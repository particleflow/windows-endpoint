import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { productEntryProbe, parseEntryProbe } from './product-entry-probe.mjs'

test('probe only inserts stages into the exact launcher and retains its original checks and catch', async () => {
  const source = await fs.readFile(new URL('../WindowsEndpoint.ps1', import.meta.url))
  const probe = productEntryProbe(source)
  const lines = probe.split('\n')
  let cursor = 0
  for (const line of source.toString('utf8').split('\n')) {
    while (cursor < lines.length && lines[cursor] !== line) cursor++
    assert.ok(cursor < lines.length, 'original launcher line must remain in order')
    cursor++
  }
  assert.ok(probe.includes("$script:fixtureEntryStage = 'receipt.contract_or_hash'"))
  assert.ok(probe.includes("$script:fixtureEntryStage = 'hash.manifest'"))
  assert.ok(probe.includes("$script:fixtureEntryStage = 'payload.size_or_hash'"))
  assert.ok(probe.includes('Save-FixtureEntryProbe $_\n    $code ='))
  assert.ok(probe.indexOf("$script:fixtureEntryStage = 'node.exit'") > probe.indexOf('$result = $LASTEXITCODE'))
  assert.throws(() => productEntryProbe(Buffer.concat([source, Buffer.from('\n')])), /entry_probe_source_mismatch/)
  assert.deepEqual(await fs.readFile(new URL('../WindowsEndpoint.ps1', import.meta.url)), source)
})

test('probe output admits only bounded typed stage metadata and rejects message or path fields', () => {
  const row = {schema:1,stage:'hash.manifest',context:'package-manifest',exceptionType:'System.Management.Automation.CommandNotFoundException',innerType:'none',command:'Get-FileHash',contractCode:'other',nativeExitCode:-999}
  assert.deepEqual(parseEntryProbe(JSON.stringify(row)+'\n'), [row])
  for (const invalid of [{...row,message:'secret'}, {...row,stage:'C:/private'}, {...row,command:'private.exe'}, {...row,exceptionType:'message with spaces'}, {...row,nativeExitCode:null}]) {
    assert.throws(() => parseEntryProbe(JSON.stringify(invalid)))
  }
  assert.throws(() => parseEntryProbe((JSON.stringify(row)+'\n').repeat(9)))
  assert.throws(() => parseEntryProbe(' '.repeat(32769)))
})
