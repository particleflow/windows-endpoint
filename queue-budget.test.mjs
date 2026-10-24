import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { installedFixture } from './test-support/installed-fixture.mjs'
import { main, transferLocations, validateTransferConfiguration } from './endpoint.mjs'
import { readQueueBudget, queueBudgetCommand } from './queue-budget.mjs'
import { acquireLeases, leaseKeys, StateStore } from './lifecycle.mjs'
import { deploymentReferences } from './deployment.mjs'

async function fixture(t) {
  const f = await installedFixture(t)
  f.config.transfer = { pluginRoot: path.join(f.base, 'transfer'), nasOrigin: 'https://nas.example.test/api/' }
  const root = path.join(f.base, 'host'), locations = transferLocations(f.config)
  for (const dir of [path.join(root, 'config'), path.join(root, 'data/endpoint'), locations.config, locations.state]) await fs.mkdir(dir, { recursive: true })
  await f.write(path.join(root, 'config/endpoint.json'), JSON.stringify(f.config))
  await f.write(path.join(locations.config, 'transfer.json'), JSON.stringify({ version: 1, origin: f.config.transfer.nasOrigin, source_root: f.config.sourceRoot }))
  await f.write(path.join(locations.config, 'device.credential'), 'SYNTHETIC UNREAD CREDENTIAL')
  return { ...f, root, locations, policy: path.join(locations.config, 'queue-budget.json'), directory: path.join(root, 'data/endpoint') }
}

