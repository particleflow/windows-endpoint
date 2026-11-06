// Acknowledgement data only. This module has no process, transport or stop API.
import { createHash } from 'node:crypto'

const reject = code => { throw Object.assign(new Error(code), { code }) }
const exact = (v, fields) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === [...fields].sort().join(',')
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const decimal = v => typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v)
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\u0000-\u001f\u007f]/.test(v)
export const handoffUUID = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v) && v !== '00000000-0000-0000-0000-000000000000'
const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v

export function handoffPayload(value) {
  const invalid = () => reject('handoff_payload_invalid')
  if (!exact(value, ['schema', 'request_id', 'host', 'native', 'gate', 'operations']) || value.schema !== 1 || !handoffUUID(value.request_id)) invalid()
  const h = value.host, n = value.native, g = value.gate
  if (!exact(h, ['run_id', 'root_sha256', 'program_sha256', 'configuration_sha256']) || !handoffUUID(h.run_id) || !['root_sha256', 'program_sha256', 'configuration_sha256'].every(k => hash(h[k]))) invalid()
  if (!exact(n, ['device_id', 'runtime_id', 'instance_id', 'session', 'herdr_pid', 'herdr_generation', 'connector_pid', 'connector_nonce']) || !handoffUUID(n.device_id) || !handoffUUID(n.runtime_id) || !text(n.instance_id) || !text(n.session) || !text(n.connector_nonce)) invalid()
  if (![n.herdr_pid, n.connector_pid].every(p => Number.isSafeInteger(p) && p > 0) || typeof n.herdr_generation !== 'string' || !/^[1-9][0-9]*:[0-9]+$/.test(n.herdr_generation) || n.herdr_generation.split(':')[0] !== String(n.herdr_pid)) invalid()
  if (!exact(g, ['connection_id', 'device_id', 'instance_id', 'request_id', 'revision', 'paused', 'scope']) || !handoffUUID(g.connection_id) || !handoffUUID(g.request_id) || g.device_id !== n.device_id || g.instance_id !== n.instance_id || !decimal(g.revision) || g.paused !== true || g.scope !== 'owner_connection_instance') invalid()
  if (!Array.isArray(value.operations)) invalid()
  const ids = new Set()
  for (const op of value.operations) {
    if (!exact(op, ['operation_id', 'revision', 'reconciliation_sha256']) || !handoffUUID(op.operation_id) || !decimal(op.revision) || !hash(op.reconciliation_sha256) || ids.has(op.operation_id)) invalid()
    ids.add(op.operation_id)
  }
  const result = canonical({ ...value, operations: [...value.operations].sort((a, b) => a.operation_id < b.operation_id ? -1 : a.operation_id > b.operation_id ? 1 : 0) })
  return { payload: result, sha256: createHash('sha256').update(JSON.stringify(result)).digest('hex') }
}

export function validHandoffRecord(value) {
  try {
    if (!exact(value, ['schema', 'request_id', 'payload_sha256', 'payload', 'state']) || value.schema !== 1 || !['recorded_unverified', 'outcome_unknown'].includes(value.state)) return false
    const checked = handoffPayload(value.payload)
    return value.request_id === checked.payload.request_id && value.payload_sha256 === checked.sha256
  } catch { return false }
}

export function handoffObservation(record, requestId) {
  if (!handoffUUID(requestId)) reject('handoff_request_id_invalid')
  // A missing record is not proof of non-execution by another caller/process.
  const found = record?.request_id === requestId
  return { schema: 1, request_id: requestId, state: found ? record.state : 'not_recorded_unknown',
    payload_sha256: found ? record.payload_sha256 : null, binding: found ? structuredClone(record.payload) : null,
    binding_evidence: 'unverified_declaration', principal: 'unverified', locator: 'unverified', stop_authority: false,
    stop_dispatched_by_ack: false, business_dispatched_by_ack: false, automatic_retry: false }
}
