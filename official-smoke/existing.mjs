// Actual official programs referenced outside the host root. Disposable CI only;
// synthetic configuration/relay, no model call, installation or OS trust change.
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import https from 'node:https'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { inspectInstalled, compareProducerTarget } from '../installed.mjs'
import { programPaths } from '../endpoint.mjs'
import { NativeDriver } from '../lifecycle.mjs'

assert.equal(process.platform, 'win32')
const installation = await fs.realpath(process.argv[2]), base = path.resolve(process.argv[3])
await fs.mkdir(base)
const external = path.join(base, 'existing configuration')
const config = { schema: 2, programs: { node: path.join(installation, 'node/node.exe'), herdr: path.join(installation, 'herdr/herdr.exe'), piPackage: path.join(installation, 'node_modules/@earendil-works/pi-coding-agent'), piBin: path.join(installation, 'node_modules/.bin'), gitRoot: path.join(installation, 'git'), connectorPackage: path.join(installation, 'node_modules/@agenvo/herdr') },
  sourceRoot: path.join(external, 'work'), herdrConfigRoot: path.join(external, 'config/herdr'), herdrStateRoot: path.join(external, 'state/herdr'), agenvoConfigDir: path.join(external, 'config/agenvo'), piConfigDir: path.join(external, 'pi'), deviceId: randomUUID(), runtimeId: randomUUID(), instanceId: 'referenced-official', session: 'endpoint-reference-fixture' }
