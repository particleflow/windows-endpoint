import test from 'node:test'
import assert from 'node:assert/strict'
import { parseLifecycleSummary } from './official-smoke/transfer-contract.mjs'

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
