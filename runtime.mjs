import * as fs from 'node:fs/promises'
import path from 'node:path'
import { catalog, digest, validateConfig, validateDirectory, verifyBundle, verifyToolchain, validateTransferConfiguration, EndpointError } from './endpoint.mjs'
import { NativeDriver, EndpointLifecycle, StateStore, acquireLeases, leaseKeys, LifecycleError } from './lifecycle.mjs'
import { NativeTransferDriver, TransferLifecycle } from './transfer-lifecycle.mjs'
import { inspectInstalled, inspectInstalledTransfer, validateInstalledConfiguration } from './installed.mjs'

export class RuntimeError extends LifecycleError {
  constructor(code) { super(code); this.code = code }
}
const requireRuntime = (ok, code) => { if (!ok) throw new RuntimeError(code) }
const same = (a, b) => typeof a === 'string' && (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
async function regular(file, limit = 65536) {
  await validateDirectory(path.dirname(file))
  const st = await fs.lstat(file)
  requireRuntime(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size > 0 && st.size <= limit, 'runtime_input_unsafe')
}
async function json(file) {
  await regular(file)
  try { return JSON.parse(await fs.readFile(file, 'utf8')) }
  catch { throw new RuntimeError('runtime_configuration_invalid') }
}

// Absence retains observation-only behavior. This opt-in binds one exact local
// inventory; it is not a release certification or a way to supply executables,
// arguments, shell commands, credentials, or a test driver.
export function validateRuntimeRequest(value, config) {
  if (config.schema === 2) {
    requireRuntime(value && typeof value === 'object' && Object.keys(value).sort().join(',') === 'mode,schema,transfer' && value.schema === 2 && value.mode === 'existing-installations' && ['disabled', 'existing-queue'].includes(value.transfer), 'runtime_request_invalid')
    requireRuntime(value.transfer !== 'existing-queue' || config.transfer, 'transfer_reference_required')
    return Object.freeze({ ...value })
  }
  requireRuntime(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === 'manifestSha256,mode,schema,transfer', 'runtime_request_invalid')
  requireRuntime(value.schema === 1 && value.mode === 'explicit-review' && ['disabled', 'existing-queue'].includes(value.transfer), 'runtime_request_invalid')
  requireRuntime(value.manifestSha256 === config.manifestSha256, 'runtime_manifest_mismatch')
  return Object.freeze({ ...value })
}

export async function validateRuntimeConfiguration(config, request) {
  validateConfig(config); validateRuntimeRequest(request, config)
  if (config.schema === 2) {
    await validateInstalledConfiguration(config)
    if (request.transfer === 'existing-queue') await inspectInstalledTransfer(config)
    return
  }
  for (const key of ['sourceRoot', 'herdrConfigRoot', 'herdrStateRoot', 'agenvoConfigDir', 'piConfigDir']) await validateDirectory(config[key])
  await regular(path.join(config.herdrConfigRoot, 'config.toml'))
  const connector = await json(path.join(config.agenvoConfigDir, 'config.json'))
  requireRuntime(connector.schema === 1 && connector.deviceId === config.deviceId && Array.isArray(connector.instances) && connector.instances.length === 1, 'runtime_device_mapping_invalid')
  const instance = connector.instances[0]
  requireRuntime(instance.id === config.instanceId && instance.kind === 'herdr' && same(instance.binary, path.join(config.bundleRoot, catalog.components.herdr.entry)) && same(instance.cwd, config.sourceRoot) && same(instance.configRoot, config.herdrConfigRoot), 'runtime_approved_path_mismatch')
  let relay
  try { relay = new URL(connector.relay) } catch { throw new RuntimeError('runtime_relay_invalid') }
  requireRuntime(relay.protocol === 'https:' && !relay.username && !relay.password && !relay.search && !relay.hash && relay.pathname === '/', 'runtime_relay_invalid')
  try { await regular(path.join(config.agenvoConfigDir, 'credentials.json')) }
  catch (error) { if (error.code === 'ENOENT') throw new RuntimeError('connector_authentication_required'); throw error }
  // Presence is not proof of authentication. The official connector reports it.
  if (request.transfer === 'existing-queue') {
    await validateTransferConfiguration(config)
    const registry = await json(path.join(config.herdrConfigRoot, 'plugins.json'))
    const plugins = Array.isArray(registry) ? registry.filter(p => p.plugin_id === 'memoh.delivery') : []
    const plugin = plugins[0], root = path.join(config.bundleRoot, 'transfer')
    requireRuntime(plugins.length === 1 && plugin.enabled === true && plugin.version === catalog.components.transfer.version && same(plugin.plugin_root, root) && same(plugin.manifest_path, path.join(root, 'herdr-plugin.toml')), 'runtime_transfer_mapping_invalid')
  }
}

export async function createExplicitRuntime({ config, stateDirectory, request }) {
  validateRuntimeRequest(request, config)
  // Resolve only local configuration here, without probing or starting a child.
  // Freeze the effective path for this runtime; official changes need a new run.
  if (config.schema === 2) config = (await validateInstalledConfiguration(config)).config
  let verified, installation, installedTransfer, driver
  const qualify = async () => {
    try {
      requireRuntime(process.platform === 'win32' && process.arch === 'x64', 'runtime_windows_x64_required')
      if (config.schema === 2) {
        // A running owner's recovery cannot silently accept an official update.
        // A new explicit run re-detects versions without a new approval manifest.
        installation?.assertUnchanged()
        await installedTransfer?.assertUnchanged()
        installation = await inspectInstalled(config)
        if (request.transfer === 'existing-queue') installedTransfer = await inspectInstalledTransfer(config)
        driver.herdrVersion = installation.versions.herdr
        return true
      }
      verified = await verifyBundle(config.bundleRoot, config.manifestSha256)
      await validateRuntimeConfiguration(config, request)
      requireRuntime((await verifyToolchain(config, verified.manifest.components.git.version)).every(c => c.state === 'passed'), 'runtime_toolchain_verification_failed')
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
    if (config.schema === 2) {
      requireRuntime(installation && installedTransfer, 'runtime_inventory_unverified')
      installation.assertUnchanged()
      await installedTransfer.assertUnchanged()
      return true
    }
    requireRuntime(verified, 'runtime_inventory_unverified')
    for (const name of ['bundle.json', catalog.components.transfer.entry, 'transfer/herdr-plugin.toml', 'transfer/SHA256SUMS.json']) {
      const file = path.join(config.bundleRoot, name)
      await regular(file, 256 * 1024 ** 2)
      const expected = name === 'bundle.json' ? config.manifestSha256 : verified.manifest.files.find(f => f.path === name)?.sha256
      requireRuntime(await digest(file) === expected, 'runtime_payload_changed')
    }
    return true
  }
  const transfer = request.transfer === 'existing-queue' ? new TransferLifecycle({ driver: new NativeTransferDriver(config, { qualify: qualifyTransfer }) }) : null
  driver = new NativeDriver(config, { qualify, checkPrograms: config.schema === 2 ? scope => {
    requireRuntime(installation, 'installation_not_checked')
    try { installation.assertUnchanged(scope) } catch (error) { throw new RuntimeError(error.code) }
  } : null })
  return new EndpointLifecycle({ driver,
    store: new StateStore(stateDirectory, config.deviceId), acquire: () => acquireLeases(leaseKeys(config), stateDirectory), transfer })
}
