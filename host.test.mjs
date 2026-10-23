import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fork, spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { setTimeout as sleep } from 'node:timers/promises'
import { deploymentReferences } from './deployment.mjs'
import { acquireLeases, leaseKeys } from './lifecycle.mjs'
import { readHostStatus } from './host.mjs'
import { deploymentFixture, syntheticBundle } from './test-support/deployment-fixture.mjs'

const endpoint = fileURLToPath(new URL('./endpoint.mjs', import.meta.url))
const worker = fileURLToPath(new URL('./test-support/host-runtime.mjs', import.meta.url))
async function fixture(t, configured = false) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'endpoint host 空格 ')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  // Windows device leases are machine-wide across test-file processes. Each
  // independent fixture gets an identity; restarts reuse this saved config.
  const config = deploymentReferences(root, { manifestSha256: 'a'.repeat(64), nasOrigin: 'https://nas.example.test', deviceId: randomUUID(), runtimeId: '22222222-2222-4222-8222-222222222222', instanceId: 'synthetic-instance', session: 'default' })
  const configFile = path.join(root, 'config/endpoint.json')
  if (configured) { await fs.mkdir(path.dirname(configFile)); await fs.writeFile(configFile, JSON.stringify(config)) }
  return { root, config, configFile, stateDirectory: path.join(root, 'data/endpoint'), statusFile: path.join(root, 'data/endpoint/host-status.json') }
}
function launch(t, f, scenario = null) {
  const options = { stdio: ['pipe', 'pipe', 'pipe', ...(scenario === null ? [] : ['ipc'])], execArgv: [] }
  const child = scenario === null ? spawn(process.execPath, [endpoint, 'host', 'run', '--root', f.root], options) : fork(worker, [f.root, scenario], options)
  const statuses = [], events = []
  let stdout = '', stderr = '', buffer = '', exited = false
  child.stdout.on('data', chunk => {
    stdout += chunk; buffer += chunk
    const lines = buffer.split('\n'); buffer = lines.pop()
    for (const line of lines) { try { statuses.push(JSON.parse(line)) } catch { /* Assert valid protocol below. */ } }
  })
  child.stderr.on('data', chunk => { stderr += chunk })
  child.on('message', message => { if (message.fixture) events.push(message.fixture) })
  const done = new Promise(resolve => child.once('exit', (code, signal) => { exited = true; resolve({ code, signal }) }))
  t.after(async () => { if (!exited) { child.kill('SIGKILL'); await done } })
  const waitFor = async predicate => {
    const end = Date.now() + 10000
    while (Date.now() < end) {
      const found = predicate()
      if (found) return found
      if (exited) throw new Error(`fixture host exited: ${stderr.slice(0, 80)}`)
      await sleep(20)
    }
    throw new Error('fixture host observation timed out')
  }
  return { child, statuses, events, done, waitFor, command: action => child.stdin.write(`${JSON.stringify({ action })}\n`),
    fixture: action => child.send({ fixture: action }), stdout: () => stdout, stderr: () => stderr }
}
const running = p => p.waitFor(() => p.statuses.find(s => s.phase === 'running'))
const attention = (p, code) => p.waitFor(() => p.statuses.find(s => s.attention === code))
async function stop(p) { p.command('stop'); return p.done }
async function syntheticRunning(p) {
  const s = await running(p)
  // Host liveness alone is not evidence that the fixture acquired its leases.
  assert.equal(s.attention, null, 'synthetic component startup attention')
  assert.equal(s.components, 'synthetic_fixture')
  assert.equal(s.componentLifecycle?.phase, 'running')
  return s
}

test('public foreground entry stays observable with missing config, enforces one host, and stops cleanly', async t => {
  const f = await fixture(t)
  const p = launch(t, f)
  const s = await running(p)
  assert.equal(s.configuration, 'missing'); assert.equal(s.attention, 'host_configuration_missing')
  assert.equal(s.ready, false); assert.equal(s.components, 'unavailable_unqualified')
  assert.equal(s.evidence, 'host_process_only')
  assert.equal(s.control, 'stdin_open')
  const second = launch(t, f)
  assert.equal((await second.done).code, 2)
  assert.ok(second.statuses.some(x => x.attention === 'endpoint_already_owned'))
  assert.equal((await readHostStatus(f.root)).runId, s.runId)
  p.command('status'); await p.waitFor(() => p.statuses.filter(x => x.runId === s.runId).length >= 3)
  assert.equal((await stop(p)).code, 0)
  assert.equal((await readHostStatus(f.root)).phase, 'stopped')
  const legacy = JSON.parse(await fs.readFile(f.statusFile, 'utf8'))
  delete legacy.control
  await fs.writeFile(f.statusFile, JSON.stringify(legacy))
  assert.equal((await readHostStatus(f.root)).control, 'unverified')
  const next = launch(t, f); assert.notEqual((await running(next)).runId, s.runId); await stop(next)
})

