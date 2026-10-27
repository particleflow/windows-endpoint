import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { inspectInstalled, inspectInstalledTransfer, compareProducerTarget, validateInstalledConfiguration, installedDoctor } from './installed.mjs'
import { catalog, digest, validateConfig, managedEnvironment, programPaths, configure, main, transferLocations, transferEnvironment, validateTransferConfiguration, componentRoots, connectorConfigReference, installationReferences, launchPlan } from './endpoint.mjs'
import { validateRuntimeRequest, createExplicitRuntime } from './runtime.mjs'
import { NativeDriver, LifecycleError, leaseKeys } from './lifecycle.mjs'
import { transferCommand, NativeTransferDriver } from './transfer-lifecycle.mjs'
import { captureSessionContinuation, verifySessionContinuation } from './session-continuation.mjs'
import { installedFixture, nativeInstalledFixture } from './test-support/installed-fixture.mjs'
import { deploymentReferences } from './deployment.mjs'

test('owned component exit and stderr byte evidence survives replacement without recording private stderr', async t => {
  const f = await nativeInstalledFixture(t)
  f.config.programs.node = process.execPath
  await f.write(path.join(path.dirname(f.p.connector), 'endpoint-host-api.mjs'), "export class RuntimeSession {}; export const formatCLIError = e => e.message; export function runCLI() { process.stderr.write('SYNTHETIC-PRIVATE-COMPONENT-TEXT'); console.log('stopped'); return Promise.resolve(7) }\n")
  const driver = new NativeDriver(f.config)
  await driver.start('connector')
  const first = driver.nativeConnector.record
  await first.done
  const recorded = driver.diagnostics()[0]
  assert.equal(recorded.exitCode, 7); assert.equal(recorded.exitObserved, true)
  assert.equal(recorded.stderrBytes, Buffer.byteLength('SYNTHETIC-PRIVATE-COMPONENT-TEXT'))
  assert.equal(recorded.stderrCode, 'native_runtime_failed')
  await driver.start('connector'); await driver.nativeConnector.record.done
  const second = driver.diagnostics()[0]
  const { previousExit, ...prior } = recorded
  assert.equal(previousExit, null); assert.notEqual(second.pid, recorded.pid); assert.deepEqual(second.previousExit, prior)
  assert.equal(JSON.stringify(second).includes('SYNTHETIC-PRIVATE'), false)
})

test('native declarations require one registered Runtime UUID without rewriting an identity mismatch', async t => {
  const f = await nativeInstalledFixture(t)
  assert.equal(f.config.deviceId, f.config.runtimeId)
  assert.equal(validateConfig(f.config), f.config)
  const mismatch = { ...f.config, runtimeId: randomUUID() }, raw = JSON.stringify(mismatch)
  assert.throws(() => validateConfig(mismatch), { code: 'native_runtime_identity_mismatch' })
  assert.equal(JSON.stringify(mismatch), raw)
})

test('legacy schema1 and schema2 retain their distinct device and Runtime declarations', async t => {
  const f = await installedFixture(t)
  assert.notEqual(f.config.deviceId, f.config.runtimeId)
  assert.equal(validateConfig(f.config), f.config)
  const legacy = deploymentReferences(path.join(f.base, 'legacy-host'), {
    manifestSha256: 'a'.repeat(64), nasOrigin: 'https://nas.example.test',
    deviceId: f.config.deviceId, runtimeId: f.config.runtimeId, instanceId: f.config.instanceId, session: f.config.session,
  })
  assert.equal(legacy.schema, 1)
  assert.equal(legacy.deviceId, f.config.deviceId); assert.equal(legacy.runtimeId, f.config.runtimeId)
  assert.equal(validateConfig(legacy), legacy)
})

