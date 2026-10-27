import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EndpointLifecycle, LifecycleError, StateStore, NativeDriver, acquireLeases, connectorAttention, leaseKeys } from './lifecycle.mjs'
import { managedEnvironment } from './endpoint.mjs'
import { TransferError, TransferLifecycle } from './transfer-lifecycle.mjs'

function driverConfig(directory) {
  return { schema: 3, programs: { node: process.execPath, herdr: path.join(directory, 'herdr.exe'), piPackage: directory, piBin: directory, gitRoot: directory, connectorPackage: path.join(directory, 'runtime') },
    connector: { kind: 'memoh-runtime', enrollmentFile: path.join(directory, 'enrollment.json') },
    sourceRoot: directory, herdrConfigRoot: directory, herdrStateRoot: directory, piConfigDir: directory, session: 'default', deviceId: 'fixture-device', runtimeId: 'fixture-runtime' }
}

async function fixture(t, options = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'endpoint-life-')))
  const calls = [], alive = new Set()
  const driver = {
    status: { state: 'online', lastError: '' },
    validate: async () => { calls.push('validate') },
    hostStatus: () => ({ running: alive.has('herdr'), version: '0.9.5', endpoint_compatible: true }),
    alive: c => alive.has(c),
    ownedHostStatus: () => driver.hostStatus(),
    connectorStatus: async () => driver.status,
    start: async c => { calls.push(`start:${c}`); alive.add(c) },
    waitReady: async c => { calls.push(`ready:${c}`) },
    stop: async c => { calls.push(`stop:${c}`); alive.delete(c) },
    recoverConnector: async () => { calls.push('recover:connector') },
  }
  const store = new StateStore(directory, 'fixture-device')
  const create = (overrides = {}) => new EndpointLifecycle({ driver, store, acquire: () => acquireLeases([directory], directory), clock: () => 1000000, delay: async () => {}, ...options, ...overrides })
  const lifecycle = create()
  t.after(async () => { if (lifecycle.release) await lifecycle.stop(); await fs.rm(directory, { recursive: true, force: true }) })
  return { lifecycle, create, driver, alive, calls, store, directory }
}

test('starts Herdr API before connector and normal stop reverses order', async t => {
  const { lifecycle, calls } = await fixture(t)
  const snapshot = await lifecycle.start()
  assert.deepEqual(calls, ['validate', 'start:herdr', 'ready:herdr', 'start:connector', 'ready:connector'])
  assert.equal(snapshot.ready, false)
  assert.equal(snapshot.transfer, 'lifecycle_interface_pending')
  await lifecycle.stop()
  assert.deepEqual(calls.slice(-2), ['stop:connector', 'stop:herdr'])
})

test('stop checkpoint is recorded after cleanup and consumed before a fresh component start', async t => {
  const f = await fixture(t), checkpoint = { schema: 1, binding: 'a'.repeat(64), configuration: 'b'.repeat(64), snapshot: 'c'.repeat(64), ordinary: true }
  f.driver.captureContinuation = async () => { assert.equal(f.alive.size, 0); return checkpoint }
  await f.lifecycle.start(); await f.lifecycle.stop()
  assert.deepEqual((await f.store.load()).sessionContinuation, checkpoint)
  const next = f.create(), originalStart = f.driver.start
  f.driver.validate = async state => assert.deepEqual(state.sessionContinuation, checkpoint)
  f.driver.start = async component => { assert.equal((await f.store.load()).sessionContinuation, undefined); await originalStart(component) }
  await next.start(); await next.stop()
})

test('failed cleanup cannot publish a continuation checkpoint or release ownership', async t => {
  const f = await fixture(t), stop = f.driver.stop
  f.driver.captureContinuation = async () => { assert.fail('failed cleanup must not checkpoint') }
  await f.lifecycle.start()
  f.driver.stop = async component => { if (component === 'herdr') throw new LifecycleError('herdr_stop_unknown'); await stop(component) }
  await assert.rejects(f.lifecycle.stop(), { code: 'herdr_stop_unknown' })
  assert.equal((await f.store.load()).sessionContinuation, undefined); assert.ok(f.lifecycle.release)
  delete f.driver.captureContinuation; f.driver.stop = stop; await f.lifecycle.stop()
})

test('checkpoint read failure preserves stopped evidence and attention without claiming resumability', async t => {
  const f = await fixture(t)
  f.driver.captureContinuation = async () => { throw Object.assign(new Error('unreadable'), { code: 'EACCES' }) }
  await f.lifecycle.start()
  await assert.rejects(f.lifecycle.stop(), { code: 'session_continuation_unavailable' })
  assert.equal(f.alive.size, 0); assert.equal(f.lifecycle.release, null)
  const saved = await f.store.load()
  assert.equal(saved.phase, 'stopped'); assert.equal(saved.attention, 'session_continuation_unavailable'); assert.equal(saved.sessionContinuation, undefined)
})

