import test from 'node:test'
import assert from 'node:assert/strict'
import { mergePiCatalog } from './pi-catalog-sync.mjs'

const fixture = () => ({ providers: { magpie: { baseUrl: 'https://example.invalid/v1', models: [{ id: 'existing', contextWindow: 10, custom: true }], modelOverrides: { existing: { reasoning: false } } }, other: { models: [{ id: 'untouched' }] } }, extra: { value: true } })
const added = { id: 'new', contextWindow: 1000, maxTokens: 100, reasoning: false, input: ['text'] }

test('adds only fully described models while retaining all user state and old models', () => {
  const old = fixture()
  const next = mergePiCatalog(old, 'magpie', [{ ...added, id: 'existing', contextWindow: 999 }, added, { id: 'unknown' }])
  assert.deepEqual(next.providers.magpie.models, [old.providers.magpie.models[0], added])
  assert.deepEqual(next.providers.magpie.modelOverrides, old.providers.magpie.modelOverrides)
  assert.deepEqual(next.providers.other, old.providers.other)
  assert.deepEqual(old, fixture())
  assert.equal(mergePiCatalog(next, 'magpie', [added]), next)
})

test('projection rejects malformed or duplicate metadata without mutating the original', () => {
  const original=fixture(),raw=JSON.stringify(original)
  assert.throws(()=>mergePiCatalog(original,'magpie',[added,added]))
  assert.throws(()=>mergePiCatalog(original,'missing',[added]))
  assert.throws(()=>mergePiCatalog({...original,providers:{magpie:{models:[{id:'same'},{id:'same'}]}}},'magpie',[]))
  assert.equal(JSON.stringify(original),raw)
})
