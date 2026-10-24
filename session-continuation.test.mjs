import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { captureSessionContinuation, verifySessionContinuation } from './session-continuation.mjs'
import { inspectInstalled } from './installed.mjs'
import { installedFixture } from './test-support/installed-fixture.mjs'
import { NativeDriver } from './lifecycle.mjs'

async function ordinaryFixture(t) {
  const f = await installedFixture(t)
  const file = path.join(f.config.herdrConfigRoot, 'sessions', f.config.session, 'session.json')
  const pane = { cwd: f.config.sourceRoot, label: 'synthetic ordinary pane' }
  const snapshot = { version: 3, workspaces: [{ id: 'workspace-before-update', tabs: [{ panes: { 1: pane } }] }] }
  const saveSnapshot = () => f.write(file, JSON.stringify(snapshot))
  await saveSnapshot()
  return { ...f, file, pane, snapshot, saveSnapshot }
}
test('clean-stop checkpoint follows official program mapping while retaining original workspace and task data', async t => {
  const f = await ordinaryFixture(t), checkpoint = await captureSessionContinuation(f.config)
  const original = await fs.readFile(f.file)
  const references = path.join(f.config.sourceRoot, '.memoh-computer/attempts/synthetic/receipt.json')
  const session = path.join(f.config.sourceRoot, '.memoh-computer/sessions/synthetic/session.jsonl')
  await f.write(references, 'SYNTHETIC UNRESOLVED ORIGINAL TASK REFERENCE')
  await f.write(session, 'SYNTHETIC PI HISTORY; NEVER REPLAY')
  await assert.rejects(inspectInstalled(f.config, f.run), { code: 'existing_herdr_session_requires_handoff' })
  f.p.herdr = path.join(f.base, 'official-next/herdr.exe')
  await f.write(f.p.herdr, 'INERT NEXT OFFICIAL EXECUTABLE')
  f.connector.instances[0].binary = f.p.herdr
  await f.write(path.join(f.config.agenvoConfigDir, 'config.json'), JSON.stringify(f.connector))
  delete f.config.programs.herdr
  const next = await inspectInstalled(f.config, f.run, { sessionContinuation: checkpoint })
  assert.equal(next.config.programs.herdr, f.p.herdr)
  assert.equal(next.history.workspaceCount, 1)
  assert.deepEqual(await fs.readFile(f.file), original)
  assert.equal(await fs.readFile(references, 'utf8'), 'SYNTHETIC UNRESOLVED ORIGINAL TASK REFERENCE')
  assert.equal(await fs.readFile(session, 'utf8'), 'SYNTHETIC PI HISTORY; NEVER REPLAY')
})
test('data identity changes cannot strand old history by pointing the next run at an empty directory', async t => {
  const f = await ordinaryFixture(t), checkpoint = await captureSessionContinuation(f.config)
  for (const key of ['deviceId', 'runtimeId', 'instanceId', 'session', 'sourceRoot', 'herdrConfigRoot', 'herdrStateRoot', 'agenvoConfigDir', 'piConfigDir']) {
    await assert.rejects(verifySessionContinuation({ ...f.config, [key]: `${f.config[key]}-other` }, checkpoint), { code: 'session_data_identity_changed' })
  }
  await assert.rejects(verifySessionContinuation({ ...f.config, transfer: { nasOrigin: 'https://different.example.test' } }, checkpoint), { code: 'session_data_identity_changed' })
})
test('changed, deleted or externally replaced snapshots are not authorized by an old stop checkpoint', async t => {
  const f = await ordinaryFixture(t), checkpoint = await captureSessionContinuation(f.config)
  f.snapshot.workspaces[0].id = 'different-workspace'; await f.saveSnapshot()
  await assert.rejects(verifySessionContinuation(f.config, checkpoint), { code: 'session_continuation_changed' })
  await fs.rm(f.file)
  await assert.rejects(verifySessionContinuation(f.config, checkpoint), { code: 'session_continuation_changed' })
  await f.saveSnapshot()
  const current = await captureSessionContinuation(f.config)
  await fs.appendFile(path.join(f.config.herdrConfigRoot, 'config.toml'), '\n# changed official config\n')
  await assert.rejects(verifySessionContinuation(f.config, current), { code: 'session_continuation_changed' })
})
test('Agent references, resume commands, launch commands and unfamiliar formats retain the handoff gate', async t => {
  const f = await ordinaryFixture(t)
  for (const [key, value] of [['agent_name', 'original-agent'], ['managed_agent_kind', 'pi'], ['agent_session', { source: 'herdr:pi', agent: 'pi', kind: 'id', value: 'original-session' }], ['agent_resume', { argv: ['pi', '--continue'] }], ['launch_argv', ['run-original-task']], ['future_launch', true]]) {
    f.pane[key] = value; await f.saveSnapshot()
    const checkpoint = await captureSessionContinuation(f.config)
    assert.equal(checkpoint.ordinary, false)
    await assert.rejects(verifySessionContinuation(f.config, checkpoint), { code: 'existing_herdr_session_requires_handoff' })
    delete f.pane[key]
  }
  f.snapshot.version = 4; await f.saveSnapshot()
  assert.equal((await captureSessionContinuation(f.config)).ordinary, false)
})

test('only a confirmed owned stop captures the snapshot; later retries cannot authorize replaced history', async t => {
  const f = await ordinaryFixture(t), driver = new NativeDriver(f.config)
  const owned = { exited: false, done: Promise.resolve() }
  driver.children.set('herdr', owned)
  let stops = 0
  driver.ownedHostRequest = async action => { assert.equal(action, 'server.stop'); stops++; owned.exited = true }
  await driver.stop('herdr')
  const checkpoint = await driver.captureContinuation()
  assert.equal(checkpoint.ordinary, true); assert.equal(stops, 1)
  f.snapshot.workspaces[0].id = 'external-change-after-stop'; await f.saveSnapshot()
  await driver.stop('herdr')
  assert.deepEqual(await driver.captureContinuation(), checkpoint)
  await assert.rejects(verifySessionContinuation(f.config, checkpoint), { code: 'session_continuation_changed' })
  driver.children.set('herdr', { exited: true, done: Promise.resolve() })
  await driver.stop('herdr')
  assert.equal(await driver.captureContinuation(), null); assert.equal(stops, 1)
})
