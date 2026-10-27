import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import { programDeployment, programDeploymentMain, runSelectedProgram, prepareProfileSwitch, archiveProfileSwitch, commitProfileSwitch } from './program-deployment.mjs'
import { verifyCandidate } from './candidate.mjs'
import { digest } from './endpoint.mjs'
import { StateStore, acquireLeases } from './lifecycle.mjs'
import { captureSessionContinuation } from './session-continuation.mjs'
import { ForegroundHost, runForeground } from './host.mjs'
import { installedFixture, nativeInstalledFixture } from './test-support/installed-fixture.mjs'
import { attemptEvidence, recoveryConfigurationHash } from './host-recovery.mjs'
import { programPackage } from './test-support/program-package.mjs'
import { createHash, randomUUID } from 'node:crypto'

async function fixture(t, { native = false } = {}) {
  const f = await (native ? nativeInstalledFixture(t) : installedFixture(t)), root = path.join(f.base, 'host')
  if (!native) delete f.config.programs.herdr
  await fs.mkdir(path.join(root, 'config'), { recursive: true })
  const configFile = path.join(root, 'config/endpoint.json')
  await fs.writeFile(configFile, JSON.stringify(f.config))
  if (native) await fs.writeFile(path.join(root, 'config/runtime.json'), JSON.stringify({ schema: 2, mode: 'existing-installations', transfer: 'disabled' }))
  const a = await programPackage(path.join(f.base, 'package a'), 'a', { native })
  const b = await programPackage(path.join(f.base, 'package b'), 'b', { native })
  const manager = await programDeployment(root, { prepare: true })
  const originalFiles = [configFile, native ? f.config.connector.enrollmentFile : path.join(f.config.agenvoConfigDir, 'config.json'), path.join(f.config.piConfigDir, 'auth.json'), ...(native ? [path.join(root, 'config/runtime.json')] : [])]
  const originals = await Promise.all(originalFiles.map(p => fs.readFile(p)))
  return { ...f, root, a, b, manager, originalFiles, originals }
}
const apply = (f, pkg, mode = 'install') => programDeploymentMain([mode, '--root', f.root, '--source', pkg.directory, '--manifest-sha256', pkg.hash])
async function preserve(f) { assert.deepEqual(await Promise.all(f.originalFiles.map(p => fs.readFile(p))), f.originals) }

test('offline local profile commit resumes after both publications without replaying original unknown', async t => {
  const f = await fixture(t, { native: true }), store = f.manager.lifecycleStore
  await apply(f, f.a)
  const attempt = path.join(f.config.sourceRoot, '.memoh-computer/attempts/original/receipt.json')
  await fs.mkdir(path.dirname(attempt), { recursive: true }); await fs.writeFile(attempt, 'SYNTHETIC UNKNOWN RECEIPT')
  const continuation = await captureSessionContinuation(f.config)
  await store.save({ ...(await store.load()), sessionContinuation: continuation })
  const configRaw = await fs.readFile(f.manager.configFile), stateRaw = await fs.readFile(store.file)
  const profile = path.join(f.base, 'new Pi profile'); await fs.mkdir(profile)
  const sha = value => createHash('sha256').update(value).digest('hex')
  const options = { root: f.root, requestId: randomUUID(), profile, configurationSha256: sha(configRaw), lifecycleSha256: sha(stateRaw),
    continuationSha256: sha(JSON.stringify(continuation)), attemptsSha256: await attemptEvidence(f.config) }
  await fs.writeFile(path.join(f.manager.lifecycleDirectory, 'host-status.json'), JSON.stringify({ schema: 1, owner: 'windows-endpoint-host', phase: 'stopped', attention: null, pid: 4242, runId: randomUUID(), updatedAt: Date.now() }))
  await prepareProfileSwitch(options); await archiveProfileSwitch(options)
  const inspect = async config => ({ config, assertUnchanged() {} })
  const observe = async () => ({ ownerVerified: true, oldHostAbsent: true, referencedProcessesAbsent: true, herdrAbsent: true })
  await assert.rejects(commitProfileSwitch(options, { inspect, observe: async () => ({ ownerVerified: true, oldHostAbsent: true, referencedProcessesAbsent: true, herdrAbsent: false }) }), { code: 'deployment_profile_switch_host_unverified' })
  await assert.rejects(commitProfileSwitch(options, { inspect, observe, checkpoint: async p => { if (p === 'configuration_file_synced') await fs.appendFile(f.manager.configFile, ' ') } }), { code: 'deployment_profile_switch_evidence_changed' })
  assert.deepEqual(await fs.readFile(store.file), stateRaw)
  await fs.writeFile(f.manager.configFile, configRaw)
  await assert.rejects(commitProfileSwitch(options, { inspect, observe, checkpoint: async p => { if (p === 'configuration_published') throw new Error('synthetic crash') } }))
  assert.equal(JSON.parse(await fs.readFile(f.manager.configFile)).piConfigDir, profile)
  assert.deepEqual(await fs.readFile(store.file), stateRaw)
  await assert.rejects(commitProfileSwitch(options, { inspect, observe, checkpoint: async p => { if (p === 'lifecycle_published') throw new Error('synthetic crash') } }))
  assert.equal((await commitProfileSwitch(options, { inspect, observe })).state, 'local_profile_prepared')
  assert.equal((await commitProfileSwitch(options, { inspect, observe })).state, 'local_profile_prepared')
  const history = path.join(f.manager.lifecycleDirectory, 'profile-switch-history')
  assert.deepEqual(await fs.readFile(path.join(history, `${options.requestId}.configuration.json`)), configRaw)
  assert.deepEqual(await fs.readFile(path.join(history, `${options.requestId}.lifecycle.json`)), stateRaw)
  assert.equal(await fs.readFile(attempt, 'utf8'), 'SYNTHETIC UNKNOWN RECEIPT')
  assert.notEqual(JSON.parse(await fs.readFile(store.file)).sessionContinuation.binding, continuation.binding)
  await assert.rejects(runSelectedProgram(f.root), { code: 'deployment_profile_switch_recovery_required' })
  await assert.rejects(commitProfileSwitch({ ...options, rollback: true }, { inspect, observe, checkpoint: async p => { if (p === 'lifecycle_published') throw new Error('synthetic rollback interruption') } }))
  assert.equal((await commitProfileSwitch({ ...options, rollback: true }, { inspect, observe })).state, 'local_profile_rolled_back')
  assert.deepEqual(await fs.readFile(f.manager.configFile), configRaw)
  assert.deepEqual(await fs.readFile(store.file), stateRaw)
  assert.equal(await fs.readFile(attempt, 'utf8'), 'SYNTHETIC UNKNOWN RECEIPT')
  await assert.rejects(runSelectedProgram(f.root), { code: 'deployment_profile_switch_recovery_required' })
})

