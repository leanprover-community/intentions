import { expiryEnabled } from '../config.js'
import { resolveExpiry, toStorage, formatExpiry } from '../ttl.js'
import { getIssueItem, setStatus, setExpiry } from '../github/projects.js'
import { getAssignees, assign, comment } from '../github/issues.js'
import { type Deps, optionId, requireOption, isTerminal } from './deps.js'

/**
 * Handle `claim [expiry]`.
 *
 * Resolution order (Codex hardening): load item + assignees + status FIRST, then branch.
 * If the actor already holds the claim, treat this as a renew/extend; otherwise require an
 * Unclaimed item with no assignees. Writes are ordered to fail closed: status + expiry are
 * set before assignment, so the sweep never sees a Claimed item with a missing expiry.
 */
export async function handleClaim(deps: Deps, expiryArg: string): Promise<void> {
  const { octokit, cfg, ctx, owner, repo, issueNumber, actor } = deps
  const now = new Date()

  const item = await getIssueItem(octokit, owner, repo, issueNumber, ctx)
  if (!item) {
    await comment(octokit, owner, repo, issueNumber,
      `@${actor} this issue isn't on the **${cfg.projectTitle}** board yet, so it can't be claimed. A maintainer needs to add it first.`)
    return
  }

  const assignees = await getAssignees(octokit, owner, repo, issueNumber)
  const statusName = item.statusOptionId ? ctx.statusNameById.get(item.statusOptionId) ?? null : null
  const claimedId = requireOption(ctx, cfg.statusClaimed)
  const unclaimedId = requireOption(ctx, cfg.statusUnclaimed)
  const inProgressId = optionId(ctx, cfg.statusInProgress)
  const actorHolds =
    assignees.includes(actor) &&
    (item.statusOptionId === claimedId || (inProgressId !== null && item.statusOptionId === inProgressId))

  // ---- Renew / extend path -------------------------------------------------
  if (actorHolds) {
    if (!expiryEnabled(cfg)) {
      await comment(octokit, owner, repo, issueNumber,
        `@${actor} you already hold this claim. Expiry is disabled for this project, so there's nothing to renew.`)
      return
    }
    const res = resolveExpiry(expiryArg, now, cfg.defaultTtl, cfg.maxTtlMs)
    if (!res.ok) {
      await comment(octokit, owner, repo, issueNumber, `@${actor} ${res.reason}`)
      return
    }
    await setExpiry(octokit, ctx, item.itemId, toStorage(res.expiry))
    await comment(octokit, owner, repo, issueNumber,
      `@${actor} claim renewed — now expires **${formatExpiry(res.expiry)}**.`)
    return
  }

  // ---- Fresh claim path: enforce guardrails --------------------------------
  if (isTerminal(cfg, statusName)) {
    await comment(octokit, owner, repo, issueNumber,
      `@${actor} this task is **${statusName}**, so there's nothing to claim.`)
    return
  }
  if (item.statusOptionId !== unclaimedId || assignees.length > 0) {
    const who = assignees.length ? assignees.map((a) => `@${a}`).join(', ') : 'someone'
    await comment(octokit, owner, repo, issueNumber,
      `@${actor} this task isn't available — it's currently **${statusName ?? 'not Unclaimed'}** (held by ${who}). It will free up if the claim is disclaimed or expires.`)
    return
  }

  // Expiry disabled for the project: behave like the classic TTL-less bot.
  if (!expiryEnabled(cfg)) {
    await setStatus(octokit, ctx, item.itemId, claimedId)
    await assign(octokit, owner, repo, issueNumber, actor)
    const note = expiryArg.trim() ? ' (expiry ignored: this project doesn\'t track claim expiry)' : ''
    await comment(octokit, owner, repo, issueNumber, `@${actor} you've claimed this task.${note}`)
    return
  }

  const res = resolveExpiry(expiryArg, now, cfg.defaultTtl, cfg.maxTtlMs)
  if (!res.ok) {
    await comment(octokit, owner, repo, issueNumber, `@${actor} ${res.reason}`)
    return
  }

  // Fail-closed order: write the expiry BEFORE flipping to Claimed, so the item is never
  // observable as Claimed-with-empty-expiry (which a sweep could misread as a legacy claim).
  // Then status, then assignment, then the human comment.
  await setExpiry(octokit, ctx, item.itemId, toStorage(res.expiry))
  await setStatus(octokit, ctx, item.itemId, claimedId)
  await assign(octokit, owner, repo, issueNumber, actor)

  const lines = [`@${actor} you've claimed this task — it expires **${formatExpiry(res.expiry)}**.`]
  if (res.usedDefault) {
    lines.push(`That's the project default. To set your own, comment e.g. \`claim 2w\`, \`claim 5 hours\`, or \`claim 2026-08-01\` — and \`claim <when>\` again any time to extend.`)
  }
  await comment(octokit, owner, repo, issueNumber, lines.join('\n\n'))
}
