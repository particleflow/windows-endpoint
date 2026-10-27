// Connect the existing transaction journal to the portable foreground program.
// Official component paths, configuration and producer data are never switched.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { validateConfig, validateDirectory, isNativeRuntimeConfig, isWindowsUNCWorkspacePath } from './endpoint.mjs'
import { DeploymentTransactions, DeploymentError, deploymentLayout, hostReferenceLayout } from './deployment.mjs'
import { acquireLeases } from './lifecycle.mjs'
import { boundedRead, readSessionHistory } from './session-diagnostics.mjs'
import { captureSessionContinuation, verifySessionContinuation } from './session-continuation.mjs'
import { validateRuntimeRequest } from './runtime.mjs'
import { verifyCandidate, stageCandidate, programProfileHash } from './candidate.mjs'
import { attemptEvidence, nativeRecoveryEvidence, recoveryConfigurationHash } from './host-recovery.mjs'
import { inspectInstalled } from './installed.mjs'

const demand = (ok, code) => { if (!ok) throw new DeploymentError(code) }
const sha256 = value => createHash('sha256').update(value).digest('hex')
const hashValue = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)

// Preparing is not a permit to switch profile or start work. The owner must
// complete the later offline transition with the original evidence intact.
export async function prepareProfileSwitch({ root, requestId, profile, configurationSha256, lifecycleSha256, continuationSha256, attemptsSha256 }, { checkpoint = async () => {} } = {}) {
  demand(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId || '') &&
    [configurationSha256, lifecycleSha256, continuationSha256, attemptsSha256].every(hashValue), 'deployment_profile_switch_arguments_invalid')
  const manager = await programDeployment(root)
  demand(isNativeRuntimeConfig(manager.config), 'deployment_profile_switch_native_required')
  const next = validateConfig({ ...manager.config, piConfigDir: profile })
  demand(next.piConfigDir !== manager.config.piConfigDir && hostReferenceLayout(root, next).compatible, 'deployment_profile_switch_target_invalid')
  await validateDirectory(profile)
  return manager.locked(async () => {
    await manager.unchanged()
    const selection = await manager.read()
    demand(selection.pending === null && selection.current !== null, 'deployment_profile_switch_reader_unqualified')
    await manager.owned(selection, selection.current)
    // The selected normal launcher must already contain these exact guards;
    // a previous release would otherwise ignore the preparation marker.
    for (const name of ['endpoint.mjs', 'program-deployment.mjs', 'host.mjs']) {
      const current = await boundedRead(fileURLToPath(new URL(`./${name}`, import.meta.url)), 262144)
      const selected = await boundedRead(path.join(manager.layout.packages, selection.current, name), 262144)
      demand(current === selected, 'deployment_profile_switch_reader_unqualified')
    }
    const stateRaw = await boundedRead(manager.lifecycleStore.file, 262144)
    const state = await manager.lifecycleStore.load()
    demand(!state.handoff && state.sessionContinuation, 'deployment_profile_switch_checkpoint_required')
    await verifySessionContinuation(manager.config, state.sessionContinuation)
    const attempts = await attemptEvidence(manager.config)
    demand(sha256(manager.configRaw) === configurationSha256 && sha256(stateRaw) === lifecycleSha256 &&
      sha256(JSON.stringify(state.sessionContinuation)) === continuationSha256 && attempts === attemptsSha256, 'deployment_profile_switch_evidence_changed')
    const record = { schema: 1, state: 'prepared', requestId, configurationSha256, lifecycleSha256, continuationSha256, attemptsSha256, profile,
      authority: 'preparation_only', started: false, businessReplayed: false }
    const file = path.join(manager.lifecycleDirectory, 'profile-switch-pending.json')
    const desired = JSON.stringify(record) + '\n'
    const existing = await optional(file, 16384)
    if (existing !== null) {
      demand(existing === desired, 'deployment_profile_switch_pending_conflict')
      return { state: 'already_prepared', requestId, activation: 'blocked', businessReplayed: false }
    }
    await checkpoint('before_prepare')
    await manager.unchanged()
    demand(await boundedRead(manager.lifecycleStore.file, 262144) === stateRaw && await attemptEvidence(manager.config) === attempts, 'deployment_profile_switch_evidence_changed')
    const h = await fs.open(file, 'wx')
    try { await h.writeFile(desired); await h.sync() } finally { await h.close() }
    await checkpoint('prepared')
    await manager.unchanged()
    demand(await boundedRead(manager.lifecycleStore.file, 262144) === stateRaw && await attemptEvidence(manager.config) === attempts, 'deployment_profile_switch_evidence_changed')
    return { state: 'prepared', requestId, activation: 'blocked', businessReplayed: false }
  })
}

