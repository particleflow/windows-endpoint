// One owned foreground connector inside the existing endpoint lifecycle. The
// official Runtime owns reconnects and only its own remote Exec children.
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const protocol = 'memoh.endpoint.native-runtime.v1'
const bridge = fileURLToPath(new URL('./native-connector-child.mjs', import.meta.url))
const fail = code => { throw Object.assign(new Error(code), { code }) }
const stateMap = { connecting: 'connecting', connected: 'online', disconnected: 'offline', stopped: 'stopped' }
const processDiagnostic = c => c ? { component: 'connector', pid: c.process.pid || null, exitObserved: c.exitObserved,
  exitCode: c.exitCode ?? null, signal: c.signal ?? null, processError: c.error,
  stderrBytes: c.stderrBytes, stderrCode: c.stderrCode } : null

// Never return raw stderr, enrollment, URLs or keys. The HTTP classifications
// match the official Runtime's own fixed handshake diagnostic, not a guessed
// machine-offline conclusion. Other network failures remain offline/unknown.
export function nativeConnectorObservation(line, stderr = false) {
  const value = line.trim()
  if (!value) return null
  const match = /^(connecting|connected|disconnected|stopped)(?:: (.*))?$/.exec(value)
  const error = match?.[2] || (stderr ? value : '')
  const handshake = /runtime handshake rejected with HTTP (401|403|426)(?:\b|:)/.exec(error)
  if (handshake) return { state: 'needs_attention', lastError: `handshake_${handshake[1]}` }
  // Runtime forwards Node's verification message without its error code. Keep
  // these known failures distinct from ordinary network disconnects, without
  // returning the certificate details, hostname or URL contained in the text.
  if (/^(?:self-signed certificate(?: in certificate chain)?|unable to verify the first certificate|certificate has expired|Hostname\/IP does not match certificate's altnames)(?:$|: )/i.test(error)) return { state: 'needs_attention', lastError: 'native_tls_verification_failed' }
  if (/server selected unexpected runtime protocol:/.test(error)) return { state: 'needs_attention', lastError: 'native_protocol_invalid' }
  if (stderr && /^runtime configuration (?:was not found|could not be read safely|at .+ (?:is |must |has ))/.test(value)) return { state: 'needs_attention', lastError: 'native_configuration_invalid' }
  if (match) return { state: stateMap[match[1]], lastError: error ? 'connection_unavailable' : null }
  return { state: 'needs_attention', lastError: stderr ? 'native_runtime_failed' : 'native_output_invalid' }
}

export class NativeRuntimeConnector {
  constructor({ node, entry, enrollmentFile, cwd, env, deviceId, runtimeId, version }) {
    if (![node, entry, enrollmentFile, cwd].every(value => typeof value === 'string' && path.isAbsolute(value)) ||
        typeof deviceId !== 'string' || typeof runtimeId !== 'string' || !/^\d+\.\d+\.\d+$/.test(version || '')) fail('native_connector_configuration_invalid')
    this.options = { node, entry, enrollmentFile, cwd, env: { ...env }, deviceId, runtimeId, version }
    for (const name of Object.keys(this.options.env)) if (/^(NODE_OPTIONS|NODE_PATH|MEMOH_RUNTIME_(SERVER|KEY|CONFIG|TEAM_ID|INSECURE_LOCALHOST|HOME))$/i.test(name)) delete this.options.env[name]
    this.record = null
    this.previousRecord = null // Diagnostic evidence only; never cleanup authority.
  }
  alive() { return Boolean(this.record && !this.record.exited) }
  diagnostics() {
    const c = this.record
    return c ? { ...processDiagnostic(c), previousExit: processDiagnostic(this.previousRecord) } : null
  }
  confirmedExit() {
    const c = this.record
    return Boolean(c && c.exitObserved && Number.isSafeInteger(c.process.pid) && this.cleanupConfirmed())
  }
  cleanupConfirmed() {
    const c = this.record
    if (!c?.closed) return false
    if (c.spawnFailed && c.process.pid === undefined) return true // Known not executed; not a fabricated exit.
    if (!c.exitObserved || c.error || c.signal !== null) return false
    // Process closure alone cannot prove cleanup of Runtime-owned Exec work.
    // Official stopped is emitted after runConnection's child cleanup. Before
    // any session started, an explicit secure-configuration failure owns none.
    return c.stoppedObserved || c.loaded && !c.sessionStarted && c.observation?.lastError === 'native_configuration_invalid'
  }
  status() {
    const c = this.record
    if (!c?.observation) return null
    const observation = c.closed && !this.cleanupConfirmed() ? { state: 'needs_attention', lastError: 'native_cleanup_unknown' } : c.observation
    return { ...observation, pid: c.process.pid, deviceId: this.options.deviceId, runtimeId: this.options.runtimeId,
      version: this.options.version, updatedAt: c.updatedAt, identity: 'configured_reference_unverified' }
  }
  start() {
    if (this.alive() || this.record && !this.record.closed) fail('component_already_owned')
    if (this.record && !this.cleanupConfirmed()) fail('component_previous_cleanup_unknown')
    const { node, entry, enrollmentFile, cwd, env } = this.options
    const child = spawn(node, [bridge, entry, enrollmentFile], { cwd, env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
    const c = { process: child, startedAt: Date.now(), updatedAt: Date.now(), exited: false, exitObserved: false, closed: false, error: false,
      stopRequested: false, stopSent: false, loaded: false, observation: null, exitCode: null, signal: null, stoppedObserved: false, sessionStarted: false, spawnFailed: false,
      stderrBytes: 0, stderrCode: null }
    this.previousRecord = this.record; this.record = c
    const observe = (value, line = '') => {
      if (!value) return
      const event = /^(connecting|connected|disconnected|stopped)(?:: .*)?$/.exec(line.trim())?.[1]
      if (event === 'stopped') c.stoppedObserved = true
      else if (event) { c.sessionStarted = true; c.stoppedObserved = false }
      // Keep a hard failure visible even if the official retry loop subsequently
      // emits connecting. Lifecycle attention requires its existing owner flow.
      if (c.observation?.state === 'needs_attention' && value.state !== 'needs_attention') return
      c.observation = value; c.updatedAt = Date.now()
    }
    const sendStop = () => {
      if (c.stopSent || c.closed || !child.connected) return
      c.stopSent = true
      child.send({ protocol, type: 'stop' }, error => { if (error && !c.closed) observe({ state: 'needs_attention', lastError: 'native_control_unknown' }) })
    }
    c.requestStop = () => { c.stopRequested = true; sendStop() }
    child.on('message', message => {
      if (!message || message.protocol !== protocol || message.pid !== child.pid || !['loaded', 'load_failed', 'invalid_control'].includes(message.type) || Object.keys(message).sort().join(',') !== 'pid,protocol,type') {
        observe({ state: 'needs_attention', lastError: 'native_control_unknown' }); c.requestStop(); return
      }
      if (message.type === 'loaded') c.loaded = true
      else observe({ state: 'needs_attention', lastError: message.type === 'load_failed' ? 'native_runtime_failed' : 'native_control_unknown' })
    })
    const consume = (stream, stderr) => {
      let pending = '', discarding = false
      stream.on('data', chunk => {
        if (stderr) { c.stderrBytes = Math.min(Number.MAX_SAFE_INTEGER, c.stderrBytes + chunk.length); c.stderrCode ||= 'unclassified_stderr' }
        for (const part of chunk.toString('utf8').split(/(?<=\n)/)) {
          if (!discarding) pending += part
          if (Buffer.byteLength(pending) > 4096) { pending = ''; discarding = true; observe({ state: 'needs_attention', lastError: 'native_output_invalid' }); c.requestStop() }
          if (part.endsWith('\n')) {
            if (!discarding) {
              const observation = nativeConnectorObservation(pending, stderr)
              if (stderr && observation?.lastError) c.stderrCode = observation.lastError
              observe(observation, pending)
            }
            pending = ''; discarding = false
          }
        }
      })
      stream.once('end', () => { if (pending && !discarding) {
        const observation = nativeConnectorObservation(pending, stderr)
        if (stderr && observation?.lastError) c.stderrCode = observation.lastError
        observe(observation, pending)
      } })
    }
    consume(child.stdout, false); consume(child.stderr, true)
    c.done = new Promise(resolve => {
      let stdoutClosed = false, stderrClosed = false
      // Node's aggregate ChildProcess close can remain pending after explicit
      // IPC disconnect. Require each owned resource directly: actual exit,
      // drained/closed output pipes, and disconnected IPC. This is not a timer
      // or PID-existence inference and never discards an active owned child.
      const finish = () => {
        if (c.closed || !c.exitObserved && !(c.error && child.pid === undefined) || !stdoutClosed || !stderrClosed || child.connected) return
        c.closed = true; c.exited = true; resolve({ code: c.exitCode, signal: c.signal })
      }
      child.stdout.once('close', () => { stdoutClosed = true; finish() })
      child.stderr.once('close', () => { stderrClosed = true; finish() })
      child.once('disconnect', finish)
      child.once('exit', (code, signal) => { c.exitObserved = true; c.exited = true; c.exitCode = code; c.signal = signal; finish() })
      child.on('error', () => {
        c.error = true; observe({ state: 'needs_attention', lastError: 'native_process_error' })
        if (child.pid === undefined) { c.exited = true; c.spawnFailed = true }
        finish()
      })
    })
    return c
  }
  async waitClosed(timeoutMs = 10000) {
    const c = this.record
    if (!c) return
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) fail('native_connector_stop_timeout_invalid')
    let timer
    try {
      return await Promise.race([c.done, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('connector_stop_unknown'), { code: 'connector_stop_unknown' })), timeoutMs) })])
    } finally { clearTimeout(timer) }
  }
  async stop(timeoutMs = 10000) {
    const c = this.record
    if (!c) return
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) fail('native_connector_stop_timeout_invalid')
    c.requestStop()
    await this.waitClosed(timeoutMs)
    // Exit/close is evidence about this exact child, not a global PID lookup or
    // permission to clean any external process. Unknown outcomes retain record.
    if (this.record !== c || !this.cleanupConfirmed()) fail('connector_stop_unknown')
  }
}
