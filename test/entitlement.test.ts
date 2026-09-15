import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isEntitled } from '../src/entitlement.js'

const body = [
  '### What are you working on?',
  '',
  'Masures for Kac-Moody groups.',
  '',
  '### Participants',
  '',
  '@alice, @bob',
  '',
  '### Credible expiry date',
  '',
  '2027-01-31',
].join('\n')

test('the issue author is entitled, whatever the participants field says', () => {
  assert.equal(isEntitled('carol', 'carol', body, 'Participants'), true)
  assert.equal(isEntitled('carol', 'carol', '', ''), true)
})

test('a listed participant is entitled', () => {
  assert.equal(isEntitled('alice', 'carol', body, 'Participants'), true)
  assert.equal(isEntitled('bob', 'carol', body, 'Participants'), true)
})

test('a handle written without its leading @ does not entitle (prose must not assign)', () => {
  assert.equal(isEntitled('dave', 'carol', '### Participants\n\ndave', 'Participants'), false)
})

test('matching is case-insensitive on both author and participants', () => {
  assert.equal(isEntitled('CAROL', 'carol', body, 'Participants'), true)
  assert.equal(isEntitled('Alice', 'carol', body, 'Participants'), true)
})

test('a stranger is not entitled', () => {
  assert.equal(isEntitled('mallory', 'carol', body, 'Participants'), false)
})

test('without a participants field configured, only the author is entitled', () => {
  assert.equal(isEntitled('alice', 'carol', body, ''), false)
  assert.equal(isEntitled('carol', 'carol', body, ''), true)
})

test('a missing or blank participants section entitles nobody but the author', () => {
  assert.equal(isEntitled('alice', 'carol', '### Participants\n\n_No response_', 'Participants'), false)
  assert.equal(isEntitled('alice', 'carol', '### Other\n\nx', 'Participants'), false)
})

test('an unknown author does not entitle an empty actor', () => {
  assert.equal(isEntitled('', '', body, 'Participants'), false)
})
