import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { fork, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { StateStore } from './lifecycle.mjs'
import { handoffPayload } from './handoff.mjs'
import { deploymentReferences } from './deployment.mjs'

const endpoint = fileURLToPath(new URL('./endpoint.mjs', import.meta.url))
const worker = fileURLToPath(new URL('./test-support/handoff-journal.mjs', import.meta.url))
const hash = value => createHash('sha256').update(value).digest('hex')
const noAuthority = value => {
  assert.equal(value.stop_authority, false); assert.equal(value.stop_dispatched_by_ack, false)
  assert.equal(value.business_dispatched_by_ack, false); assert.equal(value.automatic_retry, false)
  assert.equal(value.principal, 'unverified'); assert.equal(value.locator, 'unverified')
}
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'handoff journal 空格 ')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const directory = path.join(root, 'data/endpoint'), identity = randomUUID()
  await fs.mkdir(directory, { recursive: true }); await fs.mkdir(path.join(root, 'config'))
  const config = deploymentReferences(root, { manifestSha256: 'a'.repeat(64), nasOrigin: 'https://nas.example.test', deviceId: identity, runtimeId: randomUUID(), instanceId: 'fixture', session: 'default' })
  await fs.writeFile(path.join(root, 'config/endpoint.json'), JSON.stringify(config))
  const payload = { schema: 1, request_id: randomUUID(),
    host: { run_id: randomUUID(), root_sha256: hash(root), program_sha256: '1'.repeat(64), configuration_sha256: hash(JSON.stringify(config)) },
    native: { device_id: identity, runtime_id: config.runtimeId, instance_id: 'fixture', session: 'default', herdr_pid: 123, herdr_generation: '123:456', connector_pid: 789, connector_nonce: randomUUID() },
    gate: { connection_id: randomUUID(), device_id: identity, instance_id: 'fixture', request_id: randomUUID(), revision: '9007199254740993123', paused: true, scope: 'owner_connection_instance' },
    operations: [0, 1].map(() => ({ operation_id: randomUUID(), revision: '9007199254740993124', reconciliation_sha256: '2'.repeat(64) })) }
  const store = new StateStore(directory, identity), state = await store.load()
  state.sessionContinuation = { schema: 1, binding: 'a'.repeat(64), configuration: 'b'.repeat(64), snapshot: 'c'.repeat(64), ordinary: true }
  await store.save(state)
  const file = path.join(root, 'fixture.json')
  await fs.writeFile(file, JSON.stringify({ directory, identity, payload }))
  return { root, directory, identity, config, store, state, payload, file }
}
function child(t, f, action, killpoint = '') {
  const process = fork(worker, [f.file, action, killpoint], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], execArgv: [] })
  let stderr = ''
  process.stderr.on('data', c => { stderr += c })
  const message = new Promise((resolve, reject) => {
    process.once('message', resolve); process.once('error', reject)
    process.once('exit', code => { if (code) reject(new Error(stderr || 'fixture exited')) })
  })
  const done = new Promise(resolve => process.once('exit', (code, signal) => resolve({ code, signal })))
  t.after(async () => { if (process.exitCode === null && process.signalCode === null) process.kill('SIGKILL'); await done })
  return { process, message, done }
}

test('same UUID and canonical payload survive process restart; queries and duplicates do not write', async t => {
  const f = await fixture(t), first = child(t, f, 'record')
  const a = (await first.message).result; assert.equal((await first.done).code, 0); noAuthority(a)
  const raw = await fs.readFile(f.store.file)
  const second = child(t, f, 'record'), b = (await second.message).result
  assert.equal((await second.done).code, 0); assert.notEqual(first.process.pid, second.process.pid)
  assert.deepEqual(b, a); assert.deepEqual(await fs.readFile(f.store.file), raw)
  const reordered = Object.fromEntries(Object.entries(f.payload).reverse())
  reordered.operations = [...reordered.operations].reverse()
  const checking = new StateStore(f.directory, f.identity, { checkpoint: () => assert.fail('duplicate must not write') })
  assert.deepEqual(await checking.recordHandoff(reordered), a)
  const queried = spawnSync(process.execPath, [endpoint, 'host', 'handoff-status', '--root', f.root, '--request-id', f.payload.request_id], { encoding: 'utf8', timeout: 10000 })
  assert.equal(queried.status, 0, queried.stderr); assert.deepEqual(JSON.parse(queried.stdout), a)
  assert.deepEqual(await fs.readFile(f.store.file), raw)
  assert.equal((await f.store.load()).schema, 2)
  assert.deepEqual((await f.store.load()).sessionContinuation, f.state.sessionContinuation)
})

