// Isolated actual PS5 bootstrap regression. No candidate build, installation,
// receipt change, Agent execution, credential or global environment mutation.
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

assert.equal(process.platform, 'win32', 'this regression requires actual Windows PowerShell 5.1')
const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')

test('bootstrap verifies exact Node bytes under polluted PSModulePath and refuses mismatch or unavailable verifier', async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'bootstrap module fixture 空格 ')))
  t.after(() => fs.rm(base, { recursive: true, force: true }))
  const bootstrap = path.join(base, 'endpoint.ps1')
  await fs.copyFile(new URL('./endpoint.ps1', import.meta.url), bootstrap)
  const calls = path.join(base, 'node-invocations.txt')
  await fs.writeFile(path.join(base, 'endpoint.mjs'), `
    import {appendFile} from 'node:fs/promises'
    await appendFile(new URL('./node-invocations.txt', import.meta.url), 'once\\n')
    process.stdout.write('synthetic_bootstrap_child\\n')
  `)
  const polluted = path.join(base, 'unrelated modules')
  await fs.mkdir(polluted)
  const wrapper = path.join(base, 'invoke-bootstrap.ps1')
  await fs.writeFile(wrapper, `
param([string]$Bootstrap,[string]$NodePath,[string]$NodeSha256,[string]$Polluted,[switch]$FailImport)
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) { throw 'actual_ps51_required' }
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { throw 'fixture_requires_full_language' }
# Load only the path guards first, so this fixture isolates Utility discovery.
Import-Module -Name "$PSHOME\\Modules\\Microsoft.PowerShell.Management\\Microsoft.PowerShell.Management.psd1" -ErrorAction Stop
Remove-Module -Name Microsoft.PowerShell.Utility -ErrorAction SilentlyContinue
$env:PSModulePath = $Polluted
$PSModuleAutoLoadingPreference = 'None'
if ($null -ne (Get-Command Get-FileHash -ErrorAction SilentlyContinue)) { throw 'fixture_hash_command_must_start_unavailable' }
if ($FailImport) {
    # Test-only injected loader failure; the OS modules and product are untouched.
    function Import-Module { throw 'synthetic_utility_import_failure' }
}
& $Bootstrap -NodePath $NodePath -NodeSha256 $NodeSha256 help
exit $LASTEXITCODE
`)
  const node = await fs.realpath(process.execPath)
  const hash = createHash('sha256').update(await fs.readFile(node)).digest('hex')
  const parentModules = process.env.PSModulePath
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'))
  env.PSModulePath = polluted
  const run = (expectedHash, failImport = false) => {
    const result = spawnSync(powershell, [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-File', wrapper,
      '-Bootstrap', bootstrap, '-NodePath', node, '-NodeSha256', expectedHash, '-Polluted', polluted,
      ...(failImport ? ['-FailImport'] : []),
    ], { env, encoding: 'utf8', timeout: 15000, maxBuffer: 16384, windowsHide: true, shell: false })
    t.diagnostic(JSON.stringify({ powershell, failImport, expectedHash, code: result.status, signal: result.signal,
      error: result.error?.code ?? null, stdout: result.stdout, stderr: result.stderr }))
    return result
  }
  const good = run(hash)
  assert.equal(good.error, undefined)
  assert.equal(good.status, 0, good.stderr)
  assert.equal(good.stdout.trim(), 'synthetic_bootstrap_child')
  assert.equal(good.stderr, '')
  const admitted = await fs.readFile(calls)
  const wrong = run('0'.repeat(64))
  assert.equal(wrong.error, undefined)
  assert.equal(wrong.status, 2, wrong.stderr)
  assert.equal(wrong.stdout, '')
  assert.match(wrong.stderr, /node_hash_mismatch/)
  assert.deepEqual(await fs.readFile(calls), admitted)
  const unavailable = run(hash, true)
  assert.equal(unavailable.error, undefined)
  assert.equal(unavailable.status, 2, unavailable.stderr)
  assert.equal(unavailable.stdout, '')
  assert.match(unavailable.stderr, /node_hash_verifier_unavailable/)
  assert.deepEqual(await fs.readFile(calls), admitted)
  assert.equal(process.env.PSModulePath, parentModules)
})
