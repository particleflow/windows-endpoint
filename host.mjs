import * as fs from 'node:fs/promises'
import { writeSync, fsyncSync } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { EndpointError, validateConfig, validateDirectory, verifyBundle, isNativeRuntimeConfig, connectorConfigReference } from './endpoint.mjs'
import { deploymentLayout, deploymentReferences, hostReferenceLayout } from './deployment.mjs'
import { acquireLeases, LifecycleError, StateStore } from './lifecycle.mjs'
import { createExplicitRuntime, validateRuntimeRequest, RuntimeError } from './runtime.mjs'
import { PiCatalogLifecycle } from './pi-catalog-lifecycle.mjs'

export class HostError extends Error {
  constructor(code) { super(code); this.code = code }
}
const safeCode = error => error instanceof HostError || error instanceof LifecycleError || error instanceof EndpointError || error instanceof RuntimeError ? error.code :
  ['EACCES', 'EPERM', 'EROFS'].includes(error?.code) ? 'host_storage_permission_denied' : error?.code === 'ENOSPC' ? 'host_storage_full' : 'host_operation_failed'
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const overlaps = (a, b) => [path.relative(a, b), path.relative(b, a)].some(r => r === '' || !path.isAbsolute(r) && r !== '..' && !r.startsWith(`..${path.sep}`))
async function regular(file, limit) {
  const st = await fs.lstat(file)
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > limit) throw new HostError('host_input_unsafe')
  return fs.readFile(file, 'utf8')
}
async function ensureDirectory(directory) {
  try { await fs.mkdir(directory) } catch (error) { if (error.code !== 'EEXIST') throw error }
  await validateDirectory(directory)
}
const stamp = raw => raw === null ? null : createHash('sha256').update(raw).digest('hex')
function validatedStatus(value) {
  const fields = ['schema', 'owner', 'runId', 'pid', 'updatedAt', 'phase', 'health', 'attention', 'configuration', 'components', 'connection', 'componentLifecycle', 'transfer', 'evidence', 'ready', 'desktop', 'agent', 'transferAutomaticRecovery', 'log']
  // Earlier schema-1 observations lack control availability. Accept that exact
  // older shape as unknown, without inferring an open channel from a live PID.
  if (value && Object.hasOwn(value, 'control')) fields.push('control')
  const code = item => item === null || typeof item === 'string' && /^[a-z_]{1,80}$/.test(item)
  const objectFields = (item, names) => item && typeof item === 'object' && Object.keys(item).sort().join(',') === names.sort().join(',')
  const invalid = () => { throw new HostError('host_status_invalid') }
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== fields.sort().join(',') || value.schema !== 1 || value.owner !== 'windows-endpoint-host' || !Number.isSafeInteger(value.updatedAt) || value.ready !== false || value.transferAutomaticRecovery !== false) invalid()
  if (!/^[a-f0-9-]{36}$/.test(value.runId) || !Number.isSafeInteger(value.pid) || value.pid < 1 || !['starting', 'running', 'stopping', 'stopped', 'failed', 'stop_failed'].includes(value.phase) || !['needs_attention', 'blocked', 'observed_fixture', 'observed_components'].includes(value.health) || !code(value.attention)) invalid()
  if (!['unverified', 'missing', 'loaded', 'invalid', 'changed_restart_required'].includes(value.configuration) || !['unavailable_unqualified', 'unavailable_missing', 'unavailable_invalid', 'synthetic_fixture', 'verified_local'].includes(value.components) || !['unverified', 'authorization_unverified', 'authorization_required', 'online_snapshot', 'offline', 'connecting', 'authenticating', 'stopped', 'needs_attention', 'recovering'].includes(value.connection)) invalid()
  if (!['host_process_only', 'synthetic_components', 'native_components'].includes(value.evidence) || value.desktop !== 'unavailable' || value.agent !== 'unavailable_unqualified' || !['unverified', 'recording', 'capacity_reached'].includes(value.log)) invalid()
  if (Object.hasOwn(value, 'control') && !['unverified', 'stdin_open', 'stdin_closed'].includes(value.control)) invalid()
  if (value.componentLifecycle !== null) {
    const c = value.componentLifecycle
    if (!objectFields(c, ['phase', 'attention', 'cleanupAttention', 'journal', 'restartsInWindow']) || !['stopped', 'starting', 'running', 'stopping', 'needs_attention'].includes(c.phase) || !code(c.attention) || !code(c.cleanupAttention) || !['unavailable', 'observed', 'unverified'].includes(c.journal) || !Number.isSafeInteger(c.restartsInWindow) || c.restartsInWindow < 0 || c.restartsInWindow > 100) invalid()
  }
  if (value.transfer !== 'not_included_pending_qualification' && (!objectFields(value.transfer, ['state', 'attention', 'active']) || !['stopped', 'unverified', 'due', 'idle', 'waiting', 'needs_attention', 'retry_hint'].includes(value.transfer.state) || !code(value.transfer.attention) || typeof value.transfer.active !== 'boolean')) invalid()
  return value
}

