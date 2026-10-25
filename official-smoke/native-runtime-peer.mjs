// CI-only counterpart to the official RuntimeSession loopback handshake test.
// It never dispatches an RPC, runs a task, handles file bytes, or grants a scope.
import assert from 'node:assert/strict'
import http from 'node:http'

export const runtimeProtocol = 'memoh.runtime.v1.grpc'
export function validateRuntimeHandshake(request, expected) {
  assert.equal(request.url, '/api/runtimes/connect', 'fixture API base must be retained')
  assert.equal(request.headers.authorization, `Bearer ${expected.key}`, 'synthetic fixture authorization')
  assert.equal(request.headers['x-team-id'], expected.teamId, 'synthetic fixture tenant')
  assert.equal(request.headers['sec-websocket-protocol'], runtimeProtocol, 'official runtime protocol')
  const encoded = request.headers['x-memoh-runtime-metadata']
  assert.equal(typeof encoded, 'string', 'metadata header is required')
  assert.ok(encoded.length > 0 && encoded.length <= 12000 && /^[A-Za-z0-9_-]+$/.test(encoded), 'metadata header is bounded base64url')
  const raw = Buffer.from(encoded, 'base64url')
  assert.ok(raw.length <= 8192, 'official metadata byte limit')
  const metadata = JSON.parse(raw.toString('utf8'))
  assert.deepEqual(Object.keys(metadata).sort(), ['arch', 'capabilities', 'client_version', 'hostname', 'os', 'version', 'workspace_base'])
  assert.equal(metadata.version, 1)
  assert.equal(metadata.os, expected.os || 'win32'); assert.equal(metadata.arch, expected.arch || 'x64')
  assert.equal(metadata.client_version, expected.version)
  assert.equal(metadata.workspace_base, expected.workspaceBase, 'official CLI default directory remains explicit evidence')
  assert.equal(typeof metadata.hostname, 'string'); assert.ok(metadata.hostname.length > 0)
  assert.deepEqual([...metadata.capabilities].sort(), ['exec', 'fs', 'host_fs'])
  return metadata
}

export async function createRuntimePeer({ WebSocket, ...expected }) {
  const server = http.createServer((_request, response) => { response.writeHead(404); response.end() })
  const websocket = new WebSocket.Server({ noServer: true, handleProtocols: values => values.has(runtimeProtocol) ? runtimeProtocol : false })
  const sockets = new Set(), counts = { attempts: 0, connections: 0, rejected: 0, invalid: 0 }
  let rejectAuthorization = false, closing = false
  server.on('upgrade', (request, socket, head) => {
    counts.attempts++
    try { validateRuntimeHandshake(request, expected) }
    catch {
      counts.invalid++; socket.end('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\n\r\n'); return
    }
    if (closing || rejectAuthorization) {
      counts.rejected++; socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'); return
    }
    websocket.handleUpgrade(request, socket, head, client => {
      counts.connections++; sockets.add(client)
      client.on('error', () => {}); client.once('close', () => sockets.delete(client))
      // A handshake/reconnect test needs no gRPC payload. Runtime's own
      // ping/pong and its reconnect policy remain real and unmodified.
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  return {
    origin: `http://127.0.0.1:${server.address().port}/api`,
    counts,
    rejectAuthorization() { rejectAuthorization = true },
    disconnect() { for (const socket of sockets) socket.terminate() },
    async close() {
      closing = true
      for (const socket of sockets) socket.terminate()
      server.closeAllConnections()
      await Promise.all([new Promise(resolve => websocket.close(resolve)), new Promise(resolve => server.close(resolve))])
    },
  }
}
