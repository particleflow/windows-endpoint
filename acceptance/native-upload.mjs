// Acceptance evidence only. No enrollment, credential loader, task submission,
// source closure, queue creation, failure retry or release-gate mutation.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import {createHash} from 'node:crypto'
import {execFile} from 'node:child_process'
import {promisify,isDeepStrictEqual} from 'node:util'
import {fileURLToPath} from 'node:url'
import {verifyCandidate} from '../candidate.mjs'
import {catalog,validateConfig,validateDirectory,validateTransferConfiguration,transferEnvironment,transferLocations} from '../endpoint.mjs'
import {boundedRead} from '../session-diagnostics.mjs'

const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const demand=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code})}
const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value)
const samePath=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b
const stamp=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs,s.nlink,s.mode].map(String).join(':')

async function json(file,limit=262144){
  await validateDirectory(path.dirname(file))
  const s=await fs.lstat(file)
  demand(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.size<=limit,'acceptance_input_invalid')
  return JSON.parse(await fs.readFile(file,'utf8'))
}

export function expectedFile(closed){
  demand(closed?.version===1&&closed.closed===true&&hash(closed.sha256)&&Number.isSafeInteger(closed.size_bytes)&&closed.size_bytes>0,'acceptance_declaration_invalid')
  const t=closed.task,a=closed.artifact
  demand(t&&['operation_id','bot_id','user_id','session_id','target_id'].every(k=>uuid(t[k]))&&
    ['attempt','generation'].every(k=>/^[a-f0-9]{32}$/.test(t[k]))&&hash(t.root_hash)&&typeof t.run_id==='string'&&t.run_id.length>0&&t.run_id.length<=256,'acceptance_declaration_invalid')
  demand(a&&typeof a.source_ref==='string'&&a.source_ref.length<=64&&/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(a.source_ref)&&
    !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(a.source_ref)&&!a.source_ref.startsWith('memoh_delivery_')&&
    typeof a.mime==='string'&&a.mime.length<=255&&/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(a.mime),'acceptance_declaration_invalid')
  // Recompute the existing producer ID for comparison, never allocate an ID.
  const delivery=sha(JSON.stringify({Operation:t.operation_id,Attempt:t.attempt,Generation:t.generation,Source:a.source_ref}))
  return {delivery_id:delivery,operation_id:t.operation_id,bot_id:t.bot_id,content_hash:closed.sha256,size_bytes:closed.size_bytes,mime:a.mime}
}

export async function sourceEvidence(file,closed){
  const expected=expectedFile(closed)
  await validateDirectory(path.dirname(file))
  const before=await fs.lstat(file,{bigint:true})
  demand(before.isFile()&&!before.isSymbolicLink()&&before.nlink===1n&&before.ino!==0n&&before.size===BigInt(expected.size_bytes),'acceptance_source_invalid')
  const handle=await fs.open(file,'r'),digest=createHash('sha256'),buffer=Buffer.alloc(65536)
  try{
    demand(stamp(await handle.stat({bigint:true}))===stamp(before),'acceptance_source_changed')
    let total=0
    for(;;){const {bytesRead}=await handle.read(buffer,0,buffer.length,null);if(!bytesRead)break;digest.update(buffer.subarray(0,bytesRead));total+=bytesRead}
    demand(total===expected.size_bytes&&digest.digest('hex')===expected.content_hash&&stamp(await handle.stat({bigint:true}))===stamp(before)&&
      stamp(await fs.lstat(file,{bigint:true}))===stamp(before),'acceptance_source_changed')
  }finally{await handle.close()}
  return {sha256:expected.content_hash,size_bytes:expected.size_bytes,generation:stamp(before)}
}

