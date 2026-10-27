import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { catalog, configure, digest, doctor, launchPlan, main, stageBundle, transferLocations, validateConfig, validateTransferConfiguration, verifyBundle } from './endpoint.mjs'
import { installedFixture, nativeInstalledFixture } from './test-support/installed-fixture.mjs'
import { deploymentReferences } from './deployment.mjs'

const apiBaseVectors = JSON.parse(await fs.readFile(new URL('./test-support/api-base-v1.json', import.meta.url)))
assert.equal(apiBaseVectors.contract, 'memoh.file-api-base.v1')
assert.equal(apiBaseVectors.cases.length, 30)

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

test('historical inventory verification does not qualify retired diagnostics', async t => {
  const f = await fixture(t)
  assert.ok((await verifyBundle(f.root, f.hash)).totalBytes < 16384)
  const result = await doctor(f.config, () => assert.fail('no retired dependency probe'))
  assert.equal(result.ready, false); assert.equal(result.mode, 'retired-history-only')
  assert.deepEqual(result.checks, [{ check: 'legacy_execution', state: 'blocked', code: 'legacy_execution_retired' }])
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
  for (const nasOrigin of ['http://example.test', 'https://user:secret@example.test', 'https://example.test/api/../other', 'https://example.test?token=secret', 'https://host.invalid']) assert.throws(() => validateConfig({ ...config, nasOrigin }), /https_origin_required/)
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

async function hostTemplate(t) {
  const f = await fixture(t)
  // Historical schema-1 input shape; never a published activation template.
  const template = { schema: 1, session: 'default' }
  for (const key of ['manifestSha256', 'nasOrigin', 'deviceId', 'runtimeId', 'instanceId']) template[key] = f.config[key]
  const input = path.join(f.base, 'references.json'), root = path.join(f.base, 'host Unicode 空格')
  await json(input, template); await fs.mkdir(path.join(root, 'config'), { recursive: true })
  return { ...f, template, input, hostRoot: root, output: path.join(root, 'config/endpoint.json') }
}

test('historical configure input preserves the original host layout without enabling execution', async t => {
  const f = await hostTemplate(t), before = await fs.readFile(f.input)
  // Exercise the actual CLI, including its deferred module import. No runtime
  // request or components are supplied; the foreground check is observation-only.
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./endpoint.mjs', import.meta.url)), 'configure', '--from', f.input, '--root', f.hostRoot], { encoding: 'utf8', timeout: 10000 })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(JSON.parse(child.stdout).state, 'references_saved')
  assert.deepEqual(JSON.parse(await fs.readFile(f.output)), deploymentReferences(f.hostRoot, f.template))
  assert.deepEqual(await fs.readdir(f.hostRoot), ['config'], 'configuration must not create component data or install anything')
  assert.deepEqual(await fs.readFile(f.input), before)
  const { ForegroundHost } = await import('./host.mjs')
  const host = new ForegroundHost({ root: f.hostRoot })
  try {
    await host.start()
    assert.equal(host.snapshot().configuration, 'loaded')
    assert.equal(host.snapshot().attention, null)
    assert.equal(host.snapshot().ready, false)
    assert.equal(host.runtime, null)
  } finally { await host.stop() }
})

test('configure changing a fresh root derives new references but never relocates existing data', async t => {
  const f = await hostTemplate(t)
  await main(['configure', '--from', f.input, '--root', f.hostRoot])
  const original = await fs.readFile(f.output), saved = JSON.parse(original)
  const task = path.join(saved.sourceRoot, 'original-task.json')
  await json(task, { unchanged: true })
  const next = path.join(f.base, 'other root'), output = path.join(next, 'config/endpoint.json')
  await fs.mkdir(path.dirname(output), { recursive: true })
  await main(['configure', '--from', f.input, '--root', next])
  assert.deepEqual(JSON.parse(await fs.readFile(output)), deploymentReferences(next, f.template))
  assert.deepEqual(await fs.readFile(f.output), original)
  assert.deepEqual(JSON.parse(await fs.readFile(task)), { unchanged: true })
  assert.deepEqual(await fs.readdir(next), ['config'])
  await assert.rejects(main(['configure', '--from', f.input, '--root', f.hostRoot]), { code: 'EEXIST' })
  const stale = path.join(f.base, 'stale-root'), staleOutput = path.join(stale, 'config/endpoint.json')
  await fs.mkdir(path.dirname(staleOutput), { recursive: true })
  await assert.rejects(main(['configure', '--from', f.output, '--root', stale]), /host_configuration_root_mismatch/)
  await assert.rejects(fs.stat(staleOutput), { code: 'ENOENT' })
})

test('configure host form rejects stale explicit paths, placeholders and ambiguous destinations before writing', async t => {
  const f = await hostTemplate(t)
  const expected = deploymentReferences(f.hostRoot, f.template)
  for (const key of ['bundleRoot', 'sourceRoot', 'herdrConfigRoot', 'herdrStateRoot', 'agenvoConfigDir', 'piConfigDir', 'transferConfigDir', 'transferStateDir']) {
    await json(f.input, { ...f.template, [key]: path.join(f.base, 'old-root') })
    await assert.rejects(main(['configure', '--from', f.input, '--root', f.hostRoot]), /host_configuration_root_mismatch/)
    await assert.rejects(fs.stat(f.output), { code: 'ENOENT' })
  }
  await json(f.input, { ...f.template, manifestSha256: 'REPLACE_WITH_TRUSTED_MANIFEST_SHA256' })
  await assert.rejects(main(['configure', '--from', f.input, '--root', f.hostRoot]), /deployment_manifest_hash_required/)
  const invalid = spawnSync(process.execPath, [fileURLToPath(new URL('./endpoint.mjs', import.meta.url)), 'configure', '--from', f.input, '--root', f.hostRoot], { encoding: 'utf8', timeout: 10000 })
  assert.equal(invalid.status, 2)
  assert.deepEqual(JSON.parse(invalid.stderr), { error: 'deployment_manifest_hash_required' })
  await json(f.input, expected)
  await assert.rejects(main(['configure', '--from', f.input, '--root', f.hostRoot, '--config', f.output]), /invalid_arguments/)
  await assert.rejects(main(['configure', '--from', f.input]), /invalid_arguments/)
  await main(['configure', '--from', f.input, '--root', f.hostRoot])
  assert.deepEqual(JSON.parse(await fs.readFile(f.output)), expected)
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
  const f = await nativeInstalledFixture(t)
  const plan = launchPlan(f.config)
  assert.equal(plan.activation, 'blocked')
  assert.equal(plan.commands.length, 2)
  assert.deepEqual(plan.commands[0].args, ['--session', f.config.session, 'server'])
  assert.equal(plan.commands[1].args[1], 'run')
  for (const cmd of plan.commands) assert.ok(path.isAbsolute(cmd.file))
  assert.ok(plan.environment.PATH.startsWith(path.dirname(f.config.programs.node)))
  assert.ok(!plan.environment.PATH.includes('/usr/local/bin'))
  assert.equal(plan.environment.XDG_STATE_HOME, path.dirname(f.config.herdrStateRoot))
})

test('unqualified lifecycle operations cannot mutate or launch anything', async () => {
  for (const cmd of ['start', 'activate', 'update', 'rollback', 'uninstall']) await assert.rejects(main([cmd]), /qualification_required_no_runtime_or_data_changed/)
  await assert.rejects(main(['doctor', '--config', 'a', '--config', 'b']), /invalid_arguments/)
  assert.equal((await main(['help'])).commands.some(command => command.startsWith('transfer-budget ')), false)
  await assert.rejects(main(['transfer-budget', '--root', 'not-accessed', '--bytes', '8589934592']), /unknown_command/)
})

test('CLI diagnostics use bounded codes and a failing exit status', () => {
  const cli = fileURLToPath(new URL('./endpoint.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [cli, 'doctor', '--config', 'PRIVATE-NAS-TOKEN'], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.deepEqual(JSON.parse(result.stderr), { error: 'operation_failed' })
  assert.ok(!result.stderr.includes('PRIVATE-NAS-TOKEN'))
})

test('transfer preflight binds existing roots and config without reading or repairing credentials', async t => {
  const f = await fixture(t)
  const file = path.join(f.config.transferConfigDir, 'transfer.json')
  await validateTransferConfiguration(f.config)
  const credential = path.join(f.config.transferConfigDir, 'device.credential')
  assert.equal(await fs.readFile(credential, 'utf8'), 'DO-NOT-DISCLOSE-OR-PARSE-ME')
  await json(file, { version: 1, origin: 'https://other.example.test', source_root: f.config.sourceRoot })
  await assert.rejects(validateTransferConfiguration(f.config), /transfer_configuration_mismatch/)
  await json(file, { version: 1, origin: f.config.nasOrigin, source_root: f.config.sourceRoot })
  await fs.unlink(credential)
  await assert.rejects(validateTransferConfiguration(f.config), /transfer_credential_missing/)
  await assert.rejects(fs.stat(credential), { code: 'ENOENT' })
})

async function apiBaseFixture(t, schema) {
  const f = schema === 1 ? await fixture(t) : await installedFixture(t)
  if (schema === 2) f.config.transfer = { pluginRoot: path.join(f.base, 'existing-plugin'), nasOrigin: 'https://nas.example.test' }
  return { ...f, setBase(value) { (schema === 1 ? f.config : f.config.transfer).nasOrigin = value } }
}
for (const schema of [1, 2]) {
  test(`schema ${schema} configure reports the existing optional producer policy location without rewriting it or the queue`, async t => {
    const f = await apiBaseFixture(t, schema), locations = transferLocations(f.config)
    const input = path.join(f.base, 'network-input.json'), output = path.join(f.base, 'network-references.json')
    await json(input, f.config)
    const first = await configure(input, output)
    assert.equal(first.transferConfiguration.directory, locations.config)
    const policy = path.join(locations.config, 'transfer-network.json')
    assert.equal(first.transferConfiguration.networkPolicyFile, policy)
    assert.equal(first.transferConfiguration.validation, 'producer_on_invoke')
    await assert.rejects(fs.access(policy), { code: 'ENOENT' })
    for (const dir of [locations.config, locations.state]) await fs.mkdir(dir, { recursive: true })
    const files = new Map([
      [policy, '{"version":1,"lan_addresses":["192.0.2.1","2001:db8::1"]}\r\n'],
      [path.join(locations.config, 'transfer.json'), '{"version":1,"origin":"https://NAS.example.test:443/api/"}\n'],
      [path.join(locations.state, 'existing.journal'), 'OPAQUE EXISTING QUEUE BYTES'],
    ])
    for (const [name, raw] of files) await fs.writeFile(name, raw)
    await configure(input, path.join(f.base, 'another-reference.json'))
    for (const [name, raw] of files) assert.equal(await fs.readFile(name, 'utf8'), raw)
    assert.deepEqual(JSON.parse(await fs.readFile(output)), f.config)
  })

  test(`schema ${schema} adopts all shared API base vectors without normalization`, async t => {
    const f = await apiBaseFixture(t, schema)
    for (const vector of apiBaseVectors.cases) await t.test(vector.name, () => {
      f.setBase(vector.input)
      const before = JSON.stringify(f.config)
      if (vector.accepted) {
        assert.equal(validateConfig(f.config), f.config)
        assert.equal(transferLocations(f.config).origin, vector.input)
      } else assert.throws(() => validateConfig(f.config), { code: 'https_origin_required' })
      assert.equal(JSON.stringify(f.config), before)
    })
  })
  test(`schema ${schema} API base retains destination restriction and bounded unambiguous parsing`, async t => {
    const f = await apiBaseFixture(t, schema)
    for (const base of ['https://host.invalid/api', 'https://HOST.INVALID:8443/api', 'https://@nas.example.test/api', 'https://nas.example.test/\tapi', 'https://nas.example.test/☃', `https://nas.example.test/${'x'.repeat(2048)}`]) {
      f.setBase(base)
      assert.throws(() => validateConfig(f.config), { code: 'https_origin_required' })
    }
  })
  test(`schema ${schema} API base preflight preserves exact producer config binding and existing journal bytes`, async t => {
    const f = await apiBaseFixture(t, schema), base = 'https://NAS.example.test:443/memoh/api/'
    f.setBase(base)
    const locations = transferLocations(f.config)
    for (const dir of [locations.config, locations.state]) await fs.mkdir(dir, { recursive: true })
    const file = path.join(locations.config, 'transfer.json'), journal = path.join(locations.state, 'existing-journal')
    const raw = Buffer.from(`${JSON.stringify({ source_root: f.config.sourceRoot, origin: base, version: 1 }, null, 2)}\r\n`)
    const evidence = Buffer.from('OPAQUE EXISTING JOURNAL; PREFLIGHT MUST NOT REWRITE')
    await fs.writeFile(file, raw); await fs.writeFile(journal, evidence)
    await fs.writeFile(path.join(locations.config, 'device.credential'), 'SYNTHETIC UNREAD')
    const binding = await digest(file)
    await validateTransferConfiguration(f.config)
    const input = path.join(f.base, 'api-input.json'), output = path.join(f.base, 'api-configured.json')
    await json(input, f.config); await configure(input, output)
    assert.equal(transferLocations(JSON.parse(await fs.readFile(output))).origin, base)
    // Equivalent URL spellings are still different persisted bindings. A new
    // endpoint reference must not silently rewrite an existing producer queue.
    for (const changed of [base.slice(0, -1), 'https://nas.example.test/memoh/api/', 'https://nas.example.test']) {
      f.setBase(changed)
      await assert.rejects(validateTransferConfiguration(f.config), { code: 'transfer_configuration_mismatch' })
      assert.equal(await digest(file), binding)
      assert.deepEqual(await fs.readFile(file), raw)
      assert.deepEqual(await fs.readFile(journal), evidence)
    }
    f.setBase(base)
    await validateTransferConfiguration(f.config)
    assert.equal(await digest(file), binding)
  })
}
