import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'
import { catalog, managedEnvironment } from './endpoint.mjs'

// Internal foreground lifecycle. No business dispatch, transfer implementation,
// network service, OS startup registration, credential editing or second watchdog.
export class LifecycleError extends Error {
  constructor(code) { super(code); this.code = code }
}
function demand(ok, code) { if (!ok) throw new LifecycleError(code) }
function code(error) { return error instanceof LifecycleError ? error.code : 'lifecycle_operation_failed' }
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
  constructor(directory, identity) { this.directory = directory; this.identity = identity; this.file = path.join(directory, 'lifecycle.json') }
  async load() {
    demand(path.isAbsolute(this.directory) && await fs.realpath(this.directory) === this.directory, 'canonical_state_root_required')
    let data
    try { data = await readJSON(this.file) } catch (e) { if (e.code !== 'ENOENT') throw new LifecycleError('lifecycle_state_unreadable') }
    if (!data) return { schema: 1, identity: this.identity, phase: 'stopped', restarts: [], attention: null }
    demand(data.schema === 1 && data.identity === this.identity && Array.isArray(data.restarts) && data.restarts.length <= 100 && data.restarts.every(t => Number.isSafeInteger(t) && t >= 0), 'lifecycle_state_mismatch')
    demand(['stopped', 'starting', 'running', 'stopping', 'needs_attention'].includes(data.phase) && (data.attention === null || /^[a-z_]{1,80}$/.test(data.attention)), 'lifecycle_state_mismatch')
    return data
  }
  async save(data) {
    // Only this coordinator's small journal; never official session/queue files.
    try { await readFile(this.file) } catch (e) { if (e.code !== 'ENOENT') throw e }
    const temporary = path.join(this.directory, `.lifecycle-${randomUUID()}.tmp`)
    const h = await fs.open(temporary, 'wx')
    try { await h.writeFile(`${JSON.stringify(data)}\n`); await h.sync() } finally { await h.close() }
    await fs.rename(temporary, this.file)
  }
}