test('profile preparation fixes original hashes, is reentrant, and blocks host startup without changing unknown history', async t => {
  const f = await fixture(t, { native: true }), store = f.manager.lifecycleStore
  await apply(f, f.a)
  const attempt = path.join(f.config.sourceRoot, '.memoh-computer/attempts/original/receipt.json')
  await fs.mkdir(path.dirname(attempt), { recursive: true }); await fs.writeFile(attempt, 'SYNTHETIC UNKNOWN RECEIPT')
  const continuation = await captureSessionContinuation(f.config)
  await store.save({ ...(await store.load()), sessionContinuation: continuation })
  const configRaw = await fs.readFile(f.manager.configFile), lifecycleRaw = await fs.readFile(store.file)
  const profile = path.join(f.base, 'existing Pi profile'); await fs.mkdir(profile)
  const sha = value => createHash('sha256').update(value).digest('hex')
  const options = { root: f.root, requestId: randomUUID(), profile, configurationSha256: sha(configRaw), lifecycleSha256: sha(lifecycleRaw),
    continuationSha256: sha(JSON.stringify(continuation)), attemptsSha256: await attemptEvidence(f.config) }
  const pending = path.join(f.manager.lifecycleDirectory, 'profile-switch-pending.json')
  const release = await acquireLeases([`host:${f.root}`], f.manager.lifecycleDirectory)
  try { const result = await prepareProfileSwitch(options); assert.equal(result.state, 'deferred'); assert.equal(result.reason, 'endpoint_owned') } finally { await release() }
  await assert.rejects(prepareProfileSwitch(options, { checkpoint: async phase => { if (phase === 'before_prepare') await fs.appendFile(attempt, '!') } }), { code: 'deployment_profile_switch_evidence_changed' })
  await assert.rejects(fs.stat(pending), { code: 'ENOENT' })
  await fs.writeFile(attempt, 'SYNTHETIC UNKNOWN RECEIPT')
  await assert.rejects(prepareProfileSwitch(options, { checkpoint: async phase => { if (phase === 'prepared') throw new Error('simulated interruption') } }))
  assert.equal((await prepareProfileSwitch(options)).state, 'already_prepared')
  await assert.rejects(prepareProfileSwitch({ ...options, requestId: randomUUID() }), { code: 'deployment_profile_switch_pending_conflict' })
  const marker = await fs.readFile(pending)
  await assert.rejects(archiveProfileSwitch(options, { checkpoint: async phase => { if (phase === 'linked_configuration') throw new Error('synthetic link interruption') } }))
  await assert.rejects(archiveProfileSwitch(options, { checkpoint: async phase => { if (phase === 'archived_lifecycle') throw new Error('synthetic interruption') } }))
  assert.equal((await archiveProfileSwitch(options)).state, 'old_files_archived')
  const archive = path.join(f.manager.lifecycleDirectory, 'profile-switch-history')
  assert.deepEqual(await fs.readFile(path.join(archive, `${options.requestId}.configuration.json`)), configRaw)
  assert.deepEqual(await fs.readFile(path.join(archive, `${options.requestId}.lifecycle.json`)), lifecycleRaw)
  assert.deepEqual(await fs.readFile(pending), marker)
  const archivedConfig = path.join(archive, `${options.requestId}.configuration.json`)
  await fs.writeFile(archivedConfig, 'SYNTHETIC FOREIGN CHANGE')
  await assert.rejects(archiveProfileSwitch(options), { code: 'deployment_profile_switch_archive_conflict' })
  assert.equal(await fs.readFile(archivedConfig, 'utf8'), 'SYNTHETIC FOREIGN CHANGE')
  let started = false
  const host = new ForegroundHost({ root: f.root, createTestRuntime: async () => { started = true; throw new Error('must not start') } })
  await assert.rejects(host.start(), { code: 'host_profile_switch_recovery_required' })
  await assert.rejects(runSelectedProgram(f.root), { code: 'deployment_profile_switch_recovery_required' })
  const input = new PassThrough(), output = new PassThrough(); let observed = ''
  output.on('data', chunk => { observed += chunk })
  assert.equal(await runForeground({ root: f.root, input, output }), 2)
  assert.match(observed, /host_profile_switch_recovery_required/)
  input.destroy(); output.destroy()
  assert.equal(started, false)
  assert.deepEqual(await fs.readFile(f.manager.configFile), configRaw)
  assert.deepEqual(await fs.readFile(store.file), lifecycleRaw)
  assert.equal(await fs.readFile(attempt, 'utf8'), 'SYNTHETIC UNKNOWN RECEIPT')
  await fs.appendFile(attempt, '!')
  await assert.rejects(prepareProfileSwitch(options), { code: 'deployment_profile_switch_evidence_changed' })
})

