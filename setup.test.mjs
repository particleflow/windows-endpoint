import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { setupEndpoint, setupMain } from './setup.mjs'
import { catalog, digest } from './endpoint.mjs'
import { acquireLeases, leaseKeys } from './lifecycle.mjs'
import { programDeployment, programDeploymentMain } from './program-deployment.mjs'
import { DeploymentTransactions } from './deployment.mjs'
import { installedFixture, nativeInstalledFixture } from './test-support/installed-fixture.mjs'
import { programPackage } from './test-support/program-package.mjs'

const blocked = async () => ({ ready: false, checks: [{ check: 'installation_preflight', state: 'blocked', code: 'installation_input_missing' }] })
async function fixture(t, native = true) {
  const f = await (native ? nativeInstalledFixture(t) : installedFixture(t))
  const candidate = await programPackage(path.join(f.base, 'candidate'))
  if (native) {
    // Synthetic source-built inventory only; never execute these component bytes.
    const names = ['package.json', 'dist/cli.mjs', 'dist/index.mjs', 'dist/bridge.proto', 'dist/endpoint-host-api.mjs']
    const proof = { schema: 1, kind: 'memoh-runtime-source-build', source_repository: 'particleflow/Memoh', source_commit: catalog.nativeRuntime.revision,
      package_name: '@memohai/runtime', package_version: catalog.nativeRuntime.version,
      endpoint_adapter: { recipe: 'packaging/build_runtime_host.mjs', sha256: 'a'.repeat(64) }, files: [] }
    for (const name of names) {
      const file = path.join(candidate.directory, 'runtime-connector', name)
      await f.write(file, name === 'package.json' ? JSON.stringify({ name: proof.package_name, version: proof.package_version }) : 'SYNTHETIC NOT EXECUTABLE')
      proof.files.push({ path: name, size: (await fs.stat(file)).size, sha256: await digest(file) })
    }
    const proofFile = path.join(candidate.directory, 'runtime-connector/SHA256SUMS.json')
    await fs.writeFile(proofFile, JSON.stringify(proof))
    for (const name of [...names, 'SHA256SUMS.json']) {
      const file = path.join(candidate.directory, 'runtime-connector', name)
      candidate.manifest.files.push({ path: `runtime-connector/${name}`, size: (await fs.stat(file)).size, sha256: await digest(file) })
    }
    candidate.manifest.native_runtime = { repository: 'particleflow/Memoh', commit: catalog.nativeRuntime.revision, version: catalog.nativeRuntime.version,
      entry: catalog.nativeRuntime.entry, provenance: 'runtime-connector/SHA256SUMS.json' }
    candidate.manifest.native_runtime_project_root = true
    await fs.writeFile(path.join(candidate.directory, 'candidate.json'), JSON.stringify(candidate.manifest))
    candidate.hash = await digest(path.join(candidate.directory, 'candidate.json'))
    delete f.config.programs.connectorPackage
  }
  const from = path.join(f.base, 'references.json'), root = path.join(f.base, 'host')
  await fs.writeFile(from, JSON.stringify(f.config))
  const options = { from, root, source: candidate.directory, manifestSha256: candidate.hash, transfer: 'disabled' }
  const files = { config: path.join(root, 'config/endpoint.json'), runtime: path.join(root, 'config/runtime.json') }
  return { ...f, candidate, options, files }
}
const exists = async file => fs.lstat(file).then(() => true, e => { if (e.code === 'ENOENT') return false; throw e })

test('unified setup prepares and selects the existing program transaction while missing prerequisites stay blocked and official files stay unchanged', async t => {
  const f = await fixture(t)
  const originals = [f.options.from, f.config.connector.enrollmentFile, path.join(f.config.piConfigDir, 'auth.json')]
  const before = await Promise.all(originals.map(file => fs.readFile(file)))
  const result = await setupEndpoint(f.options, { doctor: blocked })
  assert.equal(result.state, 'prepared_review_only'); assert.equal(result.ready, false)
  assert.equal(result.activation, 'not_started'); assert.equal(result.prerequisites, 'blocked')
  assert.equal(result.deployment.state, 'selected_review_only')
  assert.equal(result.nextAction, null); assert.equal(result.nextRequired, 'resolve_preflight_prerequisites_then_recheck')
  assert.deepEqual(JSON.parse(await fs.readFile(f.files.config)), f.config)
  assert.deepEqual(JSON.parse(await fs.readFile(f.files.runtime)), { schema: 2, mode: 'existing-installations', transfer: 'disabled' })
  assert.deepEqual(await Promise.all(originals.map(file => fs.readFile(file))), before)
  assert.equal(f.calls.length, 0)
})