export function nativeStatus(result,id){
  demand(result&&!result.signal&&!result.error&&!result.timedOut&&Number.isInteger(result.status),'acceptance_cli_outcome_unknown')
  demand(result.status===0,'acceptance_cli_failed')
  const value=result.value
  demand(value&&value.delivery_id===id&&typeof value.phase==='string'&&Number.isSafeInteger(value.offset)&&value.offset>=0&&
    ['admitted','registered','associated'].every(k=>typeof value[k]==='boolean'),'acceptance_cli_status_invalid')
  demand(value.feedback_status==='recorded','acceptance_feedback_unverified')
  const allowed=['delivery_id','phase','offset','admitted','registered','associated','feedback_status','payload_state','association_state','error_code','reference']
  demand(Object.keys(value).every(k=>allowed.includes(k)),'acceptance_cli_status_invalid')
  for(const key of ['phase','payload_state','association_state','error_code'])if(Object.hasOwn(value,key))
    demand(typeof value[key]==='string'&&/^[a-z_]{0,80}$/.test(value[key]),'acceptance_cli_status_invalid')
  if(value.reference){
    const r=value.reference
    demand(Object.keys(r).sort().join(',')==='bot_id,content_hash,delivery_id,mime,operation_id,size_bytes'&&r.delivery_id===id&&
      uuid(r.operation_id)&&uuid(r.bot_id)&&hash(r.content_hash)&&Number.isSafeInteger(r.size_bytes)&&r.size_bytes>0&&
      typeof r.mime==='string'&&r.mime.length<=255&&/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(r.mime),'acceptance_cli_status_invalid')
  }
  return value
}

