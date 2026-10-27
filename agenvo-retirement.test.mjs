import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { validateConfig, launchPlan, managedEnvironment } from './endpoint.mjs'
import { validateRuntimeRequest, validateRuntimeConfiguration, createExplicitRuntime } from './runtime.mjs'
import { NativeDriver, StateStore } from './lifecycle.mjs'
import { readSessionHistory } from './session-diagnostics.mjs'
import { deploymentReferences } from './deployment.mjs'
import { setupEndpoint } from './setup.mjs'
import { programPackage } from './test-support/program-package.mjs'
import { installedFixture, nativeInstalledFixture } from './test-support/installed-fixture.mjs'

const request = { schema: 2, mode: 'existing-installations', transfer: 'disabled' }
const rejected = { code: 'legacy_execution_retired' }

for (const schema of [1, 2]) test(`schema ${schema} still decodes history references but cannot plan, validate or construct a runtime`, async t => {
  const f = await installedFixture(t)
  const config = schema === 2 ? f.config : deploymentReferences(path.join(f.base, 'old-host'), {
    manifestSha256: 'a'.repeat(64), nasOrigin: 'https://nas.example.test', deviceId: f.config.deviceId,
    runtimeId: f.config.runtimeId, instanceId: f.config.instanceId, session: f.config.session,
  })
  const original = JSON.stringify(config)
  assert.equal(validateConfig(config), config)
  assert.throws(() => validateRuntimeRequest(request, config), rejected)
  assert.throws(() => launchPlan(config), rejected)
  await assert.rejects(validateRuntimeConfiguration(config, request), rejected)
  const stateDirectory = path.join(f.base, 'must-not-be-created')
  await assert.rejects(createExplicitRuntime({ config, stateDirectory, request }), rejected)
  await assert.rejects(fs.lstat(stateDirectory), { code: 'ENOENT' })
  assert.equal(JSON.stringify(config), original)
  assert.equal(f.calls.length, 0)
  const driver = new NativeDriver(config, { checkPrograms: () => assert.fail('retired execution must not qualify a program') })
  for (const component of ['connector', 'herdr']) await assert.rejects(driver.start(component), rejected)
  await assert.rejects(driver.recoverConnector(), rejected)
  await assert.rejects(driver.validate(), rejected)
  assert.throws(() => driver.command(process.execPath, ['--version']), rejected)
  await assert.rejects(driver.observeHostStatus(), rejected)
  assert.equal(driver.children.size, 0)
  assert.equal(driver.recoverConnectorLock, undefined)
  assert.equal(await driver.connectorStatus(), null)
  assert.equal(managedEnvironment(config, { AGENVO_CONFIG_DIR: 'inherited-old-path' }).AGENVO_CONFIG_DIR, undefined)
})

test('old requests fail before reading program/config references, even with a formerly valid explicit-review manifest', async () => {
  for (const schema of [1, 2]) {
    const config = { schema, get programs() { assert.fail('must not resolve old programs') },
      get agenvoConfigDir() { assert.fail('must not inspect private legacy configuration') } }
    for (const value of [request, { schema: 1, mode: 'explicit-review', manifestSha256: 'a'.repeat(64), transfer: 'existing-queue' }, null]) {
      assert.throws(() => validateRuntimeRequest(value, config), rejected)
      await assert.rejects(createExplicitRuntime({ config, stateDirectory: 'not-accessed', request: value }), rejected)
    }
  }
})

test('saved legacy unknown acknowledgement, large revisions, Pi history and receipt bytes remain readable without execution', async t => {
  const f = await installedFixture(t), root = path.join(f.base, 'historical-host'), directory = path.join(root, 'data/endpoint')
  await fs.mkdir(directory, { recursive: true }); await f.write(path.join(root, 'config/endpoint.json'), JSON.stringify(f.config))
  const snapshot = path.join(f.config.herdrConfigRoot, 'sessions', f.config.session, 'session.json')
  await f.write(snapshot, JSON.stringify({ version: 3, workspaces: [{ id: 'original-workspace', tabs: [{ panes: { original: {
    cwd: f.config.sourceRoot, agent_session: { source: 'herdr:pi', agent: 'pi', kind: 'path', value: 'original-session.jsonl' },
  } } }] }] }))
  const receipt = path.join(f.config.sourceRoot, '.memoh-computer/attempts/original/receipt.json')
  const piHistory = path.join(f.config.sourceRoot, '.memoh-computer/sessions/original/session.jsonl')
  await f.write(receipt, '{"operation_id":"original","state":"unknown","revision":"9007199254740993124","RootHash":"ORIGINAL","HostBinding":"ORIGINAL"}\n')
  await f.write(piHistory, '{"id":"original-session","provider":"magpie"}\n')
  const payload = { schema: 1, request_id: randomUUID(),
    host: { run_id: randomUUID(), root_sha256: 'a'.repeat(64), program_sha256: 'b'.repeat(64), configuration_sha256: 'c'.repeat(64) },
    native: { device_id: f.config.deviceId, runtime_id: f.config.runtimeId, instance_id: f.config.instanceId, session: f.config.session,
      herdr_pid: 123, herdr_generation: '123:456', connector_pid: 789, connector_nonce: randomUUID() },
    gate: { connection_id: randomUUID(), device_id: f.config.deviceId, instance_id: f.config.instanceId, request_id: randomUUID(), revision: '9007199254740993123', paused: true, scope: 'owner_connection_instance' },
    operations: [{ operation_id: randomUUID(), revision: '9007199254740993124', reconciliation_sha256: 'd'.repeat(64) }] }
  const store = new StateStore(directory, f.config.deviceId), recorded = await store.recordHandoff(payload)
  await store.markHandoffUnknown(recorded.request_id, recorded.payload_sha256)
  const files = [store.file, receipt, piHistory, snapshot], before = await Promise.all(files.map(file => fs.readFile(file)))
  await assert.rejects(createExplicitRuntime({ config: f.config, stateDirectory: directory, request }), rejected)
  const saved = await new StateStore(directory, f.config.deviceId).load()
  assert.equal(saved.handoff.state, 'outcome_unknown')
  assert.equal(saved.handoff.payload.operations[0].revision, '9007199254740993124')
  const result = spawnSync(process.execPath, [path.resolve('endpoint.mjs'), 'host', 'handoff-status', '--root', root, '--request-id', payload.request_id], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stderr)
  const observed = JSON.parse(result.stdout)
  assert.equal(observed.state, 'outcome_unknown'); assert.equal(observed.stop_authority, false)
  assert.equal(observed.automatic_retry, false); assert.equal(observed.business_dispatched_by_ack, false)
  const history = await readSessionHistory(f.config)
  assert.equal(history.state, 'history_present'); assert.equal(history.piSessionReferences, 1)
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file))), before)
  assert.equal(f.calls.length, 0)
})