test('portable program installs, updates, rolls back and runs the selected real foreground entry without copying official components', async t => {
  const f = await fixture(t)
  assert.equal((await apply(f, f.a)).state, 'selected_review_only')
  assert.equal((await apply(f, f.a)).state, 'already_selected')
  assert.equal((await apply(f, f.b, 'update')).state, 'selected_review_only')
  assert.equal((await f.manager.read()).current, f.b.hash)
  assert.equal((await programDeploymentMain(['rollback', '--root', f.root, '--manifest-sha256', f.a.hash])).state, 'selected_review_only')
  const child = spawn(process.execPath, [fileURLToPath(new URL('./endpoint.mjs', import.meta.url)), 'deploy', 'run', '--root', f.root], { stdio: ['pipe', 'pipe', 'pipe'] })
  let output = '', stderr = ''; const ended = new Promise(resolve => child.once('close', code => resolve(code)))
  const timeout = setTimeout(() => child.kill(), 15000)
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject); child.once('exit', () => reject(new Error(stderr || 'host exited before running')))
      child.stderr.on('data', c => { stderr += c })
      child.stdout.on('data', c => { output += c; if (output.includes('"phase":"running"')) resolve() })
    })
    const before = await fs.readFile(f.manager.file)
    assert.equal((await apply(f, f.b, 'update')).reason, 'endpoint_owned')
    assert.deepEqual(await fs.readFile(f.manager.file), before)
    child.stdin.end('{"action":"stop"}\n')
    assert.equal(await ended, 0, stderr)
  } finally { clearTimeout(timeout); if (child.exitCode === null) { child.kill(); await ended } }
  assert.equal((await apply(f, f.b, 'update')).state, 'selected_review_only')
  assert.ok(output.includes('"ready":false'))
  await preserve(f)
})

test('attention, task evidence, external lock and incompatible state defer or reject without changing selected software or task files', async t => {
  const f = await fixture(t); await apply(f, f.a)
  const store = new StateStore(f.manager.lifecycleDirectory, f.config.deviceId), state = await store.load()
  await store.save({ ...state, attention: 'transfer_permission' })
  assert.equal((await apply(f, f.b, 'update')).reason, 'endpoint_attention')
  assert.equal((await store.load()).attention, 'transfer_permission')
  await store.save(state)
  const attempt = path.join(f.config.sourceRoot, '.memoh-computer/attempts/opaque-attempt')
  await fs.mkdir(attempt, { recursive: true }); await fs.writeFile(path.join(attempt, 'receipt.json'), 'SYNTHETIC UNKNOWN ORIGINAL')
  assert.equal((await apply(f, f.b, 'update')).reason, 'task_handoff_unverified')
  assert.equal(await fs.readFile(path.join(attempt, 'receipt.json'), 'utf8'), 'SYNTHETIC UNKNOWN ORIGINAL')
  assert.equal((await f.manager.read()).current, f.a.hash)
  await fs.rm(path.dirname(attempt), { recursive: true }) // remove only this test's fixture
  const lock = path.join(f.config.agenvoConfigDir, 'run.lock')
  await fs.writeFile(lock, 'SYNTHETIC EXTERNAL OWNER')
  assert.equal((await apply(f, f.b, 'update')).reason, 'external_component_state_unverified')
  assert.equal(await fs.readFile(lock, 'utf8'), 'SYNTHETIC EXTERNAL OWNER')
  await fs.unlink(lock)
  f.b.manifest.state_profile = 'future-format'
  await fs.writeFile(path.join(f.b.directory, 'candidate.json'), JSON.stringify(f.b.manifest))
  f.b.hash = await digest(path.join(f.b.directory, 'candidate.json'))
  await assert.rejects(apply(f, f.b, 'update'), { code: 'candidate_state_profile_incompatible' })
  assert.equal((await f.manager.read()).current, f.a.hash)
  await preserve(f)
})

test('ordinary workspace checkpoint survives program changes and changed data roots cannot be treated as an empty first run', async t => {
  const f = await fixture(t), snapshot = path.join(f.config.herdrConfigRoot, 'sessions', f.config.session, 'session.json')
  await fs.mkdir(path.dirname(snapshot), { recursive: true })
  const raw = JSON.stringify({ version: 3, workspaces: [{ id: 'preserved', tabs: [{ panes: { p: { cwd: f.config.sourceRoot } } }] }] })
  await fs.writeFile(snapshot, raw)
  const state = await f.manager.lifecycleStore.load()
  await f.manager.lifecycleStore.save({ ...state, sessionContinuation: await captureSessionContinuation(f.config) })
  const journalBefore = await fs.readFile(f.manager.lifecycleStore.file)
  await apply(f, f.a); await apply(f, f.b, 'update')
  assert.equal(await fs.readFile(snapshot, 'utf8'), raw)
  assert.deepEqual(await fs.readFile(f.manager.lifecycleStore.file), journalBefore)
  await fs.writeFile(f.manager.configFile, JSON.stringify({ ...f.config, sourceRoot: path.join(f.base, 'new-empty-root') }))
  assert.equal((await programDeploymentMain(['rollback', '--root', f.root, '--manifest-sha256', f.a.hash])).reason, 'session_data_identity_changed')
  assert.equal((await f.manager.read()).current, f.b.hash)
})

