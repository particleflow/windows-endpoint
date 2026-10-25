// Connect the existing transaction journal to the portable foreground program.
// Official component paths, configuration and producer data are never switched.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { validateConfig, validateDirectory } from './endpoint.mjs'
import { DeploymentTransactions, DeploymentError, deploymentLayout } from './deployment.mjs'
import { acquireLeases } from './lifecycle.mjs'
import { boundedRead, readSessionHistory } from './session-diagnostics.mjs'
import { verifySessionContinuation } from './session-continuation.mjs'
import { validateRuntimeRequest } from './runtime.mjs'
import { verifyCandidate, stageCandidate, programProfileHash } from './candidate.mjs'

const demand = (ok, code) => { if (!ok) throw new DeploymentError(code) }
const overlaps = (a, b) => [path.relative(a, b), path.relative(b, a)].some(r => r === '' || !path.isAbsolute(r) && r !== '..' && !r.startsWith(`..${path.sep}`))
async function optional(file) {
  try { return await boundedRead(file, 65536) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function exists(file) {
  try { await fs.lstat(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
async function directory(file) {
  try { await fs.mkdir(file) } catch (error) { if (error.code !== 'EEXIST') throw error }
  await validateDirectory(file)
}
const describe = result => ({ ...result, evidence: 'endpoint_program_transaction', activation: 'explicit_foreground_only',
  qualification: 'not-for-production-release', officialComponentsChanged: false, queueAdvanced: false })

export class ProgramDeployment extends DeploymentTransactions {
  async unchanged() {
    demand(await optional(this.configFile) === this.configRaw && await optional(this.runtimeFile) === this.runtimeRaw, 'deployment_configuration_changed')
  }
  async work(profile) {
    await this.unchanged()
    if (profile !== programProfileHash) return 'state_profile_incompatible'
    const state = await this.lifecycleStore.load()
    if (state.handoff) return 'host_handoff_unverified'
    if (state.phase !== 'stopped' || state.attention) return 'endpoint_stop_unverified'
    // This is a stopped-program switch, not a claim of global business idle or
    // an admission barrier for an external producer. No component/queue writer
    // is upgraded here; its original path and exact producer revision remain.
    if (state.sessionContinuation) {
      try { await verifySessionContinuation(this.config, state.sessionContinuation) }
      catch (error) { return error.code || 'session_continuation_unavailable' }
    } else {
      const history = await readSessionHistory(this.config)
      if (!['no_saved_history', 'no_saved_workspaces'].includes(history.startup)) return 'existing_herdr_session_requires_handoff'
    }
    // The task owner must reconcile attempt evidence. Do not infer that an
    // absent pane, an idle queue or a saved ordinary shell means a Pi task ended.
    const attempts = path.join(this.config.sourceRoot, '.memoh-computer/attempts')
    if (await exists(attempts)) {
      await validateDirectory(attempts)
      const handle = await fs.opendir(attempts)
      try { if (await handle.read()) return 'task_handoff_unverified' } finally { await handle.close() }
    }
    if (await exists(path.join(this.config.herdrConfigRoot, 'sessions', this.config.session, 'herdr.sock')) ||
        await exists(path.join(this.config.agenvoConfigDir, 'run.lock'))) return 'external_component_state_unverified'
    return null
  }
}

export async function programDeployment(root, { prepare = false, io = fs, checkpoint } = {}) {
  const layout = deploymentLayout(root)
  await validateDirectory(root); await validateDirectory(layout.config)
  const configFile = path.join(layout.config, 'endpoint.json'), runtimeFile = path.join(layout.config, 'runtime.json')
  const configRaw = await optional(configFile), runtimeRaw = await optional(runtimeFile)
  demand(configRaw !== null, 'deployment_configuration_missing')
  let config
  try { config = validateConfig(JSON.parse(configRaw)); if (runtimeRaw !== null) validateRuntimeRequest(JSON.parse(runtimeRaw), config) }
  catch { throw new DeploymentError('deployment_configuration_invalid') }
  demand(config.schema === 2, 'deployment_existing_installations_required')
  const external = [...['sourceRoot', 'herdrConfigRoot', 'herdrStateRoot', 'agenvoConfigDir', 'piConfigDir'].map(k => config[k]), ...Object.values(config.programs), ...(config.transfer ? [config.transfer.pluginRoot] : [])]
  demand(external.every(location => [layout.config, layout.data, layout.logs].every(owned => !overlaps(owned, location))), 'deployment_reference_overlap')
  // The same root convention as ForegroundHost. No external directory is made.
  const lifecycleDirectory = path.join(layout.data, 'endpoint')
  if (prepare) {
    const existing = await fs.readdir(root)
    if (existing.includes('control') || existing.includes('packages')) {
      // Existing or interrupted ownership is inspected, never repaired/adopted.
      await validateDirectory(lifecycleDirectory); await validateDirectory(layout.logs)
    } else {
      demand(existing.every(name => ['config', 'data', 'logs'].includes(name)), 'deployment_unowned_root_retained')
      await directory(layout.data); await directory(lifecycleDirectory); await directory(layout.logs)
    }
  } else { await validateDirectory(lifecycleDirectory) }
  const manager = new ProgramDeployment({ root, config, lifecycleDirectory, io, checkpoint,
    verify: verifyCandidate, stage: stageCandidate,
    qualify: async () => ({ schema: 1, stateProfileSha256: programProfileHash }) })
  Object.assign(manager, { configFile, runtimeFile, configRaw, runtimeRaw })
  return manager
}

export async function runSelectedProgram(root, { input = process.stdin, output = process.stdout } = {}) {
  const manager = await programDeployment(root)
  // Carry one host lease through verification, import and the existing host's
  // full lifetime. Never leave a selection/start race or launch a second daemon.
  const acquired = await acquireLeases([`host:${root}`], manager.lifecycleDirectory)
  let released = false
  const release = async () => { if (!released) { await acquired(); released = true } }
  try {
    await manager.unchanged()
    const state = await manager.read()
    demand(state.pending === null, 'deployment_recovery_required')
    demand(state.current !== null, 'deployment_not_installed')
    const owned = await manager.owned(state, state.current)
    demand(owned.profile === programProfileHash, 'deployment_state_profile_changed')
    await manager.unchanged()
    const target = path.join(manager.layout.packages, state.current, 'host.mjs')
    const { runForeground } = await import(pathToFileURL(target))
    return await runForeground({ root, input, output, inheritedHostLease: release })
  } finally { await release() }
}

export async function programDeploymentMain(args) {
  const [action, ...rest] = args, options = {}
  for (let i = 0; i < rest.length; i += 2) {
    demand(/^--[a-z][a-z0-9-]*$/.test(rest[i]) && typeof rest[i + 1] === 'string' && !Object.hasOwn(options, rest[i]), 'deployment_arguments_invalid')
    options[rest[i]] = rest[i + 1]
  }
  const fields = ['install', 'update'].includes(action) ? ['--root', '--source', '--manifest-sha256'] : action === 'rollback' ? ['--root', '--manifest-sha256'] : ['--root']
  demand(['install', 'update', 'rollback', 'recover', 'status', 'run'].includes(action) && Object.keys(options).sort().join(',') === fields.sort().join(','), 'deployment_arguments_invalid')
  const root = options['--root'], target = options['--manifest-sha256']
  if (action === 'run') return { hostExitCode: await runSelectedProgram(root) }
  const manager = await programDeployment(root, { prepare: action === 'install' })
  if (action === 'status') return describe(await manager.inventory())
  if (action === 'recover') return describe(await manager.recover())
  if (action === 'install') {
    const initialized = await manager.initialize()
    if (initialized.state === 'deferred') return describe(initialized)
  }
  if (action !== 'rollback') {
    const staged = await manager.stage(options['--source'], target)
    if (staged.state === 'deferred') return describe(staged)
  }
  return describe(await manager.select(target, action))
}
