import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readConfig, shouldAutoAdd, type Config } from '../src/config.js'

// @actions/core reads inputs from INPUT_<NAME> (spaces -> _, uppercased; hyphens kept).
function setInputs(inputs: Record<string, string>): void {
  for (const k of Object.keys(process.env)) if (k.startsWith('INPUT_')) delete process.env[k]
  for (const [name, value] of Object.entries(inputs)) {
    process.env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] = value
  }
}

// 'expire-in-progress' has an action.yml default the Actions runner injects; supply it here
// so getBooleanInput (which throws on empty) sees the same value it would at runtime.
const required = {
  mode: 'lifecycle',
  'project-token': 't',
  'project-title': 'My Project',
  'expire-in-progress': 'false',
}

test('mode accepts lifecycle', () => {
  setInputs(required)
  assert.equal(readConfig().mode, 'lifecycle')
})

test('mode rejects unknown values', () => {
  setInputs({ ...required, mode: 'bogus' })
  assert.throws(() => readConfig(), /Invalid mode/)
})

test('lifecycle status defaults', () => {
  setInputs(required)
  const cfg = readConfig()
  assert.equal(cfg.statusInReview, 'In Review')
  assert.equal(cfg.statusCompleted, 'Completed')
})

test('auto-add defaults true and is overridable', () => {
  setInputs(required)
  assert.equal(readConfig().autoAdd, true)
  setInputs({ ...required, 'auto-add': 'false' })
  assert.equal(readConfig().autoAdd, false)
})

test('auto-add-labels parses to a trimmed list (default empty)', () => {
  setInputs(required)
  assert.deepEqual(readConfig().autoAddLabels, [])
  setInputs({ ...required, 'auto-add-labels': ' intention , roadmap-feedback ' })
  assert.deepEqual(readConfig().autoAddLabels, ['intention', 'roadmap-feedback'])
})

test('shouldAutoAdd: off disables; empty allowlist adds all; allowlist filters (case-insensitive)', () => {
  const base = { autoAdd: true, autoAddLabels: [] as string[] } as Config
  assert.equal(shouldAutoAdd({ ...base, autoAdd: false }, ['intention']), false)
  assert.equal(shouldAutoAdd(base, ['anything']), true)
  assert.equal(shouldAutoAdd(base, []), true)
  const filtered = { ...base, autoAddLabels: ['intention'] } as Config
  assert.equal(shouldAutoAdd(filtered, ['Intention', 'roadmap/PDE']), true)
  assert.equal(shouldAutoAdd(filtered, ['meta']), false)
  assert.equal(shouldAutoAdd(filtered, []), false)
})

test('note-field defaults and is overridable', () => {
  setInputs(required)
  assert.equal(readConfig().noteField, 'Claim Note')
  setInputs({ ...required, 'note-field': 'Notes' })
  assert.equal(readConfig().noteField, 'Notes')
})

test('repo-token falls back to the project token when unset', () => {
  setInputs(required)
  const cfg = readConfig()
  assert.equal(cfg.token, 't')
  assert.equal(cfg.repoToken, 't')
})

test('repo-token overrides the project token for repo ops when set', () => {
  setInputs({ ...required, 'repo-token': 'gh' })
  const cfg = readConfig()
  assert.equal(cfg.token, 't')
  assert.equal(cfg.repoToken, 'gh')
})