test('single instance protects shared identity even with another config location', async t => {
  const { lifecycle, create } = await fixture(t)
  await lifecycle.start()
  await assert.rejects(create().start(), /endpoint_already_owned/)
  const keys = leaseKeys({ deviceId: 'device', herdrConfigRoot: 'root', session: 'one', agenvoConfigDir: 'connector' })
  assert.equal(keys[0], 'device:device')
  await lifecycle.stop()
  const next = create(); await next.start(); await next.stop()
})

test('installation change keeps running components and persists attention until explicit stop', async t => {
  const { lifecycle, driver, alive, calls, store } = await fixture(t)
  await lifecycle.start(); calls.length = 0
  driver.checkPrograms = () => { throw new LifecycleError('installation_changed_restart_required') }
  await lifecycle.tick(); await lifecycle.tick()
  assert.equal(lifecycle.state.attention, 'installation_changed_restart_required')
  assert.deepEqual([...alive], ['herdr', 'connector']); assert.deepEqual(calls, [])
  assert.equal((await store.load()).attention, 'installation_changed_restart_required')
  await lifecycle.stop()
  assert.deepEqual(calls, ['stop:connector', 'stop:herdr'])
  assert.equal((await store.load()).phase, 'stopped')
  assert.equal((await store.load()).attention, 'installation_changed_restart_required')
})

test('concurrent wake checks recover a crashed connector once without restarting host', async t => {
  const { lifecycle, alive, calls } = await fixture(t)
  await lifecycle.start(); alive.delete('connector')
  await Promise.all([lifecycle.tick(), lifecycle.tick(), lifecycle.tick()])
  assert.equal(calls.filter(c => c === 'start:connector').length, 2)
  assert.equal(calls.filter(c => c === 'start:herdr').length, 1)
  assert.equal(lifecycle.state.restarts.length, 1)
})

test('host crash stops connector then revalidates and recovers in dependency order', async t => {
  const { lifecycle, alive, calls } = await fixture(t)
  await lifecycle.start(); alive.delete('herdr'); calls.length = 0
  await lifecycle.tick()
  assert.deepEqual(calls, ['stop:connector', 'validate', 'start:herdr', 'ready:herdr', 'start:connector', 'ready:connector'])
})

test('offline live connector retains ownership of network reconnect without supervisor retries', async t => {
  const { lifecycle, driver, calls } = await fixture(t)
  await lifecycle.start(); driver.status = { state: 'offline', lastError: 'connection_error' }
  await lifecycle.tick(); await lifecycle.tick()
  assert.equal(lifecycle.state.phase, 'running')
  assert.equal(lifecycle.state.restarts.length, 0)
  assert.equal(calls.filter(c => c.startsWith('start:')).length, 2)
})

for (const lastError of ['handshake_401', 'handshake_403', 'handshake_426', 'config_changed_restart_required']) {
  test(`terminal ${lastError} persists attention and never restarts`, async t => {
    const { lifecycle, driver, alive, create, calls } = await fixture(t)
    await lifecycle.start(); driver.status = { state: 'needs_attention', lastError }; alive.delete('connector')
    await lifecycle.tick(); await lifecycle.tick()
    assert.equal(lifecycle.state.attention, connectorAttention(driver.status))
    assert.equal(lifecycle.state.restarts.length, 0)
    await lifecycle.stop()
    await assert.rejects(create().start(), new RegExp(connectorAttention(driver.status)))
    assert.equal(calls.filter(c => c.startsWith('start:')).length, 2)
  })
}

test('restart budget survives stop/start and explicit acknowledgement does not reset it', async t => {
  const { lifecycle, alive, create } = await fixture(t)
  await lifecycle.start()
  for (let i = 0; i < 4; i++) { alive.delete('connector'); await lifecycle.tick() }
  assert.equal(lifecycle.state.attention, 'restart_budget_exhausted')
  await lifecycle.stop()
  const next = create()
  await next.start({ acknowledgeAttention: true })
  alive.delete('connector'); await next.tick()
  assert.equal(next.state.attention, 'restart_budget_exhausted')
  assert.equal(next.state.restarts.length, 3)
  await next.stop()
})

test('unknown host observation stops recovery without guessing from unavailable', async t => {
  const { lifecycle, driver, calls } = await fixture(t)
  await lifecycle.start()
  driver.hostStatus = () => { throw new LifecycleError('herdr_observation_unknown') }
  await lifecycle.tick()
  assert.equal(lifecycle.state.attention, 'herdr_observation_unknown')
  assert.equal(calls.filter(c => c.startsWith('start:')).length, 2)
})

