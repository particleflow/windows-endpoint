import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pickDirectory } from './directory-selection.mjs'
import { configure, main } from './endpoint.mjs'
import { nativeInstalledFixture } from './test-support/installed-fixture.mjs'

test('directory selection returns the exact existing Unicode path without writing or granting a binding', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'workspace picker 空格 '))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const original = path.join(root, 'original.txt'); await fs.writeFile(original, 'KEEP ORIGINAL')
  const before = await fs.readdir(root)
  assert.deepEqual(await pickDirectory({ initialPath: root }, { choose: async initial => {
    assert.equal(initial, root); return { state: 'selected', path: root }
  } }), { state: 'selected', path: root, configurationChanged: false })
  assert.deepEqual(await fs.readdir(root), before)
  assert.equal(await fs.readFile(original, 'utf8'), 'KEEP ORIGINAL')
})

test('cancelled selection performs no filesystem lookup or configuration change', async () => {
  assert.deepEqual(await pickDirectory({}, { choose: async () => ({ state: 'cancelled' }),
    stat: () => { throw new Error('cancel must not inspect a path') } }), { state: 'cancelled', configurationChanged: false })
})

for (const response of [null, { state: 'selected', path: 'https://example.test/work' }, { state: 'selected', path: '../work' },
  { state: 'selected', path: '/work\u0000bad' }, { state: 'cancelled', path: '/unrelated' }, { state: 'selected', path: '/work', authorization: 'invented' }]) {
  test(`invalid picker response is not a filesystem selection: ${JSON.stringify(response)}`, async () => {
    await assert.rejects(pickDirectory({}, { choose: async () => response }), { code: 'directory_picker_response_invalid' })
  })
}

test('unreadable selection is reported without leaking the native error or pretending the computer is offline', async () => {
  await assert.rejects(pickDirectory({}, { choose: async () => ({ state: 'selected', path: path.resolve('synthetic') }),
    stat: async () => { throw Object.assign(new Error('SYNTHETIC PRIVATE ERROR'), { code: 'EACCES' }) } }), error => {
    assert.equal(error.code, 'directory_picker_directory_unavailable')
    assert.equal(error.message.includes('PRIVATE'), false); return true
  })
})

test('configure can browse the local default for fresh references, preserves the input and refuses to overwrite an existing binding', async t => {
  const f = await nativeInstalledFixture(t), input = path.join(f.base, 'input.json'), output = path.join(f.base, 'endpoint.json')
  const selected = path.join(f.base, 'chosen local work 空格'); await fs.mkdir(selected)
  await fs.writeFile(input, JSON.stringify({ ...f.config, sourceRoot: '<choose on Windows>' }))
  const before = await fs.readFile(input)
  const chooseDirectory = async () => ({ state: 'selected', path: selected })
  assert.equal((await configure(input, output, undefined, { browseSourceRoot: true, chooseDirectory })).state, 'references_saved')
  const saved = await fs.readFile(output)
  assert.equal(JSON.parse(saved).sourceRoot, selected)
  assert.equal(JSON.parse(saved).runtimeId, f.config.runtimeId)
  assert.deepEqual(await fs.readFile(input), before)
  await assert.rejects(configure(input, output, undefined, { browseSourceRoot: true, chooseDirectory }), { code: 'EEXIST' })
  assert.deepEqual(await fs.readFile(output), saved)
  assert.deepEqual(await fs.readdir(f.config.sourceRoot), [])
})

test('cancelling configure retains the current default and all config bytes, and creates no new configuration', async t => {
  const f = await nativeInstalledFixture(t), input = path.join(f.base, 'current.json'), output = path.join(f.base, 'not-created.json')
  await fs.writeFile(input, JSON.stringify(f.config)); const before = await fs.readFile(input)
  const options = { browseSourceRoot: true, chooseDirectory: async () => ({ state: 'cancelled' }) }
  assert.deepEqual(await configure(input, output, undefined, options), { state: 'cancelled', configurationChanged: false })
  await assert.rejects(fs.stat(output), { code: 'ENOENT' })
  assert.deepEqual(await configure(input, input, undefined, options), { state: 'cancelled', configurationChanged: false })
  assert.deepEqual(await fs.readFile(input), before)
})

test('a picker cannot bypass the existing overlap guard or introduce arbitrary picker programs', async t => {
  const f = await nativeInstalledFixture(t), input = path.join(f.base, 'input.json'), output = path.join(f.base, 'output.json')
  await fs.writeFile(input, JSON.stringify(f.config))
  await assert.rejects(configure(input, output, undefined, { browseSourceRoot: true,
    chooseDirectory: async () => ({ state: 'selected', path: f.config.piConfigDir }) }), { code: 'component_data_overlap' })
  await assert.rejects(fs.stat(output), { code: 'ENOENT' })
  await assert.rejects(main(['configure', '--from', input, '--config', output, '--browse-source-root', 'arbitrary.exe']), { code: 'invalid_arguments' })
})

if (process.platform === 'win32') test('official Windows folder dialog assembly is available without opening UI or changing configuration', () => {
  const powershell = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'))
  const result = spawnSync(powershell, ['-NoLogo', '-NoProfile', '-STA', '-NonInteractive', '-File',
    fileURLToPath(new URL('./directory-selection.ps1', import.meta.url)), '-CheckOnly'], { env, encoding: 'utf8', timeout: 15000, maxBuffer: 4096 })
  assert.equal(result.status, 0, 'load the Windows built-in assembly only; no interactive picker in CI')
  assert.deepEqual(JSON.parse(result.stdout), { state: 'available', interactiveDesktopRequired: true })
})

if (process.platform !== 'win32') test('the public picker fails explicitly outside Windows without opening a substitute UI', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('./endpoint.mjs', import.meta.url)), 'directory-pick'], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 4096,
  })
  assert.equal(result.status, 2)
  assert.equal(result.stdout, '')
  assert.deepEqual(JSON.parse(result.stderr), { error: 'directory_picker_windows_required' })
})
