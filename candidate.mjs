// The portable endpoint program, not an official-component installer.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { catalog, digest, validateDirectory, stageBundle } from './endpoint.mjs'
import { boundedRead } from './session-diagnostics.mjs'

export const programStateProfile = 'endpoint-program-v1'
export const programProfileHash = createHash('sha256').update(JSON.stringify({
  // This format covers our lifecycle/status/continuation/deployment records.
  // No official state is migrated. A producer change needs separate review.
  program: programStateProfile, producer: catalog.components.transfer.revision,
})).digest('hex')
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const demand = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }) }
const required = ['endpoint.mjs', 'host.mjs', 'candidate.mjs', 'program-deployment.mjs', 'deployment.mjs', 'lifecycle.mjs', 'handoff.mjs', 'runtime.mjs', 'installed.mjs', 'dependencies.json', 'LICENSE', 'transfer/transferqueue.exe', 'transfer/SHA256SUMS.json']

export async function verifyCandidate(root, expectedHash) {
  demand(hash(expectedHash), 'candidate_manifest_hash_required')
  await validateDirectory(root)
  const raw = await boundedRead(path.join(root, 'candidate.json'), 262144)
  demand(createHash('sha256').update(raw).digest('hex') === expectedHash, 'candidate_manifest_hash_mismatch')
  let manifest
  try { manifest = JSON.parse(raw) } catch { demand(false, 'candidate_manifest_invalid') }
  demand(manifest.schema === 1 && manifest.kind === 'portable-existing-installations-review' && manifest.platform === 'win32-x64' && manifest.entry === 'endpoint.mjs' &&
    manifest.qualification === 'not-for-production-release' && manifest.official_components === 'referenced-existing-installations-not-bundled' &&
    manifest.source_repository === 'particleflow/windows-endpoint' && /^[a-f0-9]{40}$/.test(manifest.source_commit) &&
    manifest.producer_repository === 'particleflow/Memoh' && manifest.producer_commit === catalog.components.transfer.revision, 'candidate_kind_or_producer_mismatch')
  demand(manifest.state_profile === programStateProfile, 'candidate_state_profile_incompatible')
  demand(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 256, 'candidate_inventory_invalid')
  const seen = new Set(); let totalBytes = 0
  for (const f of manifest.files) {
    demand(f && Object.keys(f).sort().join(',') === 'path,sha256,size' && typeof f.path === 'string' &&
      f.path.length <= 240 && f.path.split('/').every(p => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(p) && !/[.]$/.test(p) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)) &&
      f.path !== 'candidate.json' && !seen.has(f.path.toLowerCase()) && Number.isSafeInteger(f.size) && f.size >= 0 && hash(f.sha256), 'candidate_inventory_invalid')
    // No installed official component tree or mutable data can become payload.
    demand(!f.path.includes('/') || /^(examples|licenses|transfer)\//.test(f.path), 'candidate_payload_scope_invalid')
    seen.add(f.path.toLowerCase()); totalBytes += f.size
    demand(totalBytes <= 4 * 1024 ** 3, 'candidate_package_too_large')
  }
  demand(required.every(name => seen.has(name.toLowerCase())), 'candidate_component_missing')
  const actual = []
  async function walk(directory, prefix = '') {
    await validateDirectory(directory)
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = prefix + entry.name, file = path.join(directory, entry.name)
      demand(!entry.isSymbolicLink(), 'candidate_link_rejected')
      if (entry.isDirectory()) await walk(file, name + '/')
      else { const s = await fs.lstat(file); demand(s.isFile() && s.nlink === 1, 'candidate_file_unsafe'); actual.push(name) }
    }
  }
  await walk(root)
  demand(JSON.stringify(actual.sort()) === JSON.stringify([...manifest.files.map(f => f.path), 'candidate.json'].sort()), 'candidate_inventory_mismatch')
  for (const f of manifest.files) {
    const file = path.join(root, f.path)
    demand((await fs.stat(file)).size === f.size && await digest(file) === f.sha256, 'candidate_payload_changed')
  }
  const dependencies = JSON.parse(await boundedRead(path.join(root, 'dependencies.json'), 65536))
  demand(dependencies.components?.transfer?.revision === manifest.producer_commit, 'candidate_producer_mismatch')
  return { manifest, totalBytes }
}

export function stageCandidate(source, destination, expectedHash, options = {}) {
  return stageBundle(source, destination, expectedHash, { ...options, verify: verifyCandidate, manifestName: 'candidate.json' })
}
