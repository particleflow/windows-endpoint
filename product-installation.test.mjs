import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { installProduct, programDependencies, migrationPlan } from './product-installation.mjs'
import { inspectPrograms } from './installed.mjs'
import { installedProgramReferences } from './deployment.mjs'
import { setupEndpoint } from './setup.mjs'
import { acquireLeases } from './lifecycle.mjs'
import { nativeInstalledFixture } from './test-support/installed-fixture.mjs'
import { programPackage } from './test-support/program-package.mjs'
import { programPaths } from './endpoint.mjs'
import { digest } from './endpoint.mjs'
import { programDeployment } from './program-deployment.mjs'

async function fixture(t) {
  const f = await nativeInstalledFixture(t), root = path.join(f.base,'persistent product')
  const source = await programPackage(path.join(f.base,'extracted installer'),'installation',{native:true})
  const from = path.join(f.base,'references.json'); await fs.writeFile(from,JSON.stringify(f.config))
  const options = {from,root,source:source.directory,manifestSha256:source.hash,transfer:'disabled',review:true}
  const deps = {setup: options=>setupEndpoint(options,{doctor:async()=>({checks:[],ready:false})}),
    dependencies: config=>programDependencies(config,{inspect:c=>inspectPrograms(c,f.run)})}
  const originals = [from,f.config.connector.enrollmentFile,path.join(f.config.piConfigDir,'auth.json')]
  const before = await Promise.all(originals.map(p=>fs.readFile(p)))
  return {...f,root,source,from,options,deps,originals,before,entry:path.join(root,'control/WindowsEndpoint.ps1'),receipt:path.join(root,'control/installation.json')}
}

