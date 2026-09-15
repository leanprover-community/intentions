/**
 * Parse a single issue comment into an intentions command, or null if it isn't one.
 *
 * Matching is deliberately strict (the whole comment must be the command, modulo
 * whitespace/case) so that prose like "I'll claim this later" does not trigger the bot.
 * This mirrors the original bot's exact-match behavior, extended so `claim` accepts an
 * optional expiry argument.
 *
 * `claim` (and `assign`, which registers someone else) additionally captures a freeform note:
 * the first line carries the command (and optional expiry), and any following lines are scraped
 * verbatim into `note` (original case and internal whitespace preserved, outer whitespace
 * trimmed). The other commands stay strict whole-comment matches — only `claim`/`assign` carry a
 * note.
 */

export type Command =
  | { kind: 'claim'; expiryArg: string; note: string }
  | { kind: 'assign'; target: string; expiryArg: string; note: string }
  | { kind: 'disclaim' }
  | { kind: 'propose'; pr: number }
  | { kind: 'withdraw'; pr: number }
  | { kind: 'status'; target: StatusTarget }

/** Which board column a `progress` / `review` / `done` comment asks for. */
export type StatusTarget = 'in-progress' | 'in-review' | 'completed'

export function parseCommand(body: string): Command | null {
  const normalized = body.replace(/\s+/g, ' ').trim().toLowerCase()

  // Check disclaim before claim ("disclaim" contains "claim", but is anchored separately).
  if (normalized === 'disclaim') return { kind: 'disclaim' }

  // Status commands: a holder moves their own card between columns without a pull request, for
  // registries whose work lives in other repositories. Whole-comment matches only, so prose such
  // as "this is in progress" cannot trigger them.
  if (/^(?:progress|in progress|start|started)$/.test(normalized)) return { kind: 'status', target: 'in-progress' }
  if (/^(?:review|in review|ready)$/.test(normalized)) return { kind: 'status', target: 'in-review' }
  if (/^(?:done|complete|completed|finished)$/.test(normalized)) return { kind: 'status', target: 'completed' }

  const propose = normalized.match(/^propose\s*(?:pr\s*)?#(\d+)$/)
  if (propose) return { kind: 'propose', pr: Number(propose[1]) }

  const withdraw = normalized.match(/^withdraw\s*(?:pr\s*)?#(\d+)$/)
  if (withdraw) return { kind: 'withdraw', pr: Number(withdraw[1]) }

  // claim: match on the first line only; following lines (if any) become the note. Leading blank
  // lines are tolerated (trimStart) so an accidental newline before `claim` still parses.
  // `register` and `intention` are accepted as synonyms of `claim` (the registry-facing spellings),
  // so a registrant can renew with `intention 2026-09-01` exactly as with `claim`.
  const fromCommand = body.trimStart()
  const newlineIdx = fromCommand.search(/\r?\n/)
  const firstLine = newlineIdx === -1 ? fromCommand : fromCommand.slice(0, newlineIdx)
  const note = newlineIdx === -1 ? '' : fromCommand.slice(newlineIdx).trim()
  const firstNormalized = firstLine.replace(/\s+/g, ' ').trim().toLowerCase()
  const claim = firstNormalized.match(/^(?:claim|register|intention)(?:\s+(.*))?$/)
  if (claim) return { kind: 'claim', expiryArg: claim[1] ?? '', note }

  // assign @login [expiry]: like claim, but registers someone else. The `@` is required so prose
  // ("assign this to bob") can't trigger it. The login is captured with original case (matched off
  // firstLine, not the lowercased form) so the confirmation @-mention reads naturally.
  const firstCased = firstLine.replace(/\s+/g, ' ').trim()
  const assign = firstCased.match(/^assign\s+@([A-Za-z0-9-]+)(?:\s+(.*))?$/i)
  if (assign) return { kind: 'assign', target: assign[1] ?? '', expiryArg: assign[2] ?? '', note }

  return null
}
