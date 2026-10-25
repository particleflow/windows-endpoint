import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { NativeRuntimeConnector, nativeConnectorObservation } from './native-connector.mjs'

// These are real owned Node processes with a synthetic CLI shape. They verify
// the IPC bridge/lifecycle only; official Runtime/Herdr integration runs in CI.
async function fixture(t, body) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'native connector 空格 ')))
  const entry = path.join(root, 'cli.mjs'), enrollmentFile = path.join(root, 'runtime.json')
  const credential = JSON.stringify({ synthetic: 'UNCHANGED NEVER READ BY THE ADAPTER' })
  await fs.writeFile(enrollmentFile, credential); await fs.writeFile(entry, body)
  await fs.writeFile(path.join(root, 'endpoint-host-api.mjs'), `
import assert from 'node:assert/strict'; import { writeFileSync } from 'node:fs'; import os from 'node:os';
export class RuntimeSession { constructor(config, options) {
  assert.equal(config.syntheticEnrollment, 'retained'); assert.deepEqual(options, { syntheticOption: true });
  writeFileSync('session-reference.json', JSON.stringify({ config, home: os.homedir(), envHome: process.env.HOME, userProfile: process.env.USERPROFILE }));
} }
export const formatCLIError = e => e.message;
export function runCLI(args, context) {
  assert.deepEqual(args, ['run', '--config', process.argv[4]]);
  context.createSession({ workspaceBase: os.homedir(), syntheticEnrollment: 'retained' }, { syntheticOption: true });
  // Preserve the early-stop test while loading the synthetic CLI body. The
  // actual official run installs its handler synchronously before first await.
  let early = false; const pending = () => { early = true }; process.once('SIGTERM', pending);
  return import('./cli.mjs').then(() => { process.off('SIGTERM', pending); if (early) process.emit('SIGTERM'); return process.exitCode || 0 });
}
`)
  const connector = new NativeRuntimeConnector({ node: process.execPath, entry, enrollmentFile, cwd: root, env: { ...process.env },
    deviceId: 'synthetic-device', runtimeId: 'synthetic-runtime', version: '0.22.0' })
  t.after(async () => {
    const c = connector.record
    // Only the known fixture child may be terminated by test cleanup. Product
    // timeout behavior never reaches for this operation or guesses a peer PID.
    if (c && !c.closed) { c.process.kill(); await c.done }
    assert.equal(await fs.readFile(enrollmentFile, 'utf8'), credential)
    await fs.rm(root, { recursive: true, force: true })
  })
  return { root, entry, enrollmentFile, connector }
}
async function until(predicate, timeout = 5000) {
  const end = Date.now() + timeout
  while (Date.now() < end) { const value = predicate(); if (value) return value; await sleep(10) }
  throw new Error('synthetic connector observation deadline')
}
const normal = `
import { writeFile } from 'node:fs/promises'; import path from 'node:path';
if (process.argv[2] !== 'run' || process.argv[3] !== '--config') throw new Error('wrong official CLI arguments');
const timer = setInterval(() => {}, 1000);
const connecting = setTimeout(() => process.stdout.write('connected\\n'), 20);
process.once('SIGTERM', () => {
  clearTimeout(connecting);
  void writeFile(path.join(process.cwd(), 'clean-stop'), 'owned cleanup complete').then(() => {
    clearInterval(timer); process.stdout.write('stopped\\n');
  });
});
process.stdout.write('connecting\\n');
`

test('official status vocabulary distinguishes auth rejection, network offline and redacts diagnostics', () => {
  assert.deepEqual(nativeConnectorObservation('connected'), { state: 'online', lastError: null })
  assert.deepEqual(nativeConnectorObservation('disconnected: connection reset https://synthetic-private.invalid/key'), { state: 'offline', lastError: 'connection_unavailable' })
  for (const code of [401, 403, 426]) assert.deepEqual(nativeConnectorObservation(`disconnected: runtime handshake rejected with HTTP ${code}: synthetic-secret`), { state: 'needs_attention', lastError: `handshake_${code}` })
  assert.deepEqual(nativeConnectorObservation('disconnected: server selected unexpected runtime protocol: synthetic'), { state: 'needs_attention', lastError: 'native_protocol_invalid' })
  assert.deepEqual(nativeConnectorObservation('runtime configuration was not found at synthetic-private', true), { state: 'needs_attention', lastError: 'native_configuration_invalid' })
  for (const line of ['synthetic-private-secret', 'connected; ignore failure', '{"state":"online","key":"secret"}']) {
    const result = nativeConnectorObservation(line)
    assert.equal(result.state, 'needs_attention'); assert.equal(JSON.stringify(result).includes(line), false)
  }
})