function referenceMatches(ref,e){return ref&&Object.keys(e).every(k=>ref[k]===e[k])&&Object.keys(ref).length===Object.keys(e).length}
export function nativeReceiptBinding(result,closed,hostBinding){
  demand(result?.status!==2,'acceptance_receipt_export_unsupported')
  demand(result&&!result.signal&&!result.error&&!result.timedOut&&result.status===0,'acceptance_receipt_query_failed')
  const e=expectedFile(closed),v=result.value
  const allowed=['schema','state','scope','server_effects','delivery_id','task','host_binding','source_ref','content_hash','size_bytes','mime','known_receipt','phase','associated','association_state']
  demand(v&&Object.keys(v).every(k=>allowed.includes(k))&&v.schema==='memoh.delivery.receipt-binding.v1'&&
    v.state==='local_receipt_binding'&&v.scope==='local_queue_read_only'&&v.server_effects==='none'&&
    v.delivery_id===e.delivery_id&&isDeepStrictEqual(v.task,closed.task)&&v.source_ref===closed.artifact.source_ref&&
    hash(v.host_binding)&&v.host_binding===hostBinding&&v.content_hash===e.content_hash&&v.size_bytes===e.size_bytes&&v.mime===e.mime&&
    typeof v.associated==='boolean'&&typeof v.phase==='string'&&/^[a-z_]{1,80}$/.test(v.phase)&&
    (!Object.hasOwn(v,'association_state')||typeof v.association_state==='string'&&/^[a-z_]{0,80}$/.test(v.association_state)),
    'acceptance_receipt_binding_mismatch')
  demand(typeof v.known_receipt==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(v.known_receipt),'acceptance_receipt_not_recorded')
  return v
}
export async function readSelectedReceipt(call,closed,hostBinding){
  const result=await call('receipt-binding',expectedFile(closed).delivery_id)
  nativeReceiptBinding(result,closed,hostBinding)
  return result
}
export function verifyCaptures({closed,capture,owner}){
  const e=expectedFile(closed)
  demand(capture?.schema===1&&capture.kind==='windows_native_upload_capture'&&capture.producer_commit===catalog.components.transfer.revision&&
    capture.source?.sha256===e.content_hash&&capture.source.size_bytes===e.size_bytes&&hash(capture.manifest_sha256)&&hash(capture.executable_sha256),'acceptance_capture_invalid')
  demand(capture.completed===true&&Array.isArray(capture.steps)&&capture.steps.length>0&&capture.steps.length<=16,'acceptance_capture_incomplete')
  const before=nativeStatus(capture.before,e.delivery_id),after=nativeStatus(capture.after,e.delivery_id)
  const steps=capture.steps.map(step=>nativeStatus(step,e.delivery_id)),advanced=steps.at(-1)
  demand(before.phase==='queued'&&before.offset===0&&!before.associated&&!before.reference&&(before.registered||before.admitted),'acceptance_prior_outcome_unverified')
  for(const v of steps)demand(!v.error_code&&!['creating','create_unknown','blocked','canceled'].includes(v.phase)&&
    !['unknown','in_flight','blocked'].includes(v.association_state),'acceptance_progress_unverified')
  for(const v of [advanced,after])demand(v.phase==='ready'&&v.offset===e.size_bytes&&v.associated&&v.association_state==='committed'&&referenceMatches(v.reference,e),'acceptance_not_committed')
  // Existing authorized owner readback; this file is evidence, never authority
  // to invoke a transfer or stop a task. Do not construct it from model text.
  const request=owner?.recovery_request,receipt=owner?.receipt_response,result=owner?.task_result,local=owner?.local_receipt_capture
  let knownReceipt
  if(local){
    demand(local.schema===1&&local.kind==='windows_native_receipt_capture'&&hash(capture.host_binding)&&
      local.producer_commit===capture.producer_commit&&local.manifest_sha256===capture.manifest_sha256&&
      local.executable_sha256===capture.executable_sha256,'acceptance_receipt_capture_mismatch')
    knownReceipt=nativeReceiptBinding(local.result,closed,capture.host_binding).known_receipt
  }else{
    const plan=request?.plan,artifacts=plan?.version===1?[plan.artifact]:plan?.version===2?plan.artifacts:[]
    demand(request?.version===1&&isDeepStrictEqual(plan?.task,closed.task)&&Array.isArray(artifacts)&&
      artifacts.filter(a=>isDeepStrictEqual(a,closed.artifact)).length===1&&request.source_ref===closed.artifact.source_ref&&
      request.physical_name===closed.artifact.source_ref&&request.sha256===e.content_hash&&request.size_bytes===e.size_bytes&&
      request.remote_outcome==='existing'&&typeof request.known_receipt==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(request.known_receipt)&&
      ['host_binding','target_fingerprint','operation_fingerprint','request_hash','context_hash'].every(k=>hash(request[k])),'acceptance_receipt_binding_missing')
    knownReceipt=request.known_receipt
  }
  demand(receipt?.status===200&&receipt.body?.id===knownReceipt&&receipt.body.state==='ready'&&receipt.body.offset===e.size_bytes&&
    receipt.body.content_hash===e.content_hash&&receipt.body.size_bytes===e.size_bytes&&receipt.body.mime===e.mime,'acceptance_receipt_unverified')
  demand(result?.operation_id===e.operation_id&&result.target_id===closed.task.target_id,'acceptance_owner_result_mismatch')
  const delivery=result.delivery
  const file=Array.isArray(delivery?.files)?delivery.files.find(f=>f.delivery_id===e.delivery_id):delivery
  demand(file?.delivery_id===e.delivery_id&&file.state==='delivered'&&file.reference?.version===1&&file.reference.direction==='upload'&&
    file.reference.content_hash===e.content_hash&&file.reference.size_bytes===e.size_bytes&&file.reference.mime===e.mime,'acceptance_owner_commit_unverified')
  return {state:'captured_chain_matches',delivery_id:e.delivery_id,operation_id:e.operation_id,content_hash:e.content_hash,size_bytes:e.size_bytes,
    receipt_id:knownReceipt,producer_commit:capture.producer_commit,manifest_sha256:capture.manifest_sha256,executable_sha256:capture.executable_sha256,
    evidence:'supplied_native_and_authorized_owner_captures',authorizationGranted:false,releaseGateChanged:false,
    productionAcceptance:'requires_unique_writer_provenance_and_review'}
}

async function invoke(file,args,options){
  try{const r=await promisify(execFile)(file,args,options);return {status:0,value:JSON.parse(r.stdout)}}
  catch(error){
    if(!error.killed&&!error.signal&&Number.isInteger(error.code))return {status:error.code}
    return {status:null,error:'acceptance_cli_outcome_unknown'}
  }
}

