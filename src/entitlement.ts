import { readFormField, parseParticipants } from './issueForm.js'

/**
 * Who may act on a registration irrespective of the column it sits in.
 *
 * A registry board is not a work queue: the person who registered an intention, and the people
 * they named as working on it with them, are its natural custodians, and the bot should never tell
 * them their own project is unavailable. Everyone else remains bound by the ordinary status rules,
 * so a genuinely free card can still be picked up by a newcomer.
 *
 * Entitlement is read from the issue at the moment of the comment, never cached: an author may add
 * a collaborator at any time by editing the body, and the change takes effect immediately.
 */
export function isEntitled(
  actor: string,
  issueAuthor: string,
  issueBody: string,
  participantsField: string,
): boolean {
  const a = actor.toLowerCase()
  if (issueAuthor && a === issueAuthor.toLowerCase()) return true
  if (!participantsField) return false
  return parseParticipants(readFormField(issueBody, participantsField))
    .some((p) => p.toLowerCase() === a)
}
