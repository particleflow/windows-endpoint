// Acceptance boundary for the requested producer interface. This is not an old
// CLI compatibility shim, scheduler, or permission to invoke transfer work.
export class TransferContractError extends Error {
  constructor(code) { super(code); this.code = code }
}
function requireContract(condition, code = 'transfer_lifecycle_contract_invalid') {
  if (!condition) throw new TransferContractError(code)
}

export function parseLifecycleSummary(raw, now = Date.now()) {
  requireContract(typeof raw === 'string' && Buffer.byteLength(raw) <= 16384, 'transfer_summary_output_invalid')
  let value
  try { value = JSON.parse(raw) } catch { throw new TransferContractError('transfer_summary_output_invalid') }
  requireContract(value !== null && typeof value === 'object' && !Array.isArray(value))
  requireContract(value.schema === 'memoh.delivery.lifecycle.v1', 'transfer_lifecycle_contract_missing')
  requireContract(Object.keys(value).sort().join(',') === 'error_class,next_due_at,schema,state')
  requireContract(['due', 'idle', 'waiting', 'blocked', 'unknown'].includes(value.state))
  requireContract(['none', 'transient', 'busy', 'authentication', 'permission', 'configuration', 'capacity', 'unknown'].includes(value.error_class))
  const dueAt = value.next_due_at === null ? null : Date.parse(value.next_due_at)
  requireContract(value.next_due_at === null || (typeof value.next_due_at === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value.next_due_at) && Number.isFinite(dueAt)))
  if (dueAt !== null) {
    const canonical = value.next_due_at.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction) => `.${(fraction || '').padEnd(3, '0')}Z`)
    requireContract(new Date(dueAt).toISOString() === canonical)
  }
  if (value.state === 'waiting') requireContract(dueAt !== null && dueAt > now)
  if (value.state === 'idle') requireContract(dueAt === null)
  if (['transient', 'busy'].includes(value.error_class)) requireContract(dueAt !== null && dueAt > now)
  return Object.freeze({ ...value })
}
