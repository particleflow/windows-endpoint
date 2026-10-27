// CI-only reproduction with the packaged, unchanged production EXE. No new
// transport/trust source: reuse the existing explicitly untrusted loopback TLS.
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { transferEnvironment } from '../endpoint.mjs'

export async function exerciseFeedbackBoundary({ root, candidate, transferRoot, config, plan, payload, createPrivateFixture, network }) {
  const { parseLifecycleSummary, parseAdvanceDecision } = await import(pathToFileURL(path.join(candidate, 'transfer-contract.mjs')))
  const sha = raw => createHash('sha256').update(raw).digest('hex')
  for (const kind of ['inbound_no_producer_context', 'outbound_feedback_write_failure']) {
    const base = path.join(root, kind), configRoot = path.join(base, 'config'), stateRoot = path.join(base, 'state'), source = path.join(base, 'source')
    const attempt = path.join(source, '.memoh-computer/attempts', plan.task.attempt)
    const localPlan = { ...plan, task: { ...plan.task, root_hash: sha(source.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()) } }
    const configuration = JSON.stringify({ version: 1, origin: config.nasOrigin || config.transfer.nasOrigin, source_root: source })
    const items = [base, configRoot, stateRoot, source].map(p => ({ kind: 'directory', path: p }))
    items.push({ kind: 'file', path: path.join(configRoot, 'transfer.json'), content: configuration }, { kind: 'file', path: path.join(configRoot, 'device.credential'), content: 'synthetic-cli-device' })
    if (kind.startsWith('outbound')) {
      for (const p of [path.join(source, '.memoh-computer'), path.join(source, '.memoh-computer/attempts'), attempt]) items.push({ kind: 'directory', path: p })
      items.push({ kind: 'file', path: path.join(source, plan.artifact.source_ref), content: payload }, { kind: 'file', path: path.join(attempt, 'producer-context.json'), content: JSON.stringify(localPlan) })
    }
    const input = path.join(root, `${kind}.json`)
    await fs.writeFile(input, JSON.stringify({ root, items })); createPrivateFixture(input, kind)
    const env = { ...transferEnvironment(config), HERDR_PLUGIN_CONFIG_DIR: configRoot, HERDR_PLUGIN_STATE_DIR: stateRoot }
    const command = (action, data, id) => new Promise((resolve, reject) => {
      const child = execFile(path.join(transferRoot, 'transferqueue.exe'), ['-action', action, ...(id ? ['-delivery', id] : [])], { env, cwd: source, encoding: 'utf8', timeout: 125000, maxBuffer: 16384, windowsHide: true }, (error, stdout) => {
        try {
          assert.ok(!error?.killed && !error?.signal && (!error || Number.isInteger(error.code)), 'fixture command must complete, not time out or fail to spawn')
          assert.ok([0, 1].includes(error?.code ?? 0), 'unexpected CLI exit')
          resolve({ status: error?.code ?? 0, stdout })
        } catch (failure) { reject(failure) }
      })
      child.stdin.on('error', () => {}); child.stdin.end(data ? JSON.stringify(data) : '')
    })
    const task = Object.fromEntries(['user_id', 'session_id', 'target_id', 'run_id', 'attempt', 'generation'].map(k => [k, plan.task[k]]))
    const job = { version: 1, delivery_id: 'inbound-feedback-original', snapshot_id: 'inbound-feedback-original', bot_id: plan.task.bot_id, operation_id: plan.task.operation_id,
      locator_revision: 'native-profile-v1', phase: 'queued', device_task: task, spec: { size_bytes: Buffer.byteLength(payload), sha256: sha(payload), mime: plan.artifact.mime } }
    const created = kind.startsWith('inbound') ? await command('enqueue-download', { job }) : await command('enqueue-result', { ...localPlan, closed: true, sha256: sha(payload), size_bytes: Buffer.byteLength(payload) })
    assert.equal(created.status, 0)
    const admitted = JSON.parse(created.stdout), id = admitted.delivery_id
    const inbound = kind.startsWith('inbound'), feedbackStatus = inbound ? 'not_applicable' : 'unavailable'
    assert.equal(admitted.feedback_status, inbound ? 'not_applicable' : 'recorded')
    const feedbackFile = path.join(attempt, 'delivery-feedback.json'), backup = path.join(attempt, 'saved-feedback.json')
    let saved = null
    if (kind.startsWith('outbound')) {
      saved = await fs.readFile(feedbackFile)
      await fs.rename(feedbackFile, backup); await fs.mkdir(feedbackFile) // fresh fixture only; no ACL or user file changes
    }
    try {
      const before = network(), observedAt = Date.now(), advanced = await command('advance-results'), value = JSON.parse(advanced.stdout)
      const summary = Object.fromEntries(['schema', 'state', 'next_due_at', 'error_class'].map(k => [k, value[k]]))
      assert.deepEqual(parseLifecycleSummary(JSON.stringify(summary), observedAt), summary)
      assert.equal(summary.state, 'waiting'); assert.equal(summary.error_class, 'transient')
      assert.equal(value.delivery_id, id); assert.equal(value.offset, 0); assert.equal(value.associated, false)
      assert.equal(value.feedback_status, feedbackStatus)
      if (inbound) assert.deepEqual(parseAdvanceDecision(advanced.stdout, observedAt), summary)
      else assert.throws(() => parseAdvanceDecision(advanced.stdout, observedAt), { code: 'transfer_feedback_unavailable' })
      const after = network()
      assert.equal(after.requests, before.requests); assert.ok(after.tlsFailures > before.tlsFailures)
      for (let i = 0; i < 2; i++) {
        const read = await command('inspect', null, id), state = JSON.parse(read.stdout)
        assert.equal(read.status, 0); assert.equal(state.delivery_id, id); assert.equal(state.offset, 0); assert.equal(state.associated, false)
        assert.equal(state.feedback_status, feedbackStatus)
      }
      assert.deepEqual(network(), after, 'reopens never dispatch network work')
      assert.equal(await fs.readFile(path.join(configRoot, 'transfer.json'), 'utf8'), configuration)
      process.stdout.write(JSON.stringify({ nativeFeedbackBoundary: kind, advanceExit: advanced.status, advanceEnvelope: value, feedbackStatus: value.feedback_status,
        consumerError: inbound ? null : 'transfer_feedback_unavailable', stableReopens: 2, additionalHTTPRequests: 0, positiveTLS: 'not_run', inboundSuccess: false }) + '\n')
    } finally {
      if (saved) { await fs.rmdir(feedbackFile); await fs.rename(backup, feedbackFile); assert.deepEqual(await fs.readFile(feedbackFile), saved) }
    }
  }
}
