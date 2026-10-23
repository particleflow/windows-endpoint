import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { createHash } from 'node:crypto'
import { transferFixture } from './nas-fixture.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function setup(t) {
  const plan = { task: { operation_id: 'operation-one', bot_id: 'bot-one' }, artifact: { mime: 'text/plain' } }
  const fixture = transferFixture(plan, 'delivery-one', 'fixture')
  const server = http.createServer(fixture.handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const prefix = '/internal/computer-transfers/operation-one/delivery-one'
  const media = `${prefix}/bots/bot-one/media`, association = `${prefix}/internal/computer-deliveries/operation-one/delivery-one`
  const request = (url, options = {}) => fetch(`http://127.0.0.1:${server.address().port}${url}`, { ...options, headers: { Authorization: 'Memoh-Transfer synthetic-cli-device', ...options.headers } })
  return { fixture, request, media, association }
}
test('NAS fixture requires exact bytes and resolves a lost committed response without a second mutation', async t => {
  const { fixture, request, media, association } = await setup(t)
  assert.equal((await request(`${media}/limits`)).status, 200)
  const create = await request(`${media}/uploads`, { method: 'POST', body: JSON.stringify({ size_bytes: 7, sha256: hash('fixture'), mime: 'text/plain' }) })
  assert.equal(create.status, 201); assert.equal((await create.json()).id, 'receipt-one')
  for (const [offset, body] of [[0, 'fixt'], [4, 'ure']]) {
    const response = await request(`${media}/uploads/receipt-one`, { method: 'PATCH', body, headers: { 'Upload-Offset': String(offset), 'Upload-Length': String(body.length), 'Upload-Sha256': hash(body) } })
    assert.equal(response.status, 200)
  }
  const complete = await request(`${media}/uploads/receipt-one/complete`, { method: 'POST' })
  assert.equal((await complete.json()).content_hash, hash('fixture'))
  const body = JSON.stringify({ version: 1, bot_id: 'bot-one', direction: 'upload', content_hash: hash('fixture'), size_bytes: 7, mime: 'text/plain' })
  await assert.rejects(request(`${association}/commit`, { method: 'POST', body }))
  assert.equal(fixture.snapshot().committed, true)
  assert.equal((await (await request(`${association}/resolve`, { method: 'POST', body })).json()).outcome, 'committed')
  assert.deepEqual(fixture.snapshot().uploaded, Buffer.from('fixture'))
  assert.equal(fixture.stats.commits, 1); assert.equal(fixture.stats.resolves, 1); assert.equal(fixture.stats.failures, 0)
  assert.equal((await request(`${association}/commit`, { method: 'POST', body })).status, 400)
  assert.equal(fixture.stats.commits, 1)
})
test('NAS fixture rejects foreign identity, wrong namespace, and mutated declaration before admission', async t => {
  const { fixture, request, media } = await setup(t)
  assert.equal((await request(`${media}/limits`, { headers: { Authorization: 'different-fixture' } })).status, 403)
  assert.equal((await request(`${media}/limits?unrecognized=true`)).status, 400)
  assert.equal((await request(`${media}/uploads`, { method: 'POST', body: JSON.stringify({ size_bytes: 7, sha256: hash('changed'), mime: 'text/plain' }) })).status, 400)
  assert.equal(fixture.stats.creates, 0); assert.equal(fixture.snapshot().receipt, undefined)
})
