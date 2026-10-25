// One disposable model response sequence for the original-task integration
// fixture. This replaces model inference only, never Pi, Herdr, Memoh or PG.
import http from 'node:http'

export const fixtureProvider = 'endpoint-joint-fixture'
export const fixtureModel = 'one-file-task'
export const fixtureFile = 'joint-result.txt'
export const fixtureBytes = '42\n'
export const fixtureOutput = 'joint-fixture-complete'
const callId = 'endpoint_fixture_write'

export async function startPiModelFixture({ holdCompletion = false, holdWrite = false } = {}) {
  let requests = 0, offeredWrites = 0, received = 0, rejected = 0
  let releaseCompletion, releaseWrite
  const completion = new Promise(resolve => { releaseCompletion = resolve })
  const write = new Promise(resolve => { releaseWrite = resolve })
  if (!holdCompletion) releaseCompletion()
  if (!holdWrite) releaseWrite()
  const server = http.createServer(async (req, res) => {
    received++
    try {
      if (req.method !== 'POST' || req.url !== '/v1/chat/completions') throw Error('route')
      const chunks = []; let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > 1024 * 1024) throw Error('body_limit')
        chunks.push(chunk)
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (body.model !== fixtureModel || body.stream !== true || !Array.isArray(body.messages)) throw Error('protocol')
      requests++
      let delta, finish
      if (requests === 1) {
        if (body.messages.at(-1)?.role !== 'user' || !body.tools?.some(t => t.function?.name === 'write')) throw Error('initial_request')
        await write
        offeredWrites++
        delta = { role: 'assistant', content: null, tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: fixtureFile, content: fixtureBytes }) } }] }
        finish = 'tool_calls'
      } else if (requests === 2 && body.messages.at(-1)?.role === 'tool' && body.messages.at(-1)?.tool_call_id === callId) {
        await completion
        delta = { role: 'assistant', content: fixtureOutput }; finish = 'stop'
      } else throw Error('unexpected_reexecution')
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store' })
      for (const choice of [{ delta, finish_reason: null }, { delta: {}, finish_reason: finish }]) {
        res.write(`data: ${JSON.stringify({ id: 'fixture-completion', object: 'chat.completion.chunk', created: 1, model: fixtureModel, choices: [{ index: 0, ...choice }] })}\n\n`)
      }
      res.end('data: [DONE]\n\n')
    } catch {
      rejected++
      if (!res.headersSent) res.writeHead(409, { 'Content-Type': 'application/json' })
      res.end('{"error":{"message":"fixed fixture sequence rejected"}}')
    }
  })
  server.requestTimeout = 10000; server.headersTimeout = 10000
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`
  return {
    baseUrl,
    // Pi's documented dummy key enables a local compatible model. It grants
    // no external access and is unrelated to Agenvo OAuth or target approval.
    models: { providers: { [fixtureProvider]: { baseUrl, api: 'openai-completions', apiKey: 'fixture-no-credential', models: [{ id: fixtureModel, reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 2048 }] } } },
    snapshot: () => ({ requests, offeredWrites }),
    diagnostics: () => ({ received, rejected }),
    releaseCompletion, releaseWrite,
    close: () => new Promise((resolve, reject) => { releaseWrite(); releaseCompletion(); server.close(e => e ? reject(e) : resolve()); server.closeAllConnections() }),
  }
}
