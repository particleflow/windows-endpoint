import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { hostReferenceLayout, deploymentReferencePaths } from './deployment.mjs'
import { configure, digest, main } from './endpoint.mjs'
import { setupEndpoint } from './setup.mjs'
import { programDeployment } from './program-deployment.mjs'
import { validateInstalledConfiguration } from './installed.mjs'
import { nativeInstalledFixture } from './test-support/installed-fixture.mjs'
import { programPackage } from './test-support/program-package.mjs'
import { ForegroundHost } from './host.mjs'

async function fixture(t) {
  const f = await nativeInstalledFixture(t), root = path.join(f.base, 'persistent product'), slots = deploymentReferencePaths(root)
  const config = { ...f.config, sourceRoot: slots.sourceRoot, herdrConfigRoot: slots.herdrConfigRoot,
    herdrStateRoot: slots.herdrStateRoot, piConfigDir: slots.piConfigDir,
    connector: { ...f.config.connector, enrollmentFile: path.join(root, 'config/runtime/enrollment.json') } }
  // Only this fixture's inert files are copied, never user configuration.
  await fs.mkdir(path.join(root, 'config'), { recursive: true })
  await fs.mkdir(config.sourceRoot, { recursive: true }); await fs.mkdir(config.herdrStateRoot, { recursive: true })
  await fs.cp(f.config.herdrConfigRoot, config.herdrConfigRoot, { recursive: true })
  await fs.cp(f.config.piConfigDir, config.piConfigDir, { recursive: true })
  await fs.mkdir(path.dirname(config.connector.enrollmentFile))
  await fs.copyFile(f.config.connector.enrollmentFile, config.connector.enrollmentFile)
  const input = path.join(f.base, 'input.json'); await fs.writeFile(input, JSON.stringify(config))
  const candidate = await programPackage(path.join(f.base, 'candidate'), 'central-layout', { native: true })
  const options = { from: input, root, source: candidate.directory, manifestSha256: candidate.hash, transfer: 'disabled' }
  const protectedFiles = [input, path.join(config.piConfigDir, 'auth.json'), path.join(config.herdrConfigRoot, 'config.toml'), config.connector.enrollmentFile]
  const original = await Promise.all(protectedFiles.map(file => fs.readFile(file)))
  return { ...f, root, config, input, candidate, options, protectedFiles, original }
}
const doctor = async () => ({ checks: [], ready: false })

test('one layout permits dedicated component data but does not adopt external user programs or claim Pi archives exist', async t => {
  const f = await fixture(t), report = hostReferenceLayout(f.root, f.config)
  assert.equal(report.compatible, true)
  assert.equal(report.references.filter(entry => entry.kind === 'component_data').every(entry => entry.centralized), true)
  assert.equal(report.references.filter(entry => entry.kind === 'program_reference').every(entry => !entry.centralized), true)
  assert.equal(report.dependencyOwnership, 'existing_references_not_adopted')
  assert.equal(report.piTaskArchives.currentExistence, 'not_checked')
  assert.equal(report.piTaskArchives.directory, path.join(f.config.sourceRoot, '.memoh-computer/sessions'))
  assert.equal(report.deletionImplemented, false)
  const publicReport = await main(['layout', '--config', f.input, '--root', f.root])
  assert.equal(publicReport.state, 'layout_references_valid')
  assert.equal(publicReport.capabilitiesVerified, false)
  assert.equal(JSON.stringify(publicReport).includes('SYNTHETIC UNREAD'), false)
})

