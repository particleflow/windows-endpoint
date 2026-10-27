import path from 'node:path'
import { createPiCatalogStore } from './pi-catalog-store.mjs'
import { syncPiCatalogOnce } from './pi-catalog-sync.mjs'

// The existing host tick drives refresh. No timer, daemon, credential storage,
// inference call, or profile selection is owned here. Discovery must honor abort
// and return verified Pi metadata for the one approved provider only.
export class PiCatalogLifecycle {
  constructor({ config, providerId, discover, intervalMs = 60000, now = Date.now }) {
    if (!providerId || typeof discover !== 'function' || !Number.isSafeInteger(intervalMs) || intervalMs < 1000) throw Error('invalid_catalog_binding')
    this.store = createPiCatalogStore(path.join(config.piConfigDir, 'models.json'))
    this.providerId = providerId; this.discover = discover
    this.intervalMs = intervalMs; this.now = now
    this.controller = new AbortController(); this.active = null; this.due = 0
    this.lastResult = 'unverified'
  }
  tick() {
    if (this.active) return this.active
    if (this.controller.signal.aborted || this.now() < this.due) return Promise.resolve(this.lastResult)
    this.due = this.now() + this.intervalMs
    this.active = syncPiCatalogOnce({ ...this.store, providerId: this.providerId, discover: this.discover, signal: this.controller.signal })
      .then(result => { this.lastResult = result; return result })
      .finally(() => { this.active = null })
    return this.active
  }
  async stop() {
    this.controller.abort()
    await this.active
  }
}