test('pending transaction prevents launch, recovery retains selection, and altered packages never execute', async t => {
  const f = await fixture(t); await apply(f, f.a); await f.manager.stage(f.b.directory, f.b.hash)
  const interrupted = await programDeployment(f.root, { checkpoint: async phase => { if (phase === 'switch_selected') throw new Error('fixture interruption') } })
  await assert.rejects(interrupted.select(f.b.hash, 'update'))
  const input = new PassThrough(), output = new PassThrough(); input.end('{"action":"stop"}\n')
  await assert.rejects(runSelectedProgram(f.root, { input, output }), { code: 'deployment_recovery_required' })
  assert.equal((await f.manager.recover()).manifestSha256, f.b.hash)
  const target = path.join(f.manager.layout.packages, f.b.hash)
  await fs.appendFile(path.join(target, 'host.mjs'), '\nthrow new Error("MUST NEVER EXECUTE")')
  await assert.rejects(runSelectedProgram(f.root, { input, output }), { code: 'candidate_payload_changed' })
  // Failed verification releases only the launcher's own lease; no child started.
  const release = await acquireLeases([`host:${f.root}`], f.manager.lifecycleDirectory); await release()
  await preserve(f)
})

test('read-only or full publication keeps previous program; unknown files remain and candidate links reject', async t => {
  const f = await fixture(t); await apply(f, f.a); await f.manager.stage(f.b.directory, f.b.hash)
  const foreign = path.join(f.base, 'foreign-root')
  await fs.mkdir(path.join(foreign, 'config'), { recursive: true })
  await fs.writeFile(path.join(foreign, 'config/endpoint.json'), JSON.stringify(f.config))
  await fs.writeFile(path.join(foreign, 'user-original'), 'KEEP')
  await assert.rejects(programDeployment(foreign, { prepare: true }), { code: 'deployment_unowned_root_retained' })
  assert.deepEqual((await fs.readdir(foreign)).sort(), ['config', 'user-original'])
  const before = await fs.readFile(f.manager.file)
  for (const code of ['EACCES', 'ENOSPC']) {
    const manager = await programDeployment(f.root, { io: { ...fs, rename: async () => { throw Object.assign(new Error('injected'), { code }) } } })
    await assert.rejects(manager.select(f.b.hash, 'update'))
    assert.deepEqual(await fs.readFile(f.manager.file), before)
  }
  await fs.writeFile(path.join(f.root, 'original-user-file'), 'PRESERVE')
  assert.ok((await f.manager.inventory()).retainedUnknownEntries.includes('original-user-file'))
  await fs.symlink(f.a.directory, path.join(f.b.directory, 'linked-package'), 'junction')
  await assert.rejects(verifyCandidate(f.b.directory, f.b.hash), { code: 'candidate_link_rejected' })
  await preserve(f)
})

test('inherited selection lease stays held when component cleanup fails and is released only after explicit retry', async t => {
  const f = await fixture(t), key = `host:${f.root}`
  const inherited = await acquireLeases([key], f.manager.lifecycleDirectory)
  let failStop = true
  const runtime = {
    release: true, start: async () => {},
    snapshot: () => ({ phase: 'running', attention: null, cleanupAttention: null, journal: 'observed', restartsInWindow: 0 }),
    stop: async () => { if (failStop) throw Object.assign(new Error('owned stop unknown'), { code: 'herdr_stop_unknown' }); runtime.release = null },
  }
  const host = new ForegroundHost({ root: f.root, inheritedHostLease: inherited, createTestRuntime: async () => runtime })
  try {
    await host.start()
    assert.equal(await host.stop(), false)
    assert.equal(host.phase, 'stop_failed'); assert.ok(host.release)
    await assert.rejects(acquireLeases([key], f.manager.lifecycleDirectory), { code: 'endpoint_already_owned' })
    failStop = false
    assert.equal(await host.stop(), true); assert.equal(host.release, null)
    const release = await acquireLeases([key], f.manager.lifecycleDirectory); await release()
  } finally { failStop = false; if (host.release) await host.stop() }
})


test('an unresolved handoff acknowledgement prevents program switching without clearing its evidence', async t => {
  const f = await fixture(t); await apply(f, f.a)
  const store = new StateStore(f.manager.lifecycleDirectory, f.config.deviceId)
  const request = { schema: 1, request_id: '11111111-1111-4111-8111-111111111111',
    host: { run_id: '22222222-2222-4222-8222-222222222222', root_sha256: 'a'.repeat(64), program_sha256: 'b'.repeat(64), configuration_sha256: 'c'.repeat(64) },
    native: { device_id: f.config.deviceId, runtime_id: f.config.runtimeId, instance_id: f.config.instanceId, session: f.config.session, herdr_pid: 123, herdr_generation: '123:456', connector_pid: 789, connector_nonce: 'synthetic-nonce' },
    gate: { connection_id: '33333333-3333-4333-8333-333333333333', device_id: f.config.deviceId, instance_id: f.config.instanceId, request_id: '44444444-4444-4444-8444-444444444444', revision: '1', paused: true, scope: 'owner_connection_instance' }, operations: [] }
  await store.recordHandoff(request)
  const before = await fs.readFile(store.file)
  assert.equal((await apply(f, f.b, 'update')).reason, 'host_handoff_unverified')
  assert.equal((await f.manager.read()).current, f.a.hash)
  assert.deepEqual(await fs.readFile(store.file), before)
  await preserve(f)
})

