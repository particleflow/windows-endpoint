import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLifecycleSummary, parseAdvanceDecision, deadlineMilliseconds } from './transfer-contract.mjs'

const now = Date.parse('2026-10-22T18:00:00Z')
const summary = overrides => ({ schema: 'memoh.delivery.lifecycle.v1', state: 'idle', next_due_at: null, error_class: 'none', ...overrides })
const parse = value => parseLifecycleSummary(JSON.stringify(value), now)

test('requested summary contract accepts explicit owner decisions without creating work', () => {
  for (const state of ['due', 'idle', 'blocked', 'unknown']) {
    const input = summary({ state, error_class: state === 'unknown' ? 'unknown' : state === 'blocked' ? 'permission' : 'none' })
    assert.deepEqual(parse(input), input)
    assert.ok(Object.isFrozen(parse(input)))
  }
  assert.equal(parse(summary({ state: 'waiting', next_due_at: '2026-10-22T18:00:05Z' })).state, 'waiting')
})

test('actual 6ddf61d legacy JSON never becomes a lifecycle summary by inference', () => {
  // These exact output shapes are emitted by cmd/transferqueue/main.go at the
  // pinned producer commit. They carry no versioned due/auth decision contract.
  for (const output of [
    { state: 'idle' },
    { state: 'pending_or_unavailable', feedback_status: '' },
    { state: 'busy', feedback_status: '' },
    { storage: 'available', device_configuration: 'required', profile: 'native-profile-v1' },
  ]) assert.throws(() => parse(output), { code: 'transfer_lifecycle_contract_missing' })
})

test('unknown schema, states, fields and accidental private payloads fail closed', () => {
  assert.throws(() => parse(summary({ schema: 'memoh.delivery.lifecycle.v2' })), { code: 'transfer_lifecycle_contract_missing' })
  for (const patch of [{ state: 'online' }, { error_class: 'retry_everything' }, { credentials: 'synthetic-only' }, { source_path: 'synthetic-only' }]) {
    assert.throws(() => parse(summary(patch)), { code: 'transfer_lifecycle_contract_invalid' })
  }
})

test('missing or expired due times cannot authorize an invented retry policy', () => {
  for (const next_due_at of [null, 1000, 'later', '2026-10-22T17:59:59Z', '2026-10-22T18:00:01+00:00', '2027-02-31T18:00:00Z']) {
    assert.throws(() => parse(summary({ state: 'waiting', next_due_at })), { code: 'transfer_lifecycle_contract_invalid' })
  }
  for (const error_class of ['transient', 'busy']) {
    assert.throws(() => parse(summary({ state: 'blocked', error_class })), { code: 'transfer_lifecycle_contract_invalid' })
  }
  assert.throws(() => parse(summary({ next_due_at: '2026-10-22T18:00:05Z' })), { code: 'transfer_lifecycle_contract_invalid' })
})

test('malformed and oversized output is bounded without echoing raw diagnostics', () => {
  for (const raw of ['private diagnostic', '{', 'x'.repeat(16385)]) {
    assert.throws(() => parseLifecycleSummary(raw, now), error => error.code === 'transfer_summary_output_invalid' && !error.message.includes(raw))
  }
})

test('PR56 unknown busy/transient permits only a host hint, not an invented queue deadline', () => {
  for (const error_class of ['transient', 'busy']) {
    assert.equal(parse(summary({ state: 'unknown', error_class })).next_due_at, null)
  }
  for (const state of ['due', 'idle', 'unknown', 'blocked']) {
    assert.throws(() => parse(summary({ state, next_due_at: '2026-10-22T18:00:05Z' })))
  }
  assert.throws(() => parse(summary({ state: 'due', error_class: 'unknown' })))
})

test('Go RFC3339Nano is retained exactly and rounded up for consumer wakes', () => {
  const next_due_at = '2026-10-22T18:00:05.123456789Z'
  assert.equal(parse(summary({ state: 'waiting', next_due_at })).next_due_at, next_due_at)
  assert.equal(deadlineMilliseconds(next_due_at), now + 5124)
  assert.equal(deadlineMilliseconds('2026-10-22T18:00:05.123000000Z'), now + 5123)
  assert.throws(() => deadlineMilliseconds('2026-02-31T18:00:05.123456789Z'))
})

