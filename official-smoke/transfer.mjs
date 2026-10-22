import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// Run only after prepare-transfer.ps1 verified and extracted the locked archive
// into this fresh isolated fixture. No network download or producer source build.
assert.equal(process.platform, 'win32')
const root = await fs.realpath(process.argv[2])
const temporary = await fs.mkdtemp(path.join(root, 'consumer-fixture-'))
const env = { ...process.env, TEMP: temporary, TMP: temporary }
for (const key of Object.keys(env)) if (/^(HERDR_|AGENVO_|MEMOH_)/i.test(key)) delete env[key]
env.HERDR_PLUGIN_CONFIG_DIR = path.join(temporary, 'absent-config')
env.HERDR_PLUGIN_STATE_DIR = path.join(temporary, 'absent-state')
const executable = path.join(root, 'transferqueue.exe')
const testExecutable = path.join(root, 'transferqueue.test.exe')
function run(file, args, timeout = 10000) {
  const result = spawnSync(file, args, { env, cwd: temporary, encoding: 'utf8', shell: false, windowsHide: true, timeout, maxBuffer: 262144 })
  assert.equal(result.error, undefined, 'Fixed component must execute without a spawn error or timeout')
  assert.equal(result.signal, null)
  return result
}
const checks = []
const checked = name => { checks.push(name); process.stdout.write(`${JSON.stringify({ transferFixture: name, state: 'passed' })}\n`) }
try {
  const summary = run(executable, ['-action', 'lifecycle-summary'])
  assert.equal(summary.status, 2)
  assert.equal(summary.stdout.trim(), '')
  assert.equal(summary.stderr.trim(), 'unsupported action')
  assert.deepEqual(await fs.readdir(temporary), [])
  checked('current_cli_explicitly_lacks_lifecycle_summary_without_mutating_state')

  const probe = run(executable, ['-action', 'probe'])
  assert.equal(probe.status, 1)
  assert.equal(probe.stdout.trim(), '')
  assert.equal(probe.stderr.trim(), 'storage unavailable')
  assert.deepEqual(await fs.readdir(temporary), [])
  checked('missing_host_roots_fail_without_creating_or_repairing_configuration')

  const names = ['TestProducerClosedManifestRestartAndLostAssociation', 'TestProducerInputAndRootFailClosed', 'TestProducerConfigurationCannotChangeBetweenCheckAndAdmission', 'TestProducerMissingSourceWithoutQueueIsNotIdleSuccess']
  const selector = `^(${names.join('|')})$`
  const listed = run(testExecutable, [`-test.list=${selector}`])
  assert.equal(listed.status, 0)
  assert.deepEqual(listed.stdout.trim().split(/\r?\n/).sort(), [...names].sort())
  const component = run(testExecutable, [`-test.run=${selector}`, '-test.v', '-test.timeout=2m'], 130000)
  assert.equal(component.status, 0, 'Packaged producer component fixture failed')
  for (const name of names) assert.ok(component.stdout.includes(`--- PASS: ${name} (`), 'Every selected producer fixture must actually pass')
  assert.ok(!component.stdout.includes('--- SKIP:'))
  checked('packaged_component_seven_byte_tls_recovery_reference_and_root_guards')
  process.stdout.write(`${JSON.stringify({ checks, sourceCommit: '6ddf61dcd8199758e4110398645c556a3d6d7375', lifecycleSummary: false, automaticTransferWake: false, externalCLIDataChain: 'not_tested_requires_producer_cli_fixture', componentDataChain: 'packaged_test_executable', productionQualified: false }, null, 2)}\n`)
} finally {
  await fs.rm(temporary, { recursive: true, force: true })
}