for (const reason of ['herdr_observation_unknown', 'herdr_owner_exited']) {
  test(`confirmed owned exit racing ${reason} recovers once through the existing budget`, async t => {
    const { lifecycle, driver, alive, calls, store } = await fixture(t)
    await lifecycle.start()
    // Reproduce PR5's sequence: one earlier connector restart, then Herdr dies
    // AFTER tick's alive check and BEFORE its owned status observation settles.
    alive.delete('connector'); await lifecycle.tick()
    let observedExit = false, observations = 0
    driver.confirmedExit = c => c === 'herdr' && observedExit && !alive.has(c)
    driver.ownedHostStatus = async () => {
      observations++; alive.delete('herdr'); observedExit = true
      throw new LifecycleError(reason)
    }
    await Promise.all([lifecycle.tick(), lifecycle.tick()])
    assert.equal(lifecycle.state.attention, null)
    assert.equal(lifecycle.state.phase, 'running')
    assert.equal(lifecycle.state.restarts.length, 2)
    assert.equal((await store.load()).restarts.length, 2)
    assert.equal(calls.filter(c => c === 'start:herdr').length, 2)
    assert.equal(calls.filter(c => c === 'start:connector').length, 3)
    assert.equal(observations, 1)
    assert.equal(lifecycle.snapshot().ready, false)
  })
}

for (const reason of ['herdr_owner_mismatch', 'herdr_generation_changed', 'herdr_ownership_unverified']) {
  test(`owned exit does not excuse ${reason} or touch a possible external successor`, async t => {
    const { lifecycle, driver, alive, calls, store } = await fixture(t)
    await lifecycle.start()
    driver.confirmedExit = () => true
    driver.ownedHostStatus = async () => { alive.delete('herdr'); throw new LifecycleError(reason) }
    await lifecycle.tick()
    assert.equal(lifecycle.state.attention, reason)
    assert.equal((await store.load()).attention, reason)
    assert.equal(lifecycle.state.restarts.length, 0)
    assert.equal(calls.filter(c => c.startsWith('start:')).length, 2)
  })
}

test('missing owned-exit proof keeps an observation error terminal even if alive becomes false', async t => {
  const { lifecycle, driver, alive, calls } = await fixture(t)
  await lifecycle.start()
  driver.confirmedExit = () => false
  driver.ownedHostStatus = async () => { alive.delete('herdr'); throw new LifecycleError('herdr_observation_unknown') }
  await lifecycle.tick()
  assert.equal(lifecycle.state.attention, 'herdr_observation_unknown')
  assert.equal(lifecycle.state.restarts.length, 0)
  assert.equal(calls.filter(c => c.startsWith('start:')).length, 2)
})

test('stop crossing a confirmed owned exit drains without starting a replacement', async t => {
  const { lifecycle, driver, alive, calls, store } = await fixture(t)
  await lifecycle.start()
  let finish, entered
  const waiting = new Promise(resolve => { entered = resolve })
  driver.confirmedExit = () => !alive.has('herdr')
  driver.ownedHostStatus = () => new Promise((_, reject) => {
    finish = () => { alive.delete('herdr'); reject(new LifecycleError('herdr_observation_unknown')) }; entered()
  })
  const tick = lifecycle.tick(); await waiting
  const stop = lifecycle.stop(); finish(); await Promise.all([tick, stop])
  assert.equal(lifecycle.state.phase, 'stopped'); assert.equal(lifecycle.state.attention, null)
  assert.equal(lifecycle.state.restarts.length, 0); assert.equal(lifecycle.release, null)
  assert.equal((await store.load()).phase, 'stopped')
  assert.equal(calls.filter(c => c.startsWith('start:')).length, 2)
})

test('confirmed exit still respects the original recovery budget and external-server guard', async t => {
  const f = await fixture(t)
  await f.lifecycle.start()
  f.driver.confirmedExit = () => !f.alive.has('herdr')
  f.driver.ownedHostStatus = async () => { f.alive.delete('herdr'); throw new LifecycleError('herdr_observation_unknown') }
  const start = f.driver.start
  f.driver.start = async c => { if (c === 'herdr') throw new LifecycleError('existing_herdr_requires_handoff'); await start(c) }
  await f.lifecycle.tick()
  assert.equal(f.lifecycle.state.attention, 'existing_herdr_requires_handoff')
  assert.equal(f.lifecycle.state.restarts.length, 1)
  assert.equal(f.calls.filter(c => c === 'start:herdr').length, 1)
  assert.equal(f.calls.includes('stop:herdr'), false)

  const other = await fixture(t, { policy: { maxRestarts: 0 } })
  await other.lifecycle.start()
  other.driver.confirmedExit = () => true
  other.driver.ownedHostStatus = async () => { other.alive.delete('herdr'); throw new LifecycleError('herdr_observation_unknown') }
  await other.lifecycle.tick()
  assert.equal(other.lifecycle.state.attention, 'restart_budget_exhausted')
  assert.equal(other.lifecycle.state.restarts.length, 0)
  assert.equal(other.calls.filter(c => c.startsWith('start:')).length, 2)
})

