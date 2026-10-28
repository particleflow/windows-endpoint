import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { catalog, digest } from './endpoint.mjs'
import { verifyCandidate, verifyRecordedCandidate, historicalProducer, profileForProducer, programProfileHash } from './candidate.mjs'
import { programDeployment, runSelectedProgram } from './program-deployment.mjs'
import { captureSessionContinuation, producerSessionTransition } from './session-continuation.mjs'
import { transactProducerUpgrade, producerPendingName, producerStateEvidence } from './producer-upgrade.mjs'
import { nativeInstalledFixture } from './test-support/installed-fixture.mjs'
import { programPackage } from './test-support/program-package.mjs'
import { attemptEvidence, recoveryConfigurationHash, verifyReplacementSecurity } from './host-recovery.mjs'
import { acquireLeases, EndpointLifecycle } from './lifecycle.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const encode = value => JSON.stringify(value) + '\n'
// Synthetic package metadata/inert EXEs exercise the updater contract only.
// Real 57/62d execution and NTFS publication are separate Windows evidence.
async function packageFixture(directory, old) {
  const pkg = await programPackage(directory, old?'history':'new', {native:true})
  const revision = old ? historicalProducer : catalog.components.transfer.revision
  const depsFile = path.join(directory,'dependencies.json'), deps = JSON.parse(await fs.readFile(depsFile,'utf8'))
  deps.components.transfer.revision = revision; await fs.writeFile(depsFile,encode(deps))
  const producerFiles = ['README.md','herdr-plugin.toml','transfer.example.json','transferqueue-cli.test.exe','transferqueue.exe','transferqueue.test.exe','verify-fixtures.ps1']
  for (const name of producerFiles) await fs.writeFile(path.join(directory,'transfer',name), 'INERT SYNTHETIC '+revision+' '+name)
  await fs.writeFile(path.join(directory,'transfer/SHA256SUMS.json'),encode({source_commit:revision,arch:'amd64',files:await Promise.all(producerFiles.map(async name=>({name,sha256:await digest(path.join(directory,'transfer',name))})))}))
  const files=[]
  async function walk(dir,prefix='') {
    for(const item of await fs.readdir(dir,{withFileTypes:true})) {
      const relative=prefix+item.name, file=path.join(dir,item.name)
      if(item.isDirectory())await walk(file,relative+'/')
      else if(relative!=='candidate.json')files.push({path:relative,size:(await fs.stat(file)).size,sha256:await digest(file)})
    }
  }
  await walk(directory)
  pkg.manifest.files=files;pkg.manifest.producer_commit=revision
  if(old)pkg.manifest.source_commit='57ae131eff3fb675a51b6ea5ee945bfa0b9de837'
  await fs.writeFile(path.join(directory,'candidate.json'),encode(pkg.manifest))
  pkg.hash=await digest(path.join(directory,'candidate.json'))
  return pkg
}
const goodEvidence = {ownerVerified:true,oldHostAbsent:true,referencedProcessesAbsent:true,herdrAbsent:true,producerAbsent:true}
const injected = {inspect:async config=>({config,assertUnchanged(){}}),observe:async()=>goodEvidence}
const security = async()=>{} // No claim of a Windows security-descriptor check.
test('the existing raw lifecycle attention fence prevents validation and component start without depending on a new marker',async()=>{
  let state={schema:1,identity:'inert',phase:'stopped',attention:'producer_upgrade_pending',restarts:[]}
  const calls=[]
  const lifecycle=new EndpointLifecycle({store:{load:async()=>state,save:async next=>{state=next}},
    driver:{validate:async()=>calls.push('validate'),start:async()=>calls.push('start'),stop:async()=>{}},acquire:async()=>async()=>{}})
  await assert.rejects(lifecycle.start(),{code:'producer_upgrade_pending'})
  assert.deepEqual(calls,[])
  assert.equal(state.attention,'producer_upgrade_pending')
})
async function fixture(t,{snapshot=true,agent=false,external=false}={}) {
  const f=await nativeInstalledFixture(t), root=path.join(f.base,'host')
  const old=await packageFixture(path.join(f.base,'old'),true), next=await packageFixture(path.join(f.base,'new'),false)
  const config={...f.config,transfer:{pluginRoot:external?path.join(f.base,'external'):path.join(root,'packages',old.hash,'transfer'),nasOrigin:'https://nas.example.com'},
    transferConfigDir:path.join(f.base,'transfer-config'),transferStateDir:path.join(f.base,'transfer-state')}
  await fs.mkdir(config.transferConfigDir);await fs.mkdir(config.transferStateDir)
  await fs.mkdir(path.join(root,'config'),{recursive:true})
  await fs.writeFile(path.join(root,'config/endpoint.json'),encode(config))
  await fs.writeFile(path.join(root,'config/runtime.json'),encode({schema:2,mode:'existing-installations',transfer:'disabled'}))
  if(snapshot)await f.write(path.join(config.herdrConfigRoot,'sessions',config.session,'session.json'),encode({version:3,workspaces:[{id:'ordinary',tabs:[{panes:{one:{cwd:config.sourceRoot,...(agent?{agent_name:'pi'}:{label:'saved shell'})}}}]}]}))
  const manager=await programDeployment(root,{prepare:true,...injected});await manager.initialize()
  await fs.cp(old.directory,path.join(root,'packages',old.hash),{recursive:true})
  const selected={schema:1,owner:config.deviceId,packages:[{hash:old.hash,profile:profileForProducer(historicalProducer)}],current:old.hash,previous:null,pending:null}
  await fs.writeFile(manager.file,encode(selected))
  const checkpoint=await captureSessionContinuation(config)
  await manager.lifecycleStore.save({schema:1,identity:config.deviceId,phase:'stopped',restarts:[],attention:null,sessionContinuation:checkpoint})
  await f.write(path.join(manager.lifecycleDirectory,'host-status.json'),encode({schema:1,owner:'windows-endpoint-host',runId:randomUUID(),pid:743211,phase:'stopped',attention:null,updatedAt:Date.now()}))
  const preserved=[]
  for(let i=0;i<5;i++) {
    const raw=encode({status:i<2?'unknown':'committed',RootHash:'original-root',HostBinding:'ORIGINAL BYTES',id:i})
    const journal=path.join(config.transferStateDir,`job-${i}.journal`), attempt=path.join(config.sourceRoot,'.memoh-computer/attempts',`job-${i}.json`)
    await fs.writeFile(journal,raw);await f.write(attempt,raw)
    preserved.push([journal,raw],[attempt,raw])
  }
  const queue=await producerStateEvidence(config)
  // Neither source preparation nor the transaction opens these private files.
  preserved.push([config.connector.enrollmentFile,await fs.readFile(config.connector.enrollmentFile,'utf8')],
    [path.join(config.piConfigDir,'auth.json'),await fs.readFile(path.join(config.piConfigDir,'auth.json'),'utf8')])
  await manager.stage(next.directory,next.hash)
  const oldRaw={configuration:await fs.readFile(manager.configFile,'utf8'),lifecycle:await fs.readFile(manager.lifecycleStore.file,'utf8'),selection:await fs.readFile(manager.file,'utf8')}
  const options={action:'upgrade-producer',requestId:randomUUID(),target:next.hash,configurationSha256:sha(oldRaw.configuration),lifecycleSha256:sha(oldRaw.lifecycle),selectionSha256:sha(oldRaw.selection)}
  const create=()=>programDeployment(root,injected)
  const run=async(extra={},hooks={})=>transactProducerUpgrade(await create(),{...options,...extra},{verifySecurity:security,...hooks})
  const preservedCheck=async()=>{for(const [file,raw]of preserved)assert.equal(await fs.readFile(file,'utf8'),raw);assert.equal(await producerStateEvidence(config),queue)}
  return{...f,root,config,manager,old,next,oldRaw,options,run,create,preservedCheck}
}

