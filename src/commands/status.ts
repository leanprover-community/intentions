import { getIssueItem, setStatus } from '../github/projects.js'
import { getAssignees, getIssue, comment } from '../github/issues.js'
import { isEntitled } from '../entitlement.js'
import { type StatusTarget } from '../command.js'
import { type Deps, optionId } from './deps.js'

/**
 * Handle `progress` / `review` / `done`: a holder moves their own card between columns.
 *
 * The pull-request routes into In Progress and In Review (`propose`, and the automatic `Closes #N`
 * linkage) only recognise pull requests targeting this same repository. A registry whose entries
 * describe work carried out elsewhere therefore has no way to reach those columns at all, which
 * leaves every registrant dependent on a maintainer moving cards by hand. These commands close
 * that gap without involving a pull request.
 *
 * Authority is deliberately narrow: only somebody already registered on the intention may move it,
 * plus (under `participant-claim`) the author and declared participants, who are entitled to act on
 * their own intention even before anyone has been assigned to it.
 */
export async function handleStatus(deps: Deps, target: StatusTarget): Promise<void> {
  const { octokit, repoOctokit, cfg, ctx, owner, repo, issueNumber, actor } = deps

  const wanted =
    target === 'in-progress' ? cfg.statusInProgress :
    target === 'in-review' ? cfg.statusInReview :
    cfg.statusCompleted

  const item = await getIssueItem(octokit, owner, repo, issueNumber, ctx)
  if (!item) {
    await comment(repoOctokit, owner, repo, issueNumber,
      `@${actor} this issue isn't on the **${cfg.projectTitle}** board, so there's no card to move.`)
    return
  }

  const issue = await getIssue(repoOctokit, owner, repo, issueNumber)
  if (issue.state === 'closed' && target !== 'completed') {
    await comment(repoOctokit, owner, repo, issueNumber,
      `@${actor} this issue is closed, so I've left the board alone. Reopen it before moving it back to an active column.`)
    return
  }

  const assignees = await getAssignees(repoOctokit, owner, repo, issueNumber)
  let allowed = assignees.some((a) => a.toLowerCase() === actor.toLowerCase())
  if (!allowed && cfg.participantClaim) {
    allowed = isEntitled(actor, issue.author, issue.body, cfg.claimParticipantsField)
  }
  if (!allowed) {
    await comment(repoOctokit, owner, repo, issueNumber,
      `@${actor} only somebody registered on this intention can move it. Comment \`claim\` to register yourself first.`)
    return
  }

  const targetId = optionId(ctx, wanted)
  if (!targetId) {
    await comment(repoOctokit, owner, repo, issueNumber,
      `@${actor} this board has no **${wanted}** column, so there's nowhere to move the card.`)
    return
  }
  if (item.statusOptionId === targetId) {
    await comment(repoOctokit, owner, repo, issueNumber, `@${actor} this is already **${wanted}**.`)
    return
  }

  await setStatus(octokit, ctx, item.itemId, targetId)
  await comment(repoOctokit, owner, repo, issueNumber, `@${actor} moved to **${wanted}**.`)
}
