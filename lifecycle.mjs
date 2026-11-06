import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { catalog, managedEnvironment, programPaths, transferLocations, isNativeRuntimeConfig, connectorConfigReference, requireNativeRuntime } from './endpoint.mjs'
import { NativeRuntimeConnector } from './native-connector.mjs'
import { handoffPayload, validHandoffRecord, handoffObservation } from './handoff.mjs'
import { validSessionContinuation, captureSessionContinuation } from './session-continuation.mjs'

// Internal foreground lifecycle. No business dispatch, transfer implementation,
// network service, OS startup registration, credential editing or second watchdog.
export class LifecycleError extends Error {
  constructor(code) { super(code); this.code = code }
}
function demand(ok, code) { if (!ok) throw new LifecycleError(code) }
// Preserve the existing journal's maximum history and Node's timer range.
// These are representation bounds, not a replacement restart policy.
const restartHistoryLimit = 100
const timerDelayLimit = 2 ** 31 - 1
export function validateRestartPolicy(value = {}) {
  demand(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => ['maxRestarts', 'windowMs', 'retryMs'].includes(key)), 'restart_policy_invalid')
  const policy = { maxRestarts: 3, windowMs: 600000, retryMs: 1000, ...value }
  demand(Number.isSafeInteger(policy.maxRestarts) && policy.maxRestarts >= 0 && policy.maxRestarts <= restartHistoryLimit &&
    Number.isSafeInteger(policy.windowMs) && policy.windowMs > 0 && Number.isSafeInteger(policy.retryMs) && policy.retryMs > 0 &&
    policy.retryMs <= Math.floor(timerDelayLimit / Math.max(1, policy.maxRestarts)), 'restart_policy_invalid')
  return Object.freeze(policy)
}
function code(error) { return error instanceof LifecycleError ? error.code : 'lifecycle_operation_failed' }
function connectorFailure(error) {
  return new LifecycleError(typeof error?.code === 'string' && /^(native_connector|connector)_[a-z_]+$/.test(error.code) ? error.code : 'connector_operation_failed')
}
async function readFile(file, limit = 262144) {
  const s = await fs.lstat(file)
  demand(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= limit, 'unsafe_lifecycle_input')
  return fs.readFile(file, 'utf8')
}
async function readJSON(file) { return JSON.parse(await readFile(file)) }
export function connectorAttention(snapshot) {
  if (['handshake_401', 'handshake_403'].includes(snapshot?.lastError)) return 'connector_authentication_required'
  if (snapshot?.lastError === 'handshake_426') return 'connector_protocol_upgrade_required'
  if (snapshot?.lastError === 'config_changed_restart_required') return 'connector_configuration_changed'
  if (snapshot?.lastError === 'native_configuration_invalid') return 'connector_configuration_invalid'
  if (snapshot?.lastError === 'native_tls_verification_failed') return 'connector_tls_verification_failed'
  if (snapshot?.state === 'needs_attention') return 'connector_needs_attention'
  // Official connector also stops when its credential file is removed.
  // A published clean stop is not proof of an accidental process crash.
  if (snapshot?.state === 'stopped') return 'connector_stopped_requires_attention'
  return null
}

// Windows named pipes are used only as OS lifetime leases; no commands/data are
// accepted. Their handles disappear on process death, without PID/file stealing.
// Unix socket leases support development tests; stale Unix sockets fail closed.
export async function acquireLeases(keys, directory) {
  const handles = []
  try {
    for (const key of [...new Set(keys)].sort()) {
      const id = createHash('sha256').update(key.toLowerCase()).digest('hex').slice(0, 32)
      const address = process.platform === 'win32' ? `\\\\.\\pipe\\memoh-endpoint-${id}` : path.join(directory, `${id}.sock`)
      const handle = net.createServer({ pauseOnConnect: true }, socket => socket.destroy())
      await new Promise((resolve, reject) => {
        handle.once('error', () => reject(new LifecycleError('endpoint_already_owned')))
        handle.listen({ path: address, exclusive: true }, resolve)
      })
      handles.push(handle)
    }
  } catch (error) {
    await Promise.all(handles.map(h => new Promise(resolve => h.close(resolve))))
    throw error
  }
  return async () => Promise.all(handles.map(h => new Promise(resolve => h.close(resolve))))
}

