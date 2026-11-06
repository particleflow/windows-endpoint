// Product-local IPC bridge to the unchanged official foreground CLI logic. The IPC
// channel belongs to the spawning host; it is not a remote stop/auth endpoint.
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const protocol = 'memoh.endpoint.native-runtime.v1'
const [entry, enrollmentFile] = process.argv.slice(2)
const report = type => {
  if (!process.connected) return
  try { process.send({ protocol, type, pid: process.pid }, () => {}) }
  catch { /* Parent disconnect is handled by the same graceful stop path. */ }
}
let loaded = false, stopping = false, invalidControl = false
function stop() {
  stopping = true
  if (loaded) {
    // On Windows ChildProcess.kill() does not run Node signal handlers. Emit
    // inside this owned process so the official run handler aborts its session,
    // drains its connection children and closes before the process exits.
    process.emit('SIGTERM')
  }
}
process.on('message', value => {
  if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'protocol,type' || value.protocol !== protocol || value.type !== 'stop') {
    invalidControl = true; report('invalid_control')
  }
  stop()
})
process.once('disconnect', stop)
if (!process.send || !path.isAbsolute(entry || '') || !path.isAbsolute(enrollmentFile || '') || process.argv.length !== 4) {
  process.exitCode = 2
  process.channel?.unref()
} else {
  try {
    process.argv = [process.execPath, entry, 'run', '--config', enrollmentFile]
    // This extra build entry exports unchanged official functions. runCLI has
    // no workspace flag and otherwise uses homedir(), not cwd. Override only
    // its existing session factory: enrollment paths, HOME/USERPROFILE, TLS,
    // retry and signal handling stay official. cwd is the validated sourceRoot.
    const { runCLI, formatCLIError, RuntimeSession } = await import(pathToFileURL(path.join(path.dirname(entry), 'endpoint-host-api.mjs')).href)
    const running = runCLI(['run', '--config', enrollmentFile], {
      createSession: (config, options) => new RuntimeSession({ ...config, workspaceBase: process.cwd() }, options),
    })
    // The official function installs signal handlers before its first await.
    // Do not wait for the entire session before accepting an early stop.
    loaded = true
    report('loaded')
    if (stopping) stop()
    running.then(code => { process.exitCode = invalidControl ? 2 : code })
      .catch(error => { console.error(formatCLIError(error)); process.exitCode = invalidControl ? 2 : 1 })
  } catch {
    report('load_failed')
    process.exitCode = 2
  } finally {
    // The control channel must not keep a successfully stopped CLI alive.
    // Runtime network/retry/cleanup handles retain their ordinary lifetime.
    process.channel?.unref()
    if (invalidControl) process.exitCode = 2
  }
}