// Retain the old complete files before any later change. This archive is not
// authority for activation or evidence that NAS admission is paused.
export async function archiveProfileSwitch({ root, requestId }, { checkpoint = async () => {} } = {}) {
  demand(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId || ''), 'deployment_profile_switch_arguments_invalid')
  const manager = await programDeployment(root)
  demand(isNativeRuntimeConfig(manager.config), 'deployment_profile_switch_native_required')
  return manager.locked(async () => {
    await manager.unchanged()
    const markerFile = path.join(manager.lifecycleDirectory, 'profile-switch-pending.json')
    const markerRaw = await boundedRead(markerFile, 16384)
    let marker
    try { marker = JSON.parse(markerRaw) } catch { throw new DeploymentError('deployment_profile_switch_journal_invalid') }
    const fields = ['schema','state','requestId','configurationSha256','lifecycleSha256','continuationSha256','attemptsSha256','profile','authority','started','businessReplayed']
    demand(marker && Object.keys(marker).sort().join(',') === fields.sort().join(',') && marker.schema === 1 && marker.state === 'prepared' &&
      marker.requestId === requestId && marker.authority === 'preparation_only' && marker.started === false && marker.businessReplayed === false &&
      [marker.configurationSha256,marker.lifecycleSha256,marker.continuationSha256,marker.attemptsSha256].every(hashValue), 'deployment_profile_switch_journal_invalid')
    const stateRaw = await boundedRead(manager.lifecycleStore.file, 262144), state = await manager.lifecycleStore.load()
    demand(!state.handoff && state.sessionContinuation, 'deployment_profile_switch_checkpoint_required')
    await verifySessionContinuation(manager.config, state.sessionContinuation)
    demand(sha256(manager.configRaw) === marker.configurationSha256 && sha256(stateRaw) === marker.lifecycleSha256 &&
      sha256(JSON.stringify(state.sessionContinuation)) === marker.continuationSha256 &&
      await attemptEvidence(manager.config) === marker.attemptsSha256, 'deployment_profile_switch_evidence_changed')
    const archive = path.join(manager.lifecycleDirectory, 'profile-switch-history')
    await directory(archive)
    const check = async () => {
      await manager.unchanged()
      demand(await boundedRead(markerFile, 16384) === markerRaw && await boundedRead(manager.lifecycleStore.file, 262144) === stateRaw &&
        await attemptEvidence(manager.config) === marker.attemptsSha256, 'deployment_profile_switch_evidence_changed')
    }
    for (const [name, bytes] of [['configuration', manager.configRaw], ['lifecycle', stateRaw]]) {
      const target = path.join(archive, `${requestId}.${name}.json`)
      const temp = path.join(archive, `.${requestId}.${name}.tmp`)
      // A crash after link and before unlink leaves two names for our one
      // verified inode. Remove only that exact owned temporary name.
      const targetStat = await fs.lstat(target).catch(e => { if (e.code === 'ENOENT') return null; throw e })
      const tempStat = await fs.lstat(temp).catch(e => { if (e.code === 'ENOENT') return null; throw e })
      if (targetStat && tempStat) {
        demand(targetStat.isFile() && tempStat.isFile() && !targetStat.isSymbolicLink() && !tempStat.isSymbolicLink() &&
          targetStat.ino !== 0 && targetStat.dev === tempStat.dev && targetStat.ino === tempStat.ino && targetStat.nlink === 2 && tempStat.nlink === 2 &&
          targetStat.size === Buffer.byteLength(bytes), 'deployment_profile_switch_archive_conflict')
        const handle = await fs.open(temp, 'r')
        try { demand(await handle.readFile('utf8') === bytes && (await handle.stat()).ino === tempStat.ino, 'deployment_profile_switch_archive_conflict') }
        finally { await handle.close() }
        await check()
        const again = await fs.lstat(temp)
        demand(again.isFile() && !again.isSymbolicLink() && again.dev === tempStat.dev && again.ino === tempStat.ino && again.nlink === 2, 'deployment_profile_switch_archive_conflict')
        await fs.unlink(temp)
      }
      const existing = await optional(target, 262144)
      if (existing !== null) { demand(existing === bytes, 'deployment_profile_switch_archive_conflict'); continue }
      await check()
      const retained = await optional(temp, 262144)
      if (retained !== null) demand(retained === bytes, 'deployment_profile_switch_archive_conflict')
      else {
        const h = await fs.open(temp, 'wx')
        try { await h.writeFile(bytes); await h.sync() } finally { await h.close() }
      }
      // No overwrite of an existing archive, even if a foreign writer races.
      await fs.link(temp, target)
      await checkpoint(`linked_${name}`)
      await fs.unlink(temp)
      await checkpoint(`archived_${name}`)
      await check()
    }
    await check()
    return { state: 'old_files_archived', requestId, activation: 'blocked', businessReplayed: false, nasEvidence: 'not_checked' }
  })
}