export class StateStore {
  constructor(directory, identity, { io = fs, checkpoint = async () => {} } = {}) {
    this.directory = directory; this.identity = identity; this.file = path.join(directory, 'lifecycle.json')
    this.io = io; this.checkpoint = checkpoint; this.writes = Promise.resolve()
  }
  serialize(operation) {
    const pending = this.writes.then(operation)
    this.writes = pending.catch(() => {})
    return pending
  }
  async load() {
    demand(path.isAbsolute(this.directory) && await fs.realpath(this.directory) === this.directory, 'canonical_state_root_required')
    let data, missing = false
    try { data = await readJSON(this.file) } catch (e) { if (e.code !== 'ENOENT') throw new LifecycleError('lifecycle_state_unreadable'); missing = true }
    if (missing) return { schema: 1, identity: this.identity, phase: 'stopped', restarts: [], attention: null }
    demand(data && typeof data === 'object' && !Array.isArray(data), 'lifecycle_state_mismatch')
    demand([1, 2].includes(data.schema) && data.identity === this.identity && Array.isArray(data.restarts) && data.restarts.length <= restartHistoryLimit && data.restarts.every(t => Number.isSafeInteger(t) && t >= 0), 'lifecycle_state_mismatch')
    demand(['stopped', 'starting', 'running', 'stopping', 'needs_attention'].includes(data.phase) && (data.attention === null || /^[a-z_]{1,80}$/.test(data.attention)), 'lifecycle_state_mismatch')
    demand(data.sessionContinuation === undefined || validSessionContinuation(data.sessionContinuation), 'lifecycle_state_mismatch')
    if (data.producerUpgrade !== undefined) {
      const p = data.producerUpgrade
      demand(p && Object.keys(p).sort().join(',') === 'planSha256,requestId,schema' && p.schema === 1 &&
        /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(p.requestId) && /^[a-f0-9]{64}$/.test(p.planSha256), 'lifecycle_producer_upgrade_mismatch')
    }
    if (data.infrastructureRecovery !== undefined) {
      const r = data.infrastructureRecovery
      demand(r && Object.keys(r).sort().join(',') === 'attempts,businessReplayed,configuration,fromState,previousAttention,previousPhase,run,schema' &&
        r.schema === 1 && ['attempts','configuration','fromState'].every(k => /^[a-f0-9]{64}$/.test(r[k])) && /^[a-f0-9-]{36}$/.test(r.run) &&
        (['needs_attention', 'stopped'].includes(r.previousPhase) && ['herdr_observation_unknown', 'connector_stop_unknown'].includes(r.previousAttention) || r.previousPhase === 'running' && r.previousAttention === null) &&
        r.businessReplayed === false, 'lifecycle_recovery_mismatch')
    }
    demand(data.schema === 1 ? data.handoff === undefined : validHandoffRecord(data.handoff) && data.handoff.payload.native.device_id === this.identity, 'lifecycle_handoff_mismatch')
    return data
  }
  save(data) {
    const snapshot = structuredClone(data)
    return this.serialize(async () => {
      const current = await this.load()
      // Ordinary lifecycle saves cannot erase or regress an ack written while
      // their state snapshot was in flight. Only the methods below mutate it.
      if (current.handoff) { snapshot.schema = 2; snapshot.handoff = current.handoff }
      else demand(snapshot.handoff === undefined && snapshot.schema === 1, 'lifecycle_handoff_write_required')
      await this.write(snapshot)
    })
  }
  recheckObservation(expected, next) {
    return this.serialize(async () => {
      demand(expected.phase === 'needs_attention' && expected.attention === 'herdr_observation_unknown' && !expected.handoff &&
        JSON.stringify(next) === JSON.stringify({ ...expected, phase: 'running', attention: null }), 'herdr_recheck_not_eligible')
      demand(JSON.stringify(await this.load()) === JSON.stringify(expected), 'herdr_recheck_state_changed')
      await this.write(next, expected)
    })
  }
  async write(data, expected = null) {
    // Existing journal and publication mechanism; no second task/request ledger.
    const raw = `${JSON.stringify(data)}\n`
    demand(Buffer.byteLength(raw) <= 262144, 'lifecycle_state_too_large')
    try { await readFile(this.file) } catch (e) { if (e.code !== 'ENOENT') throw e }
    await this.checkpoint('before_write')
    const temporary = path.join(this.directory, `.lifecycle-${randomUUID()}.tmp`)
    const h = await this.io.open(temporary, 'wx')
    try { await h.writeFile(raw); await h.sync() } finally { await h.close() }
    await this.checkpoint('file_synced')
    if (expected !== null && JSON.stringify(await this.load()) !== JSON.stringify(expected)) {
      await this.io.unlink(temporary)
      throw new LifecycleError('herdr_recheck_state_changed')
    }
    await this.io.rename(temporary, this.file)
    await this.checkpoint('published')
  }
  async handoffStatus(requestId) {
    return handoffObservation((await this.load()).handoff, requestId)
  }
  async recordHandoff(value) {
    // Internal journal operation, called only by its existing lease owner.
    // No CLI/stdin mutation route is exposed until caller identity is resolved.
    const checked = handoffPayload(value)
    return this.serialize(async () => {
      const current = await this.load(), requestId = checked.payload.request_id
      demand(checked.payload.native.device_id === this.identity, 'handoff_identity_mismatch')
      if (current.handoff) {
        demand(current.handoff.request_id === requestId, 'handoff_request_pending')
        demand(current.handoff.payload_sha256 === checked.sha256, 'handoff_content_conflict')
        return handoffObservation(current.handoff, requestId)
      }
      const record = { schema: 1, request_id: requestId, payload_sha256: checked.sha256, payload: checked.payload, state: 'recorded_unverified' }
      try { await this.write({ ...current, schema: 2, handoff: record }) }
      catch (cause) { throw Object.assign(new LifecycleError('handoff_persistence_unknown'), { cause }) }
      return handoffObservation(record, requestId)
    })
  }
  markHandoffUnknown(requestId, payloadHash) {
    return this.serialize(async () => {
      const current = await this.load(), record = current.handoff
      demand(record && record.request_id === requestId && record.payload_sha256 === payloadHash, 'handoff_content_conflict')
      if (record.state !== 'outcome_unknown') {
        const next = { ...record, state: 'outcome_unknown' }
        try { await this.write({ ...current, handoff: next }) }
        catch (cause) { throw Object.assign(new LifecycleError('handoff_persistence_unknown'), { cause }) }
        return handoffObservation(next, requestId)
      }
      return handoffObservation(record, requestId)
    })
  }

}

