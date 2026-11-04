import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

// Seven-byte protocol fixture, never a NAS implementation or durable ledger.
// Matches the fixed producer CLI fixture; all authority and payloads are synthetic.
export function transferFixture(plan, deliveryId, payload) {
  const sha = raw => createHash('sha256').update(raw).digest('hex')
  const bytes = Buffer.from(payload)
  assert.equal(bytes.length, 7)
  const prefix = `/internal/computer-transfers/${plan.task.operation_id}/${deliveryId}`
  const media = `${prefix}/bots/${plan.task.bot_id}/media`
  const association = `${prefix}/internal/computer-deliveries/${plan.task.operation_id}/${deliveryId}`
  const stats = { requests: 0, creates: 0, patches: 0, completes: 0, commits: 0, resolves: 0, failures: 0 }
  let uploaded = Buffer.alloc(0), receipt, committed = false
  const reference = { delivery_id: deliveryId, operation_id: plan.task.operation_id, bot_id: plan.task.bot_id, content_hash: sha(bytes), size_bytes: bytes.length, mime: plan.artifact.mime }
  const body = async req => {
    const parts = []; let size = 0
    for await (const part of req) { size += part.length; assert.ok(size <= 1024, 'bounded fixture request'); parts.push(part) }
    return Buffer.concat(parts)
  }
  const json = (res, value, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
  const handler = async (req, res) => {
    stats.requests++
    if (req.headers.authorization !== 'Memoh-Transfer synthetic-cli-device') { json(res, {}, 403); return }
    try {
      if (req.method === 'GET' && req.url === `${media}/limits`) return json(res, { max_upload_bytes: 1024, chunk_max_bytes: 4, resumable_enabled: true })
      if (req.method === 'POST' && req.url === `${media}/uploads`) {
        assert.equal(receipt, undefined, 'one receipt only')
        assert.deepEqual(JSON.parse(await body(req)), { size_bytes: bytes.length, sha256: sha(bytes), mime: plan.artifact.mime })
        stats.creates++
        receipt = { id: 'receipt-one', state: 'uploading', offset: 0, size_bytes: bytes.length, mime: plan.artifact.mime, expires_at: new Date(Date.now() + 3600000).toISOString() }
        return json(res, receipt, 201)
      }
      if (req.method === 'PATCH' && req.url === `${media}/uploads/receipt-one`) {
        assert.ok(receipt); assert.equal(receipt.state, 'uploading')
        const chunk = await body(req)
        assert.ok(chunk.length > 0 && chunk.length <= 4)
        assert.equal(req.headers['upload-offset'], String(uploaded.length))
        assert.equal(req.headers['upload-length'], String(chunk.length)); assert.equal(req.headers['upload-sha256'], sha(chunk))
        uploaded = Buffer.concat([uploaded, chunk]); assert.ok(uploaded.length <= bytes.length)
        receipt.offset = uploaded.length; stats.patches++
        return json(res, receipt)
      }
      if (req.method === 'GET' && req.url === `${media}/uploads/receipt-one`) { assert.ok(receipt); return json(res, receipt) }
      if (req.method === 'POST' && req.url === `${media}/uploads/receipt-one/complete`) {
        assert.ok(receipt); assert.equal(receipt.state, 'uploading'); assert.deepEqual(uploaded, bytes)
        stats.completes++; receipt.state = 'ready'; receipt.content_hash = sha(uploaded)
        return json(res, receipt)
      }
      if (req.method === 'POST' && [`${association}/commit`, `${association}/resolve`].includes(req.url)) {
        assert.equal(receipt?.state, 'ready')
        assert.deepEqual(JSON.parse(await body(req)), { version: 1, bot_id: reference.bot_id, direction: 'upload', content_hash: reference.content_hash, size_bytes: reference.size_bytes, mime: reference.mime })
        if (req.url.endsWith('/commit')) {
          assert.equal(committed, false, 'lost commit must be resolved, never replayed')
          stats.commits++; committed = true
          req.socket.destroy() // commit wins, but the client receives no response
          return
        }
        stats.resolves++
        return json(res, { version: 3, revision: '1', outcome: committed ? 'committed' : 'absent' })
      }
      throw new Error('unexpected fixture route')
    } catch {
      stats.failures++; json(res, { error: 'fixture_contract_failure' }, 400)
    }
  }
  return { handler, stats, reference, snapshot: () => ({ receipt: receipt && { ...receipt }, uploaded: Buffer.from(uploaded), committed }) }
}
