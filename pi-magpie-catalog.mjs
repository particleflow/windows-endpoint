import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const positive = n => Number.isSafeInteger(n) && n > 0
const envName = value => typeof value === 'string' ? /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/.exec(value) : null
function referenced(value, env) {
  const m = envName(value), result = m && env[m[1] || m[2]]
  if (typeof result !== 'string' || !result || /[\r\n]/.test(result)) throw Error('catalog_auth_reference_unavailable')
  return result
}

// SDK export verified against Pi 1.4.0. This one-off reader does not instantiate
// a credential store, write/refresh OAuth, execute a command or copy auth.json.
export async function resolvePiCatalogAuth({ config, providerId, provider, env = process.env, loadSDK }) {
  const sdk = loadSDK ? await loadSDK() : await import(pathToFileURL(createRequire(path.join(config.programs.piPackage, 'package.json')).resolve('@earendil-works/pi-coding-agent')).href)
  if (typeof sdk.readStoredCredential !== 'function') throw Error('catalog_native_auth_reader_unavailable')
  const credential = sdk.readStoredCredential(providerId, path.join(config.piConfigDir, 'auth.json'))
  let key
  if (credential) {
    if (credential.type !== 'api_key' || typeof credential.key !== 'string' || !credential.key || credential.key.startsWith('!')) throw Error('catalog_auth_type_unsupported')
    key = envName(credential.key) ? referenced(credential.key, env) : credential.key
  } else key = referenced(provider.apiKey, env)
  const headers = { Authorization: `Bearer ${key}` }
  for (const [name, ref] of Object.entries(provider.headers ?? {})) headers[name] = referenced(ref, env)
  return headers
}

// The deployment supplies no model IDs or inferred capabilities. Both window
// fields must agree when present. Input must be explicitly declared. Output
// modality is not needed for Pi chat metadata; unknown max output is deferred.
export function projectMagpieCatalog(payload) {
  if (!payload || !Array.isArray(payload.data) || payload.has_more === true) throw Error('catalog_response_invalid')
  const models = [], gaps = [], seen = new Set()
  for (const row of payload.data) {
    if (!row || typeof row.id !== 'string' || !row.id || seen.has(row.id)) throw Error('catalog_response_invalid')
    seen.add(row.id)
    const contextWindow = row.context_window ?? row.context_length
    const input = row.modalities?.input
    const missing = []
    if (!positive(contextWindow) || row.context_window !== undefined && row.context_length !== undefined && row.context_window !== row.context_length) missing.push('context')
    if (!positive(row.max_output_tokens)) missing.push('max_output_tokens')
    if (typeof row.reasoning !== 'boolean') missing.push('reasoning')
    if (!Array.isArray(input) || !input.includes('text') || input.some(x => x !== 'text' && x !== 'image')) missing.push('input')
    if (missing.length) { gaps.push({ id: row.id, fields: missing }); continue }
    models.push({ id: row.id, contextWindow, maxTokens: row.max_output_tokens, reasoning: row.reasoning, input })
  }
  return { models, gaps }
}

export function magpieCatalogBinding(providerId, { fetchCatalog = fetch, resolveAuth = resolvePiCatalogAuth } = {}) {
  if (typeof providerId !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(providerId)) throw Error('catalog_provider_invalid')
  return config => {
    const discover = async ({ provider, signal }) => {
      if (!provider || typeof provider.baseUrl !== 'string' || !['openai-completions', 'openai-responses', 'anthropic-messages'].includes(provider.api)) throw Error('catalog_provider_not_configured')
      const url = new URL(provider.baseUrl)
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('catalog_url_invalid')
      url.pathname = url.pathname.replace(/\/$/, '') + (url.pathname.replace(/\/$/, '').endsWith('/v1') ? '/models' : '/v1/models')
      const effective = AbortSignal.any([signal, AbortSignal.timeout(15000)])
      const headers = await resolveAuth({ config, providerId, provider, signal: effective })
      effective.throwIfAborted()
      const response = await fetchCatalog(url, { method: 'GET', headers, signal: effective, redirect: 'error' })
      if (response.status !== 200) { await response.body?.cancel(); throw Error('catalog_unavailable') }
      const chunks = []; let size = 0
      for await (const chunk of response.body) {
        size += chunk.length
        if (size > 1024 * 1024) throw Error('catalog_response_oversized')
        chunks.push(chunk)
      }
      const projection = projectMagpieCatalog(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      discover.gaps = projection.gaps
      return projection.models
    }
    return { providerId, discover }
  }
}