export async function driveSelectedDelivery(call,result,id,deadline){
  result.before=await call('inspect');const b=nativeStatus(result.before,id)
  demand(b.phase==='queued'&&b.offset===0&&!b.associated&&!b.reference&&(b.registered||b.admitted),'acceptance_prior_outcome_unverified')
  let previous=b
  // Native RunOne advances one finite protocol step. This bounded test drives
  // only successful progress; no retry on failure/backoff/no progress/unknown.
  for(let i=0;i<16;i++){
    demand(Date.now()<deadline,'acceptance_deadline')
    const step=await call('advance');result.steps.push(step)
    const current=nativeStatus(step,id)
    demand(!current.error_code&&!['creating','create_unknown','blocked','canceled'].includes(current.phase)&&
      !['unknown','in_flight','blocked'].includes(current.association_state),'acceptance_progress_unverified')
    if(current.associated&&current.phase==='ready'&&current.association_state==='committed')break
    demand(!isDeepStrictEqual(current,previous),'acceptance_progress_stalled')
    previous=current
  }
  demand(result.steps.at(-1)?.value?.associated===true,'acceptance_step_limit')
  result.after=await call('inspect');nativeStatus(result.after,id)
}

export async function captureNative({candidate,manifestSha256,configuration,closed,out}){
  demand(process.platform==='win32'&&process.arch==='x64','acceptance_windows_required')
  const e=expectedFile(closed),verified=await verifyCandidate(candidate,manifestSha256)
  demand(verified.manifest.producer_commit===catalog.components.transfer.revision,'acceptance_producer_mismatch')
  const config=validateConfig(configuration),locations=transferLocations(config)
  demand(samePath(path.resolve(locations.root),path.join(path.resolve(candidate),'transfer')),'acceptance_configured_producer_mismatch')
  await validateTransferConfiguration(config)
  const transferFile=path.join(locations.config,'transfer.json'),hostBinding=sha(await boundedRead(transferFile,8192))
  demand(closed.task.root_hash===sha(config.sourceRoot.replaceAll('/','\\').replace(/\\+$/,'').toLowerCase()),'acceptance_root_mismatch')
  const sourceFile=path.join(config.sourceRoot,closed.artifact.source_ref),source=await sourceEvidence(sourceFile,closed)
  const executable=path.join(locations.root,'transferqueue.exe'),member=verified.manifest.files.find(f=>f.path==='transfer/transferqueue.exe')
  // Reserve the evidence name BEFORE a network-affecting command. An existing
  // capture is never permission to repeat a prior unknown or successful run.
  const evidence=await fs.open(out,'wx',0o600)
  const deadline=Date.now()+120000,steps=[]
  const options={env:transferEnvironment(config),cwd:config.sourceRoot,encoding:'utf8',maxBuffer:16384,windowsHide:true,shell:false}
  const call=action=>invoke(executable,['-action',action,'-delivery',e.delivery_id],{...options,timeout:Math.max(1,deadline-Date.now())})
  const result={schema:1,kind:'windows_native_upload_capture',producer_commit:verified.manifest.producer_commit,
    manifest_sha256:manifestSha256,executable_sha256:member.sha256,host_binding:hostBinding,source,steps,completed:false,
    scope:'one_selected_delivery_acceptance_only',releaseGateChanged:false}
  try{
    await driveSelectedDelivery(call,result,e.delivery_id,deadline)
    const unchanged=await sourceEvidence(sourceFile,closed)
    demand(unchanged.generation===source.generation,'acceptance_source_changed')
    demand(sha(await boundedRead(transferFile,8192))===hostBinding,'acceptance_configuration_changed')
    const last=nativeStatus(steps.at(-1),e.delivery_id),after=nativeStatus(result.after,e.delivery_id)
    demand([last,after].every(v=>v.phase==='ready'&&v.offset===e.size_bytes&&v.associated&&v.association_state==='committed'&&referenceMatches(v.reference,e)),'acceptance_not_committed')
    result.completed=true
    return {state:'native_capture_saved',delivery_id:e.delivery_id,committed:true,receiptReadback:'still_required',releaseGateChanged:false}
  }catch(error){
    result.error=/^acceptance_[a-z_]+$/.test(error.code||'')?error.code:'acceptance_input_unavailable'
    throw error
  }finally{
    // Retain only schema-checked stdout or bounded generic failure, never a raw
    // child error/message, environment, URL, credential or response body.
    const safe=r=>{try{nativeStatus(r,e.delivery_id);return r}catch{return {status:Number.isInteger(r?.status)?r.status:null,error:'acceptance_cli_unverified'}}}
    for(const key of ['before','after'])if(result[key])result[key]=safe(result[key])
    result.steps=result.steps.map(safe)
    try{await evidence.writeFile(JSON.stringify(result)+'\n');await evidence.sync()}finally{await evidence.close()}
  }
}

