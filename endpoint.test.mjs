import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { catalog, configure, digest, doctor, launchPlan, main, stageBundle, validateConfig, verifyBundle } from './endpoint.mjs'

async function json(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, JSON.stringify(value))
}
async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'endpoint Unicode 空格 ')))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const root = path.join(base, 'bundle')
  const manifest = { schema: 1, platform: 'win32-x64', qualification: 'review-only', components: {}, files: [] }
  const names = new Set(catalog.requiredFiles)
  for (const [id, spec] of Object.entries(catalog.components)) {
    manifest.components[id] = { version: spec.version || '2.51.0.windows.1', source: spec.source, revision: spec.revision || 'v2.51.0.windows.1', entry: spec.entry }
    names.add(spec.entry)
    if (spec.package) names.add(spec.package)
  }
  for (const name of names) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await fs.writeFile(path.join(root, name), 'synthetic inert payload; never executable')
  }
  for (const spec of Object.values(catalog.components).filter(c => c.package)) await json(path.join(root, spec.package), { name: spec.name, version: spec.version })
  const proofs = []
  for (const name of ['transferqueue.exe', 'herdr-plugin.toml']) proofs.push({ name, sha256: await digest(path.join(root, 'transfer', name)) })
  await json(path.join(root, 'transfer/SHA256SUMS.json'), { source_commit: catalog.components.transfer.revision, arch: 'amd64', files: proofs })
  for (const name of names) manifest.files.push({ path: name, size: (await fs.stat(path.join(root, name))).size, sha256: await digest(path.join(root, name)) })
  async function save() {
    await json(path.join(root, 'bundle.json'), manifest)
    return digest(path.join(root, 'bundle.json'))
  }
  const hash = await save()
  const config = {
    schema: 1, bundleRoot: root, manifestSha256: hash, nasOrigin: 'https://nas.example.test',
    sourceRoot: path.join(base, 'exports'), herdrConfigRoot: path.join(base, 'config/herdr'),
    herdrStateRoot: path.join(base, 'state/herdr'), agenvoConfigDir: path.join(base, 'agenvo'), piConfigDir: path.join(base, 'pi'),
    transferConfigDir: path.join(base, 'config/herdr/plugins/config/memoh.delivery'),
    transferStateDir: path.join(base, 'state/herdr/plugins/memoh.delivery'),
    deviceId: '11111111-1111-4111-8111-111111111111', runtimeId: '22222222-2222-4222-8222-222222222222', instanceId: 'existing-herdr', session: 'default',
  }
  for (const key of ['sourceRoot', 'herdrConfigRoot', 'herdrStateRoot', 'agenvoConfigDir', 'piConfigDir', 'transferConfigDir', 'transferStateDir']) await fs.mkdir(config[key], { recursive: true })
  await json(path.join(config.agenvoConfigDir, 'config.json'), { schema: 1, deviceId: config.deviceId, instances: [{ id: config.instanceId, kind: 'herdr', binary: path.join(root, catalog.components.herdr.entry), cwd: config.sourceRoot, configRoot: config.herdrConfigRoot }] })
  await fs.writeFile(path.join(config.herdrConfigRoot, 'config.toml'), '# synthetic configuration')
  await json(path.join(config.herdrConfigRoot, 'plugins.json'), [{ plugin_id: 'memoh.delivery', version: catalog.components.transfer.version, enabled: true, plugin_root: path.join(root, 'transfer'), manifest_path: path.join(root, 'transfer/herdr-plugin.toml') }])
  for (const file of [path.join(config.agenvoConfigDir, 'credentials.json'), path.join(config.piConfigDir, 'auth.json'), path.join(config.transferConfigDir, 'device.credential')]) await fs.writeFile(file, 'DO-NOT-DISCLOSE-OR-PARSE-ME')
  await json(path.join(config.transferConfigDir, 'transfer.json'), { version: 1, origin: config.nasOrigin, source_root: config.sourceRoot })
  return { base, root, manifest, config, hash, save }
}

