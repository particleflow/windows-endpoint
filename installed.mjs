// References to user-selected official installations. No installer, updater,
// credential reader, registration database or user-maintained version manifest.
import * as fs from 'node:fs/promises'
import { statSync, lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { EndpointError, catalog, validateConfig, validateDirectory, programPaths, managedEnvironment, digest, transferLocations, validateTransferConfiguration, isNativeRuntimeConfig, componentRoots, connectorConfigReference, connectorPackageRoot, requireNativeRuntime } from './endpoint.mjs'
import { readSessionHistory, observeExistingSession } from './session-diagnostics.mjs'
import { verifySessionContinuation } from './session-continuation.mjs'

const demand = (ok, code) => { if (!ok) throw new EndpointError(code) }
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b)
async function regular(file) {
  await validateDirectory(path.dirname(file))
  const s = await fs.lstat(file)
  demand(s.isFile() && !s.isSymbolicLink() && s.nlink === 1 && s.size <= 256 * 1024 ** 2, 'installation_file_invalid')
  return s
}
async function json(file) {
  demand((await regular(file)).size <= 65536, 'installation_metadata_oversized')
  try { return JSON.parse(await fs.readFile(file, 'utf8')) } catch { throw new EndpointError('installation_metadata_invalid') }
}
function probe(file, args, env) {
  demand(process.platform === 'win32' && process.arch === 'x64', 'runtime_windows_x64_required')
  const r = spawnSync(file, args, { env, encoding: 'utf8', timeout: 10000, maxBuffer: 65536, windowsHide: true, shell: false })
  demand(!r.error && r.status === 0, 'installation_probe_failed')
  return r.stdout.trim()
}
function version(value) {
  demand(typeof value === 'string' && /^\d+\.\d+\.\d+$/.test(value), 'installation_version_invalid')
  return value.split('.').map(Number)
}
function minimum(value, floor) {
  const a = version(value), b = version(floor)
  demand(a[0] > b[0] || a[0] === b[0] && (a[1] > b[1] || a[1] === b[1] && a[2] >= b[2]), 'installation_version_too_old')
}
const fingerprint = s => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.nlink, s.mode].join(':')
async function resolveNativeHerdr(config) {
  const binary = config.programs.herdr, release = path.dirname(binary), releases = path.dirname(release), standalone = path.dirname(releases)
  if (path.basename(releases) !== 'releases' || path.basename(standalone) !== 'standalone' || path.basename(path.dirname(standalone)) !== 'packages') return binary
  demand(path.basename(binary).toLowerCase() === 'herdr.exe', 'herdr_active_installation_invalid')
  await validateDirectory(releases)
  const current = path.join(standalone, 'current')
  demand((await fs.lstat(current)).isSymbolicLink(), 'herdr_active_installation_invalid')
  const selected = await fs.realpath(current)
  await validateDirectory(selected)
  demand(same(path.dirname(selected), releases), 'herdr_active_installation_invalid')
  // Resolve only this official selection at a fresh check. The running owner
  // captures the current link and selected bytes before issuing any command.
  return path.join(selected, path.basename(binary))
}
async function officialHerdrSelection(config) {
  const release = path.dirname(config.programs.herdr), releases = path.dirname(release), standalone = path.dirname(releases)
  // Recognize only the official Windows standalone layout. This reads its
  // current selection; it never permits a link as a command path or changes
  // a running owner's captured official program generation.
  if (path.basename(releases) !== 'releases' || path.basename(standalone) !== 'standalone' || path.basename(path.dirname(standalone)) !== 'packages') return () => {}
  await validateDirectory(releases)
  const current = path.join(standalone, 'current'), stat = await fs.lstat(current)
  demand(stat.isSymbolicLink(), 'herdr_active_installation_invalid')
  const selected = await fs.realpath(current)
  await validateDirectory(selected)
  demand(same(path.dirname(selected), releases), 'herdr_active_installation_invalid')
  demand(same(selected, release), 'herdr_active_installation_changed')
  const expected = fingerprint(stat)
  return () => {
    demand(lstatSync(current).isSymbolicLink() && fingerprint(lstatSync(current)) === expected && same(realpathSync(current), release), 'installation_changed_restart_required')
  }
}
async function capture(config, binding) {
  const p = programPaths(config), files = new Map(), directories = new Map()
  const checkSelection = await officialHerdrSelection(config)
  // Keep the selected official instance immutable for this running owner.
  // A fresh explicit run can read a new official mapping after a clean stop.
  if (binding) files.set(binding.file, binding.stamp)
  const add = async file => files.set(file, fingerprint(await regular(file)))
  async function walk(root) {
    await validateDirectory(root)
    directories.set(root, fingerprint(await fs.stat(root)))
    for (const item of await fs.readdir(root, { withFileTypes: true })) {
      const file = path.join(root, item.name)
      demand(!item.isSymbolicLink(), 'installation_link_rejected')
      if (item.isDirectory()) await walk(file)
      else await add(file)
      demand(files.size + directories.size <= 50000, 'installation_inventory_limit')
    }
  }
  await walk(config.programs.piPackage); await walk(config.programs.connectorPackage)
  for (const file of [p.node, p.herdr, p.git, path.join(p.gitRoot, 'cmd/git.exe'), path.join(p.piBin, 'pi'), path.join(p.piBin, 'pi.cmd')]) {
    await add(file)
    directories.set(path.dirname(file), fingerprint(await fs.stat(path.dirname(file))))
  }
  const hashes = {}
  for (const id of ['node', 'herdr', 'pi', 'connector', 'git']) hashes[id] = await digest(p[id])
  const inside = (file, root) => { const r = path.relative(root, file); return r === '' || !path.isAbsolute(r) && r !== '..' && !r.startsWith(`..${path.sep}`) }
  const assertUnchanged = scope => {
    try {
      if (scope !== 'connector') checkSelection()
      for (const [file, expected] of files) {
        if (scope === 'connector' && file !== p.node && !inside(file, config.programs.connectorPackage)) continue
        const s = lstatSync(file)
        demand(s.isFile() && !s.isSymbolicLink() && fingerprint(s) === expected, 'installation_changed_restart_required')
      }
      for (const [directory, expected] of directories) {
        if (scope === 'connector' && directory !== path.dirname(p.node) && !inside(directory, config.programs.connectorPackage)) continue
        demand(!lstatSync(directory).isSymbolicLink() && fingerprint(statSync(directory)) === expected, 'installation_changed_restart_required')
      }
    } catch { throw new EndpointError('installation_changed_restart_required') }
  }
  assertUnchanged()
  return { hashes, assertUnchanged }
}

