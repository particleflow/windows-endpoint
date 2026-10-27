// Connect the existing transaction journal to the portable foreground program.
// Official component paths, configuration and producer data are never switched.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { validateConfig, validateDirectory, isNativeRuntimeConfig, isWindowsUNCWorkspacePath, requireNativeRuntime } from './endpoint.mjs'
import { DeploymentTransactions, DeploymentError, deploymentLayout, hostReferenceLayout, readDeploymentState } from './deployment.mjs'
import { acquireLeases } from './lifecycle.mjs'
import { boundedRead, readSessionHistory } from './session-diagnostics.mjs'
import { captureSessionContinuation, verifySessionContinuation } from './session-continuation.mjs'
import { validateRuntimeRequest } from './runtime.mjs'
import { verifyCandidate, stageCandidate, programProfileHash } from './candidate.mjs'
import { attemptEvidence, nativeRecoveryEvidence, recoveryConfigurationHash } from './host-recovery.mjs'
import { inspectInstalled } from './installed.mjs'
import { nativePiCatalogHostOptions, prepareNativePiCatalogReference } from './pi-native-catalog-profile.mjs'
import { nativeCatalogPendingName, publishNativeCatalogReference } from './pi-native-catalog-transaction.mjs'

const demand = (ok, code) => { if (!ok) throw new DeploymentError(code) }
const piCatalogDigest = value => createHash('sha256').update(value).digest('hex')

