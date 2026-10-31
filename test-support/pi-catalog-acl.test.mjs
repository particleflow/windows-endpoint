import test from 'node:test'
import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {assertCatalogAclPreserved,aclChildProcessOptions} from './pi-catalog-acl.mjs'

test('ACL child module path isolation survives mixed casing and leaves the parent unchanged', async () => {
  const inherited = { PSModulePath: 'synthetic-pwsh7', psmodulepath: 'synthetic-other-modules', TEMP:'synthetic-temp', TMP:'synthetic-tmp', SystemRoot: process.env.SystemRoot ?? 'C:\\Windows' }
  const saved = { ...inherited }, parent = process.env.PSModulePath
  const options = aclChildProcessOptions('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', inherited)
  assert.equal(Object.keys(options.env).filter(key => key.toLowerCase() === 'psmodulepath').length, 1)
  const result = await promisify(execFile)(process.execPath, ['-e', 'process.stdout.write(JSON.stringify({modules:process.env.PSModulePath,temp:process.env.TEMP,tmp:process.env.TMP}))'], options)
  assert.deepEqual(JSON.parse(result.stdout), {modules:'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules', temp:inherited.TEMP, tmp:inherited.TMP})
  assert.deepEqual(inherited, saved)
  assert.equal(process.env.PSModulePath, parent)
})
test('ACL comparison allows only appended identical inherited ACEs, never expanded rights', () => {
  const allow = { inherited: false, binary: 'synthetic-allow-user-full' }, deny = { inherited: false, binary: 'synthetic-deny-other-write' }
  const before = {owner:'owner',group:'group',protected:false,nullDacl:false,aces:[deny,allow]}
  assertCatalogAclPreserved(before, {...before,aces:[deny,allow,{...allow,inherited:true}]})
  for (const change of [
    {owner:'other'}, {group:'other'}, {protected:true}, {nullDacl:true},
    {aces:[allow,deny]}, {aces:[deny]},
    {aces:[deny,allow,{inherited:true,binary:'new-subject-or-mask'}]},
    {aces:[deny,allow,allow]}, {aces:[{...allow,inherited:true},deny,allow]},
  ]) assert.throws(() => assertCatalogAclPreserved(before, {...before,...change}))
  assert.throws(() => assertCatalogAclPreserved({...before,protected:true},before))
  assert.throws(() => assertCatalogAclPreserved({...before,aces:[{...allow,inherited:true}]},{...before,aces:[allow]}))
})
