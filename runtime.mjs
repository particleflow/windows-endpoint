import { validateConfig, isNativeRuntimeConfig, EndpointError } from './endpoint.mjs'
import { NativeDriver, EndpointLifecycle, StateStore, acquireLeases, leaseKeys, LifecycleError, validateRestartPolicy } from './lifecycle.mjs'
import { NativeTransferDriver, TransferLifecycle } from './transfer-lifecycle.mjs'
import { inspectInstalled, inspectInstalledTransfer, validateInstalledConfiguration } from './installed.mjs'

export class RuntimeError extends LifecycleError {
  constructor(code) { super(code); this.code = code }
}
const requireRuntime = (ok, code) => { if (!ok) throw new RuntimeError(code) }
// Absence retains observation-only behavior. This opt-in binds one exact local
// inventory; it is not a release certification or a way to supply executables,
// arguments, shell commands, credentials, or a test driver.
export function validateRuntimeRequest(value, config) {
  requireRuntime(isNativeRuntimeConfig(config), 'legacy_execution_retired')
  requireRuntime(value && typeof value === 'object' && ['mode','schema','transfer'].every(key => Object.hasOwn(value,key)) &&
    Object.keys(value).every(key => ['mode','schema','transfer','restartPolicy'].includes(key)) && value.schema === 2 && value.mode === 'existing-installations' && ['disabled', 'existing-queue'].includes(value.transfer), 'runtime_request_invalid')
  requireRuntime(value.transfer !== 'existing-queue' || config.transfer, 'transfer_reference_required')
  let restartPolicy
  if (Object.hasOwn(value, 'restartPolicy')) {
    requireRuntime(value.restartPolicy !== undefined, 'runtime_restart_policy_invalid')
    try { restartPolicy = validateRestartPolicy(value.restartPolicy) }
    catch { throw new RuntimeError('runtime_restart_policy_invalid') }
  }
  return Object.freeze({ ...value, ...(restartPolicy ? { restartPolicy } : {}) })
}

export async function validateRuntimeConfiguration(config, request) {
  validateRuntimeRequest(request, config); validateConfig(config)
  await validateInstalledConfiguration(config)
  if (request.transfer === 'existing-queue') await inspectInstalledTransfer(config)
}

export async function createExplicitRuntime({ config, stateDirectory, request }) {
  request = validateRuntimeRequest(request, config)
  // Resolve only local configuration here, without probing or starting a child.
  // Freeze the effective path for this runtime; official changes need a new run.
  config = (await validateInstalledConfiguration(config, { inspectHistoryOnly: true })).config
  let installation, installedTransfer, driver
  const qualify = async state => {
    try {
      requireRuntime(process.platform === 'win32' && process.arch === 'x64', 'runtime_windows_x64_required')
      // A running owner's recovery cannot silently accept an official update.
      installation?.assertUnchanged()
      await installedTransfer?.assertUnchanged()
      installation = await inspectInstalled(config, undefined, { sessionContinuation: state?.phase === 'stopped' ? state.sessionContinuation : null })
      if (request.transfer === 'existing-queue') installedTransfer = await inspectInstalledTransfer(config)
      driver.herdrVersion = installation.versions.herdr
      return true
    } catch (error) {
      if (error instanceof EndpointError) throw new RuntimeError(error.code)
      if (error.code === 'ENOENT') throw new RuntimeError('runtime_input_missing')
      if (['EACCES', 'EPERM'].includes(error.code)) throw new RuntimeError('runtime_permission_denied')
      throw error
    }
  }
  // Recheck executable/proof bytes before each finite command. Full inventory
  // and version checks also run before every component start or recovery.
  const qualifyTransfer = async () => {
    requireRuntime(installation && installedTransfer, 'runtime_inventory_unverified')
    installation.assertUnchanged()
    await installedTransfer.assertUnchanged()
    return true
  }
  const transfer = request.transfer === 'existing-queue' ? new TransferLifecycle({ driver: new NativeTransferDriver(config, { qualify: qualifyTransfer }) }) : null
  driver = new NativeDriver(config, { qualify, checkPrograms: scope => {
    requireRuntime(installation, 'installation_not_checked')
    try { installation.assertUnchanged(scope) } catch (error) { throw new RuntimeError(error.code) }
  } })
  return new EndpointLifecycle({ driver,
    store: new StateStore(stateDirectory, config.deviceId), acquire: () => acquireLeases(leaseKeys(config), stateDirectory), transfer, policy: request.restartPolicy })
}