test('verified full inventory is still review-only, with explicit blockers', async t => {
  const f = await fixture(t)
  assert.ok((await verifyBundle(f.root, f.hash)).totalBytes < 16384)
  const result = await doctor(f.config, () => { throw new Error('fixture: no real components') })
  assert.equal(result.ready, false)
  assert.equal(result.activation, 'blocked')
  for (const key of ['bundle_inventory', 'existing_device_mapping', 'official_agent_configuration', 'transfer_configuration', 'existing_transfer_plugin']) assert.equal(result.checks.find(c => c.check === key).state, 'passed')
  assert.equal(result.capabilities.desktop, 'unsupported_by_command_connector')
  assert.equal(result.lifecycle.automaticRecovery, false)
  assert.equal(result.lifecycle.idleQueueWake, 'missing')
  assert.ok(result.blockers.includes('transfer_candidate_not_qualified'))
  assert.ok(!JSON.stringify(result).includes('DO-NOT-DISCLOSE'))
})

test('reject missing dependency, extra files, altered payload, and untrusted manifest', async t => {
  const f = await fixture(t)
  await assert.rejects(verifyBundle(f.root, '0'.repeat(64)), /manifest_hash_mismatch/)
  await fs.writeFile(path.join(f.root, 'unexpected.exe'), 'extra')
  await assert.rejects(verifyBundle(f.root, f.hash), /inventory_mismatch/)
  await fs.unlink(path.join(f.root, 'unexpected.exe'))
  await fs.writeFile(path.join(f.root, 'herdr/herdr.exe'), 'altered')
  await assert.rejects(verifyBundle(f.root, f.hash), /payload_hash_mismatch/)
  f.manifest.files = f.manifest.files.filter(file => file.path !== 'node/node.exe')
  await assert.rejects(verifyBundle(f.root, await f.save()), /component_missing/)
})

test('refuse component version/source drift and release-status promotion', async t => {
  const f = await fixture(t)
  f.manifest.components.connector.version = '0.2.1'
  await assert.rejects(verifyBundle(f.root, await f.save()), /component_version_mismatch/)
  f.manifest.components.connector.version = '0.2.0'
  f.manifest.components.connector.source = 'https://untrusted.example.test'
  await assert.rejects(verifyBundle(f.root, await f.save()), /component_source_mismatch/)
  f.manifest.qualification = 'released'
  await assert.rejects(verifyBundle(f.root, await f.save()), /bundle_contract_unsupported/)
})

test('reject path traversal, ADS, Windows aliases and case-fold collisions', async t => {
  const f = await fixture(t)
  const original = structuredClone(f.manifest.files)
  for (const bad of ['../escape', '/absolute', 'herdr/file:stream', 'herdr/NUL.exe', 'herdr/dot.', 'herdr/trailing ', 'herdr\\escape', 'herdr//file']) {
    f.manifest.files = [...original, { path: bad, size: 0, sha256: '0'.repeat(64) }]
    await assert.rejects(verifyBundle(f.root, await f.save()), /unsafe_package_path/)
  }
  f.manifest.files = [...original, { ...original[0], path: original[0].path.toUpperCase() }]
  await assert.rejects(verifyBundle(f.root, await f.save()), /duplicate_inventory_path/)
})

test('reject linked package content and junction ancestors', async t => {
  const f = await fixture(t)
  await fs.link(path.join(f.root, 'node/node.exe'), path.join(f.base, 'outside-link'))
  await assert.rejects(verifyBundle(f.root, f.hash), /regular_private_copy_required/)
  await fs.unlink(path.join(f.base, 'outside-link'))
  const alias = path.join(f.base, 'linked-bundle')
  await fs.symlink(f.root, alias, process.platform === 'win32' ? 'junction' : 'dir')
  await assert.rejects(verifyBundle(alias, f.hash), /noncanonical_path|reparse_point_rejected/)
})

test('full inventory catches missing transitive npm payload', async t => {
  const f = await fixture(t)
  const file = { path: 'node_modules/ws/index.js', size: 4, sha256: '0'.repeat(64) }
  f.manifest.files.push(file)
  await assert.rejects(verifyBundle(f.root, await f.save()), /inventory_mismatch/)
})

test('transfer binary provenance remains tied to the exact component commit', async t => {
  const f = await fixture(t)
  const file = path.join(f.root, 'transfer/SHA256SUMS.json')
  await json(file, { source_commit: '0'.repeat(40), arch: 'amd64', files: [] })
  const proof = f.manifest.files.find(i => i.path === 'transfer/SHA256SUMS.json')
  proof.size = (await fs.stat(file)).size
  proof.sha256 = await digest(file)
  await assert.rejects(verifyBundle(f.root, await f.save()), /transfer_provenance_mismatch/)
})

