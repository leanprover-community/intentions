import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseDurationMs,
  parseTtlSetting,
  parseInstant,
  resolveExpiry,
  toStorage,
  formatExpiry,
  MS_PER_HOUR,
  MS_PER_DAY,
} from '../src/ttl.js'

test('parseDurationMs: hour spellings', () => {
  for (const s of ['1h', '1 h', '1hr', '1 hr', '1hrs', '1 hour', '1 hours']) {
    assert.equal(parseDurationMs(s), MS_PER_HOUR, s)
  }
  assert.equal(parseDurationMs('5 hours'), 5 * MS_PER_HOUR)
})

test('parseDurationMs: day/week spellings', () => {
  assert.equal(parseDurationMs('7d'), 7 * MS_PER_DAY)
  assert.equal(parseDurationMs('7day'), 7 * MS_PER_DAY)
  assert.equal(parseDurationMs('7 days'), 7 * MS_PER_DAY)
  assert.equal(parseDurationMs('2wks'), 14 * MS_PER_DAY)
  assert.equal(parseDurationMs('3 weeks'), 21 * MS_PER_DAY)
})

test('parseDurationMs: month normalizes to 30 days', () => {
  assert.equal(parseDurationMs('1 month'), 30 * MS_PER_DAY)
  assert.equal(parseDurationMs('2 mths'), 60 * MS_PER_DAY)
  assert.equal(parseDurationMs('3mo'), 90 * MS_PER_DAY)
})

test('parseDurationMs: rejects junk and non-positive', () => {
  assert.equal(parseDurationMs('soon'), null)
  assert.equal(parseDurationMs('30 minutes'), null) // no minute unit; min granularity is 1h
  assert.equal(parseDurationMs('0d'), null)
  assert.equal(parseDurationMs(''), null)
  assert.equal(parseDurationMs('#12'), null)
})

test('parseTtlSetting: none/off disables', () => {
  assert.deepEqual(parseTtlSetting('none'), { disabled: true })
  assert.deepEqual(parseTtlSetting('off'), { disabled: true })
  assert.deepEqual(parseTtlSetting(''), { disabled: true })
  assert.deepEqual(parseTtlSetting('30d'), { disabled: false, ms: 30 * MS_PER_DAY })
})

test('parseTtlSetting: throws on invalid', () => {
  assert.throws(() => parseTtlSetting('banana'))
})

test('parseInstant: bare date is end-of-day UTC', () => {
  const d = parseInstant('2026-08-01')
  assert.equal(d?.toISOString(), '2026-08-01T23:59:59.999Z')
})

test('parseInstant: full datetime', () => {
  assert.equal(parseInstant('2026-08-01T14:00:00Z')?.toISOString(), '2026-08-01T14:00:00.000Z')
  assert.equal(parseInstant('not a date'), null)
})

test('parseInstant: rejects calendar-invalid dates (no rollover)', () => {
  assert.equal(parseInstant('2026-02-30'), null)
  assert.equal(parseInstant('2026-13-01'), null)
  assert.equal(parseInstant('2026-00-10'), null)
})

const NOW = new Date('2026-06-22T12:00:00Z')
const DEFAULT = { disabled: false as const, ms: 30 * MS_PER_DAY }
const MAX = 90 * MS_PER_DAY

test('resolveExpiry: bare claim uses default and flags it', () => {
  const r = resolveExpiry('', NOW, DEFAULT, MAX)
  assert.ok(r.ok)
  assert.equal(r.usedDefault, true)
  assert.equal(r.expiry.getTime(), NOW.getTime() + 30 * MS_PER_DAY)
})

test('resolveExpiry: duration argument', () => {
  const r = resolveExpiry('1h', NOW, DEFAULT, MAX)
  assert.ok(r.ok)
  assert.equal(r.usedDefault, false)
  assert.equal(r.expiry.getTime(), NOW.getTime() + MS_PER_HOUR)
})

test('resolveExpiry: "until <date>" prefix is stripped', () => {
  const r = resolveExpiry('until 2026-07-01', NOW, DEFAULT, MAX)
  assert.ok(r.ok)
  assert.equal(toStorage(r.expiry), '2026-07-01T23:59:59Z')
})

test('resolveExpiry: rejects over max', () => {
  const r = resolveExpiry('120d', NOW, DEFAULT, MAX)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /maximum/)
})

test('resolveExpiry: rejects past instant', () => {
  const r = resolveExpiry('2020-01-01', NOW, DEFAULT, MAX)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /not in the future/)
})

test('resolveExpiry: rejects unparseable', () => {
  const r = resolveExpiry('whenever', NOW, DEFAULT, MAX)
  assert.equal(r.ok, false)
  if (!r.ok) assert.match(r.reason, /could not understand/)
})

test('resolveExpiry: no maximum allows long claims', () => {
  const r = resolveExpiry('200d', NOW, DEFAULT, null)
  assert.ok(r.ok)
})

test('toStorage drops milliseconds, formatExpiry is human', () => {
  const d = new Date('2026-08-01T14:00:00.000Z')
  assert.equal(toStorage(d), '2026-08-01T14:00:00Z')
  assert.equal(formatExpiry(d), '2026-08-01 14:00 UTC')
})
