import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { nativeCatalogResources, nativeCatalogPackage, nativeCatalogSettingsKey,
  prepareNativePiCatalogProfile, nativePiCatalogHostOptions } from './pi-native-catalog-profile.mjs'
import { PiCatalogLifecycle } from './pi-catalog-lifecycle.mjs'

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'pi-native-wiring-')))
  t.after(()=>fs.rm(root,{recursive:true,force:true}))
  const profileDir=path.join(root,'existing profile'),packageRoot=path.join(root,'selected package 空格')
  await fs.mkdir(profileDir);await fs.mkdir(packageRoot)
  const files=[]
  for(const name of nativeCatalogResources) {
    const data=await fs.readFile(fileURLToPath(new URL(name,import.meta.url)))
    await fs.writeFile(path.join(packageRoot,name),data)
    files.push({path:name,size:data.length,sha256:createHash('sha256').update(data).digest('hex')})
  }
  const manifest={native_pi_catalog:nativeCatalogPackage,files}
  const settings={defaultProvider:'approved',defaultModel:'keep-selected',packages:['npm:@tintinweb/pi-subagents@0.22.0'],extensions:['./user-extension.ts'],user:{keep:true}}
  const settingsRaw='\uFEFF'+JSON.stringify(settings,null,3)+'\n'
  const modelsRaw=JSON.stringify({providers:{approved:{models:[{id:'keep-selected',custom:true}],modelOverrides:{'keep-selected':{maxTokens:333}}}}})
  await fs.writeFile(path.join(profileDir,'settings.json'),settingsRaw)
  await fs.writeFile(path.join(profileDir,'models.json'),modelsRaw)
  return {profileDir,packageRoot,manifest,settingsRaw,settings,modelsRaw,providerId:'approved'}
}
test('profile preparation is read-only, preserves user resources/selection, and returns an idempotent native reference',async t=>{
  const f=await fixture(t),plan=await prepareNativePiCatalogProfile(f)
  assert.equal(plan.requiresStoppedHost,true);assert.equal(plan.piCatalogBinding,null)
  assert.equal(await fs.readFile(plan.settingsPath,'utf8'),f.settingsRaw)
  const next=JSON.parse(plan.settingsAfter)
  assert.deepEqual({...next,extensions:f.settings.extensions,[nativeCatalogSettingsKey]:undefined},{...f.settings,[nativeCatalogSettingsKey]:undefined})
  assert.deepEqual(next.extensions,[...f.settings.extensions,plan.resource])
  assert.equal((await prepareNativePiCatalogProfile({...f,settingsRaw:plan.settingsAfter})).settingsAfter,plan.settingsAfter)
  await fs.writeFile(plan.settingsPath,plan.settingsAfter) // isolated fixture only
  assert.deepEqual(await nativePiCatalogHostOptions({config:{piConfigDir:f.profileDir},...f,requestedProviderId:'approved'}),{piCatalogBinding:null,piCatalogMode:'native',piCatalogProviderId:'approved'})
  assert.equal(await fs.readFile(path.join(f.profileDir,'models.json'),'utf8'),f.modelsRaw)
  await assert.rejects(nativePiCatalogHostOptions({config:{piConfigDir:f.profileDir},...f,requestedProviderId:'different'}),/provider_conflict/)
})
test('unprepared old profile stays compatible; opt-in and changed package fail with fixed diagnostics',async t=>{
  const f=await fixture(t)
  assert.deepEqual(await nativePiCatalogHostOptions({config:{piConfigDir:f.profileDir},...f}),{piCatalogBinding:null,piCatalogMode:'disabled'})
  await assert.rejects(nativePiCatalogHostOptions({config:{piConfigDir:f.profileDir},...f,requestedProviderId:'approved'}),/profile_not_prepared/)
  await fs.appendFile(path.join(f.packageRoot,nativeCatalogPackage.entry),'\n// changed\n')
  await assert.rejects(prepareNativePiCatalogProfile(f),/resource_changed/)
  assert.equal(await fs.readFile(path.join(f.profileDir,'settings.json'),'utf8'),f.settingsRaw)
})
test('native profile claim stops the legacy file writer before discovery or file reads',async t=>{
  const f=await fixture(t),plan=await prepareNativePiCatalogProfile(f)
  await fs.writeFile(plan.settingsPath,plan.settingsAfter)
  let reads=0,gets=0,writes=0
  const lifecycle=new PiCatalogLifecycle({config:{piConfigDir:f.profileDir},providerId:'approved',
    discover:async()=>{gets++;return[]},store:{read:async()=>{reads++;return f.modelsRaw},compareAndSwap:async()=>{writes++;return true}}})
  assert.equal(await lifecycle.tick(),'conflict');assert.equal(await lifecycle.tick(),'conflict')
  assert.deepEqual({reads,gets,writes},{reads:0,gets:0,writes:0})
  assert.equal(lifecycle.controller.signal.aborted,true)
})