export class NativeDriver {
  constructor(config, { qualify, inheritedEnvironment = process.env } = {}) {
    this.config = config
    this.qualify = qualify
    // Environment is fully cleaned by the shared product function, not the plan
    // overlay. Extra environment injection is not exposed to product callers.
    this.env = managedEnvironment(config, inheritedEnvironment)
    this.children = new Map()
    this.node = path.join(config.bundleRoot, catalog.components.node.entry)
    this.herdr = path.join(config.bundleRoot, catalog.components.herdr.entry)
    this.connector = path.join(config.bundleRoot, catalog.components.connector.entry)
    this.fingerprint = null
    this.marker = config.session === 'default' ? path.join(config.herdrConfigRoot, 'herdr.sock') : path.join(config.herdrConfigRoot, 'sessions', config.session, 'herdr.sock')
  }
  async validate() {
    demand(process.platform === 'win32' && process.arch === 'x64' && typeof this.qualify === 'function', 'qualified_windows_driver_required')
    demand(await this.qualify() === true, 'component_qualification_failed')
    let credentials
    try { credentials = await fs.lstat(path.join(this.config.agenvoConfigDir, 'credentials.json')) }
    catch (e) { throw new LifecycleError(e.code === 'ENOENT' ? 'connector_authentication_required' : 'connector_credentials_unreadable') }
    demand(credentials.isFile() && !credentials.isSymbolicLink() && credentials.nlink === 1, 'connector_credentials_unreadable')
    const host = await readFile(path.join(this.config.herdrConfigRoot, 'config.toml'))
    const connector = await readFile(path.join(this.config.agenvoConfigDir, 'config.json'))
    const sum = createHash('sha256').update(host).update('\0').update(connector).digest('hex')
    demand(!this.fingerprint || this.fingerprint === sum, 'official_configuration_changed')
    this.fingerprint = sum
  }
  command(file, args, timeout = 10000) {
    const r = spawnSync(file, args, { env: this.env, cwd: this.config.sourceRoot, encoding: 'utf8', timeout, maxBuffer: 16384, windowsHide: true, shell: false })
    demand(!r.error && r.status === 0, 'official_command_failed')
    return r.stdout
  }
  hostStatus() {
    let value
    try { value = JSON.parse(this.command(this.herdr, ['--session', this.config.session, 'status', 'server', '--json'], 3000)) }
    catch { throw new LifecycleError('herdr_observation_unknown') }
    demand(typeof value.running === 'boolean', 'herdr_observation_unknown')
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
      throw new LifecycleError(/^herdr_(owner_mismatch|generation_changed|ownership_unverified|request_(rejected|timeout|incomplete|oversized|failed))$/.test(reason) ? reason : 'herdr_ownership_unverified')
    }
    demand(response.id === 'endpoint-owned' && response.result && !response.error, 'herdr_request_failed')
    return response.result
  }
  async ownedHostStatus() {
    await this.ownedGeneration()
    const status = this.hostStatus() // read-only; generation checked on both sides
    await this.ownedGeneration()
    return status
  }
  alive(component) { const c = this.children.get(component); return Boolean(c && !c.exited && !c.error) }
  async start(component) {
    demand(!this.alive(component), 'component_already_owned')
    if (component === 'herdr') demand(!this.hostStatus().running, 'existing_herdr_requires_handoff')
    if (component === 'connector') {
      try { await fs.lstat(path.join(this.config.agenvoConfigDir, 'run.lock')); throw new LifecycleError('connector_lock_requires_owner') }
      catch (e) { if (e.code !== 'ENOENT') throw e }
    }
    const file = component === 'herdr' ? this.herdr : this.node
    const args = component === 'herdr' ? ['--session', this.config.session, 'server'] : [this.connector, 'run']
    const processHandle = spawn(file, args, { env: this.env, cwd: this.config.sourceRoot, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    const c = { process: processHandle, startedAt: Date.now(), exited: false, error: false, lock: null }
    c.done = new Promise(resolve => {
      processHandle.once('exit', () => { c.exited = true; resolve() })
      processHandle.once('error', () => { c.error = true; c.exited = true; resolve() })
    })
    processHandle.stdout.resume()
    processHandle.stderr.resume()
    this.children.set(component, c)
  }
  async connectorStatus() {
    const c = this.children.get('connector')
    if (!c) return null
    let s
    try { s = await readJSON(path.join(this.config.agenvoConfigDir, 'status.json')) } catch { return null }
    if (s.pid !== c.process.pid || s.deviceId !== this.config.deviceId || s.version !== '0.2.0' || !Number.isSafeInteger(s.updatedAt) || s.updatedAt < c.startedAt || s.updatedAt > Date.now() + 1000) return null
    if (!['connecting', 'authenticating', 'online', 'offline', 'stopped', 'needs_attention'].includes(s.state)) return null
    if (!c.lock) {
      try {
        const lock = await readJSON(path.join(this.config.agenvoConfigDir, 'run.lock'))
        if (lock.pid === c.process.pid && typeof lock.nonce === 'string') c.lock = lock
      } catch { /* No ownership proof means no later lock recovery. */ }
    }
    return s
  }
  async waitReady(component, timeout = 30000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      demand(this.alive(component), `${component}_startup_exited`)
      if (component === 'herdr') {
        try {
          const s = this.hostStatus()
          if (s.running && s.version === '0.9.5' && s.endpoint_compatible === true) {
            await this.ownedGeneration(true)
            const owned = await this.ownedHostRequest('ping')
            demand(owned.type === 'pong' && owned.version === '0.9.5', 'herdr_ownership_unverified')
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
  async recoverConnectorLock() {
    const c = this.children.get('connector')
    let lock
    try { lock = await readJSON(path.join(this.config.agenvoConfigDir, 'run.lock')) }
    catch (e) { if (e.code === 'ENOENT') return; throw new LifecycleError('connector_lock_requires_owner') }
    demand(c?.exited && c.lock && lock.pid === c.process.pid && lock.nonce === c.lock.nonce, 'connector_lock_requires_owner')
    // Official recovery only after this exact owned process has exited and the
    // saved lock nonce still matches. No direct unlink or PID-based termination.
    try { await promisify(execFile)(this.node, [this.connector, 'doctor', '--recover-lock'], { env: this.env, cwd: this.config.sourceRoot, timeout: 12000, maxBuffer: 16384, windowsHide: true, shell: false }) }
    catch { throw new LifecycleError('connector_lock_recovery_failed') }
    try { await fs.lstat(path.join(this.config.agenvoConfigDir, 'run.lock')); throw new LifecycleError('connector_lock_requires_owner') }
    catch (e) { if (e.code !== 'ENOENT') throw e }
  }
  async stop(component) {
    const c = this.children.get(component)
    if (!c) return
    if (this.alive(component)) {
      if (component === 'herdr') {
        await this.ownedHostRequest('server.stop')
      } else {
        // Windows Node kill terminates this owned child; it does not guarantee
        // POSIX SIGTERM callbacks. Recover only its proven stale official lock.
        c.process.kill()
      }
      const timer = new AbortController()
      try {
        await Promise.race([c.done, sleep(10000, undefined, { signal: timer.signal }).then(() => { throw new LifecycleError(`${component}_stop_unknown`) })])
      } finally { timer.abort() }
    }
    if (component === 'connector') await this.recoverConnectorLock()
  }
}

export class EndpointLifecycle {
  constructor({ driver, store, acquire, clock = Date.now, delay = sleep, policy = {} }) {
    this.driver = driver; this.store = store; this.acquire = acquire
    this.clock = clock; this.delay = delay
    this.policy = { maxRestarts: 3, windowMs: 600000, retryMs: 1000, ...policy }
    this.active = null; this.stopping = false; this.release = null
    this.observedConnection = 'unverified'
  }
  snapshot() {
    return { schema: 1, phase: this.state?.phase || 'stopped', attention: this.state?.attention || null, restartsInWindow: this.state?.restarts.length || 0, ready: false,
      journal: this.journalError ? 'unavailable' : this.state ? 'observed' : 'unverified', cleanupAttention: this.cleanupError ? code(this.cleanupError) : null,
      connection: this.observedConnection, agent: 'official_restore_semantics_retained', desktop: 'interactive_session_unverified', transfer: 'lifecycle_interface_pending',
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
      await this.driver.validate()
      demand(!this.driver.hostStatus().running, 'existing_herdr_requires_handoff')
      demand(!this.stopping, 'startup_cancelled')
      this.state.phase = 'starting'; await this.save()
      await this.driver.start('herdr'); await this.driver.waitReady('herdr')
      demand(!this.stopping, 'startup_cancelled')
      await this.driver.start('connector'); await this.driver.waitReady('connector')
      demand(!this.stopping, 'startup_cancelled')
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
    else await this.driver.recoverConnectorLock()
    await this.delay(this.policy.retryMs * this.state.restarts.length)
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
      if (this.stopping || this.state?.phase !== 'running') return this.snapshot()
      try {
        const s = await this.driver.connectorStatus()
        this.observedConnection = s?.state === 'online' ? 'online_snapshot' : s?.state || 'unverified'
        const reason = connectorAttention(s)
        if (reason) { await this.attention(reason); return this.snapshot() }
        if (!this.driver.alive('herdr')) await this.recover('herdr')
        else if (!this.driver.alive('connector')) await this.recover('connector')
        else {
          const host = await this.driver.ownedHostStatus()
          demand(host.running && host.version === '0.9.5' && host.endpoint_compatible === true, 'herdr_observation_unknown')
        }
      } catch (error) {
        try { await this.attention(code(error)) } catch { throw error }
      }
      return this.snapshot()
    })()
    try { return await this.active } finally { this.active = null }
  }
  async stop() {
    this.stopping = true
    if (this.closing) return this.closing
    this.closing = this.stopOwned()
    try { return await this.closing } finally { this.closing = null }
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
  return [`device:${config.deviceId}`, `herdr:${config.herdrConfigRoot}:${config.session}`, `connector:${config.agenvoConfigDir}`]
}
