import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { catalog, digest } from '../endpoint.mjs'
import { testNames, fixturePlan, completedTests, completedAPIBaseCases, completedTaskAPIBaseCases, completedFeedbackCases, feedbackTests, networkTests, downloadTests, cliDownloadTests, publicationMigrationTests, budgetTests, cliBudgetTests, registrationTests, cliRegistrationTests, explicitFilenameTests, resultRecoveryTests, cliResultRecoveryTests, verifyProducerBundle } from './producer-fixtures.mjs'

const native = ['TestWindowsNativeActiveJournal', 'TestWindowsNativePublicationBucketBudget', 'TestWindowsNativePublicationMigrationProcessCrash', 'TestWindowsNativePublicationNewCase', 'TestWindowsNativeNewCore']
const cli = ['TestCLIPathChild', 'TestCLIPathTLSRestartAndLostResponses']
const output = names => names.map(n => `=== RUN   ${n}\n--- PASS: ${n} (0.01s)`).join('\n') + '\nPASS\n'

test('0813 recovery coverage requires the finite CLI and portable original-ID cases without skipped branches', () => {
  assert.equal(resultRecoveryTests.length,2);assert.equal(cliResultRecoveryTests.length,1)
  for(const names of [resultRecoveryTests,cliResultRecoveryTests]){
    assert.deepEqual(completedTests(output(names),names),names)
    for(const raw of ['PASS\n',output(names.slice(1)),output(names).replace('--- PASS:','--- SKIP:')])assert.throws(()=>completedTests(raw,names))
  }
})

test('explicit filename Windows coverage requires process recovery and foreign-context refusal without skipped cases', () => {
  assert.deepEqual(explicitFilenameTests, ['TestExplicitFilenameRegistrationProcessRecovery', 'TestExplicitFilenameRejectsForeignContext'])
  assert.deepEqual(completedTests(output(explicitFilenameTests), explicitFilenameTests), explicitFilenameTests)
  for (const raw of ['PASS\n', output(explicitFilenameTests.slice(1)), output(explicitFilenameTests).replace('--- PASS:', '--- SKIP:'), output([...explicitFilenameTests, 'TestExplicitUnexpected'])]) {
    assert.throws(() => completedTests(raw, explicitFilenameTests))
  }
})

test('native network configuration coverage requires the three shared tests, without claiming Linux-only routing', () => {
  assert.equal(networkTests.length, 3)
  assert.deepEqual(completedTests(output(networkTests), networkTests), networkTests)
  assert.throws(() => completedTests(output(networkTests.slice(1)), networkTests))
  assert.throws(() => completedTests(output(networkTests).replace('--- PASS:', '--- SKIP:'), networkTests))
  assert.ok(networkTests.every(name => name.startsWith('TestHostNetwork')))
})

test('default download and old publication recovery require the fixed producer cases without skips', () => {
  assert.equal(downloadTests.length, 3); assert.equal(cliDownloadTests.length, 1); assert.equal(publicationMigrationTests.length, 1)
  for (const names of [downloadTests, cliDownloadTests, publicationMigrationTests]) {
    assert.deepEqual(completedTests(output(names), names), names)
    assert.throws(() => completedTests(output(names.slice(1)), names))
    assert.throws(() => completedTests(output(names).replace('--- PASS:', '--- SKIP:'), names))
  }
})

test('feedback coverage requires six applicability cases and the actual Windows inbound restart test', () => {
  const names = ['download-no-context', 'download-foreign-context', 'upload-v1', 'upload-missing-context', 'upload-foreign-context', 'upload-write-failure']
  const log = selected => selected.map(name => `    --- PASS: TestCLIPathFeedbackApplicability/${name} (0.01s)`).join('\n') + '\n' + output(feedbackTests)
  assert.deepEqual(completedFeedbackCases(log(names)), names)
  for (const value of [log(names.slice(1)), log([...names, names[0]]), log(names).replace('--- PASS:', '--- SKIP:'), log(names).replace('--- PASS: TestCLIPathInboundFeedbackRestart', '--- SKIP: TestCLIPathInboundFeedbackRestart')]) {
    assert.throws(() => completedFeedbackCases(value))
  }
})

