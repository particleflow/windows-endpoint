import test from 'node:test'
import assert from 'node:assert/strict'
import { runtimeProtocol, validateRuntimeHandshake } from './native-runtime-peer.mjs'

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
