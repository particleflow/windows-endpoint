import test from 'node:test'
import assert from 'node:assert/strict'
import { TransferError, TransferLifecycle, NativeTransferDriver, transferCommand } from './transfer-lifecycle.mjs'
import { transferEnvironment } from './endpoint.mjs'

// Mock command boundary only. No Go queue, TLS, NTFS or actual CLI is exercised.
const start = Date.parse('2026-10-22T18:00:00Z')
const decision = (state, extras = {}) => ({ schema: 'memoh.delivery.lifecycle.v1', state, next_due_at: null, error_class: 'none', ...extras })
const output = (action, value, status = 0) => ({ status, stdout: JSON.stringify(action === 'advance-results' ?
  { ...value, delivery_id: 'original-delivery', phase: 'uploading', offset: 3, admitted: true, associated: false } : value) })
function fixture(respond) {
  let now = start
  const calls = []
  const driver = { invoke: async (action, mayInvoke) => { assert.ok(mayInvoke()); calls.push(action); return respond(action, calls.length) } }
  const transfer = new TransferLifecycle({ driver, clock: () => now })
  transfer.start()
  return { transfer, calls, time: ms => { now = start + ms } }
}

test('due hints coalesce to one finite advance and immediate ticks cannot spin', async () => {
  const { transfer, calls, time } = fixture(action => output(action, decision('due')))
  transfer.hint('completion'); transfer.hint('network')
  await Promise.all([transfer.tick(), transfer.tick(), transfer.tick()])
  assert.deepEqual(calls, ['lifecycle-summary', 'advance-results'])
  await transfer.tick()
  assert.equal(calls.length, 2)
  time(1000); await transfer.tick()
  assert.equal(calls.filter(x => x === 'advance-results').length, 2)
  assert.ok(calls.every(x => ['lifecycle-summary', 'advance-results'].includes(x)))
})

for (const status of [0, 1]) {
  test(`waiting from advance exit ${status} honors its durable deadline then reads summary again`, async () => {
    const due = '2026-10-22T18:00:05.123456789Z'
    const { transfer, calls, time } = fixture(action => output(action, action === 'lifecycle-summary' ? decision('due') : decision('waiting', { next_due_at: due, error_class: 'transient' }), status))
    // Summary must succeed; only finite advance may return a persisted retry on exit 1.
    const invoke = transfer.driver.invoke
    transfer.driver.invoke = async (...args) => { const result = await invoke(...args); if (args[0] === 'lifecycle-summary') result.status = 0; return result }
    await transfer.tick()
    time(5123); await transfer.tick(); assert.equal(calls.length, 2)
    assert.equal(transfer.snapshot().decision.next_due_at, due)
    // Requery at the rounded-up deadline. A new due result, not a locally
    // manufactured state transition, authorizes the second advance.
    transfer.driver.invoke = async action => { calls.push(action); return output(action, decision(action === 'lifecycle-summary' ? 'due' : 'idle')) }
    time(5124); await transfer.tick()
    assert.deepEqual(calls.slice(2), ['lifecycle-summary', 'advance-results'])
  })
}

test('idle polls only the existing queue and never asserts business completion', async () => {
  const { transfer, calls, time } = fixture(action => output(action, decision('idle')))
  await transfer.tick(); time(29999); await transfer.tick()
  assert.deepEqual(calls, ['lifecycle-summary'])
  assert.equal(transfer.snapshot().businessCompletion, 'not_inferred')
  time(30000); await transfer.tick()
  assert.deepEqual(calls, ['lifecycle-summary', 'lifecycle-summary'])
})

test('capacity waits survive hints and restart; only a fresh due summary permits another finite advance', async () => {
  const due = '2026-10-22T18:05:00.000000001Z'
  const waiting = decision('waiting', { error_class: 'capacity', next_due_at: due })
  const { transfer, calls, time } = fixture(action => output(action, calls.length === 1 ? decision('due') : waiting))
  await transfer.tick()
  assert.equal(transfer.snapshot().state, 'waiting'); assert.equal(transfer.snapshot().attention, null)
  for (let i = 1; i <= 20; i++) { time(i * 1000); transfer.hint('network'); await transfer.tick() }
  assert.deepEqual(calls, ['lifecycle-summary', 'advance-results'])
  await transfer.stop(); transfer.start(); await transfer.tick()
  assert.deepEqual(calls, ['lifecycle-summary', 'advance-results', 'lifecycle-summary'])
  time(300000); transfer.hint('completion'); await transfer.tick(); assert.equal(calls.length, 3)
  transfer.driver.invoke = async action => { calls.push(action); return output(action, decision(action === 'lifecycle-summary' ? 'due' : 'idle')) }
  time(300001); await transfer.tick()
  assert.deepEqual(calls.slice(3), ['lifecycle-summary', 'advance-results'])
  assert.equal(transfer.snapshot().businessCompletion, 'not_inferred')
})