test('budget coverage requires all five library tests and the actual CLI dispatcher test', () => {
  assert.equal(budgetTests.length, 5); assert.equal(cliBudgetTests.length, 1)
  for (const names of [budgetTests, cliBudgetTests]) {
    assert.deepEqual(completedTests(output(names), names), names)
    assert.throws(() => completedTests(output(names.slice(1)), names))
    assert.throws(() => completedTests(output(names).replace('--- PASS:', '--- SKIP:'), names))
  }
})

test('registration coverage includes process interruption, source changes, receipt resume and actual finite CLI indexing', () => {
  assert.equal(registrationTests.length, 4); assert.equal(cliRegistrationTests.length, 1)
  for (const names of [registrationTests, cliRegistrationTests]) {
    assert.deepEqual(completedTests(output(names), names), names)
    assert.throws(() => completedTests(output(names.slice(1)), names))
    assert.throws(() => completedTests(output(names).replace('--- PASS:', '--- SKIP:'), names))
  }
  assert.ok(!registrationTests.some(name => name.includes('TenThousand')), 'Linux-only scale evidence must not be claimed as Windows execution')
})

test('binary inventory partitions exactly once and selects every original subtest', () => {
  const groups = fixturePlan(native, cli)
  assert.deepEqual(groups.flatMap(g => g.tests).sort(), [...native, ...cli].sort())
  for (const name of [...native, ...cli]) assert.equal(groups.filter(g => new RegExp(g.pattern).test(name)).length, 1)
  assert.ok(groups.every(g => !g.pattern.includes('/') && g.timeout === '5m'))
  assert.deepEqual(groups.find(g => g.name === 'native-active-journal').tests, ['TestWindowsNativeActiveJournal'])
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
test('new task API boundaries require both actual top-level tests and all 13 distinct cases', () => {
  const parents = ['TestTaskAPIBaseLengthBoundary', 'TestTaskAPIBaseBoundaryPreservesChecks']
  const names = [
    ...[2047, 2048, 2049].flatMap(n => ['false', 'true'].map(slash => `${parents[0]}/bytes-${n}/trailing-${slash}`)),
    ...['query-at-limit', 'operation-path', 'delivery-path', 'operation-too-long', 'delivery-too-long', 'missing-auth', 'insecure-transport'].map(n => `${parents[1]}/${n}`),
  ]
  const log = selected => selected.map(n => `    --- PASS: ${n} (0.00s)`).join('\n') + '\n' + output(parents)
  assert.equal(names.length, 13)
  assert.deepEqual(completedTaskAPIBaseCases(log(names)), names)
  const inventory = ['TestAPIBaseContractVectors', ...parents]
  assert.deepEqual(testNames(inventory.join('\n'), 'Test(Task)?APIBase'), inventory)
  for (const raw of [output(['TestAPIBaseContractVectors']), 'PASS\n', log([]), log(names.slice(1)), log([...names, names[0]]), log([...names, `${parents[1]}/unexpected`]), log(names).replace(`PASS: ${names[0]}`, `SKIP: ${names[0]}`), log(names).replace(`--- PASS: ${parents[1]} (0.01s)\n`, '')]) assert.throws(() => completedTaskAPIBaseCases(raw))
})
test('shared vector checkout stays byte-identical under a Windows CRLF Git profile', async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'producer-vector-checkout-')))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  // Command-local settings and a disposable index only; never change the real
  // index, user Git settings, producer fixture, or any bound runtime config.
  const options = { cwd: new URL('../', import.meta.url), env: { ...process.env, GIT_INDEX_FILE: path.join(root, 'index') }, encoding: 'utf8', timeout: 10000 }
  const indexed = spawnSync('git', ['read-tree', 'HEAD'], options)
  assert.equal(indexed.status, 0, 'temporary fixture index')
  const prefix = `${path.join(root, 'checkout').replaceAll('\\', '/')}/`
  const checked = spawnSync('git', ['-c', 'core.autocrlf=true', 'checkout-index', `--prefix=${prefix}`, '--', 'test-support/api-base-v1.json'], options)
  assert.equal(checked.status, 0, 'isolated Windows-profile checkout')
  const actual = await fs.readFile(path.join(root, 'checkout/test-support/api-base-v1.json'))
  assert.equal(actual.includes(13), false, 'vector checkout must retain upstream LF bytes')
  assert.deepEqual(actual, await fs.readFile(new URL('../test-support/api-base-v1.json', import.meta.url)))
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