test('unified initial configuration writes only native policy; repeat preserves bytes and binding', async t => {
  const f = await fixture(t)
  const binding = await fs.readFile(path.join(f.locations.config, 'transfer.json'))
  assert.equal((await main(['transfer-budget', '--root', f.root])).budget.bytes, 256 * 1024 ** 2)
  const saved = await main(['transfer-budget', '--root', f.root, '--bytes', '8589934592'])
  assert.equal(saved.state, 'fresh_policy_created')
  assert.equal(saved.queueChanged, false)
  assert.equal((await validateTransferConfiguration(f.config)).bytes, 8 * 1024 ** 3)
  const raw = await fs.readFile(f.policy)
  assert.equal((await queueBudgetCommand(f.root, '8589934592')).state, 'configuration_unchanged')
  for (const request of ['17179869184', '1']) {
    assert.equal((await queueBudgetCommand(f.root, request)).state, 'deferred')
    assert.deepEqual(await fs.readFile(f.policy), raw)
  }
  assert.deepEqual(await fs.readFile(path.join(f.locations.config, 'transfer.json')), binding)
  assert.deepEqual(await fs.readdir(f.locations.state), [])
})
test('active host lease prevents initialization without stopping the owner', async t => {
  const f = await fixture(t), release = await acquireLeases(leaseKeys(f.config), f.directory)
  try {
    assert.equal((await queueBudgetCommand(f.root, '8589934592')).reason, 'endpoint_owned')
    await assert.rejects(fs.stat(f.policy), { code: 'ENOENT' })
  } finally { await release() }
})
test('queue records and unknown files defer without editing or creating policy', async t => {
  const f = await fixture(t)
  await f.write(path.join(f.locations.state, 'unknown-evidence'), 'retain')
  assert.equal((await queueBudgetCommand(f.root, '8589934592')).reason, 'existing_queue_requires_writer_stop_backup_and_migration')
  assert.equal(await fs.readFile(path.join(f.locations.state, 'unknown-evidence'), 'utf8'), 'retain')
  await assert.rejects(fs.stat(f.policy), { code: 'ENOENT' })
})
test('stopped journal and moved empty config/state roots cannot authorize new policy or discard old work', async t => {
  const f = await fixture(t)
  await new StateStore(f.directory, f.config.deviceId).save({ schema: 1, identity: f.config.deviceId, phase: 'stopped', restarts: [], attention: null })
  const oldPolicy = path.join(f.locations.config, 'queue-budget.json')
  await f.write(oldPolicy, '{"version":1,"bytes":8589934592}\n')
  f.config.herdrConfigRoot = path.join(f.base, 'moved-config/herdr')
  f.config.herdrStateRoot = path.join(f.base, 'moved-state/herdr')
  const moved = transferLocations(f.config)
  await fs.mkdir(moved.config, { recursive: true }); await fs.mkdir(moved.state, { recursive: true })
  await f.write(path.join(f.root, 'config/endpoint.json'), JSON.stringify(f.config))
  assert.equal((await queueBudgetCommand(f.root, '17179869184')).reason, 'existing_runtime_requires_writer_stop_backup_and_migration')
  assert.equal(await fs.readFile(oldPolicy, 'utf8'), '{"version":1,"bytes":8589934592}\n')
  await assert.rejects(fs.stat(path.join(moved.config, 'queue-budget.json')), { code: 'ENOENT' })
})
test('external runtime markers and historical session data defer without adopting or stopping', async t => {
  const f = await fixture(t)
  for (const file of [path.join(f.config.agenvoConfigDir, 'run.lock'), path.join(f.config.herdrConfigRoot, 'herdr.sock'), path.join(f.config.herdrConfigRoot, 'sessions')]) {
    await f.write(file, 'unowned')
    assert.equal((await queueBudgetCommand(f.root, '8589934592')).state, 'deferred')
    assert.equal(await fs.readFile(file, 'utf8'), 'unowned')
    await fs.unlink(file)
  }
})
test('invalid/interrupted policy never falls back, retries never overwrite evidence', async t => {
  const f = await fixture(t)
  for (const raw of ['{', '{"version":1,"bytes":0}', '{"version":1,"bytes":1099511627777}', '{"version":2,"bytes":1}', '{"version":1,"bytes":"8"}', '{"version":1,"bytes":8,"extra":1}', ' '.repeat(1025)]) {
    await fs.writeFile(f.policy, raw)
    await assert.rejects(readQueueBudget(f.config), /queue_budget_(invalid|input_unsafe)/)
    await assert.rejects(queueBudgetCommand(f.root, '8589934592'))
    assert.equal(await fs.readFile(f.policy, 'utf8'), raw)
  }
})
test('linked policies and missing config root are errors; only absent policy gets default', async t => {
  const f = await fixture(t)
  const other = path.join(f.base, 'other.json')
  await f.write(other, '{"version":1,"bytes":8}')
  await fs.link(other, f.policy)
  await assert.rejects(readQueueBudget(f.config), /queue_budget_input_unsafe/)
  await fs.unlink(f.policy)
  await fs.rm(f.locations.config, { recursive: true })
  await assert.rejects(readQueueBudget(f.config), { code: 'ENOENT' })
})
test('both configuration schemas read the same native policy without a second budget field', async t => {
  const f = await fixture(t)
  await fs.writeFile(f.policy, '{"version":1,"bytes":17179869184}')
  const schema1 = { schema: 1, bundleRoot: f.base, transferConfigDir: f.locations.config, transferStateDir: f.locations.state, nasOrigin: f.config.transfer.nasOrigin }
  assert.deepEqual(await readQueueBudget(schema1), await readQueueBudget(f.config))
  for (const bytes of ['-1', '0', '1.5', '8GiB', '1099511627777']) await assert.rejects(queueBudgetCommand(f.root, bytes), /queue_budget_invalid/)
})
test('packaged schema uses its unified layout and rejects a redirected data root', async t => {
  const f = await fixture(t)
  const config = deploymentReferences(f.root, { manifestSha256: 'a'.repeat(64), nasOrigin: f.config.transfer.nasOrigin,
    deviceId: f.config.deviceId, runtimeId: f.config.runtimeId, instanceId: f.config.instanceId, session: f.config.session })
  for (const dir of [config.transferConfigDir, config.transferStateDir]) await fs.mkdir(dir, { recursive: true })
  await f.write(path.join(f.root, 'config/endpoint.json'), JSON.stringify(config))
  assert.equal((await queueBudgetCommand(f.root, '8589934592')).state, 'fresh_policy_created')
  assert.equal((await readQueueBudget(config)).bytes, 8589934592)
  config.sourceRoot = f.config.sourceRoot
  await f.write(path.join(f.root, 'config/endpoint.json'), JSON.stringify(config))
  await assert.rejects(queueBudgetCommand(f.root, '8589934592'), /host_configuration_root_mismatch/)
})
