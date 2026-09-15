import * as core from '@actions/core'
import type { getOctokit } from '@actions/github'
import { type Config, expiryEnabled } from './config.js'
import { formatExpiry, toStorage, MS_PER_DAY } from './ttl.js'
import { readFormField, scanParticipants } from './issueForm.js'
import { maintainerCc } from './commands/deps.js'
import {
  type ProjectContext,
  type ClaimedItem,
  listItemsByStatus,
  getIssueItem,
  setStatus,
  setExpiry,
  clearExpiry,
  clearNote,
} from './github/projects.js'
import { getAssignees, assign, unassign, comment, issueHasMarker } from './github/issues.js'

type Octokit = ReturnType<typeof getOctokit>

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const s = new Set(a)
  return b.every((x) => s.has(x))
}

/**
 * Expire stale claims. Runs on a schedule (and workflow_dispatch).
 *
 * For each Claimed (and optionally In Progress) item:
 *  - empty expiry (legacy) -> handle per `backfill-legacy`
 *  - past expiry           -> compare-and-swap re-read, then unassign + reset to Unclaimed
 *
 * The compare-and-swap (Codex hardening #2) guards against racing a fresh `claim`: an item
 * is only expired if its status, expiry, and assignees are unchanged since enumeration and
 * still due at the moment of mutation.
 */
export async function runSweep(octokit: Octokit, repoOctokit: Octokit, cfg: Config, ctx: ProjectContext): Promise<void> {
  // Runs before the expiry pass, and outside its early return, so the board keeps its shape even
  // on a project that has switched expiry off entirely.
  if (cfg.enforceHolder) await reconcileHolders(octokit, repoOctokit, cfg, ctx)

  if (!expiryEnabled(cfg)) {
    core.info('Expiry is disabled for this project (default-ttl: none); sweep is a no-op.')
    return
  }
  if (!ctx.expiryFieldId) {
    core.warning(`No "${cfg.expiryField}" field on the board; cannot sweep. Add the field or set default-ttl: none.`)
    return
  }

  const claimedId = ctx.statusOptionIdByName.get(cfg.statusClaimed.toLowerCase())
  const inProgressId = ctx.statusOptionIdByName.get(cfg.statusInProgress.toLowerCase())
  const watch = new Set<string>()
  if (claimedId) watch.add(claimedId)
  if (cfg.expireInProgress && inProgressId) watch.add(inProgressId)
  if (watch.size === 0) {
    core.warning('No managed statuses resolved; nothing to sweep.')
    return
  }

  const now = new Date()
  const candidates = await listItemsByStatus(octokit, ctx, watch)
  core.info(`Sweep: ${candidates.length} item(s) in managed statuses.`)

  let expired = 0
  let backfilled = 0
  for (const c of candidates) {
    try {
      await processCandidate(octokit, repoOctokit, cfg, ctx, c, now, () => { expired++ }, () => { backfilled++ })
    } catch (err) {
      core.warning(`Item for issue #${c.issueNumber}: ${(err as Error).message}`)
    }
  }
  core.info(`Sweep complete: ${expired} expired, ${backfilled} backfilled.`)
}

/**
 * Keep every card in a shape the rest of the bot can reason about: give each one a column, and
 * make sure an active card has somebody holding it.
 *
 * Two malformed shapes arise in practice, both from board edits made by hand, which no webhook a
 * repository workflow can subscribe to would report. A card with no status at all is invisible in a
 * board grouped by status and is refused by `claim` as "not Unclaimed"; a card sitting in an active
 * column with nobody assigned is refused as "held by someone", naming a holder who does not exist.
 * Reconciling here repairs both within one sweep of them appearing.
 *
 * A statusless card is placed by what it already carries: holders mean it is registered, so it goes
 * to the claimed column; no holders means it is free, so it goes to the unclaimed one. The author is
 * used as the fallback holder only when the assignee list is empty, so any deliberate choice — the
 * bot's or a maintainer's — is left exactly as it stands. Terminal columns are not touched, since a
 * finished piece of work needs no holder.
 */
