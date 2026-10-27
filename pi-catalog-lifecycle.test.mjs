import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { assertCatalogAclPreserved, aclChildProcessOptions } from './test-support/pi-catalog-acl.mjs'
import { createPiCatalogStore, replacePiCatalogFile } from './pi-catalog-store.mjs'
import { PiCatalogLifecycle } from './pi-catalog-lifecycle.mjs'
import { ForegroundHost } from './host.mjs'

const original = { providers: { approved: { apiKey: '$EXISTING_AUTH_REFERENCE', models: [{ id: 'old', custom: true }], modelOverrides: { old: { maxTokens: 42 } } } } }
const addition = { id: 'from-catalog', contextWindow: 1000, maxTokens: 100, reasoning: false, input: ['text'] }
// Linux exercises state transitions only. Two renames are NOT a substitute
// for Windows ReplaceFile's atomic displacement semantics in production.
const simulatedReplace = async ({ file, temporary, backup }) => { await fs.rename(file, backup); await fs.rename(temporary, file) }
const storeFor = file => createPiCatalogStore(file, process.platform === 'win32' ? {} : { replace: simulatedReplace })
const commit = process.platform === 'win32' ? replacePiCatalogFile : simulatedReplace
async function disk(t, { protect = true } = {}) {
  const piConfigDir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pi-catalog-')))
  t.after(() => fs.rm(piConfigDir, { recursive: true, force: true }))
  const file = path.join(piConfigDir, 'models.json'), raw = JSON.stringify(original)
  await fs.writeFile(file, raw, { mode: 0o600 })
  if (process.platform === 'win32' && protect) await fixtureAcl(file, 'restrict-fixture')
  return { config: { piConfigDir }, file, raw, store: storeFor(file) }
}
test('disk publication keeps mode, rejects edits and leaves no temporary files', async t => {
  const f = await disk(t), store = f.store
  const before = await store.read(), mode = (await fs.stat(f.file)).mode
  await fs.writeFile(f.file, before + ' ')
  assert.equal(await store.compareAndSwap(before, before + '\n'), false)
  assert.equal(await fs.readFile(f.file, 'utf8'), before + ' ')
  const current = await store.read()
  assert.equal(await store.compareAndSwap(current, before + '\n'), true)
  assert.equal((await fs.stat(f.file)).mode, mode)
  const files = await fs.readdir(f.config.piConfigDir)
  assert.equal(files.some(n => n.endsWith('.tmp') || n.endsWith('pending.json')), false)
  assert.equal(files.filter(n => n.endsWith('.previous')).length, 1)
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
test('unsupported ACL stops this lifecycle without retrying discovery or writing again', async () => {
  let discoveries = 0, writes = 0
  const lifecycle = new PiCatalogLifecycle({ config:{piConfigDir:'/unused'}, providerId:'approved', discover:async () => { discoveries++; return [addition] }, store:{
    read:async () => JSON.stringify(original), compareAndSwap:async () => { writes++; throw Object.assign(Error('catalog_acl_unsupported'),{code:'catalog_acl_unsupported'}) },
  } })
  assert.equal(await lifecycle.tick(),'unsupported_acl')
  assert.equal(await lifecycle.tick(),'unsupported_acl')
  assert.equal(discoveries,1); assert.equal(writes,1)
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
  const f = await disk(t), store = f.store
  const before = await store.read()
  const unsafe = JSON.stringify({ providers: { approved: { apiKey: 'synthetic-private-material' } } })
  await assert.rejects(store.compareAndSwap(before, unsafe), /embedded_credential/)
  const linked = path.join(f.config.piConfigDir, 'linked.json')
  await fs.link(f.file, linked)
  await assert.rejects(store.read(), /catalog_file_unsafe/)
  assert.equal(await fs.readFile(f.file, 'utf8'), before)
})
test('foreground host refuses the retired file-sync binding before discovery or startup', () => {
  assert.throws(()=>new ForegroundHost({root:path.resolve('unused-fixture'),piCatalogBinding:{providerId:'approved',discover(){throw Error('must not run')}}}),{code:'host_pi_catalog_file_sync_retired'})
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
async function fixtureAcl(file, mode = 'read') {
  const executable = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const result = await promisify(execFile)(executable,
    ['-NoLogo','-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./test-support/pi-catalog-acl.ps1', import.meta.url)),file,mode],
    aclChildProcessOptions(executable))
  return JSON.parse(result.stdout.replace(/^\uFEFF/, ''))
}
test('ACL child module path isolation survives mixed casing and leaves the parent unchanged', async () => {
  const inherited = { PSModulePath: 'synthetic-pwsh7', psmodulepath: 'synthetic-other-modules', TEMP:'synthetic-temp', TMP:'synthetic-tmp', SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }
  const saved = { ...inherited }, parent = process.env.PSModulePath
  const options = aclChildProcessOptions('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', inherited)
  assert.equal(Object.keys(options.env).filter(key => key.toLowerCase() === 'psmodulepath').length, 1)
  const result = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({modules:process.env.PSModulePath,temp:process.env.TEMP,tmp:process.env.TMP}))'], options)
  assert.deepEqual(JSON.parse(result.stdout), {modules:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules', temp:inherited.TEMP, tmp:inherited.TMP})
  assert.deepEqual(inherited, saved)
  assert.equal(process.env.PSModulePath, parent)
})
test('Windows ReplaceFile preserves the destination ACL', { skip: process.platform !== 'win32' }, async t => {
  const f = await disk(t), store = createPiCatalogStore(f.file)
  const permissions = await fixtureAcl(f.file), before = await store.read()
  assert.equal(permissions.protected, true); assert.equal(permissions.aces.length, 1)
  assert.equal(await store.compareAndSwap(before, before + '\n'), true)
  assertCatalogAclPreserved(permissions, await fixtureAcl(f.file))
  const backup = (await fs.readdir(f.config.piConfigDir)).find(name => name.endsWith('.previous'))
  assertCatalogAclPreserved(permissions, await fixtureAcl(path.join(f.config.piConfigDir, backup)))
})
test('Windows unprotected ACL is refused before replacement with bytes, identity and propagation flags intact', { skip: process.platform !== 'win32' }, async t => {
  const f = await disk(t, { protect: false }), store = createPiCatalogStore(f.file)
  const permissions = await fixtureAcl(f.file, 'inherit-fixture'), before = await store.read(), initial = await fs.stat(f.file, { bigint: true })
  assert.equal(permissions.protected, false)
  await assert.rejects(store.compareAndSwap(before, before + '\n'), { code: 'catalog_acl_unsupported' })
  assert.equal(await fs.readFile(f.file, 'utf8'), before)
  assert.equal((await fs.stat(f.file, { bigint: true })).ino, initial.ino)
  assert.deepEqual(await fixtureAcl(f.file), permissions)
  assert.deepEqual(await fs.readdir(f.config.piConfigDir), ['models.json'])
})
test('ACL comparison allows only appended identical inherited ACEs, never expanded rights', () => {
  const allow = { inherited: false, binary: 'synthetic-allow-user-full' }, deny = { inherited: false, binary: 'synthetic-deny-other-write' }
  const before = {owner:'owner',group:'group',protected:false,nullDacl:false,aces:[deny,allow]}
  assertCatalogAclPreserved(before, {...before,aces:[deny,allow,{...allow,inherited:true}]})
  for (const change of [
    {owner:'other'}, {group:'other'}, {protected:true}, {nullDacl:true},
    {aces:[allow,deny]}, {aces:[deny]},
    {aces:[deny,allow,{inherited:true,binary:'new-subject-or-mask'}]},
    {aces:[deny,allow,allow]}, {aces:[{...allow,inherited:true},deny,allow]},
  ]) assert.throws(() => assertCatalogAclPreserved(before, {...before,...change}))
  assert.throws(() => assertCatalogAclPreserved({...before,protected:true},before))
  assert.throws(() => assertCatalogAclPreserved({...before,aces:[{...allow,inherited:true}]},{...before,aces:[allow]}))
})
test('edit in the final replacement window is preserved, detected and stops future sync', async t => {
  const f = await disk(t); let calls = 0
  const userEdit = JSON.stringify({ ...original, userEdit: 'retain exactly' })
  const store = createPiCatalogStore(f.file, { replace: async args => {
    await fs.writeFile(f.file, userEdit)
    await commit(args)
  } })
  const lifecycle = new PiCatalogLifecycle({ ...f, store, providerId: 'approved', discover: async () => { calls++; return [addition] } })
  assert.equal(await lifecycle.tick(), 'conflict')
  const files = await fs.readdir(f.config.piConfigDir), backup = files.find(n => n.endsWith('.previous'))
  assert.equal(await fs.readFile(path.join(f.config.piConfigDir, backup), 'utf8'), userEdit)
  assert.ok(files.includes('.pi-models-pending.json'))
  const laterEdit = JSON.stringify({ subsequentEdit: true })
  await fs.writeFile(f.file, laterEdit)
  assert.equal(await lifecycle.tick(), 'conflict'); assert.equal(calls, 1)
  await assert.rejects(storeFor(f.file).read(), { code: 'catalog_recovery_required' })
  assert.equal(await fs.readFile(f.file, 'utf8'), laterEdit)
})
test('same bytes from a different file identity are also a conflict', async t => {
  const f = await disk(t)
  const store = createPiCatalogStore(f.file, { replace: async args => {
    const editorDirectory = path.join(f.config.piConfigDir, 'pi-catalog-editor')
    await fs.mkdir(editorDirectory)
    const editor = path.join(editorDirectory, 'models.json')
    await fs.writeFile(editor, f.raw)
    if (process.platform === 'win32') await fixtureAcl(editor, 'restrict-fixture')
    await fs.rename(editor, f.file); await fs.rmdir(editorDirectory)
    await commit(args)
  } })
  const before = await store.read()
  await assert.rejects(store.compareAndSwap(before, before + '\n'), { code: 'catalog_recovery_required' })
})
test('interruption before, during or after replacement never triggers automatic restoration', async t => {
  for (const phase of ['prepared', 'displaced', 'replaced']) {
    const f = await disk(t)
    const store = createPiCatalogStore(f.file, { replace: async args => {
      if (phase === 'displaced') await fs.rename(args.file, args.backup)
      if (phase === 'replaced') await commit(args)
      throw Error('injected_interruption')
    } })
    const before = await store.read()
    await assert.rejects(store.compareAndSwap(before, before + '\n'), { code: 'catalog_recovery_required' })
    const files = await fs.readdir(f.config.piConfigDir), old = phase === 'prepared' ? f.file : path.join(f.config.piConfigDir, files.find(n => n.endsWith('.previous')))
    assert.equal(await fs.readFile(old, 'utf8'), before)
    await fs.writeFile(f.file, 'new user bytes after interruption')
    await assert.rejects(storeFor(f.file).read(), { code: 'catalog_recovery_required' })
    assert.equal(await fs.readFile(f.file, 'utf8'), 'new user bytes after interruption')
  }
})
test('late writes through an old handle are retained and stop the next cycle', async t => {
  const f = await disk(t), before = await f.store.read()
  assert.equal(await f.store.compareAndSwap(before, before + '\n'), true)
  const files = await fs.readdir(f.config.piConfigDir)
  const backup = path.join(f.config.piConfigDir, files.find(n => n.endsWith('.previous')))
  await fs.writeFile(backup, 'late editor bytes')
  await assert.rejects(storeFor(f.file).read(), { code: 'catalog_recovery_required' })
  assert.equal(await fs.readFile(backup, 'utf8'), 'late editor bytes')
})