for (const action of ['lifecycle-summary', 'advance-results']) for (const status of [0, 1]) {
  test(`stop drains ${action} capacity wait exit ${status}; restart observes the original deadline`, async () => {
    let finish, entered
    const ready = new Promise(resolve => { entered = resolve })
    const waiting = decision('waiting', { error_class: 'capacity', next_due_at: '2026-10-22T18:05:00Z' })
    const { transfer, calls, time } = fixture(current => current === action ? new Promise(resolve => { finish = () => resolve(output(current, waiting, status)); entered() }) : output(current, decision('due')))
    const tick = transfer.tick(); await ready
    const stop = transfer.stop(); finish(); await Promise.all([tick, stop])
    assert.equal(transfer.snapshot().attention, null)
    assert.deepEqual(transfer.snapshot().decision, waiting)
    const before = calls.length
    transfer.driver.invoke = async current => { calls.push(current); return output(current, waiting) }
    transfer.start(); await transfer.tick(); time(299999); await transfer.tick()
    assert.deepEqual(calls.slice(before), ['lifecycle-summary'])
  })
}

test('registered upload remains producer work across stop/restart without local delivery inference or resubmission', async () => {
  const { transfer, calls, time } = fixture(action => action === 'lifecycle-summary' ? output(action, decision('due')) : {
    status: 0, stdout: JSON.stringify({ ...decision('due'), delivery_id: 'original-delivery', phase: 'queued', offset: 0, registered: true, admitted: false, associated: false, feedback_status: 'recorded' }),
  })
  await transfer.tick()
  assert.equal(transfer.snapshot().state, 'due')
  assert.equal(transfer.snapshot().attention, null)
  assert.equal(transfer.snapshot().businessCompletion, 'not_inferred')
  await transfer.tick(); assert.equal(calls.length, 2)
  await transfer.stop(); transfer.start(); time(1000); await transfer.tick()
  assert.deepEqual(calls, ['lifecycle-summary', 'advance-results', 'lifecycle-summary', 'advance-results'])
  assert.equal(transfer.snapshot().state, 'due')
  assert.equal(transfer.snapshot().businessCompletion, 'not_inferred')
})

test('reported corruption trap: due plus nonzero advance suspends all automatic work', async () => {
  const { transfer, calls, time } = fixture(action => output(action, decision('due'), action === 'advance-results' ? 1 : 0))
  await transfer.tick()
  for (let i = 1; i <= 100; i++) { time(i * 30000); transfer.hint('network'); await transfer.tick() }
  assert.equal(transfer.snapshot().attention, 'transfer_command_outcome_unknown')
  assert.deepEqual(calls, ['lifecycle-summary', 'advance-results'])
})

for (const error_class of ['busy', 'transient']) {
  test(`${error_class} with no persisted deadline gets one read-only hint retry after 30 seconds`, async () => {
    const { transfer, calls, time } = fixture(action => output(action, decision('unknown', { error_class }), 1))
    await transfer.tick(); time(29999); await transfer.tick(); assert.equal(calls.length, 1)
    time(30000); await transfer.tick()
    assert.equal(transfer.snapshot().attention, `transfer_${error_class}`)
    time(60000); await transfer.tick()
    assert.deepEqual(calls, ['lifecycle-summary', 'lifecycle-summary'])
  })
}

test('authentication/permission/configuration/capacity and unknown never create or replay work', async () => {
  for (const error_class of ['authentication', 'permission', 'configuration', 'capacity', 'unknown']) {
    const { transfer, calls } = fixture(action => output(action, decision('unknown', { error_class }), 1))
    await transfer.tick(); transfer.hint('completion'); await transfer.tick()
    assert.equal(transfer.snapshot().attention, `transfer_${error_class}`)
    assert.deepEqual(calls, ['lifecycle-summary'])
  }
})

test('event storms cannot shorten the documented 30 second host retry floor', async () => {
  const { transfer, calls, time } = fixture(action => output(action, decision('unknown', { error_class: 'busy' }), 1))
  await transfer.tick()
  for (let i = 1; i < 30; i++) { time(i * 1000); transfer.hint('completion'); await transfer.tick() }
  assert.deepEqual(calls, ['lifecycle-summary'])
  time(30000); await transfer.tick()
  assert.deepEqual(calls, ['lifecycle-summary', 'lifecycle-summary'])
  // Coalesced external events can authorize one further delayed read, not a
  // fresh retry on every timer tick.
  time(60000); await transfer.tick(); time(90000); await transfer.tick()
  assert.equal(calls.length, 3)
  assert.equal(transfer.snapshot().attention, 'transfer_busy')
})

