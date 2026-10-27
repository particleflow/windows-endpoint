import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { runtimeProtocol, validateRuntimeHandshake, createRuntimePeer } from './native-runtime-peer.mjs'

const expected = { key: `mrk_${'a'.repeat(64)}`, teamId: '11111111-1111-4111-8111-111111111111', version: '0.22.0', workspaceBase: 'C:\\Users\\fixture' }
const metadata = { version: 1, hostname: 'synthetic', os: 'win32', arch: 'x64', client_version: expected.version, workspace_base: expected.workspaceBase, capabilities: ['fs', 'exec', 'host_fs'] }
const request = () => ({ url: '/api/runtimes/connect', headers: { authorization: `Bearer ${expected.key}`, 'x-team-id': expected.teamId, 'sec-websocket-protocol': runtimeProtocol, 'x-memoh-runtime-metadata': Buffer.from(JSON.stringify(metadata)).toString('base64url') } })

test('native control fixture accepts only the original official protocol, tenant and explicit directory', () => {
  assert.deepEqual(validateRuntimeHandshake(request(), expected), metadata)
  for (const [name, value] of [['authorization', 'Bearer invalid'], ['x-team-id', 'another'], ['sec-websocket-protocol', 'another']]) {
    const changed = request(); changed.headers[name] = value
    assert.throws(() => validateRuntimeHandshake(changed, expected))
  }
  assert.throws(() => validateRuntimeHandshake({ ...request(), url: '/runtimes/connect' }, expected))
  const wrongRoot = request()
  wrongRoot.headers['x-memoh-runtime-metadata'] = Buffer.from(JSON.stringify({ ...metadata, workspace_base: 'C:\\other' })).toString('base64url')
  assert.throws(() => validateRuntimeHandshake(wrongRoot, expected))
})

test('native control fixture rejects missing, oversized or private-extra metadata instead of recording it', () => {
  for (const value of [undefined, 'a'.repeat(12001), 'bad=', Buffer.from(JSON.stringify({ ...metadata, key: expected.key })).toString('base64url')]) {
    const changed = request(); changed.headers['x-memoh-runtime-metadata'] = value
    assert.throws(() => validateRuntimeHandshake(changed, expected))
  }
})

test('fixture network outage breaks transport without fabricating an authorization refusal', async t => {
  // These two rejection paths must never reach WebSocket acceptance. The real
  // official Runtime/WebSocket reconnect is exercised by Windows CI separately.
  const peer = await createRuntimePeer({ ...expected, WebSocket: { Server: class {
    handleUpgrade() { assert.fail('rejected transport must not accept a WebSocket') }
    close(done) { done() }
  } } })
  t.after(() => peer.close())
  const connect = () => new Promise(resolve => {
    const req = http.request(`${peer.origin}/runtimes/connect`, { headers: { ...request().headers, Connection: 'Upgrade', Upgrade: 'websocket' } }, response => { response.resume(); resolve(response.statusCode) })
    req.on('error', error => resolve(error.code || 'unexpected_error'))
    req.setTimeout(2000, () => req.destroy(new Error('fixture deadline'))); req.end()
  })
  peer.setNetworkAvailable(false)
  assert.equal(await connect(), 'ECONNRESET')
  assert.equal(peer.counts.networkRefused, 1); assert.equal(peer.counts.rejected, 0)
  peer.setNetworkAvailable(true); peer.rejectAuthorization()
  assert.equal(await connect(), 401)
  assert.equal(peer.counts.rejected, 1); assert.equal(peer.counts.connections, 0); assert.equal(peer.counts.invalid, 0)
})
