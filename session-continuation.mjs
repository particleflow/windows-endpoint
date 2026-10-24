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
  return hash(JSON.stringify([...keys.map(k => config[k]), config.transfer || null]))
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
