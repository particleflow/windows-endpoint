import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { readSessionHistory, observeExistingSession } from './session-diagnostics.mjs'
import { inspectInstalled } from './installed.mjs'
import { installedFixture } from './test-support/installed-fixture.mjs'

const savedFile = c => path.join(c.herdrConfigRoot, 'sessions', c.session, 'session.json')
const pi = { source: 'herdr:pi', agent: 'pi', kind: 'path', value: 'PRIVATE_SYNTHETIC_PI_SESSION' }
const history = { version: 3, workspaces: [{ custom_name: 'PRIVATE_SYNTHETIC_TITLE', identity_cwd: 'PRIVATE_SYNTHETIC_CWD', tabs: [{ panes: { 1: { cwd: 'PRIVATE_SYNTHETIC_CWD', agent_session: pi, launch_argv: ['PRIVATE_SYNTHETIC_COMMAND'] } } }] }] }
test('historical workspaces and Pi references are projected without text disclosure or restore claims', async t => {
  const f = await installedFixture(t), file = savedFile(f.config), bytes = JSON.stringify(history)
  await f.write(file, bytes)
  const result = await readSessionHistory(f.config)
  assert.equal(result.state, 'history_present'); assert.equal(result.workspaceCount, 1); assert.equal(result.paneCount, 1); assert.equal(result.piSessionReferences, 1)
  assert.equal(result.restoreEligibility, 'not_verified'); assert.equal(result.businessTasks, 'not_inferred'); assert.equal(result.startup, 'requires_handoff')
  assert.ok(!JSON.stringify(result).includes('PRIVATE_SYNTHETIC'))
  assert.equal(await fs.readFile(file, 'utf8'), bytes)
})
test('missing, empty, legacy, newer and malformed snapshots remain distinct and unchanged', async t => {
  const f = await installedFixture(t), file = savedFile(f.config)
  assert.equal((await readSessionHistory(f.config)).state, 'absent')
  for (const [raw, state] of [[JSON.stringify({ version: 3, workspaces: [] }), 'empty_current_format'], [JSON.stringify({ ...history, version: 2 }), 'legacy_requires_native_validation'], [JSON.stringify({ ...history, version: 4 }), 'newer_format'], ['{}', 'unrecognized_structure'], ['{', 'invalid_json']]) {
    await f.write(file, raw)
    assert.equal((await readSessionHistory(f.config)).state, state)
    assert.equal(await fs.readFile(file, 'utf8'), raw)
  }
})
test('oversized and linked snapshot files are uninspected rather than classified as corrupted', async t => {
  const f = await installedFixture(t), file = savedFile(f.config)
  await f.write(file, '{}'); await fs.truncate(file, 4 * 1024 ** 2 + 1)
  assert.equal((await readSessionHistory(f.config)).state, 'over_read_limit')
  assert.equal((await fs.stat(file)).size, 4 * 1024 ** 2 + 1)
  await fs.rm(file); const original = path.join(f.base, 'original-snapshot')
  await fs.writeFile(original, JSON.stringify(history)); await fs.link(original, file)
  assert.equal((await readSessionHistory(f.config)).state, 'unsafe_path')
  assert.equal(await fs.readFile(original, 'utf8'), JSON.stringify(history))
})
test('diagnostic preflight may inspect history while the normal runtime gate remains closed', async t => {
  const f = await installedFixture(t)
  await f.write(savedFile(f.config), JSON.stringify(history))
  await assert.rejects(inspectInstalled(f.config, f.run), { code: 'existing_herdr_session_requires_handoff' })
  assert.equal(f.calls.length, 0)
  const inspected = await inspectInstalled(f.config, f.run, { inspectHistoryOnly: true })
  assert.equal(inspected.history.state, 'history_present'); assert.equal(f.calls.length, 8)
  await assert.rejects(inspectInstalled(f.config, f.run), { code: 'existing_herdr_session_requires_handoff' })
  await f.write(savedFile(f.config), JSON.stringify({ version: 3, workspaces: [], annotation: 'x'.repeat(65536) }))
  assert.equal((await readSessionHistory(f.config)).state, 'empty_current_format')
  await assert.rejects(inspectInstalled(f.config, f.run), { code: 'existing_herdr_session_requires_handoff' })
})
async function observationFixture(t) {
  const f = await installedFixture(t), calls = [], marker = path.join(f.config.herdrConfigRoot, 'sessions', f.config.session, 'herdr.sock')
  await f.write(marker, '123:456')
  const inspected = await inspectInstalled(f.config, f.run)
  const status = { running: true, version: '0.9.5', protocol: 1, session: f.config.session, compatible: true, endpoint_compatible: true }
  const snapshot = { version: '0.9.5', protocol: 1, workspaces: [{ title: 'PRIVATE_SYNTHETIC_TITLE' }], tabs: [{}], panes: [{ agent_session: pi, cwd: 'PRIVATE_SYNTHETIC_CWD' }], agents: [{}] }
  const run = async (file, args) => {
    calls.push({ file, args })
    return { status: 0, stdout: JSON.stringify(args.includes('status') ? status : { id: 'cli:api:snapshot', result: { type: 'session_snapshot', snapshot } }) }
  }
  return { ...f, inspected, marker, status, snapshot, run, queries: calls }
}
test('native observation permits only status and snapshot and grants no stop or task authority', async t => {
  const f = await observationFixture(t), result = await observeExistingSession(f.inspected, f.run)
  assert.equal(result.state, 'observed_unowned'); assert.equal(result.stopAuthority, false); assert.equal(result.ownership, 'not_acquired')
  assert.equal(result.workspaceCount, 1); assert.equal(result.piSessionReferences, 1); assert.equal(result.businessTasks, 'not_inferred')
  assert.deepEqual(f.queries.map(q => q.args), [['--session', f.config.session, 'status', 'server', '--json'], ['--session', f.config.session, 'api', 'snapshot']])
  assert.ok(f.queries.every(q => q.file === f.p.herdr)); assert.ok(!JSON.stringify(result).includes('PRIVATE_SYNTHETIC'))
})
test('not running is reported only from a successful native observation without starting a server', async t => {
  const f = await observationFixture(t); f.status.running = false
  assert.equal((await observeExistingSession(f.inspected, f.run)).state, 'not_running')
  assert.equal(f.queries.length, 1)
  assert.equal((await observeExistingSession(f.inspected, async () => ({ status: 0, stdout: '{"running":false}' }))).state, 'query_unavailable')
  for (const run of [async () => ({ status: 1, stdout: 'PRIVATE_SYNTHETIC_ERROR' }), async () => ({ status: 0, stdout: '{' }), async () => { throw Object.assign(new Error('PRIVATE_SYNTHETIC_ERROR'), { code: 'query_outcome_unknown' }) }]) {
    const result = await observeExistingSession(f.inspected, run)
    assert.equal(result.state, 'query_unavailable'); assert.equal(result.stopAuthority, false)
    assert.ok(!JSON.stringify(result).includes('PRIVATE_SYNTHETIC'))
  }
  assert.equal((await observeExistingSession(f.inspected, async () => { throw Object.assign(new Error(), { code: 'EACCES' }) })).state, 'permission_denied')
})
test('protocol uncertainty and generation replacement do not produce a valid external-session observation', async t => {
  const f = await observationFixture(t)
  f.status.endpoint_compatible = false
  assert.equal((await observeExistingSession(f.inspected, f.run)).state, 'query_unavailable'); assert.equal(f.queries.length, 1)
  f.status.endpoint_compatible = true
  const protocol = f.status.protocol; delete f.status.protocol
  assert.equal((await observeExistingSession(f.inspected, f.run)).reason, 'query_protocol_unverified')
  f.status.protocol = protocol
  const result = await observeExistingSession(f.inspected, async (...args) => {
    const response = await f.run(...args)
    if (args[1].includes('snapshot')) await fs.writeFile(f.marker, '123:789')
    return response
  })
  assert.equal(result.reason, 'query_generation_changed'); assert.equal(result.workspaceCount, null)
})
