// Loaded by the existing official Pi process through its extension mechanism.
// No filesystem write, models store, second SDK runtime, or model selection.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { readStoredCredential } from '@earendil-works/pi-coding-agent'
import { magpieCatalogBinding, resolvePiCatalogAuth } from './pi-magpie-catalog.mjs'
import { mergePiCatalog } from './pi-catalog-sync.mjs'

export default function (pi, options = {}) {
  pi.registerFlag('magpie-native-provider', { type:'string', default:options.providerId, description:'Refresh this existing Magpie provider in the selected Pi profile, in memory only' })
  pi.registerFlag('magpie-native-interval-ms', { type:'string', default:String(options.intervalMs ?? 60000), description:'In-process catalog refresh interval (minimum 1000 ms)' })
  let controller, requestController, timer, active, context, providerId, profile
  const discovered = new Map()
  let state = { result:'disabled', refreshes:0, deferred:0, learned:0 }
  const report = result => { state.result = result; options.onState?.({...state}) }
  const status = ctx => ({ ...state, pid:process.pid, sessionId:ctx.sessionManager.getSessionId(), model:ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null })
  const notify = ctx => ctx.ui.notify(JSON.stringify({ magpieNativeCatalog:status(ctx) }), 'info')
  async function readProvider() {
    const document = JSON.parse((await readFile(path.join(profile,'models.json'),'utf8')).replace(/^\uFEFF/,''))
    const provider = document.providers?.[providerId]
    if (!provider || !Array.isArray(provider.models)) throw Error('existing_provider_required')
    return provider
  }
  function definitions(provider, ctx) {
    const merged = mergePiCatalog({providers:{[providerId]:provider}},providerId,[...discovered.values()]).providers[providerId].models
    return merged.map(definition => {
      const existing = ctx.modelRegistry.find(providerId,definition.id)
      return { ...existing, ...definition, name:definition.name ?? existing?.name ?? definition.id,
        api:definition.api ?? provider.api, baseUrl:definition.baseUrl ?? provider.baseUrl,
        // Pi 1.4 models.json's documented parser convention for unknown cost;
        // these zeros are NOT upstream price evidence or a free-model claim.
        cost:definition.cost ?? existing?.cost ?? {input:0,output:0,cacheRead:0,cacheWrite:0} }
    })
  }
  async function refresh(ctx) {
    if (active) return active
    if (!controller || controller.signal.aborted || !ctx.isIdle()) return
    requestController = new AbortController()
    active = (async () => {
      const result = await ctx.modelRegistry.refresh({ providers:[providerId], allowNetwork:true, signal:AbortSignal.any([controller.signal,requestController.signal]) })
      state.refreshes++
      report(result.aborted ? 'cancelled' : result.errors.size ? 'unavailable' : 'refreshed')
    })().catch(() => { report(controller.signal.aborted || requestController.signal.aborted ? 'cancelled' : 'unavailable') }).finally(() => { active = null; requestController = null })
    return active
  }
  pi.registerCommand('magpie-native-status', { description:'Show in-memory catalog refresh status', handler:async (_args,ctx) => notify(ctx) })
  pi.registerCommand('magpie-native-refresh', { description:'Refresh only the selected Magpie provider without inference', handler:async (_args,ctx) => { await refresh(ctx); notify(ctx) } })
  pi.registerCommand('magpie-native-cancel', { description:'Cancel the active catalog GET without aborting an agent turn', handler:async (_args,ctx) => { requestController?.abort(); await active; notify(ctx) } })
  pi.on('session_start', async (_event,ctx) => {
    context = ctx
    providerId = pi.getFlag('magpie-native-provider')
    if (!providerId) return
    profile = process.env.PI_CODING_AGENT_DIR
    const intervalMs = Number(pi.getFlag('magpie-native-interval-ms'))
    if (!/^[A-Za-z0-9_.-]{1,100}$/.test(providerId) || options.providerId && options.providerId !== providerId || !profile || !path.isAbsolute(profile) || !Number.isSafeInteger(intervalMs) || intervalMs < 1000) {
      report('configuration_required'); return
    }
    controller = new AbortController()
    try { await readProvider() } catch { report('configuration_required'); return }
    const binding = magpieCatalogBinding(providerId,{resolveAuth:args => resolvePiCatalogAuth({...args,loadSDK:async () => ({readStoredCredential})})})({piConfigDir:profile})
    pi.registerProvider(providerId,{ refreshModels:async refreshContext => {
      const provider = await readProvider()
      if (refreshContext.allowNetwork) {
        const signal = AbortSignal.any([controller.signal,refreshContext.signal])
        const incoming = await binding.discover({provider,signal})
        signal.throwIfAborted()
        for (const model of incoming) discovered.set(model.id,model)
        state.deferred = binding.discover.gaps.length; state.learned = discovered.size
      }
      return definitions(provider,context)
    } })
    await refresh(ctx)
    if (!controller.signal.aborted) { timer = setInterval(() => { void refresh(context) },intervalMs); timer.unref() }
  })
  pi.on('session_shutdown', async () => {
    clearInterval(timer); controller?.abort()
    await active
    discovered.clear()
  })
}
