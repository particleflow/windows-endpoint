import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { EndpointLifecycle, LifecycleError, StateStore, NativeDriver, acquireLeases, connectorAttention, leaseKeys } from './lifecycle.mjs'
import { managedEnvironment } from './endpoint.mjs'
import { TransferLifecycle } from './transfer-lifecycle.mjs'

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
    recoverConnectorLock: async () => { calls.push('recover:lock') },
  }
  const store = new StateStore(directory, 'fixture-device')
  const create = () => new EndpointLifecycle({ driver, store, acquire: () => acquireLeases([directory], directory), clock: () => 1000000, delay: async () => {}, ...options })
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

test('single instance protects shared identity even with another config location', async t => {
  const { lifecycle, create } = await fixture(t)
  await lifecycle.start()
  await assert.rejects(create().start(), /endpoint_already_owned/)
  const keys = leaseKeys({ deviceId: 'device', herdrConfigRoot: 'root', session: 'one', agenvoConfigDir: 'connector' })
  assert.equal(keys[0], 'device:device')
  await lifecycle.stop()
  const next = create(); await next.start(); await next.stop()
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
  assert.equal(env.AGENVO_CONFIG_DIR, '/agenvo')
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
  const config = { bundleRoot: directory, sourceRoot: directory, herdrConfigRoot: directory, herdrStateRoot: directory, agenvoConfigDir: directory, piConfigDir: directory, session: 'default' }
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
