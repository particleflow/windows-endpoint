import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runForeground } from '../host.mjs'
import { EndpointLifecycle, LifecycleError, StateStore, acquireLeases, leaseKeys } from '../lifecycle.mjs'
import { TransferLifecycle } from '../transfer-lifecycle.mjs'

const [root, scenario] = process.argv.slice(2)
const notify = value => { if (process.connected) process.send({ fixture: value }) }
let driver, releaseAdvance, releaseReady
let failStop = scenario === 'stop-failure'
const control = message => {
  if (message.fixture === 'crash_connector') driver?.children.get('connector')?.child.send({ action: 'crash' })
  if (message.fixture === 'authentication_failure') driver?.children.get('connector')?.child.send({ action: 'auth_failure' })
  if (message.fixture === 'release_advance') releaseAdvance?.()
  if (message.fixture === 'release_ready') releaseReady?.()
  if (message.fixture === 'allow_stop') failStop = false
}
process.on('message', control)

const code = await runForeground({ root, tickMs: 100, createTestRuntime: async ({ config, stateDirectory }) => {
  const children = new Map()
  driver = {
    children, status: { state: 'online', lastError: '' },
    validate: async () => {},
    alive: component => Boolean(children.get(component) && !children.get(component).exited),
    hostStatus: () => ({ running: driver.alive('herdr'), version: '0.9.5', endpoint_compatible: true }),
    ownedHostStatus: async () => driver.hostStatus(),
    connectorStatus: async () => driver.status,
    start: async component => {
      const child = fork(fileURLToPath(new URL('./host-component.mjs', import.meta.url)), [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] })
      const owned = { child, exited: false }
      owned.done = new Promise(resolve => { child.once('exit', () => { owned.exited = true; resolve() }); child.once('error', () => { owned.exited = true; resolve() }) })
      owned.ready = new Promise(resolve => child.once('message', resolve))
      child.on('message', value => { if (component === 'connector') driver.status = value })
      children.set(component, owned)
      notify({ event: 'component_started', component, pid: child.pid })
    },
    waitReady: async component => {
      const owned = children.get(component)
      await Promise.race([owned.ready, owned.done.then(() => { throw new LifecycleError('fixture_startup_exited') })])
      if (scenario === 'startup-drain' && component === 'herdr') {
        await new Promise(resolve => { releaseReady = resolve; notify({ event: 'ready_waiting' }) })
      }
    },
    recoverConnectorLock: async () => { notify({ event: 'synthetic_lock_recovery' }) },
    stop: async component => {
      if (failStop && component === 'connector') throw new LifecycleError('connector_stop_unknown')
      const owned = children.get(component)
      if (!owned || owned.exited) return
      owned.child.send({ action: 'stop' })
      await owned.done
      notify({ event: 'component_stopped', component })
    },
  }
  const transfer = new TransferLifecycle({ driver: { invoke: async action => {
    notify({ event: 'transfer_action', action })
    const result = { schema: 'memoh.delivery.lifecycle.v1', state: 'idle', next_due_at: null, error_class: 'none' }
    if (scenario === 'unknown-transfer') { result.state = 'unknown'; result.error_class = 'unknown' }
    if (scenario === 'drain-failure') {
      result.state = 'due'
      if (action === 'advance-results') {
        await new Promise(resolve => { releaseAdvance = resolve; notify({ event: 'advance_waiting' }) })
        return { status: 1, stdout: JSON.stringify({ ...result, delivery_id: 'original-delivery', phase: 'uploading', offset: 3, admitted: true, associated: false }) }
      }
    }
    return { status: 0, stdout: JSON.stringify(result) }
  } } })
  return new EndpointLifecycle({ driver, transfer, store: new StateStore(stateDirectory, config.deviceId), acquire: () => acquireLeases(leaseKeys(config), stateDirectory), policy: { retryMs: 10 } })
} })
process.removeListener('message', control)
process.exitCode = code
if (process.connected) process.disconnect()
