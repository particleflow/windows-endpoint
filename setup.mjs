// Compose existing reference configuration, preflight and program deployment.
// No service registration, credential write, component install or process start.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { validateConfig, validateDirectory, configure, installationReferences, isNativeRuntimeConfig, catalog } from './endpoint.mjs'
import { verifyCandidate } from './candidate.mjs'
import { deploymentLayout } from './deployment.mjs'
import { programDeploymentMain } from './program-deployment.mjs'
import { installedDoctor } from './installed.mjs'
import { validateRuntimeRequest } from './runtime.mjs'
import { acquireLeases, leaseKeys } from './lifecycle.mjs'
import { boundedRead } from './session-diagnostics.mjs'

export class SetupError extends Error {
  constructor(code) { super(code); this.code = code }
}
const demand = (ok, code) => { if (!ok) throw new SetupError(code) }
const overlaps = (a, b) => [path.relative(a, b), path.relative(b, a)].some(r => r === '' || !path.isAbsolute(r) && r !== '..' && !r.startsWith(`..${path.sep}`))
const ordered = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(ordered) : Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value
const stable = value => JSON.stringify(ordered(value))
const parse = raw => { try { return JSON.parse(raw) } catch { throw new SetupError('setup_configuration_invalid') } }
async function optional(file) {
  try { return await boundedRead(file, 65536) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function match(file, expected) {
  const raw = await optional(file)
  if (raw !== null) demand(stable(parse(raw)) === stable(expected), 'setup_existing_configuration_differs')
  return raw
}
async function directory(file) {
  try { await fs.mkdir(file) } catch (error) { if (error.code !== 'EEXIST') throw error }
  await validateDirectory(file)
}

export async function setupEndpoint({ from, root, source, manifestSha256, transfer }, {
  verify = verifyCandidate, doctor = installedDoctor, install = programDeploymentMain,
  checkpoint = async () => {}, io = fs,
} = {}) {
  demand(['disabled', 'existing-queue'].includes(transfer), 'setup_transfer_mode_required')
  const layout = deploymentLayout(root)
  await validateDirectory(path.dirname(root))
  const verified = await verify(source, manifestSha256) // Exact inventory before any destination write.
  const inputRaw = await boundedRead(from, 65536), config = validateConfig(parse(inputRaw))
  demand([2, 3].includes(config.schema), 'setup_reference_configuration_required')
  demand(!isNativeRuntimeConfig(config) || verified.manifest?.native_runtime, 'deployment_native_connector_missing')
  demand(!isNativeRuntimeConfig(config) || !config.transferConfigDir || verified.manifest?.native_transfer_directory_pair === true, 'deployment_transfer_directories_unsupported')
  const request = validateRuntimeRequest({ schema: 2, mode: 'existing-installations', transfer }, config)
  demand(installationReferences(config).every(location => [layout.config, layout.data, layout.logs].every(owned => !overlaps(owned, location))), 'host_reference_overlap')
  demand(!overlaps(source, root), 'setup_source_destination_overlap')
  const configFile = path.join(layout.config, 'endpoint.json'), runtimeFile = path.join(layout.config, 'runtime.json')
  // Reject existing conflicts before creating anything. Unknown files are kept.
  await match(configFile, config); await match(runtimeFile, request)
  try {
    await validateDirectory(root)
    demand((await fs.readdir(root)).every(name => ['config', 'data', 'logs', 'packages', 'control'].includes(name)), 'setup_unowned_root_retained')
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  await directory(root); await directory(layout.config); await directory(layout.data)
  const stateDirectory = path.join(layout.data, 'endpoint')
  await directory(stateDirectory)
  let release
  try { release = await acquireLeases([...leaseKeys(config), `host:${root}`, `deployment:${root}`], stateDirectory) }
  catch (error) {
    if (error.code === 'endpoint_already_owned') return { state: 'deferred', reason: 'endpoint_owned', ready: false, activation: 'not_started' }
    throw error
  }
  try {
    const previous = await match(configFile, config)
    await match(runtimeFile, request)
    if (previous === null) {
      demand(await boundedRead(from, 65536) === inputRaw, 'setup_input_changed')
      await configure(from, undefined, root)
      await match(configFile, config)
    }
    await checkpoint('references_saved')
    if (await match(runtimeFile, request) === null) {
      const handle = await io.open(runtimeFile, 'wx')
      try { await handle.writeFile(`${JSON.stringify(request, null, 2)}\n`); await handle.sync() } finally { await handle.close() }
    }
    await checkpoint('runtime_request_saved')
  } finally { await release() }
  // The existing install transaction reacquires the same ownership leases and
  // rechecks config bytes. A concurrent start defers installation, never stops it.
  let preflightConfig = config
  if (isNativeRuntimeConfig(config) && config.programs.connectorPackage === undefined) {
    preflightConfig = { ...config, programs: { ...config.programs, connectorPackage: path.dirname(path.dirname(path.join(source, catalog.nativeRuntime.entry))) } }
  }
  const preflight = await doctor(preflightConfig)
  // Preserve the exact reference request even if it changes while the doctor is
  // probing. The existing transaction then freezes and rechecks these bytes.
  demand(await match(configFile, config) !== null && await match(runtimeFile, request) !== null, 'setup_configuration_changed')
  const deployment = await install(['install', '--root', root, '--source', source, '--manifest-sha256', manifestSha256])
  const selected = ['selected_review_only', 'already_selected'].includes(deployment.state)
  const blocked = preflight.checks.some(check => check.state === 'blocked')
  return { state: selected ? 'prepared_review_only' : deployment.state, ready: false, activation: 'not_started',
    qualification: 'not-for-production-release', preflight, prerequisites: blocked ? 'blocked' : 'local_checks_passed',
    deployment, nextAction: selected && !blocked ? ['deploy', 'run', '--root', root] : null,
    nextRequired: selected && blocked ? 'resolve_preflight_prerequisites_then_recheck' : null,
    officialComponentsChanged: false, credentialsWritten: false, queueAdvanced: false }
}

export async function setupMain(args) {
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    demand(/^--[a-z][a-z0-9-]*$/.test(args[i]) && typeof args[i + 1] === 'string' && !Object.hasOwn(options, args[i]), 'setup_arguments_invalid')
    options[args[i]] = args[i + 1]
  }
  demand(Object.keys(options).sort().join(',') === '--from,--manifest-sha256,--root,--source,--transfer', 'setup_arguments_invalid')
  try { return await setupEndpoint({ from: options['--from'], root: options['--root'], source: options['--source'], manifestSha256: options['--manifest-sha256'], transfer: options['--transfer'] }) }
  catch (error) {
    if (['EACCES', 'EPERM', 'EROFS'].includes(error.code)) throw new SetupError('setup_storage_read_only')
    if (error.code === 'ENOSPC') throw new SetupError('setup_space_unavailable')
    throw error
  }
}
