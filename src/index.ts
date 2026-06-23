import * as core from '@actions/core'
import { context, getOctokit } from '@actions/github'
import { readConfig, expiryEnabled } from './config.js'
import { parseCommand } from './command.js'
import { resolveProjectId, loadFields, type ProjectContext } from './github/projects.js'
import { type Deps } from './commands/deps.js'
import { handleClaim } from './commands/claim.js'
import { handleDisclaim } from './commands/disclaim.js'
import { handlePropose } from './commands/propose.js'
import { handleWithdraw } from './commands/withdraw.js'
import { runSweep } from './sweep.js'
import { runLifecycle } from './lifecycle.js'

async function main(): Promise<void> {
  const cfg = readConfig()
  const octokit = getOctokit(cfg.token)
  const { owner, repo } = context.repo

  // Resolve the board + fields. This is also our read-side permission probe: if the token
  // cannot see the project, we fail here with a clear message rather than deep in a mutation.
  let ctx: ProjectContext
  try {
    const projectId = await resolveProjectId(octokit, owner, repo, cfg.projectTitle)
    const fields = await loadFields(octokit, projectId, cfg.statusField, cfg.expiryField)
    ctx = { projectId, ...fields }
  } catch (err) {
    core.setFailed(
      `Could not read the project board. This is usually a token problem — the default GITHUB_TOKEN cannot access org Projects v2; use a GitHub App installation token or a fine-grained PAT with Projects/Issues/Pull-requests write (and SAML-authorized for the org). Underlying error: ${(err as Error).message}`,
    )
    return
  }

  // Config guard: expiry on but no field to store it in.
  if (expiryEnabled(cfg) && !ctx.expiryFieldId) {
    core.setFailed(
      `default-ttl is set but the board has no Text field named "${cfg.expiryField}". Add that field (see examples/board-setup.md) or set default-ttl: none to disable expiry.`,
    )
    return
  }

  if (cfg.mode === 'sweep') {
    await runSweep(octokit, cfg, ctx)
    return
  }

  if (cfg.mode === 'lifecycle') {
    await runLifecycle(octokit, cfg, ctx)
    return
  }

  // mode === 'command'
  const comment = context.payload.comment as { body?: string; user?: { login?: string } } | undefined
  const issue = context.payload.issue as { number?: number; pull_request?: unknown } | undefined
  if (!comment?.body || !issue?.number || !comment.user?.login) {
    core.info('Not an issue_comment event with the expected payload; nothing to do.')
    return
  }
  if (issue.pull_request) {
    core.info('Comment is on a pull request, not an issue; ignoring.')
    return
  }

  const command = parseCommand(comment.body)
  if (!command) {
    core.info('Comment is not a claim-bot command; ignoring.')
    return
  }

  const deps: Deps = {
    octokit,
    cfg,
    ctx,
    owner,
    repo,
    issueNumber: issue.number,
    actor: comment.user.login,
  }

  switch (command.kind) {
    case 'claim':
      await handleClaim(deps, command.expiryArg)
      break
    case 'disclaim':
      await handleDisclaim(deps)
      break
    case 'propose':
      await handlePropose(deps, command.pr)
      break
    case 'withdraw':
      await handleWithdraw(deps, command.pr)
      break
  }
}

main().catch((err) => {
  core.setFailed((err as Error).message)
})