test('native setup resolves its candidate connector for preflight, preserves omitted package references and never creates enrollment', async t => {
  const f = await fixture(t, true)
  await fs.unlink(f.config.connector.enrollmentFile)
  let observed
  const result = await setupEndpoint(f.options, { doctor: async config => { observed = config; return blocked() } })
  assert.equal(result.state, 'prepared_review_only')
  assert.equal(observed.programs.connectorPackage, path.join(f.candidate.directory, 'runtime-connector'))
  assert.equal(observed.programs.herdr, f.config.programs.herdr)
  assert.equal(observed.piConfigDir, f.config.piConfigDir)
  assert.equal(JSON.parse(await fs.readFile(f.files.config)).programs.connectorPackage, undefined)
  assert.equal(await exists(f.config.connector.enrollmentFile), false)
  assert.equal(result.prerequisites, 'blocked'); assert.equal(result.credentialsWritten, false)
})

test('one existing setup entry browses and saves the fresh Windows default without modifying the reference template', async t => {
  const f = await fixture(t, true), input = await fs.readFile(f.options.from), selected = path.join(f.base, 'chosen work 空格')
  await fs.mkdir(selected)
  let calls = 0
  const result = await setupEndpoint({ ...f.options, browseSourceRoot: true }, { doctor: blocked, chooseDirectory: async () => {
    calls++; return { state: 'selected', path: selected }
  } })
  assert.equal(calls, 1, 'the configuration writer must not open a second dialog')
  assert.equal(result.state, 'prepared_review_only')
  assert.equal(JSON.parse(await fs.readFile(f.files.config)).sourceRoot, selected)
  assert.deepEqual(await fs.readFile(f.options.from), input)
  assert.deepEqual(await fs.readdir(f.config.sourceRoot), [])
  const binding = await fs.readFile(f.files.config)
  await assert.rejects(setupEndpoint({ ...f.options, browseSourceRoot: true }, { doctor: blocked,
    chooseDirectory: async () => ({ state: 'selected', path: f.config.sourceRoot }) }), { code: 'setup_existing_configuration_differs' })
  assert.deepEqual(await fs.readFile(f.files.config), binding, 'choosing a new default never migrates an existing binding')
})

test('cancelling setup directory selection creates no host, config, enrollment or deployment', async t => {
  const f = await fixture(t, true), input = await fs.readFile(f.options.from)
  assert.deepEqual(await setupEndpoint({ ...f.options, browseSourceRoot: true }, { chooseDirectory: async () => ({ state: 'cancelled' }) }),
    { state: 'cancelled', configurationChanged: false })
  assert.equal(await exists(f.options.root), false)
  assert.deepEqual(await fs.readFile(f.options.from), input)
})

if (process.platform === 'win32') test('UNC setup rejects an old reader before creating the host or probing an invented share', async t => {
  const f = await fixture(t, true)
  await fs.writeFile(f.options.from, JSON.stringify({ ...f.config, sourceRoot: '\\\\synthetic-server\\share\\work' }))
  delete f.candidate.manifest.workspace_unc_source_root
  await fs.writeFile(path.join(f.candidate.directory, 'candidate.json'), JSON.stringify(f.candidate.manifest))
  const manifestSha256 = await digest(path.join(f.candidate.directory, 'candidate.json'))
  await assert.rejects(setupEndpoint({ ...f.options, manifestSha256 }, { doctor: async () => {
    throw new Error('unsupported reader must fail before any directory probe')
  } }), { code: 'deployment_unc_workspace_unsupported' })
  assert.equal(await exists(f.options.root), false)
})

test('native setup rejects home-mapped candidates before writing configuration', async t => {
  const f = await fixture(t, true)
  delete f.candidate.manifest.native_runtime_project_root
  await fs.writeFile(path.join(f.candidate.directory, 'candidate.json'), JSON.stringify(f.candidate.manifest))
  f.options.manifestSha256 = await digest(path.join(f.candidate.directory, 'candidate.json'))
  await assert.rejects(setupEndpoint(f.options, { doctor: blocked }), { code: 'deployment_native_project_root_unsupported' })
  assert.equal(await exists(f.options.root), false)
})