test('changed host, ownership, gate or operation revision cannot reuse a durable request', async t => {
  const f = await fixture(t); await f.store.recordHandoff(f.payload)
  const raw = await fs.readFile(f.store.file)
  for (const change of [
    p => { p.host.run_id = randomUUID() }, p => { p.host.root_sha256 = '3'.repeat(64) },
    p => { p.host.program_sha256 = '3'.repeat(64) }, p => { p.host.configuration_sha256 = '3'.repeat(64) },
    p => { p.native.herdr_generation = '123:457' }, p => { p.native.connector_nonce = randomUUID() },
    p => { p.gate.revision = '9007199254740993124' }, p => { p.gate.connection_id = randomUUID() },
    p => { p.operations[0].revision = '9007199254740993125' }, p => { p.operations[0].reconciliation_sha256 = '3'.repeat(64) },
    p => { p.operations.pop() },
  ]) {
    const changed = structuredClone(f.payload); change(changed)
    await assert.rejects(f.store.recordHandoff(changed), { code: 'handoff_content_conflict' })
    assert.deepEqual(await fs.readFile(f.store.file), raw)
  }
  await assert.rejects(f.store.recordHandoff({ ...f.payload, request_id: randomUUID() }), { code: 'handoff_request_pending' })
  noAuthority(await f.store.handoffStatus(randomUUID()))
})

test('strict payload rejects claimed permission, duplicate operations and mismatched native/gate identity', async t => {
  const f = await fixture(t)
  for (const change of [
    p => { p.principal_verified = true }, p => { p.gate.paused = false }, p => { p.gate.device_id = randomUUID() },
    p => { p.operations.push(p.operations[0]) }, p => { p.gate.revision = 9007199254740992 },
    p => { p.operations[0].revision = '01' }, p => { p.native.herdr_generation = '999:456' },
  ]) { const changed = structuredClone(f.payload); change(changed); assert.throws(() => handoffPayload(changed), { code: 'handoff_payload_invalid' }) }
  assert.equal((await f.store.load()).schema, 1)
})

test('unknown outcome is durable and never regresses on duplicate record or stale ordinary lifecycle save', async t => {
  const f = await fixture(t), a = await f.store.recordHandoff(f.payload)
  const unknown = await f.store.markHandoffUnknown(a.request_id, a.payload_sha256)
  noAuthority(unknown); assert.equal(unknown.state, 'outcome_unknown')
  assert.deepEqual(await f.store.recordHandoff(f.payload), unknown)
  await f.store.save({ ...f.state, phase: 'running' }) // Snapshot predates ack.
  const loaded = await new StateStore(f.directory, f.identity).load()
  assert.equal(loaded.schema, 2); assert.equal(loaded.phase, 'running'); assert.equal(loaded.handoff.state, 'outcome_unknown')
  await assert.rejects(f.store.markHandoffUnknown(a.request_id, 'f'.repeat(64)), { code: 'handoff_content_conflict' })
  assert.deepEqual(await f.store.handoffStatus(a.request_id), unknown)
})

for (const stage of ['before_write', 'file_synced', 'published']) {
  test(`journal failure at ${stage} requires readback and grants no execution`, async t => {
    const f = await fixture(t), before = await fs.readFile(f.store.file)
    const broken = new StateStore(f.directory, f.identity, { checkpoint: point => { if (point === stage) throw Object.assign(new Error('fixture fault'), { code: 'EIO' }) } })
    await assert.rejects(broken.recordHandoff(f.payload), { code: 'handoff_persistence_unknown' })
    const query = child(t, f, 'query'), result = (await query.message).result
    assert.equal((await query.done).code, 0); noAuthority(result)
    assert.equal(result.state, stage === 'published' ? 'recorded_unverified' : 'not_recorded_unknown')
    if (stage !== 'published') assert.deepEqual(await fs.readFile(f.store.file), before)
    const after = await fs.readFile(f.store.file)
    await f.store.handoffStatus(f.payload.request_id)
    assert.deepEqual(await fs.readFile(f.store.file), after)
  })
}
for (const stage of ['file_synced', 'published']) {
  test(`actual writer termination at ${stage} preserves the existing journal and never adopts staging`, async t => {
    const f = await fixture(t), original = await fs.readFile(f.store.file), writer = child(t, f, 'record', stage)
    assert.equal((await writer.message).checkpoint, stage)
    writer.process.kill('SIGKILL'); await writer.done
    const reader = child(t, f, 'query'), value = (await reader.message).result
    assert.equal((await reader.done).code, 0); noAuthority(value)
    assert.equal(value.state, stage === 'published' ? 'recorded_unverified' : 'not_recorded_unknown')
    if (stage === 'file_synced') {
      assert.deepEqual(await fs.readFile(f.store.file), original)
      assert.ok((await fs.readdir(f.directory)).some(n => n.startsWith('.lifecycle-')))
    }
  })
}

