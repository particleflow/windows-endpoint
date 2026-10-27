import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DeploymentTransactions, deploymentReferences } from './deployment.mjs'
import { verifyCandidate, stageCandidate } from './candidate.mjs'
import { validateConfig } from './endpoint.mjs'
import { EndpointLifecycle, acquireLeases, leaseKeys } from './lifecycle.mjs'
import { TransferLifecycle } from './transfer-lifecycle.mjs'
import { deploymentFixture, fixtureManager, syntheticCandidate } from './test-support/deployment-fixture.mjs'

async function staged(f) {
  await f.manager.stage(f.a.directory, f.a.hash)
  await f.manager.stage(f.b.directory, f.b.hash)
}
async function journal(f) { return fs.readFile(f.manager.file, 'utf8') }
async function preserved(f) {
  for (const file of f.originals) assert.equal(await fs.readFile(file, 'utf8'), 'SYNTHETIC USER FILE: PRESERVE EXACTLY')
}

test('offline install, update, rollback and repeated selection preserve config and business data', async t => {
  const f = await deploymentFixture(t); await staged(f)
  assert.equal((await f.manager.initialize()).state, 'already_initialized')
  assert.equal((await f.manager.stage(f.a.directory, f.a.hash)).state, 'already_staged')
  const lifecycle = await fs.readFile(f.store.file, 'utf8')
  const before = await journal(f)
  assert.equal((await f.manager.preflight(f.a.hash, 'install')).state, 'eligible_review_only')
  assert.equal(await journal(f), before)
  const installed = await f.manager.select(f.a.hash, 'install')
  assert.equal(installed.state, 'selected_review_only')
  assert.equal(installed.activation, 'blocked'); assert.equal(installed.transferAutomaticRecovery, false)
  assert.equal((await f.manager.select(f.a.hash, 'install')).state, 'already_selected')
  await f.manager.select(f.b.hash, 'update')
  assert.equal((await f.manager.read()).current, f.b.hash)
  await f.manager.select(f.a.hash, 'rollback')
  assert.equal((await f.manager.read()).current, f.a.hash)
  assert.equal((await f.manager.select(f.a.hash, 'rollback')).state, 'already_selected')
  assert.equal(await fs.readFile(f.store.file, 'utf8'), lifecycle)
  await preserved(f)
})

test('relative template resolves one root without creating identities or writing user configuration', async t => {
  const f = await deploymentFixture(t)
  const refs = { manifestSha256: f.a.hash, nasOrigin: 'https://nas.example.test', deviceId: f.config.deviceId, runtimeId: f.config.runtimeId, instanceId: f.config.instanceId, session: f.config.session }
  const config = deploymentReferences(f.root, refs)
  assert.equal(config.transferStateDir, path.join(f.root, 'data/herdr/plugins/memoh.delivery'))
  assert.equal(config.agenvoConfigDir, path.join(f.root, 'config/agenvo'))
  assert.equal(config.bundleRoot, path.join(f.root, 'packages', f.a.hash))
  assert.equal(config.deviceId, f.config.deviceId)
  assert.throws(() => deploymentReferences(f.root, { ...refs, deviceId: 'create-one-for-me' }))
  await preserved(f)
})

test('mutable roots equal to or inside packages/control are rejected without writes', async t => {
  const f = await deploymentFixture(t)
  const before = await journal(f)
  for (const protectedRoot of [f.manager.layout.packages, f.manager.layout.control]) {
    for (const sourceRoot of [protectedRoot, path.join(protectedRoot, 'user-exports')]) {
      await fs.mkdir(sourceRoot, { recursive: true })
      const marker = path.join(sourceRoot, 'user-original.txt')
      await fs.writeFile(marker, 'keep')
      const config = { ...f.config, sourceRoot }
      validateConfig(config)
      const manager = fixtureManager({ ...f.settings, config })
      await assert.rejects(manager.stage(f.a.directory, f.a.hash), { code: 'deployment_mutable_root_overlap' })
      assert.equal(await journal(f), before)
      assert.equal(await fs.readFile(marker, 'utf8'), 'keep')
    }
  }
  await preserved(f)
})

