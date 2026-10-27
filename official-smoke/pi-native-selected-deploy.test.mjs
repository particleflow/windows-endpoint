import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { nativeCatalogInstall } from '../test-support/native-catalog-install.mjs'
import { nativeCatalogReferenceName } from '../pi-native-catalog-profile.mjs'
import { StateStore } from '../lifecycle.mjs'

const piPackage=process.env.PI_NATIVE_FIXTURE_PACKAGE
test('actual deploy CLI selects the guarded host and loads native discovery inside the original-config official Pi JSON child',{skip:!piPackage,timeout:30000},async t=>{
  assert.equal(JSON.parse(await fs.readFile(path.join(piPackage,'package.json'),'utf8')).version,'1.4.0')
  let gets=0,inference=0,held=0,cancelled=0
  const responses=new Set(),server=http.createServer((req,res)=>{
    if(req.method!=='GET'||req.url!=='/v1/models'){inference++;res.writeHead(400).end();return}
    gets++
    if(req.headers.authorization!=='Bearer synthetic-selected-deploy'){res.writeHead(401).end();return}
    if(gets>1){held++;responses.add(res);res.on('close',()=>{responses.delete(res);if(!res.writableEnded)cancelled++});return}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'upstream-added',context_window:8192,max_output_tokens:1024,reasoning:true,modalities:{input:['text']}}]}))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(async()=>{for(const r of responses)r.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
  let paths
  const f=await nativeCatalogInstall(t,{piPackage,configurePackage:async({pkg,f:original})=>{
    paths={audit:path.join(original.base,'same-pi-audit.json'),release:path.join(original.base,'finish-pi'),binding:path.join(original.base,'forwarded-binding.json'),piOutput:path.join(original.base,'pi-output.jsonl'),piError:path.join(original.base,'pi-stderr.txt'),sessions:path.join(original.base,'pi-sessions')}
    // Test-only replacement of the external Herdr start boundary. The endpoint
    // CLI, selected-package verification and actual foreground host are real.
    // This wrapper/resources are absent from the production packaging inventory.
    await fs.rename(path.join(pkg.directory,'host.mjs'),path.join(pkg.directory,'foreground-host.mjs'))
    await fs.writeFile(path.join(pkg.directory,'host.mjs'),`import {runForeground as realRun} from './foreground-host.mjs';import {fixtureRuntime} from './fixture-herdr-boundary.mjs';export {piNativeCatalogBindingVersion} from './foreground-host.mjs';export const runForeground=options=>realRun({...options,createTestRuntime:fixtureRuntime});\n`)
    await fs.writeFile(path.join(pkg.directory,'fixture-herdr-boundary.mjs'),`import * as fs from 'node:fs/promises';import path from 'node:path';import {spawn} from 'node:child_process';import {setTimeout as delay} from 'node:timers/promises';
const p=${JSON.stringify(paths)};
export async function fixtureRuntime({config,piNativeCatalog}){
await fs.writeFile(p.binding,JSON.stringify({config,piNativeCatalog}));let child,done,out='',err='';
return {snapshot:()=>null,tick:async()=>{},start:async()=>{
const env={HOME:${JSON.stringify(original.base)},PATH:process.env.PATH,PI_CODING_AGENT_DIR:config.piConfigDir};
for(const k of ['SystemRoot','WINDIR','COMSPEC','TEMP','TMP','APPDATA','LOCALAPPDATA'])if(process.env[k])env[k]=process.env[k];
child=spawn(config.programs.node,[path.join(config.programs.piPackage,'dist/bundle/cli.js'),'--mode','json','--provider','approved','--model','selected','--session-dir',p.sessions,'--session-id',${JSON.stringify(randomUUID())},'--no-mcp','--no-skills','--no-prompt-templates','--no-context-files'],{cwd:config.sourceRoot,env,stdio:['pipe','pipe','pipe']});
done=new Promise(resolve=>child.once('close',resolve));child.stdout.on('data',v=>{out+=v});child.stderr.on('data',v=>{err+=v});child.stdin.end('/fixture-selected-observe\\n');
const end=Date.now()+10000;while(Date.now()<end){try{await fs.access(p.audit);return}catch{await delay(25)}}throw Error('fixture Pi startup deadline');
},stop:async()=>{if(!child)return;await fs.writeFile(p.release,'normal owned shutdown');const code=await done;await fs.writeFile(p.piOutput,out);await fs.writeFile(p.piError,err);if(code!==0)throw Error('fixture Pi exit failure')}}}
`)
  }})
  const observer=path.join(f.base,'existing-user-extension.mjs')
  await fs.writeFile(observer,`import * as fs from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';export default function(pi){pi.registerCommand('fixture-selected-observe',{handler:async(_args,ctx)=>{await fs.writeFile(${JSON.stringify(paths.audit)},JSON.stringify({pid:process.pid,session:ctx.sessionManager.getSessionId(),provider:ctx.model.provider,model:ctx.model.id,models:ctx.modelRegistry.getAll().filter(m=>m.provider==='approved').map(m=>({id:m.id,maxTokens:m.maxTokens,reasoning:m.reasoning}))}));while(true){try{await fs.access(${JSON.stringify(paths.release)});break}catch{await delay(25)}}}})}\n`)
  f.settingsRaw='\uFEFF'+JSON.stringify({extensions:[observer],packages:[],defaultProvider:'approved',defaultModel:'selected',custom:{keep:true}},null,3)+'\n'
  const document=JSON.parse(f.modelsRaw.replace(/^\uFEFF/,''));document.providers.approved.baseUrl=`http://127.0.0.1:${server.address().port}/v1`
  f.modelsRaw='\uFEFF'+JSON.stringify(document)
  const authRaw=JSON.stringify({approved:{type:'api_key',key:'synthetic-selected-deploy'}})
  for(const [name,raw]of [['settings.json',f.settingsRaw],['models.json',f.modelsRaw],['auth.json',authRaw]])await fs.writeFile(path.join(f.config.piConfigDir,name),raw)
  const settingsStamp=await fs.stat(path.join(f.config.piConfigDir,'settings.json'),{bigint:true})
  const endpoint=fileURLToPath(new URL('../endpoint.mjs',import.meta.url)),children=[]
  function cli(args){const child=spawn(process.execPath,[endpoint,'deploy',...args],{stdio:['pipe','pipe','pipe']});let out='',err='';child.stdout.on('data',v=>{out+=v});child.stderr.on('data',v=>{err+=v});const done=new Promise(resolve=>child.once('close',code=>resolve(code)));const p={child,done,out:()=>out,err:()=>err};children.push(p);return p}
  t.after(async()=>{for(const p of children)if(p.child.exitCode===null){p.child.kill('SIGKILL');await p.done}})
  async function waitFor(read,predicate){const end=Date.now()+12000;while(Date.now()<end){const v=await read();if(predicate(v))return v;await delay(30)}throw Error('selected deploy fixture deadline')}
  const preparation=cli(['prepare-pi-catalog','--root',f.root,'--request-id',randomUUID(),'--provider','approved','--interval-ms','1000'])
  preparation.child.stdin.end();assert.equal(await preparation.done,0,preparation.err());assert.equal(JSON.parse(preparation.out()).state,'prepared_native_catalog')
  const running=cli(['run','--root',f.root])
  await waitFor(running.out,text=>text.includes('"phase":"running"'))
  const observed=JSON.parse(await fs.readFile(paths.audit,'utf8')),forwarded=JSON.parse(await fs.readFile(paths.binding,'utf8'))
  assert.deepEqual(forwarded.config,f.config);assert.equal(forwarded.piNativeCatalog.profileDir,f.config.piConfigDir)
  assert.equal(forwarded.piNativeCatalog.providerId,'approved');assert.equal(observed.provider,'approved');assert.equal(observed.model,'selected')
  assert.ok(observed.models.some(m=>m.id==='upstream-added'));assert.equal(observed.models.find(m=>m.id==='selected').maxTokens,333)
  assert.equal(observed.models.find(m=>m.id==='selected').reasoning,false)
  await waitFor(async()=>held,v=>v===1)
  running.child.stdin.end('{"action":"stop"}\n');assert.equal(await running.done,0,running.err())
  await waitFor(async()=>cancelled,v=>v===1)
  const header=(await fs.readFile(paths.piOutput,'utf8')).trim().split('\n').map(JSON.parse).find(v=>v.type==='session')
  assert.equal(header.id,observed.session);assert.ok(Number.isSafeInteger(observed.pid))
  assert.match(await fs.readFile(paths.piError,'utf8'),/windows_endpoint_pi_catalog: refreshed/)
  assert.match(await fs.readFile(paths.piError,'utf8'),/windows_endpoint_pi_catalog: cancelled/)
  const finishedGets=gets;await delay(1100);assert.equal(gets,finishedGets)
  for(const [name,raw]of [['settings.json',f.settingsRaw],['models.json',f.modelsRaw],['auth.json',authRaw]])assert.equal(await fs.readFile(path.join(f.config.piConfigDir,name),'utf8'),raw)
  const after=await fs.stat(path.join(f.config.piConfigDir,'settings.json'),{bigint:true})
  for(const key of ['ino','mode','mtimeNs','ctimeNs'])assert.equal(after[key],settingsStamp[key])
  assert.equal((await fs.stat(path.join(f.config.piConfigDir,'extensions',nativeCatalogReferenceName))).nlink,1)
  // Unknown durable work/attention is retained and prevents a new Pi launch.
  const receipt=path.join(f.config.sourceRoot,'.memoh-computer/attempts/original/receipt.json'),unknown='{"state":"unknown","prompt_submitted":false,"pi_session":"original"}'
  await fs.mkdir(path.dirname(receipt),{recursive:true});await fs.writeFile(receipt,unknown)
  const store=new StateStore(f.manager.lifecycleDirectory,f.config.deviceId),state=await store.load()
  await store.save({...state,phase:'needs_attention',attention:'task_outcome_unknown'})
  const originalState=await fs.readFile(store.file,'utf8'),originalBinding=await fs.readFile(paths.binding,'utf8')
  const blocked=cli(['run','--root',f.root]);await waitFor(blocked.out,text=>text.includes('"phase":"running"'))
  blocked.child.stdin.end('{"action":"stop"}\n');assert.equal(await blocked.done,2)
  assert.equal(await fs.readFile(receipt,'utf8'),unknown);assert.equal(await fs.readFile(store.file,'utf8'),originalState)
  assert.equal(await fs.readFile(paths.binding,'utf8'),originalBinding);assert.equal(gets,finishedGets);assert.equal(inference,0)
  console.log(JSON.stringify({entry:'endpoint deploy run -> selected host -> isolated Herdr boundary -> official Pi 1.4.0 JSON',nativeResourceActuallyLoaded:true,originalIdentityAndProfile:true,userExtensionPreserved:true,modelUnchanged:true,userFilesUnchanged:true,normalExitCancels:true,unknownWorkNotReplayed:true,inferenceRequests:0,windowsHerdrExe:'not exercised'}))
})
