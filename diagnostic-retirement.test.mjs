import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { doctor } from './endpoint.mjs'
import { inspectPrograms, inspectInstalled, inspectInstalledTransfer, validateInstalledConfiguration, installedDoctor } from './installed.mjs'
import { readSessionHistory, observeExistingSession } from './session-diagnostics.mjs'
import { ForegroundHost } from './host.mjs'
import { installedFixture, nativeInstalledFixture } from './test-support/installed-fixture.mjs'

for (const schema of [1, 2]) test(`legacy schema ${schema} qualification fails before private references or a probe callback`, async () => {
  const config = { schema, get programs() { assert.fail('no legacy program resolution') }, get agenvoConfigDir() { assert.fail('no legacy private config read') } }
  const run = () => assert.fail('no old process probe')
  for (const invoke of [() => inspectPrograms(config, run), () => inspectInstalled(config, run),
    () => validateInstalledConfiguration(config, { inspectHistoryOnly: true }), () => inspectInstalledTransfer(config),
    () => observeExistingSession({ config, assertUnchanged: run }, run)]) {
    await assert.rejects(invoke(), { code: 'legacy_execution_retired' })
  }
})

test('retired doctor and public CLI read only saved history, ignoring linked private auth/status and missing binaries', async t => {
  const f = await installedFixture(t), session = path.join(f.config.herdrConfigRoot, 'sessions', f.config.session, 'session.json')
  await f.write(session, JSON.stringify({ version: 3, workspaces: [{ tabs: [{ panes: { original: { agent_session: { source: 'herdr:pi', agent: 'pi', kind: 'path', value: 'PRIVATE-HISTORY-PATH' } } } }] }] }))
  const foreign = path.join(f.base, 'private-target')
  await fs.mkdir(foreign); await f.write(path.join(foreign, 'credentials.json'), 'PRIVATE-DO-NOT-READ')
  await fs.rm(f.config.agenvoConfigDir, { recursive: true }); await fs.symlink(foreign, f.config.agenvoConfigDir, 'junction')
  const before = await fs.readFile(session)
  const refuse = () => assert.fail('retired diagnostics cannot probe or query a server')
  const result = await installedDoctor(f.config, null, { run: refuse, observe: refuse })
  assert.equal(result.mode, 'retired-history-only'); assert.equal(result.versions, null); assert.equal(result.credentialsRead, false)
  assert.equal(result.history.piSessionReferences, 1); assert.equal(result.sessionObservation.state, 'not_queried')
  assert.deepEqual(result.checks, [{ check: 'legacy_execution', state: 'blocked', code: 'legacy_execution_retired' }])
  assert.equal(JSON.stringify(result).includes('PRIVATE-'), false)
  assert.deepEqual(await doctor(f.config, refuse), result)
  const input = path.join(f.base, 'retired.json'); await f.write(input, JSON.stringify(f.config))
  const cli = spawnSync(process.execPath, [path.resolve('endpoint.mjs'), 'doctor', '--config', input], { encoding: 'utf8', timeout: 10000 })
  assert.equal(cli.status, 2); assert.deepEqual(JSON.parse(cli.stdout), result); assert.equal(cli.stderr, '')
  const host = new ForegroundHost({ root: f.base })
  await host.observeAuthorization(f.config)
  assert.equal(host.connection, 'unverified')
  assert.deepEqual(await fs.readFile(session), before)
  assert.equal((await readSessionHistory(f.config)).state, 'history_present')
  assert.equal(f.calls.length, 0)
})

test('native qualification retains version/protocol checks without constructing legacy packages or configuration', async t => {
  const f = await nativeInstalledFixture(t)
  await assert.rejects(fs.stat(path.join(f.base, 'configuration/agenvo')), { code: 'ENOENT' })
  const inspected = await inspectInstalled(f.config, f.run)
  assert.equal(inspected.herdrSource, 'explicit_official_installation')
  assert.equal(inspected.versions.connector, '0.22.0'); assert.equal(f.calls.length, 9)
  assert.equal(f.calls.some(c => c.args.includes('--version') && c.args[0] === f.p.connector), false)
  assert.equal(f.calls.some(c => c.args[0] === f.p.connector && c.args[1] === 'version'), true)
  const host = new ForegroundHost({ root: f.base })
  await host.observeAuthorization(f.config)
  assert.equal(host.connection, 'authorization_unverified')
})
