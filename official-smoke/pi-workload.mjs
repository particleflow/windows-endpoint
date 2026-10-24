// Native half of the pending original-task joint test. Real Herdr + official Pi
// + fixed producer projector, synthetic model only. No Memoh/PG/MCP grant claim.
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { catalog, programPaths, verifyToolchain } from '../endpoint.mjs'
import { NativeDriver } from '../lifecycle.mjs'
import { startPiModelFixture, fixtureProvider, fixtureModel, fixtureFile, fixtureBytes, fixtureOutput } from './pi-model-fixture.mjs'

assert.equal(process.platform, 'win32')
assert.equal(process.env.GITHUB_ACTIONS, 'true')
const bundleRoot = await fs.realpath(process.argv[2]), root = path.resolve(process.argv[3]), source = await fs.realpath(process.argv[4])
assert.equal(execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim(), catalog.components.transfer.revision)
await fs.mkdir(root) // Must be a fresh fixture, never an existing installation.
const config = { bundleRoot, sourceRoot: path.join(root, 'work'), herdrConfigRoot: path.join(root, 'config/herdr'), herdrStateRoot: path.join(root, 'state/herdr'), agenvoConfigDir: path.join(root, 'agenvo'), piConfigDir: path.join(root, 'pi'), session: 'joint-pi-fixture', deviceId: randomUUID() }
for (const key of ['sourceRoot', 'herdrConfigRoot', 'herdrStateRoot', 'agenvoConfigDir', 'piConfigDir']) await fs.mkdir(config[key], { recursive: true })
const programs = programPaths(config), sessions = path.join(root, 'sessions'), session = randomBytes(32).toString('hex')
await fs.mkdir(sessions)
await fs.writeFile(path.join(config.herdrConfigRoot, 'config.toml'), '[update]\nversion_check = false\nmanifest_check = false\n')
const model = await startPiModelFixture()
const inherited = { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC, TEMP: root, TMP: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root, PI_OFFLINE: '1' }
const driver = new NativeDriver(config, { inheritedEnvironment: inherited })
let stage = 'toolchain', primaryFailure, cleanupFailure
const reportFailure = (phase, error) => process.stdout.write(JSON.stringify({ nativePiFailure: phase, code: error.code || error.name, helper: error.helper || null }) + '\n')
const ownedRequest = driver.ownedHostRequest.bind(driver)
driver.ownedHostRequest = async action => {
  const started = Date.now()
  process.stdout.write(JSON.stringify({ nativePiOwnedRequest: action, state: 'started' }) + '\n')
  try {
    const response = await ownedRequest(action)
    process.stdout.write(JSON.stringify({ nativePiOwnedRequest: action, state: 'passed', elapsedMs: Date.now() - started }) + '\n')
    return response
  } catch (error) {
    process.stdout.write(JSON.stringify({ nativePiOwnedRequest: action, state: 'failed', elapsedMs: Date.now() - started, code: error.code, helper: error.helper || null }) + '\n')
    throw error
  }
}
try {
  await fs.writeFile(path.join(config.piConfigDir, 'models.json'), JSON.stringify(model.models))
  await fs.writeFile(path.join(config.piConfigDir, 'auth.json'), '{}')
  assert.ok((await verifyToolchain(config, '2.51.0.windows.1')).every(c => c.state === 'passed'))
  const pi = path.join(bundleRoot, catalog.components.pi.entry)
  // This test wrapper records real invocation count/output. It does not create
  // a producer attempt, receipt, queue item or claimed server task identity.
  const wrapper = `const fs=require('node:fs'),{spawnSync}=require('node:child_process');\nfs.appendFileSync('invocations.txt','once\\n');\nconst out=fs.openSync('stdout.jsonl','wx'),err=fs.openSync('stderr.txt','wx');\nlet r;try{r=spawnSync(${JSON.stringify(programs.node)},${JSON.stringify([pi, '--mode', 'json', '--provider', fixtureProvider, '--model', fixtureModel, '--session-dir', sessions, '--session-id', session, '--tools', 'write', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files'])},{input:'Write the fixed synthetic result file, then report completion.',stdio:['pipe',out,err],timeout:60000,windowsHide:true});}finally{fs.closeSync(out);fs.closeSync(err);}\nfs.writeFileSync('exit.json',JSON.stringify({status:r.status,error:r.error?.code??null}));\n`
  await fs.writeFile(path.join(config.sourceRoot, 'run-pi.cjs'), wrapper)
  stage = 'herdr_start'; await driver.start('herdr')
  stage = 'herdr_ready'; await driver.waitReady('herdr')
  stage = 'workspace_create'
  const created = JSON.parse(driver.command(driver.herdr, ['--session', config.session, 'workspace', 'create', '--cwd', config.sourceRoot])).result
  const pane = created.root_pane.pane_id
  stage = 'pi_invoke'
  driver.command(driver.herdr, ['--session', config.session, 'pane', 'run', pane, 'node run-pi.cjs'])
  const deadline = Date.now() + 75000
  let exited
  while (Date.now() < deadline) {
    try { exited = JSON.parse(await fs.readFile(path.join(config.sourceRoot, 'exit.json'), 'utf8')); break }
    catch (e) { if (e.code !== 'ENOENT') throw e }
    await delay(100)
  }
  assert.deepEqual(exited, { status: 0, error: null }, 'Official Pi invocation did not complete')
  assert.equal(await fs.readFile(path.join(config.sourceRoot, fixtureFile), 'utf8'), fixtureBytes)
  assert.equal(await fs.readFile(path.join(config.sourceRoot, 'invocations.txt'), 'utf8'), 'once\n')
  assert.deepEqual(model.snapshot(), { requests: 2, offeredWrites: 1 })
  stage = 'producer_projection'
  const { summarize } = createRequire(import.meta.url)(path.join(source, 'internal/agenvo/pi_result.cjs'))
  const expected = { pi_session_id: session, provider: fixtureProvider, model: fixtureModel }
  const result = summarize(path.join(config.sourceRoot, 'stdout.jsonl'), expected, exited.status)
  assert.equal(result.result.outcome, 'succeeded'); assert.equal(result.result.output, fixtureOutput)
  const history = (await fs.readdir(sessions)).filter(f => f.endsWith('.jsonl'))
  assert.equal(history.length, 1)
  const saved = await fs.readFile(path.join(sessions, history[0]), 'utf8')
  assert.equal(JSON.parse(saved.split('\n')[0]).id, session)
  // A fresh CLI observation and producer read reuse the recorded native result.
  // This is not a connector reconnect or a claim of task/receipt reconciliation.
  stage = 'repeated_observation'
  const snapshot = JSON.parse(driver.command(driver.herdr, ['--session', config.session, 'api', 'snapshot'])).result.snapshot
  assert.ok(snapshot.panes.some(p => p.pane_id === pane))
  assert.deepEqual(summarize(path.join(config.sourceRoot, 'stdout.jsonl'), expected, exited.status), result)
  assert.equal(await fs.readFile(path.join(sessions, history[0]), 'utf8'), saved)
  assert.equal(await fs.readFile(path.join(config.sourceRoot, 'invocations.txt'), 'utf8'), 'once\n')
  assert.deepEqual(model.snapshot(), { requests: 2, offeredWrites: 1 })
  process.stdout.write(JSON.stringify({ nativePiPreparation: 'passed', producer: catalog.components.transfer.revision, officialPi: catalog.components.pi.version, invocationCount: 1, modelRequests: 2, producerProjection: result.result.outcome, persistedSession: true, repeatedReadUnchanged: true, memohPgJointTask: 'not_run', connectorReconnect: 'not_run', realPcNas: false }) + '\n')
} catch (error) {
  primaryFailure = error; reportFailure(stage, error)
} finally {
  try { await driver.stop('herdr') }
  catch (error) { cleanupFailure = error; reportFailure('owned_cleanup', error) }
  try { await model.close() }
  catch (error) { cleanupFailure ||= error; reportFailure('model_cleanup', error) }
  if (!cleanupFailure) process.stdout.write(JSON.stringify({ nativePiPreparationCleanup: 'owned_herdr_stopped_and_fixture_closed' }) + '\n')
}
// Cleanup must run, and its failure must not erase the original failed stage.
if (primaryFailure) throw primaryFailure
if (cleanupFailure) throw cleanupFailure
