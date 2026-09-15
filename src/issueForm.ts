/**
 * Read a single field out of a GitHub issue-form body.
 *
 * GitHub renders an issue form as Markdown: each field becomes a `### <label>` heading followed by
 * the user's answer, up to the next `### ` heading (or the end of the body). An empty optional field
 * renders as the literal `_No response_`. This lets the lifecycle pull, say, the expiry a registrant
 * typed into the form so they don't have to repeat it in a separate `claim` comment.
 */
export function readFormField(body: string, label: string): string | null {
  if (!body || !label) return null
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Match the heading line exactly (only trailing spaces/tabs, not following blank lines), then
  // capture up to the next `### ` heading or the end of the body.
  const re = new RegExp(`(?:^|\\n)###[ \\t]+${escaped}[ \\t]*\\r?\\n([\\s\\S]*?)(?=\\r?\\n###[ \\t]|$)`)
  const m = body.match(re)
  if (!m) return null
  const value = m[1]!.trim()
  if (value === '' || value === '_No response_') return null
  return value
}

/**
 * Parse a list of GitHub handles out of a form-field value like `@alice, @bob`.
 *
 * A handle must carry its `@`; handles may be separated by commas, semicolons, or any whitespace.
 * The field is free text on a public form, so a bare word is never read as a handle: someone who
 * types "Alice Smith and Bob Jones" means four names, and reading those as `@Alice`, `@Smith`,
 * `@and`, `@Bob`, `@Jones` would notify (and possibly assign) unrelated accounts. Tokens that
 * aren't a well-formed GitHub login (1–39 alphanumerics/hyphens, no leading/trailing/double
 * hyphen) are dropped rather than reported. Duplicates collapse case-insensitively to the first
 * spelling. A null/blank value yields [].
 */
export interface ParticipantScan {
  /** the handles that were recognised, in order, deduplicated case-insensitively */
  logins: string[]
  /** tokens that were not recognisable as handles — almost always a missing leading `@` */
  unreadable: string[]
}

/**
 * Split a participants field into the handles it names and the tokens it does not.
 *
 * The leading `@` is required, so that ordinary prose in a free-text field cannot be mistaken for
 * an assignment. That makes a missing `@` the overwhelmingly common mistake, and silently dropping
 * it leaves somebody unregistered with nothing to explain why — so the rejects are returned rather
 * than discarded, for the caller to report back.
 */
export function scanParticipants(value: string | null): ParticipantScan {
  const logins: string[] = []
  const unreadable: string[] = []
  if (!value) return { logins, unreadable }
  const seen = new Set<string>()
  const seenBad = new Set<string>()
  for (const token of value.split(/[\s,;]+/)) {
    if (!token) continue
    const m = token.match(/^@([A-Za-z0-9](?:-?[A-Za-z0-9]){0,38})$/)
    if (!m) {
      const key = token.toLowerCase()
      if (!seenBad.has(key)) {
        seenBad.add(key)
        unreadable.push(token)
      }
      continue
    }
    const login = m[1]!
    const key = login.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    logins.push(login)
  }
  return { logins, unreadable }
}

/** The handles named in a participants field; see {@link scanParticipants} for the rejects. */
export function parseParticipants(value: string | null): string[] {
  return scanParticipants(value).logins
}