export async function validateInstalledConfiguration(config, { inspectHistoryOnly = false, sessionContinuation = null } = {}) {
  requireNativeRuntime(config)
  validateConfig(config)
  for (const directory of componentRoots(config)) await validateDirectory(directory, { workspace: directory === config.sourceRoot })
  await regular(path.join(config.herdrConfigRoot, 'config.toml'))
  const file = connectorConfigReference(config)
  let before
  try { before = await regular(file) }
  catch (error) { if (error.code === 'ENOENT') throw new EndpointError('connector_authentication_required'); throw error }
  demand(before.size <= 65536, 'installation_metadata_oversized')
  // Presence is not authenticated NAS identity. Only the official Runtime
  // loader reads the enrollment and validates its native credential format.
  demand(before.size > 0, 'connector_authentication_required')
  const herdr = await resolveNativeHerdr(config)
  const herdrSource = same(herdr, config.programs.herdr) ? 'explicit_official_installation' : 'official_current_selection'
  const resolved = { ...config, programs: { ...config.programs, herdr, connectorPackage: connectorPackageRoot(config) } }
  validateConfig(resolved)
  await regular(resolved.programs.herdr)
  // Existing historical panes may contain live/unknown work. Do not import or
  // resume them merely because this config names their official state root.
  const history = await readSessionHistory(config)
  if (!inspectHistoryOnly) {
    if (sessionContinuation) {
      try { await verifySessionContinuation(config, sessionContinuation) }
      catch (error) { throw new EndpointError(error.code || 'session_continuation_unavailable') }
    } else demand(['no_saved_history', 'no_saved_workspaces'].includes(history.startup), 'existing_herdr_session_requires_handoff')
  }
  return { config: resolved, binding: { file, stamp: fingerprint(before) }, herdrSource, history }
}