// Local transaction only. An operator still owns the paused NAS gate and its
// target CAS; the pending marker stays in place until that separate handoff.
export async function commitProfileSwitch({ root, requestId, rollback = false }, { inspect = inspectInstalled, observe = nativeRecoveryEvidence, checkpoint = async () => {} } = {}) {
  demand(typeof rollback === 'boolean', 'deployment_profile_switch_arguments_invalid')
  demand(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId || ''), 'deployment_profile_switch_arguments_invalid')
  const manager = await programDeployment(root)
  demand(isNativeRuntimeConfig(manager.config), 'deployment_profile_switch_native_required')
  return manager.locked(async () => {
    const markerFile = path.join(manager.lifecycleDirectory, 'profile-switch-pending.json')
    const markerRaw = await boundedRead(markerFile, 16384)
    let marker
    try { marker = JSON.parse(markerRaw) } catch { throw new DeploymentError('deployment_profile_switch_journal_invalid') }
    const fields = ['schema','state','requestId','configurationSha256','lifecycleSha256','continuationSha256','attemptsSha256','profile','authority','started','businessReplayed']
    demand(marker && Object.keys(marker).sort().join(',') === fields.sort().join(',') && marker.schema === 1 && marker.state === 'prepared' && marker.requestId === requestId &&
      marker.authority === 'preparation_only' && marker.started === false && marker.businessReplayed === false &&
      [marker.configurationSha256,marker.lifecycleSha256,marker.continuationSha256,marker.attemptsSha256].every(hashValue), 'deployment_profile_switch_journal_invalid')
    const history = path.join(manager.lifecycleDirectory, 'profile-switch-history')
    const oldConfigRaw = await boundedRead(path.join(history, `${requestId}.configuration.json`), 262144)
    const oldStateRaw = await boundedRead(path.join(history, `${requestId}.lifecycle.json`), 262144)
    demand(sha256(oldConfigRaw) === marker.configurationSha256 && sha256(oldStateRaw) === marker.lifecycleSha256, 'deployment_profile_switch_archive_conflict')
    const oldConfig = validateConfig(JSON.parse(oldConfigRaw)), oldState = JSON.parse(oldStateRaw)
    demand(isNativeRuntimeConfig(oldConfig) && oldState.identity === oldConfig.deviceId && oldState.phase === 'stopped' && oldState.attention === null && !oldState.handoff && oldState.sessionContinuation &&
      sha256(JSON.stringify(oldState.sessionContinuation)) === marker.continuationSha256, 'deployment_profile_switch_checkpoint_required')
    await verifySessionContinuation(oldConfig, oldState.sessionContinuation)
    const newConfig = validateConfig({ ...oldConfig, piConfigDir: marker.profile })
    demand(hostReferenceLayout(root, newConfig).compatible && newConfig.piConfigDir !== oldConfig.piConfigDir, 'deployment_profile_switch_target_invalid')
    await validateDirectory(newConfig.piConfigDir)
    const newContinuation = await captureSessionContinuation(newConfig)
    demand(newContinuation.ordinary && newContinuation.configuration === oldState.sessionContinuation.configuration && newContinuation.snapshot === oldState.sessionContinuation.snapshot, 'deployment_profile_switch_evidence_changed')
    const newState = { ...oldState, sessionContinuation: newContinuation }
    // Previous infrastructure proof belongs to the old config. Its exact bytes
    // remain in the immutable archive; it cannot authorize the new generation.
    delete newState.infrastructureRecovery
    const newConfigRaw = JSON.stringify(newConfig, null, 2) + '\n', newStateRaw = JSON.stringify(newState) + '\n'
    const statusFile = path.join(manager.lifecycleDirectory, 'host-status.json')
    const statusRaw = await boundedRead(statusFile, 32768), status = JSON.parse(statusRaw)
    demand(status.schema === 1 && status.owner === 'windows-endpoint-host' && status.phase === 'stopped' && status.attention === null && Number.isSafeInteger(status.pid) && status.pid > 0, 'deployment_profile_switch_host_unverified')
    const inspected = await inspect(oldConfig, undefined, { inspectHistoryOnly: true })
    if (observe === nativeRecoveryEvidence) demand(path.resolve(process.execPath).toLowerCase() === path.resolve(inspected.config.programs.node).toLowerCase(), 'deployment_profile_switch_host_unverified')
    const files = { root, config: manager.configFile, runtime: manager.runtimeFile, state: manager.lifecycleStore.file, status: statusFile }
    const check = async () => {
      demand(await boundedRead(markerFile, 16384) === markerRaw && await boundedRead(statusFile, 32768) === statusRaw &&
        await boundedRead(manager.runtimeFile, 65536) === manager.runtimeRaw && await attemptEvidence(oldConfig) === marker.attemptsSha256 &&
        await boundedRead(path.join(history, `${requestId}.configuration.json`), 262144) === oldConfigRaw &&
        await boundedRead(path.join(history, `${requestId}.lifecycle.json`), 262144) === oldStateRaw, 'deployment_profile_switch_evidence_changed')
      await verifySessionContinuation(oldConfig, oldState.sessionContinuation)
      const c = await boundedRead(manager.configFile, 65536), s = await boundedRead(manager.lifecycleStore.file, 262144)
      demand([oldConfigRaw, newConfigRaw].includes(c) && [oldStateRaw, newStateRaw].includes(s), 'deployment_profile_switch_evidence_changed')
      inspected.assertUnchanged()
      const evidence = await observe({ config: inspected.config, status, files })
      demand(evidence?.ownerVerified === true && evidence.oldHostAbsent === true && evidence.referencedProcessesAbsent === true && evidence.herdrAbsent === true, 'deployment_profile_switch_host_unverified')
      return { c, s }
    }
    const publish = async (file, before, after, phase) => {
      if (before === after) return
      const temp = path.join(path.dirname(file), `.profile-switch-${randomUUID()}.tmp`)
      const handle = await fs.open(temp, 'wx')
      try { await handle.writeFile(after); await handle.sync() } finally { await handle.close() }
      await checkpoint(`${phase}_file_synced`)
      const current = await check()
      demand((file === manager.configFile ? current.c : current.s) === before, 'deployment_profile_switch_evidence_changed')
      await fs.rename(temp, file)
      await checkpoint(`${phase}_published`)
      await check()
    }
    const initial = await check()
    if (rollback) {
      await publish(manager.lifecycleStore.file, initial.s, oldStateRaw, 'lifecycle')
      const afterState = await check()
      await publish(manager.configFile, afterState.c, oldConfigRaw, 'configuration')
    } else {
      await publish(manager.configFile, initial.c, newConfigRaw, 'configuration')
      const afterConfig = await check()
      await publish(manager.lifecycleStore.file, afterConfig.s, newStateRaw, 'lifecycle')
    }
    const result = await check()
    const expectedConfig = rollback ? oldConfigRaw : newConfigRaw, expectedState = rollback ? oldStateRaw : newStateRaw
    demand(result.c === expectedConfig && result.s === expectedState, 'deployment_profile_switch_evidence_changed')
    return { state: rollback ? 'local_profile_rolled_back' : 'local_profile_prepared', requestId, activation: 'blocked', nasEvidence: 'not_checked', businessReplayed: false, configurationSha256: sha256(expectedConfig), lifecycleSha256: sha256(expectedState) }
  })
}
async function optional(file, limit = 65536) {
  try { return await boundedRead(file, limit) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

// Called by the existing trusted local owner maintenance process. The reader
// must use that process's authenticated Memoh owner client, never CLI receipts.
// No bearer token, remote write/retry, enrollment or new listener lives here.
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
      const g = observed?.admission, n = observed?.nativeHerdr
      demand(observed?.ownerId === ownerId && observed.runtimeId === runtimeId && observed.targetId === targetId &&
        n?.connection_id === runtimeId && n.device_id === runtimeId && n.instance_id === instanceId && n.session === manager.config.session && n.config_sha256 === configSha256 && n.target_fingerprint === targetFingerprint &&
        g?.connection_id === runtimeId && g.device_id === runtimeId && g.instance_id === instanceId && g.request_id === pauseRequestId &&
        g.scope === 'owner_connection_instance' && g.paused === true && g.revision === revision, 'deployment_profile_switch_owner_binding_changed')
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
    demand(!await exists(path.join(manager.lifecycleDirectory, 'profile-switch-pending.json')), 'deployment_profile_switch_recovery_required')
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
  const fields = ['install', 'update'].includes(action) ? ['--root', '--source', '--manifest-sha256'] : action === 'rollback' ? ['--root', '--manifest-sha256'] : action === 'prepare-profile' ? ['--root', '--request-id', '--profile', '--configuration-sha256', '--lifecycle-sha256', '--continuation-sha256', '--attempts-sha256'] : ['archive-profile','commit-profile','rollback-profile'].includes(action) ? ['--root', '--request-id'] : ['--root']
  demand(['install', 'update', 'rollback', 'recover', 'status', 'run', 'prepare-profile', 'archive-profile', 'commit-profile', 'rollback-profile'].includes(action) && Object.keys(options).sort().join(',') === fields.sort().join(','), 'deployment_arguments_invalid')
  const root = options['--root'], target = options['--manifest-sha256']
  if (action === 'prepare-profile') return prepareProfileSwitch({ root, requestId: options['--request-id'], profile: options['--profile'], configurationSha256: options['--configuration-sha256'], lifecycleSha256: options['--lifecycle-sha256'], continuationSha256: options['--continuation-sha256'], attemptsSha256: options['--attempts-sha256'] })
  if (action === 'archive-profile') return archiveProfileSwitch({ root, requestId: options['--request-id'] })
  if (action === 'commit-profile') return commitProfileSwitch({ root, requestId: options['--request-id'] })
  if (action === 'rollback-profile') return commitProfileSwitch({ root, requestId: options['--request-id'], rollback: true })
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