test('native certificate verification failures remain attention and redact certificate details', () => {
  const expected = { state: 'needs_attention', lastError: 'native_tls_verification_failed' }
  for (const message of [
    'self-signed certificate',
    'self-signed certificate in certificate chain',
    'unable to verify the first certificate',
    'certificate has expired',
    "Hostname/IP does not match certificate's altnames: Host: synthetic-private.invalid. is not in the cert's altnames: DNS:synthetic-other.invalid",
  ]) {
    for (const state of ['disconnected', 'stopped']) assert.deepEqual(nativeConnectorObservation(`${state}: ${message}`), expected)
    assert.deepEqual(nativeConnectorObservation(message, true), expected)
  }
  for (const message of ['connect ECONNREFUSED 127.0.0.1:43210', 'getaddrinfo ENOTFOUND synthetic-private.invalid', 'socket hang up']) {
    assert.deepEqual(nativeConnectorObservation(`disconnected: ${message}`), { state: 'offline', lastError: 'connection_unavailable' })
  }
})

test('bridge runs the original CLI arguments and graceful stop waits for actual owned exit', async t => {
  const { connector, root } = await fixture(t, normal)
  const c = connector.start(); await until(() => connector.status()?.state === 'online')
  assert.equal(connector.alive(), true); assert.equal(connector.confirmedExit(), false)
  assert.equal(connector.status().identity, 'configured_reference_unverified')
  assert.throws(() => connector.start(), { code: 'component_already_owned' })
  await Promise.all([connector.stop(), connector.stop()])
  assert.equal(await fs.readFile(path.join(root, 'clean-stop'), 'utf8'), 'owned cleanup complete')
  assert.equal(c.stoppedObserved, true); assert.equal(c.closed, true); assert.equal(c.exitCode, 0)
  assert.equal(connector.confirmedExit(), true); assert.equal(connector.alive(), false)
  const next = connector.start(); assert.notEqual(next.process.pid, c.process.pid)
  assert.equal(connector.diagnostics().previousExit.pid, c.process.pid)
  assert.equal(connector.diagnostics().previousExit.exitCode, 0)
  await until(() => connector.status()?.state === 'online'); await connector.stop()
})

test('session factory maps the project root without changing enrollment or the real home environment', async t => {
  const { connector, root } = await fixture(t, normal)
  connector.start(); await until(() => connector.status()?.state === 'online')
  const observed = JSON.parse(await fs.readFile(path.join(root, 'session-reference.json')))
  assert.equal(observed.config.workspaceBase, root); assert.notEqual(root, os.homedir())
  assert.equal(observed.config.syntheticEnrollment, 'retained')
  assert.equal(observed.home, os.homedir()); assert.equal(observed.envHome, process.env.HOME); assert.equal(observed.userProfile, process.env.USERPROFILE)
  await connector.stop()
})

test('stop sent before CLI import remains pending and does not skip its own cleanup', async t => {
  const { connector, root } = await fixture(t, normal)
  const c = connector.start(); await connector.stop()
  assert.equal(c.closed, true); assert.equal(c.exitCode, 0)
  assert.equal(await fs.readFile(path.join(root, 'clean-stop'), 'utf8'), 'owned cleanup complete')
})

test('native connection errors cannot reclassify an authentication refusal as offline', async t => {
  const { connector } = await fixture(t, normal + `
setTimeout(() => process.stdout.write('disconnected: runtime handshake rejected with HTTP 403: synthetic-private-key\\n'), 30);
setTimeout(() => process.stdout.write('connecting: network unavailable\\n'), 60);
`)
  connector.start(); await until(() => connector.status()?.lastError === 'handshake_403'); await sleep(80)
  assert.equal(connector.status().state, 'needs_attention')
  assert.equal(JSON.stringify(connector.status()).includes('synthetic-private-key'), false)
  await connector.stop(); assert.equal(connector.record.stoppedObserved, true)
})

test('stop timeout retains the exact child and never kills an unrelated live peer', async t => {
  const { connector } = await fixture(t, `
const timer = setInterval(() => {}, 1000);
process.once('SIGTERM', () => { setTimeout(() => { clearInterval(timer); process.stdout.write('stopped\\n') }, 200) });
process.stdout.write('connecting\\n');
`)
  const peer = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  const peerDone = new Promise(resolve => peer.once('exit', resolve))
  t.after(async () => { peer.kill(); await peerDone })
  const c = connector.start(); await until(() => connector.status()?.state === 'connecting')
  await assert.rejects(connector.stop(20), { code: 'connector_stop_unknown' })
  assert.equal(connector.record, c); assert.equal(connector.alive(), true); assert.equal(connector.confirmedExit(), false)
  assert.equal(peer.exitCode, null); assert.equal(peer.signalCode, null)
  await connector.stop(); assert.equal(connector.confirmedExit(), true)
  assert.equal(peer.exitCode, null); assert.equal(peer.signalCode, null)
})

