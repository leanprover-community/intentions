import * as core from '@actions/core'
import type { getOctokit } from '@actions/github'
import { type Config, expiryEnabled } from './config.js'
import { formatExpiry, toStorage, MS_PER_DAY } from './ttl.js'
import {
  type ProjectContext,
  type ClaimedItem,
  listItemsByStatus,
  getIssueItem,
  setStatus,
  setExpiry,
  clearExpiry,
} from './github/projects.js'
import { getAssignees, unassign, comment } from './github/issues.js'

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
export async function runSweep(octokit: Octokit, cfg: Config, ctx: ProjectContext): Promise<void> {
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
      await processCandidate(octokit, cfg, ctx, c, now, () => { expired++ }, () => { backfilled++ })
    } catch (err) {
      core.warning(`Item for issue #${c.issueNumber}: ${(err as Error).message}`)
    }
  }
  core.info(`Sweep complete: ${expired} expired, ${backfilled} backfilled.`)
}

async function processCandidate(
  octokit: Octokit,
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
      const assignees = await getAssignees(octokit, owner, repo, c.issueNumber)
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
  const assignees = await getAssignees(octokit, owner, repo, c.issueNumber)
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
  for (const login of assignees) {
    await unassign(octokit, owner, repo, c.issueNumber, login)
  }
  const wasDue = c.expiryText ? formatExpiry(new Date(c.expiryText)) : 'now (legacy claim, backfill=expire)'
  await comment(octokit, owner, repo, c.issueNumber,
    `:hourglass: This claim expired (was due **${wasDue}**) and has been released back to **${cfg.statusUnclaimed}**. Comment \`claim\` to pick it up again.`)
  onExpire()
  core.info(`#${c.issueNumber}: expired and released.`)
}
