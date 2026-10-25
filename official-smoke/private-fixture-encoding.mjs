// Actual Windows PowerShell 5.1 input/output roundtrip; fresh test files only.
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

assert.equal(process.platform, 'win32')
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'endpoint-fixture-utf8-')))
const input = path.join(root, 'input.json'), file = path.join(root, 'references.json')
const raw = JSON.stringify({ program: 'C:\\Synthetic fixture\\中文 空格\\runtime-connector\\dist\\cli.mjs' })
try {
  // Reproduce the prior PowerShell default's loss without changing a code page.
  assert.notEqual(new TextDecoder('windows-1252').decode(Buffer.from(raw)), raw)
  await fs.writeFile(input, JSON.stringify({ root, items: [{ kind: 'file', path: file, content: raw }] }))
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const made = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./private-fixture.ps1', import.meta.url)), '-InputFile', input], { encoding: 'utf8', timeout: 30000, maxBuffer: 16384 })
  assert.equal(made.status, 0, 'fresh private Unicode fixture creation failed')
  assert.deepEqual(await fs.readFile(file), Buffer.from(raw), 'configuration bytes must survive the PowerShell boundary')
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), JSON.parse(raw))
  process.stdout.write(JSON.stringify({ privateFixtureUTF8: 'passed', powershell: 'WindowsPowerShell5.1', systemEncodingChanged: false }) + '\n')
} finally { await fs.rm(root, { recursive: true, force: true }) }
