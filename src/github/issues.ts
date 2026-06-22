import type { getOctokit } from '@actions/github'

type Octokit = ReturnType<typeof getOctokit>

export async function getAssignees(octokit: Octokit, owner: string, repo: string, issue_number: number): Promise<string[]> {
  const res = await octokit.rest.issues.get({ owner, repo, issue_number })
  return (res.data.assignees ?? []).map((a) => a.login)
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
const closesMarker = (issueNumber: number): string => `<!-- claim-bot:closes #${issueNumber} -->`

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