test('native Runtime references retain official programs and external state without reading enrollment or copying configuration', async t => {
  const f = await nativeInstalledFixture(t), original = JSON.stringify(f.config)
  const protectedFiles = [f.config.connector.enrollmentFile, path.join(f.config.piConfigDir, 'auth.json'), path.join(f.config.herdrConfigRoot, 'config.toml')]
  const before = await Promise.all(protectedFiles.map(file => fs.readFile(file)))
  const inspected = await inspectInstalled(f.config, f.run)
  assert.equal(inspected.versions.connector, '0.22.0')
  assert.equal(inspected.herdrSource, 'explicit_official_installation')
  assert.equal(connectorConfigReference(f.config), f.config.connector.enrollmentFile)
  assert.equal(componentRoots(f.config).length, 4)
  assert.equal(componentRoots(f.config).includes(undefined), false)
  assert.equal(installationReferences(f.config).includes(f.config.connector.enrollmentFile), true)
  const env = managedEnvironment(f.config, { MEMOH_RUNTIME_KEY: 'SYNTHETIC MUST NOT INHERIT', MEMOH_RUNTIME_CONFIG: 'OTHER', AGENVO_CONFIG_DIR: 'OTHER' })
  assert.equal(env.MEMOH_RUNTIME_KEY, undefined); assert.equal(env.MEMOH_RUNTIME_CONFIG, undefined); assert.equal(env.AGENVO_CONFIG_DIR, undefined)
  assert.equal(env.PI_CODING_AGENT_DIR, f.config.piConfigDir)
  assert.deepEqual(launchPlan(f.config).commands[1].args, [f.p.connector, 'run', '--config', f.config.connector.enrollmentFile])
  const root = path.join(f.base, 'host'), input = path.join(f.base, 'input.json')
  await fs.mkdir(path.join(root, 'config'), { recursive: true }); await f.write(input, original)
  await configure(input, undefined, root)
  assert.equal(JSON.stringify(JSON.parse(await fs.readFile(path.join(root, 'config/endpoint.json')))), original)
  assert.deepEqual(await Promise.all(protectedFiles.map(file => fs.readFile(file))), before)
  assert.equal(JSON.stringify(f.config), original)
})

test('native preflight requires a safe existing enrollment and suspends same-run enrollment changes', async t => {
  const f = await nativeInstalledFixture(t), file = f.config.connector.enrollmentFile
  const first = await inspectInstalled(f.config, f.run)
  await fs.appendFile(file, ' CHANGED')
  assert.throws(first.assertUnchanged, { code: 'installation_changed_restart_required' })
  first.assertUnchanged('connector') // ownership-bound cleanup never reads replacement credentials
  await fs.writeFile(file, '')
  await assert.rejects(inspectInstalled(f.config, f.run), { code: 'connector_authentication_required' })
  await fs.rm(file)
  await assert.rejects(inspectInstalled(f.config, f.run), { code: 'connector_authentication_required' })
  for (const invalid of [
    { ...f.config, agenvoConfigDir: path.join(f.base, 'legacy') },
    { ...f.config, connector: { ...f.config.connector, kind: 'unknown' } },
    { ...f.config, connector: { ...f.config.connector, enrollmentFile: path.join(f.config.sourceRoot, 'runtime.json') } },
    { ...f.config, connector: { ...f.config.connector, enrollmentFile: path.join(path.dirname(f.p.node), 'runtime.json') } },
  ]) assert.throws(() => validateConfig(invalid))
})

test('native candidate supplies its colocated Runtime without saving a version-specific package path', async t => {
  const f = await nativeInstalledFixture(t)
  delete f.config.programs.connectorPackage
  const original = JSON.stringify(f.config), selected = programPaths(validateConfig(f.config)).connector
  assert.equal(path.basename(selected), 'cli.mjs')
  assert.equal(path.basename(path.dirname(path.dirname(selected))), 'runtime-connector')
  const resolved = await validateInstalledConfiguration(f.config)
  assert.equal(resolved.config.programs.connectorPackage, path.dirname(path.dirname(selected)))
  assert.equal(JSON.stringify(f.config), original)
  assert.equal(installationReferences(f.config).includes(resolved.config.programs.connectorPackage), false, 'colocated code is not an external installation reference')
  const input = path.join(f.base, 'input.json'), destination = path.join(f.base, 'endpoint.json')
  await f.write(input, original); await configure(input, destination)
  assert.equal(JSON.parse(await fs.readFile(destination)).programs.connectorPackage, undefined)
})