test('loaded config and absent bundle/authorization remain unavailable, with bounded local diagnostics', async t => {
  const f = await fixture(t, true)
  await fs.mkdir(f.config.agenvoConfigDir)
  const credential = path.join(f.config.agenvoConfigDir, 'credentials.json')
  await fs.writeFile(credential, 'SYNTHETIC-CREDENTIAL-MUST-NOT-BE-READ')
  await fs.writeFile(path.join(f.config.agenvoConfigDir, 'status.json'), JSON.stringify({ deviceId: f.config.deviceId, updatedAt: Date.now(), state: 'offline', lastError: 'handshake_401', private: 'NEVER-ECHO-STATUS-PAYLOAD' }))
  const p = launch(t, f)
  const s = await running(p)
  assert.equal(s.configuration, 'loaded'); assert.equal(s.components, 'unavailable_missing')
  assert.equal(s.connection, 'authorization_required'); assert.equal(s.ready, false)
  const report = spawnSync(process.execPath, [endpoint, 'host', 'status', '--root', f.root], { encoding: 'utf8' })
  assert.equal(report.status, 0)
  assert.equal(JSON.parse(report.stdout).observation, 'cached')
  await stop(p)
  const files = await fs.readdir(path.join(f.root, 'logs/endpoint-host'))
  const log = await fs.readFile(path.join(f.root, 'logs/endpoint-host', files[0]), 'utf8')
  assert.ok(Buffer.byteLength(log) <= 65536)
  assert.equal((p.stdout() + p.stderr() + log).includes('SYNTHETIC-CREDENTIAL'), false)
  assert.equal((p.stdout() + p.stderr() + log).includes('NEVER-ECHO'), false)
  assert.equal((p.stdout() + p.stderr() + log).includes(f.root), false)
  assert.equal(await fs.readFile(credential, 'utf8'), 'SYNTHETIC-CREDENTIAL-MUST-NOT-BE-READ')
})

test('a complete inert bundle inventory never activates unqualified public components', async t => {
  const f = await fixture(t, true)
  const bundle = await syntheticBundle(path.join(f.root, 'packages/candidate'), 'host-public-gate')
  const config = deploymentReferences(f.root, { ...f.config, manifestSha256: bundle.hash })
  await fs.rename(bundle.directory, config.bundleRoot)
  await fs.writeFile(f.configFile, JSON.stringify(config))
  const p = launch(t, f)
  const s = await running(p)
  assert.equal(s.configuration, 'loaded'); assert.equal(s.components, 'unavailable_unqualified')
  assert.equal(s.componentLifecycle, null); assert.equal(s.transfer, 'not_included_pending_qualification')
  assert.equal(s.evidence, 'host_process_only'); assert.equal(s.ready, false)
  await stop(p)
  await assert.rejects(fs.lstat(path.join(f.stateDirectory, 'lifecycle.json')), { code: 'ENOENT' })
})

test('a linked authorization directory is rejected without observing foreign status', async t => {
  const f = await fixture(t, true)
  const foreign = path.join(f.root, 'foreign')
  await fs.mkdir(foreign)
  await fs.writeFile(path.join(foreign, 'status.json'), 'PRIVATE-FOREIGN-STATUS')
  await fs.symlink(foreign, f.config.agenvoConfigDir, process.platform === 'win32' ? 'junction' : 'dir')
  const p = launch(t, f)
  const s = await running(p)
  assert.ok(s.attention); assert.equal(s.connection, 'unverified'); assert.equal(s.componentLifecycle, null)
  assert.equal((await stop(p)).code, 2)
  assert.equal(p.stdout().includes('PRIVATE-FOREIGN'), false)
  assert.equal(await fs.readFile(path.join(foreign, 'status.json'), 'utf8'), 'PRIVATE-FOREIGN-STATUS')
})

