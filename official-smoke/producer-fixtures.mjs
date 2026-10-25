// CI-only scheduling of unchanged, source-built producer tests. This is not a
// transfer implementation, installer, test replacement or production entry.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { catalog, digest, validateDirectory } from '../endpoint.mjs'

const payloads = ['transferqueue.exe', 'transferqueue.test.exe', 'transferqueue-cli.test.exe', 'herdr-plugin.toml', 'verify-fixtures.ps1', 'README.md', 'transfer.example.json']
const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && [...a].sort().join('\n') === [...b].sort().join('\n')
const requireFixture = (ok, code) => { if (!ok) throw new Error(code) }

export function testNames(output, prefix) {
  const names = output.trim().split(/\r?\n/)
  requireFixture(names.length > 0 && names.length <= 256 && names.every(n => new RegExp(`^${prefix}[A-Za-z0-9_]*$`).test(n)) && new Set(names).size === names.length, 'producer_fixture_inventory_invalid')
  return names
}

export function fixturePlan(native, cli) {
  testNames(native.join('\n'), 'TestWindowsNative'); testNames(cli.join('\n'), 'TestCLIPath')
  const bucket = 'TestWindowsNativePublicationBucketBudget', journal = 'TestWindowsNativeActiveJournal'
  const groups = [
    { name: 'native-core', binary: 'transferqueue.test.exe', tests: native.filter(n => !n.startsWith('TestWindowsNativePublication') && n !== journal) },
    { name: 'native-active-journal', binary: 'transferqueue.test.exe', tests: native.filter(n => n === journal) },
    { name: 'native-bucket-budget', binary: 'transferqueue.test.exe', tests: native.filter(n => n === bucket) },
    { name: 'native-publication', binary: 'transferqueue.test.exe', tests: native.filter(n => n.startsWith('TestWindowsNativePublication') && n !== bucket) },
    { name: 'cli-path', binary: 'transferqueue-cli.test.exe', tests: [...cli] },
  ]
  requireFixture(groups.every(g => g.tests.length > 0) && sameSet(groups.filter(g => g.binary === 'transferqueue.test.exe').flatMap(g => g.tests), native) && sameSet(groups.at(-1).tests, cli), 'producer_fixture_partition_incomplete')
  return groups.map(g => ({ ...g, timeout: '5m', pattern: `^(${g.tests.join('|')})$` }))
}

export function completedTests(output, expected) {
  // Exact top-level membership, plus all original subtests (no slash filter).
  // Exit 0 alone cannot conceal a misspelled regex, zero tests or a skipped case.
  const passed = [...output.matchAll(/^--- PASS: (\w+) \([\d.]+s\)\r?$/gm)].map(m => m[1])
  requireFixture(/^PASS\r?$/m.test(output) && !/^\s*--- (?:FAIL|SKIP):/m.test(output) && sameSet(passed, expected), 'producer_fixture_coverage_incomplete')
  return passed
}

export function completedAPIBaseCases(output, expected) {
  completedTests(output, ['TestAPIBaseContractVectors'])
  const passed = [...output.matchAll(/^\s+--- PASS: TestAPIBaseContractVectors\/([A-Za-z0-9_-]+) \([\d.]+s\)\r?$/gm)].map(m => m[1])
  requireFixture(expected.length > 0 && sameSet(passed, expected), 'producer_api_base_coverage_incomplete')
  return passed
}

const taskAPIBaseTests = ['TestTaskAPIBaseLengthBoundary', 'TestTaskAPIBaseBoundaryPreservesChecks']
export const networkTests = ['TestHostNetworkPolicyKeepsOriginalQueueBinding', 'TestHostNetworkPolicyValidation', 'TestHostNetworkPolicyRejectsProxyConflict']
export const downloadTests = ['TestDownloadMetadataDoesNotReservePayloadOrBacklog', 'TestDownloadDiskPressureRetainsCheckpointAndWorkerBound', 'TestDownloadDiskPressureKeepsUnknownAssociation']
export const cliDownloadTests = ['TestCLIDefaultDownloadDoesNotCapSourceSize']
export const publicationMigrationTests = ['TestPublicationMetadataMigrationPreservesCompleteHistory']
export const budgetTests = ['TestHostBudgetConfiguration', 'TestBudgetMigrationPreservesIdentityAndUnknown', 'TestBudgetMigrationRejectsBusyMismatchAndCapacity', 'TestBudgetMigrationResumesIncompleteAdmission', 'TestBudgetMigrationProcessCrashAndTornTail']
export const cliBudgetTests = ['TestCLIBudgetConfigurationAndOldQueueRecovery']
export const registrationTests = ['TestRegisteredProcessExitBeforeAcknowledgement', 'TestRegisteredSourceRestartAndMissingChanges', 'TestRegisteredSourceResumesReceiptWithoutSnapshot', 'TestRegisteredSourceBlockProofRejectsUndetectedChange']
export const cliRegistrationTests = ['TestProducerAdmissionPendingCanResumeSameDelivery']
export function completedTaskAPIBaseCases(output) {
  completedTests(output, taskAPIBaseTests)
  const expected = [
    ...[2047, 2048, 2049].flatMap(length => [false, true].map(trailing => `${taskAPIBaseTests[0]}/bytes-${length}/trailing-${trailing}`)),
    ...['query-at-limit', 'operation-path', 'delivery-path', 'operation-too-long', 'delivery-too-long', 'missing-auth', 'insecure-transport'].map(name => `${taskAPIBaseTests[1]}/${name}`),
  ]
  const passed = [...output.matchAll(/^[ \t]+--- PASS: (TestTaskAPIBase[A-Za-z0-9_]+\/[A-Za-z0-9_/-]+) \([\d.]+s\)\r?$/gm)].map(m => m[1])
  requireFixture(sameSet(passed, expected), 'producer_task_api_base_coverage_incomplete')
  return passed
}

