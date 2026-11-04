import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { prepareNativePiCatalog,programDeploymentMain,runSelectedProgram } from './program-deployment.mjs'
import { nativePiCatalogHostOptions,nativeCatalogReferenceName,prepareNativePiCatalogReference } from './pi-native-catalog-profile.mjs'
import { nativeCatalogPendingName,publishNativeCatalogReference } from './pi-native-catalog-transaction.mjs'
import { ForegroundHost } from './host.mjs'
import { acquireLeases } from './lifecycle.mjs'
import { nativeCatalogInstall } from './test-support/native-catalog-install.mjs'

async function unchanged(f){
  assert.equal(await fs.readFile(path.join(f.config.piConfigDir,'settings.json'),'utf8'),f.settingsRaw)
  assert.equal(await fs.readFile(path.join(f.config.piConfigDir,'models.json'),'utf8'),f.modelsRaw)
  assert.equal(await fs.readFile(path.join(f.root,'config/endpoint.json'),'utf8'),f.configurationRaw)
  assert.equal(await fs.readFile(path.join(f.config.piConfigDir,'auth.json'),'utf8'),'SYNTHETIC UNREAD PI CONFIG')
}
test('explicit normal CLI preparation publishes one new resource without replacing settings, ACL-bearing files or identity',async t=>{
  const f=await nativeCatalogInstall(t),requestId=randomUUID(),settings=path.join(f.config.piConfigDir,'settings.json')
  const before=await fs.stat(settings,{bigint:true})
  const args=['prepare-pi-catalog','--root',f.root,'--request-id',requestId,'--provider','approved']
  assert.equal((await programDeploymentMain(args)).state,'prepared_native_catalog')
  const after=await fs.stat(settings,{bigint:true})
  for(const key of ['ino','mode','mtimeNs','ctimeNs'])assert.equal(after[key],before[key])
  const file=path.join(f.config.piConfigDir,'extensions',nativeCatalogReferenceName),st=await fs.stat(file,{bigint:true})
  assert.equal(st.nlink,1n)
  const packageRoot=path.join(f.manager.layout.packages,f.pkg.hash)
  assert.equal((await nativePiCatalogHostOptions({config:f.config,packageRoot,manifest:f.pkg.manifest})).piCatalogMode,'native')
  assert.equal((await programDeploymentMain(args)).state,'already_prepared')
  assert.equal((await fs.stat(file,{bigint:true})).mtimeNs,st.mtimeNs)
  await unchanged(f)
})
test('an existing different reference is preserved and fails without staging or ACL fallback',async t=>{
  const f=await nativeCatalogInstall(t),directory=path.join(f.config.piConfigDir,'extensions')
  await fs.mkdir(directory);const file=path.join(directory,nativeCatalogReferenceName)
  await fs.writeFile(file,'USER REFERENCE: DO NOT REPLACE')
  await assert.rejects(prepareNativePiCatalog({root:f.root,requestId:randomUUID(),providerId:'approved'}),{code:'catalog_native_reference_conflict'})
  assert.equal(await fs.readFile(file,'utf8'),'USER REFERENCE: DO NOT REPLACE')
  assert.deepEqual(await fs.readdir(directory),[nativeCatalogReferenceName]);await unchanged(f)
})
for(const phase of ['native_catalog_prepared','native_catalog_published','native_catalog_receipt_synced'])test(`interruption at ${phase} blocks startup; only the same explicit request finishes its exact file`,async t=>{
  const f=await nativeCatalogInstall(t),request={root:f.root,requestId:randomUUID(),providerId:'approved'}
  await assert.rejects(prepareNativePiCatalog(request,{checkpoint:async at=>{if(at===phase)throw Error('synthetic interruption')}}),{code:'deployment_operation_failed'})
  assert.ok(await fs.stat(path.join(f.manager.lifecycleDirectory,nativeCatalogPendingName)))
  let starts=0
  await assert.rejects(runSelectedProgram(f.root,{createTestRuntime:async()=>{starts++;return{}}}),{code:'deployment_pi_catalog_recovery_required'})
  const direct=new ForegroundHost({root:f.root,createTestRuntime:async()=>{starts++;return{}}})
  await assert.rejects(direct.start(),{code:'host_pi_catalog_recovery_required'})
  assert.equal(starts,0)
  const nextProfile=path.join(f.base,'different-profile');await fs.mkdir(nextProfile)
  const profileArgs=['prepare-profile','--root',f.root,'--request-id',randomUUID(),'--profile',nextProfile,
    ...['configuration','lifecycle','continuation','attempts'].flatMap(name=>[`--${name}-sha256`,'0'.repeat(64)])]
  await assert.rejects(programDeploymentMain(profileArgs),{code:'deployment_pi_catalog_recovery_required'})
  assert.equal((await prepareNativePiCatalog(request)).state,'prepared_native_catalog')
  await assert.rejects(fs.stat(path.join(f.manager.lifecycleDirectory,nativeCatalogPendingName)),{code:'ENOENT'})
  await unchanged(f)
})
test('a concurrent settings edit is retained; pending preparation cannot silently adopt or restore it',async t=>{
  const f=await nativeCatalogInstall(t),request={root:f.root,requestId:randomUUID(),providerId:'approved'},file=path.join(f.config.piConfigDir,'settings.json')
  const edit=JSON.stringify({userEdit:'retain exactly'})
  await assert.rejects(prepareNativePiCatalog(request,{checkpoint:async at=>{if(at==='native_catalog_prepared')await fs.writeFile(file,edit)}}),{code:'catalog_native_preparation_changed'})
  await assert.rejects(prepareNativePiCatalog(request),{code:'catalog_native_recovery_required'})
  assert.equal(await fs.readFile(file,'utf8'),edit)
  await assert.rejects(runSelectedProgram(f.root),{code:'deployment_pi_catalog_recovery_required'})
})
test('live host lease and unknown original work block preparation without launching/replaying or touching the profile',async t=>{
  const f=await nativeCatalogInstall(t),request={root:f.root,requestId:randomUUID(),providerId:'approved'}
  const release=await acquireLeases([`host:${f.root}`],f.manager.lifecycleDirectory)
  try{assert.equal((await prepareNativePiCatalog(request)).reason,'endpoint_owned')}finally{await release()}
  const receipt=path.join(f.config.sourceRoot,'.memoh-computer/attempts/unknown/receipt.json'),raw='{"state":"unknown","prompt_submitted":false,"pi_session":"original"}'
  await fs.mkdir(path.dirname(receipt),{recursive:true});await fs.writeFile(receipt,raw)
  const result=await prepareNativePiCatalog(request)
  assert.equal(result.state,'deferred');assert.equal(result.reason,'task_handoff_unverified')
  assert.equal(await fs.readFile(receipt,'utf8'),raw)
  await assert.rejects(fs.stat(path.join(f.config.piConfigDir,'extensions')),{code:'ENOENT'});await unchanged(f)
})
test('the public foreground host explicitly rejects the retired file-sync injection before startup',()=>{
  assert.throws(()=>new ForegroundHost({root:'/unused',piCatalogBinding:{providerId:'approved',discover(){throw Error('must not call')}}}),{code:'host_pi_catalog_file_sync_retired'})
})
test('unsupported atomic publication leaves a blocking journal and never falls back to replacing user files',async t=>{
  const f=await nativeCatalogInstall(t),packageRoot=path.join(f.manager.layout.packages,f.pkg.hash)
  const plan=await prepareNativePiCatalogReference({profileDir:f.config.piConfigDir,packageRoot,manifest:f.pkg.manifest,settingsRaw:f.settingsRaw,modelsRaw:f.modelsRaw,providerId:'approved'})
  await assert.rejects(publishNativeCatalogReference({lifecycleDirectory:f.manager.lifecycleDirectory,plan,record:{requestId:randomUUID()},assertUnchanged:async()=>{},linkFile:async()=>{throw Object.assign(Error('synthetic unsupported primitive'),{code:'ENOTSUP'})}}),{code:'catalog_native_atomic_publication_unavailable'})
  await assert.rejects(fs.stat(plan.file),{code:'ENOENT'})
  assert.ok(await fs.stat(path.join(f.manager.lifecycleDirectory,nativeCatalogPendingName)))
  await assert.rejects(runSelectedProgram(f.root),{code:'deployment_pi_catalog_recovery_required'});await unchanged(f)
})
test('an existing extension-root entry or user disable filter is preserved and requires explicit review',async t=>{
  const f=await nativeCatalogInstall(t),directory=path.join(f.config.piConfigDir,'extensions')
  await fs.mkdir(directory);await fs.writeFile(path.join(directory,'index.js'),'// original user entry')
  await assert.rejects(prepareNativePiCatalog({root:f.root,requestId:randomUUID(),providerId:'approved'}),{code:'catalog_native_extension_root_requires_review'})
  assert.deepEqual(await fs.readdir(directory),['index.js']);await unchanged(f)
  await fs.rename(path.join(directory,'index.js'),path.join(directory,'index.saved')) // own fixture entry remains retained
  f.settingsRaw=JSON.stringify({extensions:['-extensions/*.js'],user:'keep filter'})
  await fs.writeFile(path.join(f.config.piConfigDir,'settings.json'),f.settingsRaw)
  await assert.rejects(prepareNativePiCatalog({root:f.root,requestId:randomUUID(),providerId:'approved'}),{code:'catalog_native_extension_filter_requires_review'})
  assert.deepEqual(await fs.readdir(directory),['index.saved']);await unchanged(f)
})
