import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { validateRuntimeRequest, validateRuntimeConfiguration, createExplicitRuntime } from './runtime.mjs'
import { deploymentFixture } from './test-support/deployment-fixture.mjs'
import { parseAdvanceDecision } from './transfer-contract.mjs'
import { catalog } from './endpoint.mjs'

const request = config => ({ schema: 1, mode: 'explicit-review', manifestSha256: config.manifestSha256, transfer: 'existing-queue' })
async function configured(t) {
  const f = await deploymentFixture(t), c = f.config
  const connector = { schema: 1, relay: 'https://relay.example.test', deviceId: c.deviceId, instances: [{ id: c.instanceId, kind: 'herdr', binary: path.join(c.bundleRoot, 'herdr/herdr.exe'), cwd: c.sourceRoot, configRoot: c.herdrConfigRoot }] }
  const file = path.join(c.agenvoConfigDir, 'config.json')
  await fs.writeFile(file, JSON.stringify(connector))
  await fs.writeFile(path.join(c.transferConfigDir, 'transfer.json'), JSON.stringify({ version: 1, origin: c.nasOrigin, source_root: c.sourceRoot }))
  await fs.writeFile(path.join(c.transferConfigDir, 'device.credential'), 'synthetic-only')
  await fs.writeFile(path.join(c.herdrConfigRoot, 'plugins.json'), JSON.stringify([{ plugin_id: 'memoh.delivery', enabled: true, version: catalog.components.transfer.version, plugin_root: path.join(c.bundleRoot, 'transfer'), manifest_path: path.join(c.bundleRoot, 'transfer/herdr-plugin.toml') }]))
  return { ...f, connector, file }
}
test('explicit request rejects executable, credential, test-driver and qualification overrides', () => {
  const config = { manifestSha256: 'a'.repeat(64) }, valid = request(config)
  assert.deepEqual(validateRuntimeRequest(valid, config), valid)
  for (const value of [null, {}, { ...valid, manifestSha256: 'b'.repeat(64) }, { ...valid, mode: 'automatic' }, { ...valid, transfer: 'collect-result' }, ...['binary', 'qualified', 'createTestRuntime', 'credential'].map(k => ({ ...valid, [k]: true }))]) assert.throws(() => validateRuntimeRequest(value, config))
})
test('runtime configuration verifies roots and existing mapping without reading or creating credentials', async t => {
  const f = await configured(t)
  await validateRuntimeConfiguration(f.config, request(f.config))
  assert.equal(await fs.readFile(path.join(f.config.agenvoConfigDir, 'credentials.json'), 'utf8'), 'SYNTHETIC USER FILE: PRESERVE EXACTLY')
  await fs.rm(path.join(f.config.agenvoConfigDir, 'credentials.json'))
  await assert.rejects(validateRuntimeConfiguration(f.config, request(f.config)), { code: 'connector_authentication_required' })
})
test('runtime rejects an extra instance, changed binary, insecure relay and mismatched transfer source', async t => {
  const f = await configured(t), check = () => validateRuntimeConfiguration(f.config, request(f.config))
  for (const altered of [{ ...f.connector, instances: [...f.connector.instances, f.connector.instances[0]] }, { ...f.connector, instances: [{ ...f.connector.instances[0], binary: process.execPath }] }, { ...f.connector, relay: 'http://localhost' }, { ...f.connector, relay: 'https://name:secret@relay.example.test' }]) {
    await fs.writeFile(f.file, JSON.stringify(altered)); await assert.rejects(check())
  }
  await fs.writeFile(f.file, JSON.stringify(f.connector))
  await fs.writeFile(path.join(f.config.transferConfigDir, 'transfer.json'), JSON.stringify({ version: 1, origin: f.config.nasOrigin, source_root: f.root }))
  await assert.rejects(check(), { code: 'transfer_configuration_mismatch' })
})
test('constructing native runtime does not execute or create work; disabled transfer stays absent', async t => {
  const f = await configured(t)
  const runtime = await createExplicitRuntime({ config: f.config, stateDirectory: f.lifecycleDirectory, request: { ...request(f.config), transfer: 'disabled' } })
  assert.equal(runtime.transfer, null); assert.equal(runtime.release, null)
  assert.equal(runtime.driver.children.size, 0)
  if (process.platform !== 'win32') {
    await assert.rejects(runtime.start(), { code: 'qualified_windows_driver_required' })
    assert.equal(runtime.release, null)
    assert.equal((await f.store.load()).attention, 'qualified_windows_driver_required')
  }
})
test('failed producer feedback is never silently projected to idle success', () => {
  const base = { schema: 'memoh.delivery.lifecycle.v1', state: 'idle', next_due_at: null, error_class: 'none', delivery_id: 'fixture', phase: 'ready', offset: 7, admitted: true, associated: true }
  assert.equal(parseAdvanceDecision(JSON.stringify({ ...base, feedback_status: 'recorded' })).state, 'idle')
  assert.throws(() => parseAdvanceDecision(JSON.stringify({ ...base, feedback_status: 'unavailable' })), { code: 'transfer_feedback_unavailable' })
})
