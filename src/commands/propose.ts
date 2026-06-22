import { expiryEnabled } from '../config.js'
import { resolveExpiry, toStorage, formatExpiry } from '../ttl.js'
import { getIssueItem, setStatus, setExpiry } from '../github/projects.js'
import { getAssignees, getPull, linkPullToIssue, comment } from '../github/issues.js'
import { type Deps, optionId, requireOption } from './deps.js'

/**
 * Handle `propose PR #N`: move a claimed task to In Progress, link the PR, refresh expiry.
 * The PR is validated (exists, open, targets this repo) before any state change.
 */
export async function handlePropose(deps: Deps, pr: number): Promise<void> {
  const { octokit, cfg, ctx, owner, repo, issueNumber, actor } = deps

  const pull = await getPull(octokit, owner, repo, pr)
  if (!pull) {
    await comment(octokit, owner, repo, issueNumber, `@${actor} PR #${pr} doesn't exist in this repository.`)
    return
  }
  if (pull.state !== 'open') {
    await comment(octokit, owner, repo, issueNumber, `@${actor} PR #${pr} is not open, so it can't be proposed.`)
    return
  }
  if (pull.baseRepoFullName.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
    await comment(octokit, owner, repo, issueNumber, `@${actor} PR #${pr} must target ${owner}/${repo}.`)
    return
  }

  const item = await getIssueItem(octokit, owner, repo, issueNumber, ctx)
  if (!item) return
  const assignees = await getAssignees(octokit, owner, repo, issueNumber)
  if (!assignees.includes(actor)) {
    await comment(octokit, owner, repo, issueNumber, `@${actor} only the current claimant can propose a PR for this task.`)
    return
  }

  const inProgressId = optionId(ctx, cfg.statusInProgress)
  if (!inProgressId) throw new Error(`Project has no "${cfg.statusInProgress}" status option.`)
  const claimedId = requireOption(ctx, cfg.statusClaimed)
  if (item.statusOptionId !== claimedId && item.statusOptionId !== inProgressId) {
    const name = item.statusOptionId ? ctx.statusNameById.get(item.statusOptionId) : 'unknown'
    await comment(octokit, owner, repo, issueNumber, `@${actor} this task is **${name}**; claim it before proposing a PR.`)
    return
  }

  await linkPullToIssue(octokit, owner, repo, pr, issueNumber, pull.body)

  // Refresh the expiry before flipping status, so the item is never In Progress with a
  // stale expiry (matters when expire-in-progress is enabled).
  let expiryNote = ''
  if (expiryEnabled(cfg)) {
    const res = resolveExpiry('', new Date(), cfg.defaultTtl, cfg.maxTtlMs) // refresh to default from now
    if (res.ok) {
      await setExpiry(octokit, ctx, item.itemId, toStorage(res.expiry))
      expiryNote = ` Claim refreshed — expires **${formatExpiry(res.expiry)}**.`
    }
  }
  await setStatus(octokit, ctx, item.itemId, inProgressId)
  await comment(octokit, owner, repo, issueNumber, `@${actor} linked PR #${pr}; task moved to **${cfg.statusInProgress}**.${expiryNote}`)
}
