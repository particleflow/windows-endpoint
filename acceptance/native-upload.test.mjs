import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {expectedFile,nativeStatus,sourceEvidence,verifyCaptures,driveSelectedDelivery} from './native-upload.mjs'

const bytes=Buffer.from('synthetic acceptance bytes; no model or NAS call\n')
const sum=createHash('sha256').update(bytes).digest('hex')
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
function fixture(){
  const closed={version:1,closed:true,sha256:sum,size_bytes:bytes.length,
    task:{operation_id:id(1),bot_id:id(2),user_id:id(3),session_id:id(4),target_id:id(5),run_id:'synthetic-run',
      attempt:'a'.repeat(32),generation:'b'.repeat(32),root_hash:'c'.repeat(64)},artifact:{source_ref:'acceptance.bin',mime:'application/octet-stream'}}
  const reference=expectedFile(closed),delivery_id=reference.delivery_id
  const before={status:0,value:{delivery_id,phase:'queued',offset:0,admitted:true,registered:true,associated:false,feedback_status:'recorded'}}
  const ready={status:0,value:{delivery_id,phase:'ready',offset:bytes.length,admitted:true,registered:true,associated:true,
    feedback_status:'recorded',association_state:'committed',reference}}
  const capture={schema:1,kind:'windows_native_upload_capture',producer_commit:'0813c7127faa2f6383b723d5f81ec05487c4e446',
    manifest_sha256:'d'.repeat(64),executable_sha256:'e'.repeat(64),source:{sha256:sum,size_bytes:bytes.length},
    before,steps:[structuredClone(ready)],after:ready,completed:true}
  const owner={recovery_request:{version:1,plan:{version:1,task:closed.task,artifact:closed.artifact},source_ref:closed.artifact.source_ref,
    physical_name:closed.artifact.source_ref,sha256:sum,size_bytes:bytes.length,remote_outcome:'existing',known_receipt:'synthetic-receipt',
    ...Object.fromEntries(['host_binding','target_fingerprint','request_hash','operation_fingerprint','context_hash'].map(k=>[k,'f'.repeat(64)]))},
    receipt_response:{status:200,body:{id:'synthetic-receipt',state:'ready',offset:bytes.length,content_hash:sum,size_bytes:bytes.length,mime:closed.artifact.mime}},
    task_result:{operation_id:closed.task.operation_id,target_id:closed.task.target_id,delivery:{delivery_id,state:'delivered',
      reference:{version:1,direction:'upload',content_hash:sum,size_bytes:bytes.length,mime:closed.artifact.mime}}}}
  return {closed,capture,owner}
}

test('matching native/receipt/owner captures are evidence, never authorization or gate approval',()=>{
  const f=fixture(),out=verifyCaptures(f)
  assert.equal(out.state,'captured_chain_matches')
  assert.equal(out.authorizationGranted,false);assert.equal(out.releaseGateChanged,false)
  assert.equal(out.productionAcceptance,'requires_unique_writer_provenance_and_review')
  const file=f.owner.task_result.delivery
  f.owner.task_result.delivery={files:[file],state:'delivered'}
  f.owner.recovery_request.plan={version:2,task:f.closed.task,artifacts:[f.closed.artifact,{source_ref:'other.bin',mime:'application/octet-stream'}]}
  assert.equal(verifyCaptures(f).delivery_id,file.delivery_id)
})

test('receipt observation and successful exit alone cannot prove upload or association',()=>{
  for(const value of [
    {state:'receipt_observed',recovery_scope:'receipt_get_only',server_effects:'ready_proof_may_be_recorded'},
    {state:'idle'},
  ]){
    const f=fixture();f.capture.steps=[{status:0,value}]
    assert.throws(()=>verifyCaptures(f),/acceptance_cli_status_invalid/)
  }
  for(const mutate of [v=>{v.associated=false},v=>{v.association_state='unknown'},v=>{delete v.reference},v=>{v.offset--},v=>{v.reference.content_hash='0'.repeat(64)}]){
    const f=fixture();mutate(f.capture.after.value)
    assert.throws(()=>verifyCaptures(f),/acceptance_not_committed/)
  }
})

