import { expiryEnabled } from '../config.js'
import { resolveExpiry, toStorage, formatExpiry } from '../ttl.js'
import { getIssueItem, setStatus, setExpiry } from '../github/projects.js'
import { getAssignees, getIssue, type IssueFacts, assign, comment } from '../github/issues.js'
import { isEntitled } from '../entitlement.js'
import { type Deps, optionId, requireOption, isTerminal, maintainerCc } from './deps.js'
import { writeNote } from './note.js'
import { readFormField, parseParticipants, scanParticipants } from '../issueForm.js'

/**
 * Handle `claim [expiry]` plus an optional freeform note (the lines following the command).
 *
 * Resolution order (Codex hardening): load item + assignees + status FIRST, then branch.
 * If the actor already holds the claim, treat this as a renew/extend; otherwise require an
 * Unclaimed item with no assignees — except that a co-participant listed in the issue form may
 * join a held task (see tryJoinAsParticipant). Writes are ordered to fail closed: status +
 * expiry are set before assignment, so the sweep never sees a Claimed item with a missing expiry.
 *
 * With `participant-claim`, one branch is inserted ahead of those guardrails: the issue's author
 * and the participants they declared may claim from any column (see registerEntitled). A registry
 * board should never tell somebody their own intention is unavailable, and that branch is also the
 * self-service repair for a card left in an odd state by a manual board edit.
 */
export async function handleClaim(deps: Deps, expiryArg: string, note: string): Promise<void> {
  const { octokit, repoOctokit, cfg, ctx, owner, repo, issueNumber, actor } = deps
  const now = new Date()

  // One read, up front: the author is needed for every cc line, and the body for entitlement, for
  // the join path, and for diagnosing a handle the parser could not read.
  const issue = await getIssue(repoOctokit, owner, repo, issueNumber)
  // Every message that declines a claim names the people who can do something about it: the
  // registration's author, and the project's maintainers.
  const cc = maintainerCc(cfg, [issue.author])

  const item = await getIssueItem(octokit, owner, repo, issueNumber, ctx)
  if (!item) {
    // An intention opened through the form should have been added automatically, so this means
    // something is wrong with the board or the workflow rather than with the commenter.
    await comment(repoOctokit, owner, repo, issueNumber,
      `@${actor} this issue isn't on the **${cfg.projectTitle}** board, so it can't be claimed.${cc}`)
    return
  }

  const assignees = await getAssignees(repoOctokit, owner, repo, issueNumber)
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
      // No TTL to extend, but the holder can still attach/update a note.
      const updatedNote = Boolean(note.trim()) && Boolean(ctx.noteFieldId)
      await writeNote(deps, item.itemId, note)
      await comment(repoOctokit, owner, repo, issueNumber, updatedNote
        ? `@${actor} note updated.`
        : `@${actor} you already hold this claim. Expiry is disabled for this project, so there's nothing to renew.`)
      return
    }
    const res = resolveExpiry(expiryArg, now, cfg.defaultTtl, cfg.maxTtlMs)
    if (!res.ok) {
      await comment(repoOctokit, owner, repo, issueNumber, `@${actor} ${res.reason}${cc}`)
      return
    }
    await setExpiry(octokit, ctx, item.itemId, toStorage(res.expiry))
    await writeNote(deps, item.itemId, note)
    await comment(repoOctokit, owner, repo, issueNumber,
      `@${actor} claim renewed — now expires **${formatExpiry(res.expiry)}**.`)
    return
  }

  // ---- Entitled path: the author and declared participants are never turned away ----
  if (cfg.participantClaim && isEntitled(actor, issue.author, issue.body, cfg.claimParticipantsField)) {
    await registerEntitled(deps, item, assignees, expiryArg, note, issue.state, cc)
    return
  }

  // ---- Fresh claim path: enforce guardrails --------------------------------
  if (isTerminal(cfg, statusName)) {
    await comment(repoOctokit, owner, repo, issueNumber,
      `@${actor} this task is **${statusName}**, so there's nothing to claim.${cc}`)
    return
  }
  if (item.statusOptionId !== unclaimedId || assignees.length > 0) {
    // A held task refuses new claimants — unless the actor is on the registration's invitation
    // list, in which case `claim` means "join" rather than "take over".
    if (await tryJoinAsParticipant(deps, item, assignees, expiryArg, note, issue.body, cc)) return
    // Before turning somebody away as a stranger, check whether they were meant to be a
    // participant and only a mistyped handle stands in the way; that is a fault to report, not a
    // refusal to explain away.
    if (await explainUnreadableHandle(deps, issue, cc)) return
    const who = assignees.length ? assignees.map((a) => `@${a}`).join(', ') : 'someone'
    await comment(repoOctokit, owner, repo, issueNumber,
      `@${actor} this task isn't available — it's currently **${statusName ?? 'not Unclaimed'}** (held by ${who}). It will free up if the claim is disclaimed or expires.${cc}`)
    return
  }

  // Expiry disabled for the project: behave like the classic TTL-less bot.
  if (!expiryEnabled(cfg)) {
    await setStatus(octokit, ctx, item.itemId, claimedId)
    await assign(repoOctokit, owner, repo, issueNumber, actor)
    await writeNote(deps, item.itemId, note, true)
    const suffix = expiryArg.trim() ? ' (expiry ignored: this project doesn\'t track claim expiry)' : ''
    await comment(repoOctokit, owner, repo, issueNumber, `@${actor} you've claimed this task.${suffix}`)
    return
  }

  const res = resolveExpiry(expiryArg, now, cfg.defaultTtl, cfg.maxTtlMs)
  if (!res.ok) {
    await comment(repoOctokit, owner, repo, issueNumber, `@${actor} ${res.reason}${cc}`)
    return
  }

  // Fail-closed order: write the expiry BEFORE flipping to Claimed, so the item is never
  // observable as Claimed-with-empty-expiry (which a sweep could misread as a legacy claim).
  // Then status, then assignment, then the human comment.
  await setExpiry(octokit, ctx, item.itemId, toStorage(res.expiry))
  await setStatus(octokit, ctx, item.itemId, claimedId)
  await assign(repoOctokit, owner, repo, issueNumber, actor)
  await writeNote(deps, item.itemId, note, true)

  const lines = [`@${actor} you've claimed this task — it expires **${formatExpiry(res.expiry)}**.`]
  if (res.usedDefault) {
    lines.push(`That's the project default. To set your own, comment e.g. \`claim 2w\`, \`claim 5 hours\`, or \`claim 2026-08-01\` — and \`claim <when>\` again any time to extend.`)
  }
  await comment(repoOctokit, owner, repo, issueNumber, lines.join('\n\n'))
}

