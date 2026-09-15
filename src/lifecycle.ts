import * as core from '@actions/core'
import { context, type getOctokit } from '@actions/github'
import { type Config, expiryEnabled, shouldEnterBoard } from './config.js'
import { resolveExpiry, toStorage, formatExpiry } from './ttl.js'
import {
  type ProjectContext,
  getIssueItem,
  addIssueToProject,
  setStatus,
  setExpiry,
} from './github/projects.js'
import { getAssignees, assign, assignMany, canBeAssigned, comment, getClosingIssueNumbers, getOpenClosingPullNumbers } from './github/issues.js'
import { optionId, maintainerCc } from './commands/deps.js'
import { readFormField, scanParticipants } from './issueForm.js'

type Octokit = ReturnType<typeof getOctokit>

/**
 * Board lifecycle automation: keep the board in sync with issue and PR events, so a project
 * gets the full ETP column flow without configuring GitHub's native Project workflows by hand.
 *
 *  - issue opened   -> add to board as Unclaimed (auto-add); with claim-on-open, auto-claim it
 *                       for the issue author, reading the expiry from the issue form
 *  - issue labeled  -> the same, for an issue that only satisfies the auto-add filter now
 *  - issue closed   -> Completed
 *  - issue reopened -> Unclaimed (only if it was Completed)
 *  - PR opened/ready -> for each `Closes #N`: claim for the author if Unclaimed, then move to
 *                       In Review (or In Progress while draft) and refresh the expiry
 *  - PR merged      -> Completed
 *  - PR closed unmerged -> back to Claimed (the claim is kept)
 *
 * Every transition is guarded on the item's current status so manual board edits aren't stomped.
 */
export async function runLifecycle(octokit: Octokit, repoOctokit: Octokit, cfg: Config, ctx: ProjectContext): Promise<void> {
  const event = context.eventName
  const action = (context.payload.action as string | undefined) ?? ''
  if (event === 'issues') return runIssueEvent(octokit, repoOctokit, cfg, ctx, action)
  if (event === 'pull_request' || event === 'pull_request_target') return runPullEvent(octokit, repoOctokit, cfg, ctx, action)
  core.info(`Lifecycle: no handler for event ${JSON.stringify(event)}; nothing to do.`)
}

async function runIssueEvent(octokit: Octokit, repoOctokit: Octokit, cfg: Config, ctx: ProjectContext, action: string): Promise<void> {
  const issue = context.payload.issue as
    | { number?: number; node_id?: string; pull_request?: unknown; labels?: { name?: string }[]; user?: { login?: string }; body?: string; state?: string }
    | undefined
  if (!issue?.number || issue.pull_request) {
    core.info('Not an issue payload (or it is a PR); nothing to do.')
    return
  }
  const { owner, repo } = context.repo
  const num = issue.number

  // Both paths are an issue entering the board for the first time, so they behave identically:
  // on `labeled` the payload's labels are the post-change set, and the item lookup below keeps
  // every later label event a no-op.
  if (action === 'opened' || action === 'labeled') {
    const labels = (issue.labels ?? []).map((l) => l.name ?? '').filter(Boolean)
    const state = issue.state ?? 'open'
    if (!shouldEnterBoard(cfg, action, labels, state)) {
      core.info(`#${num}: not auto-added (${action}, state ${state}, labels [${labels.join(', ')}]).`)
      return
    }
    const existing = await getIssueItem(octokit, owner, repo, num, ctx)
    if (existing) return // already on the board; leave its status alone
    if (!issue.node_id) {
      core.warning(`#${num}: ${action} event has no node_id; cannot add to board.`)
      return
    }
    const itemId = await addIssueToProject(octokit, ctx, issue.node_id)
    const unclaimed = optionId(ctx, cfg.statusUnclaimed)
    if (unclaimed) await setStatus(octokit, ctx, itemId, unclaimed)
    core.info(`#${num}: added to board as ${cfg.statusUnclaimed}.`)
    if (cfg.claimOnOpen) {
      await autoClaimOnOpen(octokit, repoOctokit, cfg, ctx, owner, repo, num, itemId, issue.user?.login ?? '', issue.body ?? '')
    }
    return
  }

  if (action === 'closed') {
    const item = await getIssueItem(octokit, owner, repo, num, ctx)
    if (!item) return
    const completed = optionId(ctx, cfg.statusCompleted)
    if (!completed) {
      core.warning(`No "${cfg.statusCompleted}" status option; cannot mark #${num} completed.`)
      return
    }
    if (item.statusOptionId === completed) return
    await setStatus(octokit, ctx, item.itemId, completed)
    core.info(`#${num}: closed -> ${cfg.statusCompleted}.`)
    return
  }

  if (action === 'reopened') {
    const item = await getIssueItem(octokit, owner, repo, num, ctx)
    if (!item) return
    const completed = optionId(ctx, cfg.statusCompleted)
    const unclaimed = optionId(ctx, cfg.statusUnclaimed)
    // Only revert a Completed item; never disturb an active claim that was reopened.
    if (completed && unclaimed && item.statusOptionId === completed) {
      // Closing an issue does not unassign anybody, so a reopened item may still have its holders.
      // Sending it to the unclaimed column whilst they remain produces a card nobody can claim: the
      // holders are refused because it is not free, everybody else because somebody holds it. Return
      // a still-held item to the claimed column instead, and only a genuinely empty one to unclaimed.
      const claimed = optionId(ctx, cfg.statusClaimed)
      const holders = await getAssignees(repoOctokit, owner, repo, num)
      const target = holders.length > 0 && claimed ? claimed : unclaimed
      await setStatus(octokit, ctx, item.itemId, target)
      core.info(`#${num}: reopened -> ${target === unclaimed ? cfg.statusUnclaimed : cfg.statusClaimed}.`)
    }
  }
}

