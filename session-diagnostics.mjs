// Read-only projections of one explicitly selected official session. No attach,
// start, stop, replay, task adoption, history import or ownership acquisition.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { validateDirectory, programPaths, managedEnvironment } from './endpoint.mjs'

const stamp = s => [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs, s.nlink].join(':')
const fail = code => { throw Object.assign(new Error(code), { code }) }
async function boundedRead(file, limit) {
  await validateDirectory(path.dirname(file))
  const before = await fs.lstat(file)
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) fail('unsafe_path')
  if (before.size > limit) fail('over_read_limit')
  const handle = await fs.open(file, 'r')
  try {
    if (stamp(await handle.stat()) !== stamp(before)) fail('changing')
    const buffer = Buffer.alloc(limit + 1)
    let size = 0
    while (size < buffer.length) {
      const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size)
      if (!bytesRead) break
      size += bytesRead
    }
    if (size > limit) fail('over_read_limit')
    if (stamp(await handle.stat()) !== stamp(before) || stamp(await fs.lstat(file)) !== stamp(before)) fail('changing')
    return buffer.subarray(0, size).toString('utf8')
  } finally { await handle.close() }
}
const reason = error => ['EACCES', 'EPERM', 'permission_denied'].includes(error?.code) ? 'permission_denied' :
  ['unsafe_path', 'over_read_limit', 'changing', 'reparse_point_rejected', 'noncanonical_path'].includes(error?.code) ? error.code : 'unavailable'
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const piReference = value => object(value) && value.source === 'herdr:pi' && value.agent === 'pi' && ['path', 'id'].includes(value.kind) && typeof value.value === 'string' && value.value.length > 0

export async function readSessionHistory(config) {
  const result = { state: 'unverified', version: null, workspaceCount: null, paneCount: null, piSessionReferences: null,
    restoreEligibility: 'not_verified', businessTasks: 'not_inferred', startup: 'requires_handoff', evidence: 'saved_snapshot_only' }
  let raw
  try { raw = await boundedRead(path.join(config.herdrConfigRoot, 'sessions', config.session, 'session.json'), 4 * 1024 ** 2) }
  catch (error) { result.state = error.code === 'ENOENT' ? 'absent' : reason(error); if (result.state === 'absent') result.startup = 'no_saved_history'; return result }
  let value
  try { value = JSON.parse(raw) } catch { result.state = 'invalid_json'; return result }
  const version = object(value) && !Object.hasOwn(value, 'version') ? 0 : value?.version
  if (!object(value) || !Number.isSafeInteger(version) || version < 0 || !Array.isArray(value.workspaces)) { result.state = 'unrecognized_structure'; return result }
  result.version = version; result.workspaceCount = value.workspaces.length
  if (version > 3) { result.state = 'newer_format'; return result }
  if (version < 3) { result.state = 'legacy_requires_native_validation'; return result }
  result.state = value.workspaces.length ? 'history_present' : 'empty_current_format'
  // Diagnostic reads may inspect larger real layouts; retain the existing
  // runtime's 64-KiB empty-snapshot admission boundary.
  if (!value.workspaces.length && Buffer.byteLength(raw) <= 65536) result.startup = 'no_saved_workspaces'
  let panes = 0, pi = 0
  for (const workspace of value.workspaces) {
    if (!object(workspace) || !Array.isArray(workspace.tabs)) return result
    for (const tab of workspace.tabs) {
      if (!object(tab) || !object(tab.panes)) return result
      for (const pane of Object.values(tab.panes)) {
        if (!object(pane)) return result
        panes++; if (piReference(pane.agent_session)) pi++
      }
    }
  }
  result.paneCount = panes; result.piSessionReferences = pi
  return result
}

async function nativeQuery(file, args, env) {
  if (process.platform !== 'win32' || process.arch !== 'x64') fail('native_query_unavailable')
  try {
    const result = await promisify(execFile)(file, args, { env, windowsHide: true, shell: false, encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 ** 2 })
    return { status: 0, stdout: result.stdout }
  } catch (error) {
    if (['EACCES', 'EPERM'].includes(error.code)) fail('permission_denied')
    if (error.killed || error.signal || !Number.isInteger(error.code)) fail('query_outcome_unknown')
    return { status: error.code, stdout: error.stdout }
  }
}

export async function observeExistingSession(inspected, run = nativeQuery) {
  const { config } = inspected, p = programPaths(config), env = managedEnvironment(config)
  const result = { state: 'unverified', ownership: 'not_acquired', stopAuthority: false, workspaceCount: null,
    tabCount: null, paneCount: null, agentCount: null, piSessionReferences: null, businessTasks: 'not_inferred' }
  async function query(args) {
    inspected.assertUnchanged()
    const response = await run(p.herdr, ['--session', config.session, ...args], env)
    inspected.assertUnchanged()
    if (!response || response.status !== 0) fail('query_unavailable')
    try { return JSON.parse(response.stdout) } catch { fail('query_response_invalid') }
  }
  try {
    const status = await query(['status', 'server', '--json'])
    if (!object(status) || status.session !== config.session) fail('query_protocol_unverified')
    if (status?.running === false) { result.state = 'not_running'; return result }
    if (status.running !== true || typeof status.version !== 'string' || !status.version || !Number.isSafeInteger(status.protocol) || status.protocol < 0 || status.compatible !== true || status.endpoint_compatible !== true) fail('query_protocol_unverified')
    // Marker consistency is only a read observation, never a stop capability.
    const marker = path.join(config.herdrConfigRoot, 'sessions', config.session, 'herdr.sock')
    const generation = await boundedRead(marker, 80)
    if (!/^\d+:\d+$/.test(generation)) fail('query_generation_unverified')
    const response = await query(['api', 'snapshot']), snapshot = response?.result?.snapshot
    if (response?.id !== 'cli:api:snapshot' || response?.result?.type !== 'session_snapshot' || snapshot?.version !== status.version || snapshot?.protocol !== status.protocol || !['workspaces', 'tabs', 'panes', 'agents'].every(k => Array.isArray(snapshot[k]) && snapshot[k].length <= 10000 && snapshot[k].every(object))) fail('query_response_invalid')
    if (await boundedRead(marker, 80) !== generation) fail('query_generation_changed')
    result.state = 'observed_unowned'
    result.workspaceCount = snapshot.workspaces.length; result.tabCount = snapshot.tabs.length
    result.paneCount = snapshot.panes.length; result.agentCount = snapshot.agents.length
    result.piSessionReferences = snapshot.panes.filter(pane => piReference(pane.agent_session)).length
  } catch (error) {
    result.state = error.code === 'permission_denied' || ['EACCES', 'EPERM'].includes(error.code) ? 'permission_denied' : 'query_unavailable'
    result.reason = ['query_unavailable', 'query_response_invalid', 'query_protocol_unverified', 'query_generation_unverified', 'query_generation_changed', 'query_outcome_unknown', 'installation_changed_restart_required'].includes(error.code) ? error.code : reason(error)
  }
  return result
}
