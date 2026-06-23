import * as core from '@actions/core'
import { context, type getOctokit } from '@actions/github'
import { type Config, expiryEnabled } from './config.js'
import { resolveExpiry, toStorage } from './ttl.js'
import {
  type ProjectContext,
  getIssueItem,
  addIssueToProject,
  setStatus,
  setExpiry,
} from './github/projects.js'
import { getAssignees, assign, comment, getClosingIssueNumbers, getOpenClosingPullNumbers } from './github/issues.js'
import { optionId } from './commands/deps.js'

type Octokit = ReturnType<typeof getOctokit>

/**
 * Board lifecycle automation: keep the board in sync with issue and PR events, so a project
 * gets the full ETP column flow without configuring GitHub's native Project workflows by hand.
 *
 *  - issue opened   -> add to board as Unclaimed (auto-add)
 *  - issue closed   -> Completed
 *  - issue reopened -> Unclaimed (only if it was Completed)
 *  - PR opened/ready -> for each `Closes #N`: claim for the author if Unclaimed, then move to
 *                       In Review (or In Progress while draft) and refresh the expiry
 *  - PR merged      -> Completed
 *  - PR closed unmerged -> back to Claimed (the claim is kept)
 *
 * Every transition is guarded on the item's current status so manual board edits aren't stomped.
 */
export async function runLifecycle(octokit: Octokit, cfg: Config, ctx: ProjectContext): Promise<void> {
  const event = context.eventName
  const action = (context.payload.action as string | undefined) ?? ''
  if (event === 'issues') return runIssueEvent(octokit, cfg, ctx, action)
  if (event === 'pull_request' || event === 'pull_request_target') return runPullEvent(octokit, cfg, ctx, action)
  core.info(`Lifecycle: no handler for event ${JSON.stringify(event)}; nothing to do.`)
}

async function runIssueEvent(octokit: Octokit, cfg: Config, ctx: ProjectContext, action: string): Promise<void> {
  const issue = context.payload.issue as { number?: number; node_id?: string; pull_request?: unknown } | undefined
  if (!issue?.number || issue.pull_request) {
    core.info('Not an issue payload (or it is a PR); nothing to do.')
    return
  }
  const { owner, repo } = context.repo
  const num = issue.number

  if (action === 'opened') {
    if (!cfg.autoAdd) return
    const existing = await getIssueItem(octokit, owner, repo, num, ctx)
    if (existing) return // already on the board; leave its status alone
    if (!issue.node_id) {
      core.warning(`#${num}: opened event has no node_id; cannot add to board.`)
      return
    }
    const itemId = await addIssueToProject(octokit, ctx, issue.node_id)
    const unclaimed = optionId(ctx, cfg.statusUnclaimed)
    if (unclaimed) await setStatus(octokit, ctx, itemId, unclaimed)
    core.info(`#${num}: added to board as ${cfg.statusUnclaimed}.`)
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
      await setStatus(octokit, ctx, item.itemId, unclaimed)
      core.info(`#${num}: reopened -> ${cfg.statusUnclaimed}.`)
    }
  }
}

async function runPullEvent(octokit: Octokit, cfg: Config, ctx: ProjectContext, action: string): Promise<void> {
  const pr = context.payload.pull_request as
    | { number?: number; draft?: boolean; merged?: boolean; state?: string; user?: { login?: string } }
    | undefined
  if (!pr?.number) {
    core.info('No pull_request payload; nothing to do.')
    return
  }
  const { owner, repo } = context.repo
  const author = pr.user?.login ?? ''

  const issues = await getClosingIssueNumbers(octokit, owner, repo, pr.number)
  if (issues.length === 0) {
    core.info(`PR #${pr.number}: no "Closes #N" reference to an issue in ${owner}/${repo}; nothing to do.`)
    return
  }

  const merged = pr.merged === true
  const closed = pr.state === 'closed' || action === 'closed'
  for (const num of issues) {
    try {
      await applyPullToIssue(octokit, cfg, ctx, owner, repo, num, pr.number, { merged, closed, draft: pr.draft === true, author })
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
      await comment(octokit, owner, repo, num, `:tada: PR #${prNumber} merged; task moved to **${cfg.statusCompleted}**.`)
      return
    }
    // Closed without merging: drop an active item back to Claimed, keeping the claim intact —
    // but only if no other open PR still references the issue (don't regress live review work).
    if (claimed && (item.statusOptionId === inProgress || item.statusOptionId === inReview)) {
      const others = (await getOpenClosingPullNumbers(octokit, owner, repo, num)).filter((n) => n !== prNumber)
      if (others.length > 0) {
        core.info(`#${num}: PR #${prNumber} closed unmerged, but PR(s) ${others.join(', ')} still open; leaving status.`)
        return
      }
      if (await casSetStatus(octokit, ctx, owner, repo, num, item, claimed)) {
        await comment(octokit, owner, repo, num, `PR #${prNumber} was closed without merging; task is back to **${cfg.statusClaimed}** (still yours).`)
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
  const assignees = await getAssignees(octokit, owner, repo, num)
  if (available && assignees.length === 0) {
    if (pr.author) await assign(octokit, owner, repo, num, pr.author) // auto-claim for the PR author
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
    await comment(octokit, owner, repo, num, `PR #${prNumber} linked; task moved to **${targetName}**.`)
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
