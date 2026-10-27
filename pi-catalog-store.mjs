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
const hash = raw => createHash('sha256').update(raw).digest('hex')
const identity = st => [st.dev, st.ino].join(':')
const recovery = () => Object.assign(Error('catalog_recovery_required'), { code: 'catalog_recovery_required' })
async function assertNativeAclSupported({ file, signal }) {
  if (process.platform !== 'win32') throw Error('catalog_windows_required')
  try {
    await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./pi-catalog-replace.ps1', import.meta.url)), '-Target', file, '-CheckOnly'],
      { signal, timeout: 10000, windowsHide: true, maxBuffer: 1024 })
  } catch (error) {
    if (error.code === 4) throw Object.assign(Error('catalog_acl_unsupported'), { code: 'catalog_acl_unsupported' })
    throw error
  }
}
export async function replacePiCatalogFile({ file, temporary, backup, signal }) {
  if (process.platform !== 'win32') throw Error('catalog_windows_required')
  await run(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', fileURLToPath(new URL('./pi-catalog-replace.ps1', import.meta.url)), file, temporary, backup],
    { signal, timeout: 10000, windowsHide: true, maxBuffer: 1024 })
}
// replace is injectable only to exercise crash/race transitions in isolated
// fixtures. The production backend is Windows ReplaceFile with a backup.
export function createPiCatalogStore(file, { replace = replacePiCatalogFile } = {}) {
  let observed = null
  const directory = path.dirname(file), marker = path.join(directory, '.pi-models-pending.json')
  async function snapshot(target = file) {
    await validateDirectory(path.dirname(file))
    const st = await fs.lstat(target, { bigint: true })
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1n || st.ino === 0n || st.size > 1024n * 1024n) throw Error('catalog_file_unsafe')
    const raw = await fs.readFile(target, 'utf8')
    if (fingerprint(st) !== fingerprint(await fs.lstat(target, { bigint: true }))) throw Error('catalog_changed')
    return { raw, st }
  }
  async function checkHistory() {
    const names = await fs.readdir(directory)
    if (names.includes(path.basename(marker))) throw recovery()
    const history = names.filter(n => /^\.pi-models-[a-f0-9-]{36}\.verified\.json$/.test(n))
    if (history.length >= 128) throw recovery() // no automatic pruning of user recovery data
    for (const name of history) {
      try {
        const record = JSON.parse((await snapshot(path.join(directory, name))).raw)
        const id = name.slice('.pi-models-'.length, -'.verified.json'.length)
        const old = await snapshot(path.join(directory, `.pi-models-${id}.previous`))
        if (hash(old.raw) !== record.expectedHash || identity(old.st) !== record.oldIdentity) throw recovery()
      } catch { throw recovery() }
    }
  }
  return {
    async read({ signal } = {}) {
      signal?.throwIfAborted()
      await checkHistory()
      observed = await snapshot()
      return observed.raw
    },
    async compareAndSwap(expected, next, { signal } = {}) {
      signal?.throwIfAborted()
      if (expected === next) return true
      if (!observed || observed.raw !== expected) return false
      referenceOnly(JSON.parse(next))
      await checkHistory()
      const initial = await snapshot()
      if (initial.raw !== expected || fingerprint(initial.st) !== fingerprint(observed.st)) return false
      const id = randomUUID(), temporary = path.join(directory, `.pi-models-${id}.tmp`)
      const backup = path.join(directory, `.pi-models-${id}.previous`)
      const verified = path.join(directory, `.pi-models-${id}.verified.json`)
      let handle, prepared = false
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
        if (replace === replacePiCatalogFile) await assertNativeAclSupported({ file, signal })
        const record = { schema: 1, id, expectedHash: hash(expected), nextHash: hash(next), oldIdentity: identity(initial.st) }
        try { handle = await fs.open(marker, 'wx', 0o600) }
        catch (error) { if (error.code === 'EEXIST') throw recovery(); throw error }
        prepared = true
        await handle.writeFile(JSON.stringify(record)); await handle.sync(); await handle.close(); handle = null
        // From this point any error/cancellation preserves every artifact and
        // the durable pending marker. A restart refuses to synchronize it.
        try {
          signal?.throwIfAborted()
          await replace({ file, temporary, backup, expectedHash: record.expectedHash, signal })
          const displaced = await snapshot(backup), installed = await snapshot()
          if (hash(displaced.raw) !== record.expectedHash || identity(displaced.st) !== record.oldIdentity || installed.raw !== next) throw recovery()
          // Keep even verified originals: an editor may still hold and later
          // write their old handle. Later reads verify all retained originals.
          await fs.rename(marker, verified)
        } catch { throw recovery() }
        observed = null
        return true
      } finally {
        await handle?.close()
        if (!prepared) await fs.rm(temporary, { force: true })
      }
    },
  }
}
