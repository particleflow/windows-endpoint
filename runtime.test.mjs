import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { LifecycleError, validateRestartPolicy } from './lifecycle.mjs'
import { childExitDeadline } from './test-support/child-exit-deadline.mjs'
import { validateRuntimeRequest, validateRuntimeConfiguration, createExplicitRuntime } from './runtime.mjs'
import { nativeInstalledFixture } from './test-support/installed-fixture.mjs'
import { parseAdvanceDecision } from './transfer-contract.mjs'
import { catalog } from './endpoint.mjs'

const request = () => ({ schema: 2, mode: 'existing-installations', transfer: 'disabled' })
async function configured(t) {
  const f = await nativeInstalledFixture(t)
  return { ...f, lifecycleDirectory: path.join(f.base, 'endpoint') }
}
test('explicit request rejects executable, credential, test-driver and qualification overrides', () => {
  const config = { schema: 3 }, valid = request(config)
  assert.deepEqual(validateRuntimeRequest(valid, config), valid)
  for (const value of [null, {}, { ...valid, manifestSha256: 'b'.repeat(64) }, { ...valid, mode: 'automatic' }, { ...valid, transfer: 'collect-result' }, ...['binary', 'qualified', 'createTestRuntime', 'credential'].map(k => ({ ...valid, [k]: true }))]) assert.throws(() => validateRuntimeRequest(value, config))
})
test('runtime configuration verifies roots and existing mapping without reading or creating credentials', async t => {
  const f = await configured(t)
  await validateRuntimeConfiguration(f.config, request(f.config))
  assert.equal(await fs.readFile(f.config.connector.enrollmentFile, 'utf8'), 'SYNTHETIC UNREAD ENROLLMENT')
  await fs.rm(f.config.connector.enrollmentFile)
  await assert.rejects(validateRuntimeConfiguration(f.config, request(f.config)), { code: 'connector_authentication_required' })
})
test('native runtime rejects replaced identity, program and unsafe configuration before execution', async t => {
  const f = await configured(t)
  for (const changed of [ { ...f.config, deviceId: '22222222-2222-4222-8222-222222222222' },
    { ...f.config, programs: { ...f.config.programs, herdr: 'relative' } },
    { ...f.config, connector: { ...f.config.connector, token: 'not-accepted' } } ]) {
    await assert.rejects(validateRuntimeConfiguration(changed, request(changed)))
  }
  assert.equal(f.calls.length, 0)
})
test('constructing native runtime does not execute or create work; disabled transfer stays absent', async t => {
  const f = await configured(t)
  await fs.mkdir(f.lifecycleDirectory)
  const runtime = await createExplicitRuntime({ config: f.config, stateDirectory: f.lifecycleDirectory, request: { ...request(f.config), transfer: 'disabled' } })
  assert.equal(runtime.transfer, null); assert.equal(runtime.release, null)
  assert.equal(runtime.driver.children.size, 0)
  if (process.platform !== 'win32') {
    await assert.rejects(runtime.start(), { code: 'qualified_windows_driver_required' })
    assert.equal(runtime.release, null)
    assert.equal((await runtime.store.load()).attention, 'qualified_windows_driver_required')
  }
})
test('failed producer feedback is never silently projected to idle success', () => {
  const base = { schema: 'memoh.delivery.lifecycle.v1', state: 'idle', next_due_at: null, error_class: 'none', delivery_id: 'fixture', phase: 'ready', offset: 7, admitted: true, associated: true }
  assert.equal(parseAdvanceDecision(JSON.stringify({ ...base, feedback_status: 'recorded' })).state, 'idle')
  assert.throws(() => parseAdvanceDecision(JSON.stringify({ ...base, feedback_status: 'unavailable' })), { code: 'transfer_feedback_unavailable' })
})

test('runtime restart policy preserves defaults and rejects invalid or unrepresentable recovery before execution', async () => {
  const config={schema:3}, original=request()
  assert.deepEqual(validateRuntimeRequest(original,config),original)
  assert.deepEqual(validateRestartPolicy(),{maxRestarts:3,windowMs:600000,retryMs:1000})
  const input={...original,restartPolicy:{maxRestarts:5}}
  const checked=validateRuntimeRequest(input,config)
  input.restartPolicy.maxRestarts=0
  assert.deepEqual(checked.restartPolicy,{maxRestarts:5,windowMs:600000,retryMs:1000})
  assert.ok(Object.isFrozen(checked.restartPolicy))
  for(const restartPolicy of [null,undefined,[],{maxRestarts:-1},{maxRestarts:101},{maxRestarts:1.5},{maxRestarts:Infinity},
    {windowMs:0},{windowMs:NaN},{windowMs:'600000'},{retryMs:0},{retryMs:Infinity},{maxRestarts:5,retryMs:2**31-1},{command:'restart'}]){
    const value={...original,restartPolicy}
    assert.throws(()=>validateRuntimeRequest(value,config),{code:'runtime_restart_policy_invalid'})
    await assert.rejects(createExplicitRuntime({config,stateDirectory:'/not-used',request:value}),{code:'runtime_restart_policy_invalid'})
  }
  assert.equal(validateRestartPolicy({maxRestarts:0}).maxRestarts,0)
})

