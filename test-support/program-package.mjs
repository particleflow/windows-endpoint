import * as fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { catalog, digest } from '../endpoint.mjs'
import { programStateProfile } from '../candidate.mjs'

// Actual endpoint JS, inert producer bytes: this fixture never executes an Agent
// or claims to validate the real producer EXE. The Windows artifact job does that.
export async function programPackage(directory, label = 'a', { native = false } = {}) {
  await fs.mkdir(directory, { recursive: true })
  const source = fileURLToPath(new URL('..', import.meta.url))
  const names = (await fs.readdir(source)).filter(n => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))
  names.push('owned-herdr.ps1', 'host-recovery.ps1', 'deployment-layout.json', 'dependencies.json', 'LICENSE')
  for (const name of names) await fs.copyFile(path.join(source, name), path.join(directory, name))
  await fs.writeFile(path.join(directory, 'README.md'), `INERT REVIEW REVISION ${label}`)
  await fs.mkdir(path.join(directory, 'transfer'))
  await fs.writeFile(path.join(directory, 'transfer/transferqueue.exe'), 'MZ INERT TEST FILE')
  await fs.writeFile(path.join(directory, 'transfer/SHA256SUMS.json'), '{}')
  const extra = []
  if (native) {
    const payload = { 'package.json': JSON.stringify({ name: '@memohai/runtime', version: catalog.nativeRuntime.version }),
      'dist/cli.mjs': '// INERT RUNTIME; NEVER EXECUTE', 'dist/index.mjs': '// INERT RUNTIME',
      'dist/endpoint-host-api.mjs': '// INERT API; NEVER EXECUTE', 'dist/bridge.proto': '// INERT PROTOCOL' }
    const proof = []
    for (const [name, raw] of Object.entries(payload)) {
      const file = path.join(directory, 'runtime-connector', name)
      await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, raw)
      proof.push({ path: name, size: Buffer.byteLength(raw), sha256: await digest(file) }); extra.push('runtime-connector/' + name)
    }
    await fs.writeFile(path.join(directory, 'runtime-connector/SHA256SUMS.json'), JSON.stringify({ schema: 1, kind: 'memoh-runtime-source-build',
      source_repository: 'particleflow/Memoh', source_commit: catalog.nativeRuntime.revision, package_name: '@memohai/runtime', package_version: catalog.nativeRuntime.version,
      endpoint_adapter: { recipe: 'packaging/build_runtime_host.mjs', sha256: 'a'.repeat(64) }, files: proof }))
    extra.push('runtime-connector/SHA256SUMS.json')
  }
  const files = []
  for (const name of [...names, 'README.md', 'transfer/transferqueue.exe', 'transfer/SHA256SUMS.json', ...extra]) {
    const file = path.join(directory, name)
    files.push({ path: name, size: (await fs.stat(file)).size, sha256: await digest(file) })
  }
  const manifest = { schema: 1, kind: 'portable-existing-installations-review', platform: 'win32-x64', entry: 'endpoint.mjs',
    qualification: 'not-for-production-release', official_components: 'referenced-existing-installations-not-bundled',
    source_repository: 'particleflow/windows-endpoint', source_commit: '1'.repeat(40), producer_repository: 'particleflow/Memoh',
    producer_commit: catalog.components.transfer.revision, state_profile: programStateProfile, files }
  if (native) Object.assign(manifest, { native_runtime: { repository: 'particleflow/Memoh', commit: catalog.nativeRuntime.revision,
    version: catalog.nativeRuntime.version, entry: catalog.nativeRuntime.entry, provenance: 'runtime-connector/SHA256SUMS.json' },
    native_runtime_project_root: true, native_running_recovery: true, native_transfer_directory_pair: true, native_transfer_direct_cli: true })
  await fs.writeFile(path.join(directory, 'candidate.json'), JSON.stringify(manifest))
  return { directory, hash: await digest(path.join(directory, 'candidate.json')), manifest }
}
