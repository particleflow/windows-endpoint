import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { configure, main } from './endpoint.mjs'
import { deploymentReferences } from './deployment.mjs'
import { programDeployment, programDeploymentMain, runSelectedProgram } from './program-deployment.mjs'
import { stageCandidate, verifyCandidate } from './candidate.mjs'
import { installedFixture } from './test-support/installed-fixture.mjs'
import { programPackage } from './test-support/program-package.mjs'

const retired = { code: 'legacy_execution_retired' }
const cli = path.resolve('endpoint.mjs')

for (const schema of [1, 2]) test(`schema ${schema} configure refuses before picker, package mapping or destination access`, async t => {
  const f = await installedFixture(t), root = path.join(f.base, 'absent-host')
  const config = schema === 2 ? f.config : deploymentReferences(root, {
    manifestSha256: 'a'.repeat(64), nasOrigin: 'https://nas.example.test', deviceId: f.config.deviceId,
    runtimeId: f.config.runtimeId, instanceId: f.config.instanceId, session: f.config.session,
  })
  const input = path.join(f.base, 'history-reference.json'), output = path.join(f.base, 'absent-reference.json')
  const raw = JSON.stringify(config) + '\r\n'; await f.write(input, raw)
  const packageReferences = { get source() { assert.fail('no package mapping') } }
  await assert.rejects(configure(input, output, undefined, { browseSourceRoot: true,
    chooseDirectory: () => assert.fail('no dialog'), packageReferences }), retired)
  for (const target of [['--root', root], ['--config', output]]) {
    await assert.rejects(main(['configure', '--from', input, ...target]), retired)
    const child = spawnSync(process.execPath, [cli, 'configure', '--from', input, ...target], { encoding: 'utf8', timeout: 10000 })
    assert.equal(child.status, 2); assert.deepEqual(JSON.parse(child.stderr), { error: retired.code })
  }
  await assert.rejects(fs.stat(root), { code: 'ENOENT' }); await assert.rejects(fs.stat(output), { code: 'ENOENT' })
  assert.equal(await fs.readFile(input, 'utf8'), raw)
})

test('retired public bundle stage cannot inspect or copy a payload; native staging refuses a legacy portable candidate', async t => {
  const f = await installedFixture(t), destination = path.join(f.base, 'packages')
  await fs.mkdir(destination); await f.write(path.join(destination, '.pending-original/partial'), 'KEEP ORIGINAL')
  const original = await fs.readdir(destination)
  const args = ['stage', '--source', path.join(f.base, 'absent-bundle'), '--destination', destination, '--manifest-sha256', 'a'.repeat(64)]
  await assert.rejects(main(args), retired)
  const child = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000 })
  assert.equal(child.status, 2); assert.deepEqual(JSON.parse(child.stderr), { error: retired.code })
  const legacy = await programPackage(path.join(f.base, 'old-candidate'), 'historical')
  assert.equal((await verifyCandidate(legacy.directory, legacy.hash)).manifest.native_runtime, undefined, 'historical inventory still readable')
  await assert.rejects(stageCandidate(legacy.directory, destination, legacy.hash), retired)
  assert.deepEqual(await fs.readdir(destination), original)
  assert.equal(await fs.readFile(path.join(destination, '.pending-original/partial'), 'utf8'), 'KEEP ORIGINAL')
  assert.equal((await main(['help'])).commands.some(command => command.startsWith('stage ')), false)
})

for (const schema of [1, 2]) test(`schema ${schema} deploy refuses without runtime.json before preparation, but saved selection remains readable`, async t => {
  const f = await installedFixture(t), root = path.join(f.base, 'old-host')
  const config = schema === 2 ? f.config : deploymentReferences(root, {
    manifestSha256: 'a'.repeat(64), nasOrigin: 'https://nas.example.test', deviceId: f.config.deviceId,
    runtimeId: f.config.runtimeId, instanceId: f.config.instanceId, session: f.config.session,
  })
  const configFile = path.join(root, 'config/endpoint.json'), raw = JSON.stringify(config) + '\r\n'
  await f.write(configFile, raw)
  const receipt = path.join(f.config.sourceRoot, '.memoh-computer/attempts/original/receipt.json')
  const unknown = '{"state":"unknown","revision":"9007199254740993124","RootHash":"ORIGINAL","HostBinding":"ORIGINAL"}\r\n'
  await f.write(receipt, unknown)
  const invoke = async () => {
    for (const prepare of [false, true]) await assert.rejects(programDeployment(root, { prepare }), retired)
    await assert.rejects(runSelectedProgram(root), retired)
    for (const action of ['install', 'update', 'rollback', 'recover', 'run']) {
      const args = [action, '--root', root,
        ...(['install', 'update'].includes(action) ? ['--source', path.join(f.base, 'absent-source')] : []),
        ...(['install', 'update', 'rollback'].includes(action) ? ['--manifest-sha256', 'a'.repeat(64)] : [])]
      await assert.rejects(programDeploymentMain(args), retired)
      await assert.rejects(main(['deploy', ...args]), retired)
    }
  }
  await invoke()
  assert.deepEqual(await fs.readdir(root), ['config'], 'no prepare directories or leases')
  // A non-file at the old runtime path must not be consulted to reject legacy writes.
  await fs.mkdir(path.join(root, 'config/runtime.json')); await invoke()
  for (const name of ['control', 'packages', 'data', 'logs']) await fs.mkdir(path.join(root, name))
  const journal = { schema: 1, owner: config.deviceId, packages: [{ hash: 'a'.repeat(64), profile: 'b'.repeat(64) }],
    current: 'a'.repeat(64), previous: null, pending: { kind: 'stage', hash: 'c'.repeat(64), profile: 'b'.repeat(64) } }
  const journalFile = path.join(root, 'control/deployment.json'), journalRaw = JSON.stringify(journal) + '\n'
  await fs.writeFile(journalFile, journalRaw)
  const status = await main(['deploy', 'status', '--root', root])
  assert.equal(status.state, 'retired-history-only'); assert.equal(status.executionPermitted, false)
  assert.equal(status.selected, journal.current); assert.deepEqual(status.pending, journal.pending)
  assert.equal(await fs.readFile(journalFile, 'utf8'), journalRaw)
  assert.equal(await fs.readFile(configFile, 'utf8'), raw)
  assert.equal(await fs.readFile(receipt, 'utf8'), unknown)
  assert.deepEqual(await fs.readdir(path.join(root, 'control')), ['deployment.json'], 'history read creates no lease or journal')
})
