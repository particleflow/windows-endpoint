import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import {createHash,randomUUID} from 'node:crypto'
import {recoverHost,recoveryConfigurationHash,nativeRecoveryEvidence} from './host-recovery.mjs'
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
for(const change of ['wrong_run','wrong_config','wrong_state','live_pid','wrong_attention','handoff','agent_history','process_unknown','herdr_present','attempt_changed','config_changed','state_changed'])test(`recheck refuses ${change} without erasing prior evidence`,async t=>{
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
 await assert.rejects(nativeRecoveryEvidence({config,status:f.status,files}),{code:'herdr_observation_unknown'})
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
