// CI assembly only: called on a freshly prepared isolated directory, never on
// a user's installation. A digest binds review input; it is not a signature.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { catalog, digest, verifyBundle } from '../endpoint.mjs'
const root = await fs.realpath(process.argv[2])
const manifest = { schema: 1, platform: catalog.platform, qualification: 'review-only', components: {}, files: [] }
for (const [id, c] of Object.entries(catalog.components)) manifest.components[id] = { version: c.version, source: c.source, revision: c.revision, entry: c.entry }
async function walk(directory, prefix = '') {
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    if (item.isSymbolicLink()) throw new Error('CI inventory contains link')
    const name = prefix + item.name, full = path.join(directory, item.name)
    if (item.isDirectory()) await walk(full, name + '/')
    else manifest.files.push({ path: name, size: (await fs.stat(full)).size, sha256: await digest(full) })
  }
}
await walk(root)
await fs.writeFile(path.join(root, 'bundle.json'), JSON.stringify(manifest), { flag: 'wx' })
const hash = await digest(path.join(root, 'bundle.json'))
await verifyBundle(root, hash)
process.stdout.write(JSON.stringify({ inventory: 'verified', manifestSha256: hash, sourceCommit: catalog.components.transfer.revision }) + '\n')
