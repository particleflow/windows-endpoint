import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { catalog, digest } from '../endpoint.mjs'
import { DeploymentTransactions } from '../deployment.mjs'
import { StateStore } from '../lifecycle.mjs'

export async function syntheticBundle(directory, revision, format = 1) {
  const manifest = { schema: 1, platform: 'win32-x64', qualification: 'review-only', components: {}, files: [] }
  const names = new Set([...catalog.requiredFiles, 'fixture-revision.txt', 'fixture-state-profile.json'])
  for (const [id, spec] of Object.entries(catalog.components)) {
    manifest.components[id] = { version: spec.version || '2.51.0.windows.1', source: spec.source, revision: spec.revision || 'v2.51.0.windows.1', entry: spec.entry }
    names.add(spec.entry); if (spec.package) names.add(spec.package)
  }
  for (const name of names) {
    await fs.mkdir(path.dirname(path.join(directory, name)), { recursive: true })
    await fs.writeFile(path.join(directory, name), 'SYNTHETIC INERT PAYLOAD; NEVER EXECUTE')
  }
  for (const spec of Object.values(catalog.components).filter(c => c.package)) await fs.writeFile(path.join(directory, spec.package), JSON.stringify({ name: spec.name, version: spec.version }))
  await fs.writeFile(path.join(directory, 'fixture-revision.txt'), revision)
  // This is a toy state format. It is not an asserted official component schema.
  await fs.writeFile(path.join(directory, 'fixture-state-profile.json'), JSON.stringify({ syntheticQueueFormat: format }))
  const proofs = []
  for (const name of ['transferqueue.exe', 'herdr-plugin.toml']) proofs.push({ name, sha256: await digest(path.join(directory, 'transfer', name)) })
  await fs.writeFile(path.join(directory, 'transfer/SHA256SUMS.json'), JSON.stringify({ source_commit: catalog.components.transfer.revision, arch: 'amd64', files: proofs }))
  for (const name of names) manifest.files.push({ path: name, size: (await fs.stat(path.join(directory, name))).size, sha256: await digest(path.join(directory, name)) })
  await fs.writeFile(path.join(directory, 'bundle.json'), JSON.stringify(manifest))
  return { directory, hash: await digest(path.join(directory, 'bundle.json')), profile: await digest(path.join(directory, 'fixture-state-profile.json')) }
}

export function fixtureManager(settings, options = {}) {
  return new DeploymentTransactions({ ...settings,
    qualify: async directory => ({ schema: 1, stateProfileSha256: await digest(path.join(directory, 'fixture-state-profile.json')) }),
    inspectWork: async () => ({ schema: 1, admission: 'closed', tasks: 'idle', transfers: 'idle', stateProfileSha256: settings.profile }),
    ...options })
}

export async function deploymentFixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'endpoint deploy 空格 ')))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const a = await syntheticBundle(path.join(base, 'source-a'), 'a')
  const b = await syntheticBundle(path.join(base, 'source-b'), 'b')
  const root = path.join(base, 'install')
  const config = { schema: 1, bundleRoot: a.directory, manifestSha256: a.hash, nasOrigin: 'https://nas.example.test',
    sourceRoot: path.join(root, 'data/exports'), herdrConfigRoot: path.join(root, 'config/herdr'), herdrStateRoot: path.join(root, 'data/herdr'),
    agenvoConfigDir: path.join(root, 'config/agenvo'), piConfigDir: path.join(root, 'data/pi'),
    transferConfigDir: path.join(root, 'config/herdr/plugins/config/memoh.delivery'), transferStateDir: path.join(root, 'data/herdr/plugins/memoh.delivery'),
    deviceId: '11111111-1111-4111-8111-111111111111', runtimeId: '22222222-2222-4222-8222-222222222222', instanceId: 'fixture-herdr', session: 'default' }
  const lifecycleDirectory = path.join(root, 'data/endpoint')
  for (const directory of [lifecycleDirectory, ...['sourceRoot', 'herdrConfigRoot', 'herdrStateRoot', 'agenvoConfigDir', 'piConfigDir', 'transferConfigDir', 'transferStateDir'].map(k => config[k])]) await fs.mkdir(directory, { recursive: true })
  const settings = { root, config, lifecycleDirectory, profile: a.profile }
  const store = new StateStore(lifecycleDirectory, config.deviceId)
  await store.save({ schema: 1, identity: config.deviceId, phase: 'stopped', attention: null, restarts: [] })
  const originals = [path.join(config.sourceRoot, 'original.bin'), path.join(config.transferStateDir, 'queue.jsonl'), path.join(config.herdrConfigRoot, 'config.toml'), path.join(config.agenvoConfigDir, 'credentials.json'),
    path.join(config.herdrStateRoot, 'session.json'), path.join(config.piConfigDir, 'task.json'), path.join(root, 'config/endpoint.json'), path.join(root, 'logs/prior.log')]
  for (const file of originals) { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'SYNTHETIC USER FILE: PRESERVE EXACTLY') }
  const manager = fixtureManager(settings)
  await manager.initialize()
  const input = path.join(base, 'fixture.json')
  await fs.writeFile(input, JSON.stringify(settings))
  return { base, root, a, b, config, lifecycleDirectory, settings, input, manager, store, originals }
}
