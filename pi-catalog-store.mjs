import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { validateDirectory } from './endpoint.mjs'

const run = promisify(execFile)
const fingerprint = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs, s.mode, s.uid, s.gid].join(':')
function referenceOnly(value, key = '') {
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) referenceOnly(v, key === 'headers' ? 'header' : k)
  } else if (/^(apiKey|token|password|authorization|header)$/i.test(key) && typeof value === 'string' && !/^\$(?:[A-Za-z_][A-Za-z0-9_]*|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(value)) {
    // Atomic replacement stages bytes. Never stage an embedded credential.
    throw Error('embedded_credential_not_supported')
  }
}
export function createPiCatalogStore(file) {
  let observed = null
  async function snapshot() {
    await validateDirectory(path.dirname(file))
    const st = await fs.lstat(file, { bigint: true })
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1n || st.size > 1024n * 1024n) throw Error('catalog_file_unsafe')
    const raw = await fs.readFile(file, 'utf8')
    if (fingerprint(st) !== fingerprint(await fs.lstat(file, { bigint: true }))) throw Error('catalog_changed')
    return { raw, st }
  }
  return {
    async read({ signal } = {}) {
      signal?.throwIfAborted()
      observed = await snapshot()
      return observed.raw
    },
    async compareAndSwap(expected, next, { signal } = {}) {
      signal?.throwIfAborted()
      if (expected === next) return true
      if (!observed || observed.raw !== expected) return false
      referenceOnly(JSON.parse(next))
      const initial = await snapshot()
      if (initial.raw !== expected || fingerprint(initial.st) !== fingerprint(observed.st)) return false
      const temporary = path.join(path.dirname(file), `.pi-models-${randomUUID()}.tmp`)
      let handle
      try {
        handle = await fs.open(temporary, 'wx', Number(initial.st.mode) & 0o777)
        await handle.writeFile(next); await handle.sync(); await handle.close(); handle = null
        if (process.platform !== 'win32') {
          await fs.chown(temporary, Number(initial.st.uid), Number(initial.st.gid))
          await fs.chmod(temporary, Number(initial.st.mode) & 0o7777)
        }
        signal?.throwIfAborted()
        const current = await snapshot()
        if (current.raw !== expected || fingerprint(current.st) !== fingerprint(initial.st)) return false
        if (process.platform === 'win32') {
          // File.Replace uses Windows ReplaceFile, preserving the destination DACL.
          // No fallback to rename (which would inherit the temporary file ACL).
          try {
            await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
              ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./pi-catalog-replace.ps1', import.meta.url)), file, temporary, createHash('sha256').update(expected).digest('hex')],
              { signal, timeout: 10000, windowsHide: true, maxBuffer: 1024 })
          } catch (error) {
            // A cancelled child may already have committed. Observe before
            // reporting failure; never retry or roll back an uncertain write.
            if ((await snapshot()).raw === next) return true
            if (error.code === 3) return false
            throw error
          }
        } else await fs.rename(temporary, file)
        observed = null
        return true
      } finally {
        await handle?.close()
        await fs.rm(temporary, { force: true })
      }
    },
  }
}