export class ForegroundHost {
  constructor({ root, emit = () => {}, createTestRuntime = null, inheritedHostLease = null, piCatalogBinding = null }) {
    this.root = root; this.layout = deploymentLayout(root)
    this.stateDirectory = path.join(this.layout.data, 'endpoint')
    this.statusFile = path.join(this.stateDirectory, 'host-status.json')
    this.logDirectory = path.join(this.layout.logs, 'endpoint-host')
    this.configFile = path.join(this.layout.config, 'endpoint.json')
    this.runtimeFile = path.join(this.layout.config, 'runtime.json')
    this.emit = emit; this.createTestRuntime = createTestRuntime
    this.inheritedHostLease = inheritedHostLease
    this.piCatalogBinding = piCatalogBinding; this.piCatalog = null
    this.runId = randomUUID(); this.phase = 'starting'; this.attention = null
    this.stopReason = null; this.control = 'unverified'
    this.stopTrigger = null; this.fatalOrigin = null; this.fatalType = null
    this.configuration = 'unverified'; this.components = 'unavailable_unqualified'; this.connection = 'unverified'
    this.release = null; this.runtime = null; this.stopRequested = false
    this.active = null; this.starting = null; this.closing = null; this.publishing = null
    this.logBytes = 0; this.logState = 'unverified'; this.lastEvent = null; this.initialized = false
  }
  logLine(event) { return `${JSON.stringify({ schema: 1, runId: this.runId, at: Date.now(), ...event })}\n` }
  componentDiagnostics() { return this.runtime?.driver?.diagnostics?.() || [] }
  async logEvent(event, terminal = false) {
    const line = this.logLine(event), bytes = Buffer.byteLength(line)
    // Keep room for the final result even when ordinary state-change logging
    // reaches its existing per-run cap. No deletion or retention policy added.
    if (this.logBytes + bytes > 65536 - (terminal ? 0 : 2048)) { this.logState = 'capacity_reached'; return }
    await this.logHandle.writeFile(line); await this.logHandle.sync(); this.logBytes += bytes
  }
  attachProcessDiagnostics() {
    this.onFatal = (_error, origin) => {
      this.fatalOrigin = origin === 'unhandledRejection' ? 'unhandled_rejection' : 'uncaught_exception'
      this.fatalType = 'Error'
      try { if (['TypeError', 'RangeError', 'SyntaxError', 'ReferenceError'].includes(_error?.name)) this.fatalType = _error.name } catch { /* Inspecting a thrown value must not replace the original failure. */ }
    }
    this.onProcessExit = exitCode => {
      this.piCatalog?.controller.abort()
      // Observation only: no catch/restart, lease release or component stop.
      // TerminateProcess/SIGKILL/power loss cannot run this hook.
      try {
        const line = this.logLine({ event: 'process_exit', exitCode, stopTrigger: this.stopTrigger,
          fatalOrigin: this.fatalOrigin, fatalType: this.fatalType, cleanup: 'not_confirmed_by_process_exit', components: this.componentDiagnostics() })
        if (this.logBytes + Buffer.byteLength(line) > 65536) return
        writeSync(this.logHandle.fd, line); fsyncSync(this.logHandle.fd)
      } catch { /* Diagnostic failure must not change the original exit. */ }
    }
    process.on('uncaughtExceptionMonitor', this.onFatal); process.on('exit', this.onProcessExit)
  }
  async closeLog() {
    process.off('uncaughtExceptionMonitor', this.onFatal); process.off('exit', this.onProcessExit)
    await this.logHandle?.close()
  }
  snapshot() {
    const runtime = this.runtime?.snapshot()
    // A later config observation must not replace a terminating input/I/O error.
    const attention = this.stopReason || this.attention || runtime?.attention || runtime?.cleanupAttention || null
    const connection = attention === 'connector_authentication_required' ? 'authorization_required' : runtime?.connection || this.connection
    return { schema: 1, owner: 'windows-endpoint-host', runId: this.runId, pid: process.pid, updatedAt: Date.now(),
      phase: this.phase, control: this.control, health: attention ? 'needs_attention' : this.configuration !== 'loaded' || !this.runtime ? 'blocked' : this.createTestRuntime ? 'observed_fixture' : 'observed_components',
      attention, configuration: this.configuration, components: this.components, connection,
      componentLifecycle: runtime ? { phase: runtime.phase, attention: runtime.attention, cleanupAttention: runtime.cleanupAttention, journal: runtime.journal, restartsInWindow: runtime.restartsInWindow } : null,
      transfer: runtime?.transfer && typeof runtime.transfer === 'object' ? { state: runtime.transfer.state, attention: runtime.transfer.attention, active: runtime.transfer.active } : 'not_included_pending_qualification',
      evidence: this.createTestRuntime ? 'synthetic_components' : this.components === 'verified_local' ? 'native_components' : 'host_process_only',
      ready: false, desktop: 'unavailable', agent: 'unavailable_unqualified', transferAutomaticRecovery: false, log: this.logState }
  }
  async configRaw(file = this.configFile) {
    try {
      await validateDirectory(this.layout.config)
      return await regular(file, 65536)
    } catch (error) { if (error.code === 'ENOENT') return null; throw error }
  }
  publish() {
    if (this.publishing) return this.publishing
    const operation = (async () => {
      const snapshot = validatedStatus(this.snapshot())
      if (!this.initialized) { this.emit(snapshot); return }
      try {
        validatedStatus(JSON.parse(await regular(this.statusFile, 32768)))
      } catch (error) { if (error.code !== 'ENOENT') throw error }
      const temporary = path.join(this.stateDirectory, `.host-status-${randomUUID()}.tmp`)
      const handle = await fs.open(temporary, 'wx')
      try { await handle.writeFile(`${JSON.stringify(snapshot)}\n`); await handle.sync() } finally { await handle.close() }
      await fs.rename(temporary, this.statusFile)
      const event = JSON.stringify({ phase: snapshot.phase, control: snapshot.control, health: snapshot.health, attention: snapshot.attention, configuration: snapshot.configuration, components: snapshot.components, connection: snapshot.connection,
        componentPhase: snapshot.componentLifecycle?.phase || null, restarts: snapshot.componentLifecycle?.restartsInWindow || 0, transferState: snapshot.transfer?.state || null,
        stopTrigger: this.stopTrigger, componentDiagnostics: this.componentDiagnostics() })
      if (event !== this.lastEvent) {
        await this.logEvent(JSON.parse(event))
        this.lastEvent = event
        this.emit(this.snapshot())
      }
    })()
    this.publishing = operation
    operation.then(() => { this.publishing = null }, () => { this.publishing = null })
    return operation
  }
  async start() {
    this.starting = this.startOwned()
    try { await this.starting } finally { this.starting = null }
  }
  async startOwned() {
    await validateDirectory(this.root)
    await ensureDirectory(this.layout.data); await ensureDirectory(this.stateDirectory)
    await ensureDirectory(this.layout.logs); await ensureDirectory(this.logDirectory)
    this.release = this.inheritedHostLease || await acquireLeases([`host:${this.root}`], this.stateDirectory)
    this.logHandle = await fs.open(path.join(this.logDirectory, `${this.runId}.jsonl`), 'ax')
    this.attachProcessDiagnostics()
    this.logState = 'recording'; this.initialized = true
    await this.publish()
    try {
      const raw = await this.configRaw()
      this.configStamp = stamp(raw)
      if (raw === null) { this.configuration = 'missing'; this.attention = 'host_configuration_missing' }
      else {
        let config
        try { config = validateConfig(JSON.parse(raw)) } catch { throw new HostError('host_configuration_invalid') }
        if (config.schema === 1) {
          const expected = deploymentReferences(this.root, { manifestSha256: config.manifestSha256, nasOrigin: config.nasOrigin, deviceId: config.deviceId, runtimeId: config.runtimeId, instanceId: config.instanceId, session: config.session })
          for (const key of ['sourceRoot', 'herdrConfigRoot', 'herdrStateRoot', 'agenvoConfigDir', 'piConfigDir', 'transferConfigDir', 'transferStateDir']) {
            if (!samePath(config[key], expected[key])) throw new HostError('host_configuration_root_mismatch')
          }
        } else {
          if (!hostReferenceLayout(this.root, config).compatible) throw new HostError('host_reference_overlap')
        }
        this.configuration = 'loaded'
        const runtimeRaw = await this.configRaw(this.runtimeFile)
        this.runtimeStamp = stamp(runtimeRaw)
        let request = null
        if (runtimeRaw !== null) {
          try { request = validateRuntimeRequest(JSON.parse(runtimeRaw), config) }
          catch (error) { throw error instanceof RuntimeError ? error : new RuntimeError('runtime_request_invalid') }
        }
        await this.observeAuthorization(config)
        const previous = await new StateStore(this.stateDirectory, config.deviceId).load()
        const recheckInstallation = Boolean(request) && [2, 3].includes(config.schema) && previous.phase === 'stopped' && previous.attention === 'installation_changed_restart_required'
        if (previous.handoff) this.attention = 'host_handoff_unverified'
        else if (previous.attention && !recheckInstallation) this.attention = previous.attention
        else if (previous.phase !== 'stopped') this.attention = 'host_previous_runtime_uncertain'
        if (config.schema === 1) {
          try { await verifyBundle(config.bundleRoot, config.manifestSha256) }
          catch (error) { this.components = error.code === 'ENOENT' ? 'unavailable_missing' : 'unavailable_invalid' }
        }
        // Test injection remains confined to the separate source fixture.
        if (this.createTestRuntime && !this.stopRequested && !this.attention) {
          this.runtime = await this.createTestRuntime({ config, stateDirectory: this.stateDirectory })
          if (!this.stopRequested) { await this.runtime.start(); this.components = 'synthetic_fixture' }
        } else if (request && !this.stopRequested && !this.attention) {
          this.runtime = await createExplicitRuntime({ config, stateDirectory: this.stateDirectory, request })
          if ([2, 3].includes(config.schema) && [this.layout.config, this.layout.data, this.layout.logs].some(owned => overlaps(owned, this.runtime.driver.herdr))) throw new HostError('host_reference_overlap')
          if (!this.stopRequested) {
            await this.runtime.start({ acknowledgeAttention: recheckInstallation })
            if (!this.stopRequested) this.components = 'verified_local'
          }
        }
        if (this.runtime && !this.stopRequested && !this.attention && this.piCatalogBinding) {
          this.piCatalog = new PiCatalogLifecycle({ ...this.piCatalogBinding, config })
          void this.piCatalog.tick()
        }
      }
    } catch (error) {
      if (!(this.stopRequested && error instanceof LifecycleError && error.code === 'startup_cancelled')) this.attention = safeCode(error)
      if (this.configuration !== 'loaded') this.configuration = 'invalid'
    }
    if (!this.stopRequested) this.phase = 'running'
    await this.publish()
  }
  async observeAuthorization(config) {
    if (!isNativeRuntimeConfig(config)) return // Old references are history only.
    try {
      const st = await fs.lstat(connectorConfigReference(config))
      this.connection = st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size > 0 && st.size <= 65536 ? 'authorization_unverified' : 'authorization_required'
    } catch (error) { this.connection = error.code === 'ENOENT' ? 'authorization_required' : 'authorization_unverified' }
    // Metadata is not authenticated identity; the official Runtime owns loading.
  }
  async tick() {
    if (this.active) return this.active
    this.active = (async () => {
      if (this.stopRequested || this.phase !== 'running') return
      const raw = await this.configRaw()
      const runtimeRaw = await this.configRaw(this.runtimeFile)
      if (stamp(raw) !== this.configStamp || this.configuration === 'loaded' && stamp(runtimeRaw) !== this.runtimeStamp) {
        this.configuration = 'changed_restart_required'; this.attention = 'host_configuration_changed'
        if (this.runtime?.state && !this.runtime.state.attention) await this.runtime.attention('host_configuration_changed')
      }
      if (this.configuration === 'loaded' && !this.attention && this.runtime) {
        await this.runtime.tick()
        if (this.piCatalog) void this.piCatalog.tick()
      } else if (this.piCatalog) await this.piCatalog.stop()
    })()
    try { await this.active } finally { this.active = null }
  }
  async stop(reason = null) {
    this.stopRequested = true
    const catalogStop = this.piCatalog?.stop()
    if (reason) this.stopReason ||= reason
    if (this.closing) return this.closing
    this.closing = this.stopOwned()
    try { await catalogStop; return await this.closing } finally { this.closing = null }
  }
  async stopOwned() {
    this.phase = 'stopping'
    // Signal the existing lifecycle immediately so startup/advance cannot issue
    // replacements while we await it. Its stop preserves in-flight outcomes.
    const runtimeStop = this.runtime?.stop()
    const stopped = runtimeStop?.then(() => null, error => error)
    if (this.publishing) await this.publishing.catch(() => {})
    try { await this.publish() } catch { this.attention ||= 'host_observation_write_failed' }
    if (this.starting) await this.starting.catch(error => { this.attention ||= safeCode(error) })
    if (this.active) await this.active.catch(error => { this.attention ||= safeCode(error) })
    const failure = await stopped
    if (failure) this.attention ||= safeCode(failure)
    if (this.runtime?.release) {
      this.phase = 'stop_failed'; this.attention ||= 'host_cleanup_requires_attention'
      try { await this.publish() }
      catch { this.emit(this.snapshot()) } // Observer failure must not abandon ownership; stdin may already be closed.
      return false // Retain ownership. Retry through stdin is possible only while it remains open.
    }
    this.phase = failure ? 'failed' : 'stopped'
    let publicationFailure
    if (this.publishing) await this.publishing.catch(() => {})
    try { await this.publish() } catch (error) { publicationFailure = error; this.attention ||= 'host_observation_write_failed'; this.emit(this.snapshot()) }
    try {
      if (this.logHandle) {
        const attention = this.snapshot().attention
        try { await this.logEvent({ event: 'foreground_result', returnCode: publicationFailure || attention && attention !== 'host_configuration_missing' ? 2 : 0,
          stopTrigger: this.stopTrigger, phase: this.phase, attention, components: this.componentDiagnostics() }, true) }
        finally { await this.closeLog() }
      }
    } finally { if (this.release) { await this.release(); this.release = null } }
    if (publicationFailure) throw new HostError('host_observation_write_failed')
    return true
  }
}