test('native mode follows only official current selection on fresh check while freezing a running generation', async t => {
  const f = await nativeInstalledFixture(t), standalone = path.join(f.base, 'official-herdr/packages/standalone')
  const firstRelease = path.join(standalone, 'releases/0.9.5-windows-x86_64'), secondRelease = path.join(standalone, 'releases/0.9.6-windows-x86_64')
  f.config.programs.herdr = path.join(firstRelease, 'herdr.exe'); f.p.herdr = f.config.programs.herdr
  await f.write(f.p.herdr, 'INERT OLD RELEASE'); await f.write(path.join(secondRelease, 'herdr.exe'), 'INERT NEW RELEASE')
  const current = path.join(standalone, 'current'), before = JSON.stringify(f.config)
  await fs.symlink(firstRelease, current, 'junction')
  const first = await inspectInstalled(f.config, f.run)
  await fs.unlink(current); await fs.symlink(secondRelease, current, 'junction')
  assert.throws(first.assertUnchanged, { code: 'installation_changed_restart_required' })
  first.assertUnchanged('connector')
  f.p.herdr = path.join(secondRelease, 'herdr.exe'); f.versions.herdr = '0.9.6'
  const rechecked = await inspectInstalled(f.config, f.run)
  assert.equal(rechecked.herdrSource, 'official_current_selection'); assert.equal(rechecked.config.programs.herdr, f.p.herdr)
  assert.equal(rechecked.versions.herdr, '0.9.6'); assert.equal(JSON.stringify(f.config), before)
  assert.equal(await fs.readFile(f.config.programs.herdr, 'utf8'), 'INERT OLD RELEASE')
  const calls = f.calls.length
  await fs.unlink(current); await fs.symlink(f.config.sourceRoot, current, 'junction')
  await assert.rejects(inspectInstalled(f.config, f.run), { code: 'herdr_active_installation_invalid' })
  assert.equal(f.calls.length, calls)
})

test('native Runtime package and foreground protocol must match before being considered locally verified', async t => {
  const f = await nativeInstalledFixture(t)
  await assert.rejects(inspectInstalled(f.config, (file, args, env) => args[0] === f.p.connector && args[1] === 'run' ? '--config' : f.run(file, args, env)), { code: 'installation_connector_protocol_invalid' })
  await f.write(path.join(f.config.programs.connectorPackage, 'package.json'), JSON.stringify({ name: '@agenvo/herdr', version: '0.22.0' }))
  await assert.rejects(inspectInstalled(f.config, f.run), { code: 'installation_package_mismatch' })
})

test('native startup rejects a CLI-only package instead of silently advertising the user home', async t => {
  const f = await nativeInstalledFixture(t)
  await fs.unlink(path.join(path.dirname(f.p.connector), 'endpoint-host-api.mjs'))
  const before = await fs.readFile(f.config.connector.enrollmentFile)
  await assert.rejects(inspectInstalled(f.config, f.run), { code: 'native_runtime_project_root_unsupported' })
  assert.equal(f.calls.length, 0)
  assert.deepEqual(await fs.readFile(f.config.connector.enrollmentFile), before)
})