/**
 * Auto-claim a freshly opened issue for its author, so registering takes only the issue form — no
 * separate `claim` comment. The author opening their own issue is exactly self-service `claim`, so
 * no authority check is needed. The expiry is read from the issue form (`claim-expiry-field`),
 * falling back to the project default when the field is absent, blank, or unparseable: auto-claim is
 * forgiving and never refuses on a bad date, since the registrant can always adjust with `claim`.
 *
 * Ordering mirrors `claim`/`assign`: assign first and confirm GitHub kept the author before
 * touching the board (a rejected assignment leaves the card Unclaimed for a manual claim, never
 * Claimed-with-nobody), then write the expiry before flipping to Claimed.
 */
async function autoClaimOnOpen(
  octokit: Octokit,
  repoOctokit: Octokit,
  cfg: Config,
  ctx: ProjectContext,
  owner: string,
  repo: string,
  num: number,
  itemId: string,
  author: string,
  body: string,
): Promise<void> {
  if (!author) {
    core.info(`#${num}: claim-on-open is set but the issue has no author login; left ${cfg.statusUnclaimed}.`)
    return
  }
  const claimed = optionId(ctx, cfg.statusClaimed)
  if (!claimed) {
    core.warning(`#${num}: no "${cfg.statusClaimed}" status option; cannot auto-claim.`)
    return
  }

  await assign(repoOctokit, owner, repo, num, author)
  const assignees = await getAssignees(repoOctokit, owner, repo, num)
  if (!assignees.some((a) => a.toLowerCase() === author.toLowerCase())) {
    core.info(`#${num}: GitHub didn't accept @${author} as an assignee; left ${cfg.statusUnclaimed} for a manual claim.`)
    return
  }

  const { added, missing, unreadable } = await registerParticipants(repoOctokit, cfg, owner, repo, num, author, body)

  let expiry: Date | null = null
  let expiryNote = ''
  if (expiryEnabled(cfg)) {
    const fromForm = cfg.claimExpiryField ? readFormField(body, cfg.claimExpiryField) : null
    const now = new Date()
    let res = resolveExpiry(fromForm ?? '', now, cfg.defaultTtl, cfg.maxTtlMs, {
      requireDate: cfg.claimExpiryRequireDate,
    })
    if (!res.ok) {
      // A bad, oversized, or (when a date is required) non-date form value falls back to the
      // default; note it so the registrant sees their value wasn't used and can fix it with `claim`.
      if (fromForm) {
        expiryNote = cfg.claimExpiryRequireDate
          ? ` I couldn't use "${fromForm}" — this project needs an absolute date like \`2026-09-01\` — so I've used the default for now.`
          : ` I couldn't read "${fromForm}" as an expiry, so I've used the default for now.`
      }
      res = resolveExpiry('', now, cfg.defaultTtl, cfg.maxTtlMs)
    }
    if (res.ok) {
      await setExpiry(octokit, ctx, itemId, toStorage(res.expiry))
      expiry = res.expiry
    }
  }

  await setStatus(octokit, ctx, itemId, claimed)

  let first = added.length
    ? `@${author} you're now registered as working on this together with ${added.map((a) => `@${a}`).join(', ')} — no extra step needed.`
    : `@${author} you're now registered as working on this — no extra step needed.`
  if (expiry) first += ` This registration expires **${formatExpiry(expiry)}**.`
  if (expiryNote) first += expiryNote
  if (missing.length) {
    first += ` I couldn't register ${missing.map((m) => `@${m}`).join(', ')} — GitHub only lets me assign collaborators, org members, or people who have commented on the issue. Anyone listed can comment \`claim\` here to add themselves.`
  }
  if (unreadable.length) {
    // A handle must carry a leading @, so that ordinary prose in a free-text field cannot be
    // mistaken for an assignment. Name each token that was dropped, rather than leaving somebody
    // unregistered with nothing to explain why.
    const shown = unreadable.slice(0, 5).map((t) => `\`${t.replace(/`/g, '')}\``).join(', ')
    const more = unreadable.length > 5 ? `, and ${unreadable.length - 5} more` : ''
    first += ` I couldn't read ${shown}${more} in the "${cfg.claimParticipantsField}" field as GitHub handles — each one needs its leading \`@\`, as in \`@alice\`. Edit the issue to correct them, and they can then comment \`claim\` to join.`
  }
  // When the form requires an absolute date, don't advertise a duration example the form would reject.
  const changeHint = cfg.claimExpiryRequireDate ? 'e.g. `claim 2026-09-01`' : 'e.g. `claim 2 weeks` or `claim 2026-09-01`'
  const second = expiryEnabled(cfg)
    ? `Comment \`claim <when>\` to change the expiry (${changeHint}), \`claim\` again to renew, or \`disclaim\` to release it.`
    : 'Comment `disclaim` to release it once you\'re done.'
  // Registration is the one moment a registrant is told that something went partly wrong — a
  // participant who could not be assigned, a name that could not be read, an expiry that could not
  // be used — and until now that was said to them alone. The registrant may not grasp the
  // consequence: a credible date quietly replaced by the project default expires their work far
  // earlier than they asked for. So cc whoever the project has named, but only when there is
  // something to report, since a clean registration should notify nobody.
  const shortfall = Boolean(expiryNote) || missing.length > 0 || unreadable.length > 0
  // The message already opens by @-mentioning the author, so the cc adds only the maintainers.
  const cc = shortfall ? maintainerCc(cfg) : ''
  await comment(repoOctokit, owner, repo, num, `${first}\n\n${second}${cc}`)
  core.info(`#${num}: auto-claimed for @${author}${added.length ? ` with participants ${added.join(', ')}` : ''}${shortfall ? ' (with a shortfall reported)' : ''}.`)
}