test('stopped home-mapped inventory can upgrade, but restart and rollback cannot silently restore home mapping', async t => {
  const f = await fixture(t, true)
  await setupEndpoint(f.options, { doctor: blocked })
  const currentHash = f.candidate.hash
  delete f.candidate.manifest.native_runtime_project_root
  const manifestFile = path.join(f.candidate.directory, 'candidate.json')
  await fs.writeFile(manifestFile, JSON.stringify(f.candidate.manifest))
  const oldHash = await digest(manifestFile), legacy = await programDeployment(f.options.root)
  await legacy.stage(f.candidate.directory, oldHash)
  // Reproduce the recorded selection made by the previous program, which had
  // no workspace capability check. Only this isolated fixture uses that rule.
  legacy.selectionCheck = DeploymentTransactions.prototype.selectionCheck.bind(legacy)
  await legacy.select(oldHash, 'update')
  const config = await fs.readFile(f.files.config), enrollment = await fs.readFile(f.config.connector.enrollmentFile)
  await assert.rejects(programDeploymentMain(['run', '--root', f.options.root]), { code: 'deployment_native_project_root_unsupported' })
  f.candidate.manifest.native_runtime_project_root = true
  await fs.writeFile(manifestFile, JSON.stringify(f.candidate.manifest))
  assert.equal(await digest(manifestFile), currentHash)
  assert.equal((await programDeploymentMain(['update', '--root', f.options.root, '--source', f.candidate.directory, '--manifest-sha256', currentHash])).state, 'selected_review_only')
  const manager = await programDeployment(f.options.root), journal = await fs.readFile(manager.file)
  await assert.rejects(programDeploymentMain(['rollback', '--root', f.options.root, '--manifest-sha256', oldHash]), { code: 'deployment_native_project_root_unsupported' })
  assert.deepEqual(await fs.readFile(manager.file), journal)
  assert.deepEqual(await fs.readFile(f.files.config), config)
  assert.deepEqual(await fs.readFile(f.config.connector.enrollmentFile), enrollment)
})

test('explicit native file directories reject an older candidate before creating the host root', async t => {
  const f = await fixture(t, true)
  Object.assign(f.config, { transfer: { pluginRoot: path.join(f.base, 'producer'), nasOrigin: 'https://example.com/api' },
    transferConfigDir: path.join(f.base, 'native-file/config'), transferStateDir: path.join(f.base, 'native-file/state') })
  await fs.writeFile(f.options.from, JSON.stringify(f.config))
  await assert.rejects(setupEndpoint(f.options, { doctor: blocked }), { code: 'deployment_transfer_directories_unsupported' })
  assert.equal(await exists(f.options.root), false)
})

test('native directory configuration refuses rollback to a candidate that cannot read the pair while retaining state', async t => {
  const f = await fixture(t, true)
  // The earlier pair-only candidate still required an enabled legacy plugin.
  f.candidate.manifest.native_transfer_directory_pair = true
  await fs.writeFile(path.join(f.candidate.directory, 'candidate.json'), JSON.stringify(f.candidate.manifest))
  f.options.manifestSha256 = f.candidate.hash = await digest(path.join(f.candidate.directory, 'candidate.json'))
  await setupEndpoint(f.options, { doctor: blocked })
  const oldHash = f.candidate.hash
  f.candidate.manifest.native_transfer_directory_pair = true
  f.candidate.manifest.native_transfer_direct_cli = true
  await fs.writeFile(path.join(f.candidate.directory, 'candidate.json'), JSON.stringify(f.candidate.manifest))
  const hash = await digest(path.join(f.candidate.directory, 'candidate.json'))
  // Select the capable program before introducing configuration it supports.
  assert.equal((await programDeploymentMain(['update', '--root', f.options.root, '--source', f.candidate.directory, '--manifest-sha256', hash])).state, 'selected_review_only')
  Object.assign(f.config, { transfer: { pluginRoot: path.join(f.base, 'producer'), nasOrigin: 'https://example.com/api' },
    transferConfigDir: path.join(f.base, 'native-file/config'), transferStateDir: path.join(f.base, 'native-file/state') })
  await f.write(path.join(f.config.transferConfigDir, 'keep'), 'original configuration bytes')
  await f.write(path.join(f.config.transferStateDir, 'keep'), 'original queue bytes')
  await fs.writeFile(f.files.config, JSON.stringify(f.config))
  const manager = await programDeployment(f.options.root), before = await fs.readFile(manager.file)
  await assert.rejects(programDeploymentMain(['rollback', '--root', f.options.root, '--manifest-sha256', oldHash]), { code: 'deployment_transfer_directories_unsupported' })
  assert.deepEqual(await fs.readFile(manager.file), before)
  assert.equal(await fs.readFile(path.join(f.config.transferConfigDir, 'keep'), 'utf8'), 'original configuration bytes')
  assert.equal(await fs.readFile(path.join(f.config.transferStateDir, 'keep'), 'utf8'), 'original queue bytes')
})