test('native exit proof needs an exit event plus a previously captured generation on that child', async t => {
  const { directory } = await fixture(t)
  const config = driverConfig(directory)
  const driver = new NativeDriver(config)
  const owned = { process: { pid: 123, killed: true }, generation: '123:456', exited: false, error: false, exitObserved: false }
  driver.children.set('herdr', owned)
  assert.equal(driver.confirmedExit('herdr'), false, 'kill request is not exit proof')
  owned.exited = true
  assert.equal(driver.confirmedExit('herdr'), false, 'unattributed exit flag is not an observed exit')
  owned.exitObserved = true
  assert.equal(driver.confirmedExit('herdr'), true)
  for (const changes of [{ error: true }, { generation: undefined }, { generation: '999:456' }, { exitObserved: false }]) {
    driver.children.set('herdr', { ...owned, ...changes })
    assert.equal(driver.confirmedExit('herdr'), false)
  }
  driver.children.delete('herdr')
  assert.equal(driver.confirmedExit('herdr'), false)
})

test('native runtime status probe lets pending process events run before reporting command failure', async t => {
  const { directory } = await fixture(t)
  const driver = new NativeDriver(driverConfig(directory))
  // Node deliberately rejects Herdr's --session argv. This is a real finite
  // subprocess but not a mock claim about Herdr or Windows named pipes.
  driver.herdr = process.execPath
  let eventLoopTurn = false
  const pending = new Promise(resolve => setImmediate(() => { eventLoopTurn = true; resolve() }))
  await assert.rejects(driver.observeHostStatus(), { code: 'herdr_observation_unknown' })
  assert.equal(eventLoopTurn, true, 'status observation must not starve owned-child exit delivery')
  await pending
})

async function nativeConnectorFixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'endpoint-native-child-')))
  const config = driverConfig(directory), api = path.join(config.programs.connectorPackage, 'dist/endpoint-host-api.mjs')
  await fs.mkdir(path.dirname(api), { recursive: true })
  await fs.writeFile(api, `
export class RuntimeSession {}
export const formatCLIError = e => e.message;
export function runCLI() {
  const timer = setInterval(() => {}, 1000);
  process.once('SIGTERM', () => { clearInterval(timer); console.log('stopped') });
  console.log('connected'); return Promise.resolve(0);
}
`)
  const driver = new NativeDriver(config)
  await driver.start('connector')
  const child = driver.nativeConnector.record, kill = child.process.kill.bind(child.process)
  t.after(async () => {
    if (!child.closed) { kill(); await child.done }
    await fs.rm(directory, { recursive: true, force: true })
  })
  await driver.waitReady('connector')
  return { directory, driver, child }
}

test('native child error after spawn cannot authorize a duplicate component or satisfy exit', async t => {
  const { driver, child } = await nativeConnectorFixture(t)
  let done = false; child.done.then(() => { done = true })
  // Fault injection on a real owned process: Node also emits error when kill
  // fails. No OS permission change or real EPERM condition is induced here.
  child.process.emit('error', Object.assign(new Error('synthetic kill failure'), { code: 'EPERM' }))
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(child.exitObserved, false)
  assert.equal(child.exited, false)
  assert.equal(done, false)
  assert.equal(driver.alive('connector'), true)
  await assert.rejects(driver.start('connector'), { code: 'component_already_owned' })
  assert.equal(driver.nativeConnector.record, child)
  await assert.rejects(driver.stop('connector'), { code: 'connector_stop_unknown' })
  assert.equal(child.exitObserved, true)
})

