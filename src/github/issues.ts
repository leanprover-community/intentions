import type { getOctokit } from '@actions/github'

type Octokit = ReturnType<typeof getOctokit>

export async function getAssignees(octokit: Octokit, owner: string, repo: string, issue_number: number): Promise<string[]> {
  const res = await octokit.rest.issues.get({ owner, repo, issue_number })
  return (res.data.assignees ?? []).map((a) => a.login)
}

/**
 * The issues a PR closes via GitHub's parsed linkage (`Closes #N` / `Fixes #N` and the
 * "Development" sidebar), restricted to issues in this same repo (the board's tasks).
 * This is the source of truth for auto-linking — we read it rather than re-parsing prose.
 */
export async function getClosingIssueNumbers(octokit: Octokit, owner: string, repo: string, pull_number: number): Promise<number[]> {
  const res: {
    repository: { pullRequest: { closingIssuesReferences: { nodes: { number: number; repository: { name: string; owner: { login: string } } }[] } } | null } | null
  } = await octokit.graphql(
    `query($owner:String!,$repo:String!,$num:Int!){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$num){
          closingIssuesReferences(first:20){ nodes{ number repository{ name owner{ login } } } }
        }
      }
    }`,
    { owner, repo, num: pull_number },
  )
  const nodes = res.repository?.pullRequest?.closingIssuesReferences?.nodes ?? []
  return nodes
    .filter((n) => n.repository.owner.login.toLowerCase() === owner.toLowerCase() && n.repository.name.toLowerCase() === repo.toLowerCase())
    .map((n) => n.number)
}

/**
 * Numbers of still-open PRs that GitHub records as closing this issue. Used when an unmerged
 * PR closes, so we only revert the board when no other open PR is still working the issue.
 */
export async function getOpenClosingPullNumbers(octokit: Octokit, owner: string, repo: string, issue_number: number): Promise<number[]> {
  const res: {
    repository: { issue: { closedByPullRequestsReferences: { nodes: { number: number; state: string }[] } } | null } | null
  } = await octokit.graphql(
    `query($owner:String!,$repo:String!,$num:Int!){
      repository(owner:$owner,name:$repo){
        issue(number:$num){
          closedByPullRequestsReferences(first:20, includeClosedPrs:false){ nodes{ number state } }
        }
      }
    }`,
    { owner, repo, num: issue_number },
  )
  const nodes = res.repository?.issue?.closedByPullRequestsReferences?.nodes ?? []
  return nodes.filter((n) => n.state === 'OPEN').map((n) => n.number)
}

/**
 * The actor's permission on the repo, used to gate `assign` (registering someone else is an act of
 * authority that `claim` doesn't need). Returns the legacy `permission` ('admin' | 'write' | 'read'
 * | 'none') and the granular `role_name` ('admin' | 'maintain' | 'write' | 'triage' | 'read' | …)
 * when GitHub supplies it. A non-collaborator yields `{ permission: 'none' }` rather than throwing.
 */
export async function getCollaboratorPermission(
  octokit: Octokit, owner: string, repo: string, username: string,
): Promise<{ permission: string; roleName: string | null }> {
  try {
    const res = await octokit.rest.repos.getCollaboratorPermissionLevel({ owner, repo, username })
    return { permission: res.data.permission, roleName: (res.data as { role_name?: string }).role_name ?? null }
  } catch (err) {
    if ((err as { status?: number }).status === 404) return { permission: 'none', roleName: null }
    throw err
  }
}

/** True if `username` may be assigned to issues in this repo (404 from the check ⇒ not assignable). */
export async function canBeAssigned(octokit: Octokit, owner: string, repo: string, assignee: string): Promise<boolean> {
  try {
    await octokit.rest.issues.checkUserCanBeAssigned({ owner, repo, assignee })
    return true
  } catch (err) {
    if ((err as { status?: number }).status === 404) return false
    throw err
  }
}

export async function assign(octokit: Octokit, owner: string, repo: string, issue_number: number, login: string): Promise<void> {
  await octokit.rest.issues.addAssignees({ owner, repo, issue_number, assignees: [login] })
}

export async function unassign(octokit: Octokit, owner: string, repo: string, issue_number: number, login: string): Promise<void> {
  await octokit.rest.issues.removeAssignees({ owner, repo, issue_number, assignees: [login] })
}

export async function comment(octokit: Octokit, owner: string, repo: string, issue_number: number, body: string): Promise<void> {
  await octokit.rest.issues.createComment({ owner, repo, issue_number, body })
}

export interface PullState {
  state: 'open' | 'closed'
  merged: boolean
  baseRepoFullName: string
  body: string
}

/** Fetch a PR's state for `propose` validation; null if it doesn't exist. */
export async function getPull(octokit: Octokit, owner: string, repo: string, pull_number: number): Promise<PullState | null> {
  try {
    const res = await octokit.rest.pulls.get({ owner, repo, pull_number })
    return {
      state: res.data.state as 'open' | 'closed',
      merged: res.data.merged,
      baseRepoFullName: res.data.base.repo.full_name,
      body: res.data.body ?? '',
    }
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null
    throw err
  }
}

// A hidden, issue-specific marker so we only ever touch our own line, never user prose.
const closesMarker = (issueNumber: number): string => `<!-- intentions:closes #${issueNumber} -->`

/** Append a "Closes #N" line (with our marker) to a PR body if not already present. */
export async function linkPullToIssue(octokit: Octokit, owner: string, repo: string, pull_number: number, issueNumber: number, body: string): Promise<void> {
  const marker = closesMarker(issueNumber)
  if (body.includes(marker)) return
  const next = `${body.replace(/\s+$/, '')}\n\nCloses #${issueNumber} ${marker}`.replace(/^\n+/, '')
  await octokit.rest.pulls.update({ owner, repo, pull_number, body: next })
}

/** Remove only the bot's own "Closes #N" marker line from a PR body. */
export async function unlinkPullFromIssue(octokit: Octokit, owner: string, repo: string, pull_number: number, issueNumber: number, body: string): Promise<void> {
  const marker = closesMarker(issueNumber)
  if (!body.includes(marker)) return
  const next = body
    .replace(new RegExp(`\\n*[^\\n]*${marker}[^\\n]*`), '')
    .replace(/\s+$/, '')
  await octokit.rest.pulls.update({ owner, repo, pull_number, body: next })
}