export async function captureNativeReceipt({candidate,manifestSha256,configuration,closed,out}){
  demand(process.platform==='win32'&&process.arch==='x64','acceptance_windows_required')
  const e=expectedFile(closed),verified=await verifyCandidate(candidate,manifestSha256)
  const config=validateConfig(configuration),locations=transferLocations(config)
  demand(samePath(path.resolve(locations.root),path.join(path.resolve(candidate),'transfer')),'acceptance_configured_producer_mismatch')
  // No credential read/presence requirement and no source-body read. The native
  // reader owns private-storage/locator/HostBinding checks, not a JS decoder.
  const transferFile=path.join(locations.config,'transfer.json'),hostBinding=sha(await boundedRead(transferFile,8192))
  const member=verified.manifest.files.find(f=>f.path==='transfer/transferqueue.exe')
  const evidence=await fs.open(out,'wx',0o600)
  try{
    const result=await readSelectedReceipt((action,id)=>invoke(path.join(locations.root,'transferqueue.exe'),['-action',action,'-delivery',id],
      {env:transferEnvironment(config),encoding:'utf8',timeout:15000,maxBuffer:16384,windowsHide:true,shell:false}),closed,hostBinding)
    demand(sha(await boundedRead(transferFile,8192))===hostBinding,'acceptance_configuration_changed')
    await evidence.writeFile(JSON.stringify({schema:1,kind:'windows_native_receipt_capture',producer_commit:verified.manifest.producer_commit,
      manifest_sha256:manifestSha256,executable_sha256:member.sha256,result})+'\n')
    await evidence.sync()
    return {state:'local_receipt_capture_saved',delivery_id:e.delivery_id,serverEffects:'none',deliveryProven:false,releaseGateChanged:false}
  }finally{await evidence.close()}
}

async function main(args){
  const [mode,...rest]=args,options={}
  for(let i=0;i<rest.length;i+=2){demand(/^--[a-z-]+$/.test(rest[i])&&typeof rest[i+1]==='string'&&!Object.hasOwn(options,rest[i]),'acceptance_arguments_invalid');options[rest[i]]=rest[i+1]}
  const names=['capture','receipt'].includes(mode)?['candidate','manifest-sha256','config','expected','out']:mode==='verify'?['expected','capture','owner']:[]
  demand(names.length&&Object.keys(options).sort().join(',')===names.map(n=>'--'+n).sort().join(','),'acceptance_arguments_invalid')
  const closed=await json(options['--expected'],16384)
  if(mode==='capture')return captureNative({candidate:path.resolve(options['--candidate']),manifestSha256:options['--manifest-sha256'],configuration:await json(options['--config'],65536),closed,out:options['--out']})
  if(mode==='receipt')return captureNativeReceipt({candidate:path.resolve(options['--candidate']),manifestSha256:options['--manifest-sha256'],configuration:await json(options['--config'],65536),closed,out:options['--out']})
  return verifyCaptures({closed,capture:await json(options['--capture'],65536),owner:await json(options['--owner'])})
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{process.stdout.write(JSON.stringify(await main(process.argv.slice(2)))+'\n')}
  catch(error){process.stderr.write(JSON.stringify({state:'acceptance_unverified',error:/^acceptance_[a-z_]+$/.test(error.code||'')?error.code:'acceptance_input_unavailable',releaseGateChanged:false})+'\n');process.exitCode=2}
}