test('native connection selection never imports an existing Herdr task or rewrites saved history', async t => {
  const f = await nativeInstalledFixture(t)
  const file = path.join(f.config.herdrConfigRoot, 'sessions', f.config.session, 'session.json')
  const history = JSON.stringify({ version: 3, workspaces: [{ id: 'original-workspace' }] })
  await f.write(file, history)
  await assert.rejects(inspectInstalled(f.config, f.run), { code: 'existing_herdr_session_requires_handoff' })
  assert.equal(f.calls.length, 0)
  assert.equal(await fs.readFile(file, 'utf8'), history)
  assert.equal((await validateInstalledConfiguration(f.config, { inspectHistoryOnly: true })).history.startup, 'requires_handoff')
})

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
  await assert.rejects(createExplicitRuntime({ config: f.config, stateDirectory: path.join(f.base, 'endpoint'), request: { schema: 2, mode: 'existing-installations', transfer: 'disabled' } }), { code: 'legacy_execution_retired' })
  const destination = path.join(f.base, 'endpoint.json')
  await f.write(path.join(f.base, 'input.json'), input)
  await configure(path.join(f.base, 'input.json'), destination)
  assert.equal(JSON.parse(await fs.readFile(destination)).programs.herdr, undefined)
})
test('configure host root preserves existing installation references and rejects host data overlap', async t => {
  const f = await installedFixture(t)
  delete f.config.programs.herdr
  const originalFiles = [path.join(f.config.agenvoConfigDir, 'config.json'), path.join(f.config.piConfigDir, 'auth.json'), path.join(f.config.herdrConfigRoot, 'config.toml')]
  const before = await Promise.all(originalFiles.map(file => fs.readFile(file)))
  const input = path.join(f.base, 'input.json'), root = path.join(f.base, 'host')
  await f.write(input, JSON.stringify(f.config)); await fs.mkdir(path.join(root, 'config'), { recursive: true })
  await main(['configure', '--from', input, '--root', root])
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'config/endpoint.json'))), f.config)
  assert.deepEqual(await fs.readdir(root), ['config'])
  assert.deepEqual(await Promise.all(originalFiles.map(file => fs.readFile(file))), before)
  assert.equal(f.calls.length, 0, 'configuration never probes or starts an official component')
  const second = path.join(f.base, 'next-host')
  await fs.mkdir(path.join(second, 'config'), { recursive: true })
  await f.write(input, JSON.stringify({ ...f.config, sourceRoot: path.join(second, 'data/endpoint') }))
  await assert.rejects(main(['configure', '--from', input, '--root', second]), /host_reference_overlap/)
  await assert.rejects(fs.stat(path.join(second, 'config/endpoint.json')), { code: 'ENOENT' })
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
  const f = await nativeInstalledFixture(t), p = programPaths(f.config)
  const driver = new NativeDriver(f.config, { checkPrograms: () => { throw new LifecycleError('installation_changed_restart_required') } })
  assert.equal(driver.herdr, p.herdr); assert.equal(driver.node, p.node); assert.equal(driver.connector, p.connector)
  assert.throws(() => driver.hostStatus(), { code: 'installation_changed_restart_required' })
  await assert.rejects(driver.observeHostStatus(), { code: 'installation_changed_restart_required' })
  assert.equal(driver.children.size, 0)
})
test('reference activation is explicit and transfer cannot be enabled through an unqualified mode', async t => {
  const f = await nativeInstalledFixture(t), request = { schema: 2, mode: 'existing-installations', transfer: 'disabled' }
  assert.deepEqual(validateRuntimeRequest(request, f.config), request)
  for (const changed of [{ ...request, transfer: 'existing-queue' }, { ...request, command: 'anything' }, { ...request, mode: 'automatic' }]) assert.throws(() => validateRuntimeRequest(changed, f.config))
  const runtime = await createExplicitRuntime({ config: f.config, stateDirectory: path.join(f.base, 'endpoint'), request })
  assert.equal(runtime.transfer, null); assert.equal(runtime.driver.children.size, 0)
})

