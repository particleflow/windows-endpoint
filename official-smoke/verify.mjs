import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { once } from 'node:events'
import { main, managedEnvironment, programPaths, verifyToolchain } from '../endpoint.mjs'

assert.equal(process.platform, 'win32')
const root = await fs.realpath(process.argv[2])
const data = path.join(root, 'isolated-data')
const config = {
  schema: 3, programs: { node: path.join(root, 'node/node.exe'), herdr: path.join(root, 'herdr/herdr.exe'), piPackage: path.join(root, 'node_modules/@earendil-works/pi-coding-agent'), piBin: path.join(root, 'node_modules/.bin'), gitRoot: path.join(root, 'git') },
  connector: { kind: 'memoh-runtime', enrollmentFile: path.join(data, 'runtime/enrollment.json') },
  sourceRoot: data, herdrConfigRoot: path.join(data, 'config/herdr'),
  herdrStateRoot: path.join(data, 'state/herdr'),
  piConfigDir: path.join(data, 'pi'), session: 'smoke',
}
for (const p of Object.values(config).filter(v => typeof v === 'string' && path.isAbsolute(v))) await fs.mkdir(p, { recursive: true })
await fs.writeFile(path.join(config.herdrConfigRoot, 'config.toml'), '[update]\nversion_check = false\nmanifest_check = false\n')
const savedPath = process.env.PATH
process.env.PATH = path.join(process.env.SystemRoot, 'System32')
const marker = path.join(data, 'unexpected-shell-profile')
process.env.BASH_ENV = marker
process.env.NODE_OPTIONS = '--require=DO-NOT-LOAD'

const results = []
function checked(name) { results.push({ check: name, state: 'passed' }) }
let server
try {
  const good = await verifyToolchain(config, '2.51.0.windows.1')
  assert.deepEqual(good.filter(c => c.state !== 'passed'), [], JSON.stringify(good))
  checked('official_versions_and_git_bash_without_runner_path')
  const wrong = await verifyToolchain(config, '0.0.0')
  assert.equal(wrong.find(c => c.check === 'git_version').code, 'executable_version_mismatch')
  checked('incorrect_expected_version_rejected')
  for (const [file, check] of [['git/bin/bash.exe', 'git_bash_toolchain'], ['node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js', 'pi_version']]) {
    const full = path.join(root, file)
    await fs.rename(full, full + '.absent')
    try {
      assert.equal((await verifyToolchain(config, '2.51.0.windows.1')).find(c => c.check === check).state, 'blocked')
    } finally { await fs.rename(full + '.absent', full) }
  }
  const absent = { ...config, programs: { ...config.programs, node: path.join(root, 'missing-node.exe') } }
  assert.equal((await verifyToolchain(absent, '2.51.0.windows.1')).find(c => c.check === 'node_version').state, 'blocked')
  checked('missing_node_pi_bash_rejected_without_path_fallback')

  const env = managedEnvironment(config)
  assert.equal(env.AGENVO_CONFIG_DIR, undefined)
  checked('retired_connector_environment_not_emitted')
  const herdr = { file: programPaths(config).herdr, args: ['--session', config.session, 'server'] }
  function status() {
    const r = spawnSync(herdr.file, ['--session', config.session, 'status', 'server', '--json'], { env, encoding: 'utf8', timeout: 3000, maxBuffer: 16384 })
    try { return JSON.parse(r.stdout) } catch { return {} }
  }
  async function start() {
    server = spawn(herdr.file, herdr.args, { env, cwd: data, stdio: ['ignore', 'pipe', 'pipe'] })
    // Drain output without retaining private/native logs in the evidence report.
    server.stdout.resume()
    server.stderr.resume()
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      assert.equal(server.exitCode, null, 'Official Herdr exited before API readiness')
      if (status().running === true) return
      await delay(200)
    }
    throw new Error('Official Herdr API readiness timeout')
  }
  await start()
  assert.equal(status().version, '0.9.5')
  checked('official_herdr_start_and_api_readiness')
  const died = once(server, 'exit')
  server.kill() // Only our isolated cloud fixture; not physical power loss.
  await died
  await start()
  assert.equal(status().running, true)
  checked('explicit_restart_after_isolated_herdr_process_death')
  const closed = once(server, 'exit')
  const stop = spawnSync(herdr.file, ['--session', config.session, 'server', 'stop'], { env, encoding: 'utf8', timeout: 20000, maxBuffer: 16384 })
  assert.equal(stop.status, 0)
  await Promise.race([closed, delay(10000).then(() => { throw new Error('Herdr stop timeout') })])
  server = undefined
  checked('official_herdr_graceful_stop')
  await assert.rejects(main(['start']), /qualification_required/)
  checked('product_activation_still_blocked')
  process.stdout.write(`${JSON.stringify({ officialDependencySmoke: results, transfer: 'not_included_pending_qualification', unattendedRecovery: false, physicalPowerLoss: 'not_tested', gui: 'not_tested' }, null, 2)}\n`)
} finally {
  if (server && server.exitCode === null) server.kill()
  process.env.PATH = savedPath
  delete process.env.NODE_OPTIONS
  delete process.env.BASH_ENV
}