test('native failed graceful stop keeps the lifecycle lease until explicit stop confirms actual cleanup', async t => {
  const { directory, driver, child } = await nativeConnectorFixture(t)
  const store = new StateStore(directory, 'synthetic-kill-failure')
  const lifecycle = new EndpointLifecycle({ driver, store, acquire: () => acquireLeases([directory], directory) })
  lifecycle.state = await store.load(); lifecycle.state.phase = 'running'
  lifecycle.release = await lifecycle.acquire()
  let checkpoints = 0
  driver.captureContinuation = async () => { checkpoints++; return null }
  const stop = driver.nativeConnector.stop.bind(driver.nativeConnector)
  driver.nativeConnector.stop = async () => { throw new LifecycleError('connector_stop_unknown') }
  try {
    await assert.rejects(lifecycle.stop(), { code: 'connector_stop_unknown' })
    assert.equal(child.exitObserved, false); assert.equal(child.exited, false)
    assert.equal(checkpoints, 0)
    assert.equal((await store.load()).attention, 'connector_stop_unknown')
    await assert.rejects(acquireLeases([directory], directory), { code: 'endpoint_already_owned' })
    // Repeated failure remains handled and cannot release the same lease.
    await assert.rejects(lifecycle.stop(), { code: 'connector_stop_unknown' })
    driver.nativeConnector.stop = stop
    await lifecycle.stop()
    assert.equal(child.exitObserved, true); assert.equal(lifecycle.release, null)
    const release = await acquireLeases([directory], directory); await release()
  } finally {
    driver.nativeConnector.stop = stop
    if (lifecycle.release) await lifecycle.stop()
  }
})

test('native spawn failure without a PID remains a completed failed start', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'endpoint-spawn-failure-')))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const driver = new NativeDriver(driverConfig(directory))
  driver.nativeConnector.options.node = path.join(directory, 'missing-node.exe')
  await driver.start('connector')
  const child = driver.nativeConnector.record
  await child.done
  assert.equal(child.process.pid, undefined)
  assert.equal(driver.alive('connector'), false)
  assert.equal(child.exitObserved, false)
  await driver.stop('connector')
})

test('native startup preserves a classified configuration or authentication failure after the child has exited', async t => {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'endpoint-native-start-')))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const driver = new NativeDriver(driverConfig(directory))
  for (const [lastError, expected] of [['native_configuration_invalid', 'connector_configuration_invalid'], ['handshake_403', 'connector_authentication_required'], ['native_tls_verification_failed', 'connector_tls_verification_failed']]) {
    driver.nativeConnector = { alive: () => false, status: () => ({ state: 'needs_attention', lastError }) }
    await assert.rejects(driver.waitReady('connector'), { code: expected })
  }
})

test('preexisting host is never adopted or started over', async t => {
  const { lifecycle, driver, calls } = await fixture(t)
  driver.hostStatus = () => ({ running: true })
  await assert.rejects(lifecycle.start(), /existing_herdr_requires_handoff/)
  assert.equal(calls.some(c => c.startsWith('start:')), false)
  // NativeDriver.stop only touches owned child handles; no PID/process lookup kill.
})

test('partial startup failure cleans up owned children and releases lease', async t => {
  const { lifecycle, driver, alive } = await fixture(t)
  driver.waitReady = async c => { if (c === 'connector') throw new LifecycleError('connector_startup_exited') }
  await assert.rejects(lifecycle.start(), /connector_startup_exited/)
  assert.equal(alive.size, 0); assert.equal(lifecycle.release, null)
})

test('stop during backoff prevents respawn', async t => {
  let resume, waiting
  const entered = new Promise(r => { waiting = r })
  const f = await fixture(t, { delay: () => new Promise(r => { resume = r; waiting() }) })
  await f.lifecycle.start(); f.alive.delete('connector')
  const tick = f.lifecycle.tick(); await entered
  const stop = f.lifecycle.stop(); resume(); await Promise.all([tick, stop])
  assert.equal(f.calls.filter(c => c === 'start:connector').length, 1)
  assert.equal(f.alive.size, 0)
})

test('lifecycle journal never alters original files, session or transfer journal', async t => {
  const { lifecycle, directory } = await fixture(t)
  const originals = ['original.bin', 'session.json', 'queue.jsonl', 'credentials.json']
  for (const file of originals) await fs.writeFile(path.join(directory, file), `unchanged:${file}`)
  await lifecycle.start(); await lifecycle.stop()
  for (const file of originals) assert.equal(await fs.readFile(path.join(directory, file), 'utf8'), `unchanged:${file}`)
})

