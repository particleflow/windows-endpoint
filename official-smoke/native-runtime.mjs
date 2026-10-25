// Actual official Runtime CLI + Herdr, controlled by the public endpoint host.
// Synthetic loopback control/model peers; no production TLS, NAS or model grant.
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawn, spawnSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { catalog, managedEnvironment, programPaths, transferEnvironment, transferLocations } from '../endpoint.mjs'
import { inspectInstalled, inspectInstalledTransfer } from '../installed.mjs'
import { createRuntimePeer } from './native-runtime-peer.mjs'
import { isFreshPiShellPrompt, piWorkloadWrapper, piWorkloadEvidence } from './pi-workload-diagnostics.mjs'
import { startPiModelFixture, fixtureProvider, fixtureModel, fixtureFile, fixtureBytes, fixtureOutput } from './pi-model-fixture.mjs'

assert.equal(process.platform, 'win32', 'native runtime fixture requires Windows')
assert.ok(process.argv.length >= 5 && process.argv.length <= 7, 'official bundle, runtime package, fresh root, optional candidate and source file probe')
const bundle = await fs.realpath(process.argv[2]), runtimePackage = await fs.realpath(process.argv[3])
await fs.mkdir(process.argv[4])
const root = await fs.realpath(process.argv[4]), candidate = process.argv[5] ? await fs.realpath(process.argv[5]) : null
const node = path.join(bundle, 'node/node.exe'), hostRoot = path.join(root, 'host'), external = path.join(root, 'official configuration')
// The official enrollment reader validates owners all the way to the volume
// root. RUNNER_TEMP's D: namespace failed that unchanged check in 40185674832.
// Use a fresh child of the CI user's home (the official enrollment namespace),
// without touching .memoh, any existing enrollment, or any ancestor's ACL.
const enrollmentParent = await fs.realpath(os.homedir())
const enrollmentRoot = path.join(enrollmentParent, `endpoint-native-enrollment-${randomUUID()}`)
const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
const endpoint = path.join(candidate || path.dirname(fileURLToPath(new URL('../endpoint.mjs', import.meta.url))), 'endpoint.mjs')
const key = `mrk_${'c'.repeat(64)}`, teamId = randomUUID(), runtimeId = randomUUID()
const { default: WebSocket } = await import(pathToFileURL(path.join(bundle, 'node_modules/ws/index.js')))
const sourceRoot = path.join(external, 'work')
assert.notEqual(sourceRoot, await fs.realpath(os.homedir()), 'project root must not be the user home')
const peer = await createRuntimePeer({ WebSocket, key, teamId, version: catalog.nativeRuntime.version, workspaceBase: sourceRoot })
const model = await startPiModelFixture({ holdWrite: true, holdCompletion: true })
const config = {
  schema: 3,
  programs: { node, herdr: path.join(bundle, 'herdr/herdr.exe'), piPackage: path.join(bundle, 'node_modules/@earendil-works/pi-coding-agent'),
    piBin: path.join(bundle, 'node_modules/.bin'), gitRoot: path.join(bundle, 'git'), connectorPackage: runtimePackage },
  connector: { kind: 'memoh-runtime', enrollmentFile: path.join(enrollmentRoot, 'runtime.json') },
  sourceRoot, herdrConfigRoot: path.join(external, 'config/herdr'), herdrStateRoot: path.join(external, 'state/herdr'),
  piConfigDir: path.join(external, 'pi'), deviceId: runtimeId, runtimeId, instanceId: 'native-runtime-fixture', session: 'native-runtime-fixture',
  transfer: { pluginRoot: path.join(candidate || bundle, 'transfer'), nasOrigin: 'https://127.0.0.1:1/api' },
  transferConfigDir: path.join(external, 'native-file/config'), transferStateDir: path.join(external, 'native-file/state'),
}
const transfer = transferLocations(config), credential = 'synthetic-native-runtime-empty-queue'
const piWork = path.join(sourceRoot, 'pi-reconnect'), piSessions = path.join(piWork, 'sessions'), piSession = randomBytes(32).toString('hex')
const piArgs = [programPaths(config).pi, '--mode', 'json', '--provider', fixtureProvider, '--model', fixtureModel,
  '--session-dir', piSessions, '--session-id', piSession, '--tools', 'write', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files']
const original = new Map([
  [config.connector.enrollmentFile, JSON.stringify({ schemaVersion: 1, serverUrl: peer.origin, key, teamId, insecureLocalhost: true })],
  [path.join(config.herdrConfigRoot, 'config.toml'), '[update]\nversion_check = false\nmanifest_check = false\n'],
  // InstalledPluginInfo requires name even for disabled entries; Herdr reloads
  // actions from this exact producer manifest before checking enabled=false.
  [path.join(config.herdrConfigRoot, 'plugins.json'), JSON.stringify([{ plugin_id: 'memoh.delivery', name: 'Memoh delivery storage', enabled: false, version: catalog.components.transfer.version, plugin_root: transfer.root, manifest_path: path.join(transfer.root, 'herdr-plugin.toml') }])],
  [path.join(transfer.config, 'transfer.json'), JSON.stringify({ version: 1, origin: transfer.origin, source_root: config.sourceRoot })],
  [path.join(transfer.config, 'device.credential'), credential],
  [path.join(config.piConfigDir, 'auth.json'), '{}'],
  [path.join(config.piConfigDir, 'models.json'), JSON.stringify(model.models)],
  [path.join(piWork, 'run-pi.cjs'), "process.env.PI_OFFLINE='1';\n" + piWorkloadWrapper(node, piArgs, piWork, config.piConfigDir)],
  // These are inert preservation markers, not fabricated old task journals.
  [path.join(config.herdrConfigRoot, 'plugins/config/memoh.delivery/unselected-fixture.txt'), 'old plugin configuration stays in place'],
  [path.join(config.herdrStateRoot, 'plugins/memoh.delivery/unselected-fixture.txt'), 'old plugin state stays in place'],
  [path.join(config.sourceRoot, 'native-runtime-workload.cjs'), "const fs=require('node:fs'); fs.appendFileSync('invocations.txt','once\\n'); let n=0; const write=()=>fs.writeFileSync('progress.txt',String(++n)); write(); setInterval(write,200);\n"],
])
const hostConfig = path.join(hostRoot, 'config/endpoint.json'), activation = path.join(hostRoot, 'config/runtime.json')
original.set(hostConfig, JSON.stringify(config)); original.set(activation, JSON.stringify({ schema: 2, mode: 'existing-installations', transfer: 'existing-queue' }))
const directories = new Set()
for (const file of original.keys()) {
  if (file === config.connector.enrollmentFile) continue
  let directory = path.dirname(file)
  while (directory !== root) { directories.add(directory); directory = path.dirname(directory) }
}
for (let directory = transfer.state; directory !== root; directory = path.dirname(directory)) directories.add(directory)
directories.add(piSessions)
const input = path.join(root, 'private-native-runtime-fixture.json')
await fs.writeFile(input, JSON.stringify({ root, items: [...[...directories].sort((a, b) => a.length - b.length).map(p => ({ kind: 'directory', path: p })), ...[...original].filter(([p]) => p !== config.connector.enrollmentFile).map(([p, content]) => ({ kind: 'file', path: p, content }))] }))
const made = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./private-fixture.ps1', import.meta.url)), '-InputFile', input], { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 })
assert.equal(made.status, 0, 'fresh private native Runtime fixture must be created without changing existing ACLs')
// The temporary input is not a product auth file. Remove its synthetic key copy;
// preserve all actual enrolled/configuration bytes until fixture verification.
await fs.rm(input)
await fs.writeFile(input, JSON.stringify({ root: enrollmentParent, items: [
  { kind: 'directory', path: enrollmentRoot },
  { kind: 'file', path: config.connector.enrollmentFile, content: original.get(config.connector.enrollmentFile) },
] }))
const enrolledFixture = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./private-fixture.ps1', import.meta.url)), '-InputFile', input], { encoding: 'utf8', timeout: 30000, maxBuffer: 65536 })
await fs.rm(input)
assert.equal(enrolledFixture.status, 0, 'fresh CI-home enrollment must be created without changing existing ACLs')
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
async function rejectLegacyAction() {
  // Real official handler rejects before starting a plugin command. Its fixed
  // derived paths are never redirected to the host's explicit native pair.
  await assert.rejects(herdrOutput(['plugin', 'action', 'invoke', 'advance-delivery', '--plugin', 'memoh.delivery']), error => {
    if (error.killed || error.signal || error.code !== 1) return false
    try { const response = JSON.parse(error.stderr); return response.id === 'cli:plugin' && response.error?.code === 'plugin_disabled' }
    catch { return false }
  })
  assert.deepEqual(await transferCLI('lifecycle-summary'), emptyQueue)
  for (const file of [path.join(config.herdrConfigRoot, 'plugins.json'),
    path.join(config.herdrConfigRoot, 'plugins/config/memoh.delivery/unselected-fixture.txt'),
    path.join(config.herdrStateRoot, 'plugins/memoh.delivery/unselected-fixture.txt')]) assert.equal(await fs.readFile(file, 'utf8'), original.get(file))
}
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
let primaryError = null, piReconnectPhase = 'not_started'
try {
  await stage('required_inputs', async () => {
    for (const [file, content] of original) assert.deepEqual(await fs.readFile(file), Buffer.from(content), 'private fixture must preserve every original configuration byte')
    const p = programPaths(config)
    for (const file of [...original.keys(), p.node, p.herdr, p.pi, p.connector, p.git, path.join(p.gitRoot, 'cmd/git.exe'),
      path.join(p.piBin, 'pi'), path.join(p.piBin, 'pi.cmd'), path.join(config.programs.piPackage, 'package.json'), path.join(runtimePackage, 'package.json')]) assert.ok((await fs.stat(file)).isFile())
    for (const directory of [config.sourceRoot, config.herdrConfigRoot, config.herdrStateRoot, config.piConfigDir, transfer.config, transfer.state]) assert.ok((await fs.stat(directory)).isDirectory())
  })
  const installation = await stage('official_installation_preflight', () => inspectInstalled(config))
  process.stdout.write(JSON.stringify({ nativeRuntimePreflightVersions: installation.versions }) + '\n')
  if (process.argv[6]) await stage('official_enrollment_read', async () => {
    // This unchanged fixed-source reader is built only for CI, never shipped or
    // substituted for the real CLI. It checks bytes/ACLs without writes/network.
    const { readPrivateFile } = await import(pathToFileURL(await fs.realpath(process.argv[6])))
    try { assert.equal(await readPrivateFile(config.connector.enrollmentFile), original.get(config.connector.enrollmentFile)) }
    catch (error) {
      const diagnostic = String(error.stderr || error.message || '')
      const reasons = [
        ['Runtime path cannot be a reparse point', 'runtime_enrollment_reparse'],
        ['Runtime path has an untrusted owner', 'runtime_enrollment_owner'],
        ['Runtime path grants unsafe access to another account', 'runtime_enrollment_access'],
        ['runtime file changed while opening', 'runtime_enrollment_changed'],
      ]
      // Original PowerShell errors can contain their whole encoded command.
      // Output only a known category; never emit paths, ACLs or file content.
      const code = reasons.find(([text]) => diagnostic.includes(text))?.[1] || 'runtime_enrollment_read_unclassified'
      throw Object.assign(new Error(code), { code })
    }
  })
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
  const attemptsBeforeDuplicate = peer.counts.attempts, duplicate = launch()
  await duplicate.until(s => s.attention === 'endpoint_already_owned')
  assert.equal(await duplicate.stop(), 2)
  assert.equal(peer.counts.attempts, attemptsBeforeDuplicate)
  checked('second_public_host_cannot_start_another_native_connector_or_consumer')
  const generation = await fs.readFile(marker, 'utf8'); await ping(generation)
  await rejectLegacyAction()
  const created = await herdr(['workspace', 'create', '--cwd', config.sourceRoot]), paneId = created.result.root_pane.pane_id
  // pane.run acknowledges queued input, not shell readiness. Observe this fresh
  // fixture's empty prompt before the only workload submission; never retry it.
  await eventually(async () => isFreshPiShellPrompt(await herdrOutput(['pane', 'read', paneId, '--source', 'recent-unwrapped', '--lines', '5']), config.sourceRoot), 'fresh native Runtime fixture shell was not ready')
  // Official pane.run succeeds with empty CLI stdout; its exit status admits
  // input only. The progress and once-only side effect below prove execution.
  await herdrOutput(['pane', 'run', paneId, 'node native-runtime-workload.cjs'])
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
  await rejectLegacyAction()
  checked('official_disabled_legacy_action_stays_rejected_after_reconnect_without_redirecting_or_touching_old_state')
  checked('runtime_reconnect_preserves_original_herdr_pipe_peer_pane_and_single_running_workload')
  await stage('active_pi_control_disconnect', async () => {
    piReconnectPhase = 'create_workspace'
    const piCreated = (await herdr(['workspace', 'create', '--cwd', piWork])).result
    const piPane = piCreated.root_pane.pane_id, workspaceId = piCreated.workspace.workspace_id
    const paneIdentity = async () => {
      const state = (await herdr(['api', 'snapshot'])).result.snapshot
      const pane = state.panes.find(p => p.pane_id === piPane)
      assert.ok(pane?.terminal_id)
      assert.equal(pane.workspace_id, workspaceId)
      return { workspaceId, paneId: piPane, terminalId: pane.terminal_id }
    }
    await eventually(async () => isFreshPiShellPrompt(await herdrOutput(['pane', 'read', piPane, '--source', 'recent-unwrapped', '--lines', '5']), piWork), 'fresh Pi reconnect shell not ready')
    const identity = await paneIdentity()
    piReconnectPhase = 'single_pi_submission'
    await herdrOutput(['pane', 'run', piPane, 'node run-pi.cjs']) // Exactly one submission.
    await eventually(() => model.snapshot().requests === 1, 'official Pi did not reach the gated local model')
    assert.deepEqual(model.snapshot(), { requests: 1, offeredWrites: 0 })
    await assert.rejects(fs.access(path.join(piWork, fixtureFile)), { code: 'ENOENT' })
    await assert.rejects(fs.access(path.join(piWork, 'exit.json')), { code: 'ENOENT' })
    const connectionCount = peer.counts.connections, offlineAt = Date.now()
    piReconnectPhase = 'control_disconnect'
    peer.setNetworkAvailable(false)
    await host.until(s => peer.activeConnections() === 0 && s.updatedAt > offlineAt && ['offline', 'connecting'].includes(s.connection))
    await eventually(() => peer.counts.networkRefused > 0, 'control outage must include a refused reconnect')
    assert.equal(peer.counts.connections, connectionCount)
    assert.equal(await fs.readFile(marker, 'utf8'), generation); await ping(generation)
    assert.deepEqual(await paneIdentity(), identity)
    // Release the real Pi write tool only AFTER control is unavailable. File
    // creation now proves progress during the outage, not before disconnect.
    piReconnectPhase = 'offline_pi_write'; model.releaseWrite()
    await eventually(() => model.snapshot().requests === 2, 'Pi did not execute its write while control was offline')
    assert.equal(await fs.readFile(path.join(piWork, fixtureFile), 'utf8'), fixtureBytes)
    assert.equal(await fs.readFile(path.join(piWork, 'invocations.txt'), 'utf8'), 'once\n')
    await assert.rejects(fs.access(path.join(piWork, 'exit.json')), { code: 'ENOENT' })
    assert.equal(peer.counts.connections, connectionCount); assert.equal(peer.activeConnections(), 0)
    assert.deepEqual(await paneIdentity(), identity)
    const history = (await fs.readdir(piSessions)).filter(f => f.endsWith('.jsonl'))
    assert.equal(history.length, 1)
    const saved = await fs.readFile(path.join(piSessions, history[0]), 'utf8')
    assert.equal(JSON.parse(saved.split('\n')[0]).id, piSession)
    const reconnectAt = Date.now()
    piReconnectPhase = 'control_reconnect'
    peer.setNetworkAvailable(true)
    const again = await host.until(s => peer.counts.connections > connectionCount && s.updatedAt > reconnectAt && s.connection === 'online_snapshot')
    assert.equal(again.runId, online.runId); assert.equal(again.componentLifecycle.restartsInWindow, 0)
    assert.equal(await fs.readFile(marker, 'utf8'), generation); await ping(generation)
    assert.deepEqual(await paneIdentity(), identity)
    assert.equal(await fs.readFile(path.join(piWork, 'invocations.txt'), 'utf8'), 'once\n')
    assert.deepEqual(model.snapshot(), { requests: 2, offeredWrites: 1 })
    piReconnectPhase = 'pi_completion'; model.releaseCompletion()
    await eventually(async () => {
      try { assert.deepEqual(JSON.parse(await fs.readFile(path.join(piWork, 'exit.json'), 'utf8')), { status: 0, error: null }); return true }
      catch (error) { if (error.code === 'ENOENT') return false; throw error }
    }, 'official Pi did not complete after control reconnect')
    const output = await fs.readFile(path.join(piWork, 'stdout.jsonl'), 'utf8')
    assert.ok(output.trim().split('\n').map(line => JSON.parse(line)).some(event => event.type === 'message_end' && event.message?.role === 'assistant' && event.message.content?.some(part => part.type === 'text' && part.text === fixtureOutput)))
    const completed = await fs.readFile(path.join(piSessions, history[0]), 'utf8')
    assert.ok(completed.startsWith(saved)); assert.equal(JSON.parse(completed.split('\n')[0]).id, piSession)
    assert.equal(await fs.readFile(path.join(piWork, fixtureFile), 'utf8'), fixtureBytes)
    assert.equal(await fs.readFile(path.join(piWork, 'invocations.txt'), 'utf8'), 'once\n')
    assert.deepEqual(model.snapshot(), { requests: 2, offeredWrites: 1 }); assert.equal(model.diagnostics().rejected, 0)
    assert.deepEqual(await paneIdentity(), identity); await ping(generation)
    piReconnectPhase = 'passed'
    process.stdout.write(JSON.stringify({ activePiReconnect: 'passed', officialPi: catalog.components.pi.version, invocationCount: 1,
      localFileCreatedWhileControlOffline: true, samePiSession: true, samePaneTerminal: true, sameOwnedHerdrGeneration: true,
      historyPrefixPreserved: true, modelRequests: 2, model: 'synthetic_loopback', memohOperationReceipt: 'not_exercised', realPcNas: false }) + '\n')
  })
  checked('active_official_pi_writes_while_control_offline_and_reconnect_preserves_identity_without_replay')
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
  // Own isolated fixture only: reproduce the exact persisted infrastructure
  // failure after all known hosts have exited. Never alter production journals.
  const lifecycleFile = path.join(hostRoot, 'data/endpoint/lifecycle.json')
  const hostStatusFile = path.join(hostRoot, 'data/endpoint/host-status.json')
  const failureState = JSON.parse(await fs.readFile(lifecycleFile, 'utf8'))
  failureState.phase = 'needs_attention'; failureState.attention = 'herdr_observation_unknown'
  delete failureState.sessionContinuation
  const failedRaw = JSON.stringify(failureState)
  await fs.writeFile(lifecycleFile, failedRaw)
  const cached = JSON.parse(await fs.readFile(hostStatusFile, 'utf8'))
  // Preserve the original run's real timestamp ordering. Backdating this cache
  // below its own starting event invalidates the generation evidence.
  await eventually(()=>Date.now()-cached.updatedAt > 5000,'stopped fixture observation did not become stale')
  const originalAttempt = path.join(sourceRoot, '.memoh-computer/attempts/recovery-fixture/receipt.json')
  await fs.mkdir(path.dirname(originalAttempt), { recursive: true })
  const unknownReceipt = JSON.stringify({ state: 'unknown', prompt_submitted: false, attempt: 1, pi_session: piSession, receipt: 'synthetic-original' })
  await fs.writeFile(originalAttempt, unknownReceipt)
  const configurationHash = createHash('sha256').update(JSON.stringify([await fs.readFile(hostConfig, 'utf8'), await fs.readFile(activation, 'utf8')])).digest('hex')
  const failedHash = createHash('sha256').update(failedRaw).digest('hex')
  const recoveryArgs = [endpoint, 'host', 'recover', '--root', hostRoot, '--expected-run', cached.runId,
    '--expected-state-sha256', failedHash, '--expected-configuration-sha256', configurationHash]
  // A second real official Herdr server belongs to a different session and
  // this fixture's older parent process, not to the stopped host generation.
  const otherSession = config.session + '-unrelated'
  const otherServer = spawn(config.programs.herdr, ['--session', otherSession, 'server'], {env,cwd:sourceRoot,stdio:'ignore',windowsHide:true})
  const otherExit = new Promise(resolve=>otherServer.once('exit',resolve))
  const otherMarker = path.join(config.herdrConfigRoot,'sessions',otherSession,'herdr.sock')
  let rechecked
  try {
    await eventually(async()=>{
      try {const m=await fs.readFile(otherMarker,'utf8'); return m.split(':')[0] === String(otherServer.pid)} catch{return false}
    },'unrelated official Herdr did not start')
    const otherGeneration = await fs.readFile(otherMarker,'utf8')
    rechecked = JSON.parse((await promisify(execFile)(node,recoveryArgs,{timeout:60000,maxBuffer:16384,windowsHide:true,shell:false})).stdout)
    assert.ok(rechecked.excludedProcesses.some(p=>p.pid === otherServer.pid && p.role === 'herdr'))
    assert.equal(otherServer.exitCode,null)
    assert.equal(await fs.readFile(otherMarker,'utf8'),otherGeneration)
    // Only our exact created generation can receive this cleanup request.
    await promisify(execFile)(powershell,['-NoProfile','-NonInteractive','-File',path.join(path.dirname(endpoint),'owned-herdr.ps1'),'-MarkerPath',otherMarker,'-Generation',otherGeneration,'-OwnerProcessId',String(otherServer.pid),'-Action','server.stop'],{env,timeout:20000,maxBuffer:16384,windowsHide:true,shell:false})
    await bounded(otherExit,10000,'unrelated fixture Herdr cleanup deadline')
  } finally {
    // Known disposable child handle only; never find/kill a process by name.
    if(otherServer.exitCode === null) {otherServer.kill();await bounded(otherExit,10000,'unrelated fixture child exit deadline')}
  }

  assert.equal(rechecked.state, 'infrastructure_rechecked'); assert.equal(rechecked.started, false); assert.equal(rechecked.businessReplayed, false)
  assert.equal(await fs.readFile(path.join(path.dirname(lifecycleFile), `lifecycle-before-recheck-${failedHash}.json`), 'utf8'), failedRaw)
  assert.equal(await fs.readFile(originalAttempt, 'utf8'), unknownReceipt)
  const unchangedJournal = await fs.readFile(lifecycleFile, 'utf8')
  assert.equal(JSON.parse((await promisify(execFile)(node, recoveryArgs, { timeout: 60000, maxBuffer: 16384, windowsHide: true, shell: false })).stdout).state, 'already_rechecked')
  assert.equal(await fs.readFile(lifecycleFile, 'utf8'), unchangedJournal)
  const recovered = launch()
  await recovered.until(s => s.attention === 'connector_authentication_required')
  assert.equal(await recovered.stop(), 2) // Peer still refuses auth; never fake online.
  assert.equal(await fs.readFile(originalAttempt, 'utf8'), unknownReceipt)
  assert.equal(await fs.readFile(path.join(piWork, 'invocations.txt'), 'utf8'), 'once\n')
  assert.deepEqual(model.snapshot(), { requests: 2, offeredWrites: 1 })
  assert.equal(await fs.readFile(path.join(config.sourceRoot, 'invocations.txt'), 'utf8'), 'once\n')
  checked('explicit_infrastructure_recheck_uses_real_process_owner_status_and_retains_unknown_attempt_without_pi_replay')

  for (const [file, content] of original) assert.equal(await fs.readFile(file, 'utf8'), content)
  assert.equal(peer.counts.invalid, 0)
  checked('official_configuration_enrollment_and_original_workload_bytes_are_preserved')
  process.stdout.write(JSON.stringify({ nativeRuntimeChecks: checks.length, source: catalog.nativeRuntime.revision, connectorVersion: catalog.nativeRuntime.version,
    controlTransport: 'official_explicit_loopback_test_mode', originalWorkloadInvocations: 1, peerRPCDispatch: 'none', modelRequests: model.snapshot().requests, model: 'synthetic_loopback',
    transferProducer: catalog.components.transfer.revision, transferVersion: catalog.components.transfer.version, transferObservation: 'actual_exe_empty_queue_idle', deliveryAdmissionsSubmitted: 0,
    serverIdentity: 'synthetic_peer_not_memoh_owner', stopAuthority: false, taskRecovery: 'not_exercised', fileTransferTLS: 'not_exercised', realPCandNAS: 'not_run' }) + '\n')
} catch (error) {
  primaryError = error
  process.stdout.write(JSON.stringify({ activePiReconnectEvidence: await piWorkloadEvidence(piWork, [root, bundle]), phase: piReconnectPhase, model: model.snapshot() }) + '\n')
} finally {
  const [modelCleanup] = await Promise.allSettled([bounded(model.close(), 5000, 'Pi model fixture close deadline')])
  const cleanup = await Promise.allSettled([...hosts].map(host => host.stop()))
  const [peerCleanup] = await Promise.allSettled([Promise.resolve().then(() => bounded(peer.close(), 5000, 'native Runtime fixture peer close deadline'))])
  // Only the exclusive fresh fixture child above is ours to remove. Do not
  // remove its enrollment while any host cleanup remains unconfirmed.
  const [enrollmentCleanup] = await Promise.allSettled([Promise.resolve().then(async () => {
    assert.equal(hosts.size, 0, 'retain fixture enrollment while host ownership is unresolved')
    assert.equal(cleanup.filter(r => r.status === 'rejected').length, 0)
    await fs.rm(enrollmentRoot, { recursive: true })
    await assert.rejects(fs.stat(enrollmentRoot), { code: 'ENOENT' })
  })])
  process.stdout.write(JSON.stringify({ nativeRuntimeFixtureCleanup: 'observed', remainingHosts: hosts.size,
    stopFailures: cleanup.filter(r => r.status === 'rejected').length, peer: peerCleanup.status === 'fulfilled' ? 'closed' : 'close_failed',
    enrollment: enrollmentCleanup.status === 'fulfilled' ? 'fresh_child_removed' : 'retained_or_cleanup_failed', model: modelCleanup.status === 'fulfilled' ? 'closed' : 'close_failed' }) + '\n')
  try {
    assert.equal(cleanup.filter(r => r.status === 'rejected').length, 0)
    assert.equal(hosts.size, 0)
    assert.equal(peerCleanup.status, 'fulfilled', 'native Runtime fixture peer cleanup failed')
    assert.equal(modelCleanup.status, 'fulfilled', 'Pi model fixture cleanup failed')
    assert.equal(enrollmentCleanup.status, 'fulfilled', 'native Runtime fixture enrollment cleanup failed')
  } catch (error) { primaryError ??= error }
}
if (primaryError) throw primaryError