test('packages/control inside any mutable ancestor, including custom sourceRoot, are rejected before initialization', async t => {
  const f = await deploymentFixture(t)
  const before = await journal(f)
  const ancestors = [f.config.sourceRoot, f.lifecycleDirectory, ...['herdrConfigRoot', 'herdrStateRoot', 'piConfigDir', 'transferConfigDir', 'transferStateDir'].map(key => f.config[key])]
  for (const ancestor of ancestors) {
    const root = path.join(ancestor, 'nested-install')
    await fs.mkdir(root)
    validateConfig(f.config)
    const manager = fixtureManager({ ...f.settings, root })
    await assert.rejects(manager.initialize(), { code: 'deployment_mutable_root_overlap' })
    assert.deepEqual(await fs.readdir(root), [])
    assert.equal(await journal(f), before)
  }
  await preserved(f)
})

test('independent mutable directories sharing only a packages/control name prefix remain valid', async t => {
  const f = await deploymentFixture(t)
  for (const name of ['packages-exports', 'control-exports']) {
    const sourceRoot = path.join(f.root, name)
    await fs.mkdir(sourceRoot)
    const marker = path.join(sourceRoot, 'user-original.txt')
    await fs.writeFile(marker, 'keep')
    const config = { ...f.config, sourceRoot }
    validateConfig(config)
    const manager = fixtureManager({ ...f.settings, config })
    assert.equal((await manager.initialize()).state, 'already_initialized')
    assert.ok(['staged_review_only', 'already_staged'].includes((await manager.stage(f.a.directory, f.a.hash)).state))
    assert.equal(await fs.readFile(marker, 'utf8'), 'keep')
  }
  await preserved(f)
})

test('missing component, missing qualification and unknown work fail without selecting', async t => {
  const f = await deploymentFixture(t)
  const unqualified = new DeploymentTransactions(f.settings)
  await assert.rejects(unqualified.stage(f.a.directory, f.a.hash), /deployment_candidate_adapter_required/)
  const noProfile = new DeploymentTransactions({ ...f.settings, verify: verifyCandidate, stage: stageCandidate })
  await assert.rejects(noProfile.stage(f.a.directory, f.a.hash), /deployment_component_qualification_missing/)
  await staged(f)
  const before = await journal(f)
  assert.equal((await fixtureManager(f.settings, { inspectWork: undefined }).select(f.a.hash, 'install')).reason, 'work_observation_unavailable')
  await fs.unlink(path.join(f.manager.layout.packages, f.b.hash, 'transfer/transferqueue.exe'))
  await assert.rejects(f.manager.select(f.b.hash, 'install'), /candidate_inventory_mismatch/)
  assert.equal(await journal(f), before)
})

test('busy, unknown, open admission and attention defer before transaction writes', async t => {
  const f = await deploymentFixture(t); await staged(f)
  const before = await journal(f)
  const safe = { schema: 1, admission: 'closed', tasks: 'idle', transfers: 'idle', stateProfileSha256: f.a.profile }
  for (const patch of [{ tasks: 'busy' }, { transfers: 'busy' }, { tasks: 'unknown' }, { transfers: 'unknown' }, { admission: 'open' }, { stateProfileSha256: null }]) {
    const manager = fixtureManager(f.settings, { inspectWork: async () => ({ ...safe, ...patch }) })
    assert.equal((await manager.select(f.a.hash, 'install')).state, 'deferred')
    assert.equal(await journal(f), before)
  }
  const state = await f.store.load(); state.attention = 'transfer_permission'; await f.store.save(state)
  assert.equal((await f.manager.select(f.a.hash, 'install')).reason, 'endpoint_attention')
  assert.equal((await f.store.load()).attention, 'transfer_permission')
  assert.equal(await journal(f), before)
})

test('incompatible state blocks rollback without changing selection or erasing the journal', async t => {
  const f = await deploymentFixture(t); await staged(f)
  await f.manager.select(f.a.hash, 'install'); await f.manager.select(f.b.hash, 'update')
  const next = await syntheticCandidate(path.join(f.base, 'source-next-format'), 'next', 2)
  await f.manager.stage(next.directory, next.hash)
  const before = await journal(f)
  assert.equal((await f.manager.select(next.hash, 'update')).reason, 'state_profile_incompatible')
  const upgradedState = fixtureManager({ ...f.settings, profile: next.profile })
  assert.equal((await upgradedState.select(f.a.hash, 'rollback')).reason, 'state_profile_incompatible')
  assert.equal(await journal(f), before)
  await preserved(f)
})

