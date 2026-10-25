import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {recoverHost,recoveryConfigurationHash,nativeRecoveryEvidence,classifyRecoveryProcesses} from './host-recovery.mjs'
import {nativeInstalledFixture} from './test-support/installed-fixture.mjs'
import {acquireLeases,leaseKeys} from './lifecycle.mjs'
import {spawn,spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const hash = v=>createHash('sha256').update(v).digest('hex')
async function fixture(t) {
  const f=await nativeInstalledFixture(t),root=path.join(f.base,'host'),dir=path.join(root,'data/endpoint')
  await fs.mkdir(path.join(root,'config'),{recursive:true}); await fs.mkdir(dir,{recursive:true})
  const c=JSON.stringify(f.config),r=JSON.stringify({schema:2,mode:'existing-installations',transfer:'disabled'})
  await fs.writeFile(path.join(root,'config/endpoint.json'),c); await fs.writeFile(path.join(root,'config/runtime.json'),r)
  const state={schema:1,identity:f.config.deviceId,phase:'needs_attention',attention:'herdr_observation_unknown',restarts:[100]}
  const raw=JSON.stringify(state),run=randomUUID(),stateFile=path.join(dir,'lifecycle.json'),statusFile=path.join(dir,'host-status.json')
  await fs.writeFile(stateFile,raw)
  // An actually exited isolated child supplies a non-running PID (no guessed PID).
  const child=spawn(process.execPath,['-e','process.exit(0)']); await new Promise(resolve=>child.once('exit',resolve))
  const status={schema:1,owner:'windows-endpoint-host',runId:run,pid:child.pid,updatedAt:Date.now()-10000,phase:'running'}
  await fs.writeFile(statusFile,JSON.stringify(status))
  await fs.mkdir(path.join(root,'logs/endpoint-host'),{recursive:true}); await fs.writeFile(path.join(root,'logs/endpoint-host',run+'.jsonl'),JSON.stringify({schema:1,runId:run,phase:'starting',at:status.updatedAt-10000})+'\n')
  const receipt=path.join(f.config.sourceRoot,'.memoh-computer/attempts/original/receipt.json')
  await fs.mkdir(path.dirname(receipt),{recursive:true});await fs.writeFile(receipt,'{"state":"unknown","prompt_submitted":false,"attempt":1,"pi_session":"original","receipt":"original"}')
  const snapshot=path.join(f.config.herdrConfigRoot,'sessions',f.config.session,'session.json')
  await fs.mkdir(path.dirname(snapshot),{recursive:true});await fs.writeFile(snapshot,JSON.stringify({version:3,workspaces:[{id:'original',tabs:[{panes:{p1:{cwd:f.config.sourceRoot}}}]}]}))
  const options={root,expectedRun:run,expectedState:hash(raw),expectedConfiguration:recoveryConfigurationHash(c,r)}
  const deps={inspect:async()=>({config:f.config,assertUnchanged(){}}),observe:async()=>({ownerVerified:true,oldHostAbsent:true,referencedProcessesAbsent:true})}
  return {...f,root,dir,stateFile,statusFile,state,raw,status,receipt,snapshot,options,deps}
}
test('explicit recheck retains original unknown attempt, journal backup and ordinary workspace; repeat does not write',async t=>{
 const f=await fixture(t),before=await fs.readFile(f.receipt),snapshot=await fs.readFile(f.snapshot)
 const result=await recoverHost(f.options,f.deps);assert.equal(result.state,'infrastructure_rechecked');assert.equal(result.started,false);assert.equal(result.businessReplayed,false)
 const saved=JSON.parse(await fs.readFile(f.stateFile));assert.equal(saved.phase,'stopped');assert.equal(saved.attention,null);assert.deepEqual(saved.restarts,[100]);assert.equal(saved.sessionContinuation.ordinary,true)
 assert.equal(await fs.readFile(path.join(f.dir,`lifecycle-before-recheck-${f.options.expectedState}.json`),'utf8'),f.raw)
 assert.deepEqual(await fs.readFile(f.receipt),before);assert.deepEqual(await fs.readFile(f.snapshot),snapshot)
 const after=await fs.readFile(f.stateFile);assert.equal((await recoverHost(f.options,f.deps)).state,'already_rechecked');assert.deepEqual(await fs.readFile(f.stateFile),after)
})
for(const change of ['wrong_run','wrong_config','wrong_state','live_pid','wrong_attention','handoff','agent_history','process_unknown','herdr_present','attempt_changed','config_changed','state_changed','run_log_changed','attempt_changes_during_probe'])test(`recheck refuses ${change} without erasing prior evidence`,async t=>{
 const f=await fixture(t)
 if(change==='wrong_run') f.options.expectedRun=randomUUID()
 if(change==='wrong_config') f.options.expectedConfiguration='b'.repeat(64)
 if(change==='wrong_state') f.options.expectedState='b'.repeat(64)
 if(change==='live_pid'){f.status.pid=process.pid;await fs.writeFile(f.statusFile,JSON.stringify(f.status))}
 if(change==='wrong_attention'){f.state.attention='transfer_permission';await fs.writeFile(f.stateFile,JSON.stringify(f.state));f.options.expectedState=hash(JSON.stringify(f.state))}
 if(change==='handoff'){f.state.handoff={invalid:true};await fs.writeFile(f.stateFile,JSON.stringify(f.state));f.options.expectedState=hash(JSON.stringify(f.state))}
 if(change==='agent_history'){const s=JSON.parse(await fs.readFile(f.snapshot));s.workspaces[0].tabs[0].panes.p1.agent_session={value:'original'};await fs.writeFile(f.snapshot,JSON.stringify(s))}
 if(['process_unknown','herdr_present'].includes(change))f.deps.observe=async()=>{throw Object.assign(new Error('unavailable'),{code:'host_recovery_process_evidence_unavailable'})}
 if(change==='attempt_changed')f.deps.checkpoint=async phase=>{if(phase==='backup_synced')await fs.writeFile(f.receipt,'CHANGED BY ORIGINAL OWNER')}
 if(change==='config_changed')f.deps.checkpoint=async phase=>{if(phase==='before_publish')await fs.appendFile(path.join(f.root,'config/endpoint.json'),' ')}
 if(change==='state_changed')f.deps.checkpoint=async phase=>{if(phase==='before_publish')await fs.appendFile(f.stateFile,' ')}
 if(change==='run_log_changed')f.deps.checkpoint=async phase=>{if(phase==='before_publish')await fs.appendFile(path.join(f.root,'logs/endpoint-host',f.options.expectedRun+'.jsonl'),' ')}
 if(change==='attempt_changes_during_probe')f.deps.observe=async()=>{await fs.writeFile(f.receipt,'CHANGED WHILE CIM WAS READING')}
 const original=await fs.readFile(f.stateFile)
 await assert.rejects(recoverHost(f.options,f.deps))
 assert.deepEqual(await fs.readFile(f.stateFile),change==='state_changed'?Buffer.concat([original,Buffer.from(' ')]):original)
})
test('actual component/host lease prevents recheck',async t=>{
 const f=await fixture(t),release=await acquireLeases([`host:${f.root}`,...leaseKeys(f.config)],f.dir)
 try{await assert.rejects(recoverHost(f.options,f.deps),{code:'endpoint_already_owned'});assert.equal(await fs.readFile(f.stateFile,'utf8'),f.raw)}finally{await release()}
})
for(const phase of ['backup','publish','after_publish'])test(`persistence ${phase} failure preserves backup and supports honest outcome readback`,async t=>{
 const f=await fixture(t)
 if(phase==='backup')f.deps.io={...fs,open:async()=>{throw Object.assign(new Error('read only'),{code:'EACCES'})}}
 else if(phase==='publish')f.deps.io={...fs,rename:async()=>{throw Object.assign(new Error('full'),{code:'ENOSPC'})}}
 else f.deps.io={...fs,rename:async(a,b)=>{await fs.rename(a,b);throw new Error('response lost')}}
 await assert.rejects(recoverHost(f.options,f.deps))
 if(phase==='after_publish')assert.equal((await recoverHost(f.options,f.deps)).state,'already_rechecked')
 else assert.equal(await fs.readFile(f.stateFile,'utf8'),f.raw)
 assert.equal(JSON.parse(await fs.readFile(f.receipt)).state,'unknown')
})
test('process termination after backup leaves original journal; later recheck can continue',async t=>{
 const f=await fixture(t);f.deps.checkpoint=async phase=>{if(phase==='backup_synced')throw new Error('synthetic termination boundary')}
 await assert.rejects(recoverHost(f.options,f.deps));assert.equal(await fs.readFile(f.stateFile,'utf8'),f.raw)
 delete f.deps.checkpoint;assert.equal((await recoverHost(f.options,f.deps)).state,'infrastructure_rechecked')
})
if (process.platform === 'win32') test('native read-only owner/process probe accepts an exited child and rejects a live PID on Windows', async t=>{
 const f=await fixture(t)
 // Use the actual installed Node and inert nonexistent official paths. No Herdr
 // command is invoked: first prove the helper itself under the production wrapper.
 const config={...f.config,programs:{...f.config.programs,node:process.execPath}}
 const files={root:f.root,state:f.stateFile,config:path.join(f.root,'config/endpoint.json'),runtime:path.join(f.root,'config/runtime.json'),status:f.statusFile}
 // Use the existing creator for fresh private fixtures; do not alter a preexisting
 // file's ACL/owner just to pass the recovery probe.
 const audit=path.join(f.base,'private-audit'),input=path.join(f.base,'private-audit-input.json')
 const items=[{kind:'directory',path:audit}]
 for(const key of ['state','config','runtime','status']) {
   const content=await fs.readFile(files[key],'utf8')
   files[key]=path.join(audit,key+'.json');items.push({kind:'file',path:files[key],content})
 }
 await fs.writeFile(input,JSON.stringify({root:f.base,items}))
 const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe')
 const made=spawnSync(ps,['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./official-smoke/private-fixture.ps1',import.meta.url)),'-InputFile',input],{encoding:'utf8',timeout:15000,maxBuffer:4096})
 assert.equal(made.status,0,'create only fresh private probe files')

 // Helper succeeds, then the inert Herdr command fails; this is not real Herdr qualification.
 await assert.rejects(nativeRecoveryEvidence({config,status:f.status,files}),error=>{ assert.equal(error.code,'herdr_observation_unknown',`probe stage: ${error.evidenceStage || 'herdr_status'}`); return true })
 await assert.rejects(nativeRecoveryEvidence({config,status:{...f.status,pid:process.pid},files}),{code:'host_recovery_process_evidence_unavailable'})
})
if(process.platform === 'win32')test('actual recovery process exit after durable backup does not publish or replay; same evidence retries safely',async t=>{
 const f=await fixture(t),entry=new URL('./host-recovery.mjs',import.meta.url).href
 const code=`import {recoverHost} from ${JSON.stringify(entry)}; await recoverHost(${JSON.stringify(f.options)}, {inspect:async()=>({config:${JSON.stringify(f.config)},assertUnchanged(){}}),observe:async()=>{},checkpoint:async phase=>{if(phase==='backup_synced')process.exit(73)}})`
 const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['ignore','ignore','pipe']})
 const timer=setTimeout(()=>child.kill(),10000)
 const status=await new Promise(resolve=>child.once('exit',resolve));clearTimeout(timer);assert.equal(status,73)
 assert.equal(await fs.readFile(f.stateFile,'utf8'),f.raw);assert.equal(JSON.parse(await fs.readFile(f.receipt)).state,'unknown')
 assert.equal((await recoverHost(f.options,f.deps)).state,'infrastructure_rechecked')
})

