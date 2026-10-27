// Installation composes existing transactions. No component installer, service,
// credential reader, migration writer or additional configuration authority.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { validateConfig, programPaths, catalog, isNativeRuntimeConfig } from './endpoint.mjs'
import { verifyCandidate } from './candidate.mjs'
import { boundedRead } from './session-diagnostics.mjs'
import { setupEndpoint } from './setup.mjs'
import { programDeployment } from './program-deployment.mjs'
import { hostReferenceLayout, installedProgramReferences, DeploymentError } from './deployment.mjs'
import { inspectPrograms } from './installed.mjs'

const demand = (ok, code) => { if (!ok) throw new DeploymentError(code) }
const hash = raw => createHash('sha256').update(raw).digest('hex')
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const filename = 'WindowsEndpoint.ps1'
async function optional(file) { try { return await boundedRead(file, 262144) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }

export async function programDependencies(config, { inspect = inspectPrograms } = {}) {
  validateConfig(config)
  demand(isNativeRuntimeConfig(config), 'installation_native_configuration_required')
  const paths = programPaths(config), components = []
  let observed = null, error = null
  try { observed = await inspect(config) } catch (e) {
    error = /^[a-z_]{1,80}$/.test(e.code) ? e.code : ['ENOENT','ENOTDIR'].includes(e.code) ? 'installation_input_missing' : 'installation_input_unavailable'
  }
  for (const id of ['node','git','herdr','pi','connector']) {
    const file = observed ? programPaths(observed.config)[id] : paths[id]
    let presence = 'missing'
    try { presence = (await fs.lstat(file)).isFile() ? 'present_not_qualified' : 'not_regular' }
    catch (e) { if (!['ENOENT','ENOTDIR'].includes(e.code)) { presence = 'unavailable'; error ||= 'installation_input_unavailable' } }
    const source = id === 'connector' ? { source: catalog.nativeRuntime.source, method: 'included_in_verified_endpoint_package' } : catalog.installationSources[id]
    components.push({ id, path: file, state: observed ? 'verified_existing_installation' : presence,
      version: observed?.versions[id] ?? null, sha256: observed?.hashes[id] ?? null, ...source,
      installExecuted: false, owner: id === 'connector' ? 'endpoint_package' : 'existing_official_installation' })
  }
  return { schema: 1, state: observed ? 'programs_verified' : 'dependencies_unverified', error, components,
    credentialsRead: false, modelRequests: 0, installationExecuted: false, observed }
}
function publicDependencies(value) { const { observed, ...report } = value; return report }

async function publish(io, file, value) {
  const temporary = path.join(path.dirname(file), `.installation-${randomUUID()}.tmp`)
  const h = await io.open(temporary, 'wx')
  try { await h.writeFile(value); await h.sync() } finally { await h.close() }
  await io.rename(temporary, file)
}
function checkedReceipt(raw, identity) {
  if (raw === null) return null
  let r
  try { r = JSON.parse(raw) } catch { demand(false, 'installation_receipt_invalid') }
  demand(r?.schema === 1 && r.owner === identity && r.protocol === 1 && ['prepared','complete'].includes(r.phase) &&
    sha(r.launcher_sha256) && (r.previous_sha256 === null || sha(r.previous_sha256)) && sha(r.source_manifest), 'installation_receipt_invalid')
  return r
}

export async function installProduct(options, { setup = setupEndpoint, dependencies = programDependencies, io = fs, checkpoint = async () => {} } = {}) {
  const { from, root, source, manifestSha256, review = false } = options
  const verified = await verifyCandidate(source, manifestSha256)
  // Never relabel an unqualified review payload as a production installer.
  demand(verified.manifest.stable_installation_entry === 1, 'installation_entry_protocol_unsupported')
  demand(review === true, 'installation_release_qualification_pending')
  const raw = await boundedRead(from, 65536), config = validateConfig(JSON.parse(raw))
  demand(isNativeRuntimeConfig(config), 'installation_native_configuration_required')
  const mapped = installedProgramReferences(config,source,path.join(root,'packages',manifestSha256))
  const programReferenceMappings = []
  for (const [role,a,b] of [['transfer.pluginRoot',config.transfer?.pluginRoot,mapped.transfer?.pluginRoot],
    ['programs.connectorPackage',config.programs.connectorPackage,mapped.programs.connectorPackage]]) {
    if(a!==b)programReferenceMappings.push({role,from:a,to:b})
  }
  const prepared = await setup({ ...options, installProgramReferences: true })
  if (prepared.state === 'deferred') {
    const probeConfig = { ...config, programs: { ...config.programs,
      connectorPackage: config.programs.connectorPackage || path.join(source,'runtime-connector') } }
    return { ...prepared, dependencies: publicDependencies(await dependencies(probeConfig)), entry: null,
      installation: 'deferred_no_stable_entry_changed', credentialsWritten: false, migrationExecuted: false }
  }
  const manager = await programDeployment(root)
  const dependencyConfig = { ...manager.config, programs: { ...manager.config.programs,
    connectorPackage: manager.config.programs.connectorPackage || path.join(manager.layout.packages,manifestSha256,'runtime-connector') } }
  const prerequisites = await dependencies(dependencyConfig)
  const entry = path.join(manager.layout.control, filename), receiptFile = path.join(manager.layout.control, 'installation.json')
  const launcher = await boundedRead(path.join(source, filename), 65536), desiredHash = hash(launcher)
  demand(verified.manifest.files.find(f=>f.path===filename)?.sha256 === desiredHash, 'installation_source_changed')
  const result = await manager.locked(async () => {
    await manager.unchanged()
    demand(await boundedRead(from, 65536) === raw, 'installation_input_changed')
    const state = await manager.read()
    demand(state.packages.some(p => p.hash === manifestSha256), 'installation_package_not_staged')
    await manager.owned(state, manifestSha256)
    const receiptRaw = await optional(receiptFile), prior = checkedReceipt(receiptRaw, config.deviceId), before = await optional(entry)
    if (!prior) demand(before === null, 'installation_unowned_entry_retained')
    else {
      demand(state.packages.some(p=>p.hash===prior.source_manifest), 'installation_receipt_source_unowned')
      demand(prior.phase !== 'prepared' || prior.launcher_sha256 === desiredHash && prior.source_manifest === manifestSha256, 'installation_recovery_required')
      demand(before === null ? prior.phase === 'prepared' && prior.previous_sha256 === null :
        [prior.launcher_sha256, prior.phase === 'prepared' ? prior.previous_sha256 : null].includes(hash(before)), 'installation_entry_changed')
    }
    prerequisites.observed?.assertUnchanged()
    const next = { schema: 1, owner: config.deviceId, protocol: 1, phase: 'prepared', source_manifest: manifestSha256,
      launcher_sha256: desiredHash, previous_sha256: before === null ? null : hash(before),
      dependencies: publicDependencies(prerequisites), authority: 'observed_inventory_not_configuration_or_stop_permission' }
    demand(await optional(receiptFile) === receiptRaw && await optional(entry) === before, 'installation_changed')
    const preparedRaw = JSON.stringify(next) + '\n'
    await publish(io, receiptFile, preparedRaw)
    await checkpoint('entry_prepared')
    await manager.unchanged()
    demand(await optional(entry) === before && await optional(receiptFile) === preparedRaw, 'installation_entry_changed')
    if (before !== launcher) await publish(io, entry, launcher)
    await checkpoint('entry_published')
    await manager.unchanged()
    demand(await optional(entry) === launcher && await optional(receiptFile) === preparedRaw, 'installation_entry_changed')
    next.phase = 'complete'; next.previous_sha256 = null
    await publish(io, receiptFile, JSON.stringify(next) + '\n')
    const selected = state.current === manifestSha256
    return { state: selected && prerequisites.state === 'programs_verified' ? 'installed_review_only' : 'deferred',
      ...(!selected || prerequisites.state !== 'programs_verified' ? { reason: !selected ? 'program_selection_incomplete' : 'dependencies_unverified' } : {}),
      entry, dependencies: publicDependencies(prerequisites), prepared, capabilitiesVerified: false,
      layout: hostReferenceLayout(root,manager.config),
      programReferenceMappings, serverReferencesChanged: false,
      nasProducerLocator: config.transfer ? 'must_match_saved_program_path_before_remote_tasks' : 'not_configured',
      runtimePrerequisites: prepared.prerequisites, nextAction: prepared.nextAction ? [entry,'-Action','Run'] : null,
      qualification: 'not-for-production-release', activation: 'not_started', officialInstallationsChanged: false,
      credentialsWritten: false, migrationExecuted: false, uninstall: 'unsupported_all_files_retained' }
  })
  return result
}

export async function migrationPlan(from, root) {
  const config = validateConfig(JSON.parse(await boundedRead(from, 65536)))
  const layout = hostReferenceLayout(root, config)
  const mappings = layout.references.map(entry=>({role:entry.role,from:entry.path,
    to:entry.role==='sourceRoot'||entry.kind==='program_reference'?entry.path:
      entry.role==='connector.enrollmentFile'?path.join(root,'config/runtime/enrollment.json'):layout.defaults[entry.role]||entry.path,
    action:entry.kind==='program_reference'?'reuse_existing_official_installation':'review_only_no_move',automatic:false}))
  return { state: 'migration_plan_only', current: layout.references, mappings,
    proposedDefaults: layout.defaults, credentialsRead: false, filesChanged: false,
    originalBindings: 'retained_no_roothash_hostbinding_queue_or_task_rewrite',
    requiredBeforeRelocation: ['original_identity_and_writer_quiescence','persisted_original_task_and_queue_locators','explicit_authorized_mapping'] }
}

export async function installationMain(args) {
  const [action, ...rest] = args, options = {}
  for (let i=0;i<rest.length;i+=2) {
    demand(/^--[a-z][a-z0-9-]*$/.test(rest[i]) && typeof rest[i+1] === 'string' && !Object.hasOwn(options,rest[i]), 'installation_arguments_invalid')
    options[rest[i]] = rest[i+1]
  }
  if (action === 'dependencies') {
    demand(Object.keys(options).join(',') === '--from', 'installation_arguments_invalid')
    const result = publicDependencies(await programDependencies(validateConfig(JSON.parse(await boundedRead(options['--from'],65536)))))
    return result.state === 'programs_verified' ? result : { ...result, dependencyState: result.state, state: 'deferred', reason: 'dependencies_unverified' }
  }
  if (action === 'migration-plan') {
    demand(Object.keys(options).sort().join(',') === '--from,--root', 'installation_arguments_invalid')
    return migrationPlan(options['--from'],options['--root'])
  }
  demand(action === 'install' && Object.keys(options).sort().join(',') === '--from,--manifest-sha256,--review,--root,--source,--transfer' && options['--review'] === 'true', 'installation_arguments_invalid')
  return installProduct({from:options['--from'],root:options['--root'],source:options['--source'],manifestSha256:options['--manifest-sha256'],transfer:options['--transfer'],review:true})
}