test('state change after prepare defers selection; explicit recovery keeps the old candidate', async t => {
  const f = await deploymentFixture(t); await staged(f); await f.manager.select(f.a.hash, 'install')
  let checks = 0
  const manager = fixtureManager(f.settings, { inspectWork: async () => ({ schema: 1, admission: 'closed', tasks: ++checks === 1 ? 'idle' : 'busy', transfers: 'idle', stateProfileSha256: f.a.profile }) })
  assert.equal((await manager.select(f.b.hash, 'update')).recoveryRequired, true)
  assert.equal((await manager.read()).current, f.a.hash)
  assert.equal((await manager.recover()).state, 'deferred')
  assert.equal((await f.manager.recover()).manifestSha256, f.a.hash)
})

test('bounded disk and injected read-only publication failures retain the previous selection', async t => {
  const f = await deploymentFixture(t); await staged(f); await f.manager.select(f.a.hash, 'install')
  const before = await journal(f)
  const full = fixtureManager(f.settings, { io: { ...fs, statfs: async () => ({ bsize: 4096, bavail: 0 }) } })
  await assert.rejects(full.select(f.b.hash, 'update'), /deployment_space_unavailable/)
  for (const code of ['EACCES', 'EROFS', 'ENOSPC']) {
    const readOnly = fixtureManager(f.settings, { io: { ...fs, rename: async () => { throw Object.assign(new Error('injected filesystem refusal'), { code }) } } })
    await assert.rejects(readOnly.select(f.b.hash, 'update'), code === 'ENOSPC' ? /deployment_space_unavailable/ : /deployment_storage_read_only/)
    assert.equal(await journal(f), before)
  }
  const inventory = await f.manager.inventory()
  assert.equal(inventory.retainedUnknownEntries.filter(p => p.startsWith('control/.deployment-')).length, 3)
  await preserved(f)
})

test('unrecorded packages, temp names, extra payloads and user files are retained', async t => {
  const f = await deploymentFixture(t); await staged(f)
  await fs.writeFile(path.join(f.root, 'user-notes.txt'), 'keep')
  await fs.mkdir(path.join(f.manager.layout.packages, '.pending-unknown'))
  await fs.writeFile(path.join(f.manager.layout.packages, '.pending-unknown/original'), 'keep')
  await fs.writeFile(path.join(f.manager.layout.packages, f.a.hash, 'foreign-original.txt'), 'keep')
  const before = await journal(f)
  await assert.rejects(f.manager.select(f.a.hash, 'install'), /candidate_inventory_mismatch/)
  const inventory = await f.manager.inventory()
  assert.equal(inventory.deletionImplemented, false)
  assert.ok(inventory.retainedUnknownEntries.includes('user-notes.txt'))
  assert.ok(inventory.retainedUnknownEntries.includes('packages/.pending-unknown'))
  assert.deepEqual(inventory.unverifiedOwnedPackages, [f.a.hash])
  assert.equal(await fs.readFile(path.join(f.manager.layout.packages, f.a.hash, 'foreign-original.txt'), 'utf8'), 'keep')
  assert.equal(await journal(f), before)
  await preserved(f)
})

test('unrecorded valid package is not silently adopted for later deletion', async t => {
  const f = await deploymentFixture(t)
  await fs.cp(f.a.directory, path.join(f.manager.layout.packages, f.a.hash), { recursive: true })
  await assert.rejects(f.manager.stage(f.a.directory, f.a.hash), /deployment_unowned_package_retained/)
  const inventory = await f.manager.inventory()
  assert.ok(inventory.retainedUnknownEntries.includes(`packages/${f.a.hash}`))
  assert.deepEqual(inventory.ownedPackages, [])
})

test('incompatible or damaged transaction journal is never reset to an empty installation', async t => {
  const f = await deploymentFixture(t); await staged(f)
  for (const raw of ['{"schema":99}', '{']) {
    await fs.writeFile(f.manager.file, raw)
    await assert.rejects(f.manager.recover(), /deployment_journal_incompatible|deployment_journal_unreadable/)
    await assert.rejects(f.manager.initialize(), /deployment_journal_incompatible|deployment_journal_unreadable/)
    assert.equal(await fs.readFile(f.manager.file, 'utf8'), raw)
  }
  await preserved(f)
})