export async function readHostStatus(root) {
  const layout = deploymentLayout(root)
  await validateDirectory(root)
  const directory = path.join(layout.data, 'endpoint')
  await validateDirectory(directory)
  const value = validatedStatus(JSON.parse(await regular(path.join(directory, 'host-status.json'), 32768)))
  const age = Date.now() - value.updatedAt
  // Cached disk data never proves a process or a PC capability is alive.
  return { ...value, control: value.control ?? 'unverified', observation: age < 0 || age > 5000 ? 'stale_unknown' : 'cached', ready: false, transferAutomaticRecovery: false }
}

export async function runForeground({ root, input = process.stdin, output = process.stdout, createTestRuntime = null, inheritedHostLease = null, piCatalogBinding = null, tickMs = 1000 }) {
  let resolveDone, stopping = false, timer, buffer = '', commandBusy = false
  const done = new Promise(resolve => { resolveDone = resolve })
  const emit = value => {
    if (output.writableLength > 65536) { if (!host.stopRequested) void stop('host_observer_backpressure', 'observer_backpressure'); return }
    if (!output.destroyed && output.writable) output.write(`${JSON.stringify(value)}\n`)
  }
  const host = new ForegroundHost({ root, emit, createTestRuntime, inheritedHostLease, piCatalogBinding })
  host.control = input.readableEnded || input.destroyed ? 'stdin_closed' : 'stdin_open'
  const stop = async (reason, trigger = 'stop_command') => {
    host.stopTrigger ||= trigger
    // Capture an error even when an earlier clean stop is already draining.
    if (reason) host.stopReason ||= reason
    if (stopping) return
    stopping = true
    try {
      if (await host.stop(reason)) { clearInterval(timer); const attention = host.snapshot().attention; resolveDone(attention && attention !== 'host_configuration_missing' ? 2 : 0) }
      else stopping = false
    } catch {
      emit({ error: 'host_shutdown_failed', ready: false })
      if (host.runtime?.release) stopping = false
      else { clearInterval(timer); resolveDone(2) }
    }
  }
  const sigint = () => { void stop(null, 'sigint') }, sigterm = () => { void stop(null, 'sigterm') }
  const onData = chunk => {
    buffer += chunk.toString('utf8')
    if (Buffer.byteLength(buffer) > 1024) { buffer = ''; void stop('host_control_input_invalid', 'invalid_input'); return }
    const lines = buffer.split('\n'); buffer = lines.pop()
    for (const line of lines) {
      let value
      try { value = JSON.parse(line) } catch { void stop('host_control_input_invalid', 'invalid_input'); return }
      if (!value || Object.keys(value).length !== 1 || !['status', 'stop'].includes(value.action)) { void stop('host_control_input_invalid', 'invalid_input'); return }
      if (value.action === 'stop') void stop()
      else if (!commandBusy) { commandBusy = true; emit(host.snapshot()); setImmediate(() => { commandBusy = false }) }
    }
  }
  const onEnd = () => { host.control = 'stdin_closed'; void stop(buffer.trim() ? 'host_control_input_invalid' : null, 'stdin_eof') }
  const onOutputError = () => { if (!host.stopRequested) void stop('host_observer_disconnected', 'observer_disconnected') }
  input.on('data', onData); input.once('end', onEnd); output.on('error', onOutputError)
  process.on('SIGINT', sigint); process.on('SIGTERM', sigterm)
  try {
    try { await host.start() }
    catch (error) { await stop(safeCode(error), 'startup_failed') }
    if (!host.stopRequested) {
      timer = setInterval(() => {
        void host.tick().catch(() => stop('host_lifecycle_failed', 'tick_failed'))
        void host.publish().catch(() => { if (!host.stopRequested) return stop('host_observation_write_failed', 'status_write_failed') })
      }, tickMs)
    }
    return await done
  } finally {
    clearInterval(timer)
    input.off('data', onData); input.off('end', onEnd); input.pause()
    output.off('error', onOutputError)
    process.off('SIGINT', sigint); process.off('SIGTERM', sigterm)
  }
}

