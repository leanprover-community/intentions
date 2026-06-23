/**
 * Parse a single issue comment into an intentions command, or null if it isn't one.
 *
 * Matching is deliberately strict (the whole comment must be the command, modulo
 * whitespace/case) so that prose like "I'll claim this later" does not trigger the bot.
 * This mirrors the original bot's exact-match behavior, extended so `claim` accepts an
 * optional expiry argument.
 *
 * `claim` additionally captures a freeform note: the first line carries the command (and
 * optional expiry), and any following lines are scraped verbatim into `note` (original case
 * and internal whitespace preserved, outer whitespace trimmed). The other commands stay
 * strict whole-comment matches — only `claim` carries a note.
 */

export type Command =
  | { kind: 'claim'; expiryArg: string; note: string }
  | { kind: 'disclaim' }
  | { kind: 'propose'; pr: number }
  | { kind: 'withdraw'; pr: number }

export function parseCommand(body: string): Command | null {
  const normalized = body.replace(/\s+/g, ' ').trim().toLowerCase()

  // Check disclaim before claim ("disclaim" contains "claim", but is anchored separately).
  if (normalized === 'disclaim') return { kind: 'disclaim' }

  const propose = normalized.match(/^propose\s*(?:pr\s*)?#(\d+)$/)
  if (propose) return { kind: 'propose', pr: Number(propose[1]) }

  const withdraw = normalized.match(/^withdraw\s*(?:pr\s*)?#(\d+)$/)
  if (withdraw) return { kind: 'withdraw', pr: Number(withdraw[1]) }

  // claim: match on the first line only; following lines (if any) become the note. Leading blank
  // lines are tolerated (trimStart) so an accidental newline before `claim` still parses.
  const fromCommand = body.trimStart()
  const newlineIdx = fromCommand.search(/\r?\n/)
  const firstLine = newlineIdx === -1 ? fromCommand : fromCommand.slice(0, newlineIdx)
  const note = newlineIdx === -1 ? '' : fromCommand.slice(newlineIdx).trim()
  const firstNormalized = firstLine.replace(/\s+/g, ' ').trim().toLowerCase()
  const claim = firstNormalized.match(/^claim(?:\s+(.*))?$/)
  if (claim) return { kind: 'claim', expiryArg: claim[1] ?? '', note }

  return null
}