test('recorded 57 package validates original hash/profile read-only; new staging remains pinned',async t=>{
  const f=await fixture(t), record={hash:f.old.hash,profile:profileForProducer(historicalProducer)}
  await assert.rejects(verifyCandidate(f.old.directory,f.old.hash),{code:'candidate_kind_or_producer_mismatch'})
  assert.equal((await verifyRecordedCandidate(f.old.directory,record)).manifest.producer_commit,historicalProducer)
  await assert.rejects(verifyRecordedCandidate(f.old.directory,{...record,profile:programProfileHash}),{code:'candidate_record_profile_mismatch'})
  assert.equal((await f.manager.stage(f.old.directory,f.old.hash)).state,'already_staged')
  // Already-owned stage is inspection only; force an unowned historical input.
  const manifest={...f.old.manifest,source_commit:'2'.repeat(40)}
  await fs.writeFile(path.join(f.old.directory,'candidate.json'),encode(manifest))
  const changedHash=await digest(path.join(f.old.directory,'candidate.json'))
  await assert.rejects(verifyRecordedCandidate(f.old.directory,{hash:changedHash,profile:record.profile}),{code:'candidate_kind_or_producer_mismatch'})
  await assert.rejects(f.manager.stage(f.old.directory,changedHash),{code:'candidate_kind_or_producer_mismatch'})
})
test('ordinary program update defers cross-producer instead of publishing only the host',async t=>{
  const f=await fixture(t)
  assert.equal((await f.manager.select(f.next.hash,'update')).reason,'producer_transaction_required')
  assert.equal(await fs.readFile(f.manager.file,'utf8'),f.oldRaw.selection)
  await f.preservedCheck()
})
test('dry-run preserves config, selection, lifecycle, journals and private references; an owned host defers without stopping it',async t=>{
  const f=await fixture(t)
  const result=await f.run({action:'plan-producer'})
  assert.equal(result.state,'producer_upgrade_plan');assert.equal(result.persistentPayloadsWritten,false)
  assert.equal(result.pluginRoot.kept,false);assert.equal(result.pluginRoot.reason,'immutable_owned_package')
  await assert.rejects(fs.lstat(path.join(f.manager.lifecycleDirectory,'producer-upgrade-history')),{code:'ENOENT'})
  assert.equal(await fs.readFile(f.manager.configFile,'utf8'),f.oldRaw.configuration)
  assert.equal(await fs.readFile(f.manager.lifecycleStore.file,'utf8'),f.oldRaw.lifecycle)
  assert.equal(await fs.readFile(f.manager.file,'utf8'),f.oldRaw.selection)
  const release=await acquireLeases([`host:${f.root}`],f.manager.lifecycleDirectory)
  try { assert.equal((await f.run()).reason,'endpoint_owned') } finally { await release() }
  await f.preservedCheck()
})
test('coupled selection derives real binding, retains original raw files and all two unknown/three committed histories; explicit rollback restores exact bytes',async t=>{
  const f=await fixture(t), result=await f.run()
  assert.equal(result.state,'host_producer_selected');assert.equal(result.productionAccepted,false)
  const after=JSON.parse(await fs.readFile(f.manager.configFile,'utf8')), state=await f.manager.lifecycleStore.load()
  const expected=structuredClone(f.config);expected.transfer.pluginRoot=path.join(f.root,'packages',f.next.hash,'transfer')
  assert.deepEqual(after,expected)
  assert.equal(state.sessionContinuation.binding,(await captureSessionContinuation(after)).binding)
  assert.notEqual(state.sessionContinuation.binding,JSON.parse(f.oldRaw.lifecycle).sessionContinuation.binding)
  assert.equal(state.sessionContinuation.snapshot,JSON.parse(f.oldRaw.lifecycle).sessionContinuation.snapshot)
  assert.equal((await f.manager.read()).current,f.next.hash)
  for(const [name,raw]of Object.entries(f.oldRaw))assert.equal(await fs.readFile(path.join(f.manager.lifecycleDirectory,'producer-upgrade-history',f.options.requestId,name+'.json'),'utf8'),raw)
  await f.preservedCheck()
  assert.equal((await f.run({action:'recover-producer'})).state,'already_completed')
  assert.equal((await f.run({action:'rollback-producer'})).state,'producer_rolled_back')
  for(const [name,file]of [['configuration',f.manager.configFile],['lifecycle',f.manager.lifecycleStore.file],['selection',f.manager.file]])assert.equal(await fs.readFile(file,'utf8'),f.oldRaw[name])
  await f.preservedCheck()
})
for(const options of [{snapshot:false},{agent:true},{external:true}])test(`refuses unsafe producer transition ${JSON.stringify(options)}`,async t=>{
  const f=await fixture(t,options)
  await assert.rejects(f.run())
  assert.equal(await fs.readFile(f.manager.configFile,'utf8'),f.oldRaw.configuration)
  assert.equal(await fs.readFile(f.manager.lifecycleStore.file,'utf8'),f.oldRaw.lifecycle)
  await assert.rejects(fs.lstat(path.join(f.manager.lifecycleDirectory,producerPendingName)),{code:'ENOENT'})
  await f.preservedCheck()
})
test('only pluginRoot may change; Pi/Agent, origin, state/config and enrollment identities cannot be borrowed from prepare-profile',async t=>{
  const f=await fixture(t), checkpoint=JSON.parse(f.oldRaw.lifecycle).sessionContinuation
  for(const change of [config=>{config.piConfigDir+='-other'},config=>{config.transfer.nasOrigin='https://other.invalid'},config=>{config.transferStateDir+='-other'},config=>{config.connector.enrollmentFile+='-other'}]) {
    const next=structuredClone(f.config);next.transfer.pluginRoot=path.join(f.root,'packages',f.next.hash,'transfer');change(next)
    await assert.rejects(producerSessionTransition(f.config,next,checkpoint),{code:'producer_session_identity_changed'})
  }
})
const crashes=['producer_intent_synced','producer_fence_published','producer_selection_fence_published','producer_configuration_file_synced','producer_configuration_published','producer_continuation_published','producer_selection_published','producer_ready_synced','producer_marker_released','producer_release_published','producer_before_complete']
for(const phase of crashes)test(`interrupted ${phase} resumes only the exact request with original queue/history intact`,async t=>{
  const f=await fixture(t)
  await assert.rejects(f.run({}, {checkpoint:async current=>{if(current===phase)throw Error('injected interruption')}}))
  await f.preservedCheck()
  const alreadyCommitted=['producer_release_published','producer_before_complete'].includes(phase)
  if(!alreadyCommitted && phase!=='producer_marker_released')await assert.rejects(runSelectedProgram(f.root),{code:'deployment_producer_recovery_required'})
  if(phase==='producer_marker_released')assert.equal((await f.manager.lifecycleStore.load()).attention,'producer_upgrade_pending')
  await assert.rejects(f.run({action:'recover-producer',requestId:randomUUID()}))
  assert.equal((await f.run({action:'recover-producer'})).state,alreadyCommitted?'already_completed':'host_producer_selected')
  await f.preservedCheck()
})
for(const phase of ['producer_configuration_published','producer_selection_published'])test(`interrupted ${phase} can roll back without touching task identities`,async t=>{
  const f=await fixture(t)
  await assert.rejects(f.run({}, {checkpoint:async current=>{if(current===phase)throw Error('injected interruption')}}))
  assert.equal((await f.run({action:'rollback-producer'})).state,'producer_rolled_back')
  assert.equal(await fs.readFile(f.manager.configFile,'utf8'),f.oldRaw.configuration)
  assert.equal(await fs.readFile(f.manager.lifecycleStore.file,'utf8'),f.oldRaw.lifecycle)
  await f.preservedCheck()
})
test('recovery after an interrupted reverse publication retains the durable rollback direction',async t=>{
  const f=await fixture(t);await f.run()
  await assert.rejects(f.run({action:'rollback-producer'},{checkpoint:async phase=>{if(phase==='producer_configuration_published')throw Error('interrupted rollback')}}))
  assert.equal((await f.run({action:'recover-producer'})).state,'producer_rolled_back')
  assert.equal(await fs.readFile(f.manager.configFile,'utf8'),f.oldRaw.configuration)
  assert.equal(await fs.readFile(f.manager.lifecycleStore.file,'utf8'),f.oldRaw.lifecycle)
  await f.preservedCheck()
})
for(const mutate of ['configuration','lifecycle','selection','attempt','queue','snapshot','registration'])test(`CAS refuses concurrent ${mutate} mutation before any coupled publication`,async t=>{
  const f=await fixture(t)
  await assert.rejects(f.run({}, {checkpoint:async phase=>{
    if(phase!=='producer_configuration_file_synced')return
    const file={configuration:f.manager.configFile,lifecycle:f.manager.lifecycleStore.file,selection:f.manager.file,attempt:path.join(f.config.sourceRoot,'.memoh-computer/attempts/job-0.json'),queue:path.join(f.config.transferStateDir,'job-0.journal'),snapshot:path.join(f.config.herdrConfigRoot,'sessions',f.config.session,'session.json'),registration:path.join(f.config.herdrConfigRoot,'plugins.json')}[mutate]
    await fs.writeFile(file,'foreign mutation')
  }}))
  if(mutate!=='configuration')assert.equal(await fs.readFile(f.manager.configFile,'utf8'),f.oldRaw.configuration)
  await assert.rejects(f.run({action:'recover-producer'}))
})
test('running/unknown producer evidence and unsupported security preservation fail closed',async t=>{
  const f=await fixture(t)
  const manager=await programDeployment(f.root,{...injected,observe:async()=>({...goodEvidence,producerAbsent:false})})
  await assert.rejects(transactProducerUpgrade(manager,f.options,{verifySecurity:security}))
  assert.equal(await fs.readFile(manager.configFile,'utf8'),f.oldRaw.configuration)
  await assert.rejects(f.run({}, {verifySecurity:async()=>{throw Error('security descriptor differs')}}))
  assert.equal(await fs.readFile(manager.configFile,'utf8'),f.oldRaw.configuration)
  await f.preservedCheck()
})
test('CAS catches same-byte inode replacement rather than silently adopting it',async t=>{
  const f=await fixture(t)
  await assert.rejects(f.run({}, {checkpoint:async phase=>{
    if(phase!=='producer_configuration_file_synced')return
    const temporary=path.join(path.dirname(f.manager.configFile),'foreign.json')
    await fs.writeFile(temporary,f.oldRaw.configuration);await fs.rename(temporary,f.manager.configFile)
  }}))
  assert.equal(await fs.readFile(f.manager.configFile,'utf8'),f.oldRaw.configuration)
  assert.equal((await f.manager.read()).current,f.old.hash)
  await f.preservedCheck()
})
test('new binding proves the archived original recovery configuration without rewriting its historical hash',async t=>{
  const f=await fixture(t), stopped=JSON.parse(f.oldRaw.lifecycle), statusFile=path.join(f.manager.lifecycleDirectory,'host-status.json')
  const status=JSON.parse(await fs.readFile(statusFile,'utf8'));status.phase='running'
  await fs.writeFile(statusFile,encode(status))
  const prior={schema:1,identity:f.config.deviceId,phase:'running',attention:null,restarts:[]}, priorRaw=encode(prior)
  await fs.writeFile(path.join(f.manager.lifecycleDirectory,`lifecycle-before-recheck-${sha(priorRaw)}.json`),priorRaw)
  const runtimeRaw=await fs.readFile(f.manager.runtimeFile,'utf8')
  stopped.infrastructureRecovery={schema:1,fromState:sha(priorRaw),run:status.runId,configuration:recoveryConfigurationHash(f.oldRaw.configuration,runtimeRaw),
    attempts:await attemptEvidence(f.config),previousPhase:'running',previousAttention:null,businessReplayed:false}
  await f.manager.lifecycleStore.save(stopped)
  f.oldRaw.lifecycle=await fs.readFile(f.manager.lifecycleStore.file,'utf8');f.options.lifecycleSha256=sha(f.oldRaw.lifecycle)
  await f.write(path.join(f.root,'logs/endpoint-host',status.runId+'.jsonl'),encode({schema:1,runId:status.runId,phase:'starting',at:status.updatedAt-1}))
  await f.run()
  const manager=await f.create(), current=await manager.lifecycleStore.load()
  assert.deepEqual(current.infrastructureRecovery,stopped.infrastructureRecovery)
  assert.notEqual(current.infrastructureRecovery.configuration,recoveryConfigurationHash(manager.configRaw,manager.runtimeRaw))
  assert.equal(await manager.work(programProfileHash),null)
  await f.preservedCheck()
})
if(process.platform==='win32')test('Windows replacement security gate reads the actual full descriptor without editing ACLs',async t=>{
  const f=await nativeInstalledFixture(t), a=path.join(f.base,'reference.json'), b=path.join(f.base,'temporary.json')
  await fs.writeFile(a,'original');await fs.writeFile(b,'replacement')
  await verifyReplacementSecurity(a,b)
  assert.equal(await fs.readFile(a,'utf8'),'original');assert.equal(await fs.readFile(b,'utf8'),'replacement')
})
