// Actual official Runtime CLI + Herdr, controlled by the public endpoint host.
// Synthetic loopback control peer only; no TLS/file-transfer/model acceptance.
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { catalog, managedEnvironment, programPaths, transferEnvironment, transferLocations } from '../endpoint.mjs'
import { inspectInstalled, inspectInstalledTransfer } from '../installed.mjs'
import { createRuntimePeer } from './native-runtime-peer.mjs'
import { isFreshPiShellPrompt } from './pi-workload-diagnostics.mjs'

assert.equal(process.platform, 'win32', 'native runtime fixture requires Windows')
assert.ok(process.argv.length === 5 || process.argv.length === 6, 'official bundle, runtime package, fresh root, optional candidate')
const bundle = await fs.realpath(process.argv[2]), runtimePackage = await fs.realpath(process.argv[3])
await fs.mkdir(process.argv[4])
const root = await fs.realpath(process.argv[4]), candidate = process.argv[5] ? await fs.realpath(process.argv[5]) : null
const node = path.join(bundle, 'node/node.exe'), hostRoot = path.join(root, 'host'), external = path.join(root, 'official configuration')
const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
const endpoint = path.join(candidate || path.dirname(fileURLToPath(new URL('../endpoint.mjs', import.meta.url))), 'endpoint.mjs')
const key = `mrk_${'c'.repeat(64)}`, teamId = randomUUID()
const { default: WebSocket } = await import(pathToFileURL(path.join(bundle, 'node_modules/ws/index.js')))
const peer = await createRuntimePeer({ WebSocket, key, teamId, version: catalog.nativeRuntime.version, workspaceBase: await fs.realpath(os.homedir()) })
const config = {
  schema: 3,
  programs: { node, herdr: path.join(bundle, 'herdr/herdr.exe'), piPackage: path.join(bundle, 'node_modules/@earendil-works/pi-coding-agent'),
    piBin: path.join(bundle, 'node_modules/.bin'), gitRoot: path.join(bundle, 'git'), connectorPackage: runtimePackage },
  connector: { kind: 'memoh-runtime', enrollmentFile: path.join(external, 'runtime/runtime.json') },
  sourceRoot: path.join(external, 'work'), herdrConfigRoot: path.join(external, 'config/herdr'), herdrStateRoot: path.join(external, 'state/herdr'),
  piConfigDir: path.join(external, 'pi'), deviceId: randomUUID(), runtimeId: randomUUID(), instanceId: 'native-runtime-fixture', session: 'native-runtime-fixture',
  transfer: { pluginRoot: path.join(candidate || bundle, 'transfer'), nasOrigin: 'https://127.0.0.1:1/api' },
}
const transfer = transferLocations(config), credential = 'synthetic-native-runtime-empty-queue'
const original = new Map([
  [config.connector.enrollmentFile, JSON.stringify({ schemaVersion: 1, serverUrl: peer.origin, key, teamId, insecureLocalhost: true })],
  [path.join(config.herdrConfigRoot, 'config.toml'), '[update]\nversion_check = false\nmanifest_check = false\n'],
  [path.join(config.herdrConfigRoot, 'plugins.json'), JSON.stringify([{ plugin_id: 'memoh.delivery', enabled: true, version: catalog.components.transfer.version, plugin_root: transfer.root, manifest_path: path.join(transfer.root, 'herdr-plugin.toml') }])],
  [path.join(transfer.config, 'transfer.json'), JSON.stringify({ version: 1, origin: transfer.origin, source_root: config.sourceRoot })],
  [path.join(transfer.config, 'device.credential'), credential],
  [path.join(config.piConfigDir, 'auth.json'), '{}'],
  [path.join(config.sourceRoot, 'native-runtime-workload.cjs'), "const fs=require('node:fs'); fs.appendFileSync('invocations.txt','once\\n'); let n=0; const write=()=>fs.writeFileSync('progress.txt',String(++n)); write(); setInterval(write,200);\n"],
])
const hostConfig = path.join(hostRoot, 'config/endpoint.json'), activation = path.join(hostRoot, 'config/runtime.json')
original.set(hostConfig, JSON.stringify(config)); original.set(activation, JSON.stringify({ schema: 2, mode: 'existing-installations', transfer: 'existing-queue' }))
const directories = new Set()
for (const file of original.keys()) {
  let directory = path.dirname(file)
  while (directory !== root) { directories.add(directory); directory = path.dirname(directory) }
}
for (let directory = transfer.state; directory !== root; directory = path.dirname(directory)) directories.add(directory)
const input = path.join(root, 'private-native-runtime-fixture.json')
await fs.writeFile(input, JSON.stringify({ root, items: [...[...directories].sort((a, b) => a.length - b.length).map(p => ({ kind: 'directory', path: p })), ...[...original].map(([p, content]) => ({ kind: 'file', path: p, content }))] }))
const made = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./private-fixture.ps1', import.meta.url)), '-InputFile', input], { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 })
assert.equal(made.status, 0, 'fresh private native Runtime fixture must be created without changing existing ACLs')
// The temporary input is not a product auth file. Remove its synthetic key copy;
// preserve all actual enrolled/configuration bytes until fixture verification.
await fs.rm(input)
const env = managedEnvironment(config), marker = path.join(config.herdrConfigRoot, 'sessions', config.session, 'herdr.sock')
const hosts = new Set(), checks = []
const checked = name => { checks.push(name); process.stdout.write(JSON.stringify({ nativeRuntimeCheck: name, state: 'passed' }) + '\n') }
async function stage(name, action) {
  const started = Date.now()
  process.stdout.write(JSON.stringify({ nativeRuntimeStage: name, state: 'started' }) + '\n')
  try {
    const result = await action()
    process.stdout.write(JSON.stringify({ nativeRuntimeStage: name, state: 'passed', elapsedMs: Date.now() - started }) + '\n')
    return result
  } catch (error) {
    const code = typeof error.code === 'string' && /^[A-Za-z0-9_]{1,80}$/.test(error.code) ? error.code : 'fixture_stage_failed'
    let input = 'not_identified'
    // Never print raw messages, command output, credentials or arbitrary paths.
    // A missing captured package member may be reported only beneath one of
    // these explicitly supplied disposable fixture/code roots.
    if (typeof error.path === 'string') for (const [label, base] of [['fixture', root], ['runtime-package', runtimePackage], ['candidate', candidate], ['official-bundle', bundle]]) {
      if (!base) continue
      const relative = path.relative(base, error.path)
      if (relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) { input = `${label}/${relative.split(path.sep).join('/')}`; break }
    }
    process.stdout.write(JSON.stringify({ nativeRuntimeStage: name, state: 'failed', elapsedMs: Date.now() - started, code, input }) + '\n')
    throw new Error(`native Runtime fixture ${name}: ${code}`)
  }
}
async function bounded(promise, ms, reason) {
  let timer
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(reason)), ms) })]) }
  finally { clearTimeout(timer) }
}
async function eventually(predicate, message, ms = 30000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) { if (await predicate()) return; await delay(100) }
  throw new Error(message)
}
function launch() {
  const child = spawn(node, [endpoint, 'host', 'run', '--root', hostRoot], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let buffer = '', bytes = 0, closed = false, stopSent = false, invalidOutput = false, secretLeaked = false
  const states = [], done = new Promise(resolve => child.once('close', code => { closed = true; resolve(code) }))
  const inspect = chunk => { bytes += chunk.length; if ([key, credential].some(secret => chunk.toString().includes(secret))) secretLeaked = true }
  child.stderr.on('data', inspect)
  child.stdout.on('data', chunk => {
    inspect(chunk); buffer += chunk
    const lines = buffer.split('\n'); buffer = lines.pop()
    for (const line of lines) { try { states.push(JSON.parse(line)) } catch { invalidOutput = true } }
  })
  child.stdin.on('error', () => {})
  const item = { child, states,
    async until(predicate, ms = 120000) {
      await eventually(() => {
        assert.ok(bytes <= 1024 ** 2 && !invalidOutput && !secretLeaked, 'host output must remain bounded structured and secret-free')
        assert.equal(peer.counts.invalid, 0, 'real Runtime handshake must match the fixed fixture protocol/configuration')
        const found = states.at(-1)
        if (found && predicate(found)) return true
        assert.equal(closed, false, 'host ended before required native Runtime observation')
        if (found?.attention && !predicate(found)) throw new Error(`native Runtime host attention: ${found.attention}`)
        return false
      }, 'native Runtime host observation deadline', ms)
      return states.at(-1)
    },
    async stop() {
      if (!closed && !stopSent) { stopSent = true; child.stdin.end('{"action":"stop"}\n') }
      const code = await bounded(done, 25000, 'native Runtime host stop/stdio close deadline')
      hosts.delete(item)
      assert.ok(!secretLeaked && !invalidOutput, 'host final output must remain structured and secret-free')
      return code
    },
  }
  hosts.add(item); return item
}
async function herdrOutput(args) {
  const result = await promisify(execFile)(config.programs.herdr, ['--session', config.session, ...args], { env, cwd: config.sourceRoot, encoding: 'utf8', timeout: 10000, maxBuffer: 65536, windowsHide: true })
  return result.stdout
}
async function herdr(args) { return JSON.parse(await herdrOutput(args)) }
async function transferCLI(action) {
  assert.ok(['probe', 'lifecycle-summary'].includes(action), 'empty-queue fixture never admits or advances a delivery')
  const result = await promisify(execFile)(path.join(transfer.root, 'transferqueue.exe'), ['-action', action], {
    env: transferEnvironment(config), cwd: config.sourceRoot, encoding: 'utf8', timeout: 30000, maxBuffer: 16384, windowsHide: true,
  })
  return JSON.parse(result.stdout)
}
const emptyQueue = { schema: 'memoh.delivery.lifecycle.v1', state: 'idle', next_due_at: null, error_class: 'none' }
const idleConsumer = { state: 'idle', attention: null, active: false }
async function ping(generation) {
  assert.match(generation, /^\d+:\d+$/)
  const result = await promisify(execFile)(powershell, ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('../owned-herdr.ps1', import.meta.url)),
    '-MarkerPath', marker, '-Generation', generation, '-OwnerProcessId', generation.split(':')[0], '-Action', 'ping'], { env, encoding: 'utf8', timeout: 20000, maxBuffer: 16384, windowsHide: true })
  assert.equal(JSON.parse(result.stdout).result.type, 'pong')
}
async function progress() { try { return Number(await fs.readFile(path.join(config.sourceRoot, 'progress.txt'), 'utf8')) } catch (error) { if (error.code === 'ENOENT') return 0; throw error } }
try {
  await stage('required_inputs', async () => {
    const p = programPaths(config)
    for (const file of [...original.keys(), p.node, p.herdr, p.pi, p.connector, p.git, path.join(p.gitRoot, 'cmd/git.exe'),
      path.join(p.piBin, 'pi'), path.join(p.piBin, 'pi.cmd'), path.join(config.programs.piPackage, 'package.json'), path.join(runtimePackage, 'package.json')]) assert.ok((await fs.stat(file)).isFile())
    for (const directory of [config.sourceRoot, config.herdrConfigRoot, config.herdrStateRoot, config.piConfigDir, transfer.config, transfer.state]) assert.ok((await fs.stat(directory)).isDirectory())
  })
  const installation = await stage('official_installation_preflight', () => inspectInstalled(config))
  process.stdout.write(JSON.stringify({ nativeRuntimePreflightVersions: installation.versions }) + '\n')
  // Summary deliberately opens existing storage only. The native probe creates
  // this fresh empty queue; neither action admits work or sends a NAS request.
  assert.equal((await stage('transfer_inventory_preflight', () => inspectInstalledTransfer(config))).source, catalog.components.transfer.revision)
  await stage('empty_queue_initialize', async () => {
    assert.deepEqual(await transferCLI('probe'), { storage: 'available', device_configuration: 'required', profile: 'native-profile-v1' })
    assert.deepEqual(await transferCLI('lifecycle-summary'), emptyQueue)
  })
  const host = launch()
  const online = await host.until(s => s.components === 'verified_local' && s.connection === 'online_snapshot' && s.transfer?.state === 'idle' && !s.transfer.active)
  assert.equal(online.ready, false); assert.equal(online.agent, 'unavailable_unqualified'); assert.equal(online.transferAutomaticRecovery, false)
  assert.deepEqual(online.transfer, idleConsumer)
  assert.equal(peer.counts.invalid, 0); assert.ok(peer.counts.connections >= 1)
  checked('public_host_runs_official_native_runtime_and_existing_herdr_without_standalone_daemon')
  checked('same_host_finite_consumer_observes_candidate_transfer_exe_empty_queue_without_nas_work')
  const generation = await fs.readFile(marker, 'utf8'); await ping(generation)
  const created = await herdr(['workspace', 'create', '--cwd', config.sourceRoot]), paneId = created.result.root_pane.pane_id
  // pane.run acknowledges queued input, not shell readiness. Observe this fresh
  // fixture's empty prompt before the only workload submission; never retry it.
  await eventually(async () => isFreshPiShellPrompt(await herdrOutput(['pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', '5']), config.sourceRoot), 'fresh native Runtime fixture shell was not ready')
  await herdr(['pane', 'run', paneId, 'node native-runtime-workload.cjs'])
  await eventually(async () => await progress() >= 2, 'ordinary Herdr workload did not start')
  const before = await progress(), connections = peer.counts.connections, cutover = Date.now()
  peer.disconnect()
  const reconnected = await host.until(s => peer.counts.connections > connections && s.updatedAt > cutover && s.connection === 'online_snapshot' && s.transfer?.state === 'idle' && !s.transfer.active)
  assert.deepEqual(reconnected.transfer, idleConsumer)
  assert.equal(host.states.at(-1).runId, online.runId)
  assert.equal(host.states.at(-1).componentLifecycle.restartsInWindow, 0, 'official reconnect must not spawn another component watchdog')
  assert.equal(await fs.readFile(marker, 'utf8'), generation); await ping(generation)
  await eventually(async () => await progress() > before, 'independent Herdr workload stopped on Runtime disconnect')
  assert.equal(await fs.readFile(path.join(config.sourceRoot, 'invocations.txt'), 'utf8'), 'once\n')
  const snapshot = await herdr(['api', 'snapshot'])
  assert.ok(snapshot.result.snapshot.panes.some(pane => pane.pane_id === paneId))
  checked('runtime_reconnect_preserves_original_herdr_pipe_peer_pane_and_single_running_workload')
  peer.rejectAuthorization(); peer.disconnect()
  const refused = await host.until(s => s.attention === 'connector_authentication_required')
  assert.equal(refused.connection, 'authorization_required'); assert.equal(refused.ready, false)
  assert.deepEqual(refused.transfer, idleConsumer)
  assert.ok(peer.counts.rejected > 0)
  assert.equal(await fs.readFile(marker, 'utf8'), generation); await ping(generation)
  const refusedProgress = await progress()
  await eventually(async () => await progress() > refusedProgress, 'Herdr workload was stopped by connector authorization failure')
  assert.equal(await host.stop(), 2)
  checked('native_runtime_401_is_authorization_required_and_owned_host_stops_gracefully')
  const attempts = peer.counts.attempts, restarted = launch()
  await restarted.until(s => s.phase === 'running' && s.attention === 'connector_authentication_required')
  assert.equal(peer.counts.attempts, attempts)
  assert.equal(await restarted.stop(), 2)
  assert.equal(await fs.readFile(path.join(config.sourceRoot, 'invocations.txt'), 'utf8'), 'once\n')
  assert.deepEqual(await transferCLI('lifecycle-summary'), emptyQueue)
  checked('persisted_attention_restart_does_not_reconnect_or_replay_herdr_work')
  for (const [file, content] of original) assert.equal(await fs.readFile(file, 'utf8'), content)
  assert.equal(peer.counts.invalid, 0)
  checked('official_configuration_enrollment_and_original_workload_bytes_are_preserved')
  process.stdout.write(JSON.stringify({ nativeRuntimeChecks: checks.length, source: catalog.nativeRuntime.revision, connectorVersion: catalog.nativeRuntime.version,
    controlTransport: 'official_explicit_loopback_test_mode', originalWorkloadInvocations: 1, peerRPCDispatch: 'none', modelRequests: 0,
    transferProducer: catalog.components.transfer.revision, transferVersion: catalog.components.transfer.version, transferObservation: 'actual_exe_empty_queue_idle', deliveryAdmissionsSubmitted: 0,
    serverIdentity: 'synthetic_peer_not_memoh_owner', stopAuthority: false, taskRecovery: 'not_exercised', fileTransferTLS: 'not_exercised', realPCandNAS: 'not_run' }) + '\n')
} finally {
  const cleanup = await Promise.allSettled([...hosts].map(host => host.stop()))
  await bounded(peer.close(), 5000, 'native Runtime fixture peer close deadline')
  process.stdout.write(JSON.stringify({ nativeRuntimeFixtureCleanup: 'observed', remainingHosts: hosts.size, stopFailures: cleanup.filter(r => r.status === 'rejected').length }) + '\n')
  assert.equal(cleanup.filter(r => r.status === 'rejected').length, 0)
  assert.equal(hosts.size, 0)
}
