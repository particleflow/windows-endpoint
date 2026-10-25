import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { programPaths } from '../endpoint.mjs'

export async function installedFixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'existing programs 空格 ')))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const config = { schema: 2, programs: { node: path.join(base, 'programs/node/node.exe'), herdr: path.join(base, 'programs/herdr/herdr.exe'), piPackage: path.join(base, 'programs/npm/pi'), piBin: path.join(base, 'programs/npm/bin'), gitRoot: path.join(base, 'programs/git'), connectorPackage: path.join(base, 'programs/npm/connector') },
    sourceRoot: path.join(base, 'work'), herdrConfigRoot: path.join(base, 'configuration/herdr'), herdrStateRoot: path.join(base, 'state/herdr'), agenvoConfigDir: path.join(base, 'configuration/agenvo'), piConfigDir: path.join(base, 'existing-pi-config'), deviceId: randomUUID(), runtimeId: randomUUID(), instanceId: 'existing-programs', session: 'endpoint-fixture' }
  const p = programPaths(config)
  for (const directory of ['sourceRoot', 'herdrConfigRoot', 'herdrStateRoot', 'agenvoConfigDir', 'piConfigDir'].map(k => config[k])) await fs.mkdir(directory, { recursive: true })
  const write = async (file, text) => { await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text) }
  for (const file of [p.node, p.herdr, p.pi, p.connector, p.git, path.join(p.gitRoot, 'cmd/git.exe'), path.join(p.piBin, 'pi'), path.join(p.piBin, 'pi.cmd')]) await write(file, 'INERT SYNTHETIC PROGRAM; NEVER EXECUTE')
  await write(path.join(p.piBin, 'pi'), `# INERT SYNTHETIC LAUNCHER; NEVER EXECUTE\n# $basedir/${path.relative(p.piBin, p.pi).split(path.sep).join('/')}\n`)
  await write(path.join(config.programs.piPackage, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version: '1.2.0' }))
  await write(path.join(config.programs.connectorPackage, 'package.json'), JSON.stringify({ name: '@agenvo/herdr', version: '0.2.0' }))
  await write(path.join(config.herdrConfigRoot, 'config.toml'), '# SYNTHETIC CONFIG TO PRESERVE\n')
  const connector = { schema: 1, relay: 'https://relay.example.test', deviceId: config.deviceId, instances: [{ id: config.instanceId, kind: 'herdr', binary: p.herdr, cwd: config.sourceRoot, configRoot: config.herdrConfigRoot }] }
  await write(path.join(config.agenvoConfigDir, 'config.json'), JSON.stringify(connector))
  await write(path.join(config.agenvoConfigDir, 'credentials.json'), 'SYNTHETIC UNREAD CREDENTIAL')
  await write(path.join(config.piConfigDir, 'auth.json'), 'SYNTHETIC UNREAD PI CONFIG')
  const versions = { node: '24.14.0', herdr: '0.9.5', pi: '1.2.0' }, calls = []
  function run(file, args, env) {
    calls.push({ file, args, env })
    if (file === p.herdr) return args[0] === '--version' ? `herdr ${versions.herdr}` : '--session server status'
    if (file === p.git) return `${path.join(p.piBin, 'pi')}\n${versions.pi}`
    if (file === path.join(p.gitRoot, 'cmd/git.exe')) return 'git version 2.51.0.windows.1'
    if (file === p.node && args[0] === p.pi) return args[1] === '--version' ? versions.pi : '--mode --session-dir --session-id --provider --model'
    if (file === p.node && args[0] === p.connector) return '{"version":"0.2.0"}'
    if (file === p.node) return `v${versions.node}`
    throw new Error('Unexpected probe')
  }
  const target = { device_id: config.deviceId, instance_id: config.instanceId, session: config.session, work_dir: config.sourceRoot, bash_path: p.git, agent: { execution_mode: 'pi-json-v1', provider: 'synthetic', model: 'synthetic', config_dir: config.piConfigDir } }
  return { base, config, p, connector, write, versions, calls, run, target }
}

// Inert package/config bytes only. Native Runtime secure enrollment loading and
// live connection semantics require their separate actual-process fixture.
export async function nativeInstalledFixture(t) {
  const f = await installedFixture(t), config = f.config
  config.schema = 3
  config.runtimeId = config.deviceId
  delete config.agenvoConfigDir
  config.connector = { kind: 'memoh-runtime', enrollmentFile: path.join(f.base, 'native-enrollment/runtime.json') }
  const legacyRun = f.run
  f.p.connector = programPaths(config).connector
  await f.write(f.p.connector, 'INERT NATIVE RUNTIME; NEVER EXECUTE')
  await f.write(path.join(config.programs.connectorPackage, 'package.json'), JSON.stringify({ name: '@memohai/runtime', version: '0.22.0' }))
  await f.write(config.connector.enrollmentFile, 'SYNTHETIC UNREAD ENROLLMENT')
  f.run = (file, args, env) => {
    if (file === f.p.node && args[0] === f.p.connector) {
      f.calls.push({ file, args, env })
      return args[1] === 'version' ? '0.22.0' : 'Usage: memoh-runtime run --config --log'
    }
    return legacyRun(file, args, env)
  }
  return f
}