test('invalid configuration and changed configuration never start or reload components', async t => {
  const f = await fixture(t, true)
  await fs.writeFile(f.configFile, '{"private":"PRIVATE-CONFIG-TEXT"}')
  const bad = launch(t, f)
  assert.equal((await running(bad)).attention, 'host_configuration_invalid')
  assert.equal((await stop(bad)).code, 2)
  assert.equal(bad.stdout().includes('PRIVATE-CONFIG'), false)
  await fs.writeFile(f.configFile, JSON.stringify(f.config))
  const p = launch(t, f)
  await running(p)
  await fs.writeFile(f.configFile, JSON.stringify({ ...f.config, session: 'changed' }))
  await attention(p, 'host_configuration_changed')
  assert.equal(p.statuses.at(-1).configuration, 'changed_restart_required')
  assert.equal(p.statuses.at(-1).components, 'unavailable_missing')
  assert.equal((await stop(p)).code, 2)
})

test('stdin accepts only local status/stop, rejects arbitrary commands and oversized input without echo', async t => {
  for (const input of ['{"action":"execute","command":"PRIVATE-ARBITRARY"}\n', 'PRIVATE-OVERSIZED'.repeat(100)]) {
    const f = await fixture(t)
    const p = launch(t, f); await running(p)
    p.child.stdin.write(input)
    assert.equal((await p.done).code, 2)
    assert.ok(p.statuses.some(s => s.attention === 'host_control_input_invalid'))
    assert.equal(p.stdout().includes('PRIVATE-'), false)
  }
})

for (const [name, input] of [
  ['invalid', '{"action":"execute","command":"PRIVATE-EARLY"}\n'],
  ['oversized', 'PRIVATE-EARLY'.repeat(100)],
  ['invalid after clean stop request', '{"action":"stop"}\n{"action":"execute"}\n'],
]) test(`startup ${name} input remains a failure after missing-config observation`, async t => {
  const f = await fixture(t)
  const p = launch(t, f, 'early-input')
  await p.waitFor(() => p.events.find(e => e.event === 'config_waiting'))
  p.child.stdin.write(input)
  await p.waitFor(() => p.statuses.find(s => s.phase === 'stopping'))
  p.fixture('release_config')
  assert.equal((await p.done).code, 2)
  const s = await readHostStatus(f.root)
  assert.equal(s.configuration, 'missing')
  assert.equal(s.attention, 'host_control_input_invalid')
  assert.equal(p.stdout().includes('PRIVATE-EARLY'), false)
  assert.equal(p.events.some(e => e.event === 'component_started' || e.event === 'transfer_action'), false)
})

test('inherited input closure drains host instead of leaving an orphan foreground process', async t => {
  const f = await fixture(t)
  const p = launch(t, f); await running(p)
  p.child.stdin.end()
  assert.equal((await p.done).code, 0)
  assert.equal((await readHostStatus(f.root)).phase, 'stopped')
})

test('unknown or linked status files are preserved instead of overwritten or exposed', async t => {
  const f = await fixture(t)
  const p = launch(t, f); await running(p)
  const foreign = '{"schema":99,"private":"PRIVATE-STATUS-TEXT"}'
  await fs.writeFile(f.statusFile, foreign)
  assert.equal((await p.done).code, 2)
  assert.equal(await fs.readFile(f.statusFile, 'utf8'), foreign)
  assert.equal(p.stdout().includes('PRIVATE-STATUS'), false)
  await assert.rejects(readHostStatus(f.root), /host_status_invalid/)
  await fs.unlink(f.statusFile)
  const original = path.join(f.root, 'original.txt'); await fs.writeFile(original, 'KEEP')
  await fs.link(original, f.statusFile)
  const linked = launch(t, f)
  assert.equal((await linked.done).code, 2)
  assert.equal(await fs.readFile(original, 'utf8'), 'KEEP')
})

test('actual host drives synthetic child startup, bounded connector recovery and owned shutdown', async t => {
  const f = await fixture(t, true)
  const p = launch(t, f, 'normal')
  const s = await syntheticRunning(p)
  assert.equal(s.evidence, 'synthetic_components'); assert.equal(s.ready, false)
  assert.equal(p.events.filter(e => e.event === 'component_started').length, 2)
  p.fixture('crash_connector')
  await p.waitFor(() => p.statuses.find(s => s.componentLifecycle?.restartsInWindow === 1))
  assert.equal(p.events.filter(e => e.event === 'component_started' && e.component === 'connector').length, 2)
  assert.equal(p.events.filter(e => e.event === 'component_started' && e.component === 'herdr').length, 1)
  assert.equal((await stop(p)).code, 0)
  assert.equal((await readHostStatus(f.root)).componentLifecycle.phase, 'stopped')
})

