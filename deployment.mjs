import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { stageBundle, validateConfig, validateDirectory, verifyBundle, transferLocations } from './endpoint.mjs'
import { acquireLeases, leaseKeys, StateStore } from './lifecycle.mjs'

// Internal offline transaction engine. No public activation command consumes
// this selection yet: official path approval and state/quiescence proofs remain
// unimplemented. Tests supply explicit synthetic proof providers.
export class DeploymentError extends Error {
  constructor(code) { super(code); this.code = code }
}
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
function demand(value, code) { if (!value) throw new DeploymentError(code) }
function exact(value, fields) {
  return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === fields.slice().sort().join(',')
}
function contains(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`))
}
const report = (state, extra = {}) => ({ state, ...extra, activation: 'blocked', transferAutomaticRecovery: false, evidence: 'offline_transaction_only' })
const layoutTemplate = JSON.parse(await fs.readFile(new URL('./deployment-layout.json', import.meta.url), 'utf8'))

// Installation-owned layout; software packages contain only relative paths.
// Existing user configuration is never generated, rewritten or relocated here.
export function deploymentLayout(root) {
  demand(path.isAbsolute(root) && path.normalize(root) === root, 'deployment_absolute_root_required')
  return Object.fromEntries(['packages', 'control', 'config', 'data', 'logs'].map(name => [name, path.join(root, name)]))
}
export function deploymentReferences(root, references) {
  const layout = deploymentLayout(root)
  demand(hash(references.manifestSha256), 'deployment_manifest_hash_required')
  const paths = Object.fromEntries(Object.entries(layoutTemplate.references).map(([key, relative]) => {
    demand(typeof relative === 'string' && relative.split('/').every(part => /^[a-z][a-z.-]*$/.test(part) && part !== '..'), 'deployment_layout_invalid')
    return [key, path.join(root, relative)]
  }))
  return validateConfig({ ...references, ...paths, schema: 1, bundleRoot: path.join(layout.packages, references.manifestSha256) })
}

export class DeploymentTransactions {
  constructor({ root, config, lifecycleDirectory, inspectWork, qualify, verify = verifyBundle, stage = stageBundle, io = fs, checkpoint = async () => {} }) {
    this.root = root; this.layout = deploymentLayout(root); this.config = structuredClone(config)
    this.lifecycleDirectory = lifecycleDirectory
    this.lifecycleStore = new StateStore(lifecycleDirectory, config.deviceId)
    this.inspectWork = inspectWork; this.qualify = qualify; this.io = io; this.checkpoint = checkpoint
    this.verify = verify; this.stagePayload = stage
    this.file = path.join(this.layout.control, 'deployment.json')
  }
  async locked(operation) {
    validateConfig(this.config)
    const transfer = this.config.schema === 1 || this.config.transfer ? transferLocations(this.config) : null
    for (const target of [this.lifecycleDirectory, ...['sourceRoot', 'herdrConfigRoot', 'herdrStateRoot', 'agenvoConfigDir', 'piConfigDir'].map(key => this.config[key]), ...(transfer ? [transfer.config, transfer.state] : [])]) {
      demand([this.layout.packages, this.layout.control].every(root => !contains(root, target) && !contains(target, root)), 'deployment_mutable_root_overlap')
    }
    await validateDirectory(this.root)
    await validateDirectory(this.lifecycleDirectory)
    // The normal endpoint and this offline updater use the same lifetime leases.
    // A running/draining endpoint is deferred; this code never stops/kills it.
    let release
    try { release = await acquireLeases([...leaseKeys(this.config), `host:${this.root}`, `deployment:${this.root}`], this.lifecycleDirectory) }
    catch (error) { if (error.code === 'endpoint_already_owned') return report('deferred', { reason: 'endpoint_owned' }); throw error }
    try {
      const lifecycle = await this.lifecycleStore.load()
      if (lifecycle.phase !== 'stopped' || lifecycle.attention) return report('deferred', { reason: lifecycle.attention ? 'endpoint_attention' : 'endpoint_stop_unverified' })
      return await operation()
    } catch (error) {
      if (error instanceof DeploymentError) throw error
      if (/^candidate_[a-z_]+$/.test(error.code)) throw new DeploymentError(error.code)
      const reason = ['EACCES', 'EPERM', 'EROFS'].includes(error.code) ? 'deployment_storage_read_only' : error.code === 'ENOSPC' ? 'deployment_space_unavailable' : 'deployment_operation_failed'
      throw new DeploymentError(reason)
    } finally { await release() }
  }
  async read() {
    for (const directory of Object.values(this.layout)) await validateDirectory(directory)
    const st = await this.io.lstat(this.file)
    demand(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size <= 65536, 'deployment_journal_unsafe')
    let state
    try { state = JSON.parse(await this.io.readFile(this.file, 'utf8')) } catch { throw new DeploymentError('deployment_journal_unreadable') }
    demand(exact(state, ['schema', 'owner', 'packages', 'current', 'previous', 'pending']) && state.schema === 1 && state.owner === this.config.deviceId, 'deployment_journal_incompatible')
    demand(Array.isArray(state.packages) && state.packages.length <= 128 && state.packages.every(p => exact(p, ['hash', 'profile']) && hash(p.hash) && hash(p.profile)), 'deployment_journal_incompatible')
    demand(new Set(state.packages.map(p => p.hash)).size === state.packages.length, 'deployment_journal_incompatible')
    for (const key of ['current', 'previous']) demand(state[key] === null || state.packages.some(p => p.hash === state[key]), 'deployment_journal_incompatible')
    const p = state.pending
    if (p !== null) {
      if (p.kind === 'stage') demand(exact(p, ['kind', 'hash', 'profile']) && hash(p.hash) && hash(p.profile) && state.packages.length < 128 && !state.packages.some(item => item.hash === p.hash), 'deployment_journal_incompatible')
      else {
        demand(exact(p, ['kind', 'from', 'to', 'phase']) && p.kind === 'switch' && ['prepared', 'selected'].includes(p.phase) && (p.from === null || state.packages.some(item => item.hash === p.from)) && state.packages.some(item => item.hash === p.to), 'deployment_journal_incompatible')
        demand(state.current === (p.phase === 'prepared' ? p.from : p.to) && (p.phase !== 'selected' || state.previous === p.from), 'deployment_journal_incompatible')
      }
    }
    return state
  }
  async write(state) {
    // Flush the complete small journal before same-directory atomic rename.
    // Leftover temporary files are retained and reported, never wildcard-deleted.
    const temporary = path.join(this.layout.control, `.deployment-${randomUUID()}.tmp`)
    const handle = await this.io.open(temporary, 'wx')
    try { await handle.writeFile(`${JSON.stringify(state)}\n`); await handle.sync() } finally { await handle.close() }
    await this.io.rename(temporary, this.file)
  }
  async space(bytes = 65536) {
    const space = await this.io.statfs(this.root)
    demand(space.bavail * space.bsize >= bytes, 'deployment_space_unavailable')
  }
  async initialize() {
    return this.locked(async () => {
      const existing = await this.io.readdir(this.root)
      if (existing.includes('control') || existing.includes('packages')) {
        await this.read() // Never adopt a foreign/nonempty installation root.
        return report('already_initialized')
      }
      demand(existing.every(name => ['config', 'data', 'logs'].includes(name)), 'deployment_unowned_root_retained')
      await this.space()
      for (const [name, directory] of Object.entries(this.layout)) {
        if (existing.includes(name)) await validateDirectory(directory)
        else await this.io.mkdir(directory)
      }
      await this.write({ schema: 1, owner: this.config.deviceId, packages: [], current: null, previous: null, pending: null })
      return report('initialized_review_only')
    })
  }
  async proof(directory, expectedHash) {
    const verified = await this.verify(directory, expectedHash)
    demand(typeof this.qualify === 'function', 'deployment_component_qualification_missing')
    const value = await this.qualify(directory, expectedHash)
    demand(exact(value, ['schema', 'stateProfileSha256']) && value.schema === 1 && hash(value.stateProfileSha256), 'deployment_state_profile_unknown')
    return { profile: value.stateProfileSha256, totalBytes: verified.totalBytes }
  }
  async owned(state, expectedHash) {
    const item = state.packages.find(p => p.hash === expectedHash)
    demand(item, 'deployment_package_not_owned')
    const proof = await this.proof(path.join(this.layout.packages, expectedHash), expectedHash)
    demand(proof.profile === item.profile, 'deployment_state_profile_changed')
    return item
  }
  async work(profile) {
    if (typeof this.inspectWork !== 'function') return 'work_observation_unavailable'
    const value = await this.inspectWork()
    if (!exact(value, ['schema', 'admission', 'tasks', 'transfers', 'stateProfileSha256']) || value.schema !== 1) return 'work_unknown'
    if (value.tasks === 'busy' || value.transfers === 'busy') return 'work_busy'
    if (value.admission !== 'closed' || value.tasks !== 'idle' || value.transfers !== 'idle' || !hash(value.stateProfileSha256)) return 'work_unknown'
    if (value.stateProfileSha256 !== profile) return 'state_profile_incompatible'
    return null
  }
  async stage(source, expectedHash) {
    return this.locked(async () => {
      demand(hash(expectedHash), 'deployment_manifest_hash_required')
      const state = await this.read()
      demand(state.pending === null, 'deployment_recovery_required')
      if (state.packages.some(p => p.hash === expectedHash)) {
        await this.owned(state, expectedHash)
        return report('already_staged', { manifestSha256: expectedHash })
      }
      demand(state.packages.length < 128, 'deployment_inventory_full')
      try { await this.io.lstat(path.join(this.layout.packages, expectedHash)); throw new DeploymentError('deployment_unowned_package_retained') }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      const proof = await this.proof(source, expectedHash)
      await this.space(proof.totalBytes + 64 * 1024 ** 2)
      state.pending = { kind: 'stage', hash: expectedHash, profile: proof.profile }
      await this.write(state); await this.checkpoint('stage_prepared')
      await this.stagePayload(source, this.layout.packages, expectedHash, { checkpoint: () => this.checkpoint('stage_copying') })
      await this.checkpoint('stage_published')
      state.packages.push({ hash: expectedHash, profile: proof.profile }); state.pending = null
      await this.write(state)
      return report('staged_review_only', { manifestSha256: expectedHash })
    })
  }
  async selectionCheck(state, target, mode) {
    demand(state.pending === null, 'deployment_recovery_required')
    demand(['install', 'update', 'rollback'].includes(mode), 'deployment_mode_invalid')
    if (mode === 'install') demand(state.current === null || state.current === target, 'deployment_already_installed')
    else demand(state.current !== null, 'deployment_not_installed')
    if (mode === 'rollback' && state.current !== target) demand(state.previous === target, 'deployment_rollback_target_unknown')
    const item = await this.owned(state, target)
    if (state.current !== null) await this.owned(state, state.current)
    const reason = await this.work(item.profile)
    if (reason) return report('deferred', { reason })
    await this.space()
    return report('eligible_review_only', { manifestSha256: target })
  }
  async preflight(target, mode) {
    return this.locked(async () => this.selectionCheck(await this.read(), target, mode))
  }
  async select(target, mode) {
    return this.locked(async () => {
      const state = await this.read()
      const checked = await this.selectionCheck(state, target, mode)
      if (checked.state === 'deferred') return checked
      if (state.current === target) return report('already_selected', { manifestSha256: target })
      state.pending = { kind: 'switch', from: state.current, to: target, phase: 'prepared' }
      await this.write(state); await this.checkpoint('switch_prepared')
      // Re-observe immediately before publication, still holding the endpoint
      // lease. Real use needs a task owner's admission barrier, not a cached UI.
      const reason = await this.work(state.packages.find(p => p.hash === target).profile)
      if (reason) return report('deferred', { reason, recoveryRequired: true })
      state.previous = state.current; state.current = target; state.pending.phase = 'selected'
      await this.write(state); await this.checkpoint('switch_selected')
      state.pending = null
      await this.write(state); await this.checkpoint('switch_committed')
      return report('selected_review_only', { manifestSha256: target })
    })
  }
  async recover() {
    return this.locked(async () => {
      const state = await this.read()
      if (!state.pending) return report('no_recovery_needed', { manifestSha256: state.current })
      const pending = state.pending
      if (pending.kind === 'stage') {
        const directory = path.join(this.layout.packages, pending.hash)
        let exists = true
        try { await this.io.lstat(directory) } catch (error) { if (error.code !== 'ENOENT') throw error; exists = false }
        if (exists) {
          const proof = await this.proof(directory, pending.hash)
          demand(proof.profile === pending.profile, 'deployment_state_profile_changed')
          state.packages.push({ hash: pending.hash, profile: pending.profile })
        }
      } else {
        const selected = state.current === null ? pending.to : state.current
        const item = await this.owned(state, selected)
        const reason = await this.work(item.profile)
        if (reason) return report('deferred', { reason, recoveryRequired: true })
      }
      state.pending = null
      await this.write(state)
      return report('recovered_review_only', { manifestSha256: state.current, retainedUnrecordedFiles: true })
    })
  }
  async inventory() {
    return this.locked(async () => {
      const state = await this.read()
      const unknown = []
      const unverifiedOwnedPackages = []
      for (const entry of await this.io.readdir(this.root)) if (!Object.keys(this.layout).includes(entry)) unknown.push(entry)
      for (const entry of await this.io.readdir(this.layout.packages)) if (!state.packages.some(p => p.hash === entry)) unknown.push(`packages/${entry}`)
      for (const entry of await this.io.readdir(this.layout.control)) if (entry !== 'deployment.json') unknown.push(`control/${entry}`)
      for (const item of state.packages) {
        try { await this.verify(path.join(this.layout.packages, item.hash), item.hash) }
        catch { unverifiedOwnedPackages.push(item.hash) }
      }
      // No cleanup implementation in this first batch: even known old packages
      // are retained. No manifest omission, name prefix or guessed PID grants
      // deletion authority over unknown files or mutable roots.
      return report('inventory', { selected: state.current, ownedPackages: state.packages.map(p => p.hash), retainedUnknownEntries: unknown.sort(), unverifiedOwnedPackages, deletionImplemented: false })
    })
  }
}
