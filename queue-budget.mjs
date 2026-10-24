// Reuse the producer's policy in the existing Herdr plugin configuration root.
// No quota override, queue implementation, writer shutdown or migration here.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { EndpointError, validateConfig, validateDirectory, transferLocations } from './endpoint.mjs'
import { deploymentLayout, deploymentReferences } from './deployment.mjs'
import { acquireLeases, leaseKeys } from './lifecycle.mjs'

const defaultBytes = 256 * 1024 ** 2
const demand = (ok, code) => { if (!ok) throw new EndpointError(code) }
const validBytes = bytes => Number.isSafeInteger(bytes) && bytes >= 1 && bytes <= 2 ** 40
async function read(file, limit) {
  await validateDirectory(path.dirname(file))
  const st = await fs.lstat(file)
  demand(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size <= limit, 'queue_budget_input_unsafe')
  return fs.readFile(file, 'utf8')
}
async function exists(file) {
  try { await fs.lstat(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
export async function readQueueBudget(config) {
  const directory = transferLocations(config).config
  // Only an absent policy (not a missing/unsafe configuration directory) selects
  // the legacy default. The native CLI remains the authority for NTFS ACLs.
  await validateDirectory(directory)
  let raw
  try { raw = await read(path.join(directory, 'queue-budget.json'), 1024) }
  catch (error) { if (error.code === 'ENOENT') return { version: 1, bytes: defaultBytes, source: 'legacy_default' }; throw error }
  let value
  try { value = JSON.parse(raw) } catch { throw new EndpointError('queue_budget_invalid') }
  demand(value && Object.keys(value).sort().join(',') === 'bytes,version' && value.version === 1 && validBytes(value.bytes), 'queue_budget_invalid')
  return { ...value, source: 'herdr_plugin_configuration' }
}
const report = (budget, extra = {}) => ({ schema: 1, budget, jobs: 8, workers: 1, journalBytes: 8 * 1024 ** 2,
  queueCompatibility: 'native_cli_check_required', activation: 'blocked', transferAutomaticRecovery: false, ...extra })

export async function queueBudgetCommand(root, requested) {
  const layout = deploymentLayout(root)
  await validateDirectory(root)
  const config = validateConfig(JSON.parse(await read(path.join(layout.config, 'endpoint.json'), 65536)))
  const same = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
  const contains = (a, b) => { const r = path.relative(a, b); return r === '' || !path.isAbsolute(r) && r !== '..' && !r.startsWith(`..${path.sep}`) }
  const roots = ['sourceRoot', 'herdrConfigRoot', 'herdrStateRoot', 'agenvoConfigDir', 'piConfigDir']
  if (config.schema === 1) {
    const expected = deploymentReferences(root, config)
    demand([...roots, 'transferConfigDir', 'transferStateDir'].every(key => same(config[key], expected[key])), 'host_configuration_root_mismatch')
  } else {
    for (const external of [...roots.map(key => config[key]), ...Object.values(config.programs), ...(config.transfer ? [config.transfer.pluginRoot] : [])]) {
      demand([layout.config, layout.data, layout.logs].every(owned => !contains(owned, external) && !contains(external, owned)), 'host_reference_overlap')
    }
  }
  const locations = transferLocations(config)
  const budget = await readQueueBudget(config)
  if (requested === undefined) return report(budget, { state: 'configuration_observed', migration: 'all_old_writers_stopped_and_complete_backup_required' })
  demand(typeof requested === 'string' && /^[1-9][0-9]{0,12}$/.test(requested) && validBytes(Number(requested)), 'queue_budget_invalid')
  const bytes = Number(requested)
  // A repeated request never rewrites even whitespace in the native policy.
  // It is a configuration observation, not proof that a prior migration finished.
  if (budget.bytes === bytes) return report(budget, { state: 'configuration_unchanged' })
  if (budget.source !== 'legacy_default') return report(budget, { ready: false, state: 'deferred', reason: 'existing_policy_requires_writer_stop_backup_and_migration' })
  const directory = path.join(layout.data, 'endpoint')
  await validateDirectory(layout.data)
  try { await fs.mkdir(directory) } catch (error) { if (error.code !== 'EEXIST') throw error }
  await validateDirectory(directory)
  // Same host/device/queue lifetime leases as foreground execution. Never stop
  // an owner to apply a setting. This operation is only initial provisioning.
  let release
  try { release = await acquireLeases([`host:${root}`, ...leaseKeys(config)], directory) }
  catch (error) {
    if (error.code === 'endpoint_already_owned') return report(budget, { ready: false, state: 'deferred', reason: 'endpoint_owned' })
    throw error
  }
  try {
    // Any lifecycle history prevents changing roots to an empty directory from
    // stranding the old queue or task evidence. Missing proof never means drained.
    for (const file of [path.join(directory, 'lifecycle.json'), path.join(directory, 'host-status.json'),
      path.join(config.agenvoConfigDir, 'run.lock'), path.join(config.herdrConfigRoot, 'herdr.sock'), path.join(config.herdrConfigRoot, 'sessions')]) {
      if (await exists(file)) return report(budget, { ready: false, state: 'deferred', reason: 'existing_runtime_requires_writer_stop_backup_and_migration' })
    }
    await validateDirectory(locations.state)
    if ((await fs.readdir(locations.state)).length !== 0) return report(budget, { ready: false, state: 'deferred', reason: 'existing_queue_requires_writer_stop_backup_and_migration' })
    // Recheck under the lease, then create exclusively. Existing/malformed files
    // are never repaired, truncated or deleted. Interrupted creation remains an
    // explicit invalid-policy error, never a fallback to 256 MiB.
    demand((await readQueueBudget(config)).source === 'legacy_default', 'queue_budget_changed')
    const handle = await fs.open(path.join(locations.config, 'queue-budget.json'), 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify({ version: 1, bytes }) + '\n'); await handle.sync() }
    finally { await handle.close() }
    return report(await readQueueBudget(config), { state: 'fresh_policy_created', queueChanged: false, nativePermissions: 'not_verified' })
  } finally { await release() }
}
