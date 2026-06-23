import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommand } from '../src/command.js'

test('claim: bare and with whitespace/case', () => {
  assert.deepEqual(parseCommand('claim'), { kind: 'claim', expiryArg: '', note: '' })
  assert.deepEqual(parseCommand('  CLAIM\n'), { kind: 'claim', expiryArg: '', note: '' })
})

test('claim: with expiry argument', () => {
  assert.deepEqual(parseCommand('claim 1h'), { kind: 'claim', expiryArg: '1h', note: '' })
  assert.deepEqual(parseCommand('claim 3 weeks'), { kind: 'claim', expiryArg: '3 weeks', note: '' })
  assert.deepEqual(parseCommand('claim until 2026-08-01'), { kind: 'claim', expiryArg: 'until 2026-08-01', note: '' })
})

test('claim: scrapes following lines into the note (verbatim, trimmed)', () => {
  assert.deepEqual(parseCommand('claim\nWorking on the parser.'),
    { kind: 'claim', expiryArg: '', note: 'Working on the parser.' })
  // expiry on the first line, note on the rest; note keeps original case + internal newlines.
  assert.deepEqual(parseCommand('claim 2w\nSplitting this into\nthree PRs.'),
    { kind: 'claim', expiryArg: '2w', note: 'Splitting this into\nthree PRs.' })
  // outer blank lines around the note are trimmed.
  assert.deepEqual(parseCommand('claim\n\n  Heads up: blocked on #5  \n\n'),
    { kind: 'claim', expiryArg: '', note: 'Heads up: blocked on #5' })
  // leading blank lines before the command are tolerated.
  assert.deepEqual(parseCommand('\n\nclaim\nnote here'),
    { kind: 'claim', expiryArg: '', note: 'note here' })
})

test('disclaim is distinguished from claim', () => {
  assert.deepEqual(parseCommand('disclaim'), { kind: 'disclaim' })
  // "disclaim" must not be read as a claim with arg
  assert.notDeepEqual(parseCommand('disclaim'), { kind: 'claim', expiryArg: '', note: '' })
})

test('only claim carries a note; other commands stay strict whole-comment matches', () => {
  // trailing prose after a non-claim command is not a command at all
  assert.equal(parseCommand('disclaim\nthanks all'), null)
  assert.equal(parseCommand('propose #12\nready for review'), null)
})

test('reclaim is not a command (anchored)', () => {
  assert.equal(parseCommand('reclaim'), null)
})

test('propose: various PR spellings', () => {
  assert.deepEqual(parseCommand('propose #12'), { kind: 'propose', pr: 12 })
  assert.deepEqual(parseCommand('propose pr #12'), { kind: 'propose', pr: 12 })
  assert.deepEqual(parseCommand('PROPOSE PR#12'), { kind: 'propose', pr: 12 })
  assert.deepEqual(parseCommand('propose#12'), { kind: 'propose', pr: 12 })
})

test('withdraw: various PR spellings', () => {
  assert.deepEqual(parseCommand('withdraw #7'), { kind: 'withdraw', pr: 7 })
  assert.deepEqual(parseCommand('withdraw pr #7'), { kind: 'withdraw', pr: 7 })
})

test('prose containing keywords does not trigger', () => {
  assert.equal(parseCommand("I'll claim this later"), null)
  assert.equal(parseCommand('can someone propose a PR for this?'), null)
  assert.equal(parseCommand('propose 12'), null) // missing #
  assert.equal(parseCommand('thanks!'), null)
})
