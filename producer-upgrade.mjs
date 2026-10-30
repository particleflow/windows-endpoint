// Offline host/producer publication. No producer command, queue mutation,
// credential read, official Agent edit, admission change or process control.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { validateConfig, validateDirectory, transferLocations, catalog } from './endpoint.mjs'
import { boundedRead } from './session-diagnostics.mjs'
import { producerSessionTransition, verifySessionContinuation } from './session-continuation.mjs'
import { verifyCandidate, verifyRecordedCandidate, historicalProducer, explicitFilenameProducer, receiptObservationProducer, receiptBindingProducer, endpointRouteProducer, programProfileHash } from './candidate.mjs'
import { attemptEvidence, nativeRecoveryEvidence, recoveryConfigurationHash, verifyReplacementSecurity } from './host-recovery.mjs'
import { producerReferenceAdapter } from './producer-reference.mjs'
import { validateRuntimeRequest } from './runtime.mjs'

export const producerPendingName = 'producer-upgrade-pending.json'
const sha = value => createHash('sha256').update(value).digest('hex')
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const fail = code => { throw Object.assign(new Error(code), { code }) }
const demand = (value, code = 'producer_upgrade_evidence_changed') => { if (!value) fail(code) }
const encode = value => JSON.stringify(value) + '\n'
const stamp = st => ['dev','ino','size','mtimeNs','ctimeNs','mode'].map(key => String(st[key])).join(':')
async function snapshot(file, limit) {
  const before = await fs.lstat(file,{bigint:true}), raw = await boundedRead(file,limit)
  const version = stamp(before)
  demand(stamp(await fs.lstat(file,{bigint:true})) === version)
  return {raw,version}
}
// HostBinding includes these exact nonsecret bytes. Never parse/reserialize
// transfer.json, read device.credential, or adopt a new baseline on recovery.
async function transferConfigurationEvidence(config) {
  const file = path.join(transferLocations(config).config,'transfer.json'), limit = 8192
  await validateDirectory(path.dirname(file))
  const before = await fs.lstat(file,{bigint:true}), version = stamp(before)
  demand(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n && before.ino !== 0n && before.size <= BigInt(limit), 'producer_upgrade_transfer_configuration_unsafe')
  const handle = await fs.open(file,'r')
  try {
    demand(stamp(await handle.stat({bigint:true})) === version,'producer_upgrade_transfer_configuration_changed')
    const bytes = Buffer.alloc(limit+1)
    let length = 0
    while (length < bytes.length) {
      const {bytesRead} = await handle.read(bytes,length,bytes.length-length,length)
      if (!bytesRead) break
      length += bytesRead
    }
    demand(length <= limit && stamp(await handle.stat({bigint:true})) === version && stamp(await fs.lstat(file,{bigint:true})) === version, 'producer_upgrade_transfer_configuration_changed')
    return {sha256:sha(bytes.subarray(0,length)),version}
  } finally { await handle.close() }
}
const validTransferEvidence = value => value && Object.keys(value).sort().join(',') === 'sha256,version' && hash(value.sha256) &&
  typeof value.version === 'string' && value.version.length <= 256 && /^-?\d+(?::-?\d+){5}$/.test(value.version)