async function installedTransferFixture(t, native = false) {
  const f = await (native ? nativeInstalledFixture(t) : installedFixture(t))
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
test('native connector configuration retains original transfer roots, raw API binding and existing queue bytes', async t => {
  const f = await installedTransferFixture(t, true)
  const journal = path.join(f.locations.state, 'original-queue-evidence')
  await fs.writeFile(journal, 'ORIGINAL TASK RECEIPT OFFSET')
  const files = [journal, path.join(f.locations.config, 'transfer.json'), path.join(f.locations.config, 'device.credential'), f.registryFile]
  const before = await Promise.all(files.map(file => fs.readFile(file)))
  const legacy = { ...f.config, schema: 2, agenvoConfigDir: path.join(f.base, 'configuration/agenvo') }
  delete legacy.connector
  assert.deepEqual(transferLocations(f.config), transferLocations(legacy))
  assert.equal((await inspectInstalledTransfer(f.config)).source, catalog.components.transfer.revision)
  assert.equal(transferEnvironment(f.config).HERDR_PLUGIN_STATE_DIR, f.locations.state)
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file))), before)
})
test('native direct-CLI directory pair is optional and default references remain identical', async t => {
  const f = await installedTransferFixture(t, true), original = JSON.stringify(f.config)
  const explicit = { ...f.config, transferConfigDir: f.locations.config, transferStateDir: f.locations.state }
  validateConfig(explicit)
  assert.deepEqual(transferLocations(explicit), f.locations)
  assert.deepEqual(transferEnvironment(explicit, {}), transferEnvironment(f.config, {}))
  assert.ok(installationReferences(explicit).includes(f.locations.config))
  assert.ok(installationReferences(explicit).includes(f.locations.state))
  assert.equal(JSON.stringify(f.config), original)
  const legacy = await installedTransferFixture(t)
  assert.throws(() => validateConfig({ ...legacy.config, transferConfigDir: legacy.locations.config, transferStateDir: legacy.locations.state }), { code: 'unknown_or_missing_field' })
})

test('native direct-CLI directory pair rejects partial, unbound, overlapping and component-crossing locations', async t => {
  const f = await installedTransferFixture(t, true)
  const valid = { ...f.config, transferConfigDir: path.join(f.base, 'native-file-config'), transferStateDir: path.join(f.base, 'native-file-state') }
  validateConfig(valid)
  for (const omitted of ['transferConfigDir', 'transferStateDir']) {
    const partial = { ...valid }; delete partial[omitted]
    assert.throws(() => validateConfig(partial), { code: 'transfer_directory_pair_required' })
  }
  const unbound = { ...valid }; delete unbound.transfer
  assert.throws(() => validateConfig(unbound), { code: 'transfer_reference_required' })
  for (const directory of [valid.transferStateDir, path.join(valid.transferStateDir, 'nested'), f.config.sourceRoot,
    f.config.piConfigDir, f.config.herdrConfigRoot, path.dirname(f.config.herdrConfigRoot), path.join(f.config.herdrStateRoot, 'other-config')]) {
    assert.throws(() => validateConfig({ ...valid, transferConfigDir: directory }), { code: 'component_data_overlap' })
  }
  assert.throws(() => validateConfig({ ...valid, transferStateDir: path.join(f.config.herdrConfigRoot, 'other-state') }), { code: 'component_data_overlap' })
  for (const directory of [f.config.programs.piPackage, f.config.transfer.pluginRoot]) {
    assert.throws(() => validateConfig({ ...valid, transferConfigDir: directory }), { code: 'data_program_overlap' })
  }
  assert.throws(() => validateConfig({ ...valid, transferConfigDir: path.dirname(f.config.connector.enrollmentFile) }), { code: 'connector_enrollment_overlap' })
})

