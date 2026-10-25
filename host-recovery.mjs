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
        const raw = await boundedRead(file, 1024*1024)
        bytes += Buffer.byteLength(raw); demand(bytes <= 16*1024*1024 && files.length < 10000,'host_recovery_attempt_evidence_too_large')
        files.push([name,hash(raw)])
      }
    }
  }
  try { await fs.lstat(root) } catch(e) { if(e.code === 'ENOENT') return hash('absent'); throw e }
  await walk(root)
  return hash(JSON.stringify(files))
}

export async function nativeRecoveryEvidence({config,status,files}) {
  demand(process.platform === 'win32' && process.arch === 'x64','host_recovery_windows_required')
  const p = programPaths(config), powershell = path.join(process.env.SystemRoot || 'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe')
  let evidence
  try {
    const result = await promisify(execFile)(powershell,['-NoLogo','-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./host-recovery.ps1',import.meta.url)),
      '-LifecycleFile',files.state,'-ConfigurationFile',files.config,'-RuntimeFile',files.runtime,'-StatusFile',files.status,
      '-OldProcessId',String(status.pid),'-RecoveryProcessId',String(process.pid),'-NodePath',p.node,'-HerdrPath',p.herdr,
      '-PiEntry',p.pi,'-EnrollmentFile',connectorConfigReference(config),'-HostRoot',files.root],
    {cwd:config.sourceRoot,env:managedEnvironment(config),windowsHide:true,shell:false,timeout:15000,maxBuffer:4096,encoding:'utf8'})
    evidence = JSON.parse(result.stdout)
  } catch { throw Object.assign(new Error('host_recovery_process_evidence_unavailable'),{code:'host_recovery_process_evidence_unavailable'}) }
  demand(evidence.ownerVerified === true && evidence.oldHostAbsent === true && evidence.referencedProcessesAbsent === true,'host_recovery_process_evidence_unavailable')
  const driver = new NativeDriver(config)
  demand(driver.hostStatus().running === false,'host_recovery_herdr_present')
  return evidence
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
      return {state:'already_rechecked',ready:false,started:false,businessReplayed:false,stopAuthority:false}
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
    const recheck = async()=>{
      inspected.assertUnchanged()
      demand(await boundedRead(files.config,65536) === configRaw && await boundedRead(files.runtime,65536) === runtimeRaw && await boundedRead(files.status,32768) === statusRaw && await boundedRead(files.state,262144) === stateRaw,'host_recovery_evidence_changed')
      demand(same(await captureSessionContinuation(effective),continuation) && await attemptEvidence(config) === attempts,'host_recovery_business_evidence_changed')
      await observe({config:effective,status,files})
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
    return {state:'infrastructure_rechecked',ready:false,started:false,businessReplayed:false,stopAuthority:false,originalJournalSha256:expectedState,attemptEvidenceSha256:attempts,next:'explicit_foreground_start',upgradeTaskGate:'retained'}
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