test('shared managed environment removes all reserved pollution, not just overlay keys', () => {
  const config = { bundleRoot: '/bundle', herdrConfigRoot: '/config/herdr', herdrStateRoot: '/state/herdr', agenvoConfigDir: '/agenvo', piConfigDir: '/pi' }
  const env = managedEnvironment(config, { PATH: 'polluted', NODE_OPTIONS: '--require=bad', NODE_PATH: '/bad', BASH_ENV: '/bad', ENV: '/bad', HERDR_SESSION: 'bad', HERDR_SOCKET: '/bad', AGENVO_SECRET: 'bad', BASH_FUNC_bad: 'bad', SystemRoot: 'C:\\Windows' })
  for (const key of ['NODE_OPTIONS', 'NODE_PATH', 'BASH_ENV', 'ENV', 'HERDR_SESSION', 'HERDR_SOCKET', 'AGENVO_SECRET', 'BASH_FUNC_bad']) assert.equal(env[key], undefined)
  assert.equal(env.PATH.includes('polluted'), false)
  assert.equal(env.AGENVO_CONFIG_DIR, undefined)
})


test('stop during startup waits for owned cleanup and never starts connector', async t => {
  const { lifecycle, driver, alive, calls } = await fixture(t)
  let resume, entered
  const ready = new Promise(r => { entered = r })
  driver.waitReady = async c => { if (c === 'herdr') await new Promise(r => { resume = r; entered() }) }
  const start = lifecycle.start()
  const rejected = assert.rejects(start, /startup_cancelled/)
  await ready
  const stops = [lifecycle.stop(), lifecycle.stop()]
  resume(); await Promise.all([rejected, ...stops])
  assert.equal(calls.includes('start:connector'), false)
  assert.equal(alive.size, 0)
  assert.equal(lifecycle.release, null)
  assert.equal(lifecycle.state.attention, null)
})


test('official stopped snapshot needs attention and is not treated as a crash', async t => {
  const { lifecycle, driver, alive, calls } = await fixture(t)
  await lifecycle.start(); driver.status = { state: 'stopped', lastError: '' }; alive.delete('connector')
  await lifecycle.tick()
  assert.equal(lifecycle.state.attention, 'connector_stopped_requires_attention')
  assert.equal(lifecycle.state.restarts.length, 0)
  assert.equal(calls.filter(c => c === 'start:connector').length, 1)
})


test('replacement connector never inherits the old process online observation', async t => {
  const { lifecycle, driver, alive } = await fixture(t)
  await lifecycle.start(); await lifecycle.tick()
  assert.equal(lifecycle.snapshot().connection, 'online_snapshot')
  const start = driver.start
  driver.start = async c => { await start(c); if (c === 'connector') driver.status = { state: 'connecting' } }
  alive.delete('connector'); await lifecycle.tick()
  assert.equal(lifecycle.snapshot().connection, 'connecting')
  await lifecycle.stop()
  assert.equal(lifecycle.snapshot().connection, 'stopped')
})

for (const failureCode of ['ENOSPC', 'EACCES']) {
  test(`stop cleans all owned children even when journal writes fail with ${failureCode}`, async t => {
    const { lifecycle, store, alive, calls } = await fixture(t)
    await lifecycle.start()
    const original = Object.assign(new Error('synthetic journal failure'), { code: failureCode })
    store.save = async () => { throw original }
    await assert.rejects(lifecycle.stop(), error => error.code === 'lifecycle_state_write_failed' && error.cause === original)
    assert.deepEqual(calls.slice(-2), ['stop:connector', 'stop:herdr'])
    assert.equal(alive.size, 0)
    assert.equal(lifecycle.release, null)
    assert.equal(lifecycle.snapshot().journal, 'unavailable')
  })

  test(`partial startup preserves original error and cleans up when attention writes fail with ${failureCode}`, async t => {
    const { lifecycle, store, driver, alive, calls } = await fixture(t)
    const original = new LifecycleError('connector_startup_exited')
    const save = store.save.bind(store)
    store.save = async state => { if (state.phase === 'needs_attention') throw Object.assign(new Error('synthetic'), { code: failureCode }); await save(state) }
    driver.waitReady = async c => { if (c === 'connector') throw original }
    await assert.rejects(lifecycle.start(), error => error === original)
    assert.deepEqual(calls.slice(-2), ['stop:connector', 'stop:herdr'])
    assert.equal(alive.size, 0)
    assert.equal(lifecycle.release, null)
    assert.equal(lifecycle.snapshot().journal, 'unavailable')
  })
}

test('failed connector cleanup still stops owned Herdr and retains the lease', async t => {
  const { lifecycle, driver, alive, calls } = await fixture(t)
  await lifecycle.start()
  const stop = driver.stop
  const original = new LifecycleError('connector_stop_unknown')
  driver.stop = async c => { if (c === 'connector') { calls.push('stop:connector'); throw original } await stop(c) }
  try {
    await assert.rejects(lifecycle.stop(), error => error === original)
    assert.equal(alive.has('herdr'), false)
    assert.equal(alive.has('connector'), true)
    assert.ok(lifecycle.release)
    assert.equal(lifecycle.snapshot().cleanupAttention, 'connector_stop_unknown')
  } finally { driver.stop = stop; await lifecycle.stop() }
})

