import { test } from 'node:test'
import assert from 'node:assert/strict'
import { maintainerCc } from '../src/commands/deps.js'
import type { Config } from '../src/config.js'

const cfg = (notifyMaintainers: string[]): Config =>
  ({ notifyMaintainers } as unknown as Config)

test('no cc line when nobody is configured and nobody else is named', () => {
  assert.equal(maintainerCc(cfg([])), '')
})

test('the configured maintainers are mentioned', () => {
  assert.equal(maintainerCc(cfg(['alice', 'bob'])), '\n\ncc @alice @bob')
})

test('an extra mention comes first, and the list still applies', () => {
  assert.equal(maintainerCc(cfg(['alice']), ['carol']), '\n\ncc @carol @alice')
})

test('a name appearing twice is mentioned once, case-insensitively', () => {
  assert.equal(maintainerCc(cfg(['Alice']), ['alice']), '\n\ncc @alice')
})

test('a leading @ in configuration is tolerated, and blanks are dropped', () => {
  assert.equal(maintainerCc(cfg(['@alice', '']), ['']), '\n\ncc @alice')
})

test('an extra mention alone produces a cc line even with nobody configured', () => {
  assert.equal(maintainerCc(cfg([]), ['carol']), '\n\ncc @carol')
})
