import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

// Delivery coordination only. No Agent, task scheduler, transfer loop or server.
const here = path.dirname(fileURLToPath(import.meta.url))
export const catalog = JSON.parse(await fs.readFile(path.join(here, 'dependencies.json'), 'utf8'))
const hashPattern = /^[a-f0-9]{64}$/
const idPattern = /^[a-zA-Z0-9_-]{1,64}$/
const uuidPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i
const maxBundleBytes = 4 * 1024 ** 3
const pathFields = ['bundleRoot', 'sourceRoot', 'herdrConfigRoot', 'herdrStateRoot', 'agenvoConfigDir', 'piConfigDir', 'transferConfigDir', 'transferStateDir']
const configFields = ['schema', ...pathFields, 'manifestSha256', 'nasOrigin', 'deviceId', 'instanceId', 'runtimeId', 'session']

export class EndpointError extends Error {
  constructor(code) { super(code); this.code = code }
}
function requireThat(ok, code) { if (!ok) throw new EndpointError(code) }
function keys(value, required, optional = []) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'invalid_object')
  requireThat(required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => [...required, ...optional].includes(k)), 'unknown_or_missing_field')
}
function samePath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}
function overlaps(a, b) {
  return [path.relative(a, b), path.relative(b, a)].some(r => r === '' || (!path.isAbsolute(r) && r !== '..' && !r.startsWith(`..${path.sep}`)))
}
export function isWindowsUNCWorkspacePath(value) {
  if (typeof value !== 'string' || !value.startsWith('\\\\') || /^\\\\[?.]\\/.test(value)) return false
  const parts = value.slice(2).split('\\')
  if (parts.at(-1) === '') parts.pop()
  return parts.length >= 2 && parts.every(part => part && !/[<>:"/|?*\x00-\x1f]/.test(part) &&
    !['.', '..'].includes(part) && !/[. ]$/.test(part)) &&
    (value === path.win32.normalize(value) || value + '\\' === path.win32.normalize(value))
}
function absolute(value, workspace = false) {
  const unc = process.platform === 'win32' && workspace && isWindowsUNCWorkspacePath(value)
  requireThat(typeof value === 'string' && path.isAbsolute(value) && (value === path.normalize(value) || unc) && !/[\x00-\x1f]/.test(value), 'absolute_clean_path_required')
  if (process.platform === 'win32') requireThat(/^[a-z]:\\/i.test(value) && !value.slice(2).includes(':') || unc, 'local_drive_required')
  return value
}
function relative(value) {
  requireThat(typeof value === 'string' && value.length <= 240 && value.split('/').every(p => /^[^<>:"\\|?*\x00-\x1f]+$/.test(p) && !/^\.+$/.test(p) && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)), 'unsafe_package_path')
  return value
}
async function regular(file) {
  const st = await fs.lstat(file)
  requireThat(st.isFile() && !st.isSymbolicLink() && st.nlink === 1, 'regular_private_copy_required')
  return st
}
async function canonical(file, workspace = false) {
  const resolved = await fs.realpath(file)
  requireThat(samePath(resolved, file) || workspace && samePath(path.normalize(resolved), path.normalize(file)), 'noncanonical_path')
  // Check every ancestor, including junctions; no package traversal through links.
  for (let p = file; ; p = path.dirname(p)) {
    requireThat(!(await fs.lstat(p)).isSymbolicLink(), 'reparse_point_rejected')
    if (p === path.dirname(p)) break
  }
}
export async function validateDirectory(directory, { workspace = false } = {}) {
  absolute(directory, workspace)
  await canonical(directory, workspace)
  requireThat((await fs.stat(directory)).isDirectory(), 'directory_required')
}
async function readJSON(file, limit = 65536) {
  requireThat((await regular(file)).size <= limit, 'json_too_large')
  try { return JSON.parse(await fs.readFile(file, 'utf8')) }
  catch { throw new EndpointError('invalid_json') }
}
export async function digest(file) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(file)) hash.update(chunk)
  return hash.digest('hex')
}

function validateAPIBase(value) {
  // memoh.file-api-base.v1: inspect raw syntax before WHATWG URL can normalize
  // dot segments, an empty authority or a default port. Never rewrite the value
  // used by transfer.json's raw-byte HostBinding. Keep the existing error code.
  const code = 'https_origin_required'
  requireThat(typeof value === 'string' && Buffer.byteLength(value) <= 2048 && !/[\x00-\x20\x7f?#%\\]/.test(value), code)
  const parts = value.match(/^https:\/\/([^/]+)(\/.*)?$/)
  requireThat(parts && !parts[1].includes('@') && !parts[1].endsWith(':'), code)
  const port = parts[1].match(/:(\d+)$/)
  requireThat(!port || (Number(port[1]) >= 1 && Number(port[1]) <= 65535), code)
  const prefix = parts[2] || ''
  requireThat(!prefix.includes('//') && prefix.split('/').every(segment => /^[A-Za-z0-9._~-]*$/.test(segment) && segment !== '.' && segment !== '..'), code)
  let url
  try { url = new URL(value) } catch { throw new EndpointError(code) }
  requireThat(url.protocol === 'https:' && url.hostname && !url.username && !url.password && !url.hostname.endsWith('.invalid'), code)
}

export function isNativeRuntimeConfig(config) { return config?.schema === 3 }
export function connectorPackageRoot(config) {
  return config.programs.connectorPackage ?? (isNativeRuntimeConfig(config) ? path.dirname(path.dirname(path.join(here, catalog.nativeRuntime.entry))) : undefined)
}
export function componentRoots(config) {
  return ['sourceRoot', 'herdrConfigRoot', 'herdrStateRoot', ...(!isNativeRuntimeConfig(config) ? ['agenvoConfigDir'] : []), 'piConfigDir'].map(key => config[key])
}
export function connectorConfigReference(config) {
  return isNativeRuntimeConfig(config) ? config.connector.enrollmentFile : path.join(config.agenvoConfigDir, 'config.json')
}
export function installationReferences(config) {
  if (config.schema === 1) return pathFields.map(key => config[key])
  return [...componentRoots(config), ...Object.values(config.programs), ...(config.transfer ? [config.transfer.pluginRoot] : []), ...(isNativeRuntimeConfig(config) ? [connectorConfigReference(config),
    ...(Object.hasOwn(config, 'transferConfigDir') ? [transferLocations(config).config, transferLocations(config).state] : [])] : [])]
}

export function validateConfig(config) {
  if ([2, 3].includes(config?.schema)) {
    const native = isNativeRuntimeConfig(config)
    const roots = ['sourceRoot', 'herdrConfigRoot', 'herdrStateRoot', ...(!native ? ['agenvoConfigDir'] : []), 'piConfigDir']
    keys(config, ['schema', 'programs', ...roots, 'deviceId', 'runtimeId', 'instanceId', 'session', ...(native ? ['connector'] : [])], ['transfer', ...(native ? ['transferConfigDir', 'transferStateDir'] : [])])
    if (native) {
      keys(config.connector, ['kind', 'enrollmentFile'])
      requireThat(config.connector.kind === 'memoh-runtime', 'connector_kind_unsupported')
      absolute(config.connector.enrollmentFile)
    }
    // Legacy omitted Herdr resolves from its selected official Agenvo instance.
    // Native mode keeps one explicit official installation reference.
    keys(config.programs, ['node', 'piPackage', 'piBin', 'gitRoot', ...(native ? ['herdr'] : ['connectorPackage'])], native ? ['connectorPackage'] : ['herdr'])
    for (const key of roots) absolute(config[key], key === 'sourceRoot')
    for (const value of Object.values(config.programs)) absolute(value)
    requireThat(uuidPattern.test(config.deviceId) && uuidPattern.test(config.runtimeId) && idPattern.test(config.instanceId) && idPattern.test(config.session) && config.session !== 'default', 'dedicated_session_required')
    if (native) requireThat(config.deviceId === config.runtimeId, 'native_runtime_identity_mismatch')
    requireThat(path.basename(config.herdrConfigRoot) === 'herdr' && path.basename(config.herdrStateRoot) === 'herdr', 'herdr_root_name_required')
    const programs = programPaths(config)
    const programRoots = [path.dirname(programs.node), ...(programs.herdr ? [path.dirname(programs.herdr)] : []), config.programs.piPackage, config.programs.piBin, config.programs.gitRoot, connectorPackageRoot(config)]
    for (const root of roots.map(k => config[k])) for (const location of programRoots) requireThat(!overlaps(root, location), 'data_program_overlap')
    if (native) {
      for (const location of [...roots.map(k => config[k]), ...programRoots]) requireThat(!overlaps(config.connector.enrollmentFile, location), 'connector_enrollment_overlap')
    }
    for (let i = 0; i < roots.length; i++) for (let j = i + 1; j < roots.length; j++) requireThat(!overlaps(config[roots[i]], config[roots[j]]), 'component_data_overlap')
    if (config.transfer !== undefined) {
      keys(config.transfer, ['pluginRoot', 'nasOrigin'])
      absolute(config.transfer.pluginRoot)
      validateAPIBase(config.transfer.nasOrigin)
      for (const root of roots.map(k => config[k])) requireThat(!overlaps(root, config.transfer.pluginRoot), 'data_program_overlap')
      if (native) requireThat(!overlaps(config.connector.enrollmentFile, config.transfer.pluginRoot), 'connector_enrollment_overlap')
    }
    if (native && ['transferConfigDir', 'transferStateDir'].some(key => Object.hasOwn(config, key))) {
      const locations = transferLocations(config)
      for (const [directory, ownRoot] of [[locations.config, 'herdrConfigRoot'], [locations.state, 'herdrStateRoot']]) {
        absolute(directory)
        for (const program of [...programRoots, locations.root]) requireThat(!overlaps(directory, program), 'data_program_overlap')
        requireThat(!overlaps(directory, config.connector.enrollmentFile), 'connector_enrollment_overlap')
        for (const key of roots) {
          if (key === ownRoot) {
            // Existing plugin subdirectories may remain under their Herdr root;
            // never select the entire root or an ancestor containing sessions.
            const relative = path.relative(config[key], directory)
            const child = relative !== '' && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)
            requireThat(!overlaps(directory, config[key]) || child, 'component_data_overlap')
          } else requireThat(!overlaps(directory, config[key]), 'component_data_overlap')
        }
      }
      requireThat(!overlaps(locations.config, locations.state), 'component_data_overlap')
    }
    return config
  }
  keys(config, configFields)
  requireThat(config.schema === 1, 'config_version_unsupported')
  for (const field of pathFields) absolute(config[field])
  requireThat(hashPattern.test(config.manifestSha256), 'trusted_manifest_hash_required')
  validateAPIBase(config.nasOrigin)
  requireThat(uuidPattern.test(config.deviceId) && uuidPattern.test(config.runtimeId) && idPattern.test(config.instanceId) && idPattern.test(config.session), 'existing_identity_required')
  requireThat(path.basename(config.herdrConfigRoot) === 'herdr' && path.basename(config.herdrStateRoot) === 'herdr', 'herdr_root_name_required')
  requireThat(samePath(config.transferConfigDir, path.join(config.herdrConfigRoot, 'plugins/config/memoh.delivery')), 'herdr_plugin_config_mismatch')
  requireThat(samePath(config.transferStateDir, path.join(config.herdrStateRoot, 'plugins/memoh.delivery')), 'herdr_plugin_state_mismatch')
  for (const field of pathFields.filter(f => !['sourceRoot', 'bundleRoot'].includes(f))) {
    requireThat(!overlaps(config.sourceRoot, config[field]) && !overlaps(config.bundleRoot, config[field]), 'data_package_overlap')
  }
  requireThat(!overlaps(config.sourceRoot, config.bundleRoot) && !overlaps(config.transferConfigDir, config.transferStateDir), 'data_package_overlap')
  return config
}

async function walk(root, rel = '') {
  const result = []
  for (const item of await fs.readdir(path.join(root, rel), { withFileTypes: true })) {
    const name = rel ? `${rel}/${item.name}` : item.name
    relative(name)
    requireThat(!item.isSymbolicLink(), 'reparse_point_rejected')
    if (item.isDirectory()) result.push(...await walk(root, name))
    else { await regular(path.join(root, name)); result.push(name) }
    requireThat(result.length <= 50000, 'inventory_limit')
  }
  return result
}

export async function verifyBundle(root, expectedHash) {
  absolute(root)
  await canonical(root)
  requireThat(hashPattern.test(expectedHash), 'trusted_manifest_hash_required')
  const manifestFile = path.join(root, 'bundle.json')
  await regular(manifestFile)
  requireThat(await digest(manifestFile) === expectedHash, 'manifest_hash_mismatch')
  const manifest = await readJSON(manifestFile, 8 * 1024 ** 2)
  keys(manifest, ['schema', 'platform', 'qualification', 'components', 'files'])
  requireThat(manifest.schema === 1 && manifest.platform === catalog.platform && manifest.qualification === 'review-only', 'bundle_contract_unsupported')
  keys(manifest.components, Object.keys(catalog.components))
  for (const [id, spec] of Object.entries(catalog.components)) {
    const component = manifest.components[id]
    keys(component, ['version', 'source', 'revision', 'entry'])
    requireThat(component.source === spec.source && component.entry === spec.entry, 'component_source_mismatch')
    requireThat(typeof component.version === 'string' && /^\d+\.\d+\.\d+(?:\.windows\.\d+)?$/.test(component.version), 'exact_version_required')
    requireThat(typeof component.revision === 'string' && /^(?:[a-f0-9]{40}|v\d+\.\d+\.\d+(?:\.windows\.\d+)?)$/.test(component.revision), 'exact_revision_required')
    requireThat((spec.version === null || component.version === spec.version) && (spec.revision === null || component.revision === spec.revision), 'component_version_mismatch')
  }
  requireThat(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 50000, 'inventory_limit')
  const seen = new Set()
  let totalBytes = 0
  for (const file of manifest.files) {
    keys(file, ['path', 'size', 'sha256'])
    relative(file.path)
    requireThat(file.path.toLowerCase() !== 'bundle.json' && !seen.has(file.path.toLowerCase()), 'duplicate_inventory_path')
    seen.add(file.path.toLowerCase())
    requireThat(Number.isSafeInteger(file.size) && file.size >= 0 && hashPattern.test(file.sha256), 'invalid_inventory_entry')
    totalBytes += file.size
    requireThat(totalBytes <= maxBundleBytes, 'bundle_capacity_limit')
  }
  const needed = [...Object.values(catalog.components).flatMap(c => [c.entry, ...(c.package ? [c.package] : [])]), ...catalog.requiredFiles]
  requireThat(needed.every(f => seen.has(f.toLowerCase())), 'component_missing')
  const actual = (await walk(root)).filter(f => f !== 'bundle.json').sort()
  requireThat(JSON.stringify(actual) === JSON.stringify(manifest.files.map(f => f.path).sort()), 'inventory_mismatch')
  for (const file of manifest.files) {
    const full = path.join(root, file.path)
    await canonical(full)
    requireThat((await regular(full)).size === file.size && await digest(full) === file.sha256, 'payload_hash_mismatch')
  }
  for (const spec of Object.values(catalog.components).filter(c => c.package)) {
    const pkg = await readJSON(path.join(root, spec.package))
    requireThat(pkg.name === spec.name && pkg.version === spec.version, 'npm_package_mismatch')
  }
  const transfer = await readJSON(path.join(root, 'transfer/SHA256SUMS.json'))
  requireThat(transfer.source_commit === manifest.components.transfer.revision && transfer.arch === 'amd64', 'transfer_provenance_mismatch')
  for (const name of ['transferqueue.exe', 'herdr-plugin.toml']) {
    const proof = transfer.files?.find(f => f.name === name)
    requireThat(proof?.sha256 === manifest.files.find(f => f.path === `transfer/${name}`)?.sha256, 'transfer_provenance_mismatch')
  }
  return { manifest, totalBytes }
}

// Copy to a content-addressed candidate; never switch current binaries or touch data.
// Incomplete .pending-* directories are inert. Retry creates a new one; no guessing
// at a stale lock/PID and no destructive recovery. Explicit retention is deliberate.
export async function stageBundle(source, destination, expectedHash, { checkpoint = async () => {}, verify = verifyBundle, manifestName = 'bundle.json' } = {}) {
  absolute(destination)
  await canonical(destination)
  requireThat(!overlaps(source, destination), 'stage_root_overlap')
  const { manifest, totalBytes } = await verify(source, expectedHash)
  const target = path.join(destination, expectedHash)
  try {
    await fs.lstat(target)
    await verify(target, expectedHash)
    return { state: 'already_staged', manifestSha256: expectedHash }
  } catch (e) { if (e.code !== 'ENOENT') throw e }
  const space = await fs.statfs(destination)
  requireThat(space.bavail * space.bsize >= totalBytes + 64 * 1024 ** 2, 'insufficient_staging_space')
  const pending = path.join(destination, `.pending-${expectedHash}-${randomUUID()}`)
  await fs.mkdir(pending)
  for (const file of [...manifest.files.map(f => f.path), manifestName]) {
    const output = path.join(pending, file)
    await fs.mkdir(path.dirname(output), { recursive: true })
    await fs.copyFile(path.join(source, file), output, 1)
    const handle = await fs.open(output, 'r+')
    try { await handle.sync() } finally { await handle.close() }
    await checkpoint('file_copied')
  }
  await verify(pending, expectedHash)
  try { await fs.rename(pending, target) }
  catch (error) {
    if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error
    await verify(target, expectedHash) // competing identical publication only
    return { state: 'already_staged', manifestSha256: expectedHash, retainedPending: true }
  }
  return { state: 'staged_review_only', manifestSha256: expectedHash }
}

export async function configure(from, to, root, { browseSourceRoot = false, chooseDirectory, packageReferences = null } = {}) {
  let input = await readJSON(from)
  if (browseSourceRoot) {
    requireThat([2, 3].includes(input?.schema), 'directory_picker_reference_configuration_required')
    const originalInput = JSON.stringify(input)
    const { pickDirectory } = await import('./directory-selection.mjs')
    const selection = await pickDirectory({ initialPath: typeof input.sourceRoot === 'string' && path.isAbsolute(input.sourceRoot) ? input.sourceRoot : null },
      chooseDirectory ? { choose: chooseDirectory } : undefined)
    if (selection.state === 'cancelled') return selection
    requireThat(JSON.stringify(await readJSON(from)) === originalInput, 'directory_picker_configuration_changed')
    input = { ...input, sourceRoot: selection.path }
  }
  if (packageReferences) {
    const { installedProgramReferences } = await import('./deployment.mjs')
    input = installedProgramReferences(input, packageReferences.source, packageReferences.target)
  }
  let config, layout
  if (root !== undefined) {
    const { DeploymentError, deploymentLayout, deploymentReferences } = await import('./deployment.mjs')
    await validateDirectory(root)
    layout = deploymentLayout(root)
    requireThat(to === undefined, 'invalid_arguments')
    to = path.join(layout.config, 'endpoint.json')
    if (input?.schema === 1) {
      try { config = deploymentReferences(root, input) }
      catch (error) { if (error instanceof DeploymentError) throw new EndpointError(error.code); throw error }
      // A fresh template omits paths. Explicit existing paths must agree; this
      // command never silently relocates a queue, workspace or selected bundle.
      for (const field of pathFields) requireThat(!Object.hasOwn(input, field) || samePath(input[field], config[field]), 'host_configuration_root_mismatch')
    } else config = validateConfig(input)
  } else config = validateConfig(input)
  absolute(to)
  await canonical(path.dirname(to))
  const locations = installationReferences(config)
  if (layout && config.schema >= 2) {
    const { hostReferenceLayout } = await import('./deployment.mjs')
    requireThat(hostReferenceLayout(root, config).compatible, 'host_reference_overlap')
  }
  requireThat(!locations.some(location => overlaps(location, to)), 'configuration_location_rejected')
  // Exclusive creation; upgrading never overwrites the references or credentials.
  const handle = await fs.open(to, 'wx')
  try { await handle.writeFile(`${JSON.stringify(config, null, 2)}\n`); await handle.sync() }
  finally { await handle.close() }
  return { state: 'references_saved', credentialsRead: false, activation: 'blocked',
    transferConfiguration: config.schema === 1 || config.transfer ? {
      directory: transferLocations(config).config,
      networkPolicyFile: path.join(transferLocations(config).config, 'transfer-network.json'),
      networkPolicy: 'optional_existing_producer_configuration', validation: 'producer_on_invoke',
    } : null,
  }
}

export function programPaths(config) {
  if ([2, 3].includes(config.schema)) {
    const p = config.programs
    return { node: p.node, herdr: p.herdr, pi: path.join(p.piPackage, 'dist/bundle/cli.js'), connector: path.join(connectorPackageRoot(config), isNativeRuntimeConfig(config) ? 'dist/cli.mjs' : 'dist/cli.js'),
      git: path.join(p.gitRoot, 'bin/bash.exe'), piBin: p.piBin, gitRoot: p.gitRoot }
  }
  const entry = id => path.join(config.bundleRoot, catalog.components[id].entry)
  return { node: entry('node'), herdr: entry('herdr'), pi: entry('pi'), connector: entry('connector'), git: entry('git'), piBin: path.join(config.bundleRoot, 'node_modules/.bin'), gitRoot: path.join(config.bundleRoot, 'git') }
}
export function managedEnvironment(config, inherited = process.env) {
  const env = { ...inherited }
  // Keep the caller's ordinary OS environment but remove shell/runtime injection.
  for (const k of Object.keys(env)) {
    if (/^(PATH|NODE_OPTIONS|NODE_PATH|BASH_ENV|BASH_FUNC_.*|ENV|CDPATH|SHELLOPTS|BASHOPTS|HERDR_.*|XDG_CONFIG_HOME|XDG_STATE_HOME|AGENVO_.*|MEMOH_RUNTIME_.*|PI_CODING_AGENT_DIR)$/i.test(k)) delete env[k]
  }
  const system = path.join(inherited.SystemRoot || 'C:\\Windows', 'System32')
  const p = programPaths(config)
  requireThat(p.herdr, 'herdr_reference_unresolved')
  env.PATH = [path.dirname(p.node), path.dirname(p.herdr), p.piBin, path.join(p.gitRoot, 'bin'), path.join(p.gitRoot, 'usr/bin'), path.join(p.gitRoot, 'mingw64/bin'), path.join(p.gitRoot, 'cmd'), system, path.join(system, 'WindowsPowerShell/v1.0')].join(path.delimiter)
  env.HERDR_CONFIG_PATH = path.join(config.herdrConfigRoot, 'config.toml')
  env.XDG_CONFIG_HOME = path.dirname(config.herdrConfigRoot)
  env.XDG_STATE_HOME = path.dirname(config.herdrStateRoot)
  if (!isNativeRuntimeConfig(config)) env.AGENVO_CONFIG_DIR = config.agenvoConfigDir
  env.PI_CODING_AGENT_DIR = config.piConfigDir
  return env
}

// Shared reference checks only. The producer remains responsible for native
// storage permissions, authorization and queue integrity; never repair ACLs here.
export function transferLocations(config) {
  if ([2, 3].includes(config.schema)) {
    requireThat(config.transfer, 'transfer_reference_required')
    const explicit = isNativeRuntimeConfig(config) && ['transferConfigDir', 'transferStateDir'].some(key => Object.hasOwn(config, key))
    if (explicit) requireThat(['transferConfigDir', 'transferStateDir'].every(key => Object.hasOwn(config, key)), 'transfer_directory_pair_required')
    return { root: config.transfer.pluginRoot,
      config: explicit ? config.transferConfigDir : path.join(config.herdrConfigRoot, 'plugins/config/memoh.delivery'),
      state: explicit ? config.transferStateDir : path.join(config.herdrStateRoot, 'plugins/memoh.delivery'), origin: config.transfer.nasOrigin }
  }
  return { root: path.join(config.bundleRoot, 'transfer'), config: config.transferConfigDir, state: config.transferStateDir, origin: config.nasOrigin }
}
export async function validateTransferConfiguration(config) {
  validateConfig(config)
  const locations = transferLocations(config)
  for (const directory of [config.sourceRoot, locations.config, locations.state]) {
    await canonical(directory, directory === config.sourceRoot)
    requireThat((await fs.stat(directory)).isDirectory(), 'directory_required')
  }
  const file = path.join(locations.config, 'transfer.json')
  const cfg = await readJSON(file, 8192)
  keys(cfg, ['version', 'origin', 'source_root'])
  // Exact configured spelling is intentional: even equivalent URLs must not
  // silently change the producer's existing raw-byte binding or queue owner.
  requireThat(cfg.version === 1 && cfg.origin === locations.origin && samePath(cfg.source_root, config.sourceRoot), 'transfer_configuration_mismatch')
  try { requireThat((await regular(path.join(locations.config, 'device.credential'))).size > 0, 'transfer_credential_missing') }
  catch (error) { if (error.code === 'ENOENT') throw new EndpointError('transfer_credential_missing'); throw error }
}

export function transferEnvironment(config, inherited = process.env) {
  const locations = transferLocations(config)
  return { ...managedEnvironment(config, inherited),
    HERDR_PLUGIN_CONFIG_DIR: locations.config,
    HERDR_PLUGIN_STATE_DIR: locations.state }
}
export function launchPlan(config) {
  const entry = id => programPaths(config)[id]
  return {
    activation: 'blocked', reason: 'compatibility_qualification_pending',
    commands: [
      { component: 'herdr', file: entry('herdr'), args: ['--session', config.session, 'server'] },
      { component: 'connector', file: entry('node'), args: [entry('connector'), 'run', ...(isNativeRuntimeConfig(config) ? ['--config', connectorConfigReference(config)] : [])] },
    ],
    environment: { PATH: managedEnvironment(config).PATH, HERDR_CONFIG_PATH: path.join(config.herdrConfigRoot, 'config.toml'), XDG_CONFIG_HOME: path.dirname(config.herdrConfigRoot), XDG_STATE_HOME: path.dirname(config.herdrStateRoot), ...(!isNativeRuntimeConfig(config) ? { AGENVO_CONFIG_DIR: config.agenvoConfigDir } : {}), PI_CODING_AGENT_DIR: config.piConfigDir },
    transfer: { owner: 'existing Herdr memoh.delivery actions', scheduler: 'existing task/result flow' },
  }
}
function probe(file, args, env) {
  const result = spawnSync(file, args, { env, encoding: 'utf8', timeout: 10000, maxBuffer: 16384, windowsHide: true, shell: false })
  requireThat(!result.error && result.status === 0, 'dependency_probe_failed')
  return result.stdout.trim()
}

export async function doctor(config, run = probe) {
  validateConfig(config)
  if ([2, 3].includes(config.schema)) {
    const { installedDoctor } = await import('./installed.mjs')
    return installedDoctor(config)
  }
  const checks = []
  async function check(name, action) {
    try { await action(); checks.push({ check: name, state: 'passed' }); return true }
    catch (e) { checks.push({ check: name, state: 'blocked', code: e instanceof EndpointError ? e.code : 'dependency_unavailable' }); return false }
  }
  let bundle
  const bundleOK = await check('bundle_inventory', async () => { bundle = await verifyBundle(config.bundleRoot, config.manifestSha256) })
  await check('windows_host', () => requireThat(process.platform === 'win32' && process.arch === 'x64', 'windows_x64_required'))
  for (const field of pathFields.filter(f => f !== 'bundleRoot')) await check(field, async () => {
    await canonical(config[field]); requireThat((await fs.stat(config[field])).isDirectory(), 'directory_required')
  })
  await check('existing_device_mapping', async () => {
    const cfg = await readJSON(path.join(config.agenvoConfigDir, 'config.json'))
    requireThat(cfg.schema === 1 && cfg.deviceId === config.deviceId && Array.isArray(cfg.instances), 'device_identity_mismatch')
    const instances = cfg.instances.filter(i => i.id === config.instanceId)
    requireThat(instances.length === 1, 'instance_identity_mismatch')
    const i = instances[0]
    requireThat(i.kind === 'herdr' && samePath(i.binary, path.join(config.bundleRoot, catalog.components.herdr.entry)) && samePath(i.configRoot, config.herdrConfigRoot) && samePath(i.cwd, config.sourceRoot), 'approved_instance_path_mismatch')
    // Check presence only. Never read/copy/refresh the official authentication file.
    requireThat((await regular(path.join(config.agenvoConfigDir, 'credentials.json'))).size > 0, 'connector_credentials_missing')
  })
  await check('official_agent_configuration', async () => {
    requireThat((await regular(path.join(config.piConfigDir, 'auth.json'))).size > 0, 'pi_authentication_missing')
    await regular(path.join(config.herdrConfigRoot, 'config.toml'))
  })
  await check('transfer_configuration', () => validateTransferConfiguration(config))
  await check('existing_transfer_plugin', async () => {
    const registry = await readJSON(path.join(config.herdrConfigRoot, 'plugins.json'))
    requireThat(Array.isArray(registry), 'plugin_registry_invalid')
    const plugins = registry.filter(p => p.plugin_id === 'memoh.delivery')
    requireThat(plugins.length === 1, 'transfer_plugin_missing')
    const plugin = plugins[0]
    const root = path.join(config.bundleRoot, 'transfer')
    requireThat(plugin.enabled === true && plugin.version === catalog.components.transfer.version && samePath(plugin.plugin_root, root) && samePath(plugin.manifest_path, path.join(root, 'herdr-plugin.toml')), 'transfer_plugin_mapping_mismatch')
  })
  let connection = 'authentication_unverified'
  try {
    const status = await readJSON(path.join(config.agenvoConfigDir, 'status.json'))
    const age = Date.now() - status.updatedAt
    if (status.deviceId === config.deviceId && Number.isFinite(age) && age >= 0 && age <= 120000) {
      if (['handshake_401', 'handshake_403'].includes(status.lastError)) connection = 'authentication_required'
      else if (status.lastError === 'handshake_426') connection = 'protocol_upgrade_required'
      else if (status.state === 'needs_attention') connection = 'needs_attention'
      else if (status.state === 'online') connection = 'online_snapshot_unverified'
    }
  } catch { /* Optional official status snapshot; absence is unknown, not READY. */ }
  // Only execute inventory-verified dependencies on their target OS.
  if (bundleOK && process.platform === 'win32' && process.arch === 'x64') {
    checks.push(...await verifyToolchain(config, bundle.manifest.components.git.version, run))
  }
  return {
    schema: 1, ready: false, activation: 'blocked', checks,
    capabilities: { connection, agent: 'readiness_unverified', desktop: 'unsupported_by_command_connector', transfer: 'native_storage_and_route_unverified' },
    lifecycle: { owner: 'unified_endpoint', implementation: 'pending', idleQueueWake: 'missing', herdrStartupHook: 'available_one_shot_only', connectorReconnect: 'network_only', automaticRecovery: false },
    blockers: [...catalog.blockers],
    recovery: 'No restart or task resubmission. Authentication failure requires the existing authentication owner.',
  }
}

// Shared by doctor and the isolated official-binary CI harness. Callers must
// establish artifact provenance first. This never grants endpoint qualification.
export async function verifyToolchain(config, gitVersion, run = probe) {
  requireThat(process.platform === 'win32' && process.arch === 'x64', 'windows_x64_required')
  const checks = []
  async function check(name, action) {
    try { await action(); checks.push({ check: name, state: 'passed' }) }
    catch (e) { checks.push({ check: name, state: 'blocked', code: e instanceof EndpointError ? e.code : 'dependency_unavailable' }) }
  }
  const env = managedEnvironment(config)
  const entry = id => path.join(config.bundleRoot, catalog.components[id].entry)
  await check('git_version', () => requireThat(run(path.join(config.bundleRoot, 'git/cmd/git.exe'), ['--version'], env) === `git version ${gitVersion}`, 'executable_version_mismatch'))
  await check('connector_version', () => {
    let version
    try { version = JSON.parse(run(entry('node'), [entry('connector'), '--version'], env)).version } catch { throw new EndpointError('executable_version_mismatch') }
    requireThat(version === catalog.components.connector.version, 'executable_version_mismatch')
  })
  for (const id of ['node', 'herdr']) await check(`${id}_version`, () => {
    const text = run(entry(id), ['--version'], env)
    requireThat(text === `${id === 'node' ? 'v' : 'herdr '}${catalog.components[id].version}`, 'executable_version_mismatch')
  })
  await check('git_bash_toolchain', () => {
    const script = 'case "$(uname -s)" in MINGW*|MSYS*) ;; *) exit 91;; esac; for t in base64 cygpath sha256sum wc mkdir mv rm rmdir node pi herdr; do command -v "$t" >/dev/null || exit 92; done; printf endpoint-git-bash-ok'
    requireThat(run(entry('git'), ['--noprofile', '--norc', '-c', script], env) === 'endpoint-git-bash-ok', 'git_bash_required')
  })
  await check('pi_version', () => requireThat(run(entry('node'), [entry('pi'), '--version'], env) === catalog.components.pi.version, 'executable_version_mismatch'))
  return checks
}

export async function main(args) {
  const [command, ...rest] = args
  if (command === 'installation') {
    const { installationMain } = await import('./product-installation.mjs')
    try { return await installationMain(rest) }
    catch (error) { if (/^(installation|candidate|deployment|setup)_/.test(error.code)) throw new EndpointError(error.code); throw error }
  }
  if (command === 'setup') {
    const { setupMain, SetupError } = await import('./setup.mjs')
    try { return await setupMain(rest) }
    catch (error) { if (error instanceof SetupError || /^(candidate|deployment)_/.test(error.code)) throw new EndpointError(error.code); throw error }
  }
  if (command === 'deploy') {
    const { programDeploymentMain } = await import('./program-deployment.mjs')
    const { DeploymentError } = await import('./deployment.mjs')
    try { return await programDeploymentMain(rest) }
    catch (error) { if (error instanceof DeploymentError || /^(candidate|deployment)_/.test(error.code)) throw new EndpointError(error.code); throw error }
  }
  if (command === 'host') {
    const { hostMain, HostError } = await import('./host.mjs')
    try { return { hostExitCode: await hostMain(rest) } }
    catch (error) { if (error instanceof HostError) throw new EndpointError(error.code); throw error }
  }
  const options = {}
  for (let i = 0; i < rest.length; i += 2) {
    requireThat(/^--[a-z][a-z0-9-]*$/.test(rest[i]) && typeof rest[i + 1] === 'string' && !Object.hasOwn(options, rest[i]), 'invalid_arguments')
    options[rest[i]] = rest[i + 1]
  }
  if (command === 'help' || !command) return { commands: ['installation install|dependencies|migration-plan (see WindowsEndpoint.ps1)', 'setup --from FILE --root DIR --source DIR --manifest-sha256 SHA256 --transfer disabled|existing-queue [--browse-source-root native]', 'configure --from FILE --root DIR [--browse-source-root native]', 'directory-pick [--config FILE]', 'configure --from FILE --config FILE', 'doctor --config FILE', 'layout --config FILE --root DIR', 'plan --config FILE', 'stage --source DIR --destination DIR --manifest-sha256 SHA256', 'host run --root DIR', 'host status --root DIR', 'host recover --root DIR --expected-run UUID --expected-state-sha256 SHA256 --expected-configuration-sha256 SHA256', 'host handoff-status --root DIR --request-id UUID', 'deploy install|update --root DIR --source DIR --manifest-sha256 SHA256', 'deploy rollback --root DIR --manifest-sha256 SHA256', 'deploy run|recover|status --root DIR'], status: 'portable program deployment and foreground review available; production release and active-task handoff remain unqualified' }
  if (['start', 'activate', 'update', 'rollback', 'uninstall'].includes(command)) throw new EndpointError('qualification_required_no_runtime_or_data_changed')
  if (command === 'layout') {
    keys(options, ['--config', '--root'])
    const { hostReferenceLayout } = await import('./deployment.mjs')
    const result = hostReferenceLayout(options['--root'], validateConfig(await readJSON(options['--config'])))
    return { ...result, state: result.compatible ? 'layout_references_valid' : 'deferred',
      ...(result.compatible ? {} : { reason: 'host_reference_overlap' }), capabilitiesVerified: false }
  }
  if (command === 'directory-pick') {
    keys(options, [], ['--config'])
    const { pickDirectory } = await import('./directory-selection.mjs')
    const initialPath = options['--config'] ? validateConfig(await readJSON(options['--config'])).sourceRoot : null
    return pickDirectory({ initialPath })
  }
  if (command === 'configure') {
    keys(options, ['--from'], ['--config', '--root', '--browse-source-root'])
    requireThat(Object.hasOwn(options, '--config') !== Object.hasOwn(options, '--root'), 'invalid_arguments')
    requireThat(options['--browse-source-root'] === undefined || options['--browse-source-root'] === 'native', 'invalid_arguments')
    return configure(options['--from'], options['--config'], options['--root'], { browseSourceRoot: options['--browse-source-root'] === 'native' })
  }
  if (command === 'stage') { keys(options, ['--source', '--destination', '--manifest-sha256']); return stageBundle(options['--source'], options['--destination'], options['--manifest-sha256']) }
  requireThat(['doctor', 'plan'].includes(command), 'unknown_command')
  keys(options, ['--config'], command === 'doctor' ? ['--target'] : [])
  const config = validateConfig(await readJSON(options['--config']))
  if ([2, 3].includes(config.schema) && command === 'doctor') {
    const { installedDoctor } = await import('./installed.mjs')
    return installedDoctor(config, options['--target'] ? await readJSON(options['--target']) : null)
  }
  requireThat(!options['--target'], 'existing_installation_config_required')
  if (command === 'doctor') return doctor(config)
  if ([2, 3].includes(config.schema)) {
    const { inspectInstalled } = await import('./installed.mjs')
    return launchPlan((await inspectInstalled(config)).config)
  } else await verifyBundle(config.bundleRoot, config.manifestSha256)
  return launchPlan(config)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Let module evaluation finish before the optional host imports this shared
  // module. Keeping a top-level await here would form an ESM import deadlock.
  main(process.argv.slice(2)).then(result => {
    if (Object.hasOwn(result, 'hostExitCode')) { process.exitCode = result.hostExitCode; return }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (result.ready === false || result.state === 'deferred') process.exitCode = 2
  }).catch(e => {
    // Do not echo input, paths, native stdout/stderr, config or credentials.
    process.stderr.write(`${JSON.stringify({ error: e instanceof EndpointError || /^directory_picker_[a-z_]+$/.test(e.code) ? e.code : 'operation_failed' })}\n`)
    process.exitCode = 2
  })
}
