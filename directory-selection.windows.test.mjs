// OS assembly availability is not a concurrent lifecycle contract. Run this
// unchanged bounded probe in the existing Windows-only step after bulk tests.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

assert.equal(process.platform,'win32','actual Windows assembly probe required')
test('official Windows folder dialog assembly is available without opening UI or changing configuration',()=>{
  const powershell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe')
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>key.toUpperCase()!=='PSMODULEPATH'))
  const result=spawnSync(powershell,['-NoLogo','-NoProfile','-STA','-NonInteractive','-File',
    fileURLToPath(new URL('./directory-selection.ps1',import.meta.url)),'-CheckOnly'],{env,encoding:'utf8',timeout:15000,maxBuffer:4096})
  assert.equal(result.status,0,JSON.stringify({probe:'windows_builtin_forms_no_ui',status:result.status,error:result.error?.code||null,signal:result.signal,deadlineMs:15000}))
  assert.deepEqual(JSON.parse(result.stdout),{state:'available',interactiveDesktopRequired:true})
})
