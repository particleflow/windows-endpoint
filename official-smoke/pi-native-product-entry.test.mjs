import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { createHash,randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { nativeCatalogPackage,nativeCatalogResources,nativeCatalogSettingsKey,prepareNativePiCatalogProfile,nativePiCatalogHostOptions } from '../pi-native-catalog-profile.mjs'

const piPackage=process.env.PI_NATIVE_FIXTURE_PACKAGE
test('normal official Pi JSON argv loads the selected profile resource, diagnoses failure, and drains exit', {skip:!piPackage,timeout:30000},async t=>{
  assert.equal(JSON.parse(await fs.readFile(path.join(piPackage,'package.json'),'utf8')).version,'1.4.0')
  const root=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'pi-native-product-')))
  t.after(()=>fs.rm(root,{recursive:true,force:true}))
  const profileDir=path.join(root,'selected profile'),packageRoot=path.join(root,'selected package 空格'),work=path.join(root,'work'),sessions=path.join(root,'sessions')
  for(const p of [profileDir,packageRoot,work,sessions])await fs.mkdir(p)
  const files=[]
  for(const name of nativeCatalogResources){const bytes=await fs.readFile(fileURLToPath(new URL('../'+name,import.meta.url)));await fs.writeFile(path.join(packageRoot,name),bytes);files.push({path:name,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')})}
  const manifest={native_pi_catalog:nativeCatalogPackage,files}
  let gets=0,inference=0,held=0,cancelled=0
  const live=new Set()
  const server=http.createServer((req,res)=>{
    if(req.method!=='GET'||req.url!=='/v1/models'){inference++;res.writeHead(400).end();return}
    gets++
    if(req.headers.authorization!=='Bearer synthetic-product-key'){res.writeHead(401).end();return}
    if(gets>1){held++;live.add(res);res.on('close',()=>{live.delete(res);if(!res.writableEnded)cancelled++});return}
    res.setHeader('content-type','application/json');res.end(JSON.stringify({data:[{id:'new-directory-id',context_window:8192,max_output_tokens:1024,reasoning:true,modalities:{input:['text']}}]}))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(async()=>{for(const r of live)r.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
  // An existing user resource observes this exact Pi's registry and waits for
  // the synthetic release file; its command prevents any paid agent prompt.
  const audit=path.join(root,'audit.json'),release=path.join(root,'finish'),observer=path.join(root,'existing-user-extension.mjs')
  await fs.writeFile(observer,`import * as fs from 'node:fs/promises';import {setTimeout as delay} from 'node:timers/promises';
export default function(pi){pi.registerCommand('fixture-product-observe',{handler:async(_args,ctx)=>{
await fs.writeFile(${JSON.stringify(audit)},JSON.stringify({pid:process.pid,session:ctx.sessionManager.getSessionId(),model:ctx.model.id,models:ctx.modelRegistry.getAll().filter(m=>m.provider==='fixture-provider').map(m=>m.id)}));
while(true){try{await fs.access(${JSON.stringify(release)});break}catch{await delay(25)}}
}})}\n`)
  const settings={extensions:[observer],packages:[],defaultProvider:'fixture-provider',defaultModel:'selected',userSetting:{keep:true}}
  const oldSettingsRaw='\uFEFF'+JSON.stringify(settings,null,3)+'\n'
  const modelsRaw='\uFEFF'+JSON.stringify({providers:{'fixture-provider':{api:'openai-completions',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'$UNSET_PRODUCT_FIXTURE',models:[{id:'selected',name:'Keep user selection',contextWindow:4096,maxTokens:512,reasoning:false,input:['text']}],modelOverrides:{selected:{maxTokens:333}}}}})
  const authRaw=JSON.stringify({'fixture-provider':{type:'api_key',key:'synthetic-product-key'}})
  await fs.writeFile(path.join(profileDir,'models.json'),modelsRaw);await fs.writeFile(path.join(profileDir,'auth.json'),authRaw)
  const plan=await prepareNativePiCatalogProfile({profileDir,packageRoot,manifest,settingsRaw:oldSettingsRaw,modelsRaw,providerId:'fixture-provider',intervalMs:1000})
  await fs.writeFile(plan.settingsPath,plan.settingsAfter) // synthetic stopped profile transaction
  const options=await nativePiCatalogHostOptions({config:{piConfigDir:profileDir},packageRoot,manifest,requestedProviderId:'fixture-provider'})
  assert.equal(options.piCatalogBinding,null);assert.equal(options.piCatalogMode,'native')
  const children=[]
  t.after(async()=>{for(const p of children)if(p.child.exitCode===null){p.child.kill('SIGKILL');await p.done}})
  function launch(){
    const env={HOME:root,PATH:process.env.PATH,PI_CODING_AGENT_DIR:profileDir}
    for(const k of ['SystemRoot','WINDIR','COMSPEC','TEMP','TMP','APPDATA','LOCALAPPDATA'])if(process.env[k])env[k]=process.env[k]
    // Same native JSON entry used by pi_batch.go. No --extension, extra SDK,
    // provider-refresh flag, or production auth/model request is involved.
    const argv=[path.join(piPackage,'dist/bundle/cli.js'),'--mode','json','--provider','fixture-provider','--model','selected','--session-dir',sessions,'--session-id',randomUUID(),'--no-mcp','--no-skills','--no-prompt-templates','--no-context-files']
    const child=spawn(process.execPath,argv,{cwd:work,env,stdio:['pipe','pipe','pipe']})
    let stdout='',stderr=''
    child.stdout.on('data',v=>{stdout+=v});child.stderr.on('data',v=>{stderr+=v})
    const done=new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})))
    child.stdin.end('/fixture-product-observe\n')
    const p={child,done,out:()=>stdout,err:()=>stderr};children.push(p);return p
  }
  async function waitFor(read,predicate){const end=Date.now()+10000;while(Date.now()<end){const v=await read();if(predicate(v))return v;await delay(30)}throw Error('product entry observation deadline')}
  const readAudit=()=>fs.readFile(audit,'utf8').then(JSON.parse).catch(()=>null)
  const first=launch()
  const observed=await waitFor(readAudit,v=>v!==null)
  assert.equal(observed.pid,first.child.pid);assert.equal(observed.model,'selected');assert.ok(observed.models.includes('new-directory-id'))
  await waitFor(async()=>held,v=>v===1)
  await fs.writeFile(release,'synthetic exit boundary')
  assert.deepEqual(await first.done,{code:0,signal:null});await waitFor(async()=>cancelled,v=>v===1)
  assert.match(first.err(),/windows_endpoint_pi_catalog: refreshed/);assert.match(first.err(),/windows_endpoint_pi_catalog: cancelled/)
  const events=first.out().trim().split('\n').map(JSON.parse)
  assert.ok(events.some(v=>v.type==='session'&&v.id===observed.session))
  const afterExit=gets;await delay(1100);assert.equal(gets,afterExit)
  assert.equal(await fs.readFile(plan.settingsPath,'utf8'),plan.settingsAfter)
  assert.equal(await fs.readFile(path.join(profileDir,'models.json'),'utf8'),modelsRaw)
  assert.equal(await fs.readFile(path.join(profileDir,'auth.json'),'utf8'),authRaw)
  // Broken enablement is diagnosed without a directory/inference call or any
  // self-repair of the user's profile; the ordinary task process remains usable.
  const broken=JSON.parse(plan.settingsAfter);broken[nativeCatalogSettingsKey].providerId='missing-provider'
  await fs.writeFile(plan.settingsPath,JSON.stringify(broken));await fs.rm(audit)
  const second=launch();assert.deepEqual(await second.done,{code:0,signal:null})
  assert.match(second.err(),/windows_endpoint_pi_catalog: configuration_required/);assert.equal(gets,afterExit)
  assert.deepEqual((await readAudit()).models,['selected'])
  // Existing configurations with no opt-in remain valid and load their own
  // extension list through exactly the same normal JSON command.
  await fs.writeFile(plan.settingsPath,oldSettingsRaw);await fs.rm(audit)
  assert.equal((await nativePiCatalogHostOptions({config:{piConfigDir:profileDir},packageRoot,manifest})).piCatalogMode,'disabled')
  const third=launch();assert.deepEqual(await third.done,{code:0,signal:null})
  assert.doesNotMatch(third.err(),/windows_endpoint_pi_catalog/);assert.equal(gets,afterExit)
  assert.deepEqual((await readAudit()).models,['selected']);assert.equal(inference,0)
  console.log(JSON.stringify({officialPi:'1.4.0',normalJsonProfileLoad:true,existingUserExtensionPreserved:true,legacyFileBinding:null,selectedModelUnchanged:true,modelsJsonUnchanged:true,exitCancels:true,configurationFailureDiagnosed:true,oldProfileCompatible:true,inferenceRequests:inference}))
})
