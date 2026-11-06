// Evidence inside the existing lifecycle journal, never an alternate task ledger.
// Only an owned, confirmed normal stop may record this checkpoint. It permits
// ordinary shell layout restoration, not Agent resumption or unknown-task replay.
import path from 'node:path'
import { createHash } from 'node:crypto'
import { boundedRead } from './session-diagnostics.mjs'

const hash = value => createHash('sha256').update(value).digest('hex')
const reject = code => { throw Object.assign(new Error(code), { code }) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function binding(config) {
  const keys = ['deviceId', 'runtimeId', 'instanceId', 'session', 'sourceRoot', 'herdrConfigRoot', 'herdrStateRoot', 'agenvoConfigDir', 'piConfigDir']
  const values = [...keys.map(k => config[k]), config.transfer || null]
  // Preserve legacy hashes exactly. A native connection reference remains part
  // of this local data binding, never an authenticated NAS identity assertion.
  if (config.schema === 3) values.push(config.connector.kind, config.connector.enrollmentFile)
  // An explicit direct-CLI directory pair is part of the selected data identity.
  // Keep every pre-pair binding byte unchanged when the pair is absent.
  if (config.schema === 3 && Object.hasOwn(config, 'transferConfigDir')) values.push(config.transferConfigDir, config.transferStateDir)
  return hash(JSON.stringify(values))
}
function ordinary(raw) {
  let snapshot
  try { snapshot = JSON.parse(raw) } catch { return false }
  if (snapshot?.version !== 3 || !Array.isArray(snapshot.workspaces)) return false
  const fields = ['cwd', 'label', 'agent_name', 'managed_agent_kind', 'agent_session', 'agent_resume', 'launch_argv']
  return snapshot.workspaces.every(workspace => object(workspace) && typeof workspace.id === 'string' && Array.isArray(workspace.tabs) && workspace.tabs.every(tab =>
    object(tab) && object(tab.panes) && Object.values(tab.panes).every(pane => object(pane) && typeof pane.cwd === 'string' && Object.keys(pane).every(k => fields.includes(k)) &&
      ['agent_name', 'managed_agent_kind', 'agent_session', 'agent_resume', 'launch_argv'].every(k => pane[k] === undefined || pane[k] === null))))
}
export function validSessionContinuation(value) {
  return object(value) && Object.keys(value).sort().join(',') === 'binding,configuration,ordinary,schema,snapshot' && value.schema === 1 &&
    ['binding', 'configuration'].every(k => /^[a-f0-9]{64}$/.test(value[k])) && (value.snapshot === null || /^[a-f0-9]{64}$/.test(value.snapshot)) && typeof value.ordinary === 'boolean'
}
export async function captureSessionContinuation(config) {
  const configuration = hash(await boundedRead(path.join(config.herdrConfigRoot, 'config.toml'), 262144))
  let raw
  try { raw = await boundedRead(path.join(config.herdrConfigRoot, 'sessions', config.session, 'session.json'), 4 * 1024 ** 2) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  return { schema: 1, binding: binding(config), configuration, snapshot: raw === undefined ? null : hash(raw), ordinary: raw === undefined || ordinary(raw) }
}
export async function verifySessionContinuation(config, checkpoint) {
  if (!validSessionContinuation(checkpoint)) reject('session_continuation_invalid')
  // Check identity before accepting an empty directory: changing a data root
  // must not silently strand the old workspaces, Pi sessions or attempt files.
  if (checkpoint.binding !== binding(config)) reject('session_data_identity_changed')
  const current = await captureSessionContinuation(config)
  if (current.configuration !== checkpoint.configuration || current.snapshot !== checkpoint.snapshot) reject('session_continuation_changed')
  if (!checkpoint.ordinary || !current.ordinary) reject('existing_herdr_session_requires_handoff')
}

// Official capture re-run against the same config. A journal written by an older
// program may lack the checkpoint because that program consumed it at start and
// never recorded a new one; the official files are still the authority. The
// derived value is verified by the same function as a recorded one, so it cannot
// stand in for a changed session, root or agent-bearing history.
export async function sessionCheckpoint(config, state) {
  const recorded = state?.sessionContinuation
  if (recorded) { await verifySessionContinuation(config, recorded); return recorded }
  const derived = await captureSessionContinuation(config)
  await verifySessionContinuation(config, derived)
  return derived
}

// Only the producer reference may differ; every other data identity stays exact.
function referenceChange(before, after) {
  if (!before.transfer || !after.transfer || before.transfer.pluginRoot === after.transfer.pluginRoot) reject('producer_session_reference_invalid')
  const expected = structuredClone(before)
  expected.transfer.pluginRoot = after.transfer.pluginRoot
  if (JSON.stringify(expected) !== JSON.stringify(after)) reject('producer_session_identity_changed')
}

// A producer reference change has its own offline transaction. Never use this
// for a Pi profile, task root, enrollment, origin or credential change.
// Both bindings are calculated from real, unchanged ordinary saved workspaces.
export async function producerSessionTransition(before, after, checkpoint) {
  referenceChange(before, after)
  await verifySessionContinuation(before, checkpoint)
  if (checkpoint.snapshot === null) reject('producer_session_snapshot_required')
  const next = await captureSessionContinuation(after)
  if (!next.ordinary || next.snapshot !== checkpoint.snapshot || next.configuration !== checkpoint.configuration) reject('producer_session_snapshot_changed')
  await verifySessionContinuation(before, checkpoint)
  return next
}

// An archived producer transaction records what was confirmed at that time. It
// cannot be re-verified against today's session.json byte for byte: the host
// deletes the checkpoint before every start and recaptures it at the confirmed
// stop, so each start/stop rewrites the official snapshot (lifecycle.mjs). What
// the archive still proves is its own integrity — a well-formed ordinary
// checkpoint, bound to the roots of the configuration it was taken under and to
// the archived official config.toml — while an agent-bearing live session still
// needs the explicit handoff. Session rotation is tolerated, adoption is not.
//   before/after: configs rebuilt from the archived bytes.
//   archivedState: the companion journal archived beside the plan.
//   expected: plan.continuation, the transition the archived plan recorded.
export async function archivedSessionTransition(before, after, archivedState, expected) {
  referenceChange(before, after)
  if (!validSessionContinuation(expected) || !expected.ordinary || expected.snapshot === null) reject('session_continuation_invalid')
  // Only pluginRoot may move, so the recorded binding must be one of the two.
  if (![binding(before), binding(after)].includes(expected.binding)) reject('producer_upgrade_evidence_changed')
  // config.toml is the one official byte a host cycle never rewrites.
  if (expected.configuration !== hash(await boundedRead(path.join(before.herdrConfigRoot, 'config.toml'), 262144))) reject('session_continuation_changed')
  // The journal archived beside the plan must record that same transition, taken
  // before the reference change it announces.
  const recorded = archivedState?.sessionContinuation
  if (recorded !== undefined && (!validSessionContinuation(recorded) || !recorded.ordinary ||
    recorded.binding !== binding(before) || recorded.snapshot !== expected.snapshot || recorded.configuration !== expected.configuration))
    reject('producer_upgrade_evidence_changed')
  // An agent-bearing live session is unknown work, not an ordinary rotation.
  if (!(await captureSessionContinuation(before)).ordinary) reject('existing_herdr_session_requires_handoff')
  return expected
}
