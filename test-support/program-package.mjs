import * as fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { catalog, digest } from '../endpoint.mjs'
import { programStateProfile } from '../candidate.mjs'

// Actual endpoint JS, inert producer bytes: this fixture never executes an Agent
// or claims to validate the real producer EXE. The Windows artifact job does that.
export async function programPackage(directory, label = 'a') {
  await fs.mkdir(directory, { recursive: true })
  const source = fileURLToPath(new URL('..', import.meta.url))
  const names = (await fs.readdir(source)).filter(n => n.endsWith('.mjs') && !n.endsWith('.test.mjs'))
  names.push('owned-herdr.ps1', 'deployment-layout.json', 'dependencies.json', 'LICENSE')
  for (const name of names) await fs.copyFile(path.join(source, name), path.join(directory, name))
  await fs.writeFile(path.join(directory, 'README.md'), `INERT REVIEW REVISION ${label}`)
  await fs.mkdir(path.join(directory, 'transfer'))
  await fs.writeFile(path.join(directory, 'transfer/transferqueue.exe'), 'MZ INERT TEST FILE')
  await fs.writeFile(path.join(directory, 'transfer/SHA256SUMS.json'), '{}')
  const files = []
  for (const name of [...names, 'README.md', 'transfer/transferqueue.exe', 'transfer/SHA256SUMS.json']) {
    const file = path.join(directory, name)
    files.push({ path: name, size: (await fs.stat(file)).size, sha256: await digest(file) })
  }
  const manifest = { schema: 1, kind: 'portable-existing-installations-review', platform: 'win32-x64', entry: 'endpoint.mjs',
    qualification: 'not-for-production-release', official_components: 'referenced-existing-installations-not-bundled',
    source_repository: 'particleflow/windows-endpoint', source_commit: '1'.repeat(40), producer_repository: 'particleflow/Memoh',
    producer_commit: catalog.components.transfer.revision, state_profile: programStateProfile, files }
  await fs.writeFile(path.join(directory, 'candidate.json'), JSON.stringify(manifest))
  return { directory, hash: await digest(path.join(directory, 'candidate.json')), manifest }
}
