// References to user-selected official installations. No installer, updater,
// credential reader, registration database or user-maintained version manifest.
import * as fs from 'node:fs/promises'
import { statSync, lstatSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { EndpointError, validateConfig, validateDirectory, programPaths, managedEnvironment, digest } from './endpoint.mjs'

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
async function capture(config) {
  const p = programPaths(config), files = new Map(), directories = new Map()
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

export async function validateInstalledConfiguration(config) {
  validateConfig(config)
  demand(config.schema === 2, 'existing_installation_config_required')
  for (const key of ['sourceRoot', 'herdrConfigRoot', 'herdrStateRoot', 'agenvoConfigDir', 'piConfigDir']) await validateDirectory(config[key])
  await regular(path.join(config.herdrConfigRoot, 'config.toml'))
  const connector = await json(path.join(config.agenvoConfigDir, 'config.json'))
  demand(connector.schema === 1 && connector.deviceId === config.deviceId && Array.isArray(connector.instances) && connector.instances.length === 1, 'runtime_device_mapping_invalid')
  const i = connector.instances[0]
  demand(i.id === config.instanceId && i.kind === 'herdr' && same(i.binary, config.programs.herdr) && same(i.cwd, config.sourceRoot) && same(i.configRoot, config.herdrConfigRoot), 'runtime_approved_path_mismatch')
  let relay
  try { relay = new URL(connector.relay) } catch { throw new EndpointError('runtime_relay_invalid') }
  demand(relay.protocol === 'https:' && !relay.username && !relay.password && !relay.search && !relay.hash && relay.pathname === '/', 'runtime_relay_invalid')
  try { demand((await regular(path.join(config.agenvoConfigDir, 'credentials.json'))).size > 0, 'connector_authentication_required') }
  catch (error) { if (error.code === 'ENOENT') throw new EndpointError('connector_authentication_required'); throw error }
  // Existing historical panes may contain live/unknown work. Do not import or
  // resume them merely because this config names their official state root.
  const session = path.join(config.herdrConfigRoot, 'sessions', config.session, 'session.json')
  try {
    const state = await json(session)
    demand(state.version === 3 && Array.isArray(state.workspaces) && state.workspaces.length === 0, 'existing_herdr_session_requires_handoff')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
}

export function compareProducerTarget(config, target) {
  validateConfig(config)
  const a = target?.agent, p = programPaths(config)
  demand(target?.device_id === config.deviceId && target.instance_id === config.instanceId && target.session === config.session && same(target.work_dir, config.sourceRoot) && same(target.bash_path, p.git), 'producer_target_mismatch')
  demand(a?.execution_mode === 'pi-json-v1' && typeof a.provider === 'string' && a.provider.length > 0 && typeof a.model === 'string' && a.model.length > 0 && same(a.config_dir, config.piConfigDir), 'producer_agent_profile_mismatch')
  demand(!a.path || same(a.path, managedEnvironment(config).PATH), 'producer_path_mismatch')
  return { state: 'configuration_matches', invocation: 'not_executed' }
}

export async function inspectInstalled(config, run = probe) {
  await validateInstalledConfiguration(config)
  const p = programPaths(config)
  const pi = await json(path.join(config.programs.piPackage, 'package.json'))
  const connector = await json(path.join(config.programs.connectorPackage, 'package.json'))
  demand(pi.name === '@earendil-works/pi-coding-agent' && connector.name === '@agenvo/herdr', 'installation_package_mismatch')
  const launcher = path.join(p.piBin, 'pi')
  demand((await regular(launcher)).size <= 16384, 'installation_launcher_invalid')
  const relativeEntry = path.relative(p.piBin, p.pi).split(path.sep).join('/')
  demand(!path.isAbsolute(relativeEntry) && (await fs.readFile(launcher, 'utf8')).includes(`$basedir/${relativeEntry}`), 'installation_pi_launcher_mismatch')
  for (const name of ['node', 'node.exe']) {
    const sibling = path.join(p.piBin, name)
    try { await fs.lstat(sibling); demand(same(sibling, p.node), 'installation_node_resolution_mismatch') }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  const observed = await capture(config), env = managedEnvironment(config)
  const call = (file, args) => { observed.assertUnchanged(); const output = run(file, args, env); observed.assertUnchanged(); return output }
  const versions = { node: call(p.node, ['--version']).replace(/^v/, ''), herdr: call(p.herdr, ['--version']).replace(/^herdr /, ''), pi: call(p.node, [p.pi, '--version']) }
  let connectorVersion
  try { connectorVersion = JSON.parse(call(p.node, [p.connector, '--version'])).version } catch { throw new EndpointError('installation_connector_protocol_invalid') }
  versions.connector = connectorVersion
  minimum(versions.node, '24.13.0'); minimum(versions.herdr, '0.9.5'); minimum(versions.pi, '1.2.0')
  demand(versions.pi === pi.version && versions.connector === connector.version && versions.connector === '0.2.0', 'installation_package_protocol_mismatch')
  const piHelp = call(p.node, [p.pi, '--help'])
  for (const flag of ['--mode', '--session-dir', '--session-id', '--provider', '--model']) demand(piHelp.includes(flag), 'installation_pi_protocol_missing')
  const herdrHelp = call(p.herdr, ['--help'])
  for (const flag of ['--session', 'server', 'status']) demand(herdrHelp.includes(flag), 'installation_herdr_protocol_missing')
  // Resolve the real official launcher in the same controlled environment the
  // host supplies. Positional values never become shell source or a new shim.
  const resolution = 'set -e; case "$(uname -s)" in MINGW*|MSYS*) ;; *) exit 91;; esac; for t in base64 cygpath sha256sum wc mkdir mv rm rmdir; do command -v "$t" >/dev/null || exit 92; done; printf "%s\\n" "$(cygpath -w "$(command -v pi)")"; pi --version'
  const lines = call(p.git, ['--noprofile', '--norc', '-c', resolution]).split(/\r?\n/)
  demand(lines.length === 2 && same(lines[0], path.join(p.piBin, 'pi')) && lines[1] === versions.pi, 'installation_pi_resolution_mismatch')
  versions.git = call(path.join(p.gitRoot, 'cmd/git.exe'), ['--version'])
  demand(/^git version \d+\.\d+\.\d+\.windows\.\d+$/.test(versions.git), 'installation_git_protocol_missing')
  return { ...observed, versions }
}

export async function installedDoctor(config, target = null) {
  const checks = [], result = { schema: 1, ready: false, mode: 'existing-installations', versions: null, checks,
    producer: 'not_checked', transfer: 'not_included_pending_qualification', update: 'official_owner; stop_and_recheck; task_handoff_unimplemented', credentialsRead: false }
  try {
    const inspected = await inspectInstalled(config)
    result.versions = inspected.versions
    checks.push({ check: 'installation_paths_versions_protocol', state: 'passed' })
    if (target) { result.producer = compareProducerTarget(config, target).state; checks.push({ check: 'producer_configuration', state: 'passed' }) }
  } catch (error) { checks.push({ check: 'installation_preflight', state: 'blocked', code: error instanceof EndpointError ? error.code : error.code === 'ENOENT' ? 'installation_input_missing' : 'installation_input_unavailable' }) }
  return result
}
