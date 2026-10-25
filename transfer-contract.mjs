// Versioned producer decisions. Never translate legacy idle or stderr to work.
export class TransferContractError extends Error {
  constructor(code) { super(code); this.code = code }
}
function requireContract(condition, code = 'transfer_lifecycle_contract_invalid') {
  if (!condition) throw new TransferContractError(code)
}

function object(raw) {
  requireContract(typeof raw === 'string' && Buffer.byteLength(raw) <= 16384, 'transfer_summary_output_invalid')
  let value
  try { value = JSON.parse(raw) } catch { throw new TransferContractError('transfer_summary_output_invalid') }
  requireContract(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value
}

// Go time.Time emits up to nanosecond precision. Round the wake UP to a Node
// millisecond, retaining the original string; never wake before a producer due.
export function deadlineMilliseconds(value) {
  requireContract(typeof value === 'string')
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value)
  requireContract(match)
  const fraction = (match[2] || '').padEnd(9, '0')
  const truncated = `${match[1]}.${fraction.slice(0, 3)}Z`
  const time = Date.parse(truncated)
  requireContract(Number.isFinite(time) && new Date(time).toISOString() === truncated)
  return time + (Number(fraction.slice(3)) > 0 ? 1 : 0)
}

function decision(value, now) {
  requireContract(value.schema === 'memoh.delivery.lifecycle.v1', 'transfer_lifecycle_contract_missing')
  requireContract(['schema', 'state', 'next_due_at', 'error_class'].every(k => Object.hasOwn(value, k)))
  requireContract(['due', 'idle', 'waiting', 'blocked', 'unknown'].includes(value.state))
  requireContract(['none', 'transient', 'busy', 'authentication', 'permission', 'configuration', 'capacity', 'unknown'].includes(value.error_class))
  const dueAt = value.next_due_at === null ? null : deadlineMilliseconds(value.next_due_at)
  if (value.state === 'waiting') requireContract(dueAt !== null && dueAt > now)
  else requireContract(dueAt === null)
  if (['idle', 'due'].includes(value.state)) requireContract(value.error_class === 'none')
  if (value.state === 'waiting') requireContract(['none', 'transient', 'busy', 'capacity'].includes(value.error_class))
  if (['transient', 'busy'].includes(value.error_class)) requireContract(['waiting', 'unknown'].includes(value.state))
  return Object.freeze({ schema: value.schema, state: value.state, next_due_at: value.next_due_at, error_class: value.error_class })
}

export function parseLifecycleSummary(raw, now = Date.now()) {
  const value = object(raw)
  const result = decision(value, now)
  requireContract(Object.keys(value).sort().join(',') === 'error_class,next_due_at,schema,state')
  return result
}

// advance-results preserves producer IDs/reference. Validate its fixed envelope
// and project only decisions; no new result queue or completion inference here.
export function parseAdvanceDecision(raw, now = Date.now()) {
  const value = object(raw)
  const result = decision(value, now)
  const required = ['schema', 'state', 'next_due_at', 'error_class', 'delivery_id', 'phase', 'offset', 'admitted', 'associated']
  const optional = ['feedback_status', 'source_collection', 'payload_state', 'association_state', 'error_code', 'reference', 'registered']
  requireContract(required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => [...required, ...optional].includes(k)))
  for (const k of ['delivery_id', 'phase', ...optional.filter(k => !['reference', 'registered'].includes(k))]) {
    if (Object.hasOwn(value, k)) requireContract(typeof value[k] === 'string' && value[k].length <= 256 && !/[\x00-\x1f]/.test(value[k]))
  }
  requireContract(Number.isSafeInteger(value.offset) && value.offset >= 0 && typeof value.admitted === 'boolean' && typeof value.associated === 'boolean')
  // Plugin 0.9 adds metadata registration; older envelopes omit the field.
  // Neither registration nor admission establishes delivery/business completion.
  if (Object.hasOwn(value, 'registered')) requireContract(typeof value.registered === 'boolean')
  if (Object.hasOwn(value, 'reference')) {
    const ref = value.reference
    requireContract(ref && typeof ref === 'object' && !Array.isArray(ref))
    requireContract(Object.keys(ref).sort().join(',') === 'bot_id,content_hash,delivery_id,mime,operation_id,size_bytes')
    for (const k of ['bot_id', 'delivery_id', 'operation_id', 'mime']) requireContract(typeof ref[k] === 'string' && ref[k].length > 0 && ref[k].length <= 256 && !/[\x00-\x1f]/.test(ref[k]))
    requireContract(ref.delivery_id === value.delivery_id && /^[a-f0-9]{64}$/.test(ref.content_hash) && Number.isSafeInteger(ref.size_bytes) && ref.size_bytes >= 0)
  }
  if (Object.hasOwn(value, 'feedback_status')) {
    requireContract(['recorded', 'unavailable'].includes(value.feedback_status))
    requireContract(value.feedback_status === 'recorded', 'transfer_feedback_unavailable')
  }
  return result
}
