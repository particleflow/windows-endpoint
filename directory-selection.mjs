// Explicit local foreground UI only. Selection grants no remote authority and
// never changes a binding, mounts a share, creates a directory or moves data.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export class DirectorySelectionError extends Error {
  constructor(code) { super(code); this.code = code }
}
const demand = (ok, code) => { if (!ok) throw new DirectorySelectionError(code) }

async function nativeChoose(initialPath) {
  demand(process.platform === 'win32', 'directory_picker_windows_required')
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== 'PSMODULEPATH'))
  const args = ['-NoLogo', '-NoProfile', '-STA', '-File', fileURLToPath(new URL('./directory-selection.ps1', import.meta.url))]
  if (initialPath) args.push('-InitialPath', initialPath)
  return new Promise((resolve, reject) => {
    // No arbitrary deadline on a person choosing a folder. Ctrl+C cancels only
    // this owned dialog process; no Agent/component or server is involved.
    const child = execFile(powershell, args, { env, shell: false, windowsHide: false, encoding: 'utf8', maxBuffer: 16384 }, (error, stdout) => {
      process.off('SIGINT', cancel)
      if (error) { reject(new DirectorySelectionError('directory_picker_unavailable')); return }
      try { resolve(JSON.parse(stdout)) } catch { reject(new DirectorySelectionError('directory_picker_response_invalid')) }
    })
    const cancel = () => child.kill()
    process.once('SIGINT', cancel)
  })
}

// choose/stat injection is source-test support, never a command/config field.
export async function pickDirectory({ initialPath = null } = {}, { choose = nativeChoose, stat = fs.stat } = {}) {
  demand(initialPath === null || typeof initialPath === 'string' && !/[\x00-\x1f]/.test(initialPath), 'directory_picker_initial_path_invalid')
  const response = await choose(initialPath)
  demand(response && typeof response === 'object' && !Array.isArray(response), 'directory_picker_response_invalid')
  if (response.state === 'cancelled') {
    demand(Object.keys(response).join(',') === 'state', 'directory_picker_response_invalid')
    return { state: 'cancelled', configurationChanged: false }
  }
  demand(response.state === 'selected' && Object.keys(response).sort().join(',') === 'path,state' &&
    typeof response.path === 'string' && response.path.length <= 4096 && !/[\x00-\x1f]/.test(response.path) &&
    path.isAbsolute(response.path), 'directory_picker_response_invalid')
  try { demand((await stat(response.path)).isDirectory(), 'directory_picker_not_directory') }
  catch (error) { if (error instanceof DirectorySelectionError) throw error; throw new DirectorySelectionError('directory_picker_directory_unavailable') }
  return { state: 'selected', path: response.path, configurationChanged: false }
}