test('configure, setup and program update share the same central layout and preserve all component bytes', async t => {
  const f = await fixture(t)
  await configure(f.input, undefined, f.root)
  assert.equal((await setupEndpoint(f.options, { doctor })).state, 'prepared_review_only')
  const next = await programPackage(path.join(f.base, 'next package'), 'next', { native: true })
  const manager = await programDeployment(f.root)
  await manager.stage(next.directory, next.hash)
  assert.equal((await manager.select(next.hash, 'update')).state, 'selected_review_only')
  assert.deepEqual(await Promise.all(f.protectedFiles.map(file => fs.readFile(file))), f.original)
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, 'config/endpoint.json'))).piConfigDir, f.config.piConfigDir)
  assert.deepEqual(await fs.readdir(f.config.sourceRoot), [], 'updating never creates or purges task history')
  const host = new ForegroundHost({ root: f.root, createTestRuntime: async ({ config }) => {
    assert.equal(config.piConfigDir, f.config.piConfigDir)
    return { start: async () => {}, stop: async () => {}, snapshot: () => ({ phase: 'running', attention: null,
      cleanupAttention: null, journal: 'observed', restartsInWindow: 0 }) }
  } })
  try { await host.start(); assert.equal(host.attention, null); assert.equal(host.components, 'synthetic_fixture') }
  finally { await host.stop() }
})

test('reserved host records, component programs and logs remain protected from data overlap', async t => {
  const f = await nativeInstalledFixture(t), root = path.join(f.base, 'product')
  const cases = [
    { sourceRoot: path.join(root, 'data/endpoint') },
    { sourceRoot: path.join(root, 'config/work') },
    { piConfigDir: path.join(root, 'data') },
    { piConfigDir: path.join(root, 'logs/pi') },
    { connector: { ...f.config.connector, enrollmentFile: path.join(root, 'config/endpoint.json') } },
    { programs: { ...f.config.programs, herdr: path.join(root, 'data/program/herdr.exe') } },
  ]
  for (const delta of cases) assert.equal(hostReferenceLayout(root, { ...f.config, ...delta }).compatible, false)
})

test('central configuration refuses an old reader before writing references or selecting it', async t => {
  const f = await fixture(t)
  delete f.candidate.manifest.central_component_data
  await fs.writeFile(path.join(f.candidate.directory, 'candidate.json'), JSON.stringify(f.candidate.manifest))
  const hash = await digest(path.join(f.candidate.directory, 'candidate.json'))
  await assert.rejects(setupEndpoint({ ...f.options, manifestSha256: hash }, { doctor }), { code: 'deployment_central_data_unsupported' })
  await assert.rejects(fs.stat(path.join(f.root, 'config/endpoint.json')), { code: 'ENOENT' })
  assert.deepEqual(await Promise.all(f.protectedFiles.map(file => fs.readFile(file))), f.original)
})

test('a centralized installation cannot select or roll back to a reader without the layout capability', async t => {
  const f = await fixture(t)
  await setupEndpoint(f.options, { doctor })
  const old = await programPackage(path.join(f.base, 'old reader'), 'old', { native: true })
  delete old.manifest.central_component_data
  await fs.writeFile(path.join(old.directory, 'candidate.json'), JSON.stringify(old.manifest))
  const oldHash = await digest(path.join(old.directory, 'candidate.json'))
  const manager = await programDeployment(f.root), before = await fs.readFile(manager.file)
  await manager.stage(old.directory, oldHash)
  const staged = await fs.readFile(manager.file)
  for (const mode of ['update', 'rollback']) {
    await assert.rejects(manager.select(oldHash, mode), { code: 'deployment_central_data_unsupported' })
    assert.deepEqual(await fs.readFile(manager.file), staged)
  }
  assert.equal(JSON.parse(before).current, JSON.parse(staged).current)
})

test('allowing co-location never accepts a component-data junction or relaxes native directory checks', async t => {
  const f = await fixture(t), originalPi = f.config.piConfigDir + '-original'
  await fs.rename(f.config.piConfigDir, originalPi)
  await fs.symlink(originalPi, f.config.piConfigDir, 'junction')
  await assert.rejects(validateInstalledConfiguration(f.config, { inspectHistoryOnly: true }), error =>
    ['noncanonical_path', 'reparse_point_rejected'].includes(error.code))
  assert.equal(await fs.readFile(path.join(originalPi, 'auth.json'), 'utf8'), 'SYNTHETIC UNREAD PI CONFIG')
})