test('stop during async recovery qualification prevents any replacement spawn', async t => {
  const { lifecycle, driver, alive, calls } = await fixture(t)
  await lifecycle.start()
  let resume, entered
  const waiting = new Promise(r => { entered = r })
  driver.validate = async () => new Promise(r => { resume = r; entered() })
  alive.delete('connector')
  const tick = lifecycle.tick(); await waiting
  const stop = lifecycle.stop(); resume(); await Promise.all([tick, stop])
  assert.equal(calls.filter(c => c === 'start:connector').length, 1)
  assert.equal(calls.filter(c => c === 'start:herdr').length, 1)
  assert.equal(alive.size, 0)
  assert.equal(lifecycle.release, null)
})

test('stop still cleans children when awaited active tick cannot persist attention', async t => {
  const { lifecycle, driver, store, alive } = await fixture(t)
  await lifecycle.start()
  let resume, entered
  const waiting = new Promise(r => { entered = r })
  driver.connectorStatus = () => new Promise(r => { resume = () => r({ state: 'needs_attention', lastError: 'handshake_401' }); entered() })
  const original = Object.assign(new Error('synthetic disk failure'), { code: 'ENOSPC' })
  store.save = async () => { throw original }
  const tick = lifecycle.tick(); const rejectedTick = assert.rejects(tick, error => error.cause === original)
  await waiting
  const stop = lifecycle.stop(); const rejectedStop = assert.rejects(stop, error => error.cause === original)
  resume(); await Promise.all([rejectedTick, rejectedStop])
  assert.equal(alive.size, 0)
  assert.equal(lifecycle.release, null)
  assert.equal(lifecycle.snapshot().journal, 'unavailable')
})


test('owned Herdr generation rejects replaced endpoint without sending stop', async t => {
  const { directory } = await fixture(t)
  const config = driverConfig(directory)
  const driver = new NativeDriver(config)
  driver.children.set('herdr', { process: { pid: 123 }, exited: false, generation: '123:456' })
  await fs.writeFile(driver.marker, '123:456')
  assert.equal(await driver.ownedGeneration(), '123:456')
  await fs.writeFile(driver.marker, '999:789')
  await assert.rejects(driver.stop('herdr'), /herdr_owner_mismatch/)
  await fs.writeFile(driver.marker, '123:789')
  await assert.rejects(driver.stop('herdr'), /herdr_generation_changed/)
})

test('unified lifecycle persists transfer failure and cannot bypass it by restarting', async t => {
  const actions = []
  const transfer = new TransferLifecycle({ driver: { invoke: async action => {
    actions.push(action)
    return { status: 1, stdout: JSON.stringify({ schema: 'memoh.delivery.lifecycle.v1', state: 'unknown', next_due_at: null, error_class: 'permission' }) }
  } } })
  const { lifecycle, create } = await fixture(t, { transfer })
  await lifecycle.start(); await lifecycle.tick()
  assert.equal(lifecycle.state.attention, 'transfer_permission')
  await lifecycle.stop()
  const next = create()
  await assert.rejects(next.start(), /transfer_permission/)
  assert.deepEqual(actions, ['lifecycle-summary'])
})

test('unified stop drains in-flight transfer before stopping components or releasing ownership', async t => {
  let finish, entered
  const ready = new Promise(r => { entered = r })
  const actions = []
  const transfer = new TransferLifecycle({ driver: { invoke: action => {
    actions.push(action)
    return new Promise(r => { finish = () => r({ status: 0, stdout: JSON.stringify({ schema: 'memoh.delivery.lifecycle.v1', state: 'due', next_due_at: null, error_class: 'none' }) }); entered() })
  } } })
  const { lifecycle, alive, calls } = await fixture(t, { transfer })
  await lifecycle.start()
  const tick = lifecycle.tick(); await ready
  const stop = lifecycle.stop()
  lifecycle.transferHint('completion')
  assert.equal(alive.size, 2); assert.ok(lifecycle.release)
  finish(); await Promise.all([tick, stop])
  assert.deepEqual(actions, ['lifecycle-summary'])
  assert.deepEqual(calls.slice(-2), ['stop:connector', 'stop:herdr'])
  assert.equal(alive.size, 0); assert.equal(lifecycle.release, null)
})

