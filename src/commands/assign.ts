import { expiryEnabled } from '../config.js'
import { resolveExpiry, toStorage, formatExpiry } from '../ttl.js'
import { getIssueItem, setStatus, setExpiry } from '../github/projects.js'
import {
  getAssignees, assign, unassign, comment, getCollaboratorPermission, canBeAssigned,
} from '../github/issues.js'
import { type Deps, optionId, requireOption, isTerminal } from './deps.js'
import { writeNote } from './note.js'

/** Permission levels that may register others on a task: write or above (incl. triage/maintain). */
function canAssign(perm: { permission: string; roleName: string | null }): boolean {
  if (perm.permission === 'admin' || perm.permission === 'write') return true
  // The legacy `permission` field collapses triage→read, so consult the granular role for triage.
  return perm.roleName === 'triage' || perm.roleName === 'maintain'
}

/**
 * Handle `assign @target [expiry]` plus an optional freeform note.
 *
 * Unlike `claim` (egalitarian self-service), `assign` is an act of authority: only a write/triage
 * collaborator may register someone else, and it overrides an existing claim (the main reason to
 * assign is handing off abandoned or misallocated work). The board lifecycle, TTL, and note all
 * carry over from `claim` unchanged.
 *
 * When the target already holds the task this is a refresh: like a `claim` renewal it extends the
 * expiry and updates the note but leaves the status untouched, so a maintainer re-upping someone's
 * active *In Progress* task doesn't drag the board back to *Claimed*. Taking a task over instead
 * confirms the new assignee actually stuck (GitHub silently drops assignees it won't accept) before
 * it removes the previous holder or flips the board, so a handoff can never strand a *Claimed* card
 * with nobody on it.
 */
export async function handleAssign(deps: Deps, target: string, expiryArg: string, note: string): Promise<void> {
  const { octokit, repoOctokit, cfg, ctx, owner, repo, issueNumber, actor } = deps
  const now = new Date()

  // ---- Authority gate ------------------------------------------------------
  const perm = await getCollaboratorPermission(repoOctokit, owner, repo, actor)
  if (!canAssign(perm)) {
    await comment(repoOctokit, owner, repo, issueNumber,
      `@${actor} only collaborators with write or triage access can register someone else on a task. You can \`claim\` it for yourself instead.`)
    return
  }

  const item = await getIssueItem(octokit, owner, repo, issueNumber, ctx)
  if (!item) {
    await comment(repoOctokit, owner, repo, issueNumber,
      `@${actor} this issue isn't on the **${cfg.projectTitle}** board yet, so it can't be assigned. A maintainer needs to add it first.`)
    return
  }

  const assignees = await getAssignees(repoOctokit, owner, repo, issueNumber)
  const statusName = item.statusOptionId ? ctx.statusNameById.get(item.statusOptionId) ?? null : null
  const claimedId = requireOption(ctx, cfg.statusClaimed)
  const inProgressId = optionId(ctx, cfg.statusInProgress)
  const targetHolds =
    assignees.some((a) => a.toLowerCase() === target.toLowerCase()) &&
    (item.statusOptionId === claimedId || (inProgressId !== null && item.statusOptionId === inProgressId))

  // Terminal statuses (In Review / Completed) are recognized but not managed, same as `claim`.
  if (isTerminal(cfg, statusName)) {
    await comment(repoOctokit, owner, repo, issueNumber,
      `@${actor} this task is **${statusName}**, so there's nothing to assign.`)
    return
  }

  // ---- Refresh path: target already holds it — extend, don't move the board ----
  if (targetHolds) {
    if (!expiryEnabled(cfg)) {
      await writeNote(deps, item.itemId, note)
      await comment(repoOctokit, owner, repo, issueNumber,
        `@${target}, @${actor} has refreshed your registration on this task. Expiry is disabled for this project.`)
      return
    }
    const res = resolveExpiry(expiryArg, now, cfg.defaultTtl, cfg.maxTtlMs)
    if (!res.ok) {
      await comment(repoOctokit, owner, repo, issueNumber, `@${actor} ${res.reason}`)
      return
    }
    await setExpiry(octokit, ctx, item.itemId, toStorage(res.expiry))
    await writeNote(deps, item.itemId, note)
    await comment(repoOctokit, owner, repo, issueNumber,
      `@${target}, @${actor} has refreshed your registration on this task. This registration expires **${formatExpiry(res.expiry)}**.`)
    return
  }

  // ---- Take-over path: validate the target, then hand off ------------------
  // Validate before any write so a bad name can't disturb the board at all.
  if (!(await canBeAssigned(repoOctokit, owner, repo, target))) {
    await comment(repoOctokit, owner, repo, issueNumber,
      `@${actor} @${target} can't be assigned to issues in ${owner}/${repo} — they need read access or org membership first.`)
    return
  }

  let expiry: Date | null = null
  if (expiryEnabled(cfg)) {
    const res = resolveExpiry(expiryArg, now, cfg.defaultTtl, cfg.maxTtlMs)
    if (!res.ok) {
      await comment(repoOctokit, owner, repo, issueNumber, `@${actor} ${res.reason}`)
      return
    }
    expiry = res.expiry
  }

  // Add the new assignee FIRST and confirm GitHub kept them (it silently drops users it won't
  // accept, even past the canBeAssigned probe — assignability can change in the window). Only once
  // the target is confirmed do we touch expiry/status or remove the previous holder, so a failed
  // handoff leaves the task exactly as it was rather than Claimed-with-nobody.
  await assign(repoOctokit, owner, repo, issueNumber, target)
  const afterAssign = await getAssignees(repoOctokit, owner, repo, issueNumber)
  if (!afterAssign.some((a) => a.toLowerCase() === target.toLowerCase())) {
    await comment(repoOctokit, owner, repo, issueNumber,
      `@${actor} GitHub didn't accept @${target} as an assignee, so I've left this task as it was.`)
    return
  }

  // Fail-closed order: expiry before the Claimed status, then drop the prior holder(s), then note.
  if (expiry) await setExpiry(octokit, ctx, item.itemId, toStorage(expiry))
  await setStatus(octokit, ctx, item.itemId, claimedId)
  for (const a of assignees) {
    if (a.toLowerCase() !== target.toLowerCase()) await unassign(repoOctokit, owner, repo, issueNumber, a)
  }
  await writeNote(deps, item.itemId, note, true)

  const expiryLine = expiry
    ? ` This registration expires **${formatExpiry(expiry)}**.`
    : expiryArg.trim() ? ' (expiry ignored: this project doesn\'t track claim expiry)' : ''
  await comment(repoOctokit, owner, repo, issueNumber,
    `@${target}, @${actor} has registered you as working on this task.${expiryLine}`)
}