const scopeContext={oldPid:100,currentSession:1,runStart:1000}
const scopeAnchor={id:50,parent:4,created:500,windowsSession:1,role:'other'}
const externalHerdr={id:200,parent:50,created:2000,windowsSession:1,role:'herdr',scope:'different_session',ownerCurrent:true,originalReference:false}
const externalPi={id:300,parent:200,created:3000,windowsSession:1,role:'pi',scope:'different_task_root',ownerCurrent:true,originalReference:false}
test('shared Herdr/Pi binaries are excluded only with actual older external ancestry and distinct scope',()=>{
 const got=classifyRecoveryProcesses([scopeAnchor,externalHerdr,externalPi],scopeContext)
 assert.equal(got.absent,true);assert.deepEqual(got.excluded.map(p=>p.pid),[200,300])
 assert.equal(classifyRecoveryProcesses([scopeAnchor,externalHerdr,{...externalPi,scope:'interactive'}],scopeContext).absent,true)
})
for(const [name,records,context] of [
 ['original host still present',[scopeAnchor,{...scopeAnchor,id:100}],scopeContext],
 ['same-session Herdr',[scopeAnchor,{...externalHerdr,scope:'same'}],scopeContext],
 ['original task path',[scopeAnchor,externalHerdr,{...externalPi,originalReference:true}],scopeContext],
 ['unknown Pi scope',[scopeAnchor,externalHerdr,{...externalPi,scope:'unknown'}],scopeContext],
 ['missing parent',[externalHerdr,externalPi],scopeContext],
 ['cyclic later-generation parent chain',[{...externalHerdr,parent:300},{...externalPi,created:2000}],scopeContext],
 ['reused parent PID',[{...scopeAnchor,created:4000},externalHerdr,externalPi],scopeContext],
 ['parent chain enters original host',[{...scopeAnchor,id:100},externalHerdr,{...externalPi,parent:100}],scopeContext],
 ['missing original run start',[scopeAnchor,externalHerdr,externalPi],{...scopeContext,runStart:null}],
 ['different session name without observed ancestry',[{...externalHerdr,parent:999}],scopeContext],
 ['earlier Pi without observed ancestry',[{...externalPi,created:100,parent:999}],scopeContext],
 ['unknown process identity',[scopeAnchor,{...externalHerdr,ownerCurrent:false}],scopeContext],
 ['different Windows session',[scopeAnchor,{...externalHerdr,windowsSession:2}],scopeContext],
 ['same Runtime enrollment',[scopeAnchor,{...externalHerdr,role:'connector',scope:'same'}],scopeContext],
 ['unknown Runtime enrollment',[scopeAnchor,{...externalHerdr,role:'connector',scope:'unknown'}],scopeContext],
])test(`scope recheck keeps ${name} blocked`,()=>assert.equal(classifyRecoveryProcesses(records,context).absent,false))
test('different explicit Runtime enrollment also requires a verified external generation chain',()=>{
 const connector={...externalHerdr,role:'connector',scope:'different_enrollment'}
 assert.equal(classifyRecoveryProcesses([scopeAnchor,connector],scopeContext).absent,true)
 assert.equal(classifyRecoveryProcesses([connector],scopeContext).absent,false)
})
test('unknown identity is reported separately from an observed original task reference',()=>{
 assert.equal(classifyRecoveryProcesses([scopeAnchor,{...externalHerdr,ownerCurrent:false}],scopeContext).reason,'process_identity_unknown')
 assert.equal(classifyRecoveryProcesses([scopeAnchor,externalHerdr,{...externalPi,originalReference:true}],scopeContext).reason,'original_process_reference')
})
if(process.platform === 'win32')test('native scoped probe excludes a live unrelated Pi-style process but rejects the same binary with original task roots',async t=>{
 const f=await fixture(t),config={...f.config,programs:{...f.config.programs,node:process.execPath}}
 // Disposable test program, not a modified official Pi installation.
 await fs.writeFile(f.p.pi,'setInterval(()=>{},1000)')
 const files={root:f.root,state:f.stateFile,config:path.join(f.root,'config/endpoint.json'),runtime:path.join(f.root,'config/runtime.json'),status:f.statusFile}
 // Reuse fresh private objects for production file-trust checks.
 const audit=path.join(f.base,'scope-audit'),input=path.join(f.base,'scope-input.json'),items=[{kind:'directory',path:audit}]
 for(const key of ['state','config','runtime','status']) {const content=await fs.readFile(files[key],'utf8');files[key]=path.join(audit,key+'.json');items.push({kind:'file',path:files[key],content})}
 await fs.writeFile(input,JSON.stringify({root:f.base,items}))
 const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe')
 assert.equal(spawnSync(ps,['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./official-smoke/private-fixture.ps1',import.meta.url)),'-InputFile',input],{timeout:15000,maxBuffer:4096}).status,0)
 async function candidate(dir,expected) {
  const child=spawn(process.execPath,[f.p.pi,...(dir === null ? ['--continue'] : ['--session-dir',dir])],{stdio:'ignore'})
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)})
  try{await assert.rejects(nativeRecoveryEvidence({config,status:f.status,files}),error=>{assert.equal(error.code,expected,`scope probe stage: ${error.evidenceStage}; reason: ${error.processReason}`);if(expected === 'host_recovery_process_evidence_unavailable')assert.equal(error.processReason,'original_process_reference');return true})}
  finally {const closed=new Promise(resolve=>child.once('exit',resolve));child.kill();await closed}
 }
 await candidate(null, 'herdr_observation_unknown')
 await candidate(path.join(f.config.sourceRoot,'.memoh-computer/sessions/original'), 'host_recovery_process_evidence_unavailable')
})
