import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createPiCatalogStore } from './pi-catalog-store.mjs'
import { PiCatalogLifecycle } from './pi-catalog-lifecycle.mjs'
import { ForegroundHost } from './host.mjs'
import { installedFixture } from './test-support/installed-fixture.mjs'

const original = { providers: { approved: { apiKey: '$EXISTING_AUTH_REFERENCE', models: [{ id: 'old', custom: true }], modelOverrides: { old: { maxTokens: 42 } } } } }
const addition = { id: 'from-catalog', contextWindow: 1000, maxTokens: 100, reasoning: false, input: ['text'] }
async function disk(t) {
  const piConfigDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-catalog-')))
  t.after(() => fs.rm(piConfigDir, { recursive: true, force: true }))
  const file = path.join(piConfigDir, 'models.json'), raw = JSON.stringify(original)
  await fs.writeFile(file, raw, { mode: 0o600 })
  return { config: { piConfigDir }, file, raw }
}
test('disk publication keeps mode, rejects edits and leaves no temporary files', async t => {
  const f = await disk(t), store = createPiCatalogStore(f.file)
  const before = await store.read(), mode = (await fs.stat(f.file)).mode
  await fs.writeFile(f.file, before + ' ')
  assert.equal(await store.compareAndSwap(before, before + '\n'), false)
  assert.equal(await fs.readFile(f.file, 'utf8'), before + ' ')
  const current = await store.read()
  assert.equal(await store.compareAndSwap(current, before + '\n'), true)
  assert.equal((await fs.stat(f.file)).mode, mode)
  assert.deepEqual(await fs.readdir(f.config.piConfigDir), ['models.json'])
})
test('cycle publishes once, repeated data and failures preserve bytes and mtime', async t => {
  const f = await disk(t); let now = 0, fail = false, calls = 0
  const lifecycle = new PiCatalogLifecycle({ ...f, providerId: 'approved', now: () => now, intervalMs: 1000, discover: async () => { calls++; if (fail) throw Error('offline'); return [addition] } })
  assert.equal(await lifecycle.tick(), 'updated')
  const written = await fs.readFile(f.file, 'utf8'), stamp = (await fs.stat(f.file, { bigint: true })).mtimeNs
  assert.deepEqual(JSON.parse(written).providers.approved.modelOverrides, original.providers.approved.modelOverrides)
  assert.equal(await lifecycle.tick(), 'updated'); assert.equal(calls, 1)
  now = 1000; assert.equal(await lifecycle.tick(), 'unchanged')
  now = 2000; fail = true; assert.equal(await lifecycle.tick(), 'unavailable')
  assert.equal(await fs.readFile(f.file, 'utf8'), written)
  assert.equal((await fs.stat(f.file, { bigint: true })).mtimeNs, stamp)
  await lifecycle.stop()
})
test('cancellation aborts in-flight discovery and prevents publication or restart', async t => {
  const f = await disk(t); let entered
  const started = new Promise(resolve => { entered = resolve })
  const lifecycle = new PiCatalogLifecycle({ ...f, providerId: 'approved', discover: ({ signal }) => new Promise(resolve => {
    entered(); signal.addEventListener('abort', () => resolve([addition]), { once: true })
  }) })
  const active = lifecycle.tick(); assert.equal(lifecycle.tick(), active)
  await started; await lifecycle.stop()
  assert.equal(await active, 'cancelled')
  assert.equal(await fs.readFile(f.file, 'utf8'), f.raw)
  assert.equal(await lifecycle.tick(), 'cancelled')
})
test('embedded credentials are never staged and links are rejected', async t => {
  const f = await disk(t), store = createPiCatalogStore(f.file)
  const before = await store.read()
  const unsafe = JSON.stringify({ providers: { approved: { apiKey: 'synthetic-private-material' } } })
  await assert.rejects(store.compareAndSwap(before, unsafe), /embedded_credential/)
  const linked = path.join(f.config.piConfigDir, 'linked.json')
  await fs.link(f.file, linked)
  await assert.rejects(store.read(), /catalog_file_unsafe/)
  assert.equal(await fs.readFile(f.file, 'utf8'), before)
})
test('foreground host starts discovery on selected profile and drains cancellation on stop', async t => {
  const f = await installedFixture(t), root = path.join(f.base, 'catalog-host')
  await fs.mkdir(path.join(root, 'config'), { recursive: true })
  await fs.writeFile(path.join(root, 'config/endpoint.json'), JSON.stringify(f.config))
  await fs.writeFile(path.join(f.config.piConfigDir, 'models.json'), JSON.stringify(original))
  let entered, aborted = false
  const started = new Promise(resolve => { entered = resolve })
  const host = new ForegroundHost({ root, createTestRuntime: async () => ({
    async start() {}, async stop() {}, async tick() {}, snapshot: () => null,
  }), piCatalogBinding: { providerId: 'approved', discover: ({ signal }) => new Promise(resolve => {
    entered(); signal.addEventListener('abort', () => { aborted = true; resolve([addition]) }, { once: true })
  }) } })
  await host.start(); assert.equal(host.attention, null); await started
  assert.equal(await host.stop(), true); assert.equal(aborted, true)
  assert.equal(await fs.readFile(path.join(f.config.piConfigDir, 'models.json'), 'utf8'), JSON.stringify(original))
})
test('stop completes even when discovery ignores abort, and late data cannot write', async t => {
  const f = await disk(t); let complete
  const lifecycle = new PiCatalogLifecycle({ ...f, providerId: 'approved', discover: () => new Promise(resolve => { complete = resolve }) })
  const active = lifecycle.tick()
  while (!complete) await new Promise(resolve => setImmediate(resolve))
  await lifecycle.stop(); assert.equal(await active, 'cancelled')
  complete([addition]); await new Promise(resolve => setImmediate(resolve))
  assert.equal(await fs.readFile(f.file, 'utf8'), f.raw)
})
test('Windows ReplaceFile preserves the destination ACL', { skip: process.platform !== 'win32' }, async t => {
  const f = await disk(t), store = createPiCatalogStore(f.file), run = promisify(execFile)
  const acl = async () => (await run(path.join(process.env.SystemRoot, 'System32/icacls.exe'), [f.file], { windowsHide: true })).stdout
  const before = await store.read(), permissions = await acl()
  assert.equal(await store.compareAndSwap(before, before + '\n'), true)
  assert.equal(await acl(), permissions)
})
