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
import {createProducerReferenceAdapter,producerReferenceAdapter,externalProducerIdentity} from './producer-reference.mjs'
import {inspectInstalled} from './installed.mjs'

const sha = value => createHash('sha256').update(value).digest('hex')
const encode = value => JSON.stringify(value) + '\n'
// Synthetic package metadata/inert EXEs exercise the updater contract only.
// Real 57/62d execution and NTFS publication are separate Windows evidence.
async function packageFixture(directory, old, sourceCommit) {
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
  if(old)pkg.manifest.source_commit=sourceCommit||'57ae131eff3fb675a51b6ea5ee945bfa0b9de837'
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
async function fixture(t,{snapshot=true,agent=false,external=false,externalRecorded=false}={}) {
  const f=await nativeInstalledFixture(t), root=path.join(f.base,'host')
  const old=await packageFixture(path.join(f.base,'old'),true), next=await packageFixture(path.join(f.base,'new'),false)
  const source=externalRecorded?await packageFixture(path.join(f.base,'original candidate'),true,externalProducerIdentity.sourceCommit):null
  const securityOverrides=new Map(),securityDefault={ownerSid:'S-1-5-21-1-2-3-1001',groupSid:'S-1-5-32-545',descriptorSha256:sha('inert fixture descriptor')}
  const reference=source?createProducerReferenceAdapter({identity:{...externalProducerIdentity,manifestSha256:source.hash,
    executableSha256:source.manifest.files.find(file=>file.path==='transfer/transferqueue.exe').sha256,
    executableSize:source.manifest.files.find(file=>file.path==='transfer/transferqueue.exe').size},
    security:async files=>files.map(file=>securityOverrides.get(file)||securityDefault)}):null
  const config={...f.config,transfer:{pluginRoot:source?path.join(source.directory,'transfer'):external?path.join(f.base,'external'):path.join(root,'packages',old.hash,'transfer'),nasOrigin:'https://nas.example.com'},
    transferConfigDir:path.join(f.base,'transfer-config'),transferStateDir:path.join(f.base,'transfer-state')}
  await fs.mkdir(config.transferConfigDir);await fs.mkdir(config.transferStateDir)
  const transferFile=path.join(config.transferConfigDir,'transfer.json')
  const transferRaw=encode({version:1,origin:config.transfer.nasOrigin,source_root:config.sourceRoot})
  await fs.writeFile(transferFile,transferRaw)
  await fs.mkdir(path.join(root,'config'),{recursive:true})
  await fs.writeFile(path.join(root,'config/endpoint.json'),encode(config))
  await fs.writeFile(path.join(root,'config/runtime.json'),encode({schema:2,mode:'existing-installations',transfer:'disabled'}))
  if(snapshot)await f.write(path.join(config.herdrConfigRoot,'sessions',config.session,'session.json'),encode({version:3,workspaces:[{id:'ordinary',tabs:[{panes:{one:{cwd:config.sourceRoot,...(agent?{agent_name:'pi'}:{label:'saved shell'})}}}]}]}))
  const manager=await programDeployment(root,{prepare:true,...injected});await manager.initialize()
  await fs.cp(old.directory,path.join(root,'packages',old.hash),{recursive:true})
  const selected={schema:1,owner:config.deviceId,packages:[{hash:old.hash,profile:profileForProducer(historicalProducer)}],current:old.hash,previous:null,pending:null}
  if(source){await fs.cp(source.directory,path.join(root,'packages',source.hash),{recursive:true});selected.packages.push({hash:source.hash,profile:profileForProducer(historicalProducer)})}
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
  const create=async()=>{const value=await programDeployment(root,injected);if(reference)value.producerReference=reference;return value}
  const run=async(extra={},hooks={})=>transactProducerUpgrade(await create(),{...options,...extra},{verifySecurity:security,...hooks})
  const preservedCheck=async({transfer=true}={})=>{
    for(const [file,raw]of preserved)assert.equal(await fs.readFile(file,'utf8'),raw)
    assert.equal(await producerStateEvidence(config),queue)
    if(transfer)assert.equal(await fs.readFile(transferFile,'utf8'),transferRaw)
  }
  return{...f,root,config,manager,old,next,oldRaw,options,run,create,preservedCheck,transferFile,transferRaw,source,reference,securityOverrides,securityDefault,programProbe:f.run}
}

test('transfer.json newline drift after archive refuses publication without changing the original task bindings',async t=>{
  const f=await fixture(t)
  await assert.rejects(f.run({}, {checkpoint:async phase=>{
    if(phase==='producer_archived')await fs.appendFile(f.transferFile,'\n')
  }}),{code:'producer_upgrade_transfer_configuration_changed'})
  assert.equal(await fs.readFile(f.transferFile,'utf8'),f.transferRaw+'\n')
  assert.equal(await fs.readFile(f.manager.configFile,'utf8'),f.oldRaw.configuration)
  assert.equal(await fs.readFile(f.manager.lifecycleStore.file,'utf8'),f.oldRaw.lifecycle)
  assert.equal(await fs.readFile(f.manager.file,'utf8'),f.oldRaw.selection)
  await f.preservedCheck({transfer:false})
})

test('transfer.json same-byte replacement after archive refuses a changed file generation',async t=>{
  const f=await fixture(t)
  await assert.rejects(f.run({}, {checkpoint:async phase=>{
    if(phase!=='producer_archived')return
    const replacement=path.join(f.config.transferConfigDir,'replacement.json')
    await fs.writeFile(replacement,f.transferRaw);await fs.rename(replacement,f.transferFile)
  }}),{code:'producer_upgrade_transfer_configuration_changed'})
  const plan=JSON.parse(await fs.readFile(path.join(f.manager.lifecycleDirectory,'producer-upgrade-history',f.options.requestId,'plan.json'),'utf8'))
  assert.equal(plan.schema,2);assert.equal(plan.transferConfiguration.sha256,sha(f.transferRaw))
  assert.equal(await fs.readFile(f.manager.configFile,'utf8'),f.oldRaw.configuration)
  assert.equal(await fs.readFile(f.manager.lifecycleStore.file,'utf8'),f.oldRaw.lifecycle)
  assert.equal(await fs.readFile(f.manager.file,'utf8'),f.oldRaw.selection)
  await f.preservedCheck()
})

test('transfer.json drift during initial asynchronous process observation cannot become the recorded baseline',async t=>{
  const f=await fixture(t)
  const manager=await programDeployment(f.root,{...injected,observe:async()=>{await fs.appendFile(f.transferFile,'\n');return goodEvidence}})
  await assert.rejects(transactProducerUpgrade(manager,f.options,{verifySecurity:security}),{code:'producer_upgrade_transfer_configuration_changed'})
  await assert.rejects(fs.lstat(path.join(f.manager.lifecycleDirectory,'producer-upgrade-history')),{code:'ENOENT'})
  assert.equal(await fs.readFile(f.manager.configFile,'utf8'),f.oldRaw.configuration)
  await f.preservedCheck({transfer:false})
})

for(const phase of ['producer_configuration_file_synced','producer_configuration_published','producer_ready_synced','producer_marker_released','producer_release_file_synced'])test(`transfer.json newline drift at ${phase} retains the fence and rejects recovery/rollback`,async t=>{
  const f=await fixture(t)
  await assert.rejects(f.run({}, {checkpoint:async current=>{
    if(current===phase)await fs.appendFile(f.transferFile,'\n')
  }}),{code:'producer_upgrade_transfer_configuration_changed'})
  assert.equal((await f.manager.lifecycleStore.load()).attention,'producer_upgrade_pending')
  const files=[f.manager.configFile,f.manager.lifecycleStore.file,f.manager.file], before=await Promise.all(files.map(file=>fs.readFile(file,'utf8')))
  for(const action of ['recover-producer','rollback-producer'])await assert.rejects(f.run({action}),{code:'producer_upgrade_transfer_configuration_changed'})
  assert.deepEqual(await Promise.all(files.map(file=>fs.readFile(file,'utf8'))),before)
  assert.equal(await fs.readFile(f.transferFile,'utf8'),f.transferRaw+'\n')
  await f.preservedCheck({transfer:false})
})

for(const action of ['recover-producer','rollback-producer'])test(`transfer.json changed after interruption cannot be adopted by ${action}`,async t=>{
  const f=await fixture(t)
  await assert.rejects(f.run({}, {checkpoint:async phase=>{if(phase==='producer_configuration_published')throw Error('isolated interruption')}}))
  const files=[f.manager.configFile,f.manager.lifecycleStore.file,f.manager.file], before=await Promise.all(files.map(file=>fs.readFile(file,'utf8')))
  await fs.appendFile(f.transferFile,'\n')
  await assert.rejects(f.run({action}),{code:'producer_upgrade_transfer_configuration_changed'})
  assert.deepEqual(await Promise.all(files.map(file=>fs.readFile(file,'utf8'))),before)
  assert.equal(await fs.readFile(f.transferFile,'utf8'),f.transferRaw+'\n')
  await f.preservedCheck({transfer:false})
})

test('transfer.json original evidence is mandatory for a historical unbound pending plan',async t=>{
  const f=await fixture(t)
  await assert.rejects(f.run({}, {checkpoint:async phase=>{if(phase==='producer_intent_synced')throw Error('isolated interruption')}}))
  const planFile=path.join(f.manager.lifecycleDirectory,'producer-upgrade-history',f.options.requestId,'plan.json'), markerFile=path.join(f.manager.lifecycleDirectory,producerPendingName)
  const plan=JSON.parse(await fs.readFile(planFile,'utf8'));plan.schema=1;delete plan.transferConfiguration
  const planRaw=encode(plan),markerRaw=encode({schema:1,requestId:f.options.requestId,planSha256:sha(planRaw)})
  await fs.writeFile(planFile,planRaw);await fs.writeFile(markerFile,markerRaw)
  for(const action of ['recover-producer','rollback-producer'])await assert.rejects(f.run({action}),{code:'producer_upgrade_transfer_configuration_unrecorded'})
  assert.equal(await fs.readFile(planFile,'utf8'),planRaw);assert.equal(await fs.readFile(markerFile,'utf8'),markerRaw)
  assert.equal(await fs.readFile(f.manager.configFile,'utf8'),f.oldRaw.configuration)
  await f.preservedCheck()
})

test('transfer.json drift inside the last process observation cannot release the lifecycle fence',async t=>{
  const f=await fixture(t)
  let drift=false
  const manager=await programDeployment(f.root,{...injected,observe:async()=>{
    if(drift){drift=false;await fs.appendFile(f.transferFile,'\n')}
    return goodEvidence
  }})
  await assert.rejects(transactProducerUpgrade(manager,f.options,{verifySecurity:security,checkpoint:async phase=>{
    if(phase==='producer_release_file_synced')drift=true
  }}),{code:'producer_upgrade_transfer_configuration_changed'})
  assert.equal((await f.manager.lifecycleStore.load()).attention,'producer_upgrade_pending')
  await f.preservedCheck({transfer:false})
})

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
  assert.equal(result.transferConfigurationSha256,sha(f.transferRaw))
  assert.match(result.transferConfigurationVersion,/^-?\d+(?::-?\d+){5}$/)
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
test('new binding proves archived recovery without rewriting its hash and rejects transfer.json drift in transition/rollback',async t=>{
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
  const files=[manager.configFile,manager.lifecycleStore.file,manager.file], before=await Promise.all(files.map(file=>fs.readFile(file,'utf8')))
  await fs.appendFile(f.transferFile,'\n')
  await assert.rejects(manager.work(programProfileHash),{code:'producer_upgrade_transfer_configuration_changed'})
  await assert.rejects(f.run({action:'rollback-producer'}),{code:'producer_upgrade_transfer_configuration_changed'})
  assert.deepEqual(await Promise.all(files.map(file=>fs.readFile(file,'utf8'))),before)
  assert.equal(await fs.readFile(f.transferFile,'utf8'),f.transferRaw+'\n')
  await f.preservedCheck({transfer:false})
})
if(process.platform==='win32')test('Windows replacement security gate reads the actual full descriptor without editing ACLs',async t=>{
  const f=await nativeInstalledFixture(t), a=path.join(f.base,'reference.json'), b=path.join(f.base,'temporary.json')
  await fs.writeFile(a,'original');await fs.writeFile(b,'replacement')
  await verifyReplacementSecurity(a,b)
  assert.equal(await fs.readFile(a,'utf8'),'original');assert.equal(await fs.readFile(b,'utf8'),'replacement')
})

async function externalFixture(t,{recovered=false}={}) {
  const f=await fixture(t,{externalRecorded:true})
  if(recovered) {
    const state=JSON.parse(f.oldRaw.lifecycle),statusFile=path.join(f.manager.lifecycleDirectory,'host-status.json')
    const status=JSON.parse(await fs.readFile(statusFile,'utf8'));status.phase='running';await fs.writeFile(statusFile,encode(status))
    const priorRaw=encode({schema:1,identity:f.config.deviceId,phase:'running',attention:null,restarts:[]})
    await fs.writeFile(path.join(f.manager.lifecycleDirectory,`lifecycle-before-recheck-${sha(priorRaw)}.json`),priorRaw)
    state.infrastructureRecovery={schema:1,fromState:sha(priorRaw),run:status.runId,configuration:recoveryConfigurationHash(f.oldRaw.configuration,await fs.readFile(f.manager.runtimeFile,'utf8')),
      attempts:await attemptEvidence(f.config),previousPhase:'running',previousAttention:null,businessReplayed:false}
    await f.manager.lifecycleStore.save(state);f.oldRaw.lifecycle=await fs.readFile(f.manager.lifecycleStore.file,'utf8');f.options.lifecycleSha256=sha(f.oldRaw.lifecycle)
    await f.write(path.join(f.root,'logs/endpoint-host',status.runId+'.jsonl'),encode({schema:1,runId:status.runId,phase:'starting',at:status.updatedAt-1}))
  }
  const preview=await f.run({action:'plan-producer'})
  assert.equal(preview.externalDirectoryAdopted,false)
  f.options.referenceSha256=preview.referenceSha256
  return {...f,preview}
}
test('external reference keeps host57 distinct from the recorded41 witness and switches without importing or writing the source',async t=>{
  const f=await externalFixture(t),selected=await f.manager.read()
  const before=await f.reference.capture(selected,f.config,f.manager.layout)
  assert.notEqual(f.old.hash,f.source.hash)
  assert.equal((await f.run()).state,'host_producer_selected')
  const after=await f.manager.read();assert.equal(after.current,f.next.hash);assert.equal(after.previous,f.old.hash)
  assert.deepEqual(after.packages,selected.packages)
  assert.deepEqual(await f.reference.capture(selected,f.config,f.manager.layout),before)
  const plan=JSON.parse(await fs.readFile(path.join(f.manager.lifecycleDirectory,'producer-upgrade-history',f.options.requestId,'plan.json'),'utf8'))
  assert.equal(plan.schema,3);assert.equal(plan.from,f.old.hash);assert.equal(plan.producerSource.registeredManifestSha256,f.source.hash)
  assert.equal((await f.run({action:'rollback-producer'})).state,'producer_rolled_back')
  assert.equal(await fs.readFile(f.manager.configFile,'utf8'),f.oldRaw.configuration)
  assert.equal(await fs.readFile(f.manager.lifecycleStore.file,'utf8'),f.oldRaw.lifecycle)
  assert.equal(await fs.readFile(f.manager.file,'utf8'),f.oldRaw.selection)
  await f.preservedCheck()
})
test('external reference requires the exact preview digest; production identity and staging pins cannot be overridden by the fixture',async t=>{
  const f=await externalFixture(t)
  for(const referenceSha256 of [undefined,'0'.repeat(64)])await assert.rejects(f.run({referenceSha256}),{code:'producer_upgrade_external_reference_review_required'})
  await assert.rejects(producerReferenceAdapter.capture(await f.manager.read(),f.config,f.manager.layout),{code:'producer_upgrade_external_reference_unverified'})
  await assert.rejects(verifyCandidate(f.source.directory,f.source.hash),{code:'candidate_kind_or_producer_mismatch'})
  await assert.rejects(fs.lstat(path.join(f.manager.lifecycleDirectory,'producer-upgrade-history')),{code:'ENOENT'})
  await f.preservedCheck()
})
for(const mutate of ['missing_record','wrong_profile','registered_manifest','registered_payload','external_payload','external_manifest','external_proof','extra_file','hard_link','junction','owner','dacl','security_missing'])test(`external reference refuses ${mutate} without changing host or data`,async t=>{
  const f=await externalFixture(t)
  if(mutate==='missing_record'||mutate==='wrong_profile') {
    const state=await f.manager.read()
    if(mutate==='missing_record')state.packages=state.packages.filter(item=>item.hash!==f.source.hash)
    else state.packages.find(item=>item.hash===f.source.hash).profile='0'.repeat(64)
    const raw=encode(state);await fs.writeFile(f.manager.file,raw);f.options.selectionSha256=sha(raw)
  } else if(mutate==='security_missing')f.securityOverrides.set(path.join(f.source.directory,'transfer/transferqueue.exe'),{})
  else if(mutate==='owner'||mutate==='dacl') {
    f.securityOverrides.set(path.join(f.source.directory,'transfer/transferqueue.exe'),{...f.securityDefault,
      ...(mutate==='owner'?{ownerSid:'S-1-5-21-1-2-3-1002'}:{descriptorSha256:sha('changed DACL')})})
  } else if(mutate==='extra_file')await fs.writeFile(path.join(f.source.directory,'transfer/unknown.txt'),'unknown; retain')
  else if(mutate==='hard_link')await fs.link(path.join(f.source.directory,'transfer/transferqueue.exe'),path.join(f.base,'alias.exe'))
  else if(mutate==='junction') {
    const root=path.join(f.source.directory,'transfer'),other=path.join(f.source.directory,'original-transfer')
    await fs.rename(root,other);await fs.symlink(other,root,'junction')
  } else {
    const file=mutate==='registered_manifest'?path.join(f.root,'packages',f.source.hash,'candidate.json'):mutate==='registered_payload'?path.join(f.root,'packages',f.source.hash,'transfer/transferqueue.exe'):
      mutate==='external_manifest'?path.join(f.source.directory,'candidate.json'):
      mutate==='external_proof'?path.join(f.source.directory,'transfer/SHA256SUMS.json'):path.join(f.source.directory,'transfer/transferqueue.exe')
    await fs.appendFile(file,'\n')
  }
  await assert.rejects(f.run())
  assert.equal(await fs.readFile(f.manager.configFile,'utf8'),f.oldRaw.configuration)
  assert.equal(await fs.readFile(f.manager.lifecycleStore.file,'utf8'),f.oldRaw.lifecycle)
  await f.preservedCheck()
})
test('external reference cannot reuse a preview for another path containing identical bytes',async t=>{
  const f=await externalFixture(t),other=path.join(f.base,'other candidate');await fs.cp(f.source.directory,other,{recursive:true})
  const config=structuredClone(f.config);config.transfer.pluginRoot=path.join(other,'transfer')
  const raw=encode(config);await fs.writeFile(f.manager.configFile,raw)
  await assert.rejects(f.run({configurationSha256:sha(raw)}),{code:'producer_upgrade_external_reference_review_required'})
  assert.equal(await fs.readFile(f.manager.configFile,'utf8'),raw)
  assert.equal(await fs.readFile(f.manager.lifecycleStore.file,'utf8'),f.oldRaw.lifecycle)
  await f.preservedCheck()
})
test('external reference refuses a pinned producer target without the new recovery entry capability',async t=>{
  const f=await externalFixture(t)
  delete f.next.manifest.native_producer_reference
  await fs.writeFile(path.join(f.next.directory,'candidate.json'),encode(f.next.manifest))
  const target=await digest(path.join(f.next.directory,'candidate.json'))
  await f.manager.stage(f.next.directory,target)
  const selectionRaw=await fs.readFile(f.manager.file,'utf8')
  await assert.rejects(f.run({target,selectionSha256:sha(selectionRaw)}),{code:'producer_upgrade_external_target_unsupported'})
  assert.equal(await fs.readFile(f.manager.file,'utf8'),selectionRaw)
  assert.equal(await fs.readFile(f.manager.configFile,'utf8'),f.oldRaw.configuration)
  await f.preservedCheck()
})
for(const phase of ['producer_intent_synced','producer_configuration_file_synced','producer_configuration_published','producer_ready_synced','producer_marker_released'])test(`external reference interruption ${phase} resumes against the original witness`,async t=>{
  const f=await externalFixture(t)
  await assert.rejects(f.run({}, {checkpoint:async at=>{if(at===phase)throw Error('isolated interruption')}}))
  assert.equal((await f.run({action:'recover-producer'})).state,'host_producer_selected')
  await f.preservedCheck()
})
for(const mutate of ['source_bytes','source_generation','source_security','transfer_json'])test(`external reference ${mutate} drift during interruption refuses recovery and rollback`,async t=>{
  const f=await externalFixture(t)
  await assert.rejects(f.run({}, {checkpoint:async at=>{if(at==='producer_configuration_published')throw Error('isolated interruption')}}))
  const files=[f.manager.configFile,f.manager.lifecycleStore.file,f.manager.file],before=await Promise.all(files.map(file=>fs.readFile(file,'utf8')))
  const executable=path.join(f.source.directory,'transfer/transferqueue.exe')
  if(mutate==='source_bytes')await fs.appendFile(executable,'\n')
  if(mutate==='source_generation') {const temp=path.join(f.base,'replacement.exe');await fs.copyFile(executable,temp);await fs.rename(temp,executable)}
  if(mutate==='source_security')f.securityOverrides.set(executable,{...f.securityDefault,descriptorSha256:sha('changed permissions')})
  if(mutate==='transfer_json')await fs.appendFile(f.transferFile,'\n')
  for(const action of ['recover-producer','rollback-producer'])await assert.rejects(f.run({action}))
  assert.deepEqual(await Promise.all(files.map(file=>fs.readFile(file,'utf8'))),before)
  assert.equal((await f.manager.lifecycleStore.load()).attention,'producer_upgrade_pending')
  await f.preservedCheck({transfer:mutate!=='transfer_json'})
})
test('external reference source change inside the final observation cannot release attention',async t=>{
  const f=await externalFixture(t),manager=await f.create();let drift=false
  manager.observe=async()=>{if(drift){drift=false;await fs.appendFile(path.join(f.source.directory,'transfer/README.md'),'\n')}return goodEvidence}
  await assert.rejects(transactProducerUpgrade(manager,f.options,{verifySecurity:security,checkpoint:async phase=>{if(phase==='producer_release_file_synced')drift=true}}))
  assert.equal((await f.manager.lifecycleStore.load()).attention,'producer_upgrade_pending')
  await f.preservedCheck()
})
test('external reference completion/transition no longer reads the source; missing original source prevents rollback',async t=>{
  const f=await externalFixture(t,{recovered:true})
  await f.run();await fs.rm(f.source.directory,{recursive:true}) // Disposable fixture only; no product deletion path.
  assert.equal((await f.run({action:'recover-producer'})).state,'already_completed')
  const manager=await f.create()
  // Exercise the real installed-program path inventory, with inert version
  // probes only, after the external candidate has ceased to exist.
  manager.inspect=(config,_run,options)=>inspectInstalled(config,f.programProbe,options)
  assert.equal(await manager.work(programProfileHash),null)
  const files=[manager.configFile,manager.lifecycleStore.file,manager.file],before=await Promise.all(files.map(file=>fs.readFile(file,'utf8')))
  await assert.rejects(f.run({action:'rollback-producer'}),{code:'producer_upgrade_external_reference_unverified'})
  assert.deepEqual(await Promise.all(files.map(file=>fs.readFile(file,'utf8'))),before)
  await f.preservedCheck()
})
if(process.platform==='win32')test('external reference reads actual source and registered SID/DACL without adopting either directory',async t=>{
  const f=await externalFixture(t),state=await f.manager.read()
  const executable=f.source.manifest.files.find(file=>file.path==='transfer/transferqueue.exe')
  const actual=createProducerReferenceAdapter({identity:{...externalProducerIdentity,manifestSha256:f.source.hash,executableSha256:executable.sha256,executableSize:executable.size}})
  const before=await actual.capture(state,f.config,f.manager.layout)
  assert.ok(before.objects.every(item=>item.security.ownerSid.startsWith('S-')))
  await actual.assert(before,state,f.config,f.manager.layout)
  await f.preservedCheck()
})
