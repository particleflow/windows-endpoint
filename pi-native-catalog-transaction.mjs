// Offline publication of one NEW, nonsecret official Pi extension reference.
// No existing profile file replacement, ACL edit, credential or process action.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { validateDirectory } from './endpoint.mjs'

export const nativeCatalogPendingName='pi-native-catalog-pending.json'
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const fail=code=>{throw Object.assign(Error(code),{code})}
const identity=st=>`${st.dev}:${st.ino}`
async function snapshot(file,{links=1}={}) {
  let st
  try{st=await fs.lstat(file,{bigint:true})}catch(error){if(error.code==='ENOENT')return null;throw error}
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==BigInt(links)||st.ino===0n||st.size>16384n)fail('catalog_native_reference_unsafe')
  const bytes=await fs.readFile(file,'utf8'),after=await fs.lstat(file,{bigint:true})
  if(identity(st)!==identity(after)||st.size!==after.size||st.mtimeNs!==after.mtimeNs||st.ctimeNs!==after.ctimeNs)fail('catalog_native_reference_changed')
  return {bytes,identity:identity(st)}
}
async function exclusive(file,bytes) {
  const handle=await fs.open(file,'wx',0o600)
  try{await handle.writeFile(bytes);await handle.sync()}finally{await handle.close()}
}

// Caller holds the normal deployment+host+component leases and has proved
// stopped/unchanged original work. Retrying the SAME explicit request can finish
// only its exact inode/bytes, never restore files or start an old Pi/task.
export async function publishNativeCatalogReference({lifecycleDirectory,plan,record,assertUnchanged,checkpoint=async()=>{},linkFile=fs.link}) {
  const directory=path.dirname(plan.file),profile=path.dirname(directory)
  await validateDirectory(profile)
  try{await fs.mkdir(directory)}catch(error){if(error.code!=='EEXIST')throw error}
  await validateDirectory(directory)
  const marker=path.join(lifecycleDirectory,nativeCatalogPendingName)
  const temporary=path.join(directory,`.windows-endpoint-magpie-${record.requestId}.tmp`)
  const receipt=path.join(lifecycleDirectory,`pi-native-catalog-${record.requestId}.json`)
  let pending=await snapshot(marker),stored
  if(pending) {
    try{stored=JSON.parse(pending.bytes)}catch{fail('catalog_native_recovery_required')}
    if(JSON.stringify(stored.record)!==JSON.stringify(record)||typeof stored.stageIdentity!=='string')fail('catalog_native_recovery_required')
  } else {
    const current=await snapshot(plan.file)
    if(current){if(current.bytes!==plan.bytes)fail('catalog_native_reference_conflict');return 'already_prepared'}
    await assertUnchanged()
    // wx refuses any preexisting stage, even equal bytes without our journal.
    await exclusive(temporary,plan.bytes)
    const stage=await snapshot(temporary)
    stored={schema:1,record,stageIdentity:stage.identity,targetSha256:sha(plan.bytes)}
    await exclusive(marker,JSON.stringify(stored)+'\n')
    pending=await snapshot(marker)
  }
  if(stored.schema!==1||stored.targetSha256!==sha(plan.bytes))fail('catalog_native_recovery_required')
  await checkpoint('native_catalog_prepared')
  await assertUnchanged()
  let targetStat
  try{targetStat=await fs.lstat(plan.file,{bigint:true})}catch(error){if(error.code!=='ENOENT')throw error}
  if(!targetStat) {
    const stage=await snapshot(temporary)
    if(!stage||stage.identity!==stored.stageIdentity||stage.bytes!==plan.bytes)fail('catalog_native_recovery_required')
    // Atomic CREATE, never overwrite/replace an existing ACL or user's bytes.
    // Unsupported hard-link publication fails; no rename/ACL fallback.
    try{await linkFile(temporary,plan.file)}catch(error){
      if(error.code==='EEXIST')fail('catalog_native_reference_conflict')
      if(['ENOTSUP','EOPNOTSUPP','EXDEV','ENOSYS'].includes(error.code))fail('catalog_native_atomic_publication_unavailable')
      if(['EPERM','EACCES'].includes(error.code))fail('catalog_native_publication_permission_denied')
      throw error
    }
  }
  await checkpoint('native_catalog_published')
  await assertUnchanged()
  let stageStat
  try{stageStat=await fs.lstat(temporary,{bigint:true})}catch(error){if(error.code!=='ENOENT')throw error}
  if(stageStat) {
    const stage=await snapshot(temporary,{links:2}),target=await snapshot(plan.file,{links:2})
    if(stage.identity!==stored.stageIdentity||target.identity!==stage.identity||stage.bytes!==plan.bytes||target.bytes!==plan.bytes)fail('catalog_native_recovery_required')
    await fs.unlink(temporary)
  }
  const target=await snapshot(plan.file)
  if(!target||target.identity!==stored.stageIdentity||target.bytes!==plan.bytes)fail('catalog_native_recovery_required')
  const receiptBytes=JSON.stringify({schema:1,record,targetIdentity:target.identity,targetSha256:sha(plan.bytes),processStarted:false})+'\n'
  const prior=await snapshot(receipt)
  if(prior){if(prior.bytes!==receiptBytes)fail('catalog_native_recovery_required')}
  else await exclusive(receipt,receiptBytes)
  await checkpoint('native_catalog_receipt_synced')
  await assertUnchanged()
  const finalMarker=await snapshot(marker)
  if(finalMarker?.bytes!==pending.bytes||finalMarker.identity!==pending.identity)fail('catalog_native_recovery_required')
  await fs.unlink(marker)
  return 'prepared_native_catalog'
}
