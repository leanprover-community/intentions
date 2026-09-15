import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFormField, parseParticipants, scanParticipants } from '../src/issueForm.js'

const body = [
  '### What are you working on?',
  '',
  'Formalising the Radon-Nikodym theorem.',
  '',
  '### Credible expiry date',
  '',
  '3 months',
  '',
  '### Associated event',
  '',
  '_No response_',
].join('\n')

test('reads a field value up to the next heading', () => {
  assert.equal(readFormField(body, 'Credible expiry date'), '3 months')
})

test('reads the first field', () => {
  assert.equal(readFormField(body, 'What are you working on?'), 'Formalising the Radon-Nikodym theorem.')
})

test('treats _No response_ as absent', () => {
  assert.equal(readFormField(body, 'Associated event'), null)
})

test('returns null for a missing field', () => {
  assert.equal(readFormField(body, 'Nonexistent'), null)
})

test('escapes regex metacharacters in the label', () => {
  const b = '### Cost ($) per unit\n\n42'
  assert.equal(readFormField(b, 'Cost ($) per unit'), '42')
})

test('reads the last field at end of body (no trailing heading)', () => {
  const b = '### Only field\n\nthe value'
  assert.equal(readFormField(b, 'Only field'), 'the value')
})

test('empty body or label yields null', () => {
  assert.equal(readFormField('', 'x'), null)
  assert.equal(readFormField('### x\n\ny', ''), null)
})

test('collapses to null when the section is blank', () => {
  const b = '### Field\n\n\n### Next\n\nv'
  assert.equal(readFormField(b, 'Field'), null)
})

// ---- parseParticipants -------------------------------------------------------------------

test('parses comma-separated handles with @', () => {
  assert.deepEqual(parseParticipants('@alice, @bob'), ['alice', 'bob'])
})

test('parses mixed separators and newlines', () => {
  assert.deepEqual(parseParticipants('@alice; @bob\n@carol-dee'), ['alice', 'bob', 'carol-dee'])
})

test('ignores bare words, so free-text names never become handles', () => {
  assert.deepEqual(parseParticipants('Alice Smith and Bob Jones'), [])
  assert.deepEqual(parseParticipants('me and my student'), [])
  assert.deepEqual(parseParticipants('Alice Smith, @bob'), ['bob'])
})

test('drops tokens that are not well-formed logins', () => {
  assert.deepEqual(parseParticipants('@alice, handle!, -bad, bad-, dou--ble, @b_ob, https://github.com/carol'), ['alice'])
})

test('dedupes case-insensitively, keeping the first spelling', () => {
  assert.deepEqual(parseParticipants('@Alice @alice @ALICE @bob'), ['Alice', 'bob'])
})

test('null or blank value yields []', () => {
  assert.deepEqual(parseParticipants(null), [])
  assert.deepEqual(parseParticipants('   '), [])
})

test('caps login length at 39 characters', () => {
  const long = 'a'.repeat(40)
  const ok = 'a'.repeat(39)
  assert.deepEqual(parseParticipants(`@${long} @${ok}`), [ok])
})

// ---- scanParticipants: what was dropped, and why -----------------------------------------

test('scan returns the handles it read and the tokens it could not', () => {
  const scan = scanParticipants('@alice, bob, @carol-dee')
  assert.deepEqual(scan.logins, ['alice', 'carol-dee'])
  assert.deepEqual(scan.unreadable, ['bob'])
})

test('scan reports every stray token, deduplicated case-insensitively', () => {
  const scan = scanParticipants('alice and Alice and @bob')
  assert.deepEqual(scan.logins, ['bob'])
  assert.deepEqual(scan.unreadable, ['alice', 'and'])
})

test('scan of a blank or absent field reports nothing at all', () => {
  assert.deepEqual(scanParticipants(null), { logins: [], unreadable: [] })
  assert.deepEqual(scanParticipants('   '), { logins: [], unreadable: [] })
})

test('parseParticipants still returns just the handles', () => {
  assert.deepEqual(parseParticipants('@alice, bob'), ['alice'])
})