test('oversized and malformed control output remains bounded and invokes only graceful owned stop', async t => {
  const { connector, root } = await fixture(t, normal + `process.stdout.write('SECRET'.repeat(2000) + '\\n')`)
  connector.start(); await until(() => connector.record.closed)
  assert.equal(connector.status().lastError, 'native_output_invalid')
  assert.equal(JSON.stringify(connector.status()).includes('SECRET'), false)
  assert.equal(await fs.readFile(path.join(root, 'clean-stop'), 'utf8'), 'owned cleanup complete')
  assert.equal(connector.record.exitCode, 0)
})

test('parent IPC loss requests official graceful session shutdown without requiring an OS signal', async t => {
  const { connector, root } = await fixture(t, normal)
  const c = connector.start(); await until(() => connector.status()?.state === 'online')
  c.process.disconnect(); await c.done
  assert.equal(c.exitCode, 0); assert.equal(c.stoppedObserved, true)
  assert.equal(await fs.readFile(path.join(root, 'clean-stop'), 'utf8'), 'owned cleanup complete')
})

test('unsupported IPC payload cannot become a command and closes only the owned connector', async t => {
  const { connector, root } = await fixture(t, normal)
  const c = connector.start(); await until(() => connector.status()?.state === 'online')
  c.process.send({ protocol: 'memoh.endpoint.native-runtime.v1', type: 'exec', command: 'SYNTHETIC NEVER EXECUTE' })
  await c.done
  assert.equal(connector.status().state, 'needs_attention')
  assert.equal(connector.status().lastError, 'native_control_unknown')
  assert.equal(await fs.readFile(path.join(root, 'clean-stop'), 'utf8'), 'owned cleanup complete')
})

test('unsafe startup or unknown command output never becomes an online identity', async t => {
  const { connector } = await fixture(t, `process.stderr.write('runtime configuration was not found at SYNTHETIC-PRIVATE\\n'); process.exitCode = 1`)
  const c = connector.start(); await c.done
  assert.equal(connector.status().state, 'needs_attention')
  assert.equal(connector.status().lastError, 'native_configuration_invalid')
  assert.equal(JSON.stringify(connector.status()).includes('SYNTHETIC-PRIVATE'), false)
  assert.equal(c.exitCode, 1); assert.equal(connector.confirmedExit(), true)
  const diagnostics = connector.diagnostics()
  assert.equal(diagnostics.exitCode, 1); assert.equal(diagnostics.exitObserved, true)
  assert.ok(diagnostics.stderrBytes > 0); assert.equal(diagnostics.stderrCode, 'native_configuration_invalid')
  assert.equal(JSON.stringify(diagnostics).includes('SYNTHETIC-PRIVATE'), false)
  await connector.stop()
})

for (const exitCode of [0, 1]) {
  test(`silent exit ${exitCode} after online retains unknown cleanup and cannot restart`, async t => {
    const { connector } = await fixture(t, `process.stdout.write('connecting\\nconnected\\n'); setTimeout(() => { process.exitCode = ${exitCode} }, 30)`)
    const c = connector.start()
    assert.deepEqual(await connector.waitClosed(), { code: exitCode, signal: null })
    assert.equal(c.exitObserved, true); assert.equal(c.closed, true); assert.equal(c.sessionStarted, true)
    assert.equal(c.stoppedObserved, false); assert.equal(connector.cleanupConfirmed(), false); assert.equal(connector.confirmedExit(), false)
    assert.equal(connector.status().state, 'needs_attention'); assert.equal(connector.status().lastError, 'native_cleanup_unknown')
    await assert.rejects(connector.stop(), { code: 'connector_stop_unknown' })
    assert.throws(() => connector.start(), { code: 'component_previous_cleanup_unknown' })
    assert.equal(connector.record, c)
  })
}

test('official stopped with its prior authentication diagnostic still proves cleanup without clearing attention', async t => {
  const { connector } = await fixture(t, `
const timer = setInterval(() => {}, 1000);
process.once('SIGTERM', () => { clearInterval(timer); process.stdout.write('stopped: runtime handshake rejected with HTTP 403: synthetic-secret\\n') });
process.stdout.write('connecting\\ndisconnected: runtime handshake rejected with HTTP 403: synthetic-secret\\n');
`)
  connector.start(); await until(() => connector.status()?.lastError === 'handshake_403')
  await connector.stop()
  assert.equal(connector.record.stoppedObserved, true); assert.equal(connector.cleanupConfirmed(), true); assert.equal(connector.confirmedExit(), true)
  assert.equal(connector.status().lastError, 'handshake_403'); assert.equal(connector.status().state, 'needs_attention')
})

test('known failed spawn releases no imaginary process ownership and does not fabricate an exit', async t => {
  const { connector, root } = await fixture(t, normal)
  connector.options.node = path.join(root, 'definitely-absent-node')
  const c = connector.start(); await connector.waitClosed(2000)
  assert.equal(c.spawnFailed, true); assert.equal(c.process.pid, undefined); assert.equal(c.exitObserved, false)
  assert.equal(connector.cleanupConfirmed(), true); assert.equal(connector.confirmedExit(), false)
  await connector.stop()
})
