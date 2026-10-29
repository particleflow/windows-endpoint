// The portable endpoint program, not an official-component installer.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { catalog, digest, validateDirectory } from './endpoint.mjs'
import { boundedRead } from './session-diagnostics.mjs'

export const programStateProfile = 'endpoint-program-v1'
export const profileForProducer = producer => createHash('sha256').update(JSON.stringify({
  // This format covers our lifecycle/status/continuation/deployment records.
  // No official state is migrated. A producer change needs separate review.
  program: programStateProfile, producer,
})).digest('hex')
export const programProfileHash = profileForProducer(catalog.components.transfer.revision)
// Exact released reader pairs, only for inspecting already-recorded packages.
// New staging remains pinned; cross-producer selection needs its transaction.
export const historicalProducer = '0894a6eb8ff69c8796e2da5450fa172d4cd5ef81'
export const explicitFilenameProducer = '1b7200d768c1231179725cfa2f85c8c3452882fb'
export const receiptObservationProducer = '0813c7127faa2f6383b723d5f81ec05487c4e446'
const historicalProgram = '57ae131eff3fb675a51b6ea5ee945bfa0b9de837'
const recordedProducerPrograms = new Map([
  [historicalProgram,historicalProducer],
  ['8351b9c433922762f579c1c7b70e755d45b6ed2c',explicitFilenameProducer],
  ['890131d277e8d44301d4b4304f3054b761a4b38b',receiptObservationProducer],
])
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
const demand = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }) }
const required = ['endpoint.mjs', 'host.mjs', 'candidate.mjs', 'program-deployment.mjs', 'deployment.mjs', 'lifecycle.mjs', 'handoff.mjs', 'runtime.mjs', 'installed.mjs', 'dependencies.json', 'LICENSE', 'transfer/transferqueue.exe', 'transfer/SHA256SUMS.json']

export async function verifyCandidate(root, expectedHash) {
  return verifyPackage(root, expectedHash, false)
}
export async function verifyRecordedCandidate(root, record) {
  demand(record && Object.keys(record).sort().join(',') === 'hash,profile' && hash(record.hash) && hash(record.profile), 'candidate_record_invalid')
  const result = await verifyPackage(root, record.hash, true)
  demand(record.profile === profileForProducer(result.manifest.producer_commit), 'candidate_record_profile_mismatch')
  return result
}
async function verifyPackage(root, expectedHash, recorded) {
  demand(hash(expectedHash), 'candidate_manifest_hash_required')
  await validateDirectory(root)
  const raw = await boundedRead(path.join(root, 'candidate.json'), 262144)
  demand(createHash('sha256').update(raw).digest('hex') === expectedHash, 'candidate_manifest_hash_mismatch')
  let manifest
  try { manifest = JSON.parse(raw) } catch { demand(false, 'candidate_manifest_invalid') }
  demand(manifest.schema === 1 && manifest.kind === 'portable-existing-installations-review' && manifest.platform === 'win32-x64' && manifest.entry === 'endpoint.mjs' &&
    manifest.qualification === 'not-for-production-release' && manifest.official_components === 'referenced-existing-installations-not-bundled' &&
    manifest.source_repository === 'particleflow/windows-endpoint' && /^[a-f0-9]{40}$/.test(manifest.source_commit) &&
    manifest.producer_repository === 'particleflow/Memoh' && (manifest.producer_commit === catalog.components.transfer.revision ||
      recorded && recordedProducerPrograms.get(manifest.source_commit) === manifest.producer_commit), 'candidate_kind_or_producer_mismatch')
  demand(manifest.state_profile === programStateProfile, 'candidate_state_profile_incompatible')
  if (manifest.native_transfer_directory_pair !== undefined) demand(manifest.native_transfer_directory_pair === true && manifest.native_runtime, 'candidate_configuration_support_invalid')
  if (manifest.native_runtime_project_root !== undefined) demand(manifest.native_runtime_project_root === true && manifest.native_runtime, 'candidate_configuration_support_invalid')
  if (manifest.native_running_recovery !== undefined) demand(manifest.native_running_recovery === true && manifest.native_runtime, 'candidate_configuration_support_invalid')
  if (manifest.native_stopped_observation_recovery !== undefined) demand(manifest.native_stopped_observation_recovery === true && manifest.native_runtime, 'candidate_configuration_support_invalid')
  if (manifest.native_transfer_direct_cli !== undefined) demand(manifest.native_transfer_direct_cli === true && manifest.native_transfer_directory_pair === true, 'candidate_configuration_support_invalid')
  if (manifest.native_producer_reference !== undefined) demand(manifest.native_producer_reference === 1 && manifest.native_runtime && manifest.stable_installation_entry === 1, 'candidate_configuration_support_invalid')
  if (manifest.native_runtime !== undefined) {
    const n = manifest.native_runtime, pin = catalog.nativeRuntime
    demand(n && Object.keys(n).sort().join(',') === 'commit,entry,provenance,repository,version' && pin &&
      n.repository === 'particleflow/Memoh' && n.commit === pin.revision && n.version === pin.version && n.entry === pin.entry &&
      n.provenance === 'runtime-connector/SHA256SUMS.json', 'candidate_native_runtime_mismatch')
  }
  demand(Array.isArray(manifest.files) && manifest.files.length > 0 && manifest.files.length <= 256, 'candidate_inventory_invalid')
  const seen = new Set(); let totalBytes = 0
  for (const f of manifest.files) {
    demand(f && Object.keys(f).sort().join(',') === 'path,sha256,size' && typeof f.path === 'string' &&
      f.path.length <= 240 && f.path.split('/').every(p => /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(p) && !/[.]$/.test(p) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)) &&
      f.path !== 'candidate.json' && !seen.has(f.path.toLowerCase()) && Number.isSafeInteger(f.size) && f.size >= 0 && hash(f.sha256), 'candidate_inventory_invalid')
    // No installed official component tree or mutable data can become payload.
    demand(!f.path.includes('/') || /^(examples|licenses|transfer)\//.test(f.path) || manifest.native_runtime && /^runtime-connector\//.test(f.path), 'candidate_payload_scope_invalid')
    seen.add(f.path.toLowerCase()); totalBytes += f.size
    demand(totalBytes <= 4 * 1024 ** 3, 'candidate_package_too_large')
  }
  demand(required.every(name => seen.has(name.toLowerCase())), 'candidate_component_missing')
  if(manifest.native_producer_reference===1)demand(['producer-upgrade.mjs','producer-reference.mjs','producer-reference.ps1'].every(name=>seen.has(name)),'candidate_component_missing')
  if (manifest.stable_installation_entry !== undefined) demand(manifest.stable_installation_entry === 1 &&
    seen.has('windowsendpoint.ps1') && seen.has('product-installation.mjs'), 'candidate_installation_entry_missing')
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
  if (manifest.native_runtime) {
    const n = manifest.native_runtime
    demand(dependencies.nativeRuntime?.revision === n.commit && dependencies.nativeRuntime.version === n.version, 'candidate_native_runtime_mismatch')
    for (const name of ['native-connector.mjs', 'native-connector-child.mjs', n.entry, n.provenance, 'runtime-connector/package.json', 'runtime-connector/dist/index.mjs', 'runtime-connector/dist/bridge.proto']) {
      demand(seen.has(name.toLowerCase()), 'candidate_native_runtime_missing')
    }
    const proof = JSON.parse(await boundedRead(path.join(root, n.provenance), 262144))
    if (manifest.native_runtime_project_root) demand(seen.has('runtime-connector/dist/endpoint-host-api.mjs') &&
      proof.endpoint_adapter?.recipe === 'packaging/build_runtime_host.mjs' && hash(proof.endpoint_adapter.sha256), 'candidate_native_project_root_missing')
    demand(proof.schema === 1 && proof.kind === 'memoh-runtime-source-build' && proof.source_repository === n.repository &&
      proof.source_commit === n.commit && proof.package_name === '@memohai/runtime' && proof.package_version === n.version && Array.isArray(proof.files), 'candidate_native_runtime_provenance')
    const payload = manifest.files.filter(f => f.path.startsWith('runtime-connector/') && f.path !== n.provenance)
    demand(proof.files.length === payload.length && new Set(proof.files.map(f => f.path)).size === payload.length, 'candidate_native_runtime_inventory')
    for (const file of proof.files) {
      const expected = payload.find(f => f.path === `runtime-connector/${file.path}`)
      demand(expected && expected.sha256 === file.sha256 && expected.size === file.size, 'candidate_native_runtime_inventory')
    }
    const metadata = JSON.parse(await boundedRead(path.join(root, 'runtime-connector/package.json'), 65536))
    demand(metadata.name === '@memohai/runtime' && metadata.version === n.version, 'candidate_native_runtime_package')
  }
  return { manifest, totalBytes }
}

