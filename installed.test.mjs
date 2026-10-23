import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { inspectInstalled, compareProducerTarget } from './installed.mjs'
import { validateConfig, managedEnvironment, programPaths, configure } from './endpoint.mjs'
import { validateRuntimeRequest, createExplicitRuntime } from './runtime.mjs'
import { NativeDriver, LifecycleError } from './lifecycle.mjs'
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
  const runtime = createExplicitRuntime({ config: f.config, stateDirectory: path.join(f.base, 'endpoint'), request })
  assert.equal(runtime.transfer, null); assert.equal(runtime.driver.children.size, 0)
})