// Factory and journal are production code; only the official component driver
// is replaced in this test with owned, inert Node subprocesses. No Agent/model,
// production queue, credential or network is used or qualified here.
async function recoveryFixture(t,restartPolicy){
  const f=await configured(t)
  await fs.mkdir(f.lifecycleDirectory)
  f.config.transfer={pluginRoot:path.join(f.base,'producer'),nasOrigin:'https://nas.example.com'}
  f.config.transferConfigDir=path.join(f.base,'transfer-config');f.config.transferStateDir=path.join(f.base,'transfer-state')
  const files=new Map([
    [path.join(f.config.transferConfigDir,'transfer.json'),JSON.stringify({version:1,origin:f.config.transfer.nasOrigin,source_root:f.config.sourceRoot})],
    [path.join(f.config.transferStateDir,'opaque-original.journal'),'SYNTHETIC OPAQUE ORIGINAL QUEUE/RECEIPT BYTES'],
    [path.join(f.config.sourceRoot,'original-unknown.json'),'revision2/unknown/prompt_submitted=false'],
  ])
  const originals=new Map()
  for(const [file,raw] of files){await f.write(file,raw);originals.set(file,{raw:await fs.readFile(file),mtime:(await fs.stat(file,{bigint:true})).mtimeNs})}
  const originalConfig=JSON.stringify(f.config), children=new Map(),calls=[]
  const driver={status:{state:'online',lastError:''},
    validate:async()=>{}, alive:c=>children.has(c)&&!children.get(c).closed,
    hostStatus:()=>({running:driver.alive('herdr'),version:'0.9.5',endpoint_compatible:true}),
    ownedHostStatus:async()=>driver.hostStatus(),connectorStatus:async()=>driver.status,
    async start(component){
      calls.push(component)
      const child=spawn(process.execPath,['-e','process.send("ready");setInterval(()=>{},1000)'],{stdio:['ignore','ignore','ignore','ipc'],shell:false,windowsHide:true})
      const entry={child,closed:false};entry.done=once(child,'close').then(()=>{entry.closed=true})
      children.set(component,entry)
      await once(child,'message',{signal:AbortSignal.timeout(5000)})
    },waitReady:async()=>{},recoverConnector:async()=>{},
    async stop(component){const c=children.get(component);if(c&&!c.closed){c.child.kill();await c.done}},
  }
  const make=async policy=>{
    const runtime=await createExplicitRuntime({config:f.config,stateDirectory:f.lifecycleDirectory,
      request:{...request(),...(policy===undefined?{}:{restartPolicy:policy})}})
    runtime.driver=driver // No test driver option is added to the product factory.
    return runtime
  }
  const runtime=await make(restartPolicy)
  const crash=async life=>{await driver.stop('connector');await life.tick()}
  const preserved=async()=>{
    assert.equal(JSON.stringify(f.config),originalConfig)
    for(const [file,saved]of originals){assert.deepEqual(await fs.readFile(file),saved.raw);assert.equal((await fs.stat(file,{bigint:true})).mtimeNs,saved.mtime)}
  }
  return {...f,runtime,driver,calls,make,crash,preserved}
}

for(const identity of [1,2])test(`formal factory configured five restarts recovers four real owned exits for identity ${identity}`,async t=>{
  const f=await recoveryFixture(t,{maxRestarts:5,retryMs:1})
  try{
    await f.runtime.start()
    for(let i=0;i<4;i++)await f.crash(f.runtime)
    assert.equal(f.runtime.state.phase,'running');assert.equal(f.runtime.state.attention,null)
    assert.equal(f.runtime.state.restarts.length,4)
    assert.equal(f.calls.filter(c=>c==='connector').length,5);assert.equal(f.calls.filter(c=>c==='herdr').length,1)
    assert.equal((await f.runtime.store.load()).identity,f.config.deviceId)
    await f.preserved()
  }finally{await f.runtime.stop()}
})

test('formal factory defaults still exhaust at three and never erase original task history',async t=>{
  const f=await recoveryFixture(t)
  f.runtime.delay=async()=>{} // Count boundary only; the real-clock cancellation case is separate.
  try{
    await f.runtime.start();for(let i=0;i<4;i++)await f.crash(f.runtime)
    assert.equal(f.runtime.state.attention,'restart_budget_exhausted')
    assert.equal(f.calls.filter(c=>c==='connector').length,4)
    assert.equal(f.runtime.state.restarts.length,3);await f.preserved()
  }finally{await f.runtime.stop()}
})

