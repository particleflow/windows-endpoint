import test from 'node:test'
import assert from 'node:assert/strict'
import { projectMagpieCatalog, magpieCatalogBinding, resolvePiCatalogAuth } from './pi-magpie-catalog.mjs'
import { mergePiCatalog } from './pi-catalog-sync.mjs'
import { hostMain } from './host.mjs'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Sanitized values reported by the sole onsite reader for Magpie 1.1739.
// Wire fields follow modelObject's documented context/max-output/modalities
// contract; no catalog IDs or defaults live in production code.
const rows = [
  ['group/deepseek4.1flash',1048576,393216,['text','image']],
  ['siliconflow/Qwen/Qwen3.8-27B',262144,32768,['text','image']],
  ['codex/gpt-6.1-sol',500000,128000,['text','image']],
  ['codex/gpt-6-astra',272000,128000,['text','image']],
  ['codex/gpt-6.1-terra',500000,128000,['text','image']],
  ['cursor/grok-4.7@500k',500000,undefined,['text','image']],
  ...['opus','sonnet','haiku'].flatMap(name => [
    [`cursor/claude-${name}-5-5@300k`,300000,undefined,['text','image']],
    [`cursor/claude-${name}-5-5@1m`,1000000,undefined,['text','image']],
  ]),
  ['zcode/GLM-5.3',1000000,128000,['text']],
  ['zcode/GLM-5.3-Flash',1000000,128000,['text','image']],
].map(([id,context,max,input]) => ({ id, context_window:context, context_length:context, ...(max === undefined ? {} : {max_output_tokens:max}), reasoning:true, modalities:{input} }))

test('observed 14-row metadata projects seven complete models and defers seven unknown outputs', () => {
  const result = projectMagpieCatalog({data: rows})
  assert.equal(rows.length,14); assert.equal(result.models.length,7); assert.equal(result.gaps.length,7)
  assert.ok(result.gaps.every(g => g.fields.join() === 'max_output_tokens'))
  assert.equal(result.models.find(m => m.id === rows[0].id).maxTokens,393216)
  const original = {providers:{approved:{models:[{id:rows[5].id,maxTokens:77,user:'preserve'}]}}}
  const next = mergePiCatalog(original,'approved',result.models)
  assert.deepEqual(next.providers.approved.models[0],original.providers.approved.models[0])
  assert.equal(next.providers.approved.models.length,8)
})
test('ambiguous, incomplete or paged metadata never supplies guessed capabilities', () => {
  const base = rows[0]
  assert.equal(projectMagpieCatalog({data:[{...base,context_length:1}]}).models.length,0)
  assert.equal(projectMagpieCatalog({data:[{...base,reasoning:undefined}]}).models.length,0)
  assert.equal(projectMagpieCatalog({data:[{...base,modalities:undefined}]}).models.length,0)
  assert.throws(() => projectMagpieCatalog({data:[base,base]}))
  assert.throws(() => projectMagpieCatalog({data:[],has_more:true}))
})
test('native auth reads only the selected existing path without a mutable credential store', async () => {
  const config = {piConfigDir:'/existing/profile'}, provider = {apiKey:'$ORIGINAL_REFERENCE'}
  let reads=0
  const headers = await resolvePiCatalogAuth({config,providerId:'approved',provider,loadSDK:async () => ({readStoredCredential(id,file) {
    reads++; assert.equal(id,'approved'); assert.ok(file.endsWith('auth.json'))
    return {type:'api_key',key:'synthetic-runtime-key'}
  }})})
  assert.equal(headers.Authorization,'Bearer synthetic-runtime-key'); assert.equal(reads,1)
  const none = async () => ({readStoredCredential:() => undefined})
  assert.equal((await resolvePiCatalogAuth({config,providerId:'approved',provider,env:{ORIGINAL_REFERENCE:'synthetic-env-key'},loadSDK:none})).Authorization,'Bearer synthetic-env-key')
  await assert.rejects(resolvePiCatalogAuth({config,providerId:'approved',provider:{apiKey:'!never-execute'},loadSDK:none}))
  await assert.rejects(resolvePiCatalogAuth({config,providerId:'approved',provider,loadSDK:async () => ({readStoredCredential:() => ({type:'oauth',access:'unused'})})}))
})
test('production binding uses exactly one bounded GET with runtime auth and records deferred fields', async () => {
  let calls=0
  const config={piConfigDir:'/existing/profile'}
  const binding=magpieCatalogBinding('approved',{resolveAuth:async args => {assert.equal(args.config,config); return {Authorization:'Bearer synthetic'}},fetchCatalog:async (url,options) => {
    calls++; assert.equal(url.href,'https://approved.example/prefix/v1/models'); assert.equal(options.method,'GET'); assert.equal(options.redirect,'error')
    assert.equal(options.headers.Authorization,'Bearer synthetic')
    return new Response(JSON.stringify({data:rows}))
  }})(config)
  const models=await binding.discover({provider:{api:'openai-completions',baseUrl:'https://approved.example/prefix/v1'},signal:new AbortController().signal})
  assert.equal(models.length,7); assert.equal(binding.discover.gaps.length,7); assert.equal(calls,1)
})
test('CLI rejects provider flags on observer status and malformed enablement', async () => {
  await assert.rejects(hostMain(['status','--root','/unused','--pi-catalog-provider','approved']),{code:'host_arguments_invalid'})
  await assert.rejects(hostMain(['run','--root','/unused','--pi-catalog-provider','../wrong']),{code:'host_arguments_invalid'})
})
test('CLI accepts explicit enablement without inventing a runtime or profile', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'pi-cli-')))
  t.after(() => fs.rm(root,{recursive:true,force:true}))
  const result = spawnSync(process.execPath,[fileURLToPath(new URL('./endpoint.mjs',import.meta.url)),'host','run','--root',root,'--pi-catalog-provider','approved'],{input:'',encoding:'utf8',timeout:10000})
  assert.equal(result.status,0)
  assert.equal(result.stderr,'')
  assert.equal((await fs.readdir(root)).includes('pi'),false)
  assert.equal(result.stdout.includes('host_arguments_invalid'),false)
})