export function compareProducerTarget(config, target) {
  validateConfig(config)
  const a = target?.agent, p = programPaths(config)
  demand(target?.device_id === config.deviceId && target.instance_id === config.instanceId && target.session === config.session && same(target.work_dir, config.sourceRoot) && same(target.bash_path, p.git), 'producer_target_mismatch')
  demand(a?.execution_mode === 'pi-json-v1' && typeof a.provider === 'string' && a.provider.length > 0 && typeof a.model === 'string' && a.model.length > 0 && same(a.config_dir, config.piConfigDir), 'producer_agent_profile_mismatch')
  demand(!a.path || same(a.path, managedEnvironment(config).PATH), 'producer_path_mismatch')
  return { state: 'configuration_matches', invocation: 'not_executed' }
}

// Program-only inspection reuses the exact version/protocol checks below. It
// never opens a credential, user profile or task/session directory.
export async function inspectPrograms(config, run = probe, binding = null) {
  requireNativeRuntime(config)
  validateConfig(config)
  config = { ...config, programs: { ...config.programs, connectorPackage: connectorPackageRoot(config) } }
  if (!binding) config = { ...config, programs: { ...config.programs, herdr: await resolveNativeHerdr(config) } }
  validateConfig(config)
  const p = programPaths(config)
  const pi = await json(path.join(config.programs.piPackage, 'package.json'))
  const connector = await json(path.join(config.programs.connectorPackage, 'package.json'))
  try { await regular(path.join(config.programs.connectorPackage, 'dist/endpoint-host-api.mjs')) }
  catch (error) { if (error.code === 'ENOENT') throw new EndpointError('native_runtime_project_root_unsupported'); throw error }
  demand(pi.name === '@earendil-works/pi-coding-agent' && connector.name === '@memohai/runtime', 'installation_package_mismatch')
  const launcher = path.join(p.piBin, 'pi')
  demand((await regular(launcher)).size <= 16384, 'installation_launcher_invalid')
  const relativeEntry = path.relative(p.piBin, p.pi).split(path.sep).join('/')
  demand(!path.isAbsolute(relativeEntry) && (await fs.readFile(launcher, 'utf8')).includes(`$basedir/${relativeEntry}`), 'installation_pi_launcher_mismatch')
  for (const name of ['node', 'node.exe']) {
    const sibling = path.join(p.piBin, name)
    try { await fs.lstat(sibling); demand(same(sibling, p.node), 'installation_node_resolution_mismatch') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const observed = await capture(config, binding), env = managedEnvironment(config)
  const call = (file, args) => { observed.assertUnchanged(); const output = run(file, args, env); observed.assertUnchanged(); return output }
  const versions = { node: call(p.node, ['--version']).replace(/^v/, ''), herdr: call(p.herdr, ['--version']).replace(/^herdr /, ''), pi: call(p.node, [p.pi, '--version']) }
  let connectorVersion
  try { connectorVersion = call(p.node, [p.connector, 'version']) } catch { throw new EndpointError('installation_connector_protocol_invalid') }
  versions.connector = connectorVersion
  minimum(versions.node, catalog.installationSources.node.minimum)
  minimum(versions.herdr, catalog.installationSources.herdr.minimum)
  minimum(versions.pi, catalog.installationSources.pi.minimum)
  demand(versions.pi === pi.version && versions.connector === connector.version && versions.connector === catalog.nativeRuntime.version, 'installation_package_protocol_mismatch')
  const piHelp = call(p.node, [p.pi, '--help'])
  for (const flag of ['--mode', '--session-dir', '--session-id', '--provider', '--model']) demand(piHelp.includes(flag), 'installation_pi_protocol_missing')
  const herdrHelp = call(p.herdr, ['--help'])
  for (const flag of ['--session', 'server', 'status']) demand(herdrHelp.includes(flag), 'installation_herdr_protocol_missing')
  const runtimeHelp = call(p.node, [p.connector, 'run', '--help'])
  for (const flag of ['run', '--config', '--log']) demand(runtimeHelp.includes(flag), 'installation_connector_protocol_invalid')
  // Resolve the real official launcher in the same controlled environment the
  // host supplies. Positional values never become shell source or a new shim.
  const resolution = 'set -e; case "$(uname -s)" in MINGW*|MSYS*) ;; *) exit 91;; esac; for t in base64 cygpath sha256sum wc mkdir mv rm rmdir; do command -v "$t" >/dev/null || exit 92; done; printf "%s\\n" "$(cygpath -w "$(command -v pi)")"; pi --version'
  const lines = call(p.git, ['--noprofile', '--norc', '-c', resolution]).split(/\r?\n/)
  demand(lines.length === 2 && same(lines[0], path.join(p.piBin, 'pi')) && lines[1] === versions.pi, 'installation_pi_resolution_mismatch')
  versions.git = call(path.join(p.gitRoot, 'cmd/git.exe'), ['--version'])
  demand(/^git version \d+\.\d+\.\d+\.windows\.\d+$/.test(versions.git), 'installation_git_protocol_missing')
  return { ...observed, versions, config }
}

export async function inspectInstalled(config, run = probe, { inspectHistoryOnly = false, sessionContinuation = null } = {}) {
  const resolved = await validateInstalledConfiguration(config, { inspectHistoryOnly, sessionContinuation })
  const observed = await inspectPrograms(resolved.config, run, resolved.binding)
  return { ...observed, herdrSource: resolved.herdrSource, history: resolved.history }
}

export async function installedDoctor(config, target = null, { run = probe, observe = observeExistingSession } = {}) {
  validateConfig(config)
  const native = isNativeRuntimeConfig(config)
  const checks = [], result = { schema: 1, ready: false, mode: native ? 'native-runtime-existing-installations' : 'retired-history-only', versions: null, checks,
    producer: 'not_checked', transfer: 'not_included_pending_qualification', update: 'official_owner; stop_and_recheck; task_handoff_unimplemented', credentialsRead: false,
    herdrReference: { source: native ? 'explicit_official_installation' : 'retired_reference', migration: null } }
  if (native) result.identityBinding = 'declared_configuration; authenticated_server_binding_unverified'
  result.history = await readSessionHistory(config)
  result.sessionObservation = { state: 'not_queried', ownership: 'not_acquired', stopAuthority: false, serverIdentity: 'not_verified' }
  if (!native) {
    result.activation = 'blocked'
    checks.push({ check: 'legacy_execution', state: 'blocked', code: 'legacy_execution_retired' })
    return result // Saved snapshot only; no legacy config/auth/status read or child.
  }
  try {
    const inspected = await inspectInstalled(config, run, { inspectHistoryOnly: true })
    result.versions = inspected.versions
    result.history = inspected.history
    checks.push({ check: 'installation_paths_versions_protocol', state: 'passed' })
    result.sessionObservation = await observe(inspected)
    if (config.transfer) {
      await inspectInstalledTransfer(config)
      checks.push({ check: 'existing_transfer_reference', state: 'passed' })
      result.transfer = 'existing_reference_checked; original_file_credential_retained; native_control_file_principal_mapping_unverified'
    }
    if (target) { result.producer = compareProducerTarget(inspected.config, target).state; checks.push({ check: 'producer_configuration', state: 'passed' }) }
  } catch (error) { checks.push({ check: 'installation_preflight', state: 'blocked', code: error instanceof EndpointError ? error.code : error.code === 'ENOENT' ? 'installation_input_missing' : 'installation_input_unavailable' }) }
  // The existing file principal/binding still belongs to the original Agenvo
  // connection. Local paths and payload checks do not authenticate a mapping
  // from native control identity. This diagnostic never alters the authorized
  // original queue consumer or substitutes a Runtime key for its credential.
  if (config.transfer) checks.push({ check: 'native_control_file_principal_mapping', state: 'blocked', code: 'native_file_principal_mapping_unverified' })
  return result
}

// The existing producer owns the package, credentials and queue. Its build
// receipt checks selected local bytes; it is not a signed release certificate.
export async function inspectInstalledTransfer(config) {
  requireNativeRuntime(config)
  validateConfig(config)
  demand(config.transfer, 'transfer_reference_required')
  const locations = transferLocations(config)
  await validateDirectory(locations.root)
  await validateTransferConfiguration(config)
  const direct = Object.hasOwn(config, 'transferConfigDir')
  const registryFile = path.join(config.herdrConfigRoot, 'plugins.json')
  // Direct CLI does not require a plugin registration, but an old hook must be
  // explicitly disabled. Observe absence and original bytes without editing it.
  async function directRegistry() {
    await validateDirectory(config.herdrConfigRoot)
    let before
    try { before = await regular(registryFile) }
    catch (error) { if (error.code === 'ENOENT') return { registry: [], hash: null }; throw error }
    const registry = await json(registryFile), hash = await digest(registryFile)
    demand(fingerprint(await regular(registryFile)) === fingerprint(before), 'runtime_transfer_mapping_changed')
    return { registry, hash }
  }
  const observedRegistry = direct ? await directRegistry() : { registry: await json(registryFile), hash: await digest(registryFile) }
  const { registry, hash: registryHash } = observedRegistry
  const plugins = Array.isArray(registry) ? registry.filter(p => p.plugin_id === 'memoh.delivery') : []
  const plugin = plugins[0]
  if (direct) {
    demand(Array.isArray(registry) && plugins.length <= 1, 'runtime_transfer_mapping_invalid')
    if (plugin) demand(plugin.enabled === false, 'runtime_legacy_plugin_must_be_disabled')
  } else demand(plugins.length === 1 && plugin.enabled === true && plugin.version === catalog.components.transfer.version && same(plugin.plugin_root, locations.root) && same(plugin.manifest_path, path.join(locations.root, 'herdr-plugin.toml')), 'runtime_transfer_mapping_invalid')
  const proofFile = path.join(locations.root, 'SHA256SUMS.json'), proof = await json(proofFile), proofHash = await digest(proofFile)
  const names = ['README.md', 'herdr-plugin.toml', 'transfer.example.json', 'transferqueue-cli.test.exe', 'transferqueue.exe', 'transferqueue.test.exe', 'verify-fixtures.ps1']
  demand(proof.source_commit === catalog.components.transfer.revision && proof.arch === 'amd64' && Array.isArray(proof.files) && proof.files.length === names.length && proof.files.every(f => f && Object.keys(f).sort().join(',') === 'name,sha256' && names.includes(f.name) && /^[a-f0-9]{64}$/.test(f.sha256)) && new Set(proof.files.map(f => f.name)).size === names.length, 'transfer_provenance_mismatch')
  demand(JSON.stringify((await fs.readdir(locations.root)).sort()) === JSON.stringify([...names, 'SHA256SUMS.json'].sort()), 'transfer_inventory_mismatch')
  for (const f of proof.files) {
    const file = path.join(locations.root, f.name)
    await regular(file)
    demand(await digest(file) === f.sha256, 'transfer_payload_changed')
  }
  const tracked = new Map([['SHA256SUMS.json', proofHash], ...proof.files.filter(f => ['transferqueue.exe', 'herdr-plugin.toml'].includes(f.name)).map(f => [f.name, f.sha256])])
  const assertUnchanged = async () => {
    if (direct) {
      try { demand((await directRegistry()).hash === registryHash, 'runtime_transfer_mapping_changed') }
      catch { throw new EndpointError('runtime_transfer_mapping_changed') }
    } else {
      await regular(registryFile)
      demand(await digest(registryFile) === registryHash, 'runtime_transfer_mapping_changed')
    }
    for (const [name, expected] of tracked) {
      const file = path.join(locations.root, name)
      await regular(file)
      demand(await digest(file) === expected, 'transfer_payload_changed')
    }
  }
  await assertUnchanged()
  return { source: proof.source_commit, assertUnchanged }
}