async function reconcileHolders(octokit: Octokit, repoOctokit: Octokit, cfg: Config, ctx: ProjectContext): Promise<void> {
  const claimedId = ctx.statusOptionIdByName.get(cfg.statusClaimed.toLowerCase())
  const unclaimedId = ctx.statusOptionIdByName.get(cfg.statusUnclaimed.toLowerCase())
  if (!claimedId || !unclaimedId) {
    core.warning('enforce-holder is on, but the claimed/unclaimed status options do not resolve; skipping reconciliation.')
    return
  }
  const active = new Set<string>([claimedId])
  for (const name of [cfg.statusInProgress, cfg.statusInReview]) {
    const id = ctx.statusOptionIdByName.get(name.toLowerCase())
    if (id) active.add(id)
  }
  // Holder repairs concern the active columns, but the participants audit concerns every card, so
  // enumerate the whole board in one query and let each check pick what it cares about.
  const everywhere = new Set<string>([...active, unclaimedId])
  for (const name of [cfg.statusCompleted, ...cfg.terminalStatuses]) {
    const id = ctx.statusOptionIdByName.get(name.toLowerCase())
    if (id) everywhere.add(id)
  }

  const items = await listItemsByStatus(octokit, ctx, everywhere, { includeStatusless: true })
  let placed = 0
  let filled = 0
  for (const it of items) {
    try {
      await auditParticipants(repoOctokit, cfg, it)
      if (it.statusOptionId !== null && !active.has(it.statusOptionId)) continue
      if (it.statusOptionId === null) {
        const held = it.assignees.length > 0
        const columnName = held ? cfg.statusClaimed : cfg.statusUnclaimed
        await setStatus(octokit, ctx, it.itemId, held ? claimedId : unclaimedId)
        placed++
        core.info(`#${it.issueNumber}: had no status; placed in ${columnName}.`)
        await reportRepair(repoOctokit, cfg, it,
          `this card had no status on the **${cfg.projectTitle}** board, so I've put it in **${columnName}** (${held ? 'somebody is registered on it' : 'nobody is registered on it'}).`)
        continue
      }
      if (it.assignees.length > 0) continue
      if (!it.author) {
        core.warning(`#${it.issueNumber}: no holder and no readable author; leaving alone.`)
        continue
      }
      await assign(repoOctokit, it.issueOwner, it.issueRepo, it.issueNumber, it.author)
      const after = await getAssignees(repoOctokit, it.issueOwner, it.issueRepo, it.issueNumber)
      if (!after.some((a) => a.toLowerCase() === it.author.toLowerCase())) {
        core.info(`#${it.issueNumber}: GitHub didn't accept the author @${it.author} as an assignee; leaving alone.`)
        continue
      }
      filled++
      core.info(`#${it.issueNumber}: active with no holder; assigned the author @${it.author}.`)
      await reportRepair(repoOctokit, cfg, it,
        `this card was in an active column with nobody registered on it, so I've assigned @${it.author}, who opened it.`)
    } catch (err) {
      core.warning(`#${it.issueNumber}: reconciliation failed: ${(err as Error).message}`)
    }
  }
  core.info(`Holder reconciliation: ${placed} card(s) placed, ${filled} holder(s) restored.`)
}

/**
 * Report a participants field naming somebody the parser cannot read, on every card, for as long as
 * the fault persists.
 *
 * Unlike a holder repair, this is not something the bot can put right: only a human can add the
 * missing `@`. Such a check therefore needs a memory, or it would repeat itself every few hours.
 * The memory is a hidden marker in the comment it posts, listing exactly what was unreadable, so
 * the warning is repeated when — and only when — the set of unreadable names changes. The author is
 * cc'd because it is their field to correct, and the maintainers because a registration silently
 * naming nobody is precisely the sort of fault that otherwise goes unnoticed.
 */
async function auditParticipants(repoOctokit: Octokit, cfg: Config, it: ClaimedItem): Promise<void> {
  if (!cfg.claimParticipantsField || !it.issueOwner || !it.issueRepo) return
  const { unreadable } = scanParticipants(readFormField(it.body, cfg.claimParticipantsField))
  if (unreadable.length === 0) return

  const key = [...unreadable].map((t) => t.toLowerCase()).sort().join(',')
  const marker = `<!-- intentions:participants-unreadable ${key} -->`
  try {
    if (await issueHasMarker(repoOctokit, it.issueOwner, it.issueRepo, it.issueNumber, marker)) return
    const shown = unreadable.slice(0, 5).map((t) => `\`${t.replace(/`/g, '')}\``).join(', ')
    const more = unreadable.length > 5 ? `, and ${unreadable.length - 5} more` : ''
    await comment(repoOctokit, it.issueOwner, it.issueRepo, it.issueNumber,
      `:warning: The "${cfg.claimParticipantsField}" field names ${shown}${more}, which I can't read as GitHub handles — each one needs its leading \`@\`, as in \`@alice\`. Until the field is corrected these people aren't registered, and \`claim\` won't recognise them either.${maintainerCc(cfg, [it.author])}\n\n${marker}`)
    core.info(`#${it.issueNumber}: reported ${unreadable.length} unreadable participant name(s).`)
  } catch (err) {
    core.warning(`#${it.issueNumber}: could not audit participants: ${(err as Error).message}`)
  }
}