test('synthetic authorization refusal is attention, not machine offline or a restart trigger', async t => {
  const f = await fixture(t, true)
  const p = launch(t, f, 'normal'); await syntheticRunning(p)
  p.fixture('authentication_failure')
  const s = await attention(p, 'connector_authentication_required')
  assert.equal(s.connection, 'authorization_required')
  assert.equal(s.componentLifecycle.restartsInWindow, 0)
  assert.equal(p.events.filter(e => e.event === 'component_started').length, 2)
  assert.equal((await stop(p)).code, 2)
})

test('device lease scope rejects a Windows owner in another root without stealing it', async t => {
  const f = await fixture(t, true)
  // Unique to this intentional collision test; it must not collide with other
  // suites while demonstrating the production Windows device-wide lease.
  f.config.deviceId = randomUUID()
  await fs.writeFile(f.configFile, JSON.stringify(f.config))
  const holderDirectory = path.join(f.root, 'independent-owner')
  await fs.mkdir(holderDirectory)
  const key = `device:${f.config.deviceId}`
  let release = await acquireLeases([key], holderDirectory)
  try {
    const p = launch(t, f, 'normal')
    const s = await running(p)
    if (process.platform === 'win32') {
      assert.equal(s.attention, 'endpoint_already_owned')
      assert.equal(s.componentLifecycle.phase, 'stopped')
      assert.equal(p.events.some(e => e.event === 'component_started'), false)
      assert.equal((await stop(p)).code, 2)
      t.diagnostic('Windows: same device in distinct roots is rejected before component start')
    } else {
      await syntheticRunning(p)
      assert.equal((await stop(p)).code, 0)
      t.diagnostic('Unix development sockets: distinct directories have distinct lease namespaces')
    }
    await assert.rejects(acquireLeases([key], holderDirectory), /endpoint_already_owned/)
    await release(); release = null
    const next = launch(t, f, 'normal')
    await syntheticRunning(next)
    assert.equal((await stop(next)).code, 0)
  } finally { if (release) await release() }
})

test('independent host and deployment fixtures own distinct device leases concurrently', async t => {
  const first = await fixture(t, true), second = await fixture(t, true)
  const deployment = await deploymentFixture(t)
  assert.equal(new Set([first.config.deviceId, second.config.deviceId, deployment.config.deviceId]).size, 3)
  const keys = leaseKeys(deployment.config)
  const release = await acquireLeases(keys, deployment.lifecycleDirectory)
  try {
    const a = launch(t, first, 'normal'), b = launch(t, second, 'normal')
    await Promise.all([syntheticRunning(a), syntheticRunning(b)])
    assert.equal(a.events.filter(e => e.event === 'component_started').length, 2)
    assert.equal(b.events.filter(e => e.event === 'component_started').length, 2)
    const results = await Promise.all([stop(a), stop(b)])
    assert.deepEqual(results.map(r => r.code), [0, 0])
    await assert.rejects(acquireLeases(keys, deployment.lifecycleDirectory), /endpoint_already_owned/)
  } finally { await release() }
})

test('stop during synthetic component startup prevents the next component from launching', async t => {
  const f = await fixture(t, true)
  const p = launch(t, f, 'startup-drain')
  await p.waitFor(() => p.events.find(e => e.event === 'ready_waiting'))
  p.command('stop')
  await p.waitFor(() => p.statuses.find(s => s.phase === 'stopping'))
  p.fixture('release_ready')
  assert.equal((await p.done).code, 0)
  assert.equal(p.events.some(e => e.event === 'component_started' && e.component === 'connector'), false)
})

test('host stop drains a failed finite result, persists attention and blocks fresh-process replay', async t => {
  const f = await fixture(t, true)
  const p = launch(t, f, 'drain-failure'); await running(p)
  await p.waitFor(() => p.events.find(e => e.event === 'advance_waiting'))
  p.command('stop')
  await p.waitFor(() => p.statuses.find(s => s.phase === 'stopping'))
  p.fixture('release_advance')
  assert.equal((await p.done).code, 2)
  const s = await readHostStatus(f.root)
  assert.equal(s.attention, 'transfer_command_outcome_unknown')
  const journal = JSON.parse(await fs.readFile(path.join(f.stateDirectory, 'lifecycle.json'), 'utf8'))
  assert.equal(journal.attention, 'transfer_command_outcome_unknown')
  const next = launch(t, f, 'normal')
  assert.equal((await running(next)).attention, 'transfer_command_outcome_unknown')
  assert.equal(next.events.filter(e => e.event === 'component_started' || e.event === 'transfer_action').length, 0)
  await stop(next)
})