test('native direct-CLI driver fixes one explicit directory pair and never falls back to the old credential or queue', async t => {
  const f = await installedTransferFixture(t, true), oldQueue = path.join(f.locations.state, 'retained-original-queue')
  await fs.writeFile(oldQueue, 'OLD TASK RECEIPT OFFSET')
  const oldFiles = [oldQueue, path.join(f.locations.config, 'transfer.json'), path.join(f.locations.config, 'device.credential'), f.registryFile]
  const before = await Promise.all(oldFiles.map(file => fs.readFile(file)))
  const selected = { ...f.config, transferConfigDir: path.join(f.base, 'native-file-config'), transferStateDir: path.join(f.base, 'native-file-state') }
  validateConfig(selected)
  await fs.mkdir(selected.transferConfigDir); await fs.mkdir(selected.transferStateDir)
  await f.write(path.join(selected.transferConfigDir, 'transfer.json'), JSON.stringify({ version: 1, origin: f.locations.origin, source_root: f.config.sourceRoot }))
  // An old credential exists, but the chosen pair must fail until its own input exists.
  await assert.rejects(validateTransferConfiguration(selected), { code: 'transfer_credential_missing' })
  await f.write(path.join(selected.transferConfigDir, 'device.credential'), 'SYNTHETIC SELECTED CREDENTIAL; NOT AUTHENTICATED')
  await validateTransferConfiguration(selected)
  const driver = new NativeTransferDriver(selected, { inheritedEnvironment: { HERDR_PLUGIN_CONFIG_DIR: f.locations.config, HERDR_PLUGIN_STATE_DIR: f.locations.state } })
  const pair = { config: selected.transferConfigDir, state: selected.transferStateDir }
  selected.transferConfigDir = f.locations.config; selected.transferStateDir = f.locations.state
  assert.equal(driver.env.HERDR_PLUGIN_CONFIG_DIR, pair.config); assert.equal(driver.env.HERDR_PLUGIN_STATE_DIR, pair.state)
  assert.equal(transferLocations(driver.config).config, pair.config)
  assert.ok(leaseKeys(driver.config).includes(`transfer:${pair.state}`))
  assert.equal(leaseKeys(driver.config).includes(`transfer:${f.locations.state}`), false)
  assert.deepEqual(await Promise.all(oldFiles.map(file => fs.readFile(file))), before)
  assert.equal(f.calls.length, 0, 'no Agent, producer CLI or Herdr plugin was started')
})

test('native direct-CLI directory pair joins continuation identity while absent-pair checkpoint bytes stay compatible', async t => {
  const f = await installedTransferFixture(t, true), checkpoint = await captureSessionContinuation(f.config)
  const oldKeys = ['deviceId', 'runtimeId', 'instanceId', 'session', 'sourceRoot', 'herdrConfigRoot', 'herdrStateRoot', 'agenvoConfigDir', 'piConfigDir']
  const prePairContract = [...oldKeys.map(key => f.config[key]), f.config.transfer, f.config.connector.kind, f.config.connector.enrollmentFile]
  assert.equal(checkpoint.binding, createHash('sha256').update(JSON.stringify(prePairContract)).digest('hex'))
  await verifySessionContinuation(f.config, checkpoint)
  const selected = { ...f.config, transferConfigDir: path.join(f.base, 'native-file-config'), transferStateDir: path.join(f.base, 'native-file-state') }
  validateConfig(selected)
  await assert.rejects(verifySessionContinuation(selected, checkpoint), { code: 'session_data_identity_changed' })
  const next = await captureSessionContinuation(selected)
  await verifySessionContinuation(selected, next)
  for (const field of ['transferConfigDir', 'transferStateDir']) {
    await assert.rejects(verifySessionContinuation({ ...selected, [field]: `${selected[field]}-changed` }, next), { code: 'session_data_identity_changed' })
  }
  await assert.rejects(verifySessionContinuation(f.config, next), { code: 'session_data_identity_changed' })
  assert.deepEqual(await captureSessionContinuation(f.config), checkpoint)
})
test('native direct-CLI hook gate rejects an enabled old registration without changing its bytes', async t => {
  const f = await installedTransferFixture(t, true)
  const config = { ...f.config, transferConfigDir: f.locations.config, transferStateDir: f.locations.state }
  const before = await fs.readFile(f.registryFile)
  await assert.rejects(inspectInstalledTransfer(config), { code: 'runtime_legacy_plugin_must_be_disabled' })
  assert.deepEqual(await fs.readFile(f.registryFile), before)
  assert.equal(f.calls.length, 0)
})