test('native configuration refuses rollback to an Agenvo-only candidate without changing selection or external state', async t => {
  const f = await fixture(t)
  await apply(f, f.a); await apply(f, f.b, 'update')
  const configuration = { ...f.config, schema: 3, runtimeId: f.config.deviceId, programs: { ...f.config.programs, herdr: f.p.herdr },
    connector: { kind: 'memoh-runtime', enrollmentFile: path.join(f.base, 'native/runtime.json') } }
  delete configuration.agenvoConfigDir
  await fs.writeFile(f.manager.configFile, JSON.stringify(configuration))
  const before = await fs.readFile(f.manager.file)
  const references = await Promise.all(f.originalFiles.map(file => fs.readFile(file)))
  await assert.rejects(programDeploymentMain(['rollback', '--root', f.root, '--manifest-sha256', f.a.hash]), { code: 'deployment_native_connector_missing' })
  assert.deepEqual(await fs.readFile(f.manager.file), before)
  assert.deepEqual(await Promise.all(f.originalFiles.map(file => fs.readFile(file))), references)
  assert.equal((await f.manager.read()).current, f.b.hash)
})

test('UNC references refuse an old program reader before any workspace access or selector mutation', async t => {
  const f = await fixture(t, { native: true }); await apply(f, f.a)
  delete f.b.manifest.workspace_unc_source_root
  await fs.writeFile(path.join(f.b.directory, 'candidate.json'), JSON.stringify(f.b.manifest))
  const hash = await digest(path.join(f.b.directory, 'candidate.json'))
  await f.manager.stage(f.b.directory, hash)
  const before = await fs.readFile(f.manager.file)
  // Source-test injection only: do not mount or contact an invented share.
  f.manager.config = { ...f.config, sourceRoot: '\\\\synthetic-server\\share\\work' }
  await assert.rejects(f.manager.projectRoot(hash), { code: 'deployment_unc_workspace_unsupported' })
  assert.deepEqual(await fs.readFile(f.manager.file), before)
  await preserve(f)
})

async function retainedFixture(t) {
  const f = await fixture(t, { native: true }); await apply(f, f.a)
  const attempt = path.join(f.config.sourceRoot, '.memoh-computer/attempts/original/receipt.json')
  const raw = '{"state":"unknown","prompt_submitted":false,"attempt":1,"pi_session":"original","receipt":"retained-original"}'
  await fs.mkdir(path.dirname(attempt), { recursive: true }); await fs.writeFile(attempt, raw)
  const run = randomUUID(), statusFile = path.join(f.manager.lifecycleDirectory, 'host-status.json')
  const child = spawn(process.execPath, ['-e', 'process.exit(0)']); await new Promise(resolve => child.once('exit', resolve))
  const status = { schema: 1, owner: 'windows-endpoint-host', runId: run, pid: child.pid, phase: 'stopped', attention: null, updatedAt: Date.now() }
  await fs.writeFile(statusFile, JSON.stringify(status))
  const logFile = path.join(f.root, 'logs/endpoint-host', run + '.jsonl')
  await fs.mkdir(path.dirname(logFile), { recursive: true })
  await fs.writeFile(logFile, JSON.stringify({ schema: 1, runId: run, phase: 'starting', at: status.updatedAt - 10000 }) + '\n')
  const state = await f.manager.lifecycleStore.load()
  await f.manager.lifecycleStore.save({ ...state, sessionContinuation: await captureSessionContinuation(f.config), infrastructureRecovery: {
    schema: 1, fromState: 'a'.repeat(64), run: randomUUID(), configuration: recoveryConfigurationHash(await fs.readFile(f.manager.configFile, 'utf8'), await fs.readFile(f.manager.runtimeFile, 'utf8')),
    attempts: await attemptEvidence(f.config), previousPhase: 'needs_attention', previousAttention: 'herdr_observation_unknown', businessReplayed: false } })
  let observations = 0
  const options = { inspect: async () => ({ config: f.config, assertUnchanged() {} }),
    observe: async () => { observations++; return { ownerVerified: true, oldHostAbsent: true, referencedProcessesAbsent: true } } }
  const manager = await programDeployment(f.root, options)
  await manager.stage(f.b.directory, f.b.hash)
  return { ...f, manager, options, attempt, raw, statusFile, logFile, observations: () => observations }
}

async function orphanRetentionFixture(t) {
  const f = await retainedFixture(t), state = await f.manager.lifecycleStore.load(), status = JSON.parse(await fs.readFile(f.statusFile))
  status.phase = 'running'; await fs.writeFile(f.statusFile, JSON.stringify(status))
  const prior = { ...state, phase: 'running', attention: null }; delete prior.sessionContinuation
  const original = JSON.stringify(prior), fromState = createHash('sha256').update(original).digest('hex')
  const backup = path.join(f.manager.lifecycleDirectory, `lifecycle-before-recheck-${fromState}.json`)
  await fs.writeFile(backup, original)
  await f.manager.lifecycleStore.save({ ...state, infrastructureRecovery: { ...state.infrastructureRecovery, run: status.runId,
    fromState, previousPhase: 'running', previousAttention: null } })
  return { ...f, backup }
}

