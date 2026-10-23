import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import https from 'node:https'
import { spawn, spawnSync, execFile } from 'node:child_process'
import { createHash, randomUUID, X509Certificate } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { catalog, digest, transferEnvironment } from '../endpoint.mjs'
import { deploymentReferences } from '../deployment.mjs'
import { readHostStatus } from '../host.mjs'
import { transferFixture } from './nas-fixture.mjs'

assert.equal(process.platform, 'win32')
const bundle = await fs.realpath(process.argv[2])
await fs.mkdir(process.argv[3]) // fail if this isolated root already exists
const root = await fs.realpath(process.argv[3])
const config = deploymentReferences(root, { manifestSha256: await digest(path.join(bundle, 'bundle.json')), nasOrigin: 'https://127.0.0.1', deviceId: randomUUID(), runtimeId: randomUUID(), instanceId: 'ci-explicit', session: 'ci-explicit' })
config.bundleRoot = bundle
const node = path.join(bundle, 'node/node.exe'), herdr = path.join(bundle, 'herdr/herdr.exe')
const endpoint = fileURLToPath(new URL('../endpoint.mjs', import.meta.url))
const result = [], children = new Set()
const checked = check => { result.push(check); process.stdout.write(JSON.stringify({ explicitHostCheck: check, state: 'passed' }) + '\n') }
const hash = raw => createHash('sha256').update(raw).digest('hex')
for (const dir of [path.join(root, 'config'), path.join(root, 'data'), config.herdrConfigRoot, config.herdrStateRoot, config.agenvoConfigDir, config.piConfigDir, path.dirname(config.transferConfigDir), path.dirname(config.transferStateDir)]) await fs.mkdir(dir, { recursive: true })
const trusted = process.argv[4] ? await fs.realpath(process.argv[4]) : null
const cert = trusted ? path.join(trusted, 'server.pem') : path.join(root, 'fixture-cert.pem')
const key = trusted ? path.join(trusted, 'server.key') : path.join(root, 'fixture-key.pem')
const ca = trusted ? path.join(trusted, 'root.pem') : cert
if (!trusted) {
  const opensslConfig = path.join(root, 'fixture-openssl.cnf')
  await fs.writeFile(opensslConfig, '')
  let openssl
  for (const name of ['git/usr/bin/openssl.exe', 'git/mingw64/bin/openssl.exe']) { try { await fs.access(path.join(bundle, name)); openssl = path.join(bundle, name); break } catch {} }
  const generated = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8', timeout: 15000, env: { ...process.env, OPENSSL_CONF: opensslConfig } })
  assert.equal(generated.status, 0, 'ephemeral fixture certificate')
}
let rejectAuth = false, welcomes = 0, nasRequests = 0, tlsFailures = 0
let nas
const relay = https.createServer({ cert: await fs.readFile(cert), key: await fs.readFile(key) }, (req, res) => {
  if (req.url.startsWith('/internal/')) {
    nasRequests++
    if (nas) { void nas.handler(req, res); return }
    res.writeHead(500); res.end(); return
  }
  res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ protocol: 1, ownerConfigured: true }))
})
relay.on('tlsClientError', () => { tlsFailures++ })
const { default: WebSocket } = await import(pathToFileURL(path.join(bundle, 'node_modules/ws/index.js')))
const wss = new WebSocket.Server({ noServer: true }), sockets = new Set()
relay.on('upgrade', (req, socket, head) => {
  if (rejectAuth) { socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return }
  wss.handleUpgrade(req, socket, head, ws => {
    sockets.add(ws); ws.on('close', () => sockets.delete(ws))
    ws.on('message', raw => {
      if (raw.toString() === 'agenvo:ping') { ws.send('agenvo:pong'); return }
      if (JSON.parse(raw.toString()).type === 'hello') { welcomes++; ws.send(JSON.stringify({ v: 1, type: 'welcome' })) }
    })
  })
})
await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve))
config.nasOrigin = `https://127.0.0.1:${relay.address().port}`
const plan = { version: 1, task: { operation_id: randomUUID(), bot_id: randomUUID(), user_id: randomUUID(), session_id: randomUUID(), target_id: randomUUID(), run_id: 'synthetic-no-agent', attempt: 'a'.repeat(32), generation: 'b'.repeat(32), root_hash: hash(config.sourceRoot.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()) }, artifact: { source_ref: 'result-one', mime: 'text/plain' } }
const payload = 'fixture', closed = { ...plan, closed: true, sha256: hash(payload), size_bytes: Buffer.byteLength(payload) }
const attempt = path.join(config.sourceRoot, '.memoh-computer/attempts', plan.task.attempt)
const freshItems = [config.transferConfigDir, config.transferStateDir, config.sourceRoot, path.join(config.sourceRoot, '.memoh-computer'), path.join(config.sourceRoot, '.memoh-computer/attempts'), attempt].map(p => ({ kind: 'directory', path: p }))
for (const [file, content] of [
  [path.join(config.transferConfigDir, 'transfer.json'), JSON.stringify({ version: 1, origin: config.nasOrigin, source_root: config.sourceRoot })],
  [path.join(config.transferConfigDir, 'device.credential'), 'synthetic-cli-device'],
  [path.join(config.sourceRoot, 'result-one'), payload],
  [path.join(attempt, 'producer-context.json'), JSON.stringify(plan)],
]) freshItems.push({ kind: 'file', path: file, content })
const fixtureInput = path.join(root, 'fixture-input.json')
await fs.writeFile(fixtureInput, JSON.stringify({ root, items: freshItems }))
const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
const created = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./private-fixture.ps1', import.meta.url)), '-InputFile', fixtureInput], { encoding: 'utf8', timeout: 30000 })
assert.equal(created.status, 0, `fresh private fixture objects: ${created.stderr.slice(0, 200)}`)
const official = new Map([
  [path.join(config.herdrConfigRoot, 'config.toml'), '[update]\nversion_check = false\nmanifest_check = false\n'],
  [path.join(config.agenvoConfigDir, 'config.json'), JSON.stringify({ schema: 1, relay: config.nasOrigin, deviceId: config.deviceId, name: 'isolated-ci-explicit', instances: [{ id: config.instanceId, label: 'fixture', kind: 'herdr', binary: herdr, cwd: config.sourceRoot, configRoot: config.herdrConfigRoot }] })],
  [path.join(config.agenvoConfigDir, 'credentials.json'), JSON.stringify({ secret: 'synthetic-test-only-'.repeat(4) })],
  [path.join(config.herdrConfigRoot, 'plugins.json'), JSON.stringify([{ plugin_id: 'memoh.delivery', enabled: true, version: catalog.components.transfer.version, plugin_root: path.join(bundle, 'transfer'), manifest_path: path.join(bundle, 'transfer/herdr-plugin.toml') }])],
])
for (const [file, content] of official) await fs.writeFile(file, content)
await fs.writeFile(path.join(root, 'config/endpoint.json'), JSON.stringify(config))
await fs.writeFile(path.join(root, 'config/runtime.json'), JSON.stringify({ schema: 1, mode: 'explicit-review', manifestSha256: config.manifestSha256, transfer: 'existing-queue' }))
async function cli(action, input, id, expectedExit = 0) {
  // Keep the loopback server responsive while the real CLI performs TLS/I/O.
  return new Promise((resolve, reject) => {
    const child = execFile(path.join(bundle, catalog.components.transfer.entry), ['-action', action, ...(id ? ['-delivery', id] : [])], { env: transferEnvironment(config), cwd: config.sourceRoot, encoding: 'utf8', timeout: 125000, maxBuffer: 16384, windowsHide: true }, (error, stdout) => {
      try {
        assert.equal(error?.killed ?? false, false, 'CLI timeout is not a TLS rejection')
        assert.equal(error?.code ?? 0, expectedExit, `production CLI ${action}: ${stdout.slice(0, 500)}`)
        resolve(JSON.parse(stdout))
      } catch (failure) { reject(failure) }
    })
    child.stdin.end(input ? JSON.stringify(input) : '')
  })
}
function launch() {
  const child = spawn(node, [endpoint, 'host', 'run', '--root', root], { env: { ...process.env, NODE_EXTRA_CA_CERTS: ca }, stdio: ['pipe', 'pipe', 'pipe'] })
  children.add(child)
  const states = []; let buffer = '', ended = false
  child.stdout.on('data', chunk => { buffer += chunk; const lines = buffer.split('\n'); buffer = lines.pop(); for (const line of lines) states.push(JSON.parse(line)) })
  child.stderr.resume()
  const done = new Promise(resolve => child.once('exit', code => { ended = true; children.delete(child); resolve(code) }))
  const until = async predicate => {
    const end = Date.now() + 120000
    let lastStatus = 0
    while (Date.now() < end) {
      const found = states.find(predicate)
      if (found) return found
      assert.equal(ended, false, 'host exited before observation')
      if (states.at(-1)?.attention) throw new Error(`explicit host attention: ${states.at(-1).attention}`)
      // Startup may spend time hashing a complete inventory. Never flood the
      // bounded stdin channel while synchronous official version probes run.
      if (states.at(-1)?.phase === 'running' && Date.now() - lastStatus > 1000) {
        child.stdin.write('{"action":"status"}\n'); lastStatus = Date.now()
      }
      await delay(200)
    }
    throw new Error(`explicit host observation timeout: ${JSON.stringify(states.at(-1))}`)
  }
  return { child, states, done, until, stop: () => { child.stdin.write('{"action":"stop"}\n'); return done } }
}
try {
  const admitted = await cli('enqueue-result', closed)
  assert.equal(admitted.admitted, true); assert.equal(admitted.feedback_status, 'recorded')
  assert.equal((await cli('lifecycle-summary')).state, 'due')
  const deliveryId = admitted.delivery_id
  checked('production_cli_admits_seven_bytes_and_records_original_attempt_feedback')
  if (trusted) {
    nas = transferFixture(plan, deliveryId, payload)
    const rootCert = new X509Certificate(await fs.readFile(ca))
    const mismatch = await fs.readFile(path.join(trusted, 'mismatch.pem'))
    const wrongCert = new X509Certificate(mismatch), rightCert = new X509Certificate(await fs.readFile(cert))
    for (const leaf of [wrongCert, rightCert]) assert.equal(leaf.verify(rootCert.publicKey), true)
    assert.equal(wrongCert.checkIP('127.0.0.1'), undefined); assert.equal(rightCert.checkIP('127.0.0.1'), '127.0.0.1')
    relay.setSecureContext({ cert: mismatch, key: await fs.readFile(path.join(trusted, 'mismatch.key')) })
    // Producer fail() returns the durable-save result: a recorded network
    // refusal exits 0 with waiting/connection, not exit 1. Never infer success
    // from that exit code; require the persisted failure and zero HTTP requests.
    const refused = await cli('advance-results')
    assert.equal(refused.state, 'waiting'); assert.equal(refused.error_class, 'transient')
    assert.equal(refused.phase, 'queued'); assert.equal(refused.error_code, 'connection')
    assert.equal(refused.feedback_status, 'recorded'); assert.ok(Date.parse(refused.next_due_at) > Date.now())
    assert.equal(refused.associated, false); assert.equal(refused.offset, 0)
    assert.equal(nasRequests, 0); assert.ok(tlsFailures > 0)
    checked('production_cli_rejects_trusted_chain_with_wrong_hostname')
    relay.setSecureContext({ cert: await fs.readFile(cert), key: await fs.readFile(key) })
    const host = launch()
    await host.until(s => nas.stats.commits === 1 && s.connection === 'online_snapshot' && s.transfer?.state === 'waiting' && s.transfer.decision?.next_due_at !== refused.next_due_at)
    assert.equal(await host.stop(), 0)
    const unknown = await cli('inspect', null, deliveryId)
    assert.equal(unknown.associated, false); assert.equal(unknown.association_state, 'unknown')
    assert.equal(unknown.offset, Buffer.byteLength(payload)); assert.deepEqual(unknown.reference, nas.reference)
    assert.deepEqual(nas.snapshot().uploaded, Buffer.from(payload)); assert.equal(nas.snapshot().receipt.id, 'receipt-one')
    assert.equal(nas.snapshot().committed, true); assert.equal(nas.stats.resolves, 0)
    checked('production_cli_uploads_exact_bytes_and_preserves_lost_commit_uncertainty')
    const restarted = launch()
    await restarted.until(s => s.connection === 'online_snapshot' && s.transfer?.state === 'idle')
    assert.equal(await restarted.stop(), 0)
    const recovered = await cli('inspect', null, deliveryId)
    assert.equal(recovered.associated, true); assert.equal(recovered.delivery_id, deliveryId)
    assert.deepEqual(recovered.reference, nas.reference)
    assert.equal(nas.stats.creates, 1); assert.equal(nas.stats.patches, 2); assert.equal(nas.stats.completes, 1)
    assert.equal(nas.stats.commits, 1); assert.equal(nas.stats.resolves, 1); assert.equal(nas.stats.failures, 0)
    checked('fresh_host_resolves_original_commit_and_reads_same_result_reference')
    const counts = { ...nas.stats }, reopened = launch()
    const ready = await reopened.until(s => s.connection === 'online_snapshot' && s.transfer?.state === 'idle')
    assert.equal(ready.ready, false); assert.equal(ready.transferAutomaticRecovery, false)
    assert.equal(await reopened.stop(), 0)
    assert.deepEqual(nas.stats, counts)
    assert.deepEqual((await cli('inspect', null, deliveryId)).reference, nas.reference)
    checked('completed_queue_reopen_does_not_reupload_or_replay_task')
    const feedback = JSON.parse(await fs.readFile(path.join(attempt, 'delivery-feedback.json'), 'utf8'))
    assert.equal(feedback.task.attempt, plan.task.attempt)
    assert.equal(feedback.files.length, 1); assert.equal(feedback.files[0].delivery_id, deliveryId)
    assert.equal(feedback.files[0].state, 'unknown'); assert.equal(feedback.files[0].code, 'awaiting_nas_ledger')
    assert.equal(await fs.readFile(path.join(config.sourceRoot, 'result-one'), 'utf8'), payload)
    for (const [file, content] of official) assert.equal(await fs.readFile(file, 'utf8'), content)
    checked('producer_feedback_remains_advisory_and_original_source_configuration_survive')
    process.stdout.write(JSON.stringify({ explicitHostChecks: result, producer: catalog.components.transfer.revision, ready: false, positiveProductionTLS: 'passed_isolated_fixture', realPCandNAS: 'not_run', modelRequests: 0, fixture: nas.stats }) + '\n')
  } else {
  const host = launch()
  const running = await host.until(s => s.components === 'verified_local' && s.connection === 'online_snapshot' && s.transfer?.state === 'waiting')
  assert.equal(running.evidence, 'native_components'); assert.equal(running.ready, false)
  assert.equal(running.agent, 'unavailable_unqualified'); assert.equal(running.transferAutomaticRecovery, false)
  assert.ok(welcomes > 0); assert.ok(tlsFailures > 0); assert.equal(nasRequests, 0)
  checked('public_host_runs_owned_official_components_and_production_finite_consumer')
  checked('production_cli_rejects_untrusted_tls_without_auth_or_tls_bypass')
  const before = await cli('inspect', null, deliveryId)
  assert.equal(before.associated, false); assert.equal(before.delivery_id, deliveryId)
  assert.equal((await host.stop()), 0)
  assert.equal((await readHostStatus(root)).phase, 'stopped')
  const next = launch()
  await next.until(s => s.connection === 'online_snapshot' && s.transfer?.state === 'waiting')
  const after = await cli('inspect', null, deliveryId)
  assert.equal(after.delivery_id, deliveryId); assert.equal(after.offset, before.offset); assert.equal(after.associated, false)
  assert.equal(await fs.readFile(path.join(config.sourceRoot, 'result-one'), 'utf8'), payload)
  checked('fresh_host_reopens_same_pending_queue_without_recreating_task_or_delivery')
  rejectAuth = true
  for (const socket of sockets) socket.terminate()
  const refused = await next.until(s => s.attention === 'connector_authentication_required')
  assert.equal(refused.connection, 'authorization_required'); assert.equal(refused.ready, false)
  assert.equal(await next.stop(), 2)
  const welcomesBefore = welcomes, blocked = launch()
  await blocked.until(s => s.phase === 'running' && s.attention === 'connector_authentication_required')
  assert.equal(welcomes, welcomesBefore); assert.equal(await blocked.stop(), 2)
  checked('actual_connector_auth_failure_persists_and_restart_does_not_replay')
  for (const [file, content] of official) assert.equal(await fs.readFile(file, 'utf8'), content)
  const feedback = JSON.parse(await fs.readFile(path.join(attempt, 'delivery-feedback.json'), 'utf8'))
  assert.equal(feedback.task.attempt, plan.task.attempt)
  assert.equal(feedback.files.length, 1); assert.equal(feedback.files[0].delivery_id, deliveryId)
  assert.equal(feedback.files[0].state, 'pending')
  checked('existing_config_source_and_pending_producer_feedback_are_preserved')
  process.stdout.write(JSON.stringify({ explicitHostChecks: result, producer: catalog.components.transfer.revision, ready: false, positiveProductionTLS: 'unverified', realPCandNAS: 'not_run', modelRequests: 0 }) + '\n')
  }
} finally {
  for (const child of children) { child.stdin.write('{"action":"stop"}\n') }
  // Do not kill official grandchildren if cleanup is unknown. A failing job
  // retains diagnostics; only the disposable CI runner owns final teardown.
  for (const socket of sockets) socket.terminate()
  wss.close(); relay.close()
}
