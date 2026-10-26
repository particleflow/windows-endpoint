// Connect the existing transaction journal to the portable foreground program.
// Official component paths, configuration and producer data are never switched.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { validateConfig, validateDirectory, installationReferences, isNativeRuntimeConfig } from './endpoint.mjs'
import { DeploymentTransactions, DeploymentError, deploymentLayout } from './deployment.mjs'
import { acquireLeases } from './lifecycle.mjs'
import { boundedRead, readSessionHistory } from './session-diagnostics.mjs'
import { captureSessionContinuation, verifySessionContinuation } from './session-continuation.mjs'
import { validateRuntimeRequest } from './runtime.mjs'
import { verifyCandidate, stageCandidate, programProfileHash } from './candidate.mjs'
import { attemptEvidence, nativeRecoveryEvidence, recoveryConfigurationHash } from './host-recovery.mjs'
import { inspectInstalled } from './installed.mjs'

const demand = (ok, code) => { if (!ok) throw new DeploymentError(code) }
const overlaps = (a, b) => [path.relative(a, b), path.relative(b, a)].some(r => r === '' || !path.isAbsolute(r) && r !== '..' && !r.startsWith(`..${path.sep}`))
async function optional(file, limit = 65536) {
  try { return await boundedRead(file, limit) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function exists(file) {
  try { await fs.lstat(file); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error }
}
async function directory(file) {
  try { await fs.mkdir(file) } catch (error) { if (error.code !== 'EEXIST') throw error }
  await validateDirectory(file)
}
const describe = (result, retained = null) => ({ ...result, evidence: 'endpoint_program_transaction', activation: 'explicit_foreground_only',
  qualification: 'not-for-production-release', officialComponentsChanged: false, queueAdvanced: false,
  ...(retained ? { taskHistory: 'preserved_unreconciled', retainedAttemptEvidenceSha256: retained.attempts, businessReplayed: false, stopAuthority: false } : {}) })

export class ProgramDeployment extends DeploymentTransactions {
  herdrMarker() {
    return this.config.session === 'default' ? path.join(this.config.herdrConfigRoot, 'herdr.sock') :
      path.join(this.config.herdrConfigRoot, 'sessions', this.config.session, 'herdr.sock')
  }
  async freezeWork(state, marker) {
    if (this.workBaseline) { await this.workBaseline(); return }
    const raw = await optional(this.lifecycleStore.file, 262144)
    const original = raw === null ? { schema: 1, identity: this.config.deviceId, phase: 'stopped', restarts: [], attention: null } : JSON.parse(raw)
    demand(JSON.stringify(original) === JSON.stringify(state), 'deployment_retained_work_changed')
    const attempts = await attemptEvidence(this.config), continuation = await captureSessionContinuation(this.config)
    this.workBaseline = async () => {
      await this.unchanged()
      demand(await optional(this.lifecycleStore.file, 262144) === raw && await attemptEvidence(this.config) === attempts, 'deployment_retained_work_changed')
      demand(await optional(this.herdrMarker(), 80) === marker, 'deployment_herdr_marker_changed')
      await verifySessionContinuation(this.config, continuation)
      await this.retained?.unchanged()
    }
    await this.workBaseline()
  }
  async retainedHistory(state, requireHerdrAbsent = false) {
    // A stopped, compatible PROGRAM switch need not delete or complete old
    // tasks. Consume only the original durable infrastructure-recovery digest,
    // never a caller-supplied owner/idle declaration or an unverified handoff.
    const recovery = state.infrastructureRecovery
    if (!isNativeRuntimeConfig(this.config) || !state.sessionContinuation || !recovery ||
        recovery.configuration !== recoveryConfigurationHash(this.configRaw, this.runtimeRaw)) return 'task_handoff_unverified'
    if (await attemptEvidence(this.config) !== recovery.attempts) return 'task_handoff_unverified'
    const files = { root: this.root, config: this.configFile, runtime: this.runtimeFile,
      state: this.lifecycleStore.file, status: path.join(this.lifecycleDirectory, 'host-status.json') }
    const stateRaw = await boundedRead(files.state, 262144), statusRaw = await boundedRead(files.status, 32768)
    demand(JSON.stringify(JSON.parse(stateRaw)) === JSON.stringify(state), 'deployment_retained_work_changed')
    const status = JSON.parse(statusRaw)
    const recheckedRunning = recovery.previousPhase === 'running' && recovery.previousAttention === null && status.phase === 'running' && status.runId === recovery.run
    if (status.schema !== 1 || status.owner !== 'windows-endpoint-host' || (status.phase !== 'stopped' && !recheckedRunning) || status.attention !== null ||
        !/^[a-f0-9-]{36}$/.test(status.runId) || !Number.isSafeInteger(status.pid) || status.pid < 1 || !Number.isSafeInteger(status.updatedAt)) return 'task_handoff_unverified'
    let backupFile, backupRaw
    if (recheckedRunning) {
      backupFile = path.join(this.lifecycleDirectory, `lifecycle-before-recheck-${recovery.fromState}.json`)
      backupRaw = await boundedRead(backupFile, 262144)
      const original = JSON.parse(backupRaw)
      demand(createHash('sha256').update(backupRaw).digest('hex') === recovery.fromState && original.identity === this.config.deviceId &&
        original.phase === 'running' && original.attention === null && !original.handoff, 'deployment_retained_recovery_mismatch')
    }
    const inspected = await this.inspect(this.config, undefined, { inspectHistoryOnly: true })
    if (this.observe === nativeRecoveryEvidence && path.resolve(process.execPath).toLowerCase() !== path.resolve(inspected.config.programs.node).toLowerCase()) return 'task_handoff_unverified'
    const logFile = path.join(this.root, 'logs/endpoint-host', `${status.runId}.jsonl`)
    const logRaw = await boundedRead(logFile, 65536)
    const unchanged = async () => {
      await this.unchanged(); inspected.assertUnchanged()
      demand(await boundedRead(files.state, 262144) === stateRaw && await boundedRead(files.status, 32768) === statusRaw &&
        await boundedRead(logFile, 65536) === logRaw && await attemptEvidence(this.config) === recovery.attempts, 'deployment_retained_work_changed')
      if (backupFile) demand(await boundedRead(backupFile, 262144) === backupRaw, 'deployment_retained_work_changed')
      await verifySessionContinuation(this.config, state.sessionContinuation)
    }
    // Preserve the FIRST comparison through both work checks and every atomic
    // selector publication. A later observation cannot silently adopt a change.
    if (this.retained) await this.retained.unchanged()
    await unchanged()
    const observed = await this.observe({ config: inspected.config, status, files })
    const absent = evidence => evidence?.ownerVerified === true && evidence.oldHostAbsent === true &&
      evidence.referencedProcessesAbsent === true && (!requireHerdrAbsent || evidence.herdrAbsent === true)
    demand(absent(observed), 'deployment_retained_processes_unknown')
    await unchanged()
    const reobserve = async () => {
      await unchanged()
      const current = await this.observe({ config: inspected.config, status, files })
      demand(absent(current), 'deployment_retained_processes_unknown')
      await unchanged()
    }
    this.retained ||= { attempts: recovery.attempts, unchanged, reobserve }
    return null
  }
  async projectRoot(target) {
    if (!isNativeRuntimeConfig(this.config)) return
    const verified = await this.verify(path.join(this.layout.packages, target), target)
    demand(verified.manifest.native_runtime, 'deployment_native_connector_missing')
    demand(verified.manifest.native_runtime_project_root, 'deployment_native_project_root_unsupported')
    const lifecycle = await this.lifecycleStore.load()
    if (lifecycle.infrastructureRecovery?.previousPhase === 'running') demand(verified.manifest.native_running_recovery === true, 'deployment_running_recovery_unsupported')
  }
  async selectionCheck(state, target, mode) {
    // Check the version to be selected, not the preserved previous inventory.
    // Otherwise adding this requirement would also prevent upgrading the old
    // home-mapped version to the corrected program.
    await this.projectRoot(target)
    return super.selectionCheck(state, target, mode)
  }
  async unchanged() {
    demand(await optional(this.configFile) === this.configRaw && await optional(this.runtimeFile) === this.runtimeRaw, 'deployment_configuration_changed')
  }
  async work(profile) {
    await this.unchanged()
    await this.workBaseline?.()
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
    // A task-owner handoff is still required for execution migration. A verified
    // unchanged recovery baseline can instead retain history verbatim across a
    // stopped program-only switch; it does not claim a Pi task ended.
    const marker = await optional(this.herdrMarker(), 80)
    const retainedMarker = marker !== null && isNativeRuntimeConfig(this.config)
    if (marker !== null && !/^\d+:\d+$/.test(marker)) return 'external_component_state_unverified'
    const attempts = path.join(this.config.sourceRoot, '.memoh-computer/attempts')
    let nonempty = false
    if (await exists(attempts)) {
      await validateDirectory(attempts)
      const handle = await fs.opendir(attempts)
      try { nonempty = !!(await handle.read()) } finally { await handle.close() }
    }
    if (nonempty || retainedMarker) {
      const reason = await this.retainedHistory(state, retainedMarker)
      if (reason) return reason
    }
    // Windows herdr.sock is a PID:nonce marker, not the named-pipe listener.
    // Only the existing native recovery/identity/process/status proof can retain
    // it across a program-only switch. Never remove it or infer task completion.
    if (marker !== null && !retainedMarker ||
        !isNativeRuntimeConfig(this.config) && await exists(path.join(this.config.agenvoConfigDir, 'run.lock'))) return 'external_component_state_unverified'
    await this.freezeWork(state, marker)
    return null
  }
}

export async function programDeployment(root, { prepare = false, io = fs, checkpoint, inspect = inspectInstalled, observe = nativeRecoveryEvidence } = {}) {
  const layout = deploymentLayout(root)
  await validateDirectory(root); await validateDirectory(layout.config)
  const configFile = path.join(layout.config, 'endpoint.json'), runtimeFile = path.join(layout.config, 'runtime.json')
  const configRaw = await optional(configFile), runtimeRaw = await optional(runtimeFile)
  demand(configRaw !== null, 'deployment_configuration_missing')
  let config
  try { config = validateConfig(JSON.parse(configRaw)); if (runtimeRaw !== null) validateRuntimeRequest(JSON.parse(runtimeRaw), config) }
  catch { throw new DeploymentError('deployment_configuration_invalid') }
  demand([2, 3].includes(config.schema), 'deployment_existing_installations_required')
  const external = installationReferences(config)
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
    qualify: async (_directory, _hash, verified) => {
      // Older candidates cannot consume native config. Refuse before selection
      // rather than activating an old entry and discovering it on next launch.
      if (isNativeRuntimeConfig(config)) demand(verified?.manifest?.native_runtime, 'deployment_native_connector_missing')
      if (isNativeRuntimeConfig(config) && config.transferConfigDir) demand(verified?.manifest?.native_transfer_directory_pair === true && verified.manifest.native_transfer_direct_cli === true, 'deployment_transfer_directories_unsupported')
      return { schema: 1, stateProfileSha256: programProfileHash }
    } })
  Object.assign(manager, { configFile, runtimeFile, configRaw, runtimeRaw })
  // Source-only test injection, not a public config/CLI proof provider.
  Object.assign(manager, { inspect, observe })
  manager.checkpoint = async phase => {
    await checkpoint?.(phase)
    if (phase === 'journal_file_synced') {
      await manager.retained?.reobserve()
      await manager.workBaseline?.()
    }
  }
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
    await manager.projectRoot(state.current)
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
  if (action === 'recover') return describe(await manager.recover(), manager.retained)
  if (action === 'install') {
    const initialized = await manager.initialize()
    if (initialized.state === 'deferred') return describe(initialized)
  }
  if (action !== 'rollback') {
    const staged = await manager.stage(options['--source'], target)
    if (staged.state === 'deferred') return describe(staged)
  }
  return describe(await manager.select(target, action), manager.retained)
}
