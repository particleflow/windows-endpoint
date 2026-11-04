import * as fs from 'node:fs/promises'
import { fixtureManager } from './deployment-fixture.mjs'

// Isolated CI subprocess only, with inert fixture packages. The parent waits for
// a durable checkpoint, terminates this exact owned child and observes its exit.
const [input, operation, target, source, interruptAt] = process.argv.slice(2)
const settings = JSON.parse(await fs.readFile(input, 'utf8'))
const manager = fixtureManager(settings, { checkpoint: async phase => {
  if (phase === interruptAt) {
    process.send({ checkpoint: phase })
    await new Promise(() => { setInterval(() => {}, 1000) })
  }
} })
try {
  if (operation === 'stage') await manager.stage(source, target)
  else await manager.select(target, operation)
  process.send({ error: 'fixture_checkpoint_not_reached' })
} catch (error) { process.send({ error: error.code || 'fixture_failed' }) }