/**
 * Register the co-participants a registrant listed in the issue form (`claim-participants-field`)
 * alongside the author, so a group project shows every member on the board's Assignees column.
 *
 * Best effort by design: GitHub only accepts collaborators, org members, and prior commenters as
 * assignees, and caps an issue at ten. Each handle is probed with `canBeAssigned` first (precise
 * feedback), then the survivors are added in one call and re-read, since assignability can still
 * change in the window and GitHub drops rejects silently. Whoever didn't stick is reported back
 * for the confirmation comment, which points them at the `claim`-to-join path (commenting makes
 * them assignable, so that path unblocks itself). A failure here never blocks the author's claim.
 */
async function registerParticipants(
  repoOctokit: Octokit,
  cfg: Config,
  owner: string,
  repo: string,
  num: number,
  author: string,
  body: string,
): Promise<{ added: string[]; missing: string[]; unreadable: string[] }> {
  if (!cfg.claimParticipantsField) return { added: [], missing: [], unreadable: [] }
  // GitHub caps an issue at ten assignees and the author holds one, so nine is every slot the form
  // can fill. Probing past that is wasted calls on a free-text field a paste can flood; the excess
  // is still named in the confirmation comment rather than dropped silently.
  const maxParticipants = 9
  const scan = scanParticipants(readFormField(body, cfg.claimParticipantsField))
  const unreadable = scan.unreadable
  const all = scan.logins.filter((p) => p.toLowerCase() !== author.toLowerCase())
  if (all.length === 0) return { added: [], missing: [], unreadable }
  const listed = all.slice(0, maxParticipants)
  const overflow = all.slice(maxParticipants)
  if (overflow.length) core.info(`#${num}: ${all.length} participants listed; probing the first ${maxParticipants}.`)

  try {
    const assignable: string[] = []
    const rejected: string[] = []
    for (const login of listed) {
      if (await canBeAssigned(repoOctokit, owner, repo, login)) assignable.push(login)
      else rejected.push(login)
    }
    await assignMany(repoOctokit, owner, repo, num, assignable)
    const after = new Set((await getAssignees(repoOctokit, owner, repo, num)).map((a) => a.toLowerCase()))
    const added = assignable.filter((p) => after.has(p.toLowerCase()))
    const dropped = assignable.filter((p) => !after.has(p.toLowerCase()))
    return { added, missing: [...rejected, ...dropped, ...overflow], unreadable }
  } catch (err) {
    core.warning(`#${num}: could not register participants (${(err as Error).message}); continuing with the author alone.`)
    return { added: [], missing: all, unreadable }
  }
}