test('a verified stopped native program update retains a stale official marker without deleting it or replaying unknown history', async t => {
  const f = await retainedFixture(t)
  const marker = path.join(f.config.herdrConfigRoot, 'sessions', f.config.session, 'herdr.sock')
  const generation = '12345:1770000000000000000'
  await fs.mkdir(path.dirname(marker), { recursive: true }); await fs.writeFile(marker, generation)
  f.manager.observe = async () => ({ ownerVerified: true, oldHostAbsent: true, referencedProcessesAbsent: true, herdrAbsent: true })
  const state = await fs.readFile(f.manager.lifecycleStore.file)
  assert.equal((await f.manager.select(f.b.hash, 'update')).state, 'selected_review_only')
  assert.equal(await fs.readFile(marker, 'utf8'), generation)
  assert.deepEqual(await fs.readFile(f.manager.lifecycleStore.file), state)
  assert.equal(await fs.readFile(f.attempt, 'utf8'), f.raw)
  await preserve(f)
})

for (const kind of ['no_recovery', 'missing_status_proof', 'live_server', 'unknown_probe', 'malformed_marker']) test(`a retained Herdr marker refuses ${kind} without altering selection or task evidence`, async t => {
  const f = await retainedFixture(t), marker = path.join(f.config.herdrConfigRoot, 'sessions', f.config.session, 'herdr.sock')
  const generation = kind === 'malformed_marker' ? 'not-an-official-marker' : '12345:1770000000000000000'
  await fs.mkdir(path.dirname(marker), { recursive: true }); await fs.writeFile(marker, generation)
  if (kind === 'no_recovery') {
    const state = await f.manager.lifecycleStore.load(); delete state.infrastructureRecovery
    await f.manager.lifecycleStore.save(state)
  }
  f.manager.observe = async () => {
    if (kind === 'unknown_probe') throw new Error('synthetic unreadable native status')
    return { ownerVerified: true, oldHostAbsent: true, referencedProcessesAbsent: true,
      ...(kind === 'missing_status_proof' ? {} : { herdrAbsent: kind !== 'live_server' }) }
  }
  const journal = await fs.readFile(f.manager.file), state = await fs.readFile(f.manager.lifecycleStore.file)
  if (['live_server', 'missing_status_proof', 'unknown_probe'].includes(kind)) await assert.rejects(f.manager.select(f.b.hash, 'update'))
  else assert.equal((await f.manager.select(f.b.hash, 'update')).state, 'deferred')
  assert.deepEqual(await fs.readFile(f.manager.file), journal)
  assert.deepEqual(await fs.readFile(f.manager.lifecycleStore.file), state)
  assert.equal(await fs.readFile(marker, 'utf8'), generation)
  assert.equal(await fs.readFile(f.attempt, 'utf8'), f.raw)
})

for (const kind of ['generation', 'removed', 'live_server', 'attempt']) test(`a retained Herdr marker rechecks ${kind} at selector publication`, async t => {
  const f = await retainedFixture(t), marker = path.join(f.config.herdrConfigRoot, 'sessions', f.config.session, 'herdr.sock')
  await fs.mkdir(path.dirname(marker), { recursive: true }); await fs.writeFile(marker, '12345:1770000000000000000')
  let changed = false
  f.manager.observe = async () => ({ ownerVerified: true, oldHostAbsent: true, referencedProcessesAbsent: true, herdrAbsent: !(changed && kind === 'live_server') })
  f.manager.checkpoint = async phase => {
    if (phase !== 'journal_file_synced') return
    changed = true
    if (kind === 'generation') await fs.writeFile(marker, '12345:1770000000000000001')
    if (kind === 'removed') await fs.unlink(marker)
    if (kind === 'attempt') await fs.appendFile(f.attempt, '\n')
    await f.manager.retained.reobserve()
    await f.manager.workBaseline()
  }
  const journal = await fs.readFile(f.manager.file), state = await fs.readFile(f.manager.lifecycleStore.file)
  await assert.rejects(f.manager.select(f.b.hash, 'update'), { code: kind === 'live_server' ? 'deployment_retained_processes_unknown' :
    kind === 'attempt' ? 'deployment_retained_work_changed' : 'deployment_herdr_marker_changed' })
  assert.deepEqual(await fs.readFile(f.manager.file), journal)
  assert.deepEqual(await fs.readFile(f.manager.lifecycleStore.file), state)
  assert.equal(await fs.readFile(f.attempt, 'utf8'), f.raw + (kind === 'attempt' ? '\n' : ''))
})

test('a retained marker needs the same recovery proof even when the attempt directory is empty', async t => {
  const f = await retainedFixture(t), marker = path.join(f.config.herdrConfigRoot, 'sessions', f.config.session, 'herdr.sock')
  await fs.rm(path.dirname(path.dirname(f.attempt)), { recursive: true }) // this fixture's own synthetic task only
  const state = await f.manager.lifecycleStore.load(); state.infrastructureRecovery.attempts = await attemptEvidence(f.config)
  await f.manager.lifecycleStore.save(state)
  await fs.mkdir(path.dirname(marker), { recursive: true }); await fs.writeFile(marker, '12345:1770000000000000000')
  f.manager.observe = async () => ({ ownerVerified: true, oldHostAbsent: true, referencedProcessesAbsent: true, herdrAbsent: true })
  assert.equal((await f.manager.select(f.b.hash, 'update')).state, 'selected_review_only')
  assert.equal(await fs.readFile(marker, 'utf8'), '12345:1770000000000000000')
})

