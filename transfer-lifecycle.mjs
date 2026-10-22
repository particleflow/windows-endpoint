import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { catalog, transferEnvironment, validateTransferConfiguration } from './endpoint.mjs'
import { TransferContractError, parseLifecycleSummary, parseAdvanceDecision, deadlineMilliseconds } from './transfer-contract.mjs'

export class TransferError extends Error {
  constructor(code) { super(code); this.code = code }
}

export function transferCommand(config, action) {
  if (!['lifecycle-summary', 'advance-results'].includes(action)) throw new TransferError('transfer_action_rejected')
  return { file: path.join(config.bundleRoot, catalog.components.transfer.entry), args: ['-action', action] }
}

// Internal adapter, not activated by the public CLI. Qualification must validate
// the exact executable/plugin inventory AND the implemented lifecycle contract.
// The old pinned artifact and the unreviewed PR56 source do not qualify.
export class NativeTransferDriver {
  constructor(config, { qualify, inheritedEnvironment = process.env } = {}) {
    this.config = structuredClone(config)
    this.qualify = qualify
    this.env = transferEnvironment(this.config, inheritedEnvironment)
  }
  async invoke(action, mayInvoke = () => true) {
    const command = transferCommand(this.config, action)
    if (process.platform !== 'win32' || process.arch !== 'x64' || typeof this.qualify !== 'function' || await this.qualify() !== true) {
      throw new TransferError('transfer_component_unqualified')
    }
    try { await validateTransferConfiguration(this.config) }
    catch (error) {
      const reason = ['EACCES', 'EPERM'].includes(error.code) ? 'permission' : error.code === 'transfer_credential_missing' ? 'authentication' : 'configuration'
      throw new TransferError(`transfer_${reason}`)
    }
    // This cancellation is emitted only before execFile: no child was spawned.
    if (!mayInvoke()) throw new TransferError('transfer_stopping')
    const options = { env: this.env, cwd: this.config.sourceRoot, encoding: 'utf8',
      timeout: 125000, maxBuffer: 16384, windowsHide: true, shell: false }
    try {
      const result = await promisify(execFile)(command.file, command.args, options)
      return { status: 0, stdout: result.stdout }
    } catch (error) {
      // A real nonzero exit can still carry a typed producer decision. Timeouts,
      // signals, output overflow and spawn failures are unknown, never retryable
      // by inference from stderr. execFile settles after the owned child closes.
      if (!error.killed && !error.signal && Number.isInteger(error.code)) return { status: error.code, stdout: error.stdout }
      throw new TransferError('transfer_command_outcome_unknown')
    }
  }
}

// One in-memory projection of producer state, no transfer IDs, durable work or
// independent timer. Only EndpointLifecycle.tick drives this controller. The
// existing endpoint journal persists attention; producer journals own all work.
export class TransferLifecycle {
  constructor({ driver, clock = Date.now }) {
    this.driver = driver; this.clock = clock
    this.stopping = true; this.state = 'stopped'; this.nextCheck = null
    this.nextAdvance = 0; this.active = null; this.attention = null
    this.decision = null; this.pendingHint = false; this.retryUsed = false
  }
  start() {
    if (this.active) throw new TransferError('transfer_action_active')
    this.stopping = false; this.state = 'unverified'; this.attention = null
    this.decision = null; this.nextCheck = 0; this.nextAdvance = 0
    this.pendingHint = true; this.retryUsed = false
  }
  hint(kind) {
    if (!['completion', 'network', 'owner'].includes(kind)) throw new TransferError('transfer_hint_rejected')
    if (!this.stopping && !this.attention) this.pendingHint = true
  }
  snapshot() {
    return { state: this.state, attention: this.attention,
      decision: this.decision, nextCheckAt: this.nextCheck === null ? null : new Date(this.nextCheck).toISOString(),
      active: Boolean(this.active), businessCompletion: 'not_inferred', evidence: 'consumer_unit_boundary' }
  }
  suspend(reason) {
    this.attention = reason; this.state = 'needs_attention'; this.nextCheck = null
  }
  accept(decision, status) {
    this.decision = decision
    const now = this.clock()
    // Includes the reported PR56 corruption trap: due + exit 1 must NOT be
    // transformed into a new immediate advance on every endpoint tick.
    if (![0, 1].includes(status) || (status !== 0 && ['due', 'idle'].includes(decision.state))) {
      this.suspend('transfer_command_outcome_unknown'); return
    }
    if (['authentication', 'permission', 'configuration', 'capacity'].includes(decision.error_class)) {
      this.suspend(`transfer_${decision.error_class}`); return
    }
    if (decision.state === 'unknown' && ['transient', 'busy'].includes(decision.error_class) && !this.retryUsed) {
      this.retryUsed = true; this.state = 'retry_hint'; this.nextCheck = now + 30000; return
    }
    if (['unknown', 'blocked'].includes(decision.state)) {
      this.suspend(`transfer_${decision.error_class === 'none' ? 'unknown' : decision.error_class}`); return
    }
    this.state = decision.state
    if (decision.state === 'waiting') this.nextCheck = deadlineMilliseconds(decision.next_due_at)
    else this.nextCheck = now + (decision.state === 'idle' ? 30000 : 1000)
  }
  async read(action) {
    const observedAt = this.clock()
    const result = await this.driver.invoke(action, () => !this.stopping)
    // Stop closes the invocation gate, not the result gate. An issued command
    // must still be classified so EndpointLifecycle can persist its attention
    // before owned-component cleanup and lease release.
    if (!result || result.signal || result.error || result.timedOut || !Number.isInteger(result.status)) throw new TransferError('transfer_command_outcome_unknown')
    const parse = action === 'lifecycle-summary' ? parseLifecycleSummary : parseAdvanceDecision
    this.accept(parse(result.stdout, observedAt), result.status)
    return this.decision
  }
  async tick() {
    if (this.active) return this.active
    this.active = this.tickOnce()
    try { return await this.active } finally { this.active = null }
  }
  async tickOnce() {
    if (this.stopping || this.attention || (!this.pendingHint && this.clock() < this.nextCheck)) return this.snapshot()
    if (this.state === 'retry_hint' && this.clock() < this.nextCheck) return this.snapshot()
    // Coalesce hints already received. Hints arriving during a finite invocation
    // stay pending for the next endpoint tick, never start a parallel command.
    if (this.pendingHint) { this.pendingHint = false; this.retryUsed = false }
    try {
      await this.read('lifecycle-summary')
      if (!this.stopping && !this.attention && this.state === 'due' && this.clock() >= this.nextAdvance) {
        this.nextAdvance = this.clock() + 1000
        await this.read('advance-results')
      }
    } catch (error) {
      const cancelledBeforeInvocation = this.stopping && error instanceof TransferError && error.code === 'transfer_stopping'
      if (!cancelledBeforeInvocation) this.suspend(error instanceof TransferError || error instanceof TransferContractError ? error.code : 'transfer_command_outcome_unknown')
    }
    return this.snapshot()
  }
  requestStop() { this.stopping = true; this.pendingHint = false }
  async stop() {
    this.requestStop()
    if (this.active) await this.active
    this.state = 'stopped'; this.nextCheck = null
  }
}
