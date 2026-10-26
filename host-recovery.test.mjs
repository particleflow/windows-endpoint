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
if (process.platform === 'win32') test('native read-only owner/process probe accepts an exited child and rejects a live PID on Windows', {timeout:60000}, async t=>{
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
 const made=spawnSync(ps,['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./official-smoke/private-fixture.ps1',import.meta.url)),'-InputFile',input],{encoding:'utf8',timeout:30000,maxBuffer:4096})
 assert.equal(made.status,0,'create only fresh private probe files')

 // Helper succeeds, then the inert Herdr command fails; this is not real Herdr qualification.
 await assert.rejects(nativeRecoveryEvidence({config,status:f.status,files}),error=>{ assert.equal(error.code,'herdr_observation_unknown',`probe stage: ${error.evidenceStage || 'herdr_status'}; reason: ${error.processReason}; blocking: ${JSON.stringify(error.blockingProcess)}`); return true })
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
 ['unreadable program or command line',[scopeAnchor,{...externalHerdr,role:'unknown'}],scopeContext],
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
 assert.equal(classifyRecoveryProcesses([scopeAnchor,{...externalHerdr,role:'unknown'}],scopeContext).reason,'process_identity_unknown')
 assert.equal(classifyRecoveryProcesses([scopeAnchor,externalHerdr,{...externalPi,originalReference:true}],scopeContext).reason,'original_process_reference')
})
if(process.platform === 'win32')test('native Herdr scope parser recognizes the existing official server modifier without accepting unknown or duplicate arguments',{timeout:15000},async t=>{
 const base=await fs.mkdtemp(path.join(process.env.TEMP,'herdr-scope-'))
 t.after(()=>fs.rm(base,{recursive:true,force:true}))
 const source=await fs.readFile(new URL('./host-recovery.ps1',import.meta.url),'utf8')
 // Exercise the production PowerShell block and OS argv decoder; no Herdr
 // process is started and no security modifier is enabled by this test.
 const decoder=source.slice(source.indexOf('    Add-Type -TypeDefinition'),source.indexOf('    function Same-Path'))
 const flag=source.slice(source.indexOf('    function Flag-Value'),source.indexOf('    $records ='))
 const start=source.indexOf("                if ($p.Name -eq 'herdr.exe') {")
 const end=source.indexOf("                } elseif ($role -eq 'pi') {",start)
 assert.ok(start>0 && end>start)
 const block=source.slice(start,end)+'\n}'
 const exe='"C:\\official tools\\herdr.exe"',prefix=exe+' --session other-session server',modifier=' --allow-unelevated-clients'
 const cases=[
  [prefix,'different_session'],
  [prefix+modifier,'different_session'],
  [exe+' --session=other-session server'+modifier,'different_session'],
  [exe+' server'+modifier,'different_session'],
  [exe+' --session original-session server'+modifier,'same'],
  [prefix+modifier+modifier,'unknown'],
  [prefix+' --unknown','unknown'],
  [prefix+' --unknown'+modifier,'unknown'],
  [exe+' --session other-session --session original-session server'+modifier,'unknown'],
  [exe+' --session server'+modifier,'unknown'],
  [exe+' --session other-session'+modifier+' server','unknown'],
  [prefix+' stop'+modifier,'unknown'],
  [prefix+' --allow-unelevated-clients=true','unknown'],
 ]
 const input=path.join(base,'cases.json'),script=path.join(base,'scope.ps1')
 await fs.writeFile(input,JSON.stringify(cases.map(c=>c[0])))
 await fs.writeFile(script,`param([string]$InputFile)\n$ErrorActionPreference='Stop'\n${decoder}\n${flag}\n$HerdrSession='original-session'\n$scopes=@()\n$lines=Get-Content -LiteralPath $InputFile -Raw | ConvertFrom-Json\nforeach($line in $lines) {\n$p=[pscustomobject]@{Name='herdr.exe'}\n$argv=[RecoveryArgv]::Decode($line)\n$scope='unknown'\n${block}\n$scopes += $scope\n}\nConvertTo-Json -InputObject $scopes -Compress\n`)
 const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe')
 const result=spawnSync(ps,['-NoLogo','-NoProfile','-NonInteractive','-File',script,'-InputFile',input],{encoding:'utf8',timeout:10000,maxBuffer:4096,windowsHide:true})
 assert.equal(result.status,0,'bounded read-only PowerShell parser must succeed')
 const scopes=JSON.parse(result.stdout)
 assert.deepEqual(scopes,cases.map(c=>c[1]))
 for(const scope of scopes){
  const record={...externalHerdr,scope}
  assert.equal(classifyRecoveryProcesses([scopeAnchor,record],scopeContext).absent,scope==='different_session')
  assert.equal(classifyRecoveryProcesses([scopeAnchor,{...record,originalReference:true}],scopeContext).absent,false)
  assert.equal(classifyRecoveryProcesses([scopeAnchor,{...record,role:'unknown'}],scopeContext).absent,false)
 }
})
if(process.platform === 'win32')test('native scoped probe excludes a live unrelated Pi-style process but rejects the same binary with original task roots',{timeout:60000},async t=>{
 const f=await fixture(t),config={...f.config,programs:{...f.config.programs,node:process.execPath}}
 // Disposable test program, not a modified official Pi installation.
 await fs.writeFile(f.p.pi,'setInterval(()=>{},1000)')
 const files={root:f.root,state:f.stateFile,config:path.join(f.root,'config/endpoint.json'),runtime:path.join(f.root,'config/runtime.json'),status:f.statusFile}
 // Reuse fresh private objects for production file-trust checks.
 const audit=path.join(f.base,'scope-audit'),input=path.join(f.base,'scope-input.json'),items=[{kind:'directory',path:audit}]
 for(const key of ['state','config','runtime','status']) {const content=await fs.readFile(files[key],'utf8');files[key]=path.join(audit,key+'.json');items.push({kind:'file',path:files[key],content})}
 await fs.writeFile(input,JSON.stringify({root:f.base,items}))
 const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe')
 assert.equal(spawnSync(ps,['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./official-smoke/private-fixture.ps1',import.meta.url)),'-InputFile',input],{timeout:30000,maxBuffer:4096}).status,0)
 async function candidate(dir,expected) {
  const child=spawn(process.execPath,[f.p.pi,...(dir === null ? ['--continue'] : ['--session-dir',dir])],{stdio:'ignore'})
  await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject)})
  try{await assert.rejects(nativeRecoveryEvidence({config,status:f.status,files}),error=>{assert.equal(error.code,expected,`scope probe stage: ${error.evidenceStage}; reason: ${error.processReason}; blocking: ${JSON.stringify(error.blockingProcess)}`);if(expected === 'host_recovery_process_evidence_unavailable')assert.equal(error.processReason,'original_process_reference');assert.equal(child.exitCode,null,'scope probe must preserve its live unrelated child');return true})}
  finally {if(child.exitCode === null){const closed=new Promise(resolve=>child.once('exit',resolve));child.kill();await closed}}
 }
 await candidate(null, 'herdr_observation_unknown')
 await candidate(path.join(f.config.sourceRoot,'.memoh-computer/sessions/original'), 'host_recovery_process_evidence_unavailable')
})
test('older recovery caller requires a real child edge, distinct scope and Windows session; an arbitrary earlier orphan stays unknown',()=>{
 const priorCaller={...externalHerdr,id:60,parent:999,created:500,role:'node',scope:'other_program'}
 const invoker={...scopeAnchor,id:70,parent:60,created:3000}
 assert.equal(classifyRecoveryProcesses([priorCaller,invoker],{...scopeContext,recoveryPid:70}).absent,true)
 assert.equal(classifyRecoveryProcesses([priorCaller],scopeContext).absent,false)
 assert.equal(classifyRecoveryProcesses([{...priorCaller,originalReference:true},invoker],{...scopeContext,recoveryPid:70}).absent,false)
 assert.equal(classifyRecoveryProcesses([{...priorCaller,role:'unknown'},invoker],{...scopeContext,recoveryPid:70}).absent,false)
 assert.equal(classifyRecoveryProcesses([{...priorCaller,created:4000},invoker],{...scopeContext,recoveryPid:70}).absent,false)
})