test('orphaned-running recovery permits the compatible program switch without restarting the old home-mapped host', async t => {
  const f = await orphanRetentionFixture(t), before = await fs.readFile(f.manager.lifecycleStore.file), backup = await fs.readFile(f.backup)
  assert.equal((await f.manager.select(f.b.hash, 'update')).state, 'selected_review_only')
  assert.equal((await f.manager.read()).current, f.b.hash)
  assert.deepEqual(await fs.readFile(f.manager.lifecycleStore.file), before); assert.deepEqual(await fs.readFile(f.backup), backup)
  assert.equal(JSON.parse(await fs.readFile(f.statusFile)).phase, 'running', 'never fabricate an original clean exit')
  assert.equal(await fs.readFile(f.attempt, 'utf8'), f.raw)
})

test('orphaned-running recovery refuses old-reader rollback before changing the selected program', async t => {
  const f = await orphanRetentionFixture(t)
  delete f.b.manifest.native_running_recovery
  await fs.writeFile(path.join(f.b.directory, 'candidate.json'), JSON.stringify(f.b.manifest))
  const hash = await digest(path.join(f.b.directory, 'candidate.json'))
  await f.manager.stage(f.b.directory, hash)
  const before = await fs.readFile(f.manager.file)
  await assert.rejects(f.manager.select(hash, 'update'), { code: 'deployment_running_recovery_unsupported' })
  assert.deepEqual(await fs.readFile(f.manager.file), before)
  assert.equal(await fs.readFile(f.attempt, 'utf8'), f.raw)
})

test('orphaned-running recovery cannot use a changed backup or a different cached run as retention evidence', async t => {
  for (const kind of ['backup', 'run']) {
    const f = await orphanRetentionFixture(t), before = await fs.readFile(f.manager.file)
    if (kind === 'backup') await fs.appendFile(f.backup, '\n')
    else { const status = JSON.parse(await fs.readFile(f.statusFile)); status.runId = randomUUID(); await fs.writeFile(f.statusFile, JSON.stringify(status)) }
    if (kind === 'backup') await assert.rejects(f.manager.select(f.b.hash, 'update'), { code: 'deployment_retained_recovery_mismatch' })
    else assert.equal((await f.manager.select(f.b.hash, 'update')).reason, 'task_handoff_unverified')
    assert.deepEqual(await fs.readFile(f.manager.file), before)
    assert.equal(await fs.readFile(f.attempt, 'utf8'), f.raw)
  }
})

test('compatible stopped program switch retains the original durable unknown checkpoint and never claims a business handoff', async t => {
  const f = await retainedFixture(t), before = await fs.readFile(f.manager.lifecycleStore.file)
  assert.equal((await f.manager.select(f.b.hash, 'update')).state, 'selected_review_only')
  assert.equal((await f.manager.read()).current, f.b.hash)
  assert.equal(f.observations(), 5, 'both work observations and all three atomic publications recheck native absence')
  assert.equal(f.manager.retained.attempts, await attemptEvidence(f.config))
  assert.equal(await fs.readFile(f.attempt, 'utf8'), f.raw)
  assert.deepEqual(await fs.readFile(f.manager.lifecycleStore.file), before)
  // A fresh updater can recover/read the same durable evidence; no new ledger.
  const fresh = await programDeployment(f.root, f.options)
  assert.equal((await fresh.select(f.b.hash, 'update')).state, 'already_selected')
  assert.equal(await fs.readFile(f.attempt, 'utf8'), f.raw)
  await preserve(f)
})

test('a component appearing at atomic selector publication still blocks a historical program switch', async t => {
  const f = await retainedFixture(t), before = await fs.readFile(f.manager.file)
  let calls = 0
  f.manager.observe = async () => ({ ownerVerified: true, oldHostAbsent: ++calls < 2, referencedProcessesAbsent: true })
  await assert.rejects(f.manager.select(f.b.hash, 'update'), { code: 'deployment_retained_processes_unknown' })
  assert.deepEqual(await fs.readFile(f.manager.file), before)
  assert.equal(await fs.readFile(f.attempt, 'utf8'), f.raw)
})

test('interrupted retained-history selection requires recovery and preserves the same unknown bytes across a fresh updater', async t => {
  const f = await retainedFixture(t), interrupted = await programDeployment(f.root, { ...f.options, checkpoint: async phase => {
    if (phase === 'switch_selected') throw new Error('synthetic process interruption after selection')
  } })
  await assert.rejects(interrupted.select(f.b.hash, 'update'))
  const pending = await interrupted.read(); assert.equal(pending.current, f.b.hash); assert.equal(pending.pending.phase, 'selected')
  const fresh = await programDeployment(f.root, f.options)
  assert.equal((await fresh.recover()).state, 'recovered_review_only')
  assert.equal((await fresh.read()).pending, null)
  assert.equal(await fs.readFile(f.attempt, 'utf8'), f.raw)
  await preserve(f)
})