test('shared transfer state gets one endpoint lease even across devices and sessions', async t => {
  const { directory } = await fixture(t)
  const first = leaseKeys({ deviceId: 'one', session: 'one', herdrConfigRoot: 'one', agenvoConfigDir: 'one', transferStateDir: 'shared-state' })
  const second = leaseKeys({ deviceId: 'two', session: 'two', herdrConfigRoot: 'two', agenvoConfigDir: 'two', transferStateDir: 'shared-state' })
  const release = await acquireLeases(first, directory)
  try { await assert.rejects(acquireLeases(second, directory), /endpoint_already_owned/) }
  finally { await release() }
  const releaseNext = await acquireLeases(second, directory); await releaseNext()
})

const transferDecision = (state, error_class = 'none') => ({ schema: 'memoh.delivery.lifecycle.v1', state, next_due_at: null, error_class })
const transferResult = (action, value, status = 0) => ({ status, stdout: JSON.stringify(action === 'advance-results' ?
  { ...value, delivery_id: 'original-delivery', phase: 'uploading', offset: 3, admitted: true, associated: false, feedback_status: 'recorded' } : value) })

for (const action of ['lifecycle-summary', 'advance-results']) {
  for (const failure of [
    { name: 'due with exit 1', reason: 'transfer_command_outcome_unknown', result: () => transferResult(action, transferDecision('due'), 1) },
    { name: 'native timeout rejection', reason: 'transfer_command_outcome_unknown', reject: () => new TransferError('transfer_command_outcome_unknown') },
    { name: 'permission decision', reason: 'transfer_permission', result: () => transferResult(action, transferDecision('blocked', 'permission'), 1) },
    { name: 'native permission rejection', reason: 'transfer_permission', reject: () => new TransferError('transfer_permission') },
    { name: 'malformed JSON', reason: 'transfer_summary_output_invalid', result: () => ({ status: 0, stdout: '{' }) },
    { name: 'signaled process', reason: 'transfer_command_outcome_unknown', result: () => ({ status: null, signal: 'SIGTERM', stdout: '' }) },
  ]) {
    test(`stop drain preserves ${action} ${failure.name} before cleanup and across restart`, async t => {
      let finish, entered, completed = false
      const ready = new Promise(r => { entered = r })
      const actions = []
      const commandDriver = { invoke: async (requested, mayInvoke) => {
        assert.ok(mayInvoke()); actions.push(requested)
        if (completed) return transferResult(requested, transferDecision('idle'))
        if (requested !== action) return transferResult(requested, transferDecision('due'))
        return new Promise((resolve, reject) => {
          finish = () => { completed = true; if (failure.reject) reject(failure.reject()); else resolve(failure.result()) }
          entered()
        })
      } }
      const transfer = new TransferLifecycle({ driver: commandDriver })
      const f = await fixture(t, { transfer })
      const cleanupObservations = []
      const originalStop = f.driver.stop
      f.driver.stop = async component => {
        cleanupObservations.push({ component, attention: (await f.store.load()).attention, heldLease: Boolean(f.lifecycle.release) })
        await originalStop(component)
      }
      await f.lifecycle.start()
      const tick = f.lifecycle.tick(); await ready
      const stop = f.lifecycle.stop()
      const duplicateStop = f.lifecycle.stop()
      f.lifecycle.transferHint('completion')
      assert.equal(f.alive.size, 2); assert.ok(f.lifecycle.release)
      assert.equal(cleanupObservations.length, 0)
      finish(); await Promise.all([tick, stop, duplicateStop])
      const expectedActions = action === 'advance-results' ? ['lifecycle-summary', 'advance-results'] : ['lifecycle-summary']
      assert.deepEqual(actions, expectedActions)
      assert.deepEqual(cleanupObservations, ['connector', 'herdr'].map(component => ({ component, attention: failure.reason, heldLease: true })))
      assert.equal(transfer.snapshot().attention, failure.reason)
      assert.equal(f.lifecycle.state.phase, 'stopped')
      assert.equal((await f.store.load()).attention, failure.reason)
      assert.equal(f.alive.size, 0); assert.equal(f.lifecycle.release, null)

      // A fresh consumer has no in-memory attention. The persisted endpoint gate
      // must reject restart before another producer command or owned child starts.
      const next = f.create({ transfer: new TransferLifecycle({ driver: commandDriver }) })
      const starts = f.calls.filter(c => c.startsWith('start:')).length
      await assert.rejects(next.start(), { code: failure.reason })
      assert.equal(f.calls.filter(c => c.startsWith('start:')).length, starts)
      assert.deepEqual(actions, expectedActions)
      // Explicit acknowledgement rechecks the same producer, never re-enqueues.
      await next.start({ acknowledgeAttention: true }); await next.tick(); await next.stop()
      assert.deepEqual(actions, [...expectedActions, 'lifecycle-summary'])
      assert.equal((await f.store.load()).attention, null)
    })
  }
}
