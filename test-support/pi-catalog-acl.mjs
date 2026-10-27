import assert from 'node:assert/strict'
import path from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {fileURLToPath} from 'node:url'

export async function readCatalogFixtureAcl(file) {
  const executable=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe')
  const result=await promisify(execFile)(executable,
    ['-NoLogo','-NoProfile','-NonInteractive','-File',fileURLToPath(new URL('./pi-catalog-acl.ps1',import.meta.url)),file],
    aclChildProcessOptions(executable))
  return JSON.parse(result.stdout.replace(/^\uFEFF/,''))
}

export function aclChildProcessOptions(executable, inherited = process.env) {
  const env = { ...inherited }
  // Node may sit between pwsh and Windows PowerShell, so pwsh's direct-child
  // compatibility handling cannot be assumed. Never mutate the parent env.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key]
  env.PSModulePath = path.win32.join(path.win32.dirname(executable), 'Modules')
  return { windowsHide: true, timeout: 10000, maxBuffer: 16384, env }
}

// Allow only the Windows inheritance normalization seen in CI: an unchanged
// ordered DACL followed by inherited duplicates. No sorting or SID/mask union:
// either could hide new rights or a changed deny/allow evaluation order.
export function assertCatalogAclPreserved(before, after) {
  for (const field of ['owner', 'group', 'protected', 'nullDacl']) assert.deepEqual(after[field], before[field], `ACL ${field} changed`)
  assert.ok(Array.isArray(before.aces) && Array.isArray(after.aces))
  assert.ok(after.aces.length >= before.aces.length, 'ACL entries removed')
  assert.deepEqual(after.aces.slice(0, before.aces.length), before.aces, 'Original ordered ACL changed')
  for (const ace of after.aces.slice(before.aces.length)) {
    assert.equal(ace.inherited, true, 'Unexpected explicit ACL entry')
    assert.ok(before.aces.some(old => old.binary === ace.binary), 'Inherited ACL entry grants or denies different rights')
  }
}