test('configuration has no secret fields, rejects unsafe origin and overlapping roots', async t => {
  const { config } = await fixture(t)
  for (const nasOrigin of ['http://example.test', 'https://user:secret@example.test', 'https://example.test/path', 'https://example.test?token=secret', 'https://host.invalid']) assert.throws(() => validateConfig({ ...config, nasOrigin }), /https_origin_required/)
  assert.throws(() => validateConfig({ ...config, oauthToken: 'secret' }), /unknown_or_missing_field/)
  assert.throws(() => validateConfig({ ...config, sourceRoot: config.agenvoConfigDir }), /data_package_overlap/)
  assert.throws(() => validateConfig({ ...config, transferStateDir: config.piConfigDir }), /herdr_plugin_state_mismatch/)
  assert.throws(() => validateConfig({ ...config, sourceRoot: 'relative' }), /absolute_clean_path_required/)
})

test('configure creates references exclusively and never overwrites official files', async t => {
  const f = await fixture(t)
  const input = path.join(f.base, 'input.json')
  const output = path.join(f.base, 'endpoint.json')
  await json(input, f.config)
  assert.equal((await configure(input, output)).credentialsRead, false)
  await assert.rejects(configure(input, output), e => e.code === 'EEXIST')
  await assert.rejects(configure(input, path.join(f.config.piConfigDir, 'auth.json')), /configuration_location_rejected/)
  assert.equal(await fs.readFile(path.join(f.config.piConfigDir, 'auth.json'), 'utf8'), 'DO-NOT-DISCLOSE-OR-PARSE-ME')
})

test('changed approved executable/root/device mappings are blocked', async t => {
  const f = await fixture(t)
  const file = path.join(f.config.agenvoConfigDir, 'config.json')
  const original = JSON.parse(await fs.readFile(file, 'utf8'))
  for (const changed of [
    { ...original, deviceId: 'other' },
    { ...original, instances: [{ ...original.instances[0], binary: path.join(f.base, 'old/herdr.exe') }] },
    { ...original, instances: [{ ...original.instances[0], cwd: f.base }] },
  ]) {
    await json(file, changed)
    const report = await doctor(f.config, () => '')
    assert.equal(report.checks.find(c => c.check === 'existing_device_mapping').state, 'blocked')
  }
})

test('authentication failure and stale snapshots never turn into readiness or restarts', async t => {
  const f = await fixture(t)
  const file = path.join(f.config.agenvoConfigDir, 'status.json')
  await json(file, { deviceId: f.config.deviceId, updatedAt: Date.now(), state: 'online', lastError: 'handshake_401', secret: 'REDACT-ME' })
  const blocked = await doctor(f.config, () => '')
  assert.equal(blocked.capabilities.connection, 'authentication_required')
  assert.equal(blocked.ready, false)
  assert.ok(!JSON.stringify(blocked).includes('REDACT-ME'))
  await json(file, { deviceId: f.config.deviceId, updatedAt: Date.now(), state: 'needs_attention', lastError: '' })
  assert.equal((await doctor(f.config, () => '')).capabilities.connection, 'needs_attention')
  await json(file, { deviceId: f.config.deviceId, updatedAt: Date.now() - 121000, state: 'online', lastError: '' })
  assert.equal((await doctor(f.config, () => '')).capabilities.connection, 'authentication_unverified')
})

test('official Agenvo 0.2.0 online snapshot is observed without claiming endpoint readiness', async t => {
  const f = await fixture(t)
  // Shape and online state from the pinned official connector main.ts, not a
  // hypothetical connected state. No credential is part of this snapshot.
  const snapshot = { pid: 1234, relay: 'https://relay.example.test', deviceId: f.config.deviceId, state: 'online', version: '0.2.0', updatedAt: Date.now(), instances: [{ id: f.config.instanceId, available: true, backendVersion: '0.9.5' }], lastError: '' }
  await json(path.join(f.config.agenvoConfigDir, 'status.json'), snapshot)
  const report = await doctor(f.config, () => '')
  assert.equal(report.capabilities.connection, 'online_snapshot_unverified')
  assert.equal(report.capabilities.agent, 'readiness_unverified')
  assert.equal(report.ready, false)
  assert.equal(report.lifecycle.automaticRecovery, false)
  await json(path.join(f.config.agenvoConfigDir, 'status.json'), { ...snapshot, state: 'connected' })
  assert.equal((await doctor(f.config, () => '')).capabilities.connection, 'authentication_unverified')
})