test('original operation, receipt and delivered reference must all agree',()=>{
  for(const mutate of [
    f=>{f.owner.recovery_request.remote_outcome='unknown'},
    f=>{f.owner.recovery_request.plan.task={...f.closed.task,attempt:'0'.repeat(32)}},
    f=>{f.owner.recovery_request.physical_name='different.bin'},
    f=>{f.owner.receipt_response.status=401},
    f=>{f.owner.receipt_response.body.id='different-receipt'},
    f=>{f.owner.receipt_response.body.content_hash='0'.repeat(64)},
    f=>{f.owner.receipt_response.body.offset--},
    f=>{f.owner.task_result.target_id=id(9)},
    f=>{f.owner.task_result.operation_id=id(9)},
    f=>{f.owner.task_result.delivery.state='pending'},
    f=>{f.owner.task_result.delivery.reference.direction='download'},
    f=>{f.owner.task_result.delivery.reference.size_bytes++},
    f=>{f.capture.producer_commit='0894a6eb8ff69c8796e2da5450fa172d4cd5ef81'},
    f=>{f.capture.completed=false},
    f=>{f.capture.steps.unshift({status:0,value:{...f.capture.before.value,phase:'create_unknown'}})},
  ]){const f=fixture();mutate(f);assert.throws(()=>verifyCaptures(f),/acceptance_/)}
  for(const result of [{status:1},{status:0,signal:'SIGTERM'},{status:0,timedOut:true},{status:null,error:'unknown'}])
    assert.throws(()=>nativeStatus(result,expectedFile(fixture().closed).delivery_id),/acceptance_cli_/)
})

test('finite selected-delivery driver follows success steps, never retries unknown/error/no progress',async()=>{
  const {capture}=fixture(),id=capture.before.value.delivery_id
  const progressing={status:0,value:{...capture.before.value,phase:'uploading'}}
  const responses=[capture.before,progressing,capture.after,capture.after],calls=[],result={steps:[]}
  await driveSelectedDelivery(async action=>{calls.push(action);return responses.shift()},result,id,Date.now()+10000)
  assert.deepEqual(calls,['inspect','advance','advance','inspect'])
  assert.equal(result.steps.length,2)
  for(const failure of [{status:1},{status:null,error:'unknown'},capture.before,
    {status:0,value:{...capture.before.value,phase:'create_unknown'}},
    {status:0,value:{...capture.before.value,error_code:'server_unavailable'}}]){
    const calls=[],result={steps:[]}
    await assert.rejects(driveSelectedDelivery(async action=>{calls.push(action);return calls.length===1?capture.before:failure},result,id,Date.now()+10000),/acceptance_/)
    assert.deepEqual(calls,['inspect','advance'])
  }
  const cachedCalls=[]
  await assert.rejects(driveSelectedDelivery(async action=>{cachedCalls.push(action);return capture.after},{steps:[]},id,Date.now()+10000),/acceptance_prior_outcome_unverified/)
  assert.deepEqual(cachedCalls,['inspect'])
  await assert.rejects(driveSelectedDelivery(async()=>capture.before,{steps:[]},id,Date.now()-1),/acceptance_deadline/)
  let advances=0
  await assert.rejects(driveSelectedDelivery(async action=>action==='inspect'?capture.before:
    {status:0,value:{...progressing.value,offset:++advances}},{steps:[]},id,Date.now()+10000),/acceptance_step_limit/)
  assert.equal(advances,16)
})

test('source verification streams exact bytes and rejects mismatch and links without modifying source',async t=>{
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'upload-acceptance-')))
  t.after(()=>fs.rm(dir,{recursive:true,force:true}))
  const file=path.join(dir,'acceptance.bin'),{closed}=fixture()
  await fs.writeFile(file,bytes)
  assert.equal((await sourceEvidence(file,closed)).sha256,sum)
  await assert.rejects(sourceEvidence(file,{...closed,sha256:'0'.repeat(64)}),/acceptance_source_changed/)
  const alias=path.join(dir,'alias.bin');await fs.link(file,alias)
  await assert.rejects(sourceEvidence(file,closed),/acceptance_source_invalid/)
  assert.deepEqual(await fs.readFile(file),bytes)
})

test('CLI offline verification runs without credential or network input and invalid arguments fail closed',async t=>{
  const dir=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'upload-evidence-')))
  t.after(()=>fs.rm(dir,{recursive:true,force:true}))
  const f=fixture(),args=['verify']
  for(const key of ['closed','capture','owner']){
    const file=path.join(dir,key+'.json');await fs.writeFile(file,JSON.stringify(f[key]))
    args.push('--'+(key==='closed'?'expected':key),file)
  }
  const script=fileURLToPath(new URL('./native-upload.mjs',import.meta.url))
  const run=options=>spawnSync(process.execPath,[script,...options],{encoding:'utf8',timeout:3000,shell:false})
  const valid=run(args)
  assert.equal(valid.status,0,valid.stderr)
  assert.equal(JSON.parse(valid.stdout).state,'captured_chain_matches')
  const invalid=run([...args,'--token','SYNTHETIC-MUST-NOT-APPEAR'])
  assert.equal(invalid.status,2)
  assert.equal(invalid.stdout,'')
  assert.equal(JSON.parse(invalid.stderr).error,'acceptance_arguments_invalid')
  assert.equal(invalid.stderr.includes('SYNTHETIC-MUST-NOT-APPEAR'),false)
})