for (const directory of ['sourceRoot', 'herdrConfigRoot', 'herdrStateRoot', 'agenvoConfigDir', 'piConfigDir'].map(k => config[k])) await fs.mkdir(directory, { recursive: true })
const p = programPaths(config), cert = path.join(base, 'relay.pem'), key = path.join(base, 'relay.key'), opensslConfig = path.join(base, 'openssl.cnf')
await fs.writeFile(opensslConfig, '')
let openssl = path.join(p.gitRoot, 'usr/bin/openssl.exe')
try { await fs.access(openssl) } catch { openssl = path.join(p.gitRoot, 'mingw64/bin/openssl.exe') }
const generated = spawnSync(openssl, ['req', '-batch', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { encoding: 'utf8', input: '', timeout: 15000, maxBuffer: 16384, env: { ...process.env, OPENSSL_CONF: opensslConfig } })
assert.equal(generated.status, 0, 'Bounded synthetic relay certificate generation')
const { default: WebSocket } = await import(pathToFileURL(path.join(installation, 'node_modules/ws/index.js')))
const relay = https.createServer({ cert: await fs.readFile(cert), key: await fs.readFile(key) }, (_q, res) => { res.setHeader('Content-Type', 'application/json'); res.end('{"protocol":1,"ownerConfigured":true}') })
const wss = new WebSocket.Server({ noServer: true }), sockets = new Set(), hosts = new Set()
relay.on('upgrade', (req, socket, head) => wss.handleUpgrade(req, socket, head, ws => {
  sockets.add(ws); ws.on('close', () => sockets.delete(ws))
  ws.on('message', raw => {
    if (raw.toString() === 'agenvo:ping') { ws.send('agenvo:pong'); return }
    if (JSON.parse(raw.toString()).type === 'hello') ws.send('{"v":1,"type":"welcome"}')
  })
}))
await new Promise(resolve => relay.listen(0, '127.0.0.1', resolve))
const officialFiles = [path.join(config.herdrConfigRoot, 'config.toml'), path.join(config.agenvoConfigDir, 'config.json'), path.join(config.agenvoConfigDir, 'credentials.json'), path.join(config.piConfigDir, 'auth.json')]
await fs.writeFile(officialFiles[0], '[update]\nversion_check = false\nmanifest_check = false\n')
await fs.writeFile(officialFiles[1], JSON.stringify({ schema: 1, relay: `https://127.0.0.1:${relay.address().port}`, deviceId: config.deviceId, name: 'synthetic-reference', instances: [{ id: config.instanceId, label: 'synthetic-reference', kind: 'herdr', binary: p.herdr, cwd: config.sourceRoot, configRoot: config.herdrConfigRoot }] }))
await fs.writeFile(officialFiles[2], JSON.stringify({ secret: 'synthetic-no-real-credential-'.repeat(4) }))
await fs.writeFile(officialFiles[3], '{}') // No model authorization or request.
const originals = await Promise.all(officialFiles.map(f => fs.readFile(f)))
// Public endpoint configuration points only to the official config/instance.
// Keep the fixture's initial physical path locally to prepare its inputs.
delete config.programs.herdr
const results = [], checked = check => { results.push(check); process.stdout.write(`${JSON.stringify({ existingInstallationCheck: check, state: 'passed' })}\n`) }
async function hostRoot(name) {
  const root = path.join(base, name)
  await fs.mkdir(path.join(root, 'config'), { recursive: true })
  await fs.writeFile(path.join(root, 'config/endpoint.json'), JSON.stringify(config))
  await fs.writeFile(path.join(root, 'config/runtime.json'), JSON.stringify({ schema: 2, mode: 'existing-installations', transfer: 'disabled' }))
  return root
}
function launch(root) {
  const child = spawn(p.node, [fileURLToPath(new URL('../endpoint.mjs', import.meta.url)), 'host', 'run', '--root', root], { env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let buffer = '', bytes = 0, closed = false
  const statuses = [], done = new Promise(resolve => child.once('close', code => { closed = true; resolve(code) }))
  child.stderr.resume()
  child.stdout.on('data', chunk => {
    bytes += chunk.length; buffer += chunk
    if (bytes > 1024 ** 2) { child.stdin.end('{"action":"stop"}\n'); return }
    const lines = buffer.split('\n'); buffer = lines.pop()
    for (const line of lines) statuses.push(JSON.parse(line))
  })
  const until = async predicate => {
    const end = Date.now() + 45000
    while (Date.now() < end) {
      assert.ok(bytes <= 1024 ** 2, 'Fixture output bounded')
      const value = statuses.find(predicate)
      if (value) return value
      assert.equal(closed, false, 'Host closed before required observation')
      await delay(100)
    }
    throw new Error(`Referenced host observation deadline: ${JSON.stringify(statuses.at(-1))}`)
  }
  const item = { child, statuses, until, async stop() {
    if (!closed) child.stdin.end('{"action":"stop"}\n')
    const end = Date.now() + 20000
    while (!closed && Date.now() < end) await delay(50)
    assert.equal(closed, true, 'Fixture host stop/stdio deadline')
    hosts.delete(item); return done
  } }
  hosts.add(item); return item
}
let peer
try {
  const inspected = await inspectInstalled(config)
  assert.equal(inspected.versions.pi, '1.2.0'); assert.equal(inspected.versions.herdr, '0.9.5')
  assert.equal(inspected.herdrSource, 'agenvo_instance')
  const target = { device_id: config.deviceId, instance_id: config.instanceId, session: config.session, work_dir: config.sourceRoot, bash_path: p.git, agent: { execution_mode: 'pi-json-v1', provider: 'synthetic', model: 'synthetic', config_dir: config.piConfigDir } }
  assert.equal(compareProducerTarget(config, target).state, 'configuration_matches')
  checked('actual_official_installation_preflight_and_existing_profile_shape')

  const root = await hostRoot('host-one'), one = launch(root)
  const running = await one.until(s => s.connection === 'online_snapshot' && s.components === 'verified_local')
  assert.equal(running.ready, false); assert.equal(running.agent, 'unavailable_unqualified')
  assert.equal(running.transfer, 'not_included_pending_qualification')
  assert.equal(running.transferAutomaticRecovery, false)
  checked('public_host_starts_referenced_official_components_outside_its_root')

  const second = launch(await hostRoot('host-two'))
  await second.until(s => s.attention === 'endpoint_already_owned')
  assert.equal(await second.stop(), 2)
  assert.equal(one.child.exitCode, null)
  checked('second_host_same_device_rejected_without_stopping_owner')

  // Metadata-only fixture change, no official source or executable byte patch.
  const originalTime = await fs.stat(p.herdr)
  await fs.utimes(p.herdr, originalTime.atime, new Date(originalTime.mtimeMs + 2000))
  await one.until(s => s.attention === 'installation_changed_restart_required')
  assert.equal(one.child.exitCode, null)
  assert.equal(await one.stop(), 2)
  checked('installation_change_suspends_recovery_and_owned_stop_still_drains')
  const again = launch(root)
  await again.until(s => s.connection === 'online_snapshot' && s.components === 'verified_local')
  assert.equal(await again.stop(), 0)
  checked('explicit_restart_redetects_installation_without_new_manifest')

  // Simulate an owner-maintained official instance mapping, not an updater or
  // native scope approval. The unchanged real release is copied only in CI.
  const endpointBytes = await fs.readFile(path.join(root, 'config/endpoint.json'))
  const nextDirectory = path.join(base, 'next official Herdr location'), nextBinary = path.join(nextDirectory, 'herdr.exe')
  await fs.cp(path.dirname(p.herdr), nextDirectory, { recursive: true, errorOnExist: true, force: false })
  assert.deepEqual(await fs.readFile(officialFiles[1]), originals[1])
  const mapping = JSON.parse(originals[1]); mapping.instances[0].binary = nextBinary
  originals[1] = Buffer.from(JSON.stringify(mapping)); await fs.writeFile(officialFiles[1], originals[1])
  const followed = launch(root)
  await followed.until(s => s.connection === 'online_snapshot' && s.components === 'verified_local')
  const marker = path.join(config.herdrConfigRoot, 'sessions', config.session, 'herdr.sock'), generation = await fs.readFile(marker, 'utf8')
  assert.match(generation, /^\d+:\d+$/)
  const pid = Number(generation.split(':')[0])
  assert.ok(Number.isSafeInteger(pid) && pid > 0)
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const imagePath = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', `[Diagnostics.Process]::GetProcessById(${pid}).MainModule.FileName`], { encoding: 'utf8', timeout: 10000, maxBuffer: 16384 })
  assert.equal(imagePath.status, 0, 'Read owned fixture process image path')
  assert.equal(imagePath.stdout.trim().toLowerCase(), nextBinary.toLowerCase())
  assert.equal(await fs.readFile(marker, 'utf8'), generation)
  assert.deepEqual(await fs.readFile(path.join(root, 'config/endpoint.json')), endpointBytes)
  assert.equal(await followed.stop(), 0)
  checked('fresh_host_uses_official_instance_binary_change_without_endpoint_edit')

  peer = new NativeDriver((await inspectInstalled(config)).config, { inheritedEnvironment: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, qualify: async () => { await inspectInstalled(config); return true } })
  await peer.validate(); await peer.start('herdr'); await peer.waitReady('herdr')
  const outsider = launch(await hostRoot('host-external-peer'))
  await outsider.until(s => s.attention === 'existing_herdr_requires_handoff')
  assert.equal(await outsider.stop(), 2)
  assert.equal(peer.alive('herdr'), true)
  assert.equal((await peer.ownedHostRequest('ping')).type, 'pong')
  checked('existing_external_server_refused_and_original_peer_preserved')

  // The diagnostic process has no lifecycle ownership over this server.
  // Only this fixture owns it. One ordinary shell side effect detects replay;
  // no real Agent session or model is fabricated by this scenario.
  await fs.writeFile(path.join(config.sourceRoot, 'read-only-marker.cjs'), "require('node:fs').appendFileSync('diagnostic-executions.txt','once\\n')\n")
  const created = JSON.parse(peer.command(peer.herdr, ['--session', config.session, 'workspace', 'create', '--cwd', config.sourceRoot]))
  const paneId = created.result.root_pane.pane_id
  peer.command(peer.herdr, ['--session', config.session, 'pane', 'run', paneId, 'node read-only-marker.cjs'])
  const savedSession = path.join(config.herdrConfigRoot, 'sessions', config.session, 'session.json')
  let persisted = false
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    try {
      const state = JSON.parse(await fs.readFile(savedSession, 'utf8'))
      if (state.workspaces.some(w => w.id === created.result.workspace.workspace_id) && await fs.readFile(path.join(config.sourceRoot, 'diagnostic-executions.txt'), 'utf8') === 'once\n') { persisted = true; break }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    await delay(100)
  }
  assert.equal(persisted, true, 'Official historical workspace must be saved before diagnostic')
  const beforeQuery = await fs.readFile(peer.marker, 'utf8')
  const diagnostic = spawnSync(p.node, [fileURLToPath(new URL('../endpoint.mjs', import.meta.url)), 'doctor', '--config', path.join(root, 'config/endpoint.json')], { encoding: 'utf8', timeout: 60000, maxBuffer: 65536 })
  assert.equal(diagnostic.status, 2, 'Doctor must retain ready:false')
  const report = JSON.parse(diagnostic.stdout)
  assert.equal(report.history.state, 'history_present'); assert.equal(report.history.workspaceCount, 1)
  assert.equal(report.sessionObservation.state, 'observed_unowned'); assert.equal(report.sessionObservation.stopAuthority, false)
  assert.equal(report.sessionObservation.workspaceCount, 1); assert.equal(report.sessionObservation.paneCount, 1)
  assert.equal(peer.alive('herdr'), true); assert.equal(await fs.readFile(peer.marker, 'utf8'), beforeQuery)
  assert.equal((await peer.ownedHostRequest('ping')).type, 'pong')
  const afterQuery = JSON.parse(peer.command(peer.herdr, ['--session', config.session, 'api', 'snapshot'])).result.snapshot
  assert.ok(afterQuery.panes.some(pane => pane.pane_id === paneId))
  assert.equal(await fs.readFile(path.join(config.sourceRoot, 'diagnostic-executions.txt'), 'utf8'), 'once\n')
  checked('read_only_doctor_observes_existing_history_without_ownership_or_shell_replay')
  await peer.stop('herdr'); peer = null

  const snapshot = path.join(config.herdrConfigRoot, 'sessions', config.session, 'session.json')
  await fs.mkdir(path.dirname(snapshot), { recursive: true })
  const historical = JSON.stringify({ version: 3, workspaces: [{ id: 'synthetic-existing-user-pane' }] })
  await fs.writeFile(snapshot, historical)
  const history = launch(await hostRoot('host-history'))
  await history.until(s => s.attention === 'existing_herdr_session_requires_handoff')
  assert.equal(await history.stop(), 2)
  assert.equal(await fs.readFile(snapshot, 'utf8'), historical)
  checked('synthetic_historical_state_refused_without_import_or_replay')
  for (let i = 0; i < officialFiles.length; i++) assert.deepEqual(await fs.readFile(officialFiles[i]), originals[i])
  checked('original_configuration_and_credential_bytes_preserved')
  process.stdout.write(`${JSON.stringify({ existingInstallationChecks: results.length, realPcInstallation: false, realAgentTask: false, automaticUpdate: false, nativeScopeApproval: false, trustedTransferTLS: false })}\n`)
} finally {
  const cleanup = await Promise.allSettled([...hosts].map(h => h.stop()))
  await peer?.stop('herdr')
  for (const socket of sockets) socket.terminate()
  wss.close(); relay.closeAllConnections()
  await Promise.race([new Promise(resolve => relay.close(resolve)), delay(5000).then(() => { throw new Error('Fixture network cleanup deadline') })])
  assert.ok(cleanup.every(r => r.status === 'fulfilled'), 'Fixture host cleanup must complete')
  assert.equal(hosts.size, 0)
  process.stdout.write('{"existingInstallationCleanup":"hosts_closed"}\n')
}