/**
 * Was this commenter meant to be a participant, but written without the leading `@` the parser
 * requires? If so, say precisely that, and tell the people who can put it right.
 *
 * The comparison is against the tokens the parser rejected, not against the handles it accepted, so
 * it fires exactly when somebody has been made invisible by a typing slip. Returns true when it has
 * answered the comment, so the caller skips the ordinary refusal.
 */
async function explainUnreadableHandle(deps: Deps, issue: IssueFacts, cc: string): Promise<boolean> {
  const { repoOctokit, cfg, owner, repo, issueNumber, actor } = deps
  if (!cfg.claimParticipantsField) return false
  const { unreadable } = scanParticipants(readFormField(issue.body, cfg.claimParticipantsField))
  const mine = unreadable.find((t) => t.replace(/^@/, '').toLowerCase() === actor.toLowerCase())
  if (!mine) return false
  await comment(repoOctokit, owner, repo, issueNumber,
    `@${actor} you're named in the "${cfg.claimParticipantsField}" field as \`${mine.replace(/`/g, '')}\`, but without the leading \`@\` a handle isn't recognised, so I couldn't treat you as a participant. Once the field reads \`@${actor}\`, comment \`claim\` again and I'll register you.${cc}`)
  return true
}

/**
 * Register an entitled commenter — the issue's author, or somebody they declared as a participant
 * — whatever column the card is in.
 *
 * The status is only ever moved forward into the claimed column when the card is not already in an
 * active one, so a claim can never drag a card back out of In Progress or In Review. A closed issue
 * is refused, since an intention that is simultaneously closed and actively registered is a
 * contradiction the board cannot express. The expiry is resolved before anything is written, so a
 * malformed date changes nothing; the assignment is then confirmed to have stuck before the board
 * is touched, so a rejected assignment cannot leave a card registered to nobody.
 */
