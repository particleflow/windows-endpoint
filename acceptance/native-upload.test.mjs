import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {expectedFile,nativeStatus,nativeReceiptBinding,readSelectedReceipt,sourceEvidence,verifyCaptures,driveSelectedDelivery} from './native-upload.mjs'

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

function localReceipt(f){
  f.capture.host_binding='f'.repeat(64)
  return {schema:1,kind:'windows_native_receipt_capture',producer_commit:f.capture.producer_commit,
    manifest_sha256:f.capture.manifest_sha256,executable_sha256:f.capture.executable_sha256,
    result:{status:0,value:{schema:'memoh.delivery.receipt-binding.v1',state:'local_receipt_binding',scope:'local_queue_read_only',server_effects:'none',
      delivery_id:expectedFile(f.closed).delivery_id,task:structuredClone(f.closed.task),host_binding:f.capture.host_binding,
      source_ref:f.closed.artifact.source_ref,content_hash:sum,size_bytes:bytes.length,mime:f.closed.artifact.mime,
      known_receipt:'synthetic-receipt',phase:'ready',associated:true,association_state:'committed'}}}
}

test('local receipt binding replaces nonexistent owner export without invoking recovery',()=>{
  const f=fixture();f.owner.local_receipt_capture=localReceipt(f);delete f.owner.recovery_request
  const out=verifyCaptures(f)
  assert.equal(out.receipt_id,'synthetic-receipt')
  assert.equal(out.authorizationGranted,false);assert.equal(out.releaseGateChanged,false)
  // A receipt ID is correlation only, even when the local phase says ready.
  f.owner.task_result.delivery.state='pending'
  assert.throws(()=>verifyCaptures(f),/acceptance_owner_commit_unverified/)
})

test('local receipt binding rejects changed identity/config/hash, server-effect claims and unknown fields',()=>{
  for(const mutate of [
    v=>{v.task.attempt='0'.repeat(32)},v=>{v.task.target_id=id(9)},v=>{v.task.root_hash='0'.repeat(64)},
    v=>{v.delivery_id='0'.repeat(64)},v=>{v.host_binding='0'.repeat(64)},v=>{v.source_ref='another.bin'},
    v=>{v.content_hash='0'.repeat(64)},v=>{v.size_bytes++},v=>{v.mime='text/plain'},
    v=>{v.scope='receipt_get_only'},v=>{v.server_effects='ready_proof_may_be_recorded'},v=>{v.credential='SYNTHETIC'},
  ]){
    const f=fixture(),local=localReceipt(f);mutate(local.result.value)
    assert.throws(()=>nativeReceiptBinding(local.result,f.closed,f.capture.host_binding),/acceptance_receipt_binding_mismatch/)
  }
  for(const mutate of [v=>{v.executable_sha256='0'.repeat(64)},v=>{v.producer_commit='0'.repeat(40)},v=>{v.manifest_sha256='0'.repeat(64)}]){
    const f=fixture();f.owner.local_receipt_capture=localReceipt(f);delete f.owner.recovery_request
    mutate(f.owner.local_receipt_capture)
    assert.throws(()=>verifyCaptures(f),/acceptance_receipt_capture_mismatch/)
  }
})

test('local receipt binding reports unsupported 0813, missing receipt or failed query without falling back',()=>{
  const f=fixture(),local=localReceipt(f)
  assert.throws(()=>nativeReceiptBinding({status:2},f.closed,f.capture.host_binding),/acceptance_receipt_export_unsupported/)
  for(const value of [{status:1},{status:null,error:'unknown'},{status:0,signal:'SIGTERM'},
    {status:0,value:{state:'receipt_observed',recovery_scope:'receipt_get_only',server_effects:'ready_proof_may_be_recorded'}}])
    assert.throws(()=>nativeReceiptBinding(value,f.closed,f.capture.host_binding),/acceptance_receipt_/)
  delete local.result.value.known_receipt
  assert.throws(()=>nativeReceiptBinding(local.result,f.closed,f.capture.host_binding),/acceptance_receipt_not_recorded/)
})

test('local receipt binding issues exactly one selected read and never falls back to inspect/recovery/advance',async()=>{
  const f=fixture(),local=localReceipt(f)
  for(const response of [local.result,{status:2},{status:1},{status:null,error:'unknown'}]){
    const calls=[]
    const action=readSelectedReceipt(async(...args)=>{calls.push(args);return response},f.closed,f.capture.host_binding)
    if(response===local.result)assert.equal(await action,response)
    else await assert.rejects(action,/acceptance_receipt_/)
    assert.deepEqual(calls,[['receipt-binding',expectedFile(f.closed).delivery_id]])
  }
})