for (const kind of ['no_recovery', 'wrong_configuration', 'changed_attempt', 'status_running', 'status_attention', 'agent_history', 'native_unknown', 'unverified_principal']) test(`historical retention refuses ${kind} without changing original task or selection`, async t => {
  const f = await retainedFixture(t), state = await f.manager.lifecycleStore.load()
  if (kind === 'no_recovery') { delete state.infrastructureRecovery; await f.manager.lifecycleStore.save(state) }
  if (kind === 'wrong_configuration') { state.infrastructureRecovery.configuration = 'b'.repeat(64); await f.manager.lifecycleStore.save(state) }
  if (kind === 'changed_attempt') await fs.writeFile(f.attempt, f.raw + '\n')
  if (kind.startsWith('status_')) { const status = JSON.parse(await fs.readFile(f.statusFile)); if (kind === 'status_running') status.phase = 'running'; else status.attention = 'connector_authentication_required'; await fs.writeFile(f.statusFile, JSON.stringify(status)) }
  if (kind === 'agent_history') { const snapshot = path.join(f.config.herdrConfigRoot, 'sessions', f.config.session, 'session.json'); await fs.mkdir(path.dirname(snapshot), { recursive: true }); await fs.writeFile(snapshot, JSON.stringify({ version: 3, workspaces: [{ id: 'original', tabs: [{ panes: { p: { cwd: f.config.sourceRoot, agent_session: { original: true } } } }] }] })) }
  if (kind === 'native_unknown') f.manager.observe = async () => { throw new Error('synthetic unknown native ownership') }
  if (kind === 'unverified_principal') f.manager.observe = async () => ({ ownerVerified: false, oldHostAbsent: true, referencedProcessesAbsent: true })
  const attempt = await fs.readFile(f.attempt), journal = await fs.readFile(f.manager.lifecycleStore.file)
  try { const result = await f.manager.select(f.b.hash, 'update'); assert.equal(result.state, 'deferred') }
  catch (error) { assert.ok(['native_unknown', 'unverified_principal'].includes(kind)); assert.ok(error.code) }
  assert.equal((await f.manager.read()).current, f.a.hash)
  assert.deepEqual(await fs.readFile(f.attempt), attempt); assert.deepEqual(await fs.readFile(f.manager.lifecycleStore.file), journal)
  await preserve(f)
})

for (const changed of ['attempt', 'status', 'run_log', 'configuration', 'lifecycle']) test(`retained evidence CAS rejects ${changed} changed after native observation`, async t => {
  const f = await retainedFixture(t)
  f.manager.observe = async () => {
    const file = { attempt: f.attempt, status: f.statusFile, run_log: f.logFile, configuration: f.manager.configFile, lifecycle: f.manager.lifecycleStore.file }[changed]
    await fs.appendFile(file, '\n')
    return { ownerVerified: true, oldHostAbsent: true, referencedProcessesAbsent: true }
  }
  await assert.rejects(f.manager.select(f.b.hash, 'update'), error => /^deployment_(retained_work_changed|configuration_changed)$/.test(error.code))
  assert.equal((await f.manager.read()).current, f.a.hash)
})

test('attempt created after selector fsync cannot race the stopped-program switch even from an initially empty history', async t => {
  const f = await fixture(t); await apply(f, f.a); await f.manager.stage(f.b.directory, f.b.hash)
  const receipt = path.join(f.config.sourceRoot, '.memoh-computer/attempts/concurrent/receipt.json')
  const manager = await programDeployment(f.root, { checkpoint: async phase => {
    if (phase === 'journal_file_synced') { await fs.mkdir(path.dirname(receipt), { recursive: true }); await fs.writeFile(receipt, 'CONCURRENT ORIGINAL; DO NOT DELETE') }
  } })
  const before = await fs.readFile(manager.file)
  await assert.rejects(manager.select(f.b.hash, 'update'), { code: 'deployment_retained_work_changed' })
  assert.deepEqual(await fs.readFile(manager.file), before)
  assert.equal(await fs.readFile(receipt, 'utf8'), 'CONCURRENT ORIGINAL; DO NOT DELETE')
})

test('actual CLI reports deferred with exit2 and completed selection with exit0', async t => {
  const f = await fixture(t); await apply(f, f.a)
  async function cli() {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./endpoint.mjs', import.meta.url)), 'deploy', 'update', '--root', f.root, '--source', f.b.directory, '--manifest-sha256', f.b.hash], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''; child.stdout.on('data', x => { out += x }); child.stderr.on('data', x => { err += x })
    const timer = setTimeout(() => child.kill(), 15000)
    try { const code = await new Promise(resolve => child.once('close', resolve)); assert.equal(err, ''); return { code, result: JSON.parse(out) } }
    finally { clearTimeout(timer) }
  }
  const release = await acquireLeases([`host:${f.root}`], f.manager.lifecycleDirectory)
  try { const denied = await cli(); assert.equal(denied.code, 2); assert.equal(denied.result.state, 'deferred'); assert.equal(denied.result.reason, 'endpoint_owned') }
  finally { await release() }
  const selected = await cli(); assert.equal(selected.code, 0); assert.equal(selected.result.state, 'selected_review_only')
  const attempt = path.join(f.config.sourceRoot, '.memoh-computer/attempts/unverified/receipt.json')
  await fs.mkdir(path.dirname(attempt), { recursive: true }); await fs.writeFile(attempt, 'UNVERIFIED ORIGINAL')
  const history = await cli(); assert.equal(history.code, 2); assert.equal(history.result.reason, 'task_handoff_unverified')
  assert.equal(await fs.readFile(attempt, 'utf8'), 'UNVERIFIED ORIGINAL')
  await preserve(f)
})