export async function verifyProducerBundle(root) {
  await validateDirectory(root)
  requireFixture(sameSet(await fs.readdir(root), [...payloads, 'SHA256SUMS.json']), 'producer_fixture_bundle_inventory_invalid')
  for (const name of [...payloads, 'SHA256SUMS.json']) {
    const st = await fs.lstat(path.join(root, name))
    requireFixture(st.isFile() && !st.isSymbolicLink() && st.nlink === 1, 'producer_fixture_bundle_file_unsafe')
  }
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'SHA256SUMS.json'), 'utf8'))
  requireFixture(manifest.source_commit === catalog.components.transfer.revision && manifest.arch === 'amd64' && Array.isArray(manifest.files) && sameSet(manifest.files.map(f => f.name), payloads), 'producer_fixture_provenance_mismatch')
  for (const file of manifest.files) requireFixture(/^[a-f0-9]{64}$/.test(file.sha256) && await digest(path.join(root, file.name)) === file.sha256, 'producer_fixture_checksum_mismatch')
  return manifest.source_commit
}

async function execute(file, args, timeoutMs, stream = false, cwd) {
  requireFixture(timeoutMs > 0, 'producer_fixture_suite_deadline')
  const child = spawn(file, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = '', bytes = 0, failure = null
  const terminate = reason => { failure ||= reason; child.kill() }
  const timer = setTimeout(() => terminate('producer_fixture_wall_timeout'), timeoutMs)
  const receive = (chunk, out) => {
    bytes += chunk.length
    if (bytes > 1024 ** 2) { terminate('producer_fixture_output_limit'); return }
    if (out) stdout += chunk.toString('utf8')
    if (stream) (out ? process.stdout : process.stderr).write(chunk)
  }
  child.stdout.on('data', chunk => receive(chunk, true))
  child.stderr.on('data', chunk => receive(chunk, false))
  try {
    const status = await new Promise(resolve => {
      child.once('error', () => { failure ||= 'producer_fixture_spawn_failed' })
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    if (failure || status.code !== 0 || status.signal !== null) throw Object.assign(new Error(failure || 'producer_fixture_process_failed'), { exitCode: status.code, signal: status.signal })
    return stdout
  } finally { clearTimeout(timer) }
}

export async function verifyFixtures(root, sourceRoot) {
  requireFixture(process.platform === 'win32', 'producer_fixture_windows_required')
  const deadline = Date.now() + 12 * 60 * 1000
  const remaining = limit => Math.min(limit, deadline - Date.now())
  const sourceCommit = await verifyProducerBundle(root)
  // The unchanged upstream packager does not ship testdata. Execute its actual
  // compiled contract test from the fixed source's package directory instead;
  // never add fixture data to the runtime bundle or patch the producer test.
  const contractDirectory = path.join(sourceRoot, 'internal/transferclient')
  await validateDirectory(contractDirectory)
  const expectedRaw = await fs.readFile(new URL('../test-support/api-base-v1.json', import.meta.url))
  const sourceRaw = await fs.readFile(path.join(contractDirectory, 'testdata/api-base-v1.json'))
  requireFixture(sourceRaw.equals(expectedRaw), 'producer_api_base_vectors_changed')
  const contract = JSON.parse(sourceRaw)
  requireFixture(contract.contract === 'memoh.file-api-base.v1' && contract.cases.length === 30, 'producer_api_base_contract_invalid')
  const binary = path.join(root, 'transferqueue.test.exe')
  const contractTests = testNames(await execute(binary, ['-test.list=^Test(Task)?APIBase'], remaining(30000), false, contractDirectory), 'Test(Task)?APIBase')
  requireFixture(sameSet(contractTests, ['TestAPIBaseContractVectors', ...taskAPIBaseTests]), 'producer_api_base_inventory_changed')
  const contractOutput = await execute(binary, ['-test.run=^TestAPIBaseContractVectors$', '-test.v', '-test.timeout=30s'], remaining(40000), true, contractDirectory)
  completedAPIBaseCases(contractOutput, contract.cases.map(c => c.name))
  process.stdout.write(JSON.stringify({ producerAPIBaseContract: 'passed', sourceCommit, contract: contract.contract, vectors: contract.cases.length, skipped: 0 }) + '\n')
  const boundaryOutput = await execute(binary, [`-test.run=^(${taskAPIBaseTests.join('|')})$`, '-test.v', '-test.timeout=30s'], remaining(40000), true, contractDirectory)
  const boundaryCases = completedTaskAPIBaseCases(boundaryOutput)
  process.stdout.write(JSON.stringify({ producerTaskAPIBaseBoundary: 'passed', sourceCommit, topLevel: taskAPIBaseTests.length, cases: boundaryCases.length, skipped: 0 }) + '\n')
  const cliBinary = path.join(root, 'transferqueue-cli.test.exe')
  for (const [file, names, selector, contractName] of [
    [binary, networkTests, '^TestHostNetwork', 'producerNetworkContract'],
    [binary, downloadTests, '^TestDownload(Metadata|DiskPressure)', 'producerDownloadContract'],
    [cliBinary, cliDownloadTests, '^TestCLIDefaultDownload', 'producerDownloadContract'],
    [binary, publicationMigrationTests, '^TestPublicationMetadataMigrationPreservesCompleteHistory$', 'producerPublicationMigrationContract'],
    [binary, budgetTests, '^Test(HostBudget|BudgetMigration)', 'producerBudgetContract'],
    [cliBinary, cliBudgetTests, '^TestCLIBudget', 'producerBudgetContract'],
    [binary, registrationTests, '^TestRegistered', 'producerRegistrationContract'],
    [cliBinary, cliRegistrationTests, '^TestProducerAdmissionPending', 'producerRegistrationContract'],
  ]) {
    const inventory = testNames(await execute(file, [`-test.list=${selector}`], remaining(30000)), 'Test')
    requireFixture(sameSet(inventory, names), `${contractName}_inventory_changed`)
    const output = await execute(file, [`-test.run=^(${names.join('|')})$`, '-test.v', '-test.timeout=2m'], remaining(130000), true)
    completedTests(output, names)
    process.stdout.write(JSON.stringify({ [contractName]: 'passed', sourceCommit, tests: names, skipped: 0, largePayloadAcceptance: false }) + '\n')
  }
  const native = testNames(await execute(path.join(root, 'transferqueue.test.exe'), ['-test.list=^TestWindowsNative'], remaining(30000)), 'TestWindowsNative')
  const cli = testNames(await execute(path.join(root, 'transferqueue-cli.test.exe'), ['-test.list=^TestCLIPath'], remaining(30000)), 'TestCLIPath')
  const groups = fixturePlan(native, cli)
  process.stdout.write(JSON.stringify({ producerFixturePlan: groups, sourceCommit, suiteTimeoutSeconds: 720 }) + '\n')
  const passed = []
  for (const group of groups) {
    const started = Date.now()
    let tests
    try {
      const output = await execute(path.join(root, group.binary), [`-test.run=${group.pattern}`, '-test.v', `-test.timeout=${group.timeout}`], remaining(310000), true)
      tests = completedTests(output, group.tests)
    } catch (error) {
      process.stdout.write(JSON.stringify({ producerFixtureGroup: group.name, state: 'failed', reason: error.message, exitCode: error.exitCode ?? null, signal: error.signal ?? null, durationMs: Date.now() - started }) + '\n')
      throw error
    }
    passed.push(...tests)
    process.stdout.write(JSON.stringify({ producerFixtureGroup: group.name, state: 'passed', tests, skipped: 0, durationMs: Date.now() - started }) + '\n')
  }
  requireFixture(sameSet(passed, [...native, ...cli]), 'producer_fixture_suite_incomplete')
  process.stdout.write(JSON.stringify({ producerFixtureSuite: 'passed', sourceCommit, apiBaseTopLevel: contractTests.length, apiBaseVectors: contract.cases.length, taskAPIBaseBoundaryCases: boundaryCases.length, nativeTopLevel: native.length, cliTopLevel: cli.length, skipped: 0 }) + '\n')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  requireFixture(process.argv.length === 4, 'producer_fixture_bundle_and_source_required')
  await verifyFixtures(await fs.realpath(process.argv[2]), await fs.realpath(process.argv[3]))
}
