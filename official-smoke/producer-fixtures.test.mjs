import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { catalog, digest } from '../endpoint.mjs'
import { testNames, fixturePlan, completedTests, completedAPIBaseCases, verifyProducerBundle } from './producer-fixtures.mjs'

const native = ['TestWindowsNativeActiveJournal', 'TestWindowsNativePublicationBucketBudget', 'TestWindowsNativePublicationMigrationProcessCrash', 'TestWindowsNativePublicationNewCase', 'TestWindowsNativeNewCore']
const cli = ['TestCLIPathChild', 'TestCLIPathTLSRestartAndLostResponses']
const output = names => names.map(n => `=== RUN   ${n}\n--- PASS: ${n} (0.01s)`).join('\n') + '\nPASS\n'

test('binary inventory partitions exactly once and selects every original subtest', () => {
  const groups = fixturePlan(native, cli)
  assert.deepEqual(groups.flatMap(g => g.tests).sort(), [...native, ...cli].sort())
  for (const name of [...native, ...cli]) assert.equal(groups.filter(g => new RegExp(g.pattern).test(name)).length, 1)
  assert.ok(groups.every(g => !g.pattern.includes('/') && g.timeout === '5m'))
  assert.deepEqual(testNames(native.join('\r\n') + '\r\n', 'TestWindowsNative'), native)
})
test('empty, duplicate, malformed or unexpected test inventory cannot authorize a partial plan', () => {
  for (const raw of ['', native[0] + '\n' + native[0], 'PASS', 'TestWindowsNativeX|.*', 'TestUnrelated']) assert.throws(() => testNames(raw, 'TestWindowsNative'))
  assert.throws(() => fixturePlan(native.filter(n => !n.endsWith('BucketBudget')), cli))
})
test('coverage rejects zero tests, omissions, duplicates, unexpected passes and skipped subtests', () => {
  assert.deepEqual(completedTests(output(cli), cli), cli)
  for (const raw of ['PASS\n', output(cli.slice(0, 1)), output([...cli, cli[0]]), output([...cli, 'TestCLIPathUnexpected']), output(cli) + '    --- SKIP: TestCLIPathChild/nested (0.00s)\n', output(cli).replace('PASS\n', 'FAIL\n')]) assert.throws(() => completedTests(raw, cli))
})
test('packaged API base contract requires every shared case and rejects skipped or partial coverage', () => {
  const names = ['https-root', 'https-api-prefix', 'empty-port']
  const log = selected => selected.map(n => `    --- PASS: TestAPIBaseContractVectors/${n} (0.00s)`).join('\n') + '\n' + output(['TestAPIBaseContractVectors'])
  assert.deepEqual(completedAPIBaseCases(log(names), names), names)
  for (const raw of ['PASS\n', log([]), log(names.slice(1)), log([...names, names[0]]), log([...names, 'unexpected']), log(names).replace('PASS: TestAPIBaseContractVectors/empty-port', 'SKIP: TestAPIBaseContractVectors/empty-port')]) assert.throws(() => completedAPIBaseCases(raw, names))
})
test('source-built fixture inventory rejects wrong source and modified payload before execution', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'producer-fixture-inventory-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const names = ['transferqueue.exe', 'transferqueue.test.exe', 'transferqueue-cli.test.exe', 'herdr-plugin.toml', 'verify-fixtures.ps1', 'README.md', 'transfer.example.json']
  const manifest = { source_commit: catalog.components.transfer.revision, arch: 'amd64', files: [] }
  for (const name of names) { await fs.writeFile(path.join(root, name), 'INERT TEST BYTES; NEVER EXECUTE'); manifest.files.push({ name, sha256: await digest(path.join(root, name)) }) }
  const file = path.join(root, 'SHA256SUMS.json')
  await fs.writeFile(file, JSON.stringify(manifest))
  assert.equal(await verifyProducerBundle(root), catalog.components.transfer.revision)
  await fs.writeFile(file, JSON.stringify({ ...manifest, source_commit: '0'.repeat(40) }))
  await assert.rejects(verifyProducerBundle(root), /provenance_mismatch/)
  await fs.writeFile(file, JSON.stringify(manifest)); await fs.appendFile(path.join(root, names[0]), 'tampered')
  await assert.rejects(verifyProducerBundle(root), /checksum_mismatch/)
})