// Explicit stopped transaction: install only a nonsecret native resource
// reference in the ALREADY selected profile. Never repair/start/replace a Pi.
export async function prepareNativePiCatalog({root,requestId,providerId,intervalMs=60000}, {checkpoint=async()=>{},...options}={}) {
  demand(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId||'') &&
    /^[A-Za-z0-9_.-]{1,100}$/.test(providerId||'') && Number.isSafeInteger(intervalMs) && intervalMs>=1000,'deployment_pi_catalog_arguments_invalid')
  const manager=await programDeployment(root,options)
  return manager.locked(async()=>{
    try {
      await manager.unchanged()
      demand(!await exists(path.join(manager.lifecycleDirectory,'profile-switch-pending.json')),'deployment_profile_switch_recovery_required')
      const state=await manager.read()
      demand(state.pending===null&&state.current!==null,'deployment_recovery_required')
      const owned=await manager.owned(state,state.current)
      demand(owned.profile===programProfileHash,'deployment_state_profile_changed')
      const reason=await manager.work(programProfileHash)
      if(reason)return {state:'deferred',reason,activation:'blocked',businessReplayed:false}
      const packageRoot=path.join(manager.layout.packages,state.current)
      const verified=await manager.verify(packageRoot,state.current)
      const settingsFile=path.join(manager.config.piConfigDir,'settings.json'),modelsFile=path.join(manager.config.piConfigDir,'models.json')
      const settingsOriginal=await optional(settingsFile,262144),modelsRaw=await optional(modelsFile,1048576)
      demand(modelsRaw!==null,'catalog_existing_provider_required')
      const plan=await prepareNativePiCatalogReference({profileDir:manager.config.piConfigDir,packageRoot,manifest:verified.manifest,
        settingsRaw:settingsOriginal??'{}',modelsRaw,providerId,intervalMs})
      const selectionRaw=await boundedRead(manager.file,262144),lifecycleRaw=await optional(manager.lifecycleStore.file,262144)
      const record={requestId,selected:state.current,profileDir:manager.config.piConfigDir,providerId,intervalMs,
        settingsSha256:settingsOriginal===null?null:piCatalogDigest(settingsOriginal),modelsSha256:piCatalogDigest(modelsRaw),
        configurationSha256:piCatalogDigest(manager.configRaw),lifecycleSha256:lifecycleRaw===null?null:piCatalogDigest(lifecycleRaw),selectionSha256:piCatalogDigest(selectionRaw)}
      const assertUnchanged=async()=>{
        await manager.unchanged();await manager.workBaseline?.();await manager.retained?.reobserve()
        demand(!await exists(path.join(manager.lifecycleDirectory,'profile-switch-pending.json')),'deployment_profile_switch_recovery_required')
        demand(await boundedRead(manager.file,262144)===selectionRaw&&await optional(manager.lifecycleStore.file,262144)===lifecycleRaw&&
          await optional(settingsFile,262144)===settingsOriginal&&await boundedRead(modelsFile,1048576)===modelsRaw,'catalog_native_preparation_changed')
        await manager.verify(packageRoot,state.current)
      }
      const result=await publishNativeCatalogReference({lifecycleDirectory:manager.lifecycleDirectory,plan,record,assertUnchanged,checkpoint})
      return {state:result,providerId,profile:manager.config.piConfigDir,activation:'future_pi_invocations_only',processStarted:false,businessReplayed:false}
    }catch(error){if(/^catalog_[a-z_]+$/.test(error.code??error.message))throw new DeploymentError(error.code??error.message);throw error}
  })
}
async function optional(file, limit = 65536) {
  try { return await boundedRead(file, limit) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

// Called by the existing trusted local owner maintenance process. The reader
// must use that process's authenticated Memoh owner client, never CLI receipts.
// No bearer token, remote write/retry, enrollment or new listener lives here.
export function createOwnerAdmissionReader({ sdk, client, botId }) {
  demand(client && /^[a-f0-9-]{36}$/.test(botId || '') &&
    ['getUsersMe','getBotsByBotIdWorkspaceTargets','getUsersMeRuntimesByIdAdmission'].every(name => typeof sdk?.[name] === 'function'), 'deployment_profile_switch_owner_client_required')
  return async ({ ownerId, runtimeId, targetId }) => {
    const get = async (name, path) => {
      let result
      try { result = await sdk[name]({ client, ...(path ? { path } : {}), signal: AbortSignal.timeout(10000), throwOnError: true }) }
      catch { throw new DeploymentError('deployment_profile_switch_owner_observation_unknown') }
      demand(result?.response?.status === 200 && !result.error && result.data && typeof result.data === 'object', 'deployment_profile_switch_owner_observation_unknown')
      return result.data
    }
    const user = await get('getUsersMe')
    demand(user.id === ownerId && user.is_active !== false && user.membership_is_active !== false && user.principal_is_active !== false, 'deployment_profile_switch_owner_binding_changed')
    const targets = await get('getBotsByBotIdWorkspaceTargets', { bot_id: botId })
    const matches = Array.isArray(targets.targets) ? targets.targets.filter(target => target.target_id === targetId) : []
    demand(matches.length === 1 && matches[0].runtime_id === runtimeId && matches[0].provider === 'memoh' && matches[0].kind === 'remote', 'deployment_profile_switch_owner_binding_changed')
    const admission = await get('getUsersMeRuntimesByIdAdmission', { id: runtimeId })
    return { ownerId: user.id, runtimeId, targetId, admission }
  }
}

// Recovery after an uncertain owner PUT: query only, and adopt CAS facts only
// when the atomic snapshot names the intended local profile and original pause.
export async function reconcileProfileSwitchWithOwner(options, { sdk, client, botId, checkpoint } = {}) {
  const readOwnerState = createOwnerAdmissionReader({ sdk, client, botId })
  const manager = await programDeployment(options.root)
  const observed = await readOwnerState(options), g = observed.admission
  demand(g?.connection_id === options.runtimeId && g.device_id === options.runtimeId && g.instance_id === options.instanceId &&
    g.request_id === options.pauseRequestId && g.scope === 'owner_connection_instance' && g.paused === true &&
    g.agent_config_dir === manager.config.piConfigDir && hashValue(g.config_sha256) && hashValue(g.target_fingerprint) &&
    typeof g.revision === 'string' && /^[1-9][0-9]{0,18}$/.test(g.revision) && typeof options.previousRevision === 'string' &&
    /^[1-9][0-9]{0,18}$/.test(options.previousRevision) && BigInt(g.revision) === BigInt(options.previousRevision) + 1n,
  'deployment_profile_switch_owner_binding_changed')
  return reconcileProfileSwitch({ ...options, revision: g.revision, configSha256: g.config_sha256, targetFingerprint: g.target_fingerprint }, { readOwnerState, checkpoint })
}

export async function reconcileProfileSwitch({ root, requestId, direction, ownerId, targetId, runtimeId, instanceId, pauseRequestId,
  previousRevision, revision, configSha256, targetFingerprint, localConfigSha256, localLifecycleSha256 }, { readOwnerState, checkpoint = async () => {} } = {}) {
  demand(typeof readOwnerState === 'function', 'deployment_profile_switch_owner_client_required')
  const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value) && value !== '00000000-0000-0000-0000-000000000000'
  const decimal = value => typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n
  demand([requestId,ownerId,targetId,runtimeId,pauseRequestId].every(uuid) && ['commit','rollback'].includes(direction) &&
    typeof instanceId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(instanceId) && [configSha256,targetFingerprint,localConfigSha256,localLifecycleSha256].every(hashValue) &&
    decimal(previousRevision) && decimal(revision) && BigInt(revision) === BigInt(previousRevision) + 1n, 'deployment_profile_switch_reconciliation_invalid')
  const manager = await programDeployment(root)
  demand(isNativeRuntimeConfig(manager.config) && runtimeId === manager.config.runtimeId && instanceId === manager.config.instanceId, 'deployment_profile_switch_reconciliation_invalid')
  return manager.locked(async () => {
    const pending = path.join(manager.lifecycleDirectory, 'profile-switch-pending.json')
    const history = path.join(manager.lifecycleDirectory, 'profile-switch-history')
    const completed = path.join(history, `${requestId}.completed-pending.json`)
    const pendingRaw = await optional(pending, 16384), completedRaw = await optional(completed, 16384)
    demand(pendingRaw !== null || completedRaw !== null, 'deployment_profile_switch_checkpoint_required')
    demand(completedRaw === null || pendingRaw === null, 'deployment_profile_switch_pending_conflict')
    const markerRaw = pendingRaw ?? completedRaw, marker = JSON.parse(markerRaw)
    demand(marker.schema === 1 && marker.state === 'prepared' && marker.requestId === requestId && marker.authority === 'preparation_only' &&
      marker.started === false && marker.businessReplayed === false &&
      [marker.configurationSha256,marker.lifecycleSha256,marker.continuationSha256,marker.attemptsSha256].every(hashValue), 'deployment_profile_switch_journal_invalid')
    const oldConfigRaw = await boundedRead(path.join(history, `${requestId}.configuration.json`), 262144)
    const oldStateRaw = await boundedRead(path.join(history, `${requestId}.lifecycle.json`), 262144)
    demand(sha256(oldConfigRaw) === marker.configurationSha256 && sha256(oldStateRaw) === marker.lifecycleSha256, 'deployment_profile_switch_archive_conflict')
    const oldConfig = validateConfig(JSON.parse(oldConfigRaw))
    const expected = { ...oldConfig, piConfigDir: direction === 'commit' ? marker.profile : oldConfig.piConfigDir }
    demand(JSON.stringify(manager.config) === JSON.stringify(expected), 'deployment_profile_switch_evidence_changed')
    const receipt = { schema: 1, requestId, direction, ownerId, targetId, runtimeId, instanceId, pauseRequestId, previousRevision, revision,
      configSha256, targetFingerprint, localConfigSha256, localLifecycleSha256, pendingSha256: sha256(markerRaw), businessReplayed: false }
    const receiptFile = path.join(history, `${requestId}.owner-reconciliation.json`), desired = JSON.stringify(receipt) + '\n'
    const receiptRaw = await optional(receiptFile, 16384)
    demand(receiptRaw === null || receiptRaw === desired, 'deployment_profile_switch_pending_conflict')
    const checkLocal = async () => {
      await manager.unchanged()
      const raw = await boundedRead(manager.lifecycleStore.file, 262144), state = await manager.lifecycleStore.load()
      demand(state.phase === 'stopped' && state.attention === null && !state.handoff && sha256(manager.configRaw) === localConfigSha256 &&
        sha256(raw) === localLifecycleSha256 && await attemptEvidence(oldConfig) === marker.attemptsSha256, 'deployment_profile_switch_evidence_changed')
      await verifySessionContinuation(manager.config, state.sessionContinuation)
      demand(await boundedRead(path.join(history, `${requestId}.configuration.json`), 262144) === oldConfigRaw &&
        await boundedRead(path.join(history, `${requestId}.lifecycle.json`), 262144) === oldStateRaw &&
        await optional(pendingRaw === null ? completed : pending, 16384) === markerRaw, 'deployment_profile_switch_evidence_changed')
    }
    const checkRemote = async () => {
      // This projection is produced by authenticated owner GETs (owned runtime,
      // its target mount and admission). No PUT is dispatched on any outcome.
      let observed
      try { observed = await readOwnerState({ ownerId, runtimeId, targetId }) }
      catch { throw new DeploymentError('deployment_profile_switch_owner_observation_unknown') }
      const g = observed?.admission
      demand(observed?.ownerId === ownerId && observed.runtimeId === runtimeId && observed.targetId === targetId &&
        g?.connection_id === runtimeId && g.device_id === runtimeId && g.instance_id === instanceId && g.request_id === pauseRequestId &&
        g.scope === 'owner_connection_instance' && g.paused === true && g.revision === revision &&
        g.config_sha256 === configSha256 && g.target_fingerprint === targetFingerprint && g.agent_config_dir === manager.config.piConfigDir, 'deployment_profile_switch_owner_binding_changed')
    }
    await checkLocal(); await checkRemote(); await checkLocal()
    if (receiptRaw === null) {
      const temporary = path.join(history, `.owner-reconciliation-${randomUUID()}.tmp`)
      const handle = await fs.open(temporary, 'wx')
      try { await handle.writeFile(desired); await handle.sync() } finally { await handle.close() }
      await checkpoint('owner_receipt_synced')
      await checkLocal(); await checkRemote()
      demand(await optional(receiptFile, 16384) === null, 'deployment_profile_switch_pending_conflict')
      await fs.rename(temporary, receiptFile)
    }
    await checkpoint('owner_receipt_published')
    await checkLocal(); await checkRemote(); await checkLocal()
    demand(await boundedRead(receiptFile, 16384) === desired, 'deployment_profile_switch_pending_conflict')
    if (pendingRaw !== null) {
      demand(await optional(completed, 16384) === null, 'deployment_profile_switch_pending_conflict')
      await fs.rename(pending, completed)
    }
    await checkpoint('profile_reconciled')
    return { state: 'profile_reconciled', requestId, admission: 'still_paused', revision, started: false, businessReplayed: false }
  })
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
    const recheckedStoppedObservation = recovery.previousPhase === 'stopped' && recovery.previousAttention === 'herdr_observation_unknown' &&
      status.phase === 'stopped' && status.attention === recovery.previousAttention && status.runId === recovery.run
    if (status.schema !== 1 || status.owner !== 'windows-endpoint-host' || (status.phase !== 'stopped' && !recheckedRunning) || status.attention !== null && !recheckedStoppedObservation ||
        !/^[a-f0-9-]{36}$/.test(status.runId) || !Number.isSafeInteger(status.pid) || status.pid < 1 || !Number.isSafeInteger(status.updatedAt)) return 'task_handoff_unverified'
    let backupFile, backupRaw
    if (recheckedRunning || recheckedStoppedObservation) {
      backupFile = path.join(this.lifecycleDirectory, `lifecycle-before-recheck-${recovery.fromState}.json`)
      backupRaw = await boundedRead(backupFile, 262144)
      const original = JSON.parse(backupRaw)
      demand(createHash('sha256').update(backupRaw).digest('hex') === recovery.fromState && original.identity === this.config.deviceId &&
        original.phase === recovery.previousPhase && original.attention === recovery.previousAttention && !original.handoff, 'deployment_retained_recovery_mismatch')
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
    const unc = isWindowsUNCWorkspacePath(this.config.sourceRoot)
    let verified
    // Check reader capability before attempting platform-specific path checks.
    if (unc) {
      verified = await this.verify(path.join(this.layout.packages, target), target)
      demand(verified.manifest.workspace_unc_source_root === true, 'deployment_unc_workspace_unsupported')
    }
    const central = hostReferenceLayout(this.root, this.config).references.some(entry => entry.centralized)
    if (!isNativeRuntimeConfig(this.config) && !unc && !central) return
    verified ||= await this.verify(path.join(this.layout.packages, target), target)
    if (central) demand(verified.manifest.central_component_data === true, 'deployment_central_data_unsupported')
    // Once a stable product entry is installed, selecting an older program
    // without its CLI protocol would strand dependency/recovery commands.
    if (await optional(path.join(this.layout.control,'installation.json')) !== null)
      demand(verified.manifest.stable_installation_entry === 1, 'deployment_stable_entry_unsupported')
    if (!isNativeRuntimeConfig(this.config)) return
    demand(verified.manifest.native_runtime, 'deployment_native_connector_missing')
    demand(verified.manifest.native_runtime_project_root, 'deployment_native_project_root_unsupported')
    const lifecycle = await this.lifecycleStore.load()
    if (lifecycle.infrastructureRecovery?.previousPhase === 'running') demand(verified.manifest.native_running_recovery === true, 'deployment_running_recovery_unsupported')
    if (lifecycle.infrastructureRecovery?.previousPhase === 'stopped') demand(verified.manifest.native_stopped_observation_recovery === true, 'deployment_stopped_recovery_unsupported')
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
    if (await exists(path.join(this.lifecycleDirectory, 'profile-switch-pending.json'))) return 'deployment_profile_switch_recovery_required'
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
      await validateDirectory(attempts, { workspace: true })
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
    await this.freezeWork(state, marker)
    return null
  }
}

export async function programDeployment(root, { prepare = false, io = fs, checkpoint, inspect = inspectInstalled, observe = nativeRecoveryEvidence } = {}) {
  const layout = deploymentLayout(root)
  await validateDirectory(root); await validateDirectory(layout.config)
  const configFile = path.join(layout.config, 'endpoint.json'), runtimeFile = path.join(layout.config, 'runtime.json')
  const configRaw = await optional(configFile)
  demand(configRaw !== null, 'deployment_configuration_missing')
  let config
  try { config = JSON.parse(configRaw) }
  catch { throw new DeploymentError('deployment_configuration_invalid') }
  requireNativeRuntime(config) // Before runtime-file reads, preparation or selector writes.
  const runtimeRaw = await optional(runtimeFile)
  try { validateConfig(config); if (runtimeRaw !== null) validateRuntimeRequest(JSON.parse(runtimeRaw), config) }
  catch { throw new DeploymentError('deployment_configuration_invalid') }
  demand(hostReferenceLayout(root, config).compatible, 'deployment_reference_overlap')
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
      demand(verified?.manifest?.native_runtime, 'deployment_native_connector_missing')
      if (config.transferConfigDir) demand(verified?.manifest?.native_transfer_directory_pair === true && verified.manifest.native_transfer_direct_cli === true, 'deployment_transfer_directories_unsupported')
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

export async function runSelectedProgram(root, { input = process.stdin, output = process.stdout, requestedPiCatalogProvider=null, piCatalogBinding=null } = {}) {
  demand(piCatalogBinding===null,'deployment_pi_catalog_file_sync_retired')
  const manager = await programDeployment(root)
  // Carry one host lease through verification, import and the existing host's
  // full lifetime. Never leave a selection/start race or launch a second daemon.
  const acquired = await acquireLeases([`host:${root}`], manager.lifecycleDirectory)
  let released = false
  const release = async () => { if (!released) { await acquired(); released = true } }
  try {
    await manager.unchanged()
    demand(!await exists(path.join(manager.lifecycleDirectory,'profile-switch-pending.json')),'deployment_profile_switch_recovery_required')
    demand(!await exists(path.join(manager.lifecycleDirectory,nativeCatalogPendingName)),'deployment_pi_catalog_recovery_required')
    const state = await manager.read()
    demand(state.pending === null, 'deployment_recovery_required')
    demand(state.current !== null, 'deployment_not_installed')
    const owned = await manager.owned(state, state.current)
    await manager.projectRoot(state.current)
    demand(owned.profile === programProfileHash, 'deployment_state_profile_changed')
    await manager.unchanged()
    const packageRoot=path.join(manager.layout.packages,state.current)
    const verified=await manager.verify(packageRoot,state.current)
    let catalogOptions
    try { catalogOptions=await nativePiCatalogHostOptions({config:manager.config,packageRoot,manifest:verified.manifest,requestedProviderId:requestedPiCatalogProvider}) }
    catch(error){throw new DeploymentError(/^catalog_[a-z_]+$/.test(error.message)?error.message:'deployment_pi_catalog_invalid')}
    const { runForeground, piNativeCatalogBindingVersion } = await import(pathToFileURL(path.join(packageRoot,'host.mjs')))
    if(catalogOptions.piNativeCatalog)demand(piNativeCatalogBindingVersion===1,'deployment_pi_native_catalog_unsupported')
    await manager.unchanged()
    return await runForeground({ root, input, output, inheritedHostLease: release,
      piNativeCatalog:catalogOptions.piNativeCatalog,requestedPiCatalogProvider })
  } finally { await release() }
}

export async function programDeploymentMain(args) {
  const [action, ...rest] = args, options = {}
  for (let i = 0; i < rest.length; i += 2) {
    demand(/^--[a-z][a-z0-9-]*$/.test(rest[i]) && typeof rest[i + 1] === 'string' && !Object.hasOwn(options, rest[i]), 'deployment_arguments_invalid')
    options[rest[i]] = rest[i + 1]
  }
  const fields = ['install', 'update'].includes(action) ? ['--root', '--source', '--manifest-sha256'] : action === 'rollback' ? ['--root', '--manifest-sha256'] : action==='prepare-pi-catalog'?['--root','--request-id','--provider']:['--root']
  if(action==='run'&&Object.hasOwn(options,'--pi-catalog-provider')) {
    demand(/^[A-Za-z0-9_.-]{1,100}$/.test(options['--pi-catalog-provider']),'deployment_arguments_invalid')
    fields.push('--pi-catalog-provider')
  }
  if(action==='prepare-pi-catalog'&&Object.hasOwn(options,'--interval-ms'))fields.push('--interval-ms')
  demand(['install', 'update', 'rollback', 'recover', 'status', 'run','prepare-pi-catalog'].includes(action) && Object.keys(options).sort().join(',') === fields.sort().join(','), 'deployment_arguments_invalid')
  const root = options['--root'], target = options['--manifest-sha256']
  if(action==='prepare-pi-catalog')return prepareNativePiCatalog({root,requestId:options['--request-id'],providerId:options['--provider'],intervalMs:options['--interval-ms']===undefined?60000:Number(options['--interval-ms'])})
  if (action === 'run') return { hostExitCode: await runSelectedProgram(root,{requestedPiCatalogProvider:options['--pi-catalog-provider']??null}) }
  if (action === 'status') {
    const config = validateConfig(JSON.parse(await boundedRead(path.join(deploymentLayout(root).config, 'endpoint.json'), 65536)))
    if (!isNativeRuntimeConfig(config)) {
      const state = await readDeploymentState(deploymentLayout(root), config.deviceId)
      return { state: 'retired-history-only', selected: state.current, previous: state.previous, pending: state.pending,
        ownedPackages: state.packages.map(p => p.hash), activation: 'blocked', executionPermitted: false, evidence: 'saved_deployment_journal_only' }
    }
  }
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