test('native direct-CLI hook gate accepts disabled old paths while independently checking selected producer inventory', async t => {
  const f = await installedTransferFixture(t, true)
  const config = { ...f.config, transferConfigDir: f.locations.config, transferStateDir: f.locations.state }
  const disabled = [{ ...f.registry[0], enabled: false, version: 'old-version', plugin_root: path.join(f.base, 'retained-old-plugin'), manifest_path: path.join(f.base, 'retained-old-plugin/herdr-plugin.toml') }]
  const raw = `${JSON.stringify(disabled, null, 3)}\n`
  await fs.writeFile(f.registryFile, raw)
  const checked = await inspectInstalledTransfer(config)
  assert.equal(checked.source, catalog.components.transfer.revision)
  await checked.assertUnchanged()
  assert.equal(await fs.readFile(f.registryFile, 'utf8'), raw)
  const diagnostic = await installedDoctor(config, null, { run: f.run, observe: async () => ({ state: 'not_running', stopAuthority: false }) })
  assert.ok(diagnostic.checks.some(c => c.check === 'existing_transfer_reference' && c.state === 'passed'))
  assert.ok(diagnostic.checks.some(c => c.code === 'native_file_principal_mapping_unverified' && c.state === 'blocked'))
  await fs.appendFile(path.join(f.locations.root, 'transferqueue.exe'), 'CHANGED')
  await assert.rejects(checked.assertUnchanged(), { code: 'transfer_payload_changed' })
  await assert.rejects(inspectInstalledTransfer(config), { code: 'transfer_payload_changed' })
})

test('native direct-CLI hook gate permits absent registration and freezes both registry absence and unrelated original bytes', async t => {
  for (const registry of [null, [], [{ plugin_id: 'other.fixture', enabled: true }]]) {
    const f = await installedTransferFixture(t, true)
    const config = { ...f.config, transferConfigDir: f.locations.config, transferStateDir: f.locations.state }
    if (registry === null) await fs.unlink(f.registryFile)
    else await fs.writeFile(f.registryFile, JSON.stringify(registry))
    const checked = await inspectInstalledTransfer(config)
    assert.equal(checked.source, catalog.components.transfer.revision)
    await checked.assertUnchanged()
    if (registry === null) {
      await assert.rejects(fs.lstat(f.registryFile), { code: 'ENOENT' })
      await fs.writeFile(f.registryFile, '[]')
    } else await fs.appendFile(f.registryFile, '\n')
    await assert.rejects(checked.assertUnchanged(), { code: 'runtime_transfer_mapping_changed' })
  }
})

test('native direct-CLI hook gate rejects registration removal or re-enabling during a checked run', async t => {
  for (const change of ['remove', 'enable']) {
    const f = await installedTransferFixture(t, true)
    const config = { ...f.config, transferConfigDir: f.locations.config, transferStateDir: f.locations.state }
    await fs.writeFile(f.registryFile, JSON.stringify([{ ...f.registry[0], enabled: false }]))
    const checked = await inspectInstalledTransfer(config)
    if (change === 'remove') await fs.unlink(f.registryFile)
    else await fs.writeFile(f.registryFile, JSON.stringify(f.registry))
    await assert.rejects(checked.assertUnchanged(), { code: 'runtime_transfer_mapping_changed' })
  }
})