export class NativeDriver {
  constructor(config, { qualify, inheritedEnvironment = process.env, checkPrograms = null } = {}) {
    this.config = config
    this.qualify = qualify
    this.checkPrograms = checkPrograms
    this.herdrVersion = catalog.components.herdr.version
    // Environment is fully cleaned by the shared product function, not the plan
    // overlay. Extra environment injection is not exposed to product callers.
    this.env = managedEnvironment(config, inheritedEnvironment)
    this.children = new Map()
    this.previousChildren = new Map() // At most one previous owned generation per component, diagnostics only.
    const programs = programPaths(config)
    this.node = programs.node
    this.herdr = programs.herdr
    this.connector = programs.connector
    this.nativeConnector = isNativeRuntimeConfig(config) ? new NativeRuntimeConnector({ node: this.node, entry: this.connector,
      enrollmentFile: connectorConfigReference(config), cwd: config.sourceRoot, env: this.env,
      deviceId: config.deviceId, runtimeId: config.runtimeId, version: catalog.nativeRuntime.version }) : null
    this.fingerprint = null
    this.marker = config.session === 'default' ? path.join(config.herdrConfigRoot, 'herdr.sock') : path.join(config.herdrConfigRoot, 'sessions', config.session, 'herdr.sock')
  }
  async validate(state) {
    requireNativeRuntime(this.config)
    demand(process.platform === 'win32' && process.arch === 'x64' && typeof this.qualify === 'function', 'qualified_windows_driver_required')
    demand(await this.qualify(state) === true, 'component_qualification_failed')
    let credentials
    try { credentials = await fs.lstat(connectorConfigReference(this.config)) }
    catch (e) { throw new LifecycleError(e.code === 'ENOENT' ? 'connector_authentication_required' : 'connector_credentials_unreadable') }
    demand(credentials.isFile() && !credentials.isSymbolicLink() && credentials.nlink === 1, 'connector_credentials_unreadable')
    const host = await readFile(path.join(this.config.herdrConfigRoot, 'config.toml'))
    const connector = await readFile(connectorConfigReference(this.config))
    const sum = createHash('sha256').update(host).update('\0').update(connector).digest('hex')
    demand(!this.fingerprint || this.fingerprint === sum, 'official_configuration_changed')
    this.fingerprint = sum
  }
  diagnostics() {
    const project = (component, c) => c ? { component, pid: c.process.pid || null,
      exitObserved: c.exitObserved, exitCode: c.exitCode ?? null, signal: c.signal ?? null,
      processError: c.error, stderrBytes: c.stderrBytes || 0, stderrCode: c.stderrBytes ? 'unclassified_stderr' : null } : null
    const records = [...this.children].map(([component, c]) => ({ ...project(component, c), previousExit: project(component, this.previousChildren.get(component)) }))
    const native = this.nativeConnector?.diagnostics()
    if (native) records.push(native)
    if (this.statusObservation) records.push(this.statusObservation)
    return records
  }
  recordStatusFailure(outcome, result = {}) {
    const stderr = String(result.stderr || '').slice(0, 4096)
    const stderrClass = /permission\s*denied|access (?:is )?denied|os error 5\b|For an elevated server, use an administrator terminal\./i.test(stderr) ? 'permission_denied' :
      /unexpected argument|unrecognized (?:option|argument)|unknown (?:option|argument)|bad option|invalid session/i.test(stderr) ? 'arguments_rejected' :
      /connection refused|pipe.*(?:not found|busy)|server_not_running/i.test(stderr) ? 'endpoint_unavailable' : stderr ? 'unclassified' : 'absent'
    this.statusObservation = { component: 'herdr_observation', outcome,
      exitCode: Number.isInteger(result.code) ? result.code : null,
      errorCode: ['ENOENT','EACCES','EPERM','ETIMEDOUT','ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes(result.code) ? result.code : null,
      signal: typeof result.signal === 'string' && /^SIG[A-Z]+$/.test(result.signal) ? result.signal : null,
      stdoutBytes: Math.min(16385, Buffer.byteLength(String(result.stdout || ''))), stderrBytes: Math.min(16385, Buffer.byteLength(String(result.stderr || ''))), stderrClass }
  }
  statusFailure(outcome, result) {
    this.recordStatusFailure(outcome, result)
    return new LifecycleError(this.statusObservation.stderrClass === 'permission_denied' || ['EACCES','EPERM'].includes(result?.code) ? 'herdr_observation_permission_denied' : 'herdr_observation_unknown')
  }
  command(file, args, timeout = 10000) {
    requireNativeRuntime(this.config)
    this.checkPrograms?.()
    const r = spawnSync(file, args, { env: this.env, cwd: this.config.sourceRoot, encoding: 'utf8', timeout, maxBuffer: 16384, windowsHide: true, shell: false })
    if (file === this.herdr && args.join('\0') === ['--session', this.config.session, 'status', 'server', '--json'].join('\0') && (r.error || r.status !== 0)) {
      throw this.statusFailure(r.error?.code === 'ETIMEDOUT' ? 'deadline' : r.error ? 'process_error' : 'nonzero_exit', { stdout: r.stdout, stderr: r.stderr, code: r.error?.code || r.status, signal: r.signal })
    }
    demand(!r.error && r.status === 0, 'official_command_failed')
    return r.stdout
  }
  hostStatus() {
    this.checkPrograms?.()
    let value
    try { value = JSON.parse(this.command(this.herdr, ['--session', this.config.session, 'status', 'server', '--json'], 3000)) }
    catch (error) { if (error.code === 'herdr_observation_permission_denied') throw error; throw new LifecycleError('herdr_observation_unknown') }
    demand(typeof value.running === 'boolean', 'herdr_observation_unknown')
    return value
  }
  async observeHostStatus() {
    requireNativeRuntime(this.config)
    this.checkPrograms?.()
    // A runtime observation must let the event loop record an owned child's
    // exit while the status CLI is running. spawnSync in this path held that
    // evidence back and converted a concurrent known crash into permanent
    // herdr_observation_unknown attention before recovery could run.
    let value, result
    try {
      result = await promisify(execFile)(this.herdr, ['--session', this.config.session, 'status', 'server', '--json'], {
        env: this.env, cwd: this.config.sourceRoot, timeout: 3000, maxBuffer: 16384, windowsHide: true, shell: false,
      })
    } catch (error) {
      throw this.statusFailure(error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output_limit' : error.killed ? 'deadline' : Number.isInteger(error.code) ? 'nonzero_exit' : 'process_error', error)
    }
    try { value = JSON.parse(result.stdout) }
    catch { this.recordStatusFailure('invalid_json', { ...result, code: 0 }); throw new LifecycleError('herdr_observation_unknown') }
    if (typeof value?.running !== 'boolean') { this.recordStatusFailure('invalid_shape', { ...result, code: 0 }); throw new LifecycleError('herdr_observation_unknown') }
    this.statusObservation = null
    return value
  }
  async ownedGeneration(capture = false) {
    const c = this.children.get('herdr')
    demand(this.alive('herdr'), 'herdr_owner_exited')
    let marker
    try { marker = await readFile(this.marker, 80) } catch { throw new LifecycleError('herdr_ownership_unverified') }
    demand(/^\d+:\d+$/.test(marker) && marker.split(':')[0] === String(c.process.pid), 'herdr_owner_mismatch')
    if (capture && !c.generation) c.generation = marker
    demand(c.generation === marker, 'herdr_generation_changed')
    return marker
  }
  async ownedHostRequest(action) {
    requireNativeRuntime(this.config)
    const generation = await this.ownedGeneration()
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
    const helper = fileURLToPath(new URL('./owned-herdr.ps1', import.meta.url))
    let response
    try {
      const result = await promisify(execFile)(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', helper, '-MarkerPath', this.marker, '-Generation', generation, '-OwnerProcessId', String(this.children.get('herdr').process.pid), '-Action', action], { env: this.env, cwd: this.config.sourceRoot, timeout: 20000, maxBuffer: 16384, windowsHide: true, shell: false })
      response = JSON.parse(result.stdout)
    } catch (error) {
      let reason
      try { reason = JSON.parse(error.stdout).error } catch { /* Bounded diagnostics only. */ }
      const failure = new LifecycleError(/^herdr_(owner_mismatch|generation_changed|ownership_unverified|request_(rejected|timeout|incomplete|oversized|failed))$/.test(reason) ? reason : 'herdr_ownership_unverified')
      // Keep authority fail-closed, but retain bounded process evidence for a
      // caller's diagnostics. Never attach command text, environment or output.
      const stage = String(error.stderr || '').match(/(?:^|\n)owned_helper_stage=(bootstrap|module_loaded|compiled|pipe_connected|peer_verified)(?=\r?\n|$)/g)?.at(-1)?.trim().split('=')[1] || 'not_observed'
      failure.helper = { outcome: error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output_limit' : error.killed ? 'deadline' : Number.isInteger(error.code) ? 'nonzero_exit' : 'process_error', exitCode: Number.isInteger(error.code) ? error.code : null, response: typeof reason === 'string' ? 'error_response' : error.stdout ? 'unrecognized_output' : 'absent', stage }
      throw failure
    }
    demand(response.id === 'endpoint-owned' && response.result && !response.error, 'herdr_request_failed')
    return response.result
  }
  async ownedHostStatus() {
    await this.ownedGeneration()
    const status = await this.observeHostStatus() // read-only; generation checked on both sides
    await this.ownedGeneration()
    return status
  }
  // An error can mean a failed kill, not a failed spawn. Until exit is observed
  // an allocated child still owns its slot and must remain eligible for cleanup.
  alive(component) { if (component === 'connector' && this.nativeConnector) return this.nativeConnector.alive(); const c = this.children.get(component); return Boolean(c && !c.exited) }
  confirmedExit(component) {
    if (component === 'connector' && this.nativeConnector) return this.nativeConnector.confirmedExit()
    const c = this.children.get(component)
    // Only an exit event on the same retained child record after a verified
    // generation qualifies. A kill request, spawn error or missing PID does not.
    return Boolean(c && c.exitObserved === true && c.exited && !c.error && /^\d+:\d+$/.test(c.generation) && c.generation.split(':')[0] === String(c.process.pid))
  }
  async start(component) {
    requireNativeRuntime(this.config)
    this.checkPrograms?.()
    demand(!this.alive(component), 'component_already_owned')
    if (component === 'connector' && this.nativeConnector) {
      try { await this.nativeConnector.start(); return } catch (error) { throw connectorFailure(error) }
    }
    demand(component === 'herdr', 'component_unsupported')
    demand(!this.hostStatus().running, 'existing_herdr_requires_handoff')
    const file = this.herdr
    const args = ['--session', this.config.session, 'server']
    const processHandle = spawn(file, args, { env: this.env, cwd: this.config.sourceRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    const c = { process: processHandle, startedAt: Date.now(), exited: false, exitObserved: false, error: false, exitCode: null, signal: null, stderrBytes: 0 }
    c.done = new Promise(resolve => {
      processHandle.once('exit', (exitCode, signal) => { c.exitObserved = true; c.exited = true; c.exitCode = exitCode; c.signal = signal; resolve() })
      processHandle.on('error', () => {
        c.error = true
        // Failed spawn has no PID and no later exit event. A post-spawn error
        // must not resolve done or discard the still-owned process handle.
        if (processHandle.pid === undefined) { c.exited = true; resolve() }
      })
    })
    processHandle.stdout.resume()
    // Drain without retaining arbitrary child text (which can contain keys or
    // task content). Persist only byte count and actual exit metadata via host.
    processHandle.stderr.on('data', chunk => { c.stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, c.stderrBytes + chunk.length) })
    this.previousChildren.set(component, this.children.get(component)); this.children.set(component, c)
  }
  async connectorStatus() { return this.nativeConnector?.status() ?? null }
  async waitReady(component, timeout = 30000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      // A fast secure-loader/handshake failure may already have exited. Keep
      // its classified reason instead of reducing it to process disappearance.
      if (component === 'connector' && this.nativeConnector) {
        const attention = connectorAttention(await this.connectorStatus())
        demand(!attention, attention)
      }
      demand(this.alive(component), `${component}_startup_exited`)
      const owned = component === 'connector' && this.nativeConnector ? this.nativeConnector.record : this.children.get(component)
      demand(!owned?.error, `${component}_process_error`)
      if (component === 'herdr') {
        try {
          const s = this.hostStatus()
          if (s.running && s.version === this.herdrVersion && s.endpoint_compatible === true) {
            await this.ownedGeneration(true)
            const owned = await this.ownedHostRequest('ping')
            demand(owned.type === 'pong' && owned.version === this.herdrVersion, 'herdr_ownership_unverified')
            return
          }
        } catch (error) {
          if (error instanceof LifecycleError && error.code !== 'herdr_observation_unknown') throw error
          // Startup only: the endpoint may not have been published yet.
        }
      } else {
        const s = await this.connectorStatus()
        const attention = connectorAttention(s)
        demand(!attention, attention)
        if (s && ['connecting', 'authenticating', 'online', 'offline'].includes(s.state)) return
      }
      await sleep(100)
    }
    throw new LifecycleError(`${component}_startup_timeout`)
  }
  async recoverConnector() {
    requireNativeRuntime(this.config)
    // Recovery retains only the exact owned Runtime child. No stale-lock
    // command, PID guessing or external daemon adoption is available.
    try { await this.nativeConnector.stop() } catch (error) { throw connectorFailure(error) }
    demand(this.nativeConnector.confirmedExit(), 'connector_stop_unknown')
  }
  async stop(component) {
    if (component === 'connector' && this.nativeConnector) {
      try { await this.nativeConnector.stop(); return } catch (error) { throw connectorFailure(error) }
    }
    const c = this.children.get(component)
    if (!c) return
    if (this.alive(component)) {
      demand(component === 'herdr', 'component_unsupported')
      await this.ownedHostRequest('server.stop')
      const timer = new AbortController()
      try {
        await Promise.race([c.done, sleep(10000, undefined, { signal: timer.signal }).then(() => { throw new LifecycleError(`${component}_stop_unknown`) })])
      } finally { timer.abort() }
      if (component === 'herdr' && [2, 3].includes(this.config.schema)) {
        // Capture once at the confirmed owned exit, not on a later stop retry
        // when another process might have changed the official snapshot.
        try { c.sessionContinuation = await captureSessionContinuation(this.config) }
        catch { c.continuationUnavailable = true }
      }
    }
  }
  async captureContinuation() {
    const owned = this.children.get('herdr')
    demand(!owned?.continuationUnavailable, 'session_continuation_unavailable')
    return owned?.sessionContinuation || null
  }
}

export class EndpointLifecycle {
  constructor({ driver, store, acquire, transfer = null, clock = Date.now, delay = sleep, policy = {} }) {
    this.driver = driver; this.store = store; this.acquire = acquire
    this.transfer = transfer
    this.clock = clock; this.delay = delay
    this.policy = validateRestartPolicy(policy)
    this.active = null; this.stopping = false; this.release = null
    this.observedConnection = 'unverified'
  }
  snapshot() {
    return { schema: 1, phase: this.state?.phase || 'stopped', attention: this.state?.attention || null, restartsInWindow: this.state?.restarts.length || 0, ready: false,
      journal: this.journalError ? 'unavailable' : this.state ? 'observed' : 'unverified', cleanupAttention: this.cleanupError ? code(this.cleanupError) : null,
      connection: this.observedConnection, agent: 'official_restore_semantics_retained', desktop: 'interactive_session_unverified', transfer: this.transfer?.snapshot() || 'lifecycle_interface_pending',
      lifecycle: { foreground: true, singleInstance: Boolean(this.release), componentRecovery: 'bounded', transferAutomaticRecovery: false, lockedDesktop: 'no_desktop_readiness_claim', loggedOut: 'not_running_no_autostart' } }
  }
  async save() {
    try { await this.store.save(this.state); this.journalError = null }
    catch (error) {
      this.journalError = error
      const failure = new LifecycleError('lifecycle_state_write_failed')
      failure.cause = error
      throw failure
    }
  }
  async cleanupOwned() {
    this.cleanupError = null
    try { await this.transfer?.stop() } catch (error) { this.cleanupError = error }
    for (const component of ['connector', 'herdr']) {
      try { await this.driver.stop(component) }
      catch (error) { this.cleanupError ??= error }
    }
    if (this.cleanupError) throw this.cleanupError
  }
  async attention(reason) {
    this.state.phase = 'needs_attention'; this.state.attention = reason
    await this.save()
  }
  async start(options = {}) {
    demand(!this.starting && !this.release, 'endpoint_already_owned')
    this.stopping = false
    this.observedConnection = 'unverified'
    this.starting = this.startOwned(options)
    try { return await this.starting } finally { this.starting = null }
  }
  async startOwned({ acknowledgeAttention = false } = {}) {
    this.release = await this.acquire()
    try {
      this.state = await this.store.load()
      if (this.state.attention && !acknowledgeAttention) throw new LifecycleError(this.state.attention)
      this.state.attention = null
      demand(!this.stopping, 'startup_cancelled')
      await this.driver.validate(this.state)
      demand(!this.driver.hostStatus().running, 'existing_herdr_requires_handoff')
      demand(!this.stopping, 'startup_cancelled')
      delete this.state.sessionContinuation // consume before any component start
      this.state.phase = 'starting'; await this.save()
      await this.driver.start('herdr'); await this.driver.waitReady('herdr')
      demand(!this.stopping, 'startup_cancelled')
      await this.driver.start('connector'); await this.driver.waitReady('connector')
      demand(!this.stopping, 'startup_cancelled')
      this.transfer?.start()
      this.state.phase = 'running'; await this.save()
      return this.snapshot()
    } catch (error) {
      // Journal failures must never skip owned-child cleanup or replace the
      // original startup error. A failed write remains visible in the snapshot.
      if (this.state) {
        try {
          if (code(error) === 'startup_cancelled') { this.state.phase = 'stopped'; this.state.attention = null; await this.save() }
          else await this.attention(code(error))
        } catch { /* Preserve the original failure; continue mandatory cleanup. */ }
      }
      try {
        await this.cleanupOwned()
        await this.release(); this.release = null
      } catch (cleanupError) {
        this.cleanupError = cleanupError
        if (this.state) {
          try { await this.attention('startup_cleanup_requires_attention') }
          catch { /* Retain lease when cleanup cannot be confirmed, even if disk is full. */ }
        }
      }
      throw error
    }
  }
  async recover(component) {
    const snapshot = await this.driver.connectorStatus()
    const reason = connectorAttention(snapshot)
    if (reason) return this.attention(reason)
    const now = this.clock()
    this.state.restarts = this.state.restarts.filter(t => t > now - this.policy.windowMs)
    if (this.state.restarts.some(t => t > now) || this.state.restarts.length >= this.policy.maxRestarts) return this.attention('restart_budget_exhausted')
    this.observedConnection = 'recovering'
    this.state.restarts.push(now); await this.save() // budget survives coordinator restart
    if (component === 'herdr') await this.driver.stop('connector')
    else await this.driver.recoverConnector()
    if (this.stopping) return
    const waiting = new AbortController()
    this.recoveryWait = waiting
    try { await this.delay(this.policy.retryMs * this.state.restarts.length, undefined, { signal: waiting.signal }) }
    catch (error) { if (!this.stopping || !waiting.signal.aborted || error.name !== 'AbortError') throw error }
    finally { if (this.recoveryWait === waiting) this.recoveryWait = null }
    if (this.stopping) return
    await this.driver.validate()
    if (this.stopping) return
    if (component === 'herdr') {
      await this.driver.start('herdr'); await this.driver.waitReady('herdr')
      if (this.stopping) return
    }
    await this.driver.start('connector'); await this.driver.waitReady('connector')
    const current = await this.driver.connectorStatus()
    this.observedConnection = current?.state === 'online' ? 'online_snapshot' : current?.state || 'unverified'
  }
  async tick() {
    if (this.active) return this.active
    this.active = (async () => {
      const snapshotsOnly = this.state?.phase === 'needs_attention' && this.state.attention === 'herdr_observation_unknown' &&
        this.release && this.transfer && !this.state.handoff && !this.journalError && !this.cleanupError
      if (this.stopping || this.state?.phase !== 'running' && !snapshotsOnly) return this.snapshot()
      try {
        this.driver.checkPrograms?.()
        if (snapshotsOnly) {
          // The reviewed CLI alone selects already-admitted private bytes.
          // No source collection, normal advance, control recovery or task start.
          demand(JSON.stringify(await this.store.load()) === JSON.stringify(this.state), 'transfer_snapshot_host_state_changed')
          const transfer = await this.transfer.tick({ snapshotsOnly: true })
          if (transfer.attention) await this.attention(transfer.attention)
          return this.snapshot()
        }
        const previousConnection = this.observedConnection
        const s = await this.driver.connectorStatus()
        this.observedConnection = s?.state === 'online' ? 'online_snapshot' : s?.state || 'unverified'
        if (this.observedConnection === 'online_snapshot' && previousConnection !== 'online_snapshot') this.transfer?.hint('network')
        const reason = connectorAttention(s)
        if (reason) { await this.attention(reason); return this.snapshot() }
        if (!this.driver.alive('herdr')) await this.recover('herdr')
        else if (!this.driver.alive('connector')) await this.recover('connector')
        else {
          try {
            const host = await this.driver.ownedHostStatus()
            demand(host.running && host.version === (this.driver.herdrVersion || '0.9.5') && host.endpoint_compatible === true, 'herdr_observation_unknown')
          } catch (error) {
            // The owner may exit AFTER the alive check. Classify only that
            // proven transition; identity/generation/ownership errors remain
            // terminal even if the original child has since exited.
            const exited = error instanceof LifecycleError && ['herdr_observation_unknown', 'herdr_owner_exited'].includes(error.code) && this.driver.confirmedExit?.('herdr') === true
            if (!exited) throw error
            if (!this.stopping) await this.recover('herdr')
          }
        }
        if (!this.stopping && this.state.phase === 'running' && this.transfer) {
          const transfer = await this.transfer.tick()
          if (transfer.attention) await this.attention(transfer.attention)
        }
      } catch (error) {
        try { await this.attention(code(error)) } catch { throw error }
      }
      return this.snapshot()
    })()
    try { return await this.active } finally { this.active = null }
  }
  async recheckHerdr({ validateConfiguration = async () => {} } = {}) {
    demand(!this.active && !this.starting && !this.stopping && this.release, 'herdr_recheck_busy')
    this.active = (async () => {
      const expected = structuredClone(this.state)
      demand(expected?.phase === 'needs_attention' && expected.attention === 'herdr_observation_unknown' && !expected.handoff && !this.journalError && !this.cleanupError,
        'herdr_recheck_not_eligible')
      demand(!this.transfer?.snapshot().attention && this.driver.alive('herdr') && this.driver.alive('connector') && typeof this.driver.ownedGeneration === 'function' && typeof this.driver.ownedHostRequest === 'function', 'herdr_recheck_not_eligible')
      this.driver.checkPrograms?.()
      const generation = await this.driver.ownedGeneration()
      const host = await this.driver.ownedHostStatus()
      demand(host.running === true && host.version === (this.driver.herdrVersion || '0.9.5') && host.endpoint_compatible === true, 'herdr_observation_unknown')
      const peer = await this.driver.ownedHostRequest('ping')
      demand(peer.type === 'pong' && peer.version === (this.driver.herdrVersion || '0.9.5'), 'herdr_ownership_unverified')
      demand(!connectorAttention(await this.driver.connectorStatus()), 'herdr_recheck_connector_unverified')
      demand(await this.driver.ownedGeneration() === generation && this.driver.alive('connector') && !this.stopping, 'herdr_recheck_owner_changed')
      this.driver.checkPrograms?.()
      await validateConfiguration()
      demand(!this.stopping, 'herdr_recheck_owner_changed')
      demand(JSON.stringify(this.state) === JSON.stringify(expected), 'herdr_recheck_state_changed')
      const next = { ...expected, phase: 'running', attention: null }
      try { await this.store.recheckObservation(expected, next) }
      catch (error) { this.journalError = error; throw new LifecycleError(error.code === 'herdr_recheck_state_changed' ? error.code : 'herdr_recheck_persistence_unknown') }
      this.state = next
      return this.snapshot() // Normal later tick, not this command, may advance files.
    })()
    try { return await this.active } finally { this.active = null }
  }
  async stop() {
    this.stopping = true
    this.recoveryWait?.abort()
    this.transfer?.requestStop()
    if (this.closing) return this.closing
    this.closing = this.stopOwned()
    try { return await this.closing } finally { this.closing = null }
  }
  transferHint(kind) {
    if (!this.stopping && this.release && this.state?.phase === 'running') this.transfer?.hint(kind)
  }
  async stopOwned() {
    let firstError
    if (this.starting) await this.starting.catch(() => {})
    if (this.active) {
      try { await this.active } catch (error) { firstError = error }
    }
    if (!this.release) { if (firstError) throw firstError; return this.snapshot() }
    if (this.state) {
      this.state.phase = 'stopping'
      try { await this.save() } catch (error) { firstError ??= error }
    }
    // All owned components are attempted independently of journal availability
    // and of another component's stop failure. NativeDriver never kills by PID.
    try { await this.cleanupOwned() } catch (error) { firstError ??= error }
    if (this.cleanupError) {
      if (this.state) {
        try { await this.attention(code(this.cleanupError)) } catch (error) { firstError ??= error }
      }
      // Keep the OS lease while any owned-child outcome is uncertain.
    } else {
      this.observedConnection = 'stopped'
      if (this.state) {
        if (!firstError && this.driver.captureContinuation) {
          try {
            const checkpoint = await this.driver.captureContinuation()
            if (checkpoint) this.state.sessionContinuation = checkpoint
          } catch { firstError = new LifecycleError('session_continuation_unavailable') }
        }
        this.state.phase = 'stopped'
        if (firstError) this.state.attention = code(firstError)
        try { await this.save() } catch (error) { firstError ??= error; this.state.attention = code(firstError) }
      }
      try { await this.release(); this.release = null } catch (error) { firstError ??= error }
    }
    if (firstError) throw firstError
    return this.snapshot()
  }
  async run(signal) {
    demand(this.release && this.state?.phase === 'running', 'lifecycle_not_started')
    let firstError
    try {
      while (!signal.aborted && this.release) {
        await this.tick()
        await this.delay(1000)
      }
    } catch (error) { firstError = error }
    finally { try { await this.stop() } catch (error) { firstError ??= error } }
    if (firstError) throw firstError
    return this.snapshot()
  }
}

export function leaseKeys(config) {
  return [`device:${config.deviceId}`, `herdr:${config.herdrConfigRoot}:${config.session}`, `connector:${isNativeRuntimeConfig(config) ? connectorConfigReference(config) : config.agenvoConfigDir}`,
    ...(config.transferStateDir || [2, 3].includes(config.schema) && config.transfer ? [`transfer:${[2, 3].includes(config.schema) ? transferLocations(config).state : config.transferStateDir}`] : [])]
}
