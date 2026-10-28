// One isolated Windows fixture run; does not set the invoking shell environment.
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
if (process.platform !== 'win32') throw Error('entry_probe_requires_windows')
const result = spawnSync(process.execPath, [
  '--test', '--test-timeout=30000',
  '--test-name-pattern=installed stable PowerShell entry runs and stops',
  fileURLToPath(new URL('../product-entry.windows.test.mjs', import.meta.url)),
], { env: { ...process.env, WINDOWS_ENDPOINT_ENTRY_PROBE: '1' }, stdio: 'inherit', shell: false, timeout: 40000 })
if (result.error) process.stderr.write(JSON.stringify({fixtureEntryProbe:true,spawnError:result.error.code})+'\n')
process.exit(result.status ?? 1)
