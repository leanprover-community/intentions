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
