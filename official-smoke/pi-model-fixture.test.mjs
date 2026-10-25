import test from 'node:test'
import assert from 'node:assert/strict'
import { startPiModelFixture, fixtureModel, fixtureFile, fixtureBytes, fixtureOutput } from './pi-model-fixture.mjs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { piWorkloadWrapper, piWorkloadEvidence, diagnosticText, isFreshPiShellPrompt } from './pi-workload-diagnostics.mjs'

test('Pi launch requires the empty prompt for its exact fresh workspace, never an echoed command or another directory', () => {
  const work = 'D:\\runner temp\\fixture 空格\\work'
  assert.equal(isFreshPiShellPrompt(`PowerShell\r\nPS ${work}> `, work), true)
  for (const output of ['', `PS ${work}`, `PS ${work}> node run-pi.cjs`, 'PS C:\\other> ', `PS ${work}>\r\nloading`]) {
    assert.equal(isFreshPiShellPrompt(output, work), false)
  }
})

test('Pi fixture diagnostics distinguish an unstarted wrapper from actual child failure without exposing credentials', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi evidence 空格 ')); t.after(() => fs.rm(root, { recursive: true, force: true }))
  const before = await piWorkloadEvidence(root)
  assert.ok(Object.values(before).every(file => file.state === 'absent'))
  const piConfig = path.join(root, 'pi')
  const script = "require('node:fs').readFileSync(0);console.error('Error: synthetic launch failure');console.error('Authorization: Bearer fixture-secret');process.exit(7)"
  await fs.writeFile(path.join(root, 'run.cjs'), piWorkloadWrapper(process.execPath, ['-e', script], root, piConfig))
  await promisify(execFile)(process.execPath, ['run.cjs'], { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: piConfig }, timeout: 10000 })
  const evidence = await piWorkloadEvidence(root, [root])
  assert.equal(evidence['invocations.txt'].count, 1)
  assert.deepEqual(evidence['launch.json'].launch, { phase: 'pi_exited', cwdMatchesExpected: true, nodeMatchesExpected: true, piConfigMatchesExpected: true })
  assert.deepEqual(evidence['exit.json'].exit, { status: 7, error: null })
  assert.match(evidence['stderr.txt'].excerpt, /synthetic launch failure/)
  assert.doesNotMatch(JSON.stringify(evidence), /fixture-secret|Bearer/)
})

test('Pi fixture launch diagnostics identify an unexpected shell cwd without rewriting the workload cwd', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi cwd ')); t.after(() => fs.rm(root, { recursive: true, force: true }))
  const other = path.join(root, 'other'); await fs.mkdir(other)
  const wrapper = path.join(root, 'run.cjs')
  await fs.writeFile(wrapper, piWorkloadWrapper(process.execPath, ['-e', 'process.exit(0)'], root, root))
  await promisify(execFile)(process.execPath, [wrapper], { cwd: other, env: { ...process.env, PI_CODING_AGENT_DIR: root }, timeout: 10000 })
  const evidence = await piWorkloadEvidence(root)
  assert.equal(evidence['launch.json'].launch.cwdMatchesExpected, false)
  assert.equal(evidence['invocations.txt'].state, 'absent')
  assert.deepEqual((await piWorkloadEvidence(other))['exit.json'].exit, { status: 0, error: null })
})

test('Pi fixture stderr reads and display are bounded and strip paths, URLs and credential-bearing lines', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi bounded ')); t.after(() => fs.rm(root, { recursive: true, force: true }))
  const content = `Error at ${root}\nhttps://user:private@example.invalid/path?secret=value\napiKey=private-key\n${'x'.repeat(6000)}`
  await fs.writeFile(path.join(root, 'stderr.txt'), content)
  const evidence = (await piWorkloadEvidence(root, [root]))['stderr.txt']
  assert.equal(evidence.truncated, true)
  assert.equal(evidence.bytes, Buffer.byteLength(content))
  assert.ok(evidence.excerpt.length <= 2048)
  assert.doesNotMatch(evidence.excerpt, /private|example.invalid/)
  assert.ok(!evidence.excerpt.includes(root))
  assert.equal(diagnosticText('z '.repeat(3000)).length, 2048)
})