test('actual PR56 advance envelope projects decisions without claiming reference association', () => {
  const value = { ...summary(), delivery_id: 'existing-delivery', phase: 'ready', offset: 7, admitted: true, associated: false, feedback_status: 'recorded',
    reference: { delivery_id: 'existing-delivery', operation_id: 'existing-operation', bot_id: 'existing-bot', content_hash: 'a'.repeat(64), size_bytes: 7, mime: 'text/plain' } }
  assert.deepEqual(parseAdvanceDecision(JSON.stringify(value), now), summary())
  assert.throws(() => parseLifecycleSummary(JSON.stringify(value), now))
  for (const patch of [{ credential: 'synthetic-private' }, { offset: -1 }, { associated: 'true' }, { reference: { ...value.reference, path: 'synthetic-private' } }]) {
    assert.throws(() => parseAdvanceDecision(JSON.stringify({ ...value, ...patch }), now))
  }
  assert.throws(() => parseAdvanceDecision(JSON.stringify(summary()), now))
})

test('metadata registration is a boolean envelope field, not a delivery or scheduling state', () => {
  const value = { ...summary({ state: 'due' }), delivery_id: 'original-delivery', phase: 'queued', offset: 0, registered: true, admitted: false, associated: false, feedback_status: 'recorded' }
  assert.deepEqual(parseAdvanceDecision(JSON.stringify(value), now), summary({ state: 'due' }))
  assert.deepEqual(parseAdvanceDecision(JSON.stringify({ ...value, registered: false, admitted: true }), now), summary({ state: 'due' }))
  const { registered, ...legacy } = value
  assert.deepEqual(parseAdvanceDecision(JSON.stringify(legacy), now), summary({ state: 'due' }))
  for (const registered of [null, 'true', 1, {}]) assert.throws(() => parseAdvanceDecision(JSON.stringify({ ...value, registered }), now))
  assert.throws(() => parseAdvanceDecision(JSON.stringify({ ...value, state: 'registered' }), now))
  assert.throws(() => parseLifecycleSummary(JSON.stringify({ ...summary(), registered: true }), now))
})

test('disk capacity wait requires the producer deadline without weakening other failure classes', () => {
  const waiting = summary({ state: 'waiting', error_class: 'capacity', next_due_at: '2026-10-22T18:05:00Z' })
  assert.deepEqual(parse(waiting), waiting)
  assert.deepEqual(parseAdvanceDecision(JSON.stringify({ ...waiting, delivery_id: 'original-download', phase: 'queued', offset: 8388608, admitted: true, associated: false, feedback_status: 'recorded' }), now), waiting)
  for (const next_due_at of [null, '2026-10-22T18:00:00Z']) assert.throws(() => parse({ ...waiting, next_due_at }))
  for (const error_class of ['authentication', 'permission', 'configuration', 'unknown']) assert.throws(() => parse({ ...waiting, error_class }))
})

test('missing legacy feedback is unknown and cannot imply recorded or not-applicable', () => {
  const value = { ...summary({ state: 'due' }), delivery_id: 'original', phase: 'queued', offset: 0, admitted: true, associated: false }
  for (const patch of [{}, { feedback_status: '' }]) assert.throws(() => parseAdvanceDecision(JSON.stringify({ ...value, ...patch }), now), { code: 'transfer_feedback_unknown' })
  assert.throws(() => parseAdvanceDecision(JSON.stringify({ ...value, feedback_status: 'unavailable' }), now), { code: 'transfer_feedback_unavailable' })
  assert.throws(() => parseAdvanceDecision(JSON.stringify({ ...value, feedback_status: 'unknown' }), now), { code: 'transfer_lifecycle_contract_invalid' })
})

test('pinned inbound not-applicable bypasses only feedback and preserves lifecycle and identity checks', () => {
  const waiting = summary({ state: 'waiting', error_class: 'transient', next_due_at: '2026-10-22T18:05:00Z' })
  const value = { ...waiting, delivery_id: 'original-download', phase: 'queued', offset: 0, admitted: true, associated: false, feedback_status: 'not_applicable' }
  assert.deepEqual(parseAdvanceDecision(JSON.stringify(value), now), waiting)
  for (const patch of [{ next_due_at: null }, { offset: -1 }, { associated: 'true' }, { reference: { delivery_id: 'another' } }]) {
    assert.throws(() => parseAdvanceDecision(JSON.stringify({ ...value, ...patch }), now))
  }
})