test('matching setup retry preserves raw configuration bytes and unknown configuration files', async t => {
  const f = await fixture(t); await setupEndpoint(f.options, { doctor: blocked })
  const raw = `${JSON.stringify(Object.fromEntries(Object.entries(f.config).reverse()), null, 4)}\n\n`
  const runtime = '{ "transfer": "disabled", "mode": "existing-installations", "schema": 2 }\n'
  await fs.writeFile(f.files.config, raw); await fs.writeFile(f.files.runtime, runtime)
  const unknown = path.join(f.options.root, 'config', 'user-notes'); await fs.writeFile(unknown, 'PRESERVE')
  const result = await setupEndpoint(f.options, { doctor: async () => ({ ready: false, checks: [{ check: 'synthetic_local_preflight', state: 'passed' }] }) })
  assert.equal(result.deployment.state, 'already_selected')
  assert.deepEqual(result.nextAction, ['deploy', 'run', '--root', f.options.root])
  assert.equal(result.ready, false); assert.equal(result.activation, 'not_started')
  assert.equal(await fs.readFile(f.files.config, 'utf8'), raw)
  assert.equal(await fs.readFile(f.files.runtime, 'utf8'), runtime)
  assert.equal(await fs.readFile(unknown, 'utf8'), 'PRESERVE')
})

test('interruption after references and write denial resume without replacing the saved config or external data', async t => {
  for (const failure of ['interrupted', 'EACCES', 'ENOSPC']) {
    const f = await fixture(t)
    const hooks = { doctor: blocked }
    if (failure === 'interrupted') hooks.checkpoint = async phase => { if (phase === 'references_saved') throw new Error(failure) }
    else hooks.io = { ...fs, open: async () => { throw Object.assign(new Error(failure), { code: failure }) } }
    await assert.rejects(setupEndpoint(f.options, hooks))
    const saved = await fs.readFile(f.files.config)
    assert.equal(await exists(f.files.runtime), false)
    assert.equal(await exists(path.join(f.options.root, 'control')), false)
    const result = await setupEndpoint(f.options, { doctor: blocked })
    assert.equal(result.state, 'prepared_review_only')
    assert.deepEqual(await fs.readFile(f.files.config), saved)
  }
})

test('different or partially written config is retained and cannot be overwritten on retry', async t => {
  for (const raw of ['{', JSON.stringify({ schema: 2, mode: 'existing-installations', transfer: 'existing-queue' })]) {
    const f = await fixture(t)
    await fs.mkdir(path.dirname(f.files.runtime), { recursive: true }); await fs.writeFile(f.files.runtime, raw)
    await assert.rejects(setupEndpoint(f.options, { doctor: blocked }), { code: raw === '{' ? 'setup_configuration_invalid' : 'setup_existing_configuration_differs' })
    assert.equal(await fs.readFile(f.files.runtime, 'utf8'), raw)
    assert.equal(await exists(f.files.config), false)
  }
})