test('missing, disabled or incorrectly linked transfer plugin is explicit', async t => {
  const f = await fixture(t)
  const file = path.join(f.config.herdrConfigRoot, 'plugins.json')
  const registry = JSON.parse(await fs.readFile(file, 'utf8'))
  for (const changed of [[], [{ ...registry[0], enabled: false }], [{ ...registry[0], plugin_root: f.base }]]) {
    await json(file, changed)
    assert.equal((await doctor(f.config, () => '')).checks.find(c => c.check === 'existing_transfer_plugin').state, 'blocked')
  }
})

test('staging resumes around inert interrupted copies, is idempotent, preserves data', async t => {
  const f = await fixture(t)
  const dest = path.join(f.base, 'packages')
  await fs.mkdir(dest)
  const pending = path.join(dest, `.pending-${f.hash}-interrupted`)
  await fs.mkdir(pending)
  await fs.writeFile(path.join(pending, 'partial'), 'unfinished')
  await fs.writeFile(path.join(f.config.sourceRoot, 'original'), 'KEEP-ORIGINAL')
  await fs.writeFile(path.join(f.config.transferStateDir, 'queue'), 'KEEP-UNDELIVERED')
  assert.equal((await stageBundle(f.root, dest, f.hash)).state, 'staged_review_only')
  assert.equal((await stageBundle(f.root, dest, f.hash)).state, 'already_staged')
  await verifyBundle(path.join(dest, f.hash), f.hash)
  assert.equal(await fs.readFile(path.join(pending, 'partial'), 'utf8'), 'unfinished')
  assert.equal(await fs.readFile(path.join(f.config.sourceRoot, 'original'), 'utf8'), 'KEEP-ORIGINAL')
  assert.equal(await fs.readFile(path.join(f.config.transferStateDir, 'queue'), 'utf8'), 'KEEP-UNDELIVERED')
  assert.equal(await fs.readFile(path.join(f.config.piConfigDir, 'auth.json'), 'utf8'), 'DO-NOT-DISCLOSE-OR-PARSE-ME')
})

test('corrupt published candidate is never overwritten or repaired', async t => {
  const f = await fixture(t)
  const dest = path.join(f.base, 'packages')
  await fs.mkdir(dest)
  await stageBundle(f.root, dest, f.hash)
  await fs.writeFile(path.join(dest, f.hash, 'node/node.exe'), 'corrupted')
  await assert.rejects(stageBundle(f.root, dest, f.hash), /payload_hash_mismatch/)
  assert.equal(await fs.readFile(path.join(dest, f.hash, 'node/node.exe'), 'utf8'), 'corrupted')
})

test('plan uses explicit binaries and an isolated PATH, no task/transport worker', async t => {
  const f = await fixture(t)
  const plan = launchPlan(f.config)
  assert.equal(plan.activation, 'blocked')
  assert.equal(plan.commands.length, 2)
  assert.deepEqual(plan.commands[0].args, ['--session', 'default', 'server'])
  assert.equal(plan.commands[1].args[1], 'run')
  for (const cmd of plan.commands) assert.ok(path.isAbsolute(cmd.file))
  assert.ok(plan.environment.PATH.startsWith(path.join(f.root, 'node')))
  assert.ok(!plan.environment.PATH.includes('/usr/local/bin'))
  assert.equal(plan.environment.XDG_STATE_HOME, path.dirname(f.config.herdrStateRoot))
})

test('unqualified lifecycle operations cannot mutate or launch anything', async () => {
  for (const cmd of ['start', 'activate', 'update', 'rollback', 'uninstall']) await assert.rejects(main([cmd]), /qualification_required_no_runtime_or_data_changed/)
  await assert.rejects(main(['doctor', '--config', 'a', '--config', 'b']), /invalid_arguments/)
})

test('CLI diagnostics use bounded codes and a failing exit status', () => {
  const cli = fileURLToPath(new URL('./endpoint.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [cli, 'doctor', '--config', 'PRIVATE-NAS-TOKEN'], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.deepEqual(JSON.parse(result.stderr), { error: 'operation_failed' })
  assert.ok(!result.stderr.includes('PRIVATE-NAS-TOKEN'))
})
