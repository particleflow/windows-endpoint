// Invoked only by the existing Windows CI step. Real PowerShell/Node foreground
// entry; all referenced Agent/credential bytes below are inert synthetic data.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { nativeInstalledFixture } from './test-support/installed-fixture.mjs'
import { programPackage } from './test-support/program-package.mjs'
import { setupEndpoint } from './setup.mjs'
import { installProduct } from './product-installation.mjs'
import { digest } from './endpoint.mjs'
import { childExitDeadline } from './test-support/child-exit-deadline.mjs'

assert.equal(process.platform,'win32','this differential entry test requires actual Windows')
const powershell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe')
async function fixture(t,unicodeNode=false,{selectedHost=null}={}){
  const f=await nativeInstalledFixture(t),root=path.join(f.base,'persistent product')
  f.config.programs.node=await fs.realpath(process.execPath)
  if(unicodeNode){
    const copy=path.join(f.base,'programs/node Unicode 空格/node.exe')
    await fs.mkdir(path.dirname(copy),{recursive:true});await fs.copyFile(f.config.programs.node,copy)
    f.config.programs.node=copy
  }
  const source=await programPackage(path.join(f.base,'disposable extraction'),'product-entry',{native:true})
  if(selectedHost!==null){
    const entry=path.join(source.directory,'host.mjs');await fs.writeFile(entry,selectedHost)
    const member=source.manifest.files.find(file=>file.path==='host.mjs')
    member.size=Buffer.byteLength(selectedHost);member.sha256=await digest(entry)
    await fs.writeFile(path.join(source.directory,'candidate.json'),JSON.stringify(source.manifest))
    source.hash=await digest(path.join(source.directory,'candidate.json'))
  }
  const from=path.join(f.base,'references.json');await fs.writeFile(from,JSON.stringify(f.config))
  const result=await installProduct({from,root,source:source.directory,manifestSha256:source.hash,review:true,transfer:'disabled'},
    {setup:options=>setupEndpoint(options,{doctor:async()=>({checks:[]})}),
      dependencies:async()=>({state:'programs_verified',components:[],observed:null,evidence:'synthetic_program_inventory'})})
  assert.equal(result.state,'installed_review_only')
  // Only this test's explicit activation request is removed to exercise the
  // supported observer: no inert Agent program may be launched by this check.
  await fs.rm(path.join(root,'config/runtime.json'))
  await fs.rm(source.directory,{recursive:true})
  return {...f,root,entry:result.entry}
}
const args=f=>['-NoProfile','-NonInteractive','-File',f.entry]
test('stable PowerShell Run forwards the prepared native Pi catalog and preserves old selected-host refusal',async t=>{
  const wrapper=version=>`import fs from 'node:fs/promises';import path from 'node:path';
${version===null?'':`export const piNativeCatalogBindingVersion=${version};`}
export async function runForeground({root,piNativeCatalog}){
 const config=JSON.parse(await fs.readFile(path.join(root,'config/endpoint.json'),'utf8'));
 process.stdout.write(JSON.stringify({provider:piNativeCatalog?.providerId??null,profile:config.piConfigDir})+'\\n');
 return 0;
}\n`
  for(const version of [1,null]){
    const f=await fixture(t,false,{selectedHost:wrapper(version)})
    const config=path.join(f.root,'config/endpoint.json'),selection=path.join(f.root,'control/deployment.json')
    const before=await Promise.all([config,selection,f.config.connector.enrollmentFile].map(file=>fs.readFile(file)))
    const run=extra=>promisify(execFile)(powershell,[...args(f),'-Action','Run',...extra],{timeout:20000,maxBuffer:16384})
    const plain=JSON.parse((await run([])).stdout)
    assert.deepEqual(plain,{provider:null,profile:f.config.piConfigDir})
    const settings=path.join(f.config.piConfigDir,'settings.json'),models=path.join(f.config.piConfigDir,'models.json')
    await fs.writeFile(settings,'{}\n')
    await fs.writeFile(models,JSON.stringify({providers:{'existing-magpie':{models:[{id:'selected'}]}}})+'\n')
    const userFiles=[settings,models,path.join(f.config.piConfigDir,'auth.json')]
    const userBytes=await Promise.all(userFiles.map(file=>fs.readFile(file)))
    await assert.rejects(run(['-PiCatalogProvider','existing-magpie']),error=>error.code===2&&error.stderr.includes('catalog_native_profile_not_prepared'))
    const selected=JSON.parse(await fs.readFile(selection,'utf8')).current
    const prepared=await promisify(execFile)(f.config.programs.node,[path.join(f.root,'packages',selected,'endpoint.mjs'),'deploy','prepare-pi-catalog','--root',f.root,'--request-id',randomUUID(),'--provider','existing-magpie'],{timeout:20000,maxBuffer:16384})
    assert.equal(JSON.parse(prepared.stdout).state,'prepared_native_catalog')
    if(version===1){
      const enabled=JSON.parse((await run(['-PiCatalogProvider','existing-magpie'])).stdout)
      assert.deepEqual(enabled,{provider:'existing-magpie',profile:f.config.piConfigDir})
    }else{
      await assert.rejects(run(['-PiCatalogProvider','existing-magpie']),error=>error.code===2&&error.stderr.includes('deployment_pi_native_catalog_unsupported'))
    }
    assert.deepEqual(await Promise.all(userFiles.map(file=>fs.readFile(file))),userBytes)
    assert.deepEqual(await Promise.all([config,selection,f.config.connector.enrollmentFile].map(file=>fs.readFile(file))),before)
    assert.equal(await fs.readFile(f.config.connector.enrollmentFile,'utf8'),'SYNTHETIC UNREAD ENROLLMENT')
  }
})
test('actual installer process refuses unqualified default and reports unverified dependencies without installing them',async t=>{
  const f=await nativeInstalledFixture(t),root=path.join(f.base,'actual installer product')
  f.config.programs.node=await fs.realpath(process.execPath)
  const source=await programPackage(path.join(f.base,'installer extraction'),'actual-install',{native:true})
  const from=path.join(f.base,'references.json');await fs.writeFile(from,JSON.stringify(f.config))
  const command=['-NoProfile','-NonInteractive','-File',path.join(source.directory,'WindowsEndpoint.ps1'),'-Action','Install',
    '-ProductRoot',root,'-References',from,'-ManifestSha256',source.hash,'-NodePath',f.config.programs.node,'-Transfer','disabled']
  await assert.rejects(promisify(execFile)(powershell,command,{timeout:20000,maxBuffer:65536}),e=>e.code===2&&e.stderr.includes('installation_release_qualification_pending'))
  await assert.rejects(fs.stat(root),{code:'ENOENT'})
  let stdout
  try { await promisify(execFile)(powershell,[...command,'-ReviewCandidate'],{timeout:20000,maxBuffer:65536}); assert.fail('inert dependencies must remain unqualified') }
  catch(e){assert.equal(e.code,2);stdout=e.stdout}
  const result=JSON.parse(stdout)
  assert.equal(result.state,'deferred');assert.equal(result.reason,'dependencies_unverified')
  assert.equal(result.dependencies.installationExecuted,false)
  assert.equal(JSON.parse(await fs.readFile(path.join(root,'control/installation.json'))).phase,'complete')
  assert.equal(await fs.readFile(f.config.connector.enrollmentFile,'utf8'),'SYNTHETIC UNREAD ENROLLMENT')
  const configuration=await fs.readFile(path.join(root,'config/endpoint.json'))
  const next=await programPackage(path.join(f.base,'updated installer extraction'),'updated',{native:true})
  const script=path.join(next.directory,'WindowsEndpoint.ps1')
  await fs.appendFile(script,'\n# INERT COMPATIBLE INSTALLER UPDATE\n')
  const member=next.manifest.files.find(file=>file.path==='WindowsEndpoint.ps1')
  member.size=(await fs.stat(script)).size;member.sha256=await digest(script)
  await fs.writeFile(path.join(next.directory,'candidate.json'),JSON.stringify(next.manifest))
  const nextHash=await digest(path.join(next.directory,'candidate.json'))
  try {
    await promisify(execFile)(powershell,['-NoProfile','-NonInteractive','-File',script,'-Action','Install','-ProductRoot',root,
      '-ManifestSha256',nextHash,'-NodePath',f.config.programs.node,'-Transfer','disabled','-ReviewCandidate'],{timeout:20000,maxBuffer:65536})
    assert.fail('synthetic programs must stay unqualified after update')
  }catch(e){assert.equal(e.code,2);assert.equal(JSON.parse(e.stdout).reason,'dependencies_unverified')}
  assert.equal(JSON.parse(await fs.readFile(path.join(root,'control/deployment.json'))).current,nextHash)
  assert.equal(await fs.readFile(path.join(root,'control/WindowsEndpoint.ps1'),'utf8'),await fs.readFile(script,'utf8'))
  assert.deepEqual(await fs.readFile(path.join(root,'config/endpoint.json')),configuration)
})
test('installed stable PowerShell entry runs and stops the real foreground observer after extraction is removed',async t=>{
  const f=await fixture(t,true),child=spawn(powershell,[...args(f),'-Action','Run'],{stdio:['pipe','pipe','pipe'],windowsHide:true})
  let output='',stderr='',closed=false,exitCode=null,exitSignal=null,spawnError=null
  child.stdin.on('error',()=>{})
  child.stdout.on('data',c=>{output+=c});child.stderr.on('data',c=>{stderr+=c})
  child.once('error',error=>{spawnError=error.code??error.message})
  const done=new Promise(resolve=>child.once('close',(code,signal)=>{closed=true;exitCode=code;exitSignal=signal;resolve(code)}))
  const evidence=()=>JSON.stringify({powershell,closed,exitCode,exitSignal,spawnError,stdout:output,stderr})
  t.after(async()=>{
    try { if(!closed){child.stdin.end('{"action":"stop"}\n');const ok=await childExitDeadline(done.then(()=>true),8000,false);if(!ok)child.kill()} }
    finally { t.diagnostic(evidence()) }
  })
  const deadline=Date.now()+15000
  while(Date.now()<deadline&&!output.includes('"phase":"running"')&&!closed)await delay(25)
  assert.ok(output.includes('"phase":"running"'),'installed entry must expose the live foreground observer: '+evidence())
  await delay(150)
  assert.equal(closed,false,'launcher must not substitute immediate EOF for a live foreground control channel')
  child.stdin.write('{"action":"stop"}\n')
  assert.equal(await childExitDeadline(done,10000,'deadline'),0,evidence())
  child.stdin.end()
  assert.equal(stderr,'');assert.ok(output.includes('"phase":"stopped"'))
  assert.equal(await fs.readFile(f.config.connector.enrollmentFile,'utf8'),'SYNTHETIC UNREAD ENROLLMENT')
})
test('installed uninstall plan preserves all data and changed package code is rejected before execution',async t=>{
  const f=await fixture(t),before=await fs.readFile(path.join(f.root,'config/endpoint.json'))
  const first=JSON.parse(await fs.readFile(path.join(f.root,'control/deployment.json'))).current
  const next=await programPackage(path.join(f.base,'next extraction'),'update',{native:true})
  const updated=JSON.parse((await promisify(execFile)(powershell,[...args(f),'-Action','Update','-Source',next.directory,'-ManifestSha256',next.hash],{timeout:20000,maxBuffer:16384})).stdout)
  assert.equal(updated.state,'selected_review_only')
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'control/deployment.json'))).current,next.hash)
  const rolled=JSON.parse((await promisify(execFile)(powershell,[...args(f),'-Action','Rollback','-ManifestSha256',first],{timeout:20000,maxBuffer:16384})).stdout)
  assert.equal(rolled.state,'selected_review_only')
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root,'control/deployment.json'))).current,first)
  const plan=JSON.parse((await promisify(execFile)(powershell,[...args(f),'-Action','UninstallPlan'],{timeout:15000,maxBuffer:16384})).stdout)
  assert.equal(plan.filesChanged,false);assert.equal(plan.deletionImplemented,false)
  assert.deepEqual(await fs.readFile(path.join(f.root,'config/endpoint.json')),before)
  const state=JSON.parse(await fs.readFile(path.join(f.root,'control/deployment.json')))
  await fs.appendFile(path.join(f.root,'packages',state.current,'endpoint.mjs'),'\nthrow new Error("INERT MUST NOT EXECUTE")\n')
  await assert.rejects(promisify(execFile)(powershell,[...args(f),'-Action','Doctor'],{timeout:15000,maxBuffer:16384}),e=>
    e.code===2&&e.stderr.includes('installation_payload_changed')&&!e.stderr.includes('INERT MUST NOT EXECUTE'))
})