export async function readHostHandoff(root, requestId) {
  const layout = deploymentLayout(root)
  await validateDirectory(root); await validateDirectory(layout.config)
  const config = validateConfig(JSON.parse(await regular(path.join(layout.config, 'endpoint.json'), 65536)))
  return new StateStore(path.join(layout.data, 'endpoint'), config.deviceId).handoffStatus(requestId)
}

export async function hostMain(args) {
  const [command, option, root, ...extra] = args
  if (command === 'recover') {
    const { recoveryMain } = await import('./host-recovery.mjs')
    try { process.stdout.write(`${JSON.stringify(await recoveryMain(args.slice(1)))}\n`); return 0 }
    catch (error) {
      const code = error.code?.startsWith('host_recovery_') ? error.code : safeCode(error)
      const stage = ['file_owner','process_inventory','process_absence','not_observed'].includes(error.evidenceStage) ? error.evidenceStage : undefined
      const processReason = ['original_host_pid_present','process_identity_unknown','original_process_reference','process_ancestry_unknown_or_related','process_scope_unknown'].includes(error.processReason) ? error.processReason : undefined
      const b=error.blockingProcess
      const blockingProcess=Number.isSafeInteger(b?.pid) && ['other','unknown','herdr','pi','node','connector'].includes(b?.role) ? b : undefined
      process.stderr.write(`${JSON.stringify({error: code, stage, processReason, blockingProcess})}\n`); return 2
    }
  }
  if (command === 'handoff-status' && option === '--root' && typeof root === 'string' && extra.length === 2 && extra[0] === '--request-id') {
    try { process.stdout.write(`${JSON.stringify(await readHostHandoff(root, extra[1]))}\n`); return 0 }
    catch (error) { throw new HostError(error.code?.startsWith('handoff_') ? error.code : safeCode(error)) }
  }
  if (!['run', 'status'].includes(command) || option !== '--root' || typeof root !== 'string' || extra.length) throw new HostError('host_arguments_invalid')
  if (command === 'run') return runForeground({ root })
  process.stdout.write(`${JSON.stringify(await readHostStatus(root))}\n`)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await hostMain(process.argv.slice(2)) }
  catch (error) { process.stderr.write(`${JSON.stringify({ error: safeCode(error), ready: false })}\n`); process.exitCode = 2 }
}
