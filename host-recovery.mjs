// Explicit infrastructure-only recheck. Never starts/stops a child or replays work.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { validateConfig, validateDirectory, programPaths, managedEnvironment, connectorConfigReference, isNativeRuntimeConfig } from './endpoint.mjs'
import { deploymentLayout } from './deployment.mjs'
import { acquireLeases, leaseKeys, StateStore, NativeDriver } from './lifecycle.mjs'
import { boundedRead } from './session-diagnostics.mjs'
import { captureSessionContinuation } from './session-continuation.mjs'
import { inspectInstalled } from './installed.mjs'
import { validateRuntimeRequest } from './runtime.mjs'

const hash = s => createHash('sha256').update(s).digest('hex')
const demand = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }) }
const same = (a,b) => JSON.stringify(a) === JSON.stringify(b)
export const recoveryConfigurationHash = (configRaw, runtimeRaw) => hash(JSON.stringify([configRaw,runtimeRaw]))

// Fingerprint only the existing attempt directory. No second task ledger and no
// claim that these receipts prove completed work. Unknown/oversized files block.
export async function attemptEvidence(config) {
  const root = path.join(config.sourceRoot, '.memoh-computer', 'attempts'), files = []
  let bytes = 0
  async function walk(directory, prefix = '') {
    await validateDirectory(directory)
    for (const entry of (await fs.readdir(directory, {withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
      demand(!entry.isSymbolicLink(), 'host_recovery_attempt_unsafe')
      const name = prefix + entry.name, file = path.join(directory,entry.name)
      if (entry.isDirectory()) await walk(file,name+'/')
      else {
        const text = await boundedRead(file, 1024*1024), raw = await fs.readFile(file)
        demand(raw.toString('utf8') === text && raw.length <= 1024*1024,'host_recovery_attempt_changed')
        bytes += raw.length; demand(bytes <= 16*1024*1024 && files.length < 10000,'host_recovery_attempt_evidence_too_large')
        files.push([name,hash(raw)])
      }
    }
  }
  try { await fs.lstat(root) } catch(e) { if(e.code === 'ENOENT') return hash('absent'); throw e }
  await walk(root)
  return hash(JSON.stringify(files))
}

// Classify only observed generations. A shared binary/session label is not
// ownership. A broken/reused parent chain never establishes unrelated work.
export function classifyRecoveryProcesses(records, {oldPid, currentSession, runStart, recoveryPid}) {
  const byId = new Map(records.map(p=>[p.id,p])), excluded = []
  const refuse = (reason,p) => ({absent:false,reason,excluded,blocked:p ? {pid:p.id,role:p.role,ownerCurrent:p.ownerCurrent === true,sessionMatches:p.windowsSession === currentSession} : undefined})
  if(byId.has(oldPid)) return refuse('original_host_pid_present',byId.get(oldPid))
  const callers = new Set(), callerSeen = new Set()
  let caller=byId.get(recoveryPid)
  for(let n=0;caller && n<64;n++) {
    const parent=byId.get(caller.parent)
    if(!parent || callerSeen.has(parent.id) || parent.id === oldPid || !Number.isSafeInteger(parent.created) || !Number.isSafeInteger(caller.created) || parent.created > caller.created) break
    callerSeen.add(parent.id); callers.add(parent.id); caller=parent
  }
  function externalChain(process) {
    // A real link FROM the recovery invoker also proves an older caller's
    // generation when that caller's own parent has since exited. This is not
    // permission to exclude an arbitrary older PID or an original reference.
    if(process.created < runStart && callers.has(process.id)) return true
    const seen = new Set([process.id]); let child = process
    for(let n=0;n<64;n++) {
      const parent=byId.get(child.parent)
      if(!parent || seen.has(parent.id) || parent.id === oldPid || !Number.isSafeInteger(parent.created) || !Number.isSafeInteger(child.created) || parent.created > child.created) return false
      seen.add(parent.id)
      // Existing host code publishes its first starting event before it can
      // spawn any component. A live, older ancestor cannot be its new child.
      // At least one actual parent link is required, even for an older leaf.
      if(parent.created < runStart) return true
      child=parent
    }
    return false
  }
  for(const p of records) {
    if(p.role === 'other') continue
    if(p.role === 'unknown' || !p.ownerCurrent || p.windowsSession !== currentSession) return refuse('process_identity_unknown',p)
    if(p.originalReference || p.scope === 'same') return refuse('original_process_reference',p)
    if(!Number.isSafeInteger(runStart) || runStart <= 0 || !externalChain(p)) return refuse('process_ancestry_unknown_or_related',p)
    if(p.role === 'herdr' && p.scope !== 'different_session' || p.role === 'pi' && !['different_task_root','interactive'].includes(p.scope) || p.role === 'node' && p.scope !== 'other_program' || p.role === 'connector' && p.scope !== 'different_enrollment') return refuse('process_scope_unknown',p)
    excluded.push({pid:p.id,role:p.role,reason:'verified_external_ancestry_and_scope'})
  }
  return {absent:true,excluded}
}

export async function nativeRecoveryEvidence({config,status,files}) {
  demand(process.platform === 'win32' && process.arch === 'x64','host_recovery_windows_required')
  const p = programPaths(config), powershell = path.join(process.env.SystemRoot || 'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe')
  // Reuse the official Runtime's Windows PowerShell environment rule: a
  // PowerShell 7 parent must not redirect PS5 built-in module resolution.
  const env = Object.fromEntries(Object.entries(managedEnvironment(config)).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'))
  let evidence
  try {
    const result = await promisify(execFile)(powershell,['-NoLogo','-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./host-recovery.ps1',import.meta.url)),
      '-LifecycleFile',files.state,'-ConfigurationFile',files.config,'-RuntimeFile',files.runtime,'-StatusFile',files.status,
      '-OldProcessId',String(status.pid),'-RecoveryProcessId',String(process.pid),'-NodePath',p.node,'-HerdrPath',p.herdr,
      '-PiEntry',p.pi,'-EnrollmentFile',connectorConfigReference(config),'-HostRoot',files.root,'-SourceRoot',config.sourceRoot,'-HerdrSession',config.session,'-RuntimeEntry',p.connector],
    {cwd:config.sourceRoot,env,windowsHide:true,shell:false,timeout:15000,maxBuffer:262144,encoding:'utf8'})
    evidence = JSON.parse(result.stdout)
  } catch(error) {
    let stage = 'not_observed'
    try { const value = JSON.parse(error.stderr); if (['file_owner','process_inventory','process_absence'].includes(value.stage)) stage = value.stage } catch {}
    throw Object.assign(new Error('host_recovery_process_evidence_unavailable'),{code:'host_recovery_process_evidence_unavailable',evidenceStage:stage})
  }
  let runStart = null
  try {
    const raw = await boundedRead(path.join(files.root,'logs/endpoint-host',`${status.runId}.jsonl`),65536)
    const first = JSON.parse(raw.split('\n')[0])
    if(first.schema === 1 && first.runId === status.runId && first.phase === 'starting' && Number.isSafeInteger(first.at) && first.at <= status.updatedAt) runStart=first.at
  } catch { /* Missing start evidence cannot exclude a matching live process. */ }
  const classified=classifyRecoveryProcesses(evidence.processes || [],{oldPid:status.pid,currentSession:evidence.currentSession,runStart,recoveryPid:process.pid})
  if(evidence.ownerVerified !== true || evidence.oldHostAbsent !== true || !classified.absent) {
    const failure=Object.assign(new Error('host_recovery_process_evidence_unavailable'),{code:'host_recovery_process_evidence_unavailable',evidenceStage:'process_absence'})
    failure.processReason=classified.reason; failure.blockingProcess=classified.blocked; throw failure
  }
  const driver = new NativeDriver(config)
  demand(driver.hostStatus().running === false,'host_recovery_herdr_present')
  return {ownerVerified:true,oldHostAbsent:true,referencedProcessesAbsent:true,excludedProcesses:classified.excluded}
}

// Injection is internal test support, never a config/CLI field.
export async function recoverHost({root,expectedRun,expectedState,expectedConfiguration}, {
  inspect = inspectInstalled, observe = nativeRecoveryEvidence, checkpoint = async()=>{}, io = fs,
} = {}) {
  demand(/^[a-f0-9-]{36}$/.test(expectedRun) && [expectedState,expectedConfiguration].every(v=>/^[a-f0-9]{64}$/.test(v)),'host_recovery_expected_evidence_required')
  const layout = deploymentLayout(root)
  for (const d of [root,layout.config,path.join(layout.data,'endpoint')]) await validateDirectory(d)
  const files = {root,config:path.join(layout.config,'endpoint.json'),runtime:path.join(layout.config,'runtime.json'),status:path.join(layout.data,'endpoint/host-status.json'),state:path.join(layout.data,'endpoint/lifecycle.json')}
  const configRaw = await boundedRead(files.config,65536), runtimeRaw = await boundedRead(files.runtime,65536)
  demand(recoveryConfigurationHash(configRaw,runtimeRaw) === expectedConfiguration,'host_recovery_configuration_changed')
  const config = validateConfig(JSON.parse(configRaw))
  demand(isNativeRuntimeConfig(config),'host_recovery_native_required')
  validateRuntimeRequest(JSON.parse(runtimeRaw),config)
  const release = await acquireLeases([`host:${root}`,`deployment:${root}`,...leaseKeys(config)],path.dirname(files.state))
  try {
    const stateRaw = await boundedRead(files.state,262144), store = new StateStore(path.dirname(files.state),config.deviceId,{io})
    const state = await store.load()
    // A lost response can be queried again without dispatch or another mutation.
    if (state.infrastructureRecovery?.fromState === expectedState && state.infrastructureRecovery?.run === expectedRun) {
      demand(state.infrastructureRecovery.configuration === expectedConfiguration,'host_recovery_configuration_changed')
      return {state:'already_rechecked',lifecyclePhase:state.phase,attention:state.attention,ready:false,started:false,businessReplayed:false,stopAuthority:false}
    }
    demand(hash(stateRaw) === expectedState,'host_recovery_state_changed')
    demand(state.phase === 'needs_attention' && state.attention === 'herdr_observation_unknown' && !state.handoff,'host_recovery_state_not_eligible')
    const statusRaw = await boundedRead(files.status,32768), status = JSON.parse(statusRaw)
    demand(status.schema === 1 && status.owner === 'windows-endpoint-host' && status.runId === expectedRun && Number.isSafeInteger(status.pid) && status.pid > 0 && status.pid !== process.pid && Number.isSafeInteger(status.updatedAt) && Date.now()-status.updatedAt > 5000,'host_recovery_status_not_eligible')
    const inspected = await inspect(config,undefined,{inspectHistoryOnly:true})
    const effective = inspected.config
    demand(path.resolve(process.execPath).toLowerCase() === path.resolve(effective.programs.node).toLowerCase() || observe !== nativeRecoveryEvidence,'host_recovery_node_mismatch')
    const continuation = await captureSessionContinuation(effective)
    demand(continuation.ordinary,'host_recovery_agent_history_requires_handoff')
    const attempts = await attemptEvidence(config)
    const logFile=path.join(root,'logs/endpoint-host',`${status.runId}.jsonl`)
    const readLog=async()=>{try{return await boundedRead(logFile,65536)}catch(error){if(error.code === 'ENOENT')return null;throw error}}
    const logRaw = await readLog()
    let observed = null
    const verifyBytes = async()=>{
      inspected.assertUnchanged()
      demand(await boundedRead(files.config,65536) === configRaw && await boundedRead(files.runtime,65536) === runtimeRaw && await boundedRead(files.status,32768) === statusRaw && await boundedRead(files.state,262144) === stateRaw,'host_recovery_evidence_changed')
      demand(same(await captureSessionContinuation(effective),continuation) && await attemptEvidence(config) === attempts,'host_recovery_business_evidence_changed')
      demand(await readLog() === logRaw,'host_recovery_run_log_changed')
    }
    const recheck = async()=>{
      await verifyBytes()
      observed=await observe({config:effective,status,files})
      await verifyBytes() // CIM can take time; never publish over intervening work.
    }
    await recheck(); await checkpoint('verified')
    // Original journal bytes are retained before changing infrastructure attention.
    const backup = path.join(path.dirname(files.state),`lifecycle-before-recheck-${expectedState}.json`)
    let handle
    try { handle = await io.open(backup,'wx'); await handle.writeFile(stateRaw); await handle.sync() }
    catch(e) { if(e.code !== 'EEXIST') throw e; demand(await boundedRead(backup,262144) === stateRaw,'host_recovery_backup_conflict') }
    finally { await handle?.close() }
    await checkpoint('backup_synced'); await recheck()
    store.checkpoint = async phase => { if(phase === 'file_synced') { await checkpoint('before_publish'); await recheck() } }
    const next = {...state,phase:'stopped',attention:null,sessionContinuation:continuation,
      infrastructureRecovery:{schema:1,fromState:expectedState,run:expectedRun,configuration:expectedConfiguration,attempts,previousPhase:state.phase,previousAttention:state.attention,businessReplayed:false}}
    try { await store.write(next) }
    catch(e) { throw Object.assign(new Error('host_recovery_publication_unknown'),{code:'host_recovery_publication_unknown',cause:e}) }
    return {state:'infrastructure_rechecked',ready:false,started:false,businessReplayed:false,stopAuthority:false,originalJournalSha256:expectedState,attemptEvidenceSha256:attempts,next:'explicit_foreground_start',upgradeTaskGate:'retained',excludedProcesses:observed?.excludedProcesses || []}
  } finally { await release() }
}

export async function recoveryMain(args) {
  const fields = ['--root','--expected-run','--expected-state-sha256','--expected-configuration-sha256'], options = {}
  for(let i=0;i<args.length;i+=2) {
    demand(fields.includes(args[i]) && typeof args[i+1] === 'string' && !Object.hasOwn(options,args[i]),'host_recovery_arguments_invalid')
    options[args[i]]=args[i+1]
  }
  demand(Object.keys(options).length === fields.length,'host_recovery_arguments_invalid')
  return recoverHost({root:options['--root'],expectedRun:options['--expected-run'],expectedState:options['--expected-state-sha256'],expectedConfiguration:options['--expected-configuration-sha256']})
}