async function assertTransferConfiguration(config, expected) {
  demand(validTransferEvidence(expected),'producer_upgrade_transfer_configuration_unrecorded')
  const current = await transferConfigurationEvidence(config)
  demand(current.sha256 === expected.sha256 && current.version === expected.version,'producer_upgrade_transfer_configuration_changed')
}
async function optional(file, limit = 262144) {
  try { return await boundedRead(file, limit) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}
async function exclusive(file, raw) {
  const handle = await fs.open(file, 'wx', 0o600)
  try { await handle.writeFile(raw); await handle.sync() } finally { await handle.close() }
  return stamp(await fs.lstat(file,{bigint:true}))
}
async function retain(file, raw) {
  const existing = await optional(file)
  if (existing !== null) demand(existing === raw, 'producer_upgrade_archive_conflict')
  else await exclusive(file, raw)
}
const history = (manager, requestId) => path.join(manager.lifecycleDirectory, 'producer-upgrade-history', requestId)
const planLimit = 65536
// The public factory never loads an adapter/policy from config or CLI JSON.
const referenceFor = manager => manager.producerReference || producerReferenceAdapter

// Opaque metadata only: never open journal payloads, credentials, or unknown
// files. A changed inode/size/ctime, unknown link, or excessive tree refuses the
// transaction. The producer keeps sole ownership of every queue record.
export async function producerStateEvidence(config) {
  const root = transferLocations(config).state, entries = []
  async function walk(directory, relative = '') {
    await validateDirectory(directory)
    entries.push([relative, 'directory', stamp(await fs.lstat(directory,{bigint:true}))])
    for (const item of (await fs.readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, item.name), name = relative + item.name
      const st = await fs.lstat(file, { bigint: true })
      demand(!st.isSymbolicLink() && (st.isDirectory() || st.isFile() && st.nlink === 1n) && st.ino !== 0n, 'producer_upgrade_state_unsafe')
      demand(entries.length < 10000, 'producer_upgrade_state_too_large')
      if (st.isDirectory()) await walk(file, name + '/')
      else entries.push([name, ...['dev','ino','size','mtimeNs','ctimeNs','mode'].map(key => String(st[key]))])
    }
  }
  await walk(root)
  return sha(JSON.stringify(entries))
}

async function registryEvidence(config) {
  demand(Object.hasOwn(config, 'transferConfigDir') && Object.hasOwn(config, 'transferStateDir'), 'producer_upgrade_direct_cli_required')
  const raw = await optional(path.join(config.herdrConfigRoot, 'plugins.json'), 262144)
  if (raw !== null) {
    let registry
    try { registry = JSON.parse(raw) } catch { fail('producer_upgrade_registration_unknown') }
    demand(Array.isArray(registry), 'producer_upgrade_registration_unknown')
    const selected = registry.filter(item => item?.plugin_id === 'memoh.delivery')
    demand(selected.length <= 1 && selected.every(item => item.enabled === false), 'producer_upgrade_old_hook_enabled')
  }
  return raw === null ? null : sha(raw)
}
async function producerProof(verified, directory) {
  const proof = JSON.parse(await boundedRead(path.join(directory, 'transfer/SHA256SUMS.json'), 65536))
  const files = verified.manifest.files.filter(file => file.path.startsWith('transfer/') && file.path !== 'transfer/SHA256SUMS.json')
  demand(proof.source_commit === verified.manifest.producer_commit && proof.arch === 'amd64' && Array.isArray(proof.files) &&
    proof.files.length === files.length && new Set(proof.files.map(file => file.name)).size === files.length && proof.files.every(file =>
      Object.keys(file).sort().join(',') === 'name,sha256' && files.some(expected => expected.path === `transfer/${file.name}` && expected.sha256 === file.sha256)), 'producer_upgrade_provenance_mismatch')
}
async function originals(manager, requestId) {
  const dir = history(manager, requestId), raw = await boundedRead(path.join(dir, 'plan.json'), planLimit)
  const plan = JSON.parse(raw)
  demand(validTransferEvidence(plan.transferConfiguration),'producer_upgrade_transfer_configuration_unrecorded')
  demand(Object.keys(plan).sort().join(',') === ['schema','requestId','from','target','configuration','lifecycle','selection','nextConfiguration','continuation','attempts','queue','runtime','status','registration','transferConfiguration',...(plan.schema===3?['producerSource']:[])].sort().join(',') &&
    [2,3].includes(plan.schema) && plan.requestId === requestId && [plan.from,plan.target,plan.attempts,plan.queue,plan.configuration,plan.lifecycle,plan.selection,plan.nextConfiguration,plan.status].every(hash) &&
    (plan.runtime === null || hash(plan.runtime)) && (plan.registration === null || hash(plan.registration)), 'producer_upgrade_plan_invalid')
  const read = async name => boundedRead(path.join(dir, name + '.json'), 262144)
  const [configuration,lifecycle,selection] = await Promise.all(['configuration','lifecycle','selection'].map(read))
  demand(sha(configuration) === plan.configuration && sha(lifecycle) === plan.lifecycle && sha(selection) === plan.selection, 'producer_upgrade_archive_conflict')
  const before = validateConfig(JSON.parse(configuration)), state = JSON.parse(lifecycle), selected = JSON.parse(selection)
  const after = structuredClone(before)
  after.transfer.pluginRoot = path.join(manager.layout.packages, plan.target, 'transfer')
  validateConfig(after)
  const configurationAfter = encode(after)
  demand(sha(configurationAfter) === plan.nextConfiguration, 'producer_upgrade_plan_invalid')
  if (plan.schema===3) referenceFor(manager).validate(plan.producerSource,selected,before,manager.layout)
  else demand(before.transfer.pluginRoot === path.join(manager.layout.packages, plan.from, 'transfer'),'producer_upgrade_plan_invalid')
  const nextContinuation = await producerSessionTransition(before, after, state.sessionContinuation)
  demand(JSON.stringify(nextContinuation) === JSON.stringify(plan.continuation), 'producer_upgrade_evidence_changed')
  await assertTransferConfiguration(before,plan.transferConfiguration)
  const pointer = { schema: 1, requestId, planSha256: sha(raw) }
  const finalState = { ...state, sessionContinuation: nextContinuation, producerUpgrade: pointer }
  return { dir, raw, plan, before, after, state, selected, configuration, lifecycle, selection, configurationAfter,
    lifecycleAfter: encode(finalState), fence: encode({ ...state, attention: 'producer_upgrade_pending' }),
    nextFence: encode({ ...finalState, attention: 'producer_upgrade_pending' }),
    selectionFence: encode({ ...selected, pending: { kind: 'switch', from: plan.from, to: plan.target, phase: 'prepared' } }),
    selectionAfter: encode({ ...selected, current: plan.target, previous: plan.from, pending: null }) }
}

// Validate a derived continuation against its archived ORIGINAL checkpoint and
// configuration. The infrastructure recovery hash remains historical, unchanged.
export async function verifyProducerTransition(manager, state) {
  const pointer = state.producerUpgrade
  if (!pointer || Object.keys(pointer).sort().join(',') !== 'planSha256,requestId,schema' || pointer.schema !== 1 || !uuid(pointer.requestId) || !hash(pointer.planSha256)) return false
  const record = await originals(manager, pointer.requestId)
  if (record.plan.schema===3) {
    demand(await optional(path.join(manager.lifecycleDirectory,producerPendingName),16384)===null,'producer_upgrade_evidence_changed')
    demand(await optional(path.join(record.dir,'rollback.json'),16384)===null,'producer_upgrade_evidence_changed')
    demand(await boundedRead(path.join(record.dir,'upgrade-ready.json'),16384)===encode({schema:1,requestId:pointer.requestId,planSha256:sha(record.raw),direction:'upgrade',state:'joint_publication_verified'}),'producer_upgrade_evidence_changed')
  }
  const valid = sha(record.raw) === pointer.planSha256 && manager.configRaw === record.configurationAfter &&
    JSON.stringify(state.sessionContinuation) === JSON.stringify(record.plan.continuation) &&
    JSON.stringify(state.infrastructureRecovery) === JSON.stringify(record.state.infrastructureRecovery) &&
    record.state.infrastructureRecovery?.configuration === recoveryConfigurationHash(record.configuration, manager.runtimeRaw) &&
    await attemptEvidence(record.before) === record.plan.attempts && await producerStateEvidence(record.before) === record.plan.queue
  await assertTransferConfiguration(record.before,record.plan.transferConfiguration)
  return valid
}

async function stoppedEvidence(manager, before, state, status, producerRoots, configurationRaw, runtimeRaw, additional = []) {
  demand(state.phase === 'stopped' && state.attention === null && !state.handoff && state.sessionContinuation, 'producer_upgrade_stop_unverified')
  demand(status.schema === 1 && status.owner === 'windows-endpoint-host' && uuid(status.runId) && Number.isSafeInteger(status.pid) && status.pid > 0 && Number.isSafeInteger(status.updatedAt), 'producer_upgrade_stop_unverified')
  const recovery = state.infrastructureRecovery
  if (recovery) demand(recovery.configuration === recoveryConfigurationHash(configurationRaw,runtimeRaw) && recovery.attempts === await attemptEvidence(before), 'producer_upgrade_recovery_mismatch')
  const stopped = status.phase === 'stopped' && status.attention === null
  const recovered = recovery && recovery.run === status.runId &&
    (recovery.previousPhase === 'running' && recovery.previousAttention === null && status.phase === 'running' && status.attention === null ||
      recovery.previousPhase === 'stopped' && recovery.previousAttention === 'herdr_observation_unknown' && status.phase === 'stopped' && status.attention === recovery.previousAttention)
  demand(stopped || recovered, 'producer_upgrade_stop_unverified')
  if (recovered) {
    const backup = await boundedRead(path.join(manager.lifecycleDirectory, `lifecycle-before-recheck-${recovery.fromState}.json`), 262144)
    const original = JSON.parse(backup)
    demand(sha(backup) === recovery.fromState && original.identity === before.deviceId && original.phase === recovery.previousPhase && original.attention === recovery.previousAttention && !original.handoff, 'producer_upgrade_recovery_mismatch')
  }
  const inspected = await manager.inspect(before, undefined, { inspectHistoryOnly: true })
  if (manager.observe === nativeRecoveryEvidence) demand(path.resolve(process.execPath).toLowerCase() === path.resolve(inspected.config.programs.node).toLowerCase(), 'producer_upgrade_original_node_required')
  inspected.assertUnchanged()
  const evidence = await manager.observe({ config: inspected.config, status, producerRoots, files: {
    root: manager.root, config: manager.configFile, runtime: manager.runtimeFile, state: manager.lifecycleStore.file,
    status: path.join(manager.lifecycleDirectory, 'host-status.json'), additional: [manager.file,...additional] } })
  demand(['ownerVerified','oldHostAbsent','referencedProcessesAbsent','herdrAbsent','producerAbsent'].every(key => evidence?.[key] === true), 'producer_upgrade_processes_unverified')
  inspected.assertUnchanged()
}

export async function transactProducerUpgrade(manager, options, { checkpoint = async () => {}, verifySecurity = verifyReplacementSecurity } = {}) {
  const { action, requestId, target, configurationSha256, lifecycleSha256, selectionSha256, referenceSha256 } = options
  demand(['plan-producer','upgrade-producer','recover-producer','rollback-producer'].includes(action) && uuid(requestId), 'producer_upgrade_arguments_invalid')
  const preparing = ['plan-producer','upgrade-producer'].includes(action)
  if (preparing) demand([target,configurationSha256,lifecycleSha256,selectionSha256].every(hash), 'producer_upgrade_arguments_invalid')
  manager.handlingProducer = true
  try { return await manager.locked(async () => {
    const markerFile = path.join(manager.lifecycleDirectory, producerPendingName)
    let markerRaw = await optional(markerFile, 16384), markerVersion = markerRaw === null ? null : (await snapshot(markerFile,16384)).version
    if (action === 'plan-producer') demand(markerRaw === null,'producer_upgrade_pending_conflict')
    if (markerRaw === null && preparing) {
      await manager.unchanged()
      demand(await optional(path.join(manager.lifecycleDirectory, 'profile-switch-pending.json')) === null, 'producer_upgrade_profile_pending')
      const selectionRaw = await boundedRead(manager.file, 65536), selected = await manager.read()
      const lifecycleRaw = await boundedRead(manager.lifecycleStore.file, 262144), state = await manager.lifecycleStore.load()
      demand(sha(manager.configRaw) === configurationSha256 && sha(lifecycleRaw) === lifecycleSha256 && sha(selectionRaw) === selectionSha256, 'producer_upgrade_expected_hash_mismatch')
      const transferConfiguration = await transferConfigurationEvidence(manager.config)
      demand(selected.pending === null && selected.current !== null && selected.current !== target && !state.producerUpgrade, 'producer_upgrade_selection_invalid')
      const oldRecord = await manager.owned(selected, selected.current), newRecord = await manager.owned(selected, target)
      const oldRoot = path.join(manager.layout.packages, selected.current), nextRoot = path.join(manager.layout.packages, target)
      const old = await verifyRecordedCandidate(oldRoot, oldRecord), next = await verifyCandidate(nextRoot, target)
      demand([historicalProducer,explicitFilenameProducer,receiptObservationProducer,receiptBindingProducer,endpointRouteProducer].includes(old.manifest.producer_commit) && next.manifest.producer_commit === catalog.components.transfer.revision && newRecord.profile === programProfileHash, 'producer_upgrade_version_unsupported')
      // Outside the selected package, only the exact recorded producer witness
      // can justify a reference change. It grants no directory adoption/write.
      const external=manager.config.transfer?.pluginRoot !== path.join(oldRoot,'transfer')
      let producerSource
      if (external) {
        demand(old.manifest.producer_commit===historicalProducer,'producer_upgrade_external_version_unsupported')
        demand(next.manifest.native_producer_reference===1,'producer_upgrade_external_target_unsupported')
        if(action==='upgrade-producer')demand(hash(referenceSha256),'producer_upgrade_external_reference_review_required')
        producerSource=await referenceFor(manager).capture(selected,manager.config,manager.layout)
        if(action==='upgrade-producer')demand(sha(encode(producerSource))===referenceSha256,'producer_upgrade_external_reference_review_required')
      } else demand(referenceSha256===undefined,'producer_upgrade_arguments_invalid')
      await producerProof(old, oldRoot); await producerProof(next, nextRoot)
      await manager.projectRoot(target)
      const after = structuredClone(manager.config); after.transfer.pluginRoot = path.join(nextRoot, 'transfer'); validateConfig(after)
      const continuation = await producerSessionTransition(manager.config, after, state.sessionContinuation)
      const statusRaw = await boundedRead(path.join(manager.lifecycleDirectory, 'host-status.json'), 32768)
      await stoppedEvidence(manager, manager.config, state, JSON.parse(statusRaw), [manager.config.transfer.pluginRoot, after.transfer.pluginRoot],manager.configRaw,manager.runtimeRaw)
      const plan = { schema: external?3:2, requestId, from: selected.current, target, configuration: configurationSha256, lifecycle: lifecycleSha256, selection: selectionSha256,transferConfiguration,...(external?{producerSource}:{}),
        nextConfiguration: sha(encode(after)), continuation, attempts: await attemptEvidence(manager.config), queue: await producerStateEvidence(manager.config),
        runtime: manager.runtimeRaw === null ? null : sha(manager.runtimeRaw), status: sha(statusRaw), registration: await registryEvidence(manager.config) }
      await assertTransferConfiguration(manager.config,plan.transferConfiguration)
      if(external)await referenceFor(manager).assert(producerSource,selected,manager.config,manager.layout)
      if (action === 'plan-producer') return {state:'producer_upgrade_plan',requestId,from:plan.from,to:target,oldProducer:old.manifest.producer_commit,newProducer:catalog.components.transfer.revision,
        pluginRoot:{from:manager.config.transfer.pluginRoot,to:after.transfer.pluginRoot,kept:false,reason:external?'recorded_external_read_only_reference':'immutable_owned_package'},
        ...(external?{referenceSha256:sha(encode(producerSource)),sourceRegisteredManifestSha256:producerSource.registeredManifestSha256,externalDirectoryAdopted:false,
          sourceEvidence:{sourceCommit:JSON.parse(producerSource.manifestRaw).source_commit,producerCommit:historicalProducer,
            rootGeneration:producerSource.objects.find(item=>item.role==='source:root').generation,
            ...producerSource.objects.find(item=>item.role==='source:root').security,
            executableSha256:producerSource.objects.find(item=>item.role==='source:transferqueue.exe').sha256,
            executableSize:producerSource.objects.find(item=>item.role==='source:transferqueue.exe').size}}:{}),
        configurationSha256,lifecycleSha256,selectionSha256,transferConfigurationSha256:transferConfiguration.sha256,transferConfigurationVersion:transferConfiguration.version,
        ordinarySnapshotSha256:continuation.snapshot,attemptsSha256:plan.attempts,queueMetadataSha256:plan.queue,
        activation:'blocked',persistentPayloadsWritten:false,queueAdvanced:false,businessReplayed:false,credentialsRead:false,productionAccepted:false}
      const parent = path.dirname(history(manager, requestId))
      try { await fs.mkdir(parent) } catch (error) { if (error.code !== 'EEXIST') throw error }
      await validateDirectory(parent)
      try { await fs.mkdir(history(manager, requestId)) } catch (error) { if (error.code !== 'EEXIST') throw error }
      await validateDirectory(history(manager, requestId))
      for (const [name, raw] of [['configuration',manager.configRaw],['lifecycle',lifecycleRaw],['selection',selectionRaw],['plan',encode(plan)]])
        await retain(path.join(history(manager, requestId), name + '.json'), raw)
      await checkpoint('producer_archived')
      // Publish intent only against the original CAS snapshot, still holding
      // the same host/component/deployment leases as the ordinary updater.
      await manager.unchanged()
      demand(await boundedRead(manager.file, 65536) === selectionRaw && await boundedRead(manager.lifecycleStore.file, 262144) === lifecycleRaw &&
        await attemptEvidence(manager.config) === plan.attempts && await producerStateEvidence(manager.config) === plan.queue, 'producer_upgrade_evidence_changed')
      await assertTransferConfiguration(manager.config,plan.transferConfiguration)
      if(external)await referenceFor(manager).assert(producerSource,selected,manager.config,manager.layout)
      markerRaw = encode({ schema: 1, requestId, planSha256: sha(encode(plan)) })
      markerVersion = await exclusive(markerFile, markerRaw)
      await checkpoint('producer_intent_synced')
    }
    const record = await originals(manager, requestId), { plan } = record
    if (action === 'upgrade-producer') demand(plan.target === target && plan.configuration === configurationSha256 && plan.lifecycle === lifecycleSha256 && plan.selection === selectionSha256, 'producer_upgrade_request_conflict')
    const expectedMarker = encode({ schema: 1, requestId, planSha256: sha(record.raw) })
    demand(markerRaw === null || markerRaw === expectedMarker, 'producer_upgrade_pending_conflict')
    const rollbackFile = path.join(record.dir,'rollback.json'), expectedRollback = encode({schema:1,requestId,planSha256:sha(record.raw),direction:'rollback'})
    let rollbackRaw = await optional(rollbackFile,16384)
    demand(rollbackRaw === null || rollbackRaw === expectedRollback,'producer_upgrade_request_conflict')
    const rollback = action === 'rollback-producer' || rollbackRaw !== null
    const readyFile = path.join(record.dir,rollback?'rollback-ready.json':'upgrade-ready.json')
    const expectedReady = encode({schema:1,requestId,planSha256:sha(record.raw),direction:rollback?'rollback':'upgrade',state:'joint_publication_verified'})
    let readyRaw = await optional(readyFile,16384)
    demand(readyRaw === null || readyRaw === expectedReady,'producer_upgrade_request_conflict')
    const statusFile = path.join(manager.lifecycleDirectory, 'host-status.json')
    const check = async () => {
      demand(await optional(markerFile,16384) === markerRaw, 'producer_upgrade_pending_conflict')
      if (markerRaw !== null) demand((await snapshot(markerFile,16384)).version === markerVersion,'producer_upgrade_pending_conflict')
      demand(await boundedRead(path.join(record.dir,'plan.json'),planLimit) === record.raw, 'producer_upgrade_archive_conflict')
      demand(await optional(rollbackFile,16384) === rollbackRaw,'producer_upgrade_request_conflict')
      demand(await optional(readyFile,16384) === readyRaw,'producer_upgrade_request_conflict')
      for (const [name,raw] of [['configuration',record.configuration],['lifecycle',record.lifecycle],['selection',record.selection]])
        demand(await boundedRead(path.join(record.dir,name+'.json'),262144) === raw, 'producer_upgrade_archive_conflict')
      const snapshots = {c:await snapshot(manager.configFile,65536),s:await snapshot(manager.lifecycleStore.file,262144),d:await snapshot(manager.file,65536)}
      const {c,s,d} = Object.fromEntries(Object.entries(snapshots).map(([key,value])=>[key,value.raw]))
      demand([record.configuration,record.configurationAfter].includes(c) && [record.lifecycle,record.fence,record.nextFence,record.lifecycleAfter].includes(s) &&
        [record.selection,record.selectionFence,record.selectionAfter].includes(d), 'producer_upgrade_evidence_changed')
      const completedReference=plan.schema===3&&!rollback&&markerRaw===null&&readyRaw===expectedReady&&
        c===record.configurationAfter&&s===record.lifecycleAfter&&d===record.selectionAfter
      if(plan.schema===3&&!completedReference)await referenceFor(manager).assert(plan.producerSource,record.selected,record.before,manager.layout)
      const runtime = await optional(manager.runtimeFile,65536)
      demand((runtime === null ? null : sha(runtime)) === plan.runtime && await attemptEvidence(record.before) === plan.attempts &&
        await producerStateEvidence(record.before) === plan.queue && await registryEvidence(record.before) === plan.registration, 'producer_upgrade_evidence_changed')
      const statusRaw = await boundedRead(statusFile,32768)
      demand(sha(statusRaw) === plan.status, 'producer_upgrade_evidence_changed')
      await verifySessionContinuation(record.before,record.state.sessionContinuation)
      await stoppedEvidence(manager, record.before, record.state, JSON.parse(statusRaw), [completedReference?record.after.transfer.pluginRoot:record.before.transfer.pluginRoot,record.after.transfer.pluginRoot],record.configuration,runtime,
        ['plan','configuration','lifecycle','selection'].map(name=>path.join(record.dir,name+'.json')).concat(markerRaw===null?[]:[markerFile],rollbackRaw===null?[]:[rollbackFile]))
      const oldRecord = record.selected.packages.find(item=>item.hash===plan.from)
      await verifyRecordedCandidate(path.join(manager.layout.packages,plan.from),oldRecord)
      await verifyCandidate(path.join(manager.layout.packages,plan.target),plan.target)
      // Last observation before publication, including changes made while the
      // asynchronous process/security/package evidence was being collected.
      await assertTransferConfiguration(record.before,plan.transferConfiguration)
      if(plan.schema===3&&!completedReference)await referenceFor(manager).assert(plan.producerSource,record.selected,record.before,manager.layout)
      // Queue writes (including a v6 recovery registration) during the async
      // observations must be caught before any publication or fence release.
      demand(await producerStateEvidence(record.before)===plan.queue,'producer_upgrade_evidence_changed')
      if (rollback) {
        // Opaque queue metadata is not an old-format attestation. Until such a
        // trusted boundary exists, reverse publication requires persistent
        // observer-only/disabled transfer, including resumed rollback intents.
        const rollbackRuntime = await optional(manager.runtimeFile,65536)
        demand((rollbackRuntime===null?null:sha(rollbackRuntime))===plan.runtime,'producer_upgrade_evidence_changed')
        demand(rollbackRuntime===null || validateRuntimeRequest(JSON.parse(rollbackRuntime),record.before).transfer==='disabled',
          'producer_upgrade_rollback_queue_compatibility_unverified')
      }
      return {c,s,d,versions:Object.fromEntries(Object.entries(snapshots).map(([key,value])=>[key,value.version]))}
    }
    const final = rollback ? {c:record.configuration,s:record.lifecycle,d:record.selection} : {c:record.configurationAfter,s:record.lifecycleAfter,d:record.selectionAfter}
    let current = await check()
    if (markerRaw === null) {
      if (current.c === final.c && current.s === final.s && current.d === final.d)
        return {state:'already_completed',requestId,activation:'explicit_foreground_only',businessReplayed:false,queueAdvanced:false}
      const fencedPublication = readyRaw === expectedReady && current.c === final.c && current.d === final.d && current.s === (rollback?record.fence:record.nextFence)
      demand(fencedPublication || action === 'rollback-producer' && current.c === record.configurationAfter && current.s === record.lifecycleAfter && current.d === record.selectionAfter, 'producer_upgrade_explicit_recovery_required')
      markerRaw = expectedMarker
      markerVersion = await exclusive(markerFile, markerRaw)
      await checkpoint(fencedPublication?'producer_intent_rearmed':'producer_rollback_intent_synced')
      await check()
    }
    // A rollback interrupted halfway must recover in the same direction.
    // This append-only intent is durable before the first reverse publication.
    if (rollback && rollbackRaw === null) {
      await exclusive(rollbackFile,expectedRollback); rollbackRaw = expectedRollback
      await checkpoint('producer_rollback_direction_synced')
      await check()
    }
    const publish = async (file,key,after,phase) => {
      current = await check()
      if (current[key] === after) return
      const before = current[key], version = current.versions[key], temporary = path.join(path.dirname(file), `.producer-upgrade-${randomUUID()}.tmp`)
      await exclusive(temporary,after)
      await checkpoint(`${phase}_file_synced`)
      await verifySecurity(file,temporary)
      const latest = await check()
      demand(latest[key] === before && latest.versions[key] === version, 'producer_upgrade_evidence_changed')
      await fs.rename(temporary,file)
      await checkpoint(`${phase}_published`)
      await check()
    }
    // A real lifecycle attention fence also protects the old raw 57 launcher,
    // which predates the dedicated pending marker. Never clear it mid-switch.
    await publish(manager.lifecycleStore.file,'s',record.fence,'producer_fence')
    await publish(manager.file,'d',record.selectionFence,'producer_selection_fence')
    await publish(manager.configFile,'c',final.c,'producer_configuration')
    await publish(manager.lifecycleStore.file,'s',rollback ? record.fence : record.nextFence,'producer_continuation')
    await publish(manager.file,'d',final.d,'producer_selection')
    current = await check()
    demand(current.c === final.c && current.s === (rollback?record.fence:record.nextFence) && current.d === final.d)
    if (readyRaw === null) { await exclusive(readyFile,expectedReady); readyRaw = expectedReady }
    await checkpoint('producer_ready_synced')
    await check()
    // Keep the real attention fence until AFTER removing the marker. This
    // ordering also protects a pinned target such as c036 whose raw launcher
    // predates the marker. The immutable ready receipt permits exact recovery
    // if interrupted between marker removal and lifecycle fence release.
    await fs.unlink(markerFile); markerRaw = null; markerVersion = null
    await checkpoint('producer_marker_released')
    await check()
    await publish(manager.lifecycleStore.file,'s',final.s,'producer_release')
    current = await check()
    demand(current.c === final.c && current.s === final.s && current.d === final.d)
    await checkpoint('producer_before_complete')
    await check()
    return {state:rollback?'producer_rolled_back':'host_producer_selected',requestId,manifestSha256:rollback?plan.from:plan.target,
      activation:'explicit_foreground_only',businessReplayed:false,queueAdvanced:false,credentialReferences:'unchanged',history:'original_bytes_retained',productionAccepted:false}
  }) } finally { manager.handlingProducer = false }
}