test('permission failure leaves original state; concurrent lifecycle writes preserve ack', async t => {
  const f = await fixture(t), original = await fs.readFile(f.store.file)
  const broken = new StateStore(f.directory, f.identity, { io: { ...fs, rename: async () => { throw Object.assign(new Error('fixture denied'), { code: 'EACCES' }) } } })
  await assert.rejects(broken.recordHandoff(f.payload), { code: 'handoff_persistence_unknown' })
  assert.deepEqual(await fs.readFile(f.store.file), original)
  await Promise.all([f.store.recordHandoff(f.payload), f.store.save({ ...f.state, phase: 'running' })])
  assert.equal((await f.store.load()).handoff.request_id, f.payload.request_id)
  assert.equal((await f.store.load()).phase, 'running')
})

test('journal rejects tampering and oversized revision sets without dropping entries', async t => {
  const f = await fixture(t)
  const oversized = structuredClone(f.payload); oversized.gate.revision = '9'.repeat(262144)
  await assert.rejects(f.store.recordHandoff(oversized), e => e.code === 'handoff_persistence_unknown' && e.cause.code === 'lifecycle_state_too_large')
  assert.equal((await f.store.load()).schema, 1)
  await f.store.recordHandoff(f.payload)
  const changed = await f.store.load(); changed.handoff.payload.host.run_id = randomUUID()
  await fs.writeFile(f.store.file, JSON.stringify(changed))
  await assert.rejects(f.store.handoffStatus(f.payload.request_id), { code: 'lifecycle_handoff_mismatch' })
})

test('real host restart observes unresolved ack without starting/stopping synthetic components or replaying business', async t => {
  const f = await fixture(t); await f.store.recordHandoff(f.payload)
  const original = await fs.readFile(f.store.file)
  const host = fork(fileURLToPath(new URL('./test-support/host-runtime.mjs', import.meta.url)), [f.root, 'handoff-restart'], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], execArgv: [] })
  const events = []; let buffer = '', stderr = ''
  host.on('message', value => events.push(value)); host.stderr.on('data', c => { stderr += c })
  const done = new Promise(resolve => host.once('exit', code => resolve(code)))
  t.after(async () => { if (host.exitCode === null) host.kill('SIGKILL'); await done })
  const observed = await new Promise((resolve, reject) => {
    host.once('error', reject); host.once('exit', () => reject(new Error(stderr || 'host exited')))
    host.stdout.on('data', chunk => {
      buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop()
      for (const line of lines) { const status = JSON.parse(line); if (status.phase === 'running') resolve(status) }
    })
  })
  assert.equal(observed.attention, 'host_handoff_unverified'); assert.equal(observed.componentLifecycle, null)
  assert.notEqual(observed.runId, f.payload.host.run_id); assert.equal(observed.ready, false)
  host.stdin.end('{"action":"stop"}\n'); assert.equal(await done, 2)
  assert.deepEqual(events, []); assert.deepEqual(await fs.readFile(f.store.file), original)
  assert.equal((await f.store.handoffStatus(f.payload.request_id)).binding.host.run_id, f.payload.host.run_id)
})


test('full disk before journal creation preserves the previous acknowledgement and all lifecycle fields', async t => {
  const f = await fixture(t), ack = await f.store.recordHandoff(f.payload), original = await fs.readFile(f.store.file)
  const broken = new StateStore(f.directory, f.identity, { io: { ...fs, open: async () => { throw Object.assign(new Error('fixture full'), { code: 'ENOSPC' }) } } })
  await assert.rejects(broken.markHandoffUnknown(ack.request_id, ack.payload_sha256), { code: 'handoff_persistence_unknown' })
  assert.deepEqual(await fs.readFile(f.store.file), original)
  assert.deepEqual(await f.store.handoffStatus(ack.request_id), ack)
  noAuthority(ack)
})

test('shared synthetic vector fixes canonical payload digest without rounding revision strings', async () => {
  const vector = JSON.parse(await fs.readFile(new URL('./test-support/handoff-v1.json', import.meta.url)))
  assert.equal(vector.contract, 'windows-endpoint.handoff-ack.v1')
  assert.equal(handoffPayload(vector.payload).sha256, vector.sha256)
  assert.equal(handoffPayload(vector.payload).payload.gate.revision, '9007199254740993123')
})


test('existing null or scalar journal is unknown evidence, never an empty first run', async t => {
  const f = await fixture(t)
  for (const raw of ['null', 'false', '0', '""', '[]']) {
    await fs.writeFile(f.store.file, raw)
    await assert.rejects(f.store.load(), { code: 'lifecycle_state_mismatch' })
    await assert.rejects(f.store.recordHandoff(f.payload), { code: 'lifecycle_state_mismatch' })
    await assert.rejects(f.store.save(f.state), { code: 'lifecycle_state_mismatch' })
    assert.equal(await fs.readFile(f.store.file, 'utf8'), raw)
  }
})
