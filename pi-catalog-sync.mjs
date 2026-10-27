// Pure model projection shared by the native Pi extension. No profile writes.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const positive = value => Number.isSafeInteger(value) && value > 0

export function mergePiCatalog(document, providerId, discovered) {
  if (!object(document) || !object(document.providers) || typeof providerId !== 'string' || !providerId || !Array.isArray(discovered)) throw Error('invalid_catalog_input')
  const provider = document.providers[providerId]
  if (!object(provider) || !Array.isArray(provider.models)) throw Error('provider_not_configured')
  const existing = new Set()
  for (const model of provider.models) {
    if (!object(model) || typeof model.id !== 'string' || !model.id || existing.has(model.id)) throw Error('invalid_existing_models')
    existing.add(model.id)
  }
  const seen = new Set(), additions = []
  for (const model of discovered) {
    if (!object(model) || typeof model.id !== 'string' || !model.id || seen.has(model.id)) throw Error('invalid_discovered_models')
    seen.add(model.id)
    if (existing.has(model.id)) continue
    // Unknown capabilities are not invented. An incomplete entry is deferred.
    if (!positive(model.contextWindow) || !positive(model.maxTokens) || typeof model.reasoning !== 'boolean' || !Array.isArray(model.input) || !model.input.includes('text') || model.input.some(i => i !== 'text' && i !== 'image')) continue
    additions.push({ id: model.id, contextWindow: model.contextWindow, maxTokens: model.maxTokens, reasoning: model.reasoning, input: [...new Set(model.input)] })
  }
  if (!additions.length) return document
  return { ...document, providers: { ...document.providers, [providerId]: { ...provider, models: [...provider.models, ...additions] } } }
}
