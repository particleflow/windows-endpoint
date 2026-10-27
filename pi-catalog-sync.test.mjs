import test from 'node:test'
import assert from 'node:assert/strict'
import { mergePiCatalog, syncPiCatalogOnce } from './pi-catalog-sync.mjs'

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

test('does not publish on failure, malformed duplicate, unchanged data, or cancellation', async () => {
  const before = JSON.stringify(fixture()); let writes = 0
  const base = { read: async () => before, compareAndSwap: async () => { writes++; return true }, providerId: 'magpie' }
  assert.equal(await syncPiCatalogOnce({ ...base, discover: async () => { throw Error('offline') } }), 'unavailable')
  assert.equal(await syncPiCatalogOnce({ ...base, discover: async () => [added, added] }), 'unavailable')
  assert.equal(await syncPiCatalogOnce({ ...base, discover: async () => [] }), 'unchanged')
  const controller = new AbortController()
  assert.equal(await syncPiCatalogOnce({ ...base, signal: controller.signal, discover: async () => { controller.abort(); return [added] } }), 'cancelled')
  assert.equal(writes, 0)
})

test('publication uses the exact snapshot and reports concurrent change', async () => {
  const before = JSON.stringify(fixture())
  const result = await syncPiCatalogOnce({ providerId: 'magpie', read: async () => before, discover: async () => [added], compareAndSwap: async (expected, next) => {
    assert.equal(expected, before)
    assert.equal(JSON.parse(next).providers.magpie.models.at(-1).id, 'new')
    return false
  } })
  assert.equal(result, 'conflict')
})