test('installation requires explicit review qualification before any product-root write',async t=>{
  const f=await fixture(t)
  await assert.rejects(installProduct({...f.options,review:false},f.deps),{code:'installation_release_qualification_pending'})
  await assert.rejects(fs.stat(f.root),{code:'ENOENT'})
})
test('one installation entry is repeatable, records verified existing programs and preserves original configuration and credentials',async t=>{
  const f=await fixture(t), first=await installProduct(f.options,f.deps)
  assert.equal(first.state,'installed_review_only');assert.equal(first.activation,'not_started')
  assert.equal(first.dependencies.components.length,5)
  assert.ok(first.dependencies.components.every(c=>c.state==='verified_existing_installation'&&c.installExecuted===false))
  assert.equal(await fs.readFile(f.entry,'utf8'),await fs.readFile(path.join(f.source.directory,'WindowsEndpoint.ps1'),'utf8'))
  assert.equal(JSON.parse(await fs.readFile(f.receipt)).phase,'complete')
  assert.equal((await installProduct(f.options,f.deps)).state,'installed_review_only')
  assert.deepEqual(await Promise.all(f.originals.map(p=>fs.readFile(p))),f.before)
})
for(const stage of ['entry_prepared','entry_published'])test(`interruption at ${stage} resumes only the recorded installer transaction`,async t=>{
  const f=await fixture(t)
  await assert.rejects(installProduct(f.options,{...f.deps,checkpoint:async point=>{if(point===stage)throw new Error('synthetic interruption')}}))
  assert.equal(JSON.parse(await fs.readFile(f.receipt)).phase,'prepared')
  assert.equal((await installProduct(f.options,f.deps)).state,'installed_review_only')
  assert.deepEqual(await Promise.all(f.originals.map(p=>fs.readFile(p))),f.before)
})
test('changed or unknown stable launchers are retained instead of adopted or overwritten',async t=>{
  const f=await fixture(t)
  await f.deps.setup(f.options)
  await fs.writeFile(f.entry,'UNKNOWN USER FILE')
  await assert.rejects(installProduct(f.options,f.deps),{code:'installation_unowned_entry_retained'})
  assert.equal(await fs.readFile(f.entry,'utf8'),'UNKNOWN USER FILE')
  await fs.rm(f.entry) // Only the file this synthetic test just created.
  await installProduct(f.options,f.deps)
  await fs.writeFile(f.entry,'CHANGED FILE')
  await assert.rejects(installProduct(f.options,f.deps),{code:'installation_entry_changed'})
  assert.equal(await fs.readFile(f.entry,'utf8'),'CHANGED FILE')
})
for(const code of ['EACCES','ENOSPC'])test(`installer ${code} does not erase component data or conceal incomplete publication`,async t=>{
  const f=await fixture(t)
  await assert.rejects(installProduct(f.options,{...f.deps,io:{...fs,rename:async()=>{throw Object.assign(new Error('synthetic'),{code})}}}),
    {code:code==='EACCES'?'deployment_storage_read_only':'deployment_space_unavailable'})
  await assert.rejects(fs.stat(f.entry),{code:'ENOENT'})
  assert.deepEqual(await Promise.all(f.originals.map(p=>fs.readFile(p))),f.before)
  assert.equal((await installProduct(f.options,f.deps)).state,'installed_review_only')
})
test('an active host defers installation without replacing its launcher or releasing its lease',async t=>{
  const f=await fixture(t);await installProduct(f.options,f.deps)
  const before=await fs.readFile(f.entry),release=await acquireLeases([`host:${f.root}`],path.join(f.root,'data/endpoint'))
  try {
    assert.equal((await installProduct(f.options,f.deps)).state,'deferred')
    assert.deepEqual(await fs.readFile(f.entry),before)
    await assert.rejects(acquireLeases([`host:${f.root}`],path.join(f.root,'data/endpoint')),{code:'endpoint_already_owned'})
  }finally{await release()}
})
test('setup deferral before a new root exists is returned without inventing an installation or reading a missing journal',async t=>{
  const f=await fixture(t),result=await installProduct(f.options,{...f.deps,setup:async()=>({state:'deferred',reason:'endpoint_owned'})})
  assert.equal(result.state,'deferred');assert.equal(result.reason,'endpoint_owned');assert.equal(result.entry,null)
  await assert.rejects(fs.stat(f.root),{code:'ENOENT'})
})
test('dependency inspection reuses protocol checks without reading profiles, enrollment or sessions',async t=>{
  const f=await fixture(t)
  await fs.rm(f.config.connector.enrollmentFile);await fs.rm(path.join(f.config.piConfigDir,'auth.json'))
  const result=await programDependencies(f.config,{inspect:c=>inspectPrograms(c,f.run)})
  assert.equal(result.state,'programs_verified');assert.equal(result.credentialsRead,false)
  f.versions.node='23.0.0'
  const old=await programDependencies(f.config,{inspect:c=>inspectPrograms(c,f.run)})
  assert.equal(old.error,'installation_version_too_old');assert.equal(old.state,'dependencies_unverified')
  assert.ok(old.components.every(c=>c.state!=='verified_existing_installation'))
})
test('missing dependencies report official assembly sources but never execute an installer',async t=>{
  const f=await fixture(t);await fs.rm(f.p.herdr)
  const result=await programDependencies(f.config,{inspect:c=>inspectPrograms(c,f.run)})
  const missing=result.components.find(c=>c.id==='herdr')
  assert.equal(missing.state,'missing');assert.equal(missing.source,'https://herdr.dev/docs/windows-beta/')
  assert.equal(result.installationExecuted,false)
})
test('only verified package program references relocate; migration planning never changes original roots or data',async t=>{
  const f=await fixture(t), original={...f.config,transfer:{pluginRoot:path.join(f.source.directory,'transfer'),nasOrigin:'https://nas.example.test/api'}}
  const target=path.join(f.root,'packages',f.source.hash), mapped=installedProgramReferences(original,f.source.directory,target)
  assert.equal(mapped.transfer.pluginRoot,path.join(target,'transfer'))
  for(const field of ['sourceRoot','piConfigDir','herdrConfigRoot','herdrStateRoot'])assert.equal(mapped[field],original[field])
  assert.deepEqual(mapped.connector,original.connector)
  const before=await fs.readFile(f.from),plan=await migrationPlan(f.from,f.root)
  assert.equal(plan.filesChanged,false);assert.equal(plan.credentialsRead,false)
  assert.deepEqual(await fs.readFile(f.from),before)
})
test('a changed source launcher after staging never becomes the stable installed entry',async t=>{
  const f=await fixture(t)
  await assert.rejects(installProduct(f.options,{...f.deps,setup:async options=>{
    const result=await f.deps.setup(options)
    await fs.appendFile(path.join(f.source.directory,'WindowsEndpoint.ps1'),'# SYNTHETIC CHANGE\n')
    return result
  }}),{code:'installation_source_changed'})
  await assert.rejects(fs.stat(f.entry),{code:'ENOENT'})
})
test('an installer receipt changed during publication is retained and cannot be overwritten as complete',async t=>{
  const f=await fixture(t),changed='{"synthetic":"external change retained"}\n'
  await assert.rejects(installProduct(f.options,{...f.deps,checkpoint:async stage=>{
    if(stage==='entry_published')await fs.writeFile(f.receipt,changed)
  }}),{code:'installation_entry_changed'})
  assert.equal(await fs.readFile(f.receipt,'utf8'),changed)
  assert.deepEqual(await Promise.all(f.originals.map(p=>fs.readFile(p))),f.before)
})
test('first setup persists the installed bundle reference and no longer depends on its extraction',async t=>{
  const f=await fixture(t)
  f.config.programs.connectorPackage=path.join(f.source.directory,'runtime-connector')
  await fs.writeFile(f.from,JSON.stringify(f.config))
  const result=await installProduct(f.options,{...f.deps,dependencies:config=>programDependencies(config,{inspect:c=>inspectPrograms(c,(file,args,env)=>{
    if(file===f.p.node&&args[0]===programPaths(c).connector)return args[1]==='version'?'0.22.0':'run --config --log'
    return f.run(file,args,env)
  })})})
  assert.equal(result.state,'installed_review_only')
  const saved=JSON.parse(await fs.readFile(path.join(f.root,'config/endpoint.json')))
  assert.equal(saved.programs.connectorPackage,path.join(f.root,'packages',f.source.hash,'runtime-connector'))
  assert.equal(saved.sourceRoot,f.config.sourceRoot)
  assert.deepEqual(saved.connector,f.config.connector)
  await fs.rm(f.source.directory,{recursive:true})
  assert.ok((await fs.stat(programPaths(saved).connector)).isFile())
})
test('installed stable entry refuses an unsupported old program reader without switching or changing its receipt',async t=>{
  const f=await fixture(t);await installProduct(f.options,f.deps)
  const old=await programPackage(path.join(f.base,'old reader'),'old',{native:true})
  delete old.manifest.stable_installation_entry
  await fs.writeFile(path.join(old.directory,'candidate.json'),JSON.stringify(old.manifest))
  const oldHash=await digest(path.join(old.directory,'candidate.json')),manager=await programDeployment(f.root)
  await manager.stage(old.directory,oldHash)
  const before=await fs.readFile(manager.file),receipt=await fs.readFile(f.receipt)
  for(const action of ['update','rollback'])await assert.rejects(manager.select(oldHash,action),{code:'deployment_stable_entry_unsupported'})
  assert.deepEqual(await fs.readFile(manager.file),before);assert.deepEqual(await fs.readFile(f.receipt),receipt)
})
