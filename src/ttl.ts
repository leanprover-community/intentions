/**
 * TTL / expiry parsing and validation. Everything is computed in UTC.
 *
 * Expiry is stored as a full ISO 8601 UTC datetime (in a Projects v2 Text field),
 * so hour-granularity TTLs are representable. Sub-day release is still best-effort
 * against GitHub cron jitter (documented in the README), but the data model is exact.
 */

export const MS_PER_HOUR = 60 * 60 * 1000
export const MS_PER_DAY = 24 * MS_PER_HOUR

// A "month" is normalized to 30 days; we deliberately avoid ambiguous calendar math.
const UNIT_MS: Record<string, number> = {
  h: MS_PER_HOUR,
  d: MS_PER_DAY,
  w: 7 * MS_PER_DAY,
  mo: 30 * MS_PER_DAY,
}

// Map the many accepted spellings onto a canonical unit key.
const UNIT_ALIASES: Record<string, keyof typeof UNIT_MS> = {
  h: 'h', hr: 'h', hrs: 'h', hour: 'h', hours: 'h',
  d: 'd', day: 'd', days: 'd',
  w: 'w', wk: 'w', wks: 'w', week: 'w', weeks: 'w',
  mo: 'mo', mth: 'mo', mths: 'mo', month: 'mo', months: 'mo',
}

/**
 * Parse a duration like "1h", "5 hours", "7d", "7day", "2wks", "3 weeks", "2 mths".
 * Returns milliseconds, or null if `text` is not a recognizable duration.
 */
export function parseDurationMs(text: string): number | null {
  const m = text.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([a-z]+)$/)
  if (!m) return null
  const value = Number(m[1])
  const unitKey = UNIT_ALIASES[m[2]!]
  if (!unitKey || !Number.isFinite(value) || value <= 0) return null
  return Math.round(value * UNIT_MS[unitKey]!)
}

export type TtlSetting =
  | { disabled: true }
  | { disabled: false; ms: number }

/**
 * Parse a `default-ttl` / `max-ttl` config value. "none"/"off"/"" disables expiry.
 * Throws on an invalid (non-duration, non-disabling) value so misconfig fails loudly.
 */
export function parseTtlSetting(text: string): TtlSetting {
  const t = text.trim().toLowerCase()
  if (t === '' || t === 'none' || t === 'off' || t === 'never' || t === 'infinite') {
    return { disabled: true }
  }
  const ms = parseDurationMs(t)
  if (ms === null) {
    throw new Error(`Invalid TTL setting ${JSON.stringify(text)}; expected a duration like "30d" or "90d", or "none" to disable.`)
  }
  return { disabled: false, ms }
}

/**
 * Parse an absolute instant: a bare date "2026-08-01" (interpreted as end-of-day UTC,
 * so a claim "until" that date covers the whole day) or a full ISO 8601 datetime.
 * Returns a Date, or null if not an absolute instant.
 */
export function parseInstant(text: string): Date | null {
  const t = text.trim()
  const dateOnly = t.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (dateOnly) {
    const [, y, mo, da] = dateOnly.map(Number)
    const d = new Date(`${t}T23:59:59.999Z`)
    if (Number.isNaN(d.getTime())) return null
    // Reject calendar-invalid dates that JS would otherwise roll over (e.g. 2026-02-30).
    if (d.getUTCFullYear() !== y || d.getUTCMonth() + 1 !== mo || d.getUTCDate() !== da) return null
    return d
  }
  // Full ISO 8601 datetime (require a time component to avoid locale-dependent parsing).
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t)) {
    const d = new Date(t.replace(' ', 'T'))
    return Number.isNaN(d.getTime()) ? null : d
  }
  return null
}

export type ExpiryResolution =
  | { ok: true; expiry: Date; usedDefault: boolean }
  | { ok: false; reason: string }

/**
 * Resolve the effective expiry for a claim.
 *
 * @param arg        the text after `claim` (may be empty, "until <date>", a duration, or a date)
 * @param now        current instant
 * @param defaultTtl parsed `default-ttl` setting (may be disabled)
 * @param maxTtlMs   maximum allowed TTL in ms (null = no maximum)
 */
export function resolveExpiry(
  arg: string,
  now: Date,
  defaultTtl: TtlSetting,
  maxTtlMs: number | null,
): ExpiryResolution {
  const cleaned = arg.trim().replace(/^until\s+/i, '').trim()

  // No argument: use the project default.
  if (cleaned === '') {
    if (defaultTtl.disabled) {
      // Caller decides what "disabled" means; resolveExpiry is only reached when expiry is on.
      return { ok: false, reason: 'expiry is disabled for this project' }
    }
    return { ok: true, expiry: new Date(now.getTime() + defaultTtl.ms), usedDefault: true }
  }

  // Explicit argument: a duration or an absolute instant.
  let expiry: Date | null = null
  const durationMs = parseDurationMs(cleaned)
  if (durationMs !== null) {
    expiry = new Date(now.getTime() + durationMs)
  } else {
    expiry = parseInstant(cleaned)
  }

  if (expiry === null) {
    return {
      ok: false,
      reason: `could not understand the expiry ${JSON.stringify(arg.trim())}. Use a duration like \`1h\`, \`7d\`, \`3 weeks\`, or a date like \`2026-08-01\`.`,
    }
  }

  if (expiry.getTime() <= now.getTime()) {
    return { ok: false, reason: `the expiry ${JSON.stringify(arg.trim())} is not in the future.` }
  }

  if (maxTtlMs !== null && expiry.getTime() - now.getTime() > maxTtlMs) {
    return {
      ok: false,
      reason: `the requested expiry exceeds this project's maximum of ${formatDuration(maxTtlMs)}. Pick a shorter duration/date, or ask a maintainer to set it on the board.`,
    }
  }

  return { ok: true, expiry, usedDefault: false }
}

/** Human-readable UTC datetime, e.g. "2026-08-01 14:00 UTC". */
export function formatExpiry(date: Date): string {
  const iso = date.toISOString()
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
}

/** Canonical storage form: full ISO 8601 with milliseconds dropped, e.g. "2026-08-01T14:00:00Z". */
export function toStorage(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

/** Approximate a duration in ms as a friendly string for messages. */
export function formatDuration(ms: number): string {
  if (ms % (30 * MS_PER_DAY) === 0) return `${ms / (30 * MS_PER_DAY)} month(s)`
  if (ms % (7 * MS_PER_DAY) === 0) return `${ms / (7 * MS_PER_DAY)} week(s)`
  if (ms % MS_PER_DAY === 0) return `${ms / MS_PER_DAY} day(s)`
  if (ms % MS_PER_HOUR === 0) return `${ms / MS_PER_HOUR} hour(s)`
  return `${Math.round(ms / MS_PER_HOUR)} hour(s)`
}
