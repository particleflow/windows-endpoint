import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { connectorCalls } from './owner-control-fixture.mjs'

class Socket extends EventEmitter {
  sent = []
  send(raw) { this.sent.push(JSON.parse(raw)) }
}
const hello = { instances: [{ instanceId: 'fixture', fingerprint: 'fixed-fingerprint' }] }

test('control fixture binds response to request and connector, and does not retry a lost command', async () => {
  const calls = connectorCalls(30), socket = new Socket(), other = new Socket()
  calls.hello(socket, hello)
  const pending = calls.call('pane.run', { command: 'synthetic' })
  const request = socket.sent[0]
  assert.equal(request.instanceId, 'fixture'); assert.equal(request.fingerprint, 'fixed-fingerprint')
  calls.receive(other, { type: 'result', requestId: request.requestId, outcome: { execution: 'accepted' } })
  calls.receive(socket, { type: 'result', requestId: 'unrelated', outcome: { execution: 'accepted' } })
  await assert.rejects(pending, /response_deadline_unknown/)
  assert.equal(socket.sent.length, 1)
})

test('control fixture propagates explicit errors and closes uncertain requests without another send', async () => {
  const calls = connectorCalls(), socket = new Socket()
  calls.hello(socket, hello)
  const pending = calls.call('server.stop', {})
  const outcome = { execution: 'rejected', error: { code: 'unsupported_method' } }
  calls.receive(socket, { type: 'error', requestId: socket.sent[0].requestId, outcome })
  assert.deepEqual(await pending, outcome)
  const interrupted = calls.call('pane.run', {})
  socket.emit('close')
  await assert.rejects(interrupted, /connection_lost_unknown/)
  assert.equal(socket.sent.length, 2)
  await assert.rejects(calls.call('pane.run', {}), /connector unavailable/)
})