test('native request and owned Runtime bridge remain available without any legacy environment or child', async t => {
  const f = await nativeInstalledFixture(t), config = { ...f.config, programs: { ...f.config.programs, node: process.execPath } }
  const api = path.join(path.dirname(f.p.connector), 'endpoint-host-api.mjs')
  await f.write(api, `
export class RuntimeSession {}
export const formatCLIError = e => e.message;
export function runCLI(args) {
  if (args[0] !== 'run' || args[1] !== '--config' || process.env.AGENVO_CONFIG_DIR !== undefined) throw new Error('invalid native arguments');
  const timer = setInterval(() => {}, 1000);
  process.once('SIGTERM', () => { clearInterval(timer); console.log('stopped') });
  console.log('connected'); return Promise.resolve(0);
}
`)
  const stateDirectory = path.join(f.base, 'native-endpoint')
  const runtime = await createExplicitRuntime({ config, stateDirectory, request })
  assert.equal(runtime.driver.children.size, 0); assert.equal(runtime.transfer, null)
  assert.deepEqual(validateRuntimeRequest(request, config), request)
  assert.deepEqual(launchPlan(config).commands[1].args, [f.p.connector, 'run', '--config', config.connector.enrollmentFile])
  const driver = new NativeDriver(config, { inheritedEnvironment: { ...process.env, AGENVO_CONFIG_DIR: 'old-path' } })
  t.after(async () => {
    const record = driver.nativeConnector.record
    if (record && !record.closed) { record.process.kill(); await record.done }
  })
  await driver.start('connector'); await driver.waitReady('connector')
  const pid = driver.nativeConnector.record.process.pid
  assert.equal(Number.isSafeInteger(pid), true)
  assert.equal((await driver.connectorStatus()).state, 'online')
  assert.equal(driver.children.has('connector'), false)
  await driver.stop('connector')
  assert.equal(driver.nativeConnector.cleanupConfirmed(), true)
  assert.equal(driver.nativeConnector.record.process.pid, pid)
})


test('retired setup refuses before writing a host, runtime request or installation selection', async t => {
  const f = await installedFixture(t), from = path.join(f.base, 'old-references.json'), root = path.join(f.base, 'must-not-be-created')
  await f.write(from, JSON.stringify(f.config))
  await assert.rejects(setupEndpoint({ from, root, source: path.join(f.base, 'not-read'), manifestSha256: 'a'.repeat(64), transfer: 'disabled' }, {
    verify: async () => ({ manifest: {} }), doctor: () => assert.fail('must not probe'), install: () => assert.fail('must not install'),
  }), rejected)
  await assert.rejects(fs.lstat(root), { code: 'ENOENT' })
})


test('public setup CLI reports retirement and leaves the destination absent', async t => {
  const f = await installedFixture(t), candidate = await programPackage(path.join(f.base, 'candidate'))
  const from = path.join(f.base, 'old-references.json'), root = path.join(f.base, 'must-not-be-created')
  await f.write(from, JSON.stringify(f.config))
  const result = spawnSync(process.execPath, [path.resolve('endpoint.mjs'), 'setup', '--from', from, '--root', root,
    '--source', candidate.directory, '--manifest-sha256', candidate.hash, '--transfer', 'disabled'], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 2)
  assert.deepEqual(JSON.parse(result.stderr), { error: 'legacy_execution_retired' })
  await assert.rejects(fs.lstat(root), { code: 'ENOENT' })
})