test('loopback model offers one real write request then a final response; reexecution is rejected', async t => {
  const fixture = await startPiModelFixture(); t.after(() => fixture.close())
  const call = body => fetch(`${fixture.baseUrl}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) })
  const initial = { model: fixtureModel, stream: true, messages: [{ role: 'user', content: 'synthetic task' }], tools: [{ type: 'function', function: { name: 'write' } }] }
  const first = await call(initial); assert.equal(first.status, 200)
  const events = (await first.text()).split('\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)))
  const tool = events[0].choices[0].delta.tool_calls[0]
  assert.deepEqual(JSON.parse(tool.function.arguments), { path: fixtureFile, content: fixtureBytes })
  assert.equal(events[1].choices[0].finish_reason, 'tool_calls')
  const result = await call({ ...initial, messages: [{ role: 'tool', tool_call_id: tool.id, content: 'written' }] })
  assert.equal(result.status, 200); assert.match(await result.text(), new RegExp(fixtureOutput))
  const duplicate = await call(initial); assert.equal(duplicate.status, 409); await duplicate.text()
  assert.deepEqual(fixture.snapshot(), { requests: 3, offeredWrites: 1 })
})

test('unrelated model and non-streaming requests cannot advance the fixed workload', async t => {
  const fixture = await startPiModelFixture(); t.after(() => fixture.close())
  for (const body of [{ model: 'other', stream: true, messages: [] }, { model: fixtureModel, stream: false, messages: [] }]) {
    const response = await fetch(`${fixture.baseUrl}/chat/completions`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(3000) })
    assert.equal(response.status, 409); await response.text()
  }
  assert.deepEqual(fixture.snapshot(), { requests: 0, offeredWrites: 0 })
  assert.deepEqual(fixture.diagnostics(), { received: 2, rejected: 2 })
})

test('completion gate keeps the real-model response pending until an explicit release', async t => {
  const fixture = await startPiModelFixture({ holdCompletion: true }); t.after(() => fixture.close())
  const call = body => fetch(`${fixture.baseUrl}/chat/completions`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(3000) })
  const initial = { model: fixtureModel, stream: true, messages: [{ role: 'user', content: 'synthetic task' }], tools: [{ type: 'function', function: { name: 'write' } }] }
  const first = await call(initial)
  const tool = JSON.parse((await first.text()).split('\n').find(l => l.startsWith('data: {')).slice(6)).choices[0].delta.tool_calls[0]
  let received = false
  const pending = call({ ...initial, messages: [{ role: 'tool', tool_call_id: tool.id, content: 'written' }] }).then(async r => { received = true; assert.equal(r.status, 200); return r.text() })
  const deadline = Date.now() + 1000
  while (fixture.snapshot().requests !== 2 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(fixture.snapshot(), { requests: 2, offeredWrites: 1 })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(received, false)
  fixture.releaseCompletion()
  assert.match(await pending, new RegExp(fixtureOutput))
  fixture.releaseCompletion()
  assert.deepEqual(fixture.snapshot(), { requests: 2, offeredWrites: 1 })
})

test('write gate cannot offer a tool before the controlled disconnect point', async t => {
  const fixture = await startPiModelFixture({ holdWrite: true }); t.after(() => fixture.close())
  let received = false
  const pending = fetch(`${fixture.baseUrl}/chat/completions`, { method: 'POST',
    body: JSON.stringify({ model: fixtureModel, stream: true, messages: [{ role: 'user', content: 'synthetic task' }], tools: [{ type: 'function', function: { name: 'write' } }] }),
    signal: AbortSignal.timeout(3000),
  }).then(async response => { received = true; assert.equal(response.status, 200); return response.text() })
  const deadline = Date.now() + 1000
  while (fixture.snapshot().requests !== 1 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(fixture.snapshot(), { requests: 1, offeredWrites: 0 })
  await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(received, false)
  fixture.releaseWrite()
  assert.match(await pending, /endpoint_fixture_write/)
  assert.deepEqual(fixture.snapshot(), { requests: 1, offeredWrites: 1 })
})