test('a stopped configuration change and a fresh process preserve the durable recovery budget and original files',async t=>{
  const f=await recoveryFixture(t,{maxRestarts:5,retryMs:1});let next
  try{
    await f.runtime.start();for(let i=0;i<4;i++)await f.crash(f.runtime)
    const oldRestarts=[...f.runtime.state.restarts];await f.runtime.stop()
    const script=`import {createExplicitRuntime} from ${JSON.stringify(new URL('./runtime.mjs',import.meta.url).href)};const r=await createExplicitRuntime(JSON.parse(process.argv[1]));console.log(JSON.stringify({policy:r.policy,state:await r.store.load(),children:r.driver.children.size}));`
    const child=spawnSync(process.execPath,['--input-type=module','-e',script,JSON.stringify({config:f.config,stateDirectory:f.lifecycleDirectory,request:{...request(),restartPolicy:{maxRestarts:4,retryMs:1}}})],{encoding:'utf8',timeout:10000,shell:false})
    assert.equal(child.error,undefined);assert.equal(child.status,0,child.stderr)
    const observed=JSON.parse(child.stdout)
    assert.equal(observed.policy.maxRestarts,4);assert.deepEqual(observed.state.restarts,oldRestarts);assert.equal(observed.children,0)
    next=await f.make({maxRestarts:4,retryMs:1});await next.start();await f.crash(next)
    assert.equal(next.state.attention,'restart_budget_exhausted');assert.deepEqual(next.state.restarts,oldRestarts)
    await f.preserved()
  }finally{await next?.stop();await f.runtime.stop()}
})

test('stop cancels a configured long native backoff without a respawn or lost budget',async t=>{
  const f=await recoveryFixture(t,{maxRestarts:5,retryMs:60000})
  try{
    await f.runtime.start();await f.driver.stop('connector')
    const ticking=f.runtime.tick()
    for(let i=0;i<1000&&!f.runtime.recoveryWait;i++)await delay(1)
    assert.ok(f.runtime.recoveryWait)
    assert.equal(await childExitDeadline(Promise.all([f.runtime.stop(),ticking]).then(()=>true),2000,false),true,'stop failed to cancel 60-second backoff')
    assert.equal(f.calls.filter(c=>c==='connector').length,1)
    assert.equal(f.runtime.state.restarts.length,1);assert.equal(f.runtime.release,null)
    await f.preserved()
  }finally{await f.runtime.stop()}
})

for(const reason of ['handshake_403','native_tls_verification_failed'])test(`configured recovery never retries terminal ${reason}`,async t=>{
  const f=await recoveryFixture(t,{maxRestarts:5,retryMs:1})
  try{
    await f.runtime.start();f.driver.status={state:'needs_attention',lastError:reason};await f.crash(f.runtime)
    assert.equal(f.runtime.state.restarts.length,0)
    assert.equal(f.runtime.state.attention,reason==='handshake_403'?'connector_authentication_required':'connector_tls_verification_failed')
    assert.equal(f.calls.filter(c=>c==='connector').length,1);assert.equal(f.driver.alive('herdr'),true)
    await f.preserved()
  }finally{await f.runtime.stop()}
})

test('formal factory applies the configured window and linear retry delay without changing task identity',async t=>{
  const f=await recoveryFixture(t,{maxRestarts:5,windowMs:50,retryMs:7}),waits=[]
  let now=1000;f.runtime.clock=()=>now;f.runtime.delay=async ms=>{waits.push(ms)}
  try{
    await f.runtime.start();await f.crash(f.runtime)
    now=1001;await f.crash(f.runtime)
    assert.deepEqual(f.runtime.state.restarts,[1000,1001])
    now=1052;await f.crash(f.runtime)
    assert.deepEqual(waits,[7,14,7]);assert.deepEqual(f.runtime.state.restarts,[1052])
    assert.equal(f.runtime.state.phase,'running');await f.preserved()
  }finally{await f.runtime.stop()}
})

test('permission revalidation failure remains precise and does not restart the sibling or alter original files',async t=>{
  const f=await recoveryFixture(t,{maxRestarts:5,retryMs:1})
  try{
    await f.runtime.start()
    f.driver.validate=async()=>{throw new LifecycleError('runtime_permission_denied')}
    await f.crash(f.runtime);await f.runtime.tick()
    assert.equal(f.runtime.state.attention,'runtime_permission_denied')
    assert.equal(f.calls.filter(c=>c==='connector').length,1)
    assert.equal(f.calls.filter(c=>c==='herdr').length,1);assert.equal(f.driver.alive('herdr'),true)
    await f.preserved()
  }finally{await f.runtime.stop()}
})