test('default native and legacy transfer references still require their original enabled matching registration', async t => {
  for (const native of [false, true]) {
    const f = await installedTransferFixture(t, native)
    assert.equal((await inspectInstalledTransfer(f.config)).source, catalog.components.transfer.revision)
    await fs.writeFile(f.registryFile, JSON.stringify([{ ...f.registry[0], enabled: false }]))
    await assert.rejects(inspectInstalledTransfer(f.config), { code: 'runtime_transfer_mapping_invalid' })
    await fs.unlink(f.registryFile)
    await assert.rejects(inspectInstalledTransfer(f.config), { code: 'ENOENT' })
  }
})
test('native doctor separates locally checked original transfer references from the unverified native file principal mapping', async t => {
  const f = await installedTransferFixture(t, true), journal = path.join(f.locations.state, 'original-queue-evidence')
  await fs.writeFile(journal, 'ORIGINAL TASK RECEIPT OFFSET')
  const files = [journal, path.join(f.locations.config, 'transfer.json'), path.join(f.locations.config, 'device.credential'), f.registryFile, f.config.connector.enrollmentFile]
  const before = await Promise.all(files.map(file => fs.readFile(file)))
  const observe = async () => ({ state: 'not_running', ownership: 'not_acquired', stopAuthority: false, serverIdentity: 'not_verified' })
  const result = await installedDoctor(f.config, null, { run: f.run, observe })
  assert.ok(result.checks.some(c => c.check === 'existing_transfer_reference' && c.state === 'passed'))
  assert.deepEqual(result.checks.filter(c => c.check === 'native_control_file_principal_mapping'), [
    { check: 'native_control_file_principal_mapping', state: 'blocked', code: 'native_file_principal_mapping_unverified' },
  ])
  assert.equal(result.transfer, 'existing_reference_checked; original_file_credential_retained; native_control_file_principal_mapping_unverified')
  assert.equal(result.ready, false); assert.equal(result.credentialsRead, false)
  const runtime = await createExplicitRuntime({ config: f.config, stateDirectory: path.join(f.base, 'endpoint'), request: { schema: 2, mode: 'existing-installations', transfer: 'existing-queue' } })
  assert.equal(runtime.transfer.state, 'stopped'); assert.equal(runtime.driver.children.size, 0)
  assert.deepEqual(await Promise.all(files.map(file => fs.readFile(file))), before)
  await fs.unlink(path.join(f.locations.config, 'device.credential'))
  const missing = await installedDoctor(f.config, null, { run: f.run, observe })
  assert.ok(missing.checks.some(c => c.check === 'installation_preflight' && c.code === 'transfer_credential_missing'))
  assert.ok(missing.checks.some(c => c.code === 'native_file_principal_mapping_unverified'))
})
test('the native file mapping diagnostic does not invent a gate for legacy transfer or native control-only configuration', async t => {
  const observe = async () => ({ state: 'not_running', ownership: 'not_acquired', stopAuthority: false, serverIdentity: 'not_verified' })
  const legacy = await installedTransferFixture(t)
  const checked = await installedDoctor(legacy.config, null, { run: legacy.run, observe })
  assert.ok(checked.checks.some(c => c.check === 'existing_transfer_reference' && c.state === 'passed'))
  assert.equal(checked.transfer, 'reference_checked; native_tls_and_authorization_unverified')
  assert.equal(checked.checks.some(c => c.check === 'native_control_file_principal_mapping'), false)
  const native = await nativeInstalledFixture(t)
  const control = await installedDoctor(native.config, null, { run: native.run, observe })
  assert.equal(control.checks.some(c => c.state === 'blocked'), false)
  assert.equal(control.ready, false)
})
test('reference mode shares the registered producer paths and lease without another bundle or queue', async t => {
  const f = await installedTransferFixture(t), request = { schema: 2, mode: 'existing-installations', transfer: 'existing-queue' }
  delete f.config.programs.herdr
  const original = JSON.stringify(f.config)
  const journal = path.join(f.locations.state, 'untouched-user-journal')
  await fs.writeFile(journal, 'KEEP EXISTING QUEUE EVIDENCE')
  const checked = await inspectInstalledTransfer(f.config)
  assert.equal(checked.source, catalog.components.transfer.revision)
  assert.deepEqual(transferCommand(f.config, 'advance-results'), { file: path.join(f.locations.root, 'transferqueue.exe'), args: ['-action', 'advance-results'] })
  assert.throws(() => transferEnvironment(f.config), { code: 'herdr_reference_unresolved' })
  const resolved = (await validateInstalledConfiguration(f.config)).config
  const env = transferEnvironment(resolved)
  assert.ok(env.PATH.split(path.delimiter).includes(path.dirname(f.p.herdr)))
  assert.equal(JSON.stringify(f.config), original)
  assert.equal(env.HERDR_PLUGIN_CONFIG_DIR, f.locations.config); assert.equal(env.HERDR_PLUGIN_STATE_DIR, f.locations.state)
  assert.ok(leaseKeys(f.config).includes(`transfer:${f.locations.state}`))
  await assert.rejects(createExplicitRuntime({ config: f.config, stateDirectory: path.join(f.base, 'endpoint'), request }), { code: 'legacy_execution_retired' })
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