test('active host lease defers setup without writing configuration or releasing the other owner', async t => {
  const f = await fixture(t), state = path.join(f.options.root, 'data/endpoint')
  await fs.mkdir(state, { recursive: true })
  const release = await acquireLeases([...leaseKeys(f.config), `host:${f.options.root}`], state)
  try {
    const result = await setupEndpoint(f.options, { doctor: blocked })
    assert.equal(result.state, 'deferred'); assert.equal(result.reason, 'endpoint_owned')
    assert.equal(await exists(f.files.config), false); assert.equal(await exists(f.files.runtime), false)
    await assert.rejects(acquireLeases([`host:${f.options.root}`], state), { code: 'endpoint_already_owned' })
  } finally { await release() }
})

test('existing task evidence defers actual selection and keeps the original receipt', async t => {
  const f = await fixture(t)
  const receipt = path.join(f.config.sourceRoot, '.memoh-computer/attempts/original/receipt.json')
  await f.write(receipt, 'SYNTHETIC ORIGINAL RECEIPT')
  const result = await setupEndpoint(f.options, { doctor: blocked })
  assert.equal(result.state, 'deferred'); assert.equal(result.deployment.reason, 'task_handoff_unverified')
  assert.equal(result.nextAction, null); assert.equal(result.ready, false)
  assert.equal(await fs.readFile(receipt, 'utf8'), 'SYNTHETIC ORIGINAL RECEIPT')
  assert.equal((await (await programDeployment(f.options.root)).read()).current, null)
})

test('invalid package, unknown root and absent native payload fail before any reference write', async t => {
  const f = await fixture(t)
  await assert.rejects(setupEndpoint({ ...f.options, manifestSha256: '0'.repeat(64) }, { doctor: blocked }), { code: 'candidate_manifest_hash_mismatch' })
  assert.equal(await exists(f.options.root), false)
  await fs.mkdir(f.options.root); await fs.writeFile(path.join(f.options.root, 'original.txt'), 'KEEP')
  await assert.rejects(setupEndpoint(f.options, { doctor: blocked }), { code: 'setup_unowned_root_retained' })
  assert.deepEqual(await fs.readdir(f.options.root), ['original.txt'])
  const native = await fixture(t, true)
  await assert.rejects(setupEndpoint(native.options, { verify: async () => ({ manifest: {} }), doctor: blocked }), { code: 'deployment_native_connector_missing' })
  assert.equal(await exists(native.options.root), false)
})

test('setup refuses a configuration changed during doctor and validates its public argument shape', async t => {
  const f = await fixture(t)
  await assert.rejects(setupEndpoint(f.options, { doctor: async () => {
    await fs.writeFile(f.files.config, JSON.stringify({ ...f.config, session: 'different' })); return blocked()
  } }), { code: 'setup_existing_configuration_differs' })
  assert.equal(await exists(path.join(f.options.root, 'control')), false)
  await assert.rejects(setupMain(['--root', f.options.root]), { code: 'setup_arguments_invalid' })
})

test('runtime request removed during preflight cannot become an implicit disabled configuration', async t => {
  const f = await fixture(t)
  await assert.rejects(setupEndpoint(f.options, { doctor: async () => {
    await fs.unlink(f.files.runtime); return blocked()
  } }), { code: 'setup_configuration_changed' })
  assert.equal(await exists(path.join(f.options.root, 'control')), false)
})

test('public setup entry reports offline preparation separately from readiness using the real command path', async t => {
  const f = await fixture(t, true)
  await fs.unlink(f.config.connector.enrollmentFile)
  const args = [fileURLToPath(new URL('./endpoint.mjs', import.meta.url)), 'setup', '--from', f.options.from,
    '--root', f.options.root, '--source', f.options.source, '--manifest-sha256', f.options.manifestSha256, '--transfer', 'disabled']
  let response
  try { await promisify(execFile)(process.execPath, args, { timeout: 15000, maxBuffer: 65536 }) }
  catch (error) { assert.equal(error.code, 2); assert.equal(error.stderr, ''); response = JSON.parse(error.stdout) }
  assert.ok(response, 'endpoint keeps its existing ready:false exit-code convention')
  assert.equal(response.state, 'prepared_review_only'); assert.equal(response.prerequisites, 'blocked')
  assert.equal(response.preflight.checks[0].code, 'connector_authentication_required')
  assert.equal(response.ready, false); assert.equal(response.activation, 'not_started')
  assert.equal(response.nextAction, null)
  assert.equal(await exists(f.config.connector.enrollmentFile), false)
  assert.equal((await (await programDeployment(f.options.root)).read()).current, f.candidate.hash)
})