async function runPullEvent(octokit: Octokit, repoOctokit: Octokit, cfg: Config, ctx: ProjectContext, action: string): Promise<void> {
  const pr = context.payload.pull_request as
    | { number?: number; draft?: boolean; merged?: boolean; state?: string; user?: { login?: string } }
    | undefined
  if (!pr?.number) {
    core.info('No pull_request payload; nothing to do.')
    return
  }
  const { owner, repo } = context.repo
  const author = pr.user?.login ?? ''

  const issues = await getClosingIssueNumbers(repoOctokit, owner, repo, pr.number)
  if (issues.length === 0) {
    core.info(`PR #${pr.number}: no "Closes #N" reference to an issue in ${owner}/${repo}; nothing to do.`)
    return
  }

  const merged = pr.merged === true
  const closed = pr.state === 'closed' || action === 'closed'
  for (const num of issues) {
    try {
      await applyPullToIssue(octokit, repoOctokit, cfg, ctx, owner, repo, num, pr.number, { merged, closed, draft: pr.draft === true, author })
    } catch (err) {
      core.warning(`PR #${pr.number} -> issue #${num}: ${(err as Error).message}`)
    }
  }
}

interface PullFacts {
  merged: boolean
  closed: boolean
  draft: boolean
  author: string
}

async function applyPullToIssue(
  octokit: Octokit,
  repoOctokit: Octokit,
  cfg: Config,
  ctx: ProjectContext,
  owner: string,
  repo: string,
  num: number,
  prNumber: number,
  pr: PullFacts,
): Promise<void> {
  const item = await getIssueItem(octokit, owner, repo, num, ctx)
  if (!item) return // issue isn't on the board

  const unclaimed = optionId(ctx, cfg.statusUnclaimed)
  const claimed = optionId(ctx, cfg.statusClaimed)
  const inProgress = optionId(ctx, cfg.statusInProgress)
  const inReview = optionId(ctx, cfg.statusInReview)
  const completed = optionId(ctx, cfg.statusCompleted)

  if (pr.closed) {
    if (pr.merged) {
      // A merge is terminal truth: complete the task (no CAS — merging always wins).
      if (!completed) {
        core.warning(`No "${cfg.statusCompleted}" status option; cannot complete #${num}.`)
        return
      }
      if (item.statusOptionId === completed) return
      await setStatus(octokit, ctx, item.itemId, completed)
      await comment(repoOctokit, owner, repo, num, `:tada: PR #${prNumber} merged; task moved to **${cfg.statusCompleted}**.`)
      return
    }
    // Closed without merging: drop an active item back to Claimed, keeping the claim intact —
    // but only if no other open PR still references the issue (don't regress live review work).
    if (claimed && (item.statusOptionId === inProgress || item.statusOptionId === inReview)) {
      const others = (await getOpenClosingPullNumbers(repoOctokit, owner, repo, num)).filter((n) => n !== prNumber)
      if (others.length > 0) {
        core.info(`#${num}: PR #${prNumber} closed unmerged, but PR(s) ${others.join(', ')} still open; leaving status.`)
        return
      }
      if (await casSetStatus(octokit, ctx, owner, repo, num, item, claimed)) {
        await comment(repoOctokit, owner, repo, num, `PR #${prNumber} was closed without merging; task is back to **${cfg.statusClaimed}** (still yours).`)
      }
    }
    return
  }

  // ---- PR is open (opened / reopened / ready_for_review / converted_to_draft) ----
  if (completed && item.statusOptionId === completed) return // don't reactivate a done task

  // Authorization (mirrors `propose`): the lifecycle may auto-claim a genuinely free task for
  // the PR author, or advance a task the author already holds — but it must never touch a task
  // claimed by someone else. This matters because `pull_request_target` runs with the write
  // token on PRs from forks, where the author is untrusted.
  const available = item.statusOptionId === null || item.statusOptionId === unclaimed
  const assignees = await getAssignees(repoOctokit, owner, repo, num)
  if (available && assignees.length === 0) {
    if (pr.author) await assign(repoOctokit, owner, repo, num, pr.author) // auto-claim for the PR author
  } else if (!pr.author || !assignees.includes(pr.author)) {
    core.info(`#${num}: held by someone other than ${pr.author || '(unknown author)'}; lifecycle leaves it alone.`)
    return
  }

  if (expiryEnabled(cfg)) {
    const res = resolveExpiry('', new Date(), cfg.defaultTtl, cfg.maxTtlMs)
    if (res.ok) await setExpiry(octokit, ctx, item.itemId, toStorage(res.expiry))
  }

  // Draft PRs sit in In Progress; ready PRs move to In Review when the board has that column.
  const target = pr.draft ? inProgress : (inReview ?? inProgress)
  const targetName = pr.draft ? cfg.statusInProgress : (inReview ? cfg.statusInReview : cfg.statusInProgress)
  if (!target) {
    core.warning(`No "${cfg.statusInProgress}" status option to move #${num} into.`)
    return
  }
  if (item.statusOptionId === target) return // already there; stay quiet (idempotent on re-fires)
  if (await casSetStatus(octokit, ctx, owner, repo, num, item, target)) {
    await comment(repoOctokit, owner, repo, num, `PR #${prNumber} linked; task moved to **${targetName}**.`)
  }
}

/**
 * Set status only if the item's status is unchanged since `seen` was read — a compare-and-swap
 * that re-reads immediately before mutating, so a lifecycle write can't stomp a `claim` /
 * `disclaim` / `propose` (or another PR event) that raced it. Mirrors the sweep's CAS. Returns
 * false (and does nothing) if the item moved or vanished in the meantime.
 */
async function casSetStatus(
  octokit: Octokit,
  ctx: ProjectContext,
  owner: string,
  repo: string,
  num: number,
  seen: { itemId: string; statusOptionId: string | null },
  targetOptionId: string,
): Promise<boolean> {
  const fresh = await getIssueItem(octokit, owner, repo, num, ctx)
  if (!fresh || fresh.itemId !== seen.itemId || fresh.statusOptionId !== seen.statusOptionId) {
    core.info(`#${num}: status changed concurrently; skipping lifecycle move.`)
    return false
  }
  await setStatus(octokit, ctx, fresh.itemId, targetOptionId)
  return true
}