test('unsupported, malformed, truncated, timeout and signal output fail closed without raw diagnostics', async () => {
  for (const result of [
    { status: 2, stdout: JSON.stringify(decision('due')) },
    { status: 0, stdout: '{"state":"idle"}' },
    { status: 0, stdout: '{' },
    { status: 0, stdout: 'private-fixture'.repeat(2000) },
    { status: 0, stdout: JSON.stringify(decision('due')), timedOut: true },
    { status: null, stdout: JSON.stringify(decision('due')), signal: 'SIGTERM' },
  ]) {
    const { transfer, calls, time } = fixture(() => result)
    await transfer.tick(); time(60000); await transfer.tick()
    assert.ok(transfer.snapshot().attention)
    assert.equal(JSON.stringify(transfer.snapshot()).includes('private-fixture'), false)
    assert.deepEqual(calls, ['lifecycle-summary'])
  }
})

test('stop during summary prevents advance; restart reads producer state anew', async () => {
  let finish, entered
  const ready = new Promise(r => { entered = r })
  const { transfer, calls } = fixture(action => new Promise(r => { finish = () => r(output(action, decision('due'))); entered() }))
  const tick = transfer.tick(); await ready
  let stopped = false
  const stop = transfer.stop().then(() => { stopped = true })
  await Promise.resolve(); assert.equal(stopped, false)
  finish(); await Promise.all([tick, stop])
  assert.deepEqual(calls, ['lifecycle-summary'])
  transfer.driver.invoke = async action => { calls.push(action); return output(action, decision('idle')) }
  transfer.start(); await transfer.tick(); await transfer.stop()
  assert.deepEqual(calls, ['lifecycle-summary', 'lifecycle-summary'])
})

test('stop drains a finite advance once without launching a replacement', async () => {
  let finish, entered
  const ready = new Promise(r => { entered = r })
  const { transfer, calls } = fixture(action => action === 'lifecycle-summary' ? output(action, decision('due')) : new Promise(r => { finish = () => r(output(action, decision('due'))); entered() }))
  const tick = transfer.tick(); await ready
  const stop = transfer.stop(); transfer.hint('completion'); finish()
  await Promise.all([tick, stop, transfer.tick()])
  assert.deepEqual(calls, ['lifecycle-summary', 'advance-results'])
  assert.equal(transfer.snapshot().state, 'stopped')
})

test('stop during preflight cancels before invocation without inventing a failed command', async () => {
  let finish, entered, invoked = false
  const ready = new Promise(r => { entered = r })
  const transfer = new TransferLifecycle({ driver: { invoke: async (_action, mayInvoke) => {
    await new Promise(r => { finish = r; entered() })
    if (!mayInvoke()) throw new TransferError('transfer_stopping')
    invoked = true
    return output('lifecycle-summary', decision('due'))
  } } })
  transfer.start()
  const tick = transfer.tick(); await ready
  const stop = transfer.stop(); finish()
  await Promise.all([tick, stop])
  assert.equal(invoked, false)
  assert.equal(transfer.snapshot().attention, null)
  assert.equal(transfer.snapshot().state, 'stopped')
})

test('native command uses only fixed finite actions and official shared roots', async () => {
  const config = { bundleRoot: '/bundle', sourceRoot: '/source', herdrConfigRoot: '/config/herdr', herdrStateRoot: '/state/herdr', agenvoConfigDir: '/agenvo', piConfigDir: '/pi', transferConfigDir: '/config/herdr/plugins/config/memoh.delivery', transferStateDir: '/state/herdr/plugins/memoh.delivery' }
  for (const action of ['enqueue-result', 'collect-result', 'cancel', 'retire']) assert.throws(() => transferCommand(config, action), /transfer_action_rejected/)
  assert.deepEqual(transferCommand(config, 'advance-results').args, ['-action', 'advance-results'])
  const env = transferEnvironment(config, { HERDR_PLUGIN_CONFIG_DIR: 'polluted', HERDR_PLUGIN_STATE_DIR: 'polluted', NODE_OPTIONS: '--require=bad' })
  assert.equal(env.HERDR_PLUGIN_CONFIG_DIR, config.transferConfigDir)
  assert.equal(env.HERDR_PLUGIN_STATE_DIR, config.transferStateDir)
  assert.equal(env.NODE_OPTIONS, undefined)
  // Missing qualifier fails before any executable is spawned or config is read.
  await assert.rejects(new NativeTransferDriver(config).invoke('lifecycle-summary'), /transfer_component_unqualified/)
})