async function registerEntitled(
  deps: Deps,
  item: { itemId: string; statusOptionId: string | null },
  assignees: string[],
  expiryArg: string,
  note: string,
  issueState: 'open' | 'closed',
  cc: string,
): Promise<void> {
  const { octokit, repoOctokit, cfg, ctx, owner, repo, issueNumber, actor } = deps

  if (issueState === 'closed') {
    await comment(repoOctokit, owner, repo, issueNumber,
      `@${actor} this issue is closed, so I've left the board alone. Reopen it and comment \`claim\` again to register.${cc}`)
    return
  }

  const claimedId = requireOption(ctx, cfg.statusClaimed)
  const active = new Set([claimedId, optionId(ctx, cfg.statusInProgress), optionId(ctx, cfg.statusInReview)]
    .filter((id): id is string => id !== null))
  const alreadyActive = item.statusOptionId !== null && active.has(item.statusOptionId)
  const joiningExisting = alreadyActive && assignees.length > 0

  // A bare claim by somebody joining an existing registration preserves its shared expiry.
  let expiry: Date | null = null
  if (expiryEnabled(cfg) && (!joiningExisting || expiryArg.trim().length > 0)) {
    const res = resolveExpiry(expiryArg, new Date(), cfg.defaultTtl, cfg.maxTtlMs)
    if (!res.ok) {
      await comment(repoOctokit, owner, repo, issueNumber, `@${actor} ${res.reason}${cc}`)
      return
    }
    expiry = res.expiry
  }

  await assign(repoOctokit, owner, repo, issueNumber, actor)
  const after = await getAssignees(repoOctokit, owner, repo, issueNumber)
  if (!after.some((a) => a.toLowerCase() === actor.toLowerCase())) {
    await comment(repoOctokit, owner, repo, issueNumber,
      `@${actor} GitHub didn't accept the assignment, so I couldn't register you on this intention.${cc}`)
    return
  }

  if (expiry) await setExpiry(octokit, ctx, item.itemId, toStorage(expiry))
  if (!alreadyActive) await setStatus(octokit, ctx, item.itemId, claimedId)
  // Only a first holder may clear a note left behind; a joiner must not wipe the group's note.
  await writeNote(deps, item.itemId, note, assignees.length === 0)

  const others = assignees.filter((a) => a.toLowerCase() !== actor.toLowerCase())
  let line = others.length
    ? `@${actor} you've joined this registration alongside ${others.map((a) => `@${a}`).join(', ')}.`
    : `@${actor} you're registered as working on this.`
  if (!alreadyActive) line += ` It's now **${cfg.statusClaimed}**.`
  if (expiry) line += ` This registration expires **${formatExpiry(expiry)}**.`
  await comment(repoOctokit, owner, repo, issueNumber, line)
}

/**
 * Join an active registration as a listed co-participant.
 *
 * The issue form's participants field (`claim-participants-field`) is the author's explicit
 * invitation list, so someone named there who comments `claim` on a held task joins it as a
 * co-holder instead of being refused. This is also the self-service path for participants the
 * auto-claim couldn't assign: by commenting they've just made themselves assignable, so the
 * assignment that failed on open succeeds now. Joining leaves status and note untouched; a
 * joiner who gave an expiry renews the shared one, exactly as any holder could a moment later.
 *
 * Returns true when the comment was handled here (joined, or failed with its own diagnostic);
 * false hands back to the ordinary refusal.
 */
async function tryJoinAsParticipant(
  deps: Deps,
  item: { itemId: string; statusOptionId: string | null },
  assignees: string[],
  expiryArg: string,
  note: string,
  body: string,
  cc: string,
): Promise<boolean> {
  const { octokit, repoOctokit, cfg, ctx, owner, repo, issueNumber, actor } = deps
  if (!cfg.claimParticipantsField) return false
  const claimedId = requireOption(ctx, cfg.statusClaimed)
  const inProgressId = optionId(ctx, cfg.statusInProgress)
  const active = item.statusOptionId === claimedId || (inProgressId !== null && item.statusOptionId === inProgressId)
  if (!active || assignees.length === 0) return false
  if (assignees.some((a) => a.toLowerCase() === actor.toLowerCase())) return false

  const listed = parseParticipants(readFormField(body, cfg.claimParticipantsField))
  if (!listed.some((p) => p.toLowerCase() === actor.toLowerCase())) return false

  // Confirm the assignment stuck (GitHub silently drops assignees it won't accept). The actor
  // just commented, so they're normally assignable; the cap of ten is the realistic failure.
  await assign(repoOctokit, owner, repo, issueNumber, actor)
  const after = await getAssignees(repoOctokit, owner, repo, issueNumber)
  if (!after.some((a) => a.toLowerCase() === actor.toLowerCase())) {
    await comment(repoOctokit, owner, repo, issueNumber,
      `@${actor} you're listed as a participant here, but GitHub didn't accept the assignment, so I couldn't register you on this task.${cc}`)
    return true
  }

  const holders = assignees.map((a) => `@${a}`).join(', ')
  let line = `@${actor} you've joined this registration alongside ${holders}.`
  if (expiryEnabled(cfg) && expiryArg.trim()) {
    const res = resolveExpiry(expiryArg, new Date(), cfg.defaultTtl, cfg.maxTtlMs)
    if (res.ok) {
      await setExpiry(octokit, ctx, item.itemId, toStorage(res.expiry))
      line += ` The registration now expires **${formatExpiry(res.expiry)}**.`
    } else {
      // Forgiving like auto-claim: the join stands, only the expiry change is declined.
      line += ` I've left the shared expiry unchanged, though — ${res.reason}${cc}`
    }
  }
  await writeNote(deps, item.itemId, note)
  await comment(repoOctokit, owner, repo, issueNumber, line)
  return true
}