const originalRunStart=Date.parse('2020-01-06T12:00:00.000Z')
const preexistingOrphan={id:900,parent:800,created:Date.parse('2020-01-01T12:00:00.000Z'),windowsSession:1,role:'node',scope:'external_entry',originalReference:false}
test('preexisting concrete generic Node/npx entry need not reconstruct an absent parent to recheck components',()=>{
 const result=classifyRecoveryProcesses([preexistingOrphan],{oldPid:100,currentSession:1,runStart:originalRunStart})
 assert.equal(result.absent,true)
 assert.deepEqual(result.excluded,[{pid:900,role:'node',reason:'preexisting_generic_entry_not_managed_component',businessRelationship:'not_inferred'}])
})
for(const [name,record,extra] of [
 ['project reference',{...preexistingOrphan,originalReference:true},[]],
 ['unreadable entry',{...preexistingOrphan,role:'unknown'},[]],
 ['managed Pi',{...preexistingOrphan,role:'pi',scope:'interactive'},[]],
 ['managed Runtime',{...preexistingOrphan,role:'connector',scope:'different_enrollment'},[]],
 ['post-start generic orphan',{...preexistingOrphan,created:originalRunStart+1},[]],
 ['unknown start time',preexistingOrphan,[]],
 ['direct original host child',{...preexistingOrphan,parent:100},[]],
 ['observed original-root ancestor',{...preexistingOrphan,parent:200},[{id:200,parent:999,created:preexistingOrphan.created-1,role:'node',originalReference:true}]],
])test(`preexisting generic entry cannot waive ${name}`,()=>{
 const result=classifyRecoveryProcesses([record,...extra],{oldPid:100,currentSession:1,runStart:name==='unknown start time'?null:originalRunStart})
 assert.equal(result.absent,false)
})
if(process.platform === 'win32')test('native orphaned generic script predating the run is left live; an original root argument still blocks',{timeout:90000},async t=>{
 const f=await fixture(t),config={...f.config,programs:{...f.config.programs,node:process.execPath}}
 const files={root:f.root,state:f.stateFile,config:path.join(f.root,'config/endpoint.json'),runtime:path.join(f.root,'config/runtime.json'),status:f.statusFile}
 const audit=path.join(f.base,'orphan-audit'),input=path.join(f.base,'orphan-input.json'),items=[{kind:'directory',path:audit}]
 for(const key of ['state','config','runtime','status']) {const content=await fs.readFile(files[key],'utf8');files[key]=path.join(audit,key+'.json');items.push({kind:'file',path:files[key],content})}
 await fs.writeFile(input,JSON.stringify({root:f.base,items}))
 const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe')
 assert.equal(spawnSync(ps,['-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./official-smoke/private-fixture.ps1',import.meta.url)),'-InputFile',input],{timeout:30000,maxBuffer:4096}).status,0)
 const external=path.join(f.base,'another application');await fs.mkdir(external)
 const entry=path.join(external,'npx-cli.js')
 await fs.writeFile(entry,"const fs=require('node:fs');fs.writeFileSync(process.argv[3],'ready');setInterval(()=>{if(fs.existsSync(process.argv[2]))process.exit(0)},20)")
 async function orphan(related) {
   const stop=path.join(external,related?'related-stop':'plain-stop'),ready=stop+'-ready'
   const args=[entry,stop,ready,...(related?['--prefix='+f.config.sourceRoot]:[])]
   const code=`const {spawn}=require('node:child_process');const c=spawn(process.execPath,${JSON.stringify(args)},{detached:true,stdio:'ignore'});c.unref();console.log(JSON.stringify({pid:c.pid}));`
   const launched=spawnSync(process.execPath,['-e',code],{encoding:'utf8',timeout:10000,maxBuffer:4096})
   assert.equal(launched.status,0);const pid=JSON.parse(launched.stdout).pid
   async function wait(predicate) {const end=Date.now()+10000;while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,25))}throw new Error('owned orphan fixture deadline')}
   try {
     await wait(async()=>{try{return await fs.readFile(ready,'utf8')==='ready'}catch{return false}})
     const started=Date.now();f.status.updatedAt=started
     await fs.writeFile(files.status,JSON.stringify(f.status))
     await fs.writeFile(path.join(f.root,'logs/endpoint-host',f.options.expectedRun+'.jsonl'),JSON.stringify({schema:1,runId:f.options.expectedRun,phase:'starting',at:started})+'\n')
     await assert.rejects(nativeRecoveryEvidence({config,status:f.status,files}),error=>{
       assert.equal(error.code,related?'host_recovery_process_evidence_unavailable':'herdr_observation_unknown',`orphan stage: ${error.evidenceStage}; reason: ${error.processReason}; pid: ${JSON.stringify(error.blockingProcess)}`)
       if(related)assert.equal(error.processReason,'original_process_reference')
       return true
     })
     assert.doesNotThrow(()=>process.kill(pid,0),'recovery must leave the unrelated and related orphan untouched')
     assert.equal(await fs.readFile(f.stateFile,'utf8'),f.raw)
     assert.equal(JSON.parse(await fs.readFile(f.receipt)).state,'unknown')
   } finally {
     // Cooperative exit of only the disposable program created above. No PID kill.
     await fs.writeFile(stop,'stop')
     await wait(()=>{try{process.kill(pid,0);return false}catch(e){if(e.code==='ESRCH')return true;throw e}})
   }
 }
 await orphan(false);await orphan(true)
})
