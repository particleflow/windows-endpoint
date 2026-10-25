// Isolated archive verification; neither install nor a production qualification.
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { installedFixture } from '../test-support/installed-fixture.mjs'

const candidate = await fs.realpath(process.argv[2])
const summary = JSON.parse(await fs.readFile(process.argv[3], 'utf8'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const manifestBytes = await fs.readFile(path.join(candidate, 'candidate.json'))
assert.equal(hash(manifestBytes), summary.manifest_sha256)
const manifest = JSON.parse(manifestBytes)
assert.equal(manifest.source_commit, summary.source_commit)
assert.equal(manifest.producer_commit, summary.producer_commit)
assert.equal(manifest.qualification, 'not-for-production-release')
assert.equal(manifest.positive_production_tls, 'unverified')
const actual = []
async function walk(root, relative = '') {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name
    assert.equal(entry.isSymbolicLink(), false)
    if (entry.isDirectory()) await walk(path.join(root, entry.name), name)
    else { assert.equal(entry.isFile(), true); actual.push(name) }
  }
}
await walk(candidate)
assert.deepEqual(actual.sort(), [...manifest.files.map(f => f.path), 'candidate.json'].sort())
for (const file of manifest.files) {
  assert.ok(!file.path.split('/').some(p => p === '..' || p === '' || p.includes('\\')))
  const data = await fs.readFile(path.join(candidate, file.path))
  assert.equal(data.length, file.size); assert.equal(hash(data), file.sha256)
}
const checks = ['complete_archive_inventory_and_hashes']
const entry = path.join(candidate, 'endpoint.mjs')
const sandbox = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'endpoint-extracted-')))
const cleanups = []
const fixture = await installedFixture({ after(fn) { cleanups.push(fn) } })
function command(args, expected) {
  const r = spawnSync(process.execPath, [entry, ...args], { cwd: sandbox, encoding: 'utf8', timeout: 15000, maxBuffer: 16384, shell: false })
  assert.equal(r.error, undefined); assert.equal(r.status, expected)
  return r.stdout
}
try {
  assert.ok(JSON.parse(command(['help'], 0)).commands.includes('host run --root DIR'))
  command(['update'], 2)
  checks.push('extracted_public_entry_and_unchanged_update_gate')
  const root = path.join(sandbox, 'host')
  await fs.mkdir(path.join(root, 'config'), { recursive: true })
  await fs.mkdir(path.join(root, 'data/endpoint'), { recursive: true })
  const originals = new Map([
    [path.join(root, 'data/endpoint/original-task.json'), 'SYNTHETIC ORIGINAL TASK TO PRESERVE'],
    [path.join(fixture.config.sourceRoot, 'original-result.txt'), 'SYNTHETIC ORIGINAL FILE'],
    [path.join(fixture.config.piConfigDir, 'auth.json'), await fs.readFile(path.join(fixture.config.piConfigDir, 'auth.json'), 'utf8')],
  ])
  for (const [file, value] of originals) await fs.writeFile(file, value)
  const references = path.join(sandbox, 'references.json')
  delete fixture.config.programs.herdr
  await fs.writeFile(references, JSON.stringify(fixture.config))
  command(['configure', '--from', references, '--root', root], 0)
  originals.set(path.join(root, 'config/endpoint.json'), await fs.readFile(path.join(root, 'config/endpoint.json'), 'utf8'))
  command(['configure', '--from', references, '--root', root], 2)
  checks.push('schema2_configure_preserves_existing_references_and_refuses_overwrite')
  const installed = JSON.parse(command(['deploy', 'install', '--root', root, '--source', candidate, '--manifest-sha256', summary.manifest_sha256], 0))
  assert.equal(installed.state, 'selected_review_only')
  assert.equal(installed.officialComponentsChanged, false)
  assert.equal(JSON.parse(command(['deploy', 'install', '--root', root, '--source', candidate, '--manifest-sha256', summary.manifest_sha256], 0)).state, 'already_selected')
  checks.push('managed_program_install_is_repeatable_and_preserves_external_component_mapping')
  // The real packaged foreground entry runs in observer mode, without fixture
  // drivers, credentials, a runtime opt-in or any component execution.
  const child = spawn(process.execPath, [entry, 'deploy', 'run', '--root', root], { cwd: sandbox, stdio: ['pipe', 'pipe', 'pipe'], shell: false })
  let output = '', error = '', closed = false, stopSent = false
  const done = new Promise(resolve => child.once('close', (code, signal) => { closed = true; resolve({ code, signal }) }))
  const timer = setTimeout(() => child.kill(), 15000)
  try {
    child.stdout.on('data', chunk => {
      output += chunk
      if (output.length > 65536) child.kill()
      if (!stopSent && output.includes('"phase":"running"')) { stopSent = true; child.stdin.end('{"action":"stop"}\n') }
    })
    child.stderr.on('data', chunk => { error = (error + chunk).slice(-4096) })
    child.on('error', e => { error = e.code })
    const ended = await done
    assert.deepEqual(ended, { code: 0, signal: null }, error)
    const running = output.trim().split('\n').map(line => JSON.parse(line)).find(s => s.phase === 'running')
    assert.ok(running); assert.equal(running.ready, false)
    assert.equal(running.components, 'unavailable_unqualified')
    assert.equal(running.componentLifecycle, null)
  } finally { clearTimeout(timer); if (!closed) { child.kill(); await done } }
  checks.push('selected_packaged_foreground_observer_starts_and_stops_without_starting_components')
  for (const [file, value] of originals) assert.equal(await fs.readFile(file, 'utf8'), value)
  checks.push('configuration_task_original_and_pi_config_bytes_preserved')
  const missing = path.join(sandbox, 'missing-component-config.json')
  const config = { ...fixture.config, programs: { ...fixture.config.programs, node: path.join(sandbox, 'absent-node.exe') } }
  await fs.writeFile(missing, JSON.stringify(config))
  const doctor = JSON.parse(command(['doctor', '--config', missing], 2))
  assert.equal(doctor.ready, false)
  assert.ok(doctor.checks.some(c => c.state === 'blocked' && c.code === 'installation_input_missing'))
  checks.push('missing_component_is_explicitly_unavailable')
  process.stdout.write(JSON.stringify({ source_commit: manifest.source_commit, producer_commit: manifest.producer_commit, checks, passed: checks.length, qualification: 'not-for-production-release', realPCandNAS: false, positiveProductionTLS: 'unverified' }) + '\n')
} finally {
  for (const cleanup of cleanups) await cleanup()
  await fs.rm(sandbox, { recursive: true, force: true })
}
