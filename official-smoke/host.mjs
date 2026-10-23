import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import https from 'node:https'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { catalog, digest, transferEnvironment } from '../endpoint.mjs'
import { deploymentReferences } from '../deployment.mjs'
import { readHostStatus } from '../host.mjs'

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
const cert = path.join(root, 'fixture-cert.pem'), key = path.join(root, 'fixture-key.pem'), opensslConfig = path.join(root, 'fixture-openssl.cnf')
await fs.writeFile(opensslConfig, '')
let openssl
for (const name of ['git/usr/bin/openssl.exe', 'git/mingw64/bin/openssl.exe']) { try { await fs.access(path.join(bundle, name)); openssl = path.join(bundle, name); break } catch {} }
const generated = spawnSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8', timeout: 15000, env: { ...process.env, OPENSSL_CONF: opensslConfig } })
assert.equal(generated.status, 0, 'ephemeral fixture certificate')
let rejectAuth = false, welcomes = 0, nasRequests = 0, tlsFailures = 0
const relay = https.createServer({ cert: await fs.readFile(cert), key: await fs.readFile(key) }, (req, res) => {
  if (req.url.startsWith('/internal/')) { nasRequests++; res.writeHead(500); res.end(); return }
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
function cli(action, input, id) {
  const call = spawnSync(path.join(bundle, catalog.components.transfer.entry), ['-action', action, ...(id ? ['-delivery', id] : [])], { input: input && JSON.stringify(input), env: transferEnvironment(config), cwd: config.sourceRoot, encoding: 'utf8', timeout: 125000, maxBuffer: 16384, windowsHide: true })
  assert.equal(call.error, undefined, 'production CLI subprocess outcome')
  assert.equal(call.status, 0, `production CLI ${action}: ${call.stdout.slice(0, 500)}`)
  return JSON.parse(call.stdout)
}
function launch() {
  const child = spawn(node, [endpoint, 'host', 'run', '--root', root], { env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, stdio: ['pipe', 'pipe', 'pipe'] })
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
  const admitted = cli('enqueue-result', closed)
  assert.equal(admitted.admitted, true); assert.equal(admitted.feedback_status, 'recorded')
  assert.equal(cli('lifecycle-summary').state, 'due')
  const deliveryId = admitted.delivery_id
  checked('production_cli_admits_seven_bytes_and_records_original_attempt_feedback')
  const host = launch()
  const running = await host.until(s => s.components === 'verified_local' && s.connection === 'online_snapshot' && s.transfer?.state === 'waiting')
  assert.equal(running.evidence, 'native_components'); assert.equal(running.ready, false)
  assert.equal(running.agent, 'unavailable_unqualified'); assert.equal(running.transferAutomaticRecovery, false)
  assert.ok(welcomes > 0); assert.ok(tlsFailures > 0); assert.equal(nasRequests, 0)
  checked('public_host_runs_owned_official_components_and_production_finite_consumer')
  checked('production_cli_rejects_untrusted_tls_without_auth_or_tls_bypass')
  const before = cli('inspect', null, deliveryId)
  assert.equal(before.associated, false); assert.equal(before.delivery_id, deliveryId)
  assert.equal((await host.stop()), 0)
  assert.equal((await readHostStatus(root)).phase, 'stopped')
  const next = launch()
  await next.until(s => s.connection === 'online_snapshot' && s.transfer?.state === 'waiting')
  const after = cli('inspect', null, deliveryId)
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
} finally {
  for (const child of children) { child.stdin.write('{"action":"stop"}\n') }
  // Do not kill official grandchildren if cleanup is unknown. A failing job
  // retains diagnostics; only the disposable CI runner owns final teardown.
  for (const socket of sockets) socket.terminate()
  wss.close(); relay.close()
}
