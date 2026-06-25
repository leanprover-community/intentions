import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFormField } from '../src/issueForm.js'

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
