import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { planRetirement } from './plan-agenvo-retirement.mjs'

function manifest() {
  return { schema: 1, endpointCommit: '1537fe39256bd7f208fe3da2b4323c6bf2a9fc04', productRoot: 'C:\\Users\\Synthetic\\AppData\\Local\\GarnetAssistant',
    references: { runtimeId: '11111111-1111-4111-8111-111111111111', deviceId: '11111111-1111-4111-8111-111111111111', instanceId: 'existing-herdr', session: 'existing-session',
      hostRoot: 'F:\\NAS-Assistant\\deploy\\.build\\windows-endpoint\\host', sourceRoot: 'F:\\NAS-Assistant\\deploy\\.build\\windows-endpoint\\host\\data\\exports',
      piConfigDir: 'F:\\NAS-Assistant\\deploy\\.build\\agenvo\\windows\\pi-magpie', herdrConfigRoot: 'F:\\ExistingConfig\\herdr', herdrStateRoot: 'F:\\ExistingState\\herdr',
      runtimeEnrollmentFile: 'F:\\ExistingConfig\\runtime\\enrollment.json', transferConfigDir: 'F:\\ExistingConfig\\transfer', transferStateDir: 'F:\\ExistingState\\transfer',
      programs: { node: 'C:\\Tools\\node\\node.exe', herdr: 'C:\\Tools\\herdr\\herdr.exe', piPackage: 'C:\\Tools\\pi', piBin: 'C:\\Tools\\pi-bin', gitRoot: 'C:\\Tools\\Git' } } }
}

test('offline dry-run preserves original identity and active references without a deletion or migration permit', () => {
  const input = manifest(), before = JSON.stringify(input), plan = planRetirement(input)
  assert.equal(JSON.stringify(input), before)
  assert.equal(plan.executionPermitted, false)
  assert.deepEqual(plan.cleanup.eligiblePaths, [])
  assert.equal(plan.identity.runtimeId, input.references.runtimeId)
  assert.equal(plan.preserved.sourceRoot, input.references.sourceRoot)
  assert.deepEqual(plan.preserved.programs, input.references.programs)
  assert.equal(plan.proposals.find(p => p.reference === 'piConfigDir').current, input.references.piConfigDir)
  assert.equal(plan.proposals.every(p => p.status.startsWith('blocked_')), true)
})

test('rejects secret-like extra fields, identity substitutions, build-root destinations and overlapping roots', () => {
  const cases = [
    m => { m.references.token = 'never accept credentials' },
    m => { m.references.programs.connectorPackage = 'C:\\Legacy\\Agenvo' },
    m => { m.references.deviceId = '22222222-2222-4222-8222-222222222222' },
    m => { m.endpointCommit = '0'.repeat(40) },
    m => { m.productRoot = 'F:\\NAS-Assistant\\deploy\\.build\\new-host' },
    m => { m.productRoot = 'F:\\ExistingConfig\\herdr\\new-host' },
    m => { m.references.piConfigDir = 'F:\\ExistingConfig\\..\\Pi' },
  ]
  for (const mutate of cases) { const m = manifest(); mutate(m); assert.throws(() => planRetirement(m)) }
})

test('CLI runs from a manifest while all declared old paths are absent and writes no files', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agenvo-retirement-dry-run-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const file = path.join(root, '.agenvo-retirement-plan-input.json')
  await fs.writeFile(file, JSON.stringify(manifest()))
  const result = spawnSync(process.execPath, [path.resolve('scripts/plan-agenvo-retirement.mjs'), '--manifest', file], { encoding: 'utf8', cwd: process.cwd() })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).executionPermitted, false)
  assert.deepEqual(await fs.readdir(root), ['.agenvo-retirement-plan-input.json'])
  await fs.writeFile(file, JSON.stringify({ token: 'SECRET-DO-NOT-ECHO' }))
  const refused = spawnSync(process.execPath, [path.resolve('scripts/plan-agenvo-retirement.mjs'), '--manifest', file], { encoding: 'utf8' })
  assert.equal(refused.status, 2)
  assert.equal((refused.stdout + refused.stderr).includes('SECRET-DO-NOT-ECHO'), false)
})


test('preserves an existing UNC workspace without moving it into the product root', () => {
  const input = manifest()
  input.references.sourceRoot = '\\\\synthetic-server\\share\\original-work'
  assert.equal(planRetirement(input).preserved.sourceRoot, input.references.sourceRoot)
})
