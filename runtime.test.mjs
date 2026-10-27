import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { validateRuntimeRequest, validateRuntimeConfiguration, createExplicitRuntime } from './runtime.mjs'
import { nativeInstalledFixture } from './test-support/installed-fixture.mjs'
import { parseAdvanceDecision } from './transfer-contract.mjs'
import { catalog } from './endpoint.mjs'

const request = () => ({ schema: 2, mode: 'existing-installations', transfer: 'disabled' })
async function configured(t) {
  const f = await nativeInstalledFixture(t)
  return { ...f, lifecycleDirectory: path.join(f.base, 'endpoint') }
}
test('explicit request rejects executable, credential, test-driver and qualification overrides', () => {
  const config = { schema: 3 }, valid = request(config)
  assert.deepEqual(validateRuntimeRequest(valid, config), valid)
  for (const value of [null, {}, { ...valid, manifestSha256: 'b'.repeat(64) }, { ...valid, mode: 'automatic' }, { ...valid, transfer: 'collect-result' }, ...['binary', 'qualified', 'createTestRuntime', 'credential'].map(k => ({ ...valid, [k]: true }))]) assert.throws(() => validateRuntimeRequest(value, config))
})
test('runtime configuration verifies roots and existing mapping without reading or creating credentials', async t => {
  const f = await configured(t)
  await validateRuntimeConfiguration(f.config, request(f.config))
  assert.equal(await fs.readFile(f.config.connector.enrollmentFile, 'utf8'), 'SYNTHETIC UNREAD ENROLLMENT')
  await fs.rm(f.config.connector.enrollmentFile)
  await assert.rejects(validateRuntimeConfiguration(f.config, request(f.config)), { code: 'connector_authentication_required' })
})
test('native runtime rejects replaced identity, program and unsafe configuration before execution', async t => {
  const f = await configured(t)
  for (const changed of [ { ...f.config, deviceId: '22222222-2222-4222-8222-222222222222' },
    { ...f.config, programs: { ...f.config.programs, herdr: 'relative' } },
    { ...f.config, connector: { ...f.config.connector, token: 'not-accepted' } } ]) {
    await assert.rejects(validateRuntimeConfiguration(changed, request(changed)))
  }
  assert.equal(f.calls.length, 0)
})
test('constructing native runtime does not execute or create work; disabled transfer stays absent', async t => {
  const f = await configured(t)
  await fs.mkdir(f.lifecycleDirectory)
  const runtime = await createExplicitRuntime({ config: f.config, stateDirectory: f.lifecycleDirectory, request: { ...request(f.config), transfer: 'disabled' } })
  assert.equal(runtime.transfer, null); assert.equal(runtime.release, null)
  assert.equal(runtime.driver.children.size, 0)
  if (process.platform !== 'win32') {
    await assert.rejects(runtime.start(), { code: 'qualified_windows_driver_required' })
    assert.equal(runtime.release, null)
    assert.equal((await runtime.store.load()).attention, 'qualified_windows_driver_required')
  }
})
test('failed producer feedback is never silently projected to idle success', () => {
  const base = { schema: 'memoh.delivery.lifecycle.v1', state: 'idle', next_due_at: null, error_class: 'none', delivery_id: 'fixture', phase: 'ready', offset: 7, admitted: true, associated: true }
  assert.equal(parseAdvanceDecision(JSON.stringify({ ...base, feedback_status: 'recorded' })).state, 'idle')
  assert.throws(() => parseAdvanceDecision(JSON.stringify({ ...base, feedback_status: 'unavailable' })), { code: 'transfer_feedback_unavailable' })
})