test('unknown synthetic transfer outcome never dispatches advance or a replacement task', async t => {
  const f = await fixture(t, true)
  const p = launch(t, f, 'unknown-transfer'); await running(p)
  await attention(p, 'transfer_unknown')
  assert.deepEqual(p.events.filter(e => e.event === 'transfer_action').map(e => e.action), ['lifecycle-summary'])
  assert.equal((await stop(p)).code, 2)
})

test('failed owned cleanup keeps host observable and lease held until explicit stop retry', async t => {
  const f = await fixture(t, true)
  const p = launch(t, f, 'stop-failure'); await running(p)
  p.command('stop')
  await p.waitFor(() => p.statuses.find(s => s.phase === 'stop_failed'))
  const second = launch(t, f)
  assert.equal((await second.done).code, 2)
  p.fixture('allow_stop'); p.command('stop')
  assert.equal((await p.done).code, 2)
  assert.equal((await readHostStatus(f.root)).phase, 'stopped')
})

test('EOF with failed cleanup reports a closed control stream and retains ownership without replay', async t => {
  const f = await fixture(t, true)
  const p = launch(t, f, 'stop-failure'); await running(p)
  p.child.stdin.end()
  const s = await p.waitFor(() => p.statuses.find(s => s.phase === 'stop_failed'))
  // Allowing the synthetic driver to stop must not itself retry cleanup after EOF.
  p.fixture('allow_stop')
  await sleep(350)
  const second = launch(t, f)
  assert.equal((await second.done).code, 2)
  assert.ok(second.statuses.some(s => s.attention === 'endpoint_already_owned'))
  const journal = JSON.parse(await fs.readFile(path.join(f.stateDirectory, 'lifecycle.json'), 'utf8'))
  assert.equal(journal.attention, 'connector_stop_unknown')
  assert.equal(p.events.filter(e => e.event === 'component_started').length, 2)
  assert.equal(p.events.some(e => e.event === 'component_stopped' && e.component === 'connector'), false)
  assert.equal(s.control, 'stdin_closed')
  assert.equal((await readHostStatus(f.root)).control, 'stdin_closed')
  // Test teardown forcibly terminates only its own fixture. Product code keeps
  // the lease and journal; this is not a demonstrated graceful EOF recovery.
  assert.equal(p.child.kill('SIGKILL'), true)
  await p.done
})

test('observation failure during failed cleanup preserves control and never abandons ownership', async t => {
  const f = await fixture(t, true)
  const p = launch(t, f, 'stop-failure'); await running(p)
  const foreign = '{"schema":99,"private":"PRESERVE-FOREIGN"}'
  await fs.writeFile(f.statusFile, foreign)
  await p.waitFor(() => p.statuses.find(s => s.phase === 'stop_failed'))
  const second = launch(t, f)
  assert.equal((await second.done).code, 2)
  assert.ok(second.statuses.some(s => s.attention === 'endpoint_already_owned'))
  p.command('status')
  await p.waitFor(() => p.statuses.filter(s => s.phase === 'stop_failed').length >= 2)
  p.fixture('allow_stop'); p.command('stop')
  assert.equal((await p.done).code, 2)
  assert.equal(await fs.readFile(f.statusFile, 'utf8'), foreign)
  assert.equal(p.stdout().includes('PRESERVE-FOREIGN'), false)
})

test('abrupt host death produces stale observation and no automatic restart of uncertain runtime', async t => {
  const f = await fixture(t, true)
  const p = launch(t, f, 'normal'); await running(p)
  assert.equal(p.child.kill('SIGKILL'), true); await p.done
  // Inert fixture children exit on parent IPC disconnect. This does not establish
  // cleanup or absence of surviving real Herdr/Agenvo processes after host death.
  await sleep(5100)
  const s = await readHostStatus(f.root)
  assert.equal(s.observation, 'stale_unknown'); assert.equal(s.ready, false)
  if (process.platform !== 'win32') {
    // Only known socket files of this observed-dead synthetic fixture are
    // removed. Product code never steals Unix socket ownership after a crash.
    for (const key of [`host:${f.root}`, ...leaseKeys(f.config)]) {
      const id = createHash('sha256').update(key.toLowerCase()).digest('hex').slice(0, 32)
      const file = path.join(f.stateDirectory, `${id}.sock`)
      assert.equal((await fs.lstat(file)).isSocket(), true); await fs.unlink(file)
    }
  }
  const next = launch(t, f, 'normal')
  assert.equal((await running(next)).attention, 'host_previous_runtime_uncertain')
  assert.equal(next.events.filter(e => e.event === 'component_started' || e.event === 'transfer_action').length, 0)
  await stop(next)
})
