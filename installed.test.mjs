import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { inspectInstalled, inspectInstalledTransfer, compareProducerTarget } from './installed.mjs'
import { catalog, digest, validateConfig, managedEnvironment, programPaths, configure, transferLocations, transferEnvironment } from './endpoint.mjs'
import { validateRuntimeRequest, createExplicitRuntime } from './runtime.mjs'
import { NativeDriver, LifecycleError, leaseKeys } from './lifecycle.mjs'
import { transferCommand } from './transfer-lifecycle.mjs'
import { installedFixture } from './test-support/installed-fixture.mjs'

test('references inspect existing programs without a bundle, credential copy or user version manifest', async t => {
  const f = await installedFixture(t), before = await fs.readFile(path.join(f.config.piConfigDir, 'auth.json'))
  const inspected = await inspectInstalled(f.config, f.run)
  assert.equal(inspected.versions.herdr, '0.9.5'); assert.equal(inspected.versions.pi, '1.2.0')
  assert.equal(f.config.bundleRoot, undefined); assert.equal(f.config.manifestSha256, undefined)
  assert.deepEqual(await fs.readFile(path.join(f.config.piConfigDir, 'auth.json')), before)
  assert.equal(f.calls.length, 8)
  assert.equal(compareProducerTarget(f.config, f.target).state, 'configuration_matches')
  const destination = path.join(f.base, 'endpoint.json')
  await f.write(path.join(f.base, 'input.json'), JSON.stringify(f.config))
  await configure(path.join(f.base, 'input.json'), destination)
  assert.deepEqual(JSON.parse(await fs.readFile(destination)), f.config)
})
test('omitted Herdr path resolves only from the selected official instance without saving a second path', async t => {
  const f = await installedFixture(t), file = path.join(f.config.agenvoConfigDir, 'config.json')
  delete f.config.programs.herdr
  const before = await fs.readFile(file), input = JSON.stringify(f.config)
  const inspected = await inspectInstalled(f.config, f.run)
  assert.equal(inspected.herdrSource, 'agenvo_instance'); assert.equal(inspected.config.programs.herdr, f.p.herdr)
  assert.equal(JSON.stringify(f.config), input); assert.deepEqual(await fs.readFile(file), before)
  assert.throws(() => managedEnvironment(f.config), { code: 'herdr_reference_unresolved' })
  const runtime = await createExplicitRuntime({ config: f.config, stateDirectory: path.join(f.base, 'endpoint'), request: { schema: 2, mode: 'existing-installations', transfer: 'disabled' } })
  assert.equal(runtime.driver.herdr, f.p.herdr); assert.equal(runtime.driver.children.size, 0)
  const destination = path.join(f.base, 'endpoint.json')
  await f.write(path.join(f.base, 'input.json'), input)
  await configure(path.join(f.base, 'input.json'), destination)
  assert.equal(JSON.parse(await fs.readFile(destination)).programs.herdr, undefined)
})
test('official instance binary changes are frozen during a run and followed by a fresh check without editing endpoint config', async t => {
  const f = await installedFixture(t), file = path.join(f.config.agenvoConfigDir, 'config.json')
  delete f.config.programs.herdr
  const endpointBefore = JSON.stringify(f.config), inspected = await inspectInstalled(f.config, f.run)
  const previous = f.p.herdr, next = path.join(f.base, 'next-official-release/herdr.exe')
  await f.write(next, 'INERT NEXT OFFICIAL RELEASE')
  f.connector.instances[0].binary = next
  await fs.writeFile(file, JSON.stringify(f.connector))
  assert.throws(inspected.assertUnchanged, { code: 'installation_changed_restart_required' })
  inspected.assertUnchanged('connector') // unchanged connector cleanup is retained
  assert.equal(inspected.config.programs.herdr, previous)
  f.p.herdr = next; f.versions.herdr = '0.9.6'
  const rechecked = await inspectInstalled(f.config, f.run)
  assert.equal(rechecked.config.programs.herdr, next); assert.equal(rechecked.versions.herdr, '0.9.6')
  assert.equal(JSON.stringify(f.config), endpointBefore)
  assert.equal(JSON.parse(await fs.readFile(file)).instances[0].id, f.config.instanceId)
  assert.equal(await fs.readFile(previous, 'utf8'), 'INERT SYNTHETIC PROGRAM; NEVER EXECUTE')
})
test('legacy explicit Herdr references keep equality semantics and can migrate by removing only the duplicate path', async t => {
  const f = await installedFixture(t), file = path.join(f.config.agenvoConfigDir, 'config.json')
  assert.equal((await inspectInstalled(f.config, f.run)).herdrSource, 'legacy_explicit_match')
  const next = path.join(f.base, 'new-location/herdr.exe')
  await f.write(next, 'INERT NEW LOCATION'); f.connector.instances[0].binary = next
  await fs.writeFile(file, JSON.stringify(f.connector))
  await assert.rejects(inspectInstalled(f.config, f.run), { code: 'runtime_approved_path_mismatch' })
  delete f.config.programs.herdr; f.p.herdr = next
  assert.equal((await inspectInstalled(f.config, f.run)).config.programs.herdr, next)
})
test('single-instance resolution rejects ambiguous, mismatched and unsafe official mappings before probes', async t => {
  const f = await installedFixture(t), file = path.join(f.config.agenvoConfigDir, 'config.json')
  delete f.config.programs.herdr
  const i = f.connector.instances[0]
  for (const connector of [
    { ...f.connector, instances: [] }, { ...f.connector, instances: [i, { ...i, id: 'other' }] },
    { ...f.connector, deviceId: '33333333-3333-4333-8333-333333333333' },
    ...[{ ...i, id: 'other' }, { ...i, kind: 'other' }, { ...i, cwd: f.base }, { ...i, binary: 'herdr.exe' }, { ...i, binary: path.join(f.config.sourceRoot, 'herdr.exe') }].map(instance => ({ ...f.connector, instances: [instance] })),
  ]) {
    await fs.writeFile(file, JSON.stringify(connector)); await assert.rejects(inspectInstalled(f.config, f.run))
  }
  assert.equal(f.calls.length, 0)
})
test('official compatible version changes are redetected on a fresh check without editing an approval list', async t => {
  const f = await installedFixture(t), first = await inspectInstalled(f.config, f.run)
  f.versions.herdr = '0.9.6'; f.versions.pi = '1.3.0'
  await f.write(f.p.herdr, 'UPDATED INERT OFFICIAL PROGRAM FIXTURE')
  await f.write(path.join(f.config.programs.piPackage, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.3.0' }))
  assert.throws(first.assertUnchanged, { code: 'installation_changed_restart_required' })
  first.assertUnchanged('connector') // unchanged connector cleanup remains possible
  const next = await inspectInstalled(f.config, f.run)
  assert.equal(next.versions.herdr, '0.9.6'); assert.equal(next.versions.pi, '1.3.0')
  assert.notEqual(next.hashes.herdr, first.hashes.herdr)
})
test('same-version replacement and package closure changes suspend a running installation', async t => {
  const f = await installedFixture(t), first = await inspectInstalled(f.config, f.run)
  await f.write(path.join(f.config.programs.piPackage, 'new-helper.js'), 'NEW INERT CODE')
  assert.throws(first.assertUnchanged, { code: 'installation_changed_restart_required' })
  const next = await inspectInstalled(f.config, f.run)
  await f.write(f.p.pi, 'REPLACED SAME VERSION')
  assert.throws(next.assertUnchanged, { code: 'installation_changed_restart_required' })
})
test('official Herdr current rotation is detected even when the old release bytes are unchanged', async t => {
  const f = await installedFixture(t), standalone = path.join(f.base, 'official-herdr/packages/standalone')
  const release = path.join(standalone, 'releases/0.9.5-windows-x86_64')
  f.config.programs.herdr = path.join(release, 'herdr.exe'); f.p.herdr = f.config.programs.herdr
  await f.write(f.p.herdr, 'INERT OLD RELEASE')
  f.connector.instances[0].binary = f.p.herdr
  await f.write(path.join(f.config.agenvoConfigDir, 'config.json'), JSON.stringify(f.connector))
  const current = path.join(standalone, 'current')
  await fs.symlink(release, current, 'junction')
  const first = await inspectInstalled(f.config, f.run), calls = f.calls.length
  const next = path.join(standalone, 'releases/0.9.6-windows-x86_64')
  await f.write(path.join(next, 'herdr.exe'), 'INERT NEW RELEASE')
  await fs.unlink(current); await fs.symlink(next, current, 'junction')
  assert.throws(first.assertUnchanged, { code: 'installation_changed_restart_required' })
  first.assertUnchanged('connector')
  await assert.rejects(inspectInstalled(f.config, f.run), { code: 'herdr_active_installation_changed' })
  assert.equal(f.calls.length, calls)
  assert.equal(await fs.readFile(f.p.herdr, 'utf8'), 'INERT OLD RELEASE')
  assert.equal(JSON.parse(await fs.readFile(path.join(f.config.agenvoConfigDir, 'config.json'))).instances[0].binary, f.p.herdr)
  await fs.unlink(current); await fs.symlink(f.config.sourceRoot, current, 'junction')
  await assert.rejects(inspectInstalled(f.config, f.run), { code: 'herdr_active_installation_invalid' })
})
test('unsafe or missing references fail before any program is invoked', async t => {
  const f = await installedFixture(t)
  assert.throws(() => validateConfig({ ...f.config, session: 'default' }), { code: 'dedicated_session_required' })
  assert.throws(() => validateConfig({ ...f.config, piConfigDir: f.config.programs.piPackage }), { code: 'data_program_overlap' })
  assert.throws(() => validateConfig({ ...f.config, piConfigDir: f.config.sourceRoot }), { code: 'component_data_overlap' })
  await fs.rm(f.p.herdr)
  await assert.rejects(inspectInstalled(f.config, f.run), { code: 'ENOENT' })
  assert.equal(f.calls.length, 0)
})
test('foreign package and existing historical session reject before version probes or state mutation', async t => {
  const f = await installedFixture(t)
  const session = path.join(f.config.herdrConfigRoot, 'sessions', f.config.session, 'session.json')
  const original = JSON.stringify({ version: 3, workspaces: [{ id: 'existing-user-work' }] })
  await f.write(session, original)
  await assert.rejects(inspectInstalled(f.config, f.run), { code: 'existing_herdr_session_requires_handoff' })
  assert.equal(f.calls.length, 0); assert.equal(await fs.readFile(session, 'utf8'), original)
  await fs.rm(session)
  await f.write(path.join(f.config.programs.piPackage, 'package.json'), '{"name":"different-program","version":"1.2.0"}')
  await assert.rejects(inspectInstalled(f.config, f.run), { code: 'installation_package_mismatch' })
  assert.equal(f.calls.length, 0)
})
test('necessary CLI flags, launcher resolution and minimum version are checked', async t => {
  const f = await installedFixture(t)
  await assert.rejects(inspectInstalled(f.config, (file, args, env) => args.includes('--help') && file === f.p.node ? '--mode' : f.run(file, args, env)), { code: 'installation_pi_protocol_missing' })
  await assert.rejects(inspectInstalled(f.config, (file, args, env) => file === f.p.git ? 'different-pi\n1.2.0' : f.run(file, args, env)), { code: 'installation_pi_resolution_mismatch' })
  f.versions.node = '22.0.0'
  await assert.rejects(inspectInstalled(f.config, f.run), { code: 'installation_version_too_old' })
})

test('a launcher for another Pi package and a sibling Node cannot silently override selected programs', async t => {
  const f = await installedFixture(t), launcher = path.join(f.p.piBin, 'pi')
  const original = await fs.readFile(launcher)
  await f.write(launcher, '# $basedir/different-package/cli.js')
  await assert.rejects(inspectInstalled(f.config, f.run), { code: 'installation_pi_launcher_mismatch' })
  assert.equal(f.calls.length, 0)
  await fs.writeFile(launcher, original)
  await f.write(path.join(f.p.piBin, 'node.exe'), 'INERT OTHER NODE')
  await assert.rejects(inspectInstalled(f.config, f.run), { code: 'installation_node_resolution_mismatch' })
  assert.equal(f.calls.length, 0)
})
test('producer existing target profile mismatch cannot be called a shared task chain', async t => {
  const f = await installedFixture(t)
  for (const target of [{ ...f.target, bash_path: f.p.node }, { ...f.target, session: 'default' }, { ...f.target, agent: { ...f.target.agent, config_dir: f.config.sourceRoot } }, { ...f.target, agent: { ...f.target.agent, path: 'foreign-path' } }]) assert.throws(() => compareProducerTarget(f.config, target))
  assert.equal(compareProducerTarget(f.config, { ...f.target, agent: { ...f.target.agent, path: managedEnvironment(f.config).PATH } }).state, 'configuration_matches')
})
test('native driver uses referenced paths and changed programs fail before invoking status', async t => {
  const f = await installedFixture(t), p = programPaths(f.config)
  const driver = new NativeDriver(f.config, { checkPrograms: () => { throw new LifecycleError('installation_changed_restart_required') } })
  assert.equal(driver.herdr, p.herdr); assert.equal(driver.node, p.node); assert.equal(driver.connector, p.connector)
  assert.throws(() => driver.hostStatus(), { code: 'installation_changed_restart_required' })
  await assert.rejects(driver.observeHostStatus(), { code: 'installation_changed_restart_required' })
  assert.equal(driver.children.size, 0)
})
test('reference activation is explicit and transfer cannot be enabled through an unqualified mode', async t => {
  const f = await installedFixture(t), request = { schema: 2, mode: 'existing-installations', transfer: 'disabled' }
  assert.deepEqual(validateRuntimeRequest(request, f.config), request)
  for (const changed of [{ ...request, transfer: 'existing-queue' }, { ...request, command: 'anything' }, { ...request, mode: 'automatic' }]) assert.throws(() => validateRuntimeRequest(changed, f.config))
  const runtime = await createExplicitRuntime({ config: f.config, stateDirectory: path.join(f.base, 'endpoint'), request })
  assert.equal(runtime.transfer, null); assert.equal(runtime.driver.children.size, 0)
})

async function installedTransferFixture(t) {
  const f = await installedFixture(t)
  f.config.transfer = { pluginRoot: path.join(f.base, 'existing-delivery-plugin'), nasOrigin: 'https://nas.example.test' }
  const locations = transferLocations(f.config)
  for (const directory of [locations.root, locations.config, locations.state]) await fs.mkdir(directory, { recursive: true })
  const files = []
  for (const name of ['README.md', 'herdr-plugin.toml', 'transfer.example.json', 'transferqueue-cli.test.exe', 'transferqueue.exe', 'transferqueue.test.exe', 'verify-fixtures.ps1']) {
    const file = path.join(locations.root, name)
    await fs.writeFile(file, `INERT SYNTHETIC PRODUCER: ${name}`)
    files.push({ name, sha256: await digest(file) })
  }
  const proof = { source_commit: catalog.components.transfer.revision, arch: 'amd64', files }
  const proofFile = path.join(locations.root, 'SHA256SUMS.json')
  await fs.writeFile(proofFile, JSON.stringify(proof))
  await f.write(path.join(locations.config, 'transfer.json'), JSON.stringify({ version: 1, origin: locations.origin, source_root: f.config.sourceRoot }))
  await f.write(path.join(locations.config, 'device.credential'), 'SYNTHETIC UNREAD')
  const registryFile = path.join(f.config.herdrConfigRoot, 'plugins.json')
  const registry = [{ plugin_id: 'memoh.delivery', enabled: true, version: catalog.components.transfer.version, plugin_root: locations.root, manifest_path: path.join(locations.root, 'herdr-plugin.toml') }]
  await f.write(registryFile, JSON.stringify(registry))
  return { ...f, locations, proof, proofFile, registry, registryFile }
}
test('reference mode shares the registered producer paths and lease without another bundle or queue', async t => {
  const f = await installedTransferFixture(t), request = { schema: 2, mode: 'existing-installations', transfer: 'existing-queue' }
  const journal = path.join(f.locations.state, 'untouched-user-journal')
  await fs.writeFile(journal, 'KEEP EXISTING QUEUE EVIDENCE')
  const checked = await inspectInstalledTransfer(f.config)
  assert.equal(checked.source, catalog.components.transfer.revision)
  assert.deepEqual(transferCommand(f.config, 'advance-results'), { file: path.join(f.locations.root, 'transferqueue.exe'), args: ['-action', 'advance-results'] })
  const env = transferEnvironment(f.config)
  assert.equal(env.HERDR_PLUGIN_CONFIG_DIR, f.locations.config); assert.equal(env.HERDR_PLUGIN_STATE_DIR, f.locations.state)
  assert.ok(leaseKeys(f.config).includes(`transfer:${f.locations.state}`))
  const runtime = await createExplicitRuntime({ config: f.config, stateDirectory: path.join(f.base, 'endpoint'), request })
  assert.equal(runtime.transfer.state, 'stopped'); assert.equal(runtime.driver.children.size, 0)
  assert.equal(await fs.readFile(journal, 'utf8'), 'KEEP EXISTING QUEUE EVIDENCE')
  assert.equal(f.calls.length, 0)
})
test('external producer reference rejects source, architecture, duplicate receipt and payload mismatch', async t => {
  const f = await installedTransferFixture(t)
  for (const proof of [{ ...f.proof, source_commit: '0'.repeat(40) }, { ...f.proof, arch: 'arm64' }, { ...f.proof, files: f.proof.files.map(() => f.proof.files[0]) }]) {
    await fs.writeFile(f.proofFile, JSON.stringify(proof))
    await assert.rejects(inspectInstalledTransfer(f.config), { code: 'transfer_provenance_mismatch' })
  }
  await fs.writeFile(f.proofFile, JSON.stringify(f.proof))
  await fs.appendFile(path.join(f.locations.root, 'transferqueue.exe'), 'CHANGED')
  await assert.rejects(inspectInstalledTransfer(f.config), { code: 'transfer_payload_changed' })
})
test('missing producer input and changed plugin registration fail before any work', async t => {
  const f = await installedTransferFixture(t), credential = path.join(f.locations.config, 'device.credential')
  await fs.rm(credential)
  await assert.rejects(inspectInstalledTransfer(f.config), { code: 'transfer_credential_missing' })
  await fs.writeFile(credential, 'SYNTHETIC')
  const checked = await inspectInstalledTransfer(f.config)
  await fs.writeFile(f.registryFile, JSON.stringify([{ ...f.registry[0], plugin_root: f.base }]))
  await assert.rejects(checked.assertUnchanged(), { code: 'runtime_transfer_mapping_changed' })
  await assert.rejects(inspectInstalledTransfer(f.config), { code: 'runtime_transfer_mapping_invalid' })
  assert.equal(f.calls.length, 0)
})
test('a running consumer cannot silently accept a replaced package or new self-consistent receipt', async t => {
  const f = await installedTransferFixture(t), checked = await inspectInstalledTransfer(f.config)
  const file = path.join(f.locations.root, 'transferqueue.exe')
  await fs.writeFile(file, 'OTHER INERT BINARY')
  await assert.rejects(checked.assertUnchanged(), { code: 'transfer_payload_changed' })
  f.proof.files.find(f => f.name === 'transferqueue.exe').sha256 = await digest(file)
  await fs.writeFile(f.proofFile, JSON.stringify(f.proof))
  await assert.rejects(checked.assertUnchanged(), { code: 'transfer_payload_changed' })
})
test('external transfer roots preserve data boundaries and existing configuration agreement', async t => {
  const f = await installedTransferFixture(t)
  assert.throws(() => validateConfig({ ...f.config, transfer: { ...f.config.transfer, pluginRoot: f.config.sourceRoot } }), { code: 'data_program_overlap' })
  assert.throws(() => validateConfig({ ...f.config, transfer: { ...f.config.transfer, nasOrigin: 'http://nas.example.test' } }), { code: 'https_origin_required' })
  await fs.writeFile(path.join(f.locations.config, 'transfer.json'), JSON.stringify({ version: 1, origin: f.locations.origin, source_root: f.base }))
  await assert.rejects(inspectInstalledTransfer(f.config), { code: 'transfer_configuration_mismatch' })
})
