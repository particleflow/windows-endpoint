// Actual PS5.1 guard regression in a private inert product tree. It neither
// installs a candidate nor starts an Agent, producer, service or live queue.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

assert.equal(process.platform, 'win32', 'this regression requires actual Windows PowerShell 5.1')
const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

test('stable entry verifies receipt and full inventory under polluted module discovery and fails closed', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'entry hash fixture 空格 ')))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const root = path.join(base, 'inert product'), control = path.join(root, 'control')
  const polluted = path.join(base, 'unrelated modules')
  for (const dir of [control, polluted, path.join(root, 'config'), path.join(root, 'data')]) await fs.mkdir(dir, { recursive: true })
  const launcher = await fs.readFile(new URL('./WindowsEndpoint.ps1', import.meta.url))
  const entry = path.join(control, 'WindowsEndpoint.ps1')
  await fs.writeFile(entry, launcher)
  const child = Buffer.from(`
import {appendFile} from 'node:fs/promises'
import path from 'node:path'
await appendFile(path.resolve(import.meta.dirname, '../../data/node-invocations.txt'), 'once\\n')
process.stdout.write('synthetic_entry_child\\n')
`)
  const manifest = Buffer.from(JSON.stringify({ schema: 1, entry: 'endpoint.mjs', files: [
    { path: 'endpoint.mjs', size: child.length, sha256: sha(child) },
    { path: 'WindowsEndpoint.ps1', size: launcher.length, sha256: sha(launcher) },
  ] }))
  const selected = sha(manifest), source = path.join(root, 'packages', selected)
  await fs.mkdir(source, { recursive: true })
  const manifestFile = path.join(source, 'candidate.json'), payload = path.join(source, 'endpoint.mjs')
  await fs.writeFile(manifestFile, manifest)
  await fs.writeFile(payload, child)
  await fs.writeFile(path.join(source, 'WindowsEndpoint.ps1'), launcher)
  const receiptFile = path.join(control, 'installation.json')
  const receipt = { schema: 1, protocol: 1, phase: 'complete', owner: 'synthetic-owner', launcher_sha256: sha(launcher) }
  const receiptRaw = Buffer.from(JSON.stringify(receipt))
  await fs.writeFile(receiptFile, receiptRaw)
  const config = path.join(root, 'config/endpoint.json'), selection = path.join(control, 'deployment.json')
  await fs.writeFile(config, JSON.stringify({ deviceId: receipt.owner, programs: { node: await fs.realpath(process.execPath) } }))
  await fs.writeFile(selection, JSON.stringify({ owner: receipt.owner, current: selected, pending: null }))
  const retained = [config, selection]
  for (const name of ['unknown.json', 'committed.json', 'opaque-journal']) {
    const file = path.join(root, 'data', name)
    await fs.writeFile(file, `SYNTHETIC RETAINED ${name}\r\n`)
    retained.push(file)
  }
  const originalBytes = await Promise.all(retained.map(file => fs.readFile(file)))
  const calls = path.join(root, 'data/node-invocations.txt')
  const wrapper = path.join(base, 'invoke-entry.ps1')
  await fs.writeFile(wrapper, `
param([string]$Entry,[string]$Polluted,[switch]$FailImport,[switch]$ShadowHash)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'actual_ps51_required' }
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'fixture_requires_full_language' }
Import-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1" -ErrorAction Stop
Remove-Module -Name Microsoft.PowerShell.Utility -ErrorAction SilentlyContinue
$env:PSModulePath = $Polluted
$PSModuleAutoLoadingPreference = 'None'
if ($null -ne (Get-Command Get-FileHash -ErrorAction SilentlyContinue)) { throw 'fixture_hash_command_must_start_unavailable' }
if ($FailImport) { function Import-Module { throw 'synthetic_utility_import_failure' } }
if ($ShadowHash) { function Get-FileHash { throw 'synthetic_unqualified_hash_must_not_run' } }
& $Entry -Action Doctor
exit $LASTEXITCODE
`)
  const parentModules = process.env.PSModulePath
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'))
  env.PSModulePath = polluted
  const run = extra => {
    const r = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', wrapper,
      '-Entry', entry, '-Polluted', polluted, ...extra], { env, encoding: 'utf8', timeout: 15000, maxBuffer: 16384, windowsHide: true, shell: false })
    t.diagnostic(JSON.stringify({ switches: extra, code: r.status, signal: r.signal, spawnError: r.error?.code ?? null, stdout: r.stdout, stderr: r.stderr }))
    assert.equal(r.error, undefined)
    return r
  }
  const good = run([])
  assert.equal(good.status, 0, good.stderr)
  assert.equal(good.stdout.trim(), 'synthetic_entry_child')
  assert.equal(good.stderr, '')
  const shadow = run(['-ShadowHash'])
  assert.equal(shadow.status, 0, shadow.stderr)
  assert.equal(shadow.stdout.trim(), 'synthetic_entry_child')
  assert.equal(shadow.stderr, '')
  const admitted = await fs.readFile(calls)
  const refused = (r, code) => {
    assert.equal(r.status, 2, r.stderr)
    assert.equal(r.stdout, '')
    assert.deepEqual(JSON.parse(r.stderr), { error: code })
  }
  refused(run(['-FailImport']), 'installation_entry_unavailable')
  assert.deepEqual(await fs.readFile(calls), admitted)
  await fs.writeFile(receiptFile, JSON.stringify({ ...receipt, launcher_sha256: '0'.repeat(64) }))
  refused(run([]), 'installation_entry_recovery_required')
  await fs.writeFile(receiptFile, receiptRaw)
  await fs.appendFile(entry, '\n# SYNTHETIC TAMPER\n')
  refused(run([]), 'installation_entry_recovery_required')
  await fs.writeFile(entry, launcher)
  await fs.appendFile(manifestFile, '\n')
  refused(run([]), 'installation_manifest_changed')
  await fs.writeFile(manifestFile, manifest)
  const changed = Buffer.from(child); changed[changed.length - 2] ^= 1
  await fs.writeFile(payload, changed)
  refused(run([]), 'installation_payload_changed')
  await fs.writeFile(payload, child)
  assert.deepEqual(await fs.readFile(calls), admitted)
  assert.deepEqual(await Promise.all(retained.map(file => fs.readFile(file))), originalBytes)
  assert.deepEqual(await fs.readFile(receiptFile), receiptRaw)
  assert.deepEqual(await fs.readFile(entry), launcher)
  assert.equal(process.env.PSModulePath, parentModules)
})