/**
 * Announce a repair on the issue it was made to, so the registrant sees why the bot touched their
 * card, and cc the maintainers named in `notify-maintainers` so somebody responsible learns that a
 * malformed card existed at all — these shapes come from board edits made by hand, which no webhook
 * a repository workflow can subscribe to would report.
 *
 * Only successful repairs are announced, and each repair makes its own precondition false, so a
 * card is announced once and never again. Failures are logged as warnings instead, since a repair
 * that keeps failing would otherwise comment on every sweep. A failure to comment must never abort
 * the reconciliation: the repair itself has already landed and matters more than its announcement.
 */
async function reportRepair(repoOctokit: Octokit, cfg: Config, it: ClaimedItem, what: string): Promise<void> {
  const cc = maintainerCc(cfg, [it.author])
  try {
    await comment(repoOctokit, it.issueOwner, it.issueRepo, it.issueNumber,
      `:wrench: ${what}${cc}${cc ? ' — a card in this shape usually follows a board edit made by hand.' : ''}`)
  } catch (err) {
    core.warning(`#${it.issueNumber}: repaired, but could not comment: ${(err as Error).message}`)
  }
}

async function processCandidate(
  octokit: Octokit,
  repoOctokit: Octokit,
  cfg: Config,
  ctx: ProjectContext,
  c: ClaimedItem,
  now: Date,
  onExpire: () => void,
  onBackfill: () => void,
): Promise<void> {
  const owner = c.issueOwner
  const repo = c.issueRepo
  if (!owner || !repo) return

  // ---- Legacy claim (empty expiry) ----------------------------------------
  if (!c.expiryText) {
    if (cfg.backfillLegacy === 'ignore') return
    if (cfg.backfillLegacy === 'grace') {
      // Compare-and-swap: only backfill if the item is still Claimed-with-empty-expiry and
      // the assignees are unchanged, so we don't clobber a fresh claim/renew that raced us.
      const fresh = await getIssueItem(octokit, owner, repo, c.issueNumber, ctx)
      if (!fresh || fresh.itemId !== c.itemId) return
      if (fresh.statusOptionId !== c.statusOptionId || fresh.expiryText) return
      const assignees = await getAssignees(repoOctokit, owner, repo, c.issueNumber)
      if (!sameSet(assignees, c.assignees)) return
      const expiry = new Date(now.getTime() + (cfg.defaultTtl.disabled ? 30 * MS_PER_DAY : cfg.defaultTtl.ms))
      await setExpiry(octokit, ctx, c.itemId, toStorage(expiry))
      onBackfill()
      core.info(`#${c.issueNumber}: backfilled legacy claim, now expires ${formatExpiry(expiry)}.`)
      return
    }
    // 'expire' falls through to expire-now below.
  } else {
    const due = new Date(c.expiryText)
    if (Number.isNaN(due.getTime())) {
      core.warning(`#${c.issueNumber}: unparseable expiry ${JSON.stringify(c.expiryText)}; skipping.`)
      return
    }
    if (due.getTime() > now.getTime()) return // not yet due
  }

  // ---- Compare-and-swap: re-read just before mutating ----------------------
  const fresh = await getIssueItem(octokit, owner, repo, c.issueNumber, ctx)
  if (!fresh || fresh.itemId !== c.itemId) return
  if (fresh.statusOptionId !== c.statusOptionId) return // status changed since enumeration
  if (fresh.expiryText !== c.expiryText) return // renewed/cleared since enumeration
  const assignees = await getAssignees(repoOctokit, owner, repo, c.issueNumber)
  if (!sameSet(assignees, c.assignees)) return // assignees changed since enumeration

  // Re-confirm due (a non-legacy candidate must still be past-due).
  if (c.expiryText) {
    const due = new Date(c.expiryText)
    if (due.getTime() > now.getTime()) return
  }

  const unclaimedId = ctx.statusOptionIdByName.get(cfg.statusUnclaimed.toLowerCase())
  if (!unclaimedId) throw new Error(`No "${cfg.statusUnclaimed}" status option.`)

  await setStatus(octokit, ctx, c.itemId, unclaimedId)
  await clearExpiry(octokit, ctx, c.itemId)
  await clearNote(octokit, ctx, c.itemId)
  for (const login of assignees) {
    await unassign(repoOctokit, owner, repo, c.issueNumber, login)
  }
  const wasDue = c.expiryText ? formatExpiry(new Date(c.expiryText)) : 'now (legacy claim, backfill=expire)'
  await comment(repoOctokit, owner, repo, c.issueNumber,
    `:hourglass: This claim expired (was due **${wasDue}**) and has been released back to **${cfg.statusUnclaimed}**. Comment \`claim\` to pick it up again.`)
  onExpire()
  core.info(`#${c.issueNumber}: expired and released.`)
}
