// CI transport probe, not an authentication service or production control API.
// The existing synthetic relay addresses the real official connector. Memoh's
// owner/OAuth/grant checks are separate and are not simulated as passing here.
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { isFreshPiShellPrompt } from './pi-workload-diagnostics.mjs'

export function connectorCalls(timeoutMs = 10000) {
  let peer
  const pending = new Map()
  return {
    hello(socket, packet) {
      assert.equal(packet.instances.length, 1)
      const instance = packet.instances[0]
      assert.equal(typeof instance.instanceId, 'string'); assert.equal(typeof instance.fingerprint, 'string')
      peer = { socket, instance }
      socket.once('close', () => {
        if (peer?.socket === socket) peer = null
        for (const entry of pending.values()) if (entry.socket === socket) entry.reject(new Error('control_fixture_connection_lost_unknown'))
      })
    },
    receive(socket, packet) {
      const entry = pending.get(packet.requestId)
      if (entry?.socket === socket && ['result', 'error'].includes(packet.type)) entry.resolve(packet.outcome)
    },
    async call(method, params, overrides = {}) {
      assert.ok(peer, 'control fixture connector unavailable')
      const { socket, instance } = peer, requestId = overrides.requestId || randomUUID()
      assert.equal(pending.has(requestId), false)
      let timer
      try {
        return await new Promise((resolve, reject) => {
          pending.set(requestId, { socket, resolve, reject })
          timer = setTimeout(() => reject(new Error('control_fixture_response_deadline_unknown')), timeoutMs)
          socket.send(JSON.stringify({ v: 1, type: 'call', requestId, instanceId: instance.instanceId,
            fingerprint: overrides.fingerprint ?? instance.fingerprint, method, params }))
        })
      } finally { clearTimeout(timer); pending.delete(requestId) }
    },
  }
}

export async function exerciseOwnerControl({ calls, config, node, endpoint, hostRoot, expected, checked }) {
  const native = async (method, params) => {
    const out = await calls.call(method, { session: config.session, ...params })
    assert.equal(out.execution, 'accepted'); assert.equal(out.error, undefined)
    assert.equal(out.result.session, config.session); assert.equal(out.result.nativeError, undefined)
    return out.result
  }
  for (const method of ['plugin.action.invoke', 'server.stop', 'host.stop']) {
    const out = await calls.call(method, { session: config.session })
    assert.equal(out.execution, 'not_started'); assert.equal(out.error.code, 'unsupported_method')
  }
  checked('official_connector_has_no_direct_plugin_server_or_host_stop_method')
  const created = (await native('workspace.create', { cwd: config.sourceRoot, label: 'isolated-owner-control-probe' })).result
  const pane = created.root_pane
  assert.equal(pane.workspace_id, created.workspace.workspace_id)
  assert.ok(pane.pane_id && pane.terminal_id)
  const identity = value => Object.fromEntries(['workspace_id', 'pane_id', 'terminal_id'].map(key => [key, value[key]]))
  const get = async () => identity((await native('pane.get', { paneId: pane.pane_id })).result.pane)
  assert.deepEqual(await get(), identity(pane))
  const readyDeadline = Date.now() + 45000
  let ready = false
  while (Date.now() < readyDeadline) {
    const output = await native('pane.read', { paneId: pane.pane_id, lines: 5, source: 'recent-unwrapped' })
    assert.equal(typeof output.output, 'string')
    if (isFreshPiShellPrompt(output.output, config.sourceRoot)) { ready = true; break }
    await delay(100)
  }
  assert.ok(ready, 'control fixture fresh shell was not ready')
  const nonce = randomUUID().replaceAll('-', ''), start = `ENDPOINT_CONTROL_${nonce}:`, end = `:END_CONTROL_${nonce}`
  const count = path.join(config.sourceRoot, 'endpoint-control-count.txt'), script = path.join(config.sourceRoot, 'endpoint-control-query.cjs')
  await fs.writeFile(script, `const fs=require('node:fs'),cp=require('node:child_process');\nfs.appendFileSync(${JSON.stringify(count)},'once\\n');\nconst r=cp.spawnSync(${JSON.stringify(node)},${JSON.stringify([endpoint, 'host', 'status', '--root', hostRoot])},{encoding:'utf8',timeout:10000,maxBuffer:16384});\nconst value={exitCode:r.status,status:r.status===0?JSON.parse(r.stdout):null};\nprocess.stdout.write('\\n'+${JSON.stringify(start)}+Buffer.from(JSON.stringify(value)).toString('base64')+${JSON.stringify(end)}+'\\n');\n`, { flag: 'wx' })
  const quote = value => `'${value.replaceAll("'", "''")}'`
  const params = { session: config.session, paneId: pane.pane_id, command: `& ${quote(node)} ${quote(script)}` }
  const denied = await calls.call('pane.run', params, { fingerprint: 'not-the-approved-instance' })
  assert.equal(denied.execution, 'not_started'); assert.equal(denied.error.code, 'permission_denied')
  await assert.rejects(fs.access(count), { code: 'ENOENT' })
  checked('official_connector_refuses_wrong_instance_fingerprint_before_command')
  const requestId = randomUUID(), submitted = await calls.call('pane.run', params, { requestId })
  assert.equal(submitted.execution, 'accepted') // input delivery only
  const duplicate = await calls.call('pane.run', params, { requestId })
  assert.equal(duplicate.execution, 'unknown'); assert.equal(duplicate.error.code, 'duplicate_request')
  const deadline = Date.now() + 20000
  let observed
  while (Date.now() < deadline && !observed) {
    const output = await native('pane.read', { paneId: pane.pane_id, lines: 80, source: 'recent-unwrapped' })
    assert.equal(typeof output.output, 'string')
    const frames = output.output.replaceAll('\r\n', '\n').split('\n').filter(line => line.startsWith(start) && line.endsWith(end))
    assert.ok(frames.length <= 1, 'ambiguous control response')
    if (frames.length) observed = JSON.parse(Buffer.from(frames[0].slice(start.length, -end.length), 'base64'))
    else await delay(100)
  }
  assert.ok(observed, 'control query completion was not observed')
  assert.equal(observed.exitCode, 0); assert.equal(observed.status.runId, expected.runId)
  assert.equal(observed.status.pid, expected.pid); assert.equal(observed.status.phase, 'running')
  assert.equal(observed.status.ready, false); assert.equal(observed.status.control, 'stdin_open')
  assert.equal(await fs.readFile(count, 'utf8'), 'once\n')
  assert.deepEqual(await get(), identity(pane))
  checked('official_connector_and_herdr_read_packaged_host_status_once_without_stop_authority')
  process.stdout.write(JSON.stringify({ ownerControlTransport: 'passed', officialConnector: '0.2.0',
    calls: 'existing_pane_run_and_read', endpointCommand: 'host status', hostStopped: false,
    memohOwnerOAuthAndGrant: 'not_exercised', admissionFence: 'not_implemented', taskRecovery: 'not_exercised' }) + '\n')
}