for (const failed of [false, true]) test(`existing endpoint holds the update gate through ${failed ? 'failed' : 'successful'} stop drain`, async t => {
  const f = await deploymentFixture(t); await staged(f)
  let finish, entered
  const ready = new Promise(r => { entered = r })
  const transfer = new TransferLifecycle({ driver: { invoke: async () => new Promise(resolve => { finish = () => resolve({ status: failed ? 1 : 0, stdout: JSON.stringify({ schema: 'memoh.delivery.lifecycle.v1', state: failed ? 'blocked' : 'idle', next_due_at: null, error_class: failed ? 'permission' : 'none' }) }); entered() }) } })
  const alive = new Set(), calls = []
  const driver = { validate: async () => {}, hostStatus: () => ({ running: alive.has('herdr') }), alive: c => alive.has(c), ownedHostStatus: async () => ({ running: true, version: '0.9.5', endpoint_compatible: true }),
    connectorStatus: async () => ({ state: 'online' }), start: async c => { alive.add(c); calls.push(`start:${c}`) }, waitReady: async () => {}, stop: async c => { alive.delete(c); calls.push(`stop:${c}`) } }
  const lifecycle = new EndpointLifecycle({ driver, transfer, store: f.store, acquire: () => acquireLeases(leaseKeys(f.config), f.lifecycleDirectory) })
  await lifecycle.start()
  assert.equal((await f.manager.select(f.a.hash, 'install')).reason, 'endpoint_owned')
  const tick = lifecycle.tick(); await ready
  const stop = lifecycle.stop()
  assert.equal((await f.manager.select(f.a.hash, 'install')).reason, 'endpoint_owned')
  assert.equal(calls.some(c => c.startsWith('stop:')), false)
  finish(); await Promise.all([tick, stop])
  const result = await f.manager.select(f.a.hash, 'install')
  if (failed) { assert.equal(result.reason, 'endpoint_attention'); assert.equal((await f.manager.read()).current, null) }
  else { assert.equal(result.state, 'selected_review_only'); assert.equal((await f.manager.read()).current, f.a.hash) }
})

async function terminateAt(f, phase, operation, target, source = '') {
  const worker = fileURLToPath(new URL('./test-support/deployment-worker.mjs', import.meta.url))
  const child = fork(worker, [f.input, operation, target, source, phase], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const exited = new Promise(resolve => child.once('exit', resolve))
  const timeout = setTimeout(() => child.kill(), 10000)
  try {
    const message = await new Promise((resolve, reject) => {
      child.once('message', resolve)
      child.once('error', reject)
      child.once('exit', () => reject(new Error('fixture exited before checkpoint')))
    })
    assert.deepEqual(message, { checkpoint: phase })
    assert.equal(child.exitCode, null); assert.equal(child.signalCode, null)
    assert.equal(child.kill(), true); await exited
  } finally { clearTimeout(timeout); if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited } }
  if (process.platform !== 'win32') {
    // Unix socket files outlive their process; production deliberately fails
    // closed. Only this test's known-dead child-owned socket names are removed.
    // Windows uses actual lifetime pipes and needs no fixture lock cleanup.
    for (const key of [...leaseKeys(f.config), `host:${f.root}`, `deployment:${f.root}`]) {
      const id = createHash('sha256').update(key.toLowerCase()).digest('hex').slice(0, 32)
      const file = path.join(f.lifecycleDirectory, `${id}.sock`)
      assert.equal((await fs.lstat(file)).isSocket(), true)
      await fs.unlink(file)
    }
  }
}

for (const phase of ['stage_prepared', 'stage_copying', 'stage_published']) {
  test(`owned process termination at ${phase} recovers without deleting interrupted copies`, async t => {
    const f = await deploymentFixture(t)
    await terminateAt(f, phase, 'stage', f.a.hash, f.a.directory)
    assert.equal((await f.manager.read()).pending.kind, 'stage')
    await f.manager.recover()
    await f.manager.stage(f.a.directory, f.a.hash)
    assert.deepEqual((await f.manager.inventory()).ownedPackages, [f.a.hash])
    if (phase === 'stage_copying') assert.ok((await f.manager.inventory()).retainedUnknownEntries.some(p => p.startsWith('packages/.pending-')))
    await preserved(f)
  })
}
for (const phase of ['switch_prepared', 'switch_selected', 'switch_committed']) {
  test(`owned process termination at ${phase} retains one recoverable candidate selection`, async t => {
    const f = await deploymentFixture(t); await staged(f); await f.manager.select(f.a.hash, 'install')
    await terminateAt(f, phase, 'update', f.b.hash)
    const expected = phase === 'switch_prepared' ? f.a.hash : f.b.hash
    assert.equal((await f.manager.read()).current, expected)
    await f.manager.recover()
    assert.equal((await f.manager.read()).current, expected)
    assert.equal((await f.manager.recover()).state, 'no_recovery_needed')
    await preserved(f)
  })
}