// Stage only a verified native program candidate. Incomplete copies remain inert;
// no bundle containing retired component installations has a staging adapter.
export async function stageCandidate(source, destination, expectedHash, { checkpoint = async () => {} } = {}) {
  const verify = async (...args) => {
    const result = await verifyCandidate(...args)
    demand(result.manifest.native_runtime, 'legacy_execution_retired')
    return result
  }
  const manifestName = 'candidate.json'
  await validateDirectory(destination)
  demand(![path.relative(source, destination), path.relative(destination, source)].some(r => r === '' || (!path.isAbsolute(r) && r !== '..' && !r.startsWith(`..${path.sep}`))), 'stage_root_overlap')
  const { manifest, totalBytes } = await verify(source, expectedHash)
  const target = path.join(destination, expectedHash)
  try {
    await fs.lstat(target)
    await verify(target, expectedHash)
    return { state: 'already_staged', manifestSha256: expectedHash }
  } catch (e) { if (e.code !== 'ENOENT') throw e }
  const space = await fs.statfs(destination)
  demand(space.bavail * space.bsize >= totalBytes + 64 * 1024 ** 2, 'insufficient_staging_space')
  const pending = path.join(destination, `.pending-${expectedHash}-${randomUUID()}`)
  await fs.mkdir(pending)
  for (const file of [...manifest.files.map(f => f.path), manifestName]) {
    const output = path.join(pending, file)
    await fs.mkdir(path.dirname(output), { recursive: true })
    await fs.copyFile(path.join(source, file), output, 1)
    const handle = await fs.open(output, 'r+')
    try { await handle.sync() } finally { await handle.close() }
    await checkpoint('file_copied')
  }
  await verify(pending, expectedHash)
  try { await fs.rename(pending, target) }
  catch (error) {
    if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error
    await verify(target, expectedHash)
    return { state: 'already_staged', manifestSha256: expectedHash, retainedPending: true }
  }
  return { state: 'staged_review_only', manifestSha256: expectedHash }
}
