import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const piPackage = process.env.PI_NATIVE_FIXTURE_PACKAGE
const extension = fileURLToPath(new URL('../pi-magpie-native-extension.mjs',import.meta.url))
test('official Pi 1.4 native catalog changes in the same process without profile writes or model changes', {skip:!piPackage,timeout:45000}, async t => {
  assert.equal(JSON.parse(await fs.readFile(path.join(piPackage,'package.json'),'utf8')).version,'1.4.0')
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'pi-native-catalog-')))
  t.after(() => fs.rm(root,{recursive:true,force:true}))
  const profile=path.join(root,'profile'), work=path.join(root,'work'), sessions=path.join(root,'sessions')
  for (const p of [profile,work,sessions]) await fs.mkdir(p)
  let generation=1, offline=false, hold=false, requests=0, inference=0, held=0, cancelled=0
  const liveResponses=new Set()
  const row=id => ({id,context_window:8192,context_length:8192,max_output_tokens:1024,reasoning:true,modalities:{input:['text']}})
  const server=http.createServer((req,res) => {
    if(req.method!=='GET'||req.url!=='/v1/models'){inference++;res.writeHead(400).end();return}
    requests++
    if(req.headers.authorization!=='Bearer synthetic-native-key'){res.writeHead(401).end();return}
    if(hold){held++;liveResponses.add(res);res.on('close',()=>{liveResponses.delete(res);if(!res.writableEnded)cancelled++});return}
    if(offline){res.writeHead(503).end();return}
    res.setHeader('content-type','application/json')
    res.end(JSON.stringify({data:[row('selected'),row('learned-'+generation),{...row('incomplete'),max_output_tokens:undefined}]}))
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(async()=>{for(const res of liveResponses)res.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
  const config={providers:{'fixture-provider':{api:'openai-completions',baseUrl:`http://127.0.0.1:${server.address().port}/v1`,apiKey:'$UNSET_FIXTURE_REFERENCE',models:[{id:'selected',name:'User selected',reasoning:false,input:['text'],contextWindow:4096,maxTokens:512,cost:{input:2,output:3,cacheRead:0,cacheWrite:0}}],modelOverrides:{selected:{maxTokens:333}}}}}
  const modelBytes=JSON.stringify(config,null,3)+'\n'
  const authBytes=JSON.stringify({'fixture-provider':{type:'api_key',key:'synthetic-native-key'}})
  await fs.writeFile(path.join(profile,'models.json'),modelBytes)
  await fs.writeFile(path.join(profile,'auth.json'),authBytes)
  await fs.writeFile(path.join(profile,'settings.json'),'{}')
  const originalStamp=(await fs.stat(path.join(profile,'models.json'),{bigint:true})).mtimeNs
  const children=[]
  t.after(async()=>{for(const p of children)if(p.child.exitCode===null){p.child.kill('SIGKILL');await p.done}})
  function launch() {
    const env={HOME:root,PATH:process.env.PATH,PI_CODING_AGENT_DIR:profile}
    for(const key of ['SystemRoot','WINDIR','COMSPEC','TEMP','TMP','APPDATA','LOCALAPPDATA'])if(process.env[key])env[key]=process.env[key]
    const child=spawn(process.execPath,[path.join(piPackage,'dist/bundle/cli.js'),'--mode','rpc','--provider','fixture-provider','--model','selected','--session-dir',sessions,'--session-id',randomUUID(),'--no-mcp','--no-skills','--no-prompt-templates','--no-context-files','--extension',extension,'--magpie-native-provider','fixture-provider','--magpie-native-interval-ms','1000'],{cwd:work,env,stdio:['pipe','pipe','pipe']})
    const pending=new Map(), notifications=[];let buffer='',stderr='',serial=0
    const done=new Promise(resolve=>child.on('exit',(code,signal)=>resolve({code,signal})))
    child.stderr.on('data',data=>{stderr+=data})
    child.stdout.on('data',data=>{
      buffer+=data;const lines=buffer.split('\n');buffer=lines.pop()
      for(const line of lines){let v;try{v=JSON.parse(line)}catch{continue}
        if(v.type==='response'&&pending.has(v.id)){pending.get(v.id)(v);pending.delete(v.id)}
        if(v.type==='extension_ui_request'&&v.method==='notify')notifications.push(v)
      }
    })
    const send=async(type,extra={})=>{
      const id=String(++serial)
      const response=new Promise(resolve=>pending.set(id,resolve))
      child.stdin.write(JSON.stringify({id,type,...extra})+'\n')
      let timeout
      try{return await Promise.race([response,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('RPC deadline; '+stderr.slice(0,600))),20000)})])}finally{clearTimeout(timeout)}
    }
    const p={child,done,send,notifications,stderr:()=>stderr};children.push(p);return p
  }
  async function waitFor(read,predicate) {
    const end=Date.now()+12000
    while(Date.now()<end){const value=await read();if(predicate(value))return value;await delay(50)}
    throw Error('native fixture observation deadline')
  }
  const getModels=async p=>{const r=await p.send('get_available_models');assert.equal(r.success,true);return r.data.models.filter(m=>m.provider==='fixture-provider')}
  const first=launch()
  const initial=await first.send('get_state');assert.equal(initial.success,true)
  const session=initial.data.sessionId, pid=first.child.pid
  const one=await waitFor(()=>getModels(first),models=>models.some(m=>m.id==='learned-1'))
  assert.equal(one.find(m=>m.id==='selected').maxTokens,333)
  assert.equal(one.find(m=>m.id==='selected').reasoning,false)
  assert.equal(one.some(m=>m.id==='incomplete'),false)
  generation=2
  await waitFor(()=>getModels(first),models=>models.some(m=>m.id==='learned-2'))
  const same=await first.send('get_state')
  assert.equal(first.child.pid,pid);assert.equal(same.data.sessionId,session)
  assert.equal(same.data.model.id,'selected');assert.equal(same.data.messageCount,0)
  await first.send('prompt',{message:'/magpie-native-status'})
  await waitFor(async()=>first.notifications,ns=>ns.some(n=>n.message?.includes('magpieNativeCatalog')))
  const status=JSON.parse(first.notifications.at(-1).message).magpieNativeCatalog
  assert.equal(status.pid,pid);assert.equal(status.sessionId,session);assert.equal(status.deferred,1)
  assert.equal((await first.send('get_state')).data.messageCount,0)
  offline=true;const previousRequests=requests
  await waitFor(async()=>requests,n=>n>previousRequests)
  const retained=await getModels(first);assert.ok(retained.some(m=>m.id==='learned-2'))
  offline=false;hold=true
  await waitFor(async()=>held,n=>n>0)
  const beforeCancel=cancelled
  await first.send('prompt',{message:'/magpie-native-cancel'})
  await waitFor(async()=>cancelled,n=>n>beforeCancel)
  assert.equal(first.child.exitCode,null)
  const alive=await first.send('get_state');assert.equal(alive.data.sessionId,session);assert.equal(alive.data.model.id,'selected');assert.equal(alive.data.messageCount,0)
  const nextHeld=held
  await waitFor(async()=>held,n=>n>nextHeld)
  const beforeShutdownCancel=cancelled
  first.child.stdin.end()
  assert.equal((await first.done).code,0)
  await waitFor(async()=>cancelled,n=>n>beforeShutdownCancel)
  const afterStop=requests;await delay(1100);assert.equal(requests,afterStop)
  hold=false;offline=true
  const restarted=launch()
  const restartedState=await restarted.send('get_state');assert.equal(restartedState.success,true)
  assert.notEqual(restarted.child.pid,pid)
  const restored=await getModels(restarted)
  assert.deepEqual(restored.map(m=>m.id),['selected'])
  assert.equal(restartedState.data.model.id,'selected')
  restarted.child.stdin.end();assert.equal((await restarted.done).code,0)
  assert.equal(await fs.readFile(path.join(profile,'models.json'),'utf8'),modelBytes)
  assert.equal((await fs.stat(path.join(profile,'models.json'),{bigint:true})).mtimeNs,originalStamp)
  assert.equal(await fs.readFile(path.join(profile,'auth.json'),'utf8'),authBytes)
  // Pi 1.4 FileModelsStore.read uses FileAuthStorageBackend.ensureFileExists:
  // a read can create its generic empty store even without context.persist.
  // Require exact empty bytes, not a false claim that the file never exists.
  assert.equal(await fs.readFile(path.join(profile,'models-store.json'),'utf8'),'{}')
  assert.equal(inference,0)
  process.stdout.write(JSON.stringify({officialPi:'1.4.0',sameProcessRefresh:true,sameSession:true,modelUnchanged:true,modelsJsonUnchanged:true,authUnchanged:true,networkFailureRetains:true,restartOfflineForgetsDynamic:true,shutdownCancels:true,inferenceRequests:inference})+'\n')
})
