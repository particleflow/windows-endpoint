import test from 'node:test'
import assert from 'node:assert/strict'
import { startPiModelFixture, fixtureModel, fixtureFile, fixtureBytes, fixtureOutput } from './pi-model-fixture.mjs'

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
