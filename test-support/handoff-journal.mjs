// Real child-process journal killpoints; no production control or stop entry.
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { StateStore, acquireLeases } from '../lifecycle.mjs'

// Keep the IPC fixture barrier alive until the parent terminates this process.
process.on('message', () => {})
const [file, action, killpoint] = process.argv.slice(2)
const { directory, identity, payload } = JSON.parse(await fs.readFile(file, 'utf8'))
const store = new StateStore(directory, identity, { checkpoint: async stage => {
  if (stage === killpoint) {
    process.send({ checkpoint: stage, pid: process.pid })
    await new Promise(() => {})
  }
} })
const release = action === 'record' ? await acquireLeases([`host:${path.resolve(directory, '../..')}`], directory) : null
let result
try {
if (action === 'record') result = await store.recordHandoff(payload)
else if (action === 'query') result = await store.handoffStatus(payload.request_id)
else throw new Error('unknown fixture action')
} finally { if (release) await release() }
process.send({ result, pid: process.pid })
process.disconnect()
