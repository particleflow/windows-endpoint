// Package/profile wiring only. Reads verified package resources; never writes a
// profile, selects a model, resolves credentials or creates a Pi runtime.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

export const nativeCatalogSettingsKey = 'windowsEndpointPiCatalog'
export const nativeCatalogPackage = Object.freeze({ schema:1, mode:'pi-in-process', piVersion:'1.4.0',
  entry:'pi-magpie-native-profile-entry.mjs', settingsKey:nativeCatalogSettingsKey, legacyFileSync:false })
export const nativeCatalogResources = Object.freeze([
  'pi-magpie-native-profile-entry.mjs', 'pi-magpie-native-extension.mjs',
  'pi-native-catalog-profile.mjs', 'pi-magpie-catalog.mjs', 'pi-catalog-sync.mjs',
])
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v)
const validProvider = v => typeof v === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(v)
const equalPath = (a,b) => process.platform === 'win32' ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b)
function settingsFrom(raw) {
  let settings
  try { settings = JSON.parse(raw.replace(/^\uFEFF/,'')) } catch { throw Error('catalog_settings_invalid') }
  if (!object(settings) || settings.extensions !== undefined && (!Array.isArray(settings.extensions) || settings.extensions.some(v => typeof v !== 'string'))) throw Error('catalog_settings_invalid')
  return settings
}
export function nativeCatalogBindingFromSettings(settings, { resource } = {}) {
  const value = settings[nativeCatalogSettingsKey]
  if (value === undefined) return null
  if (!object(value) || value.schema !== 1 || value.mode !== 'pi-in-process' || !validProvider(value.providerId)
    || !Number.isSafeInteger(value.intervalMs) || value.intervalMs < 1000
    || typeof value.resource !== 'string' || !path.isAbsolute(value.resource)
    || resource && !equalPath(resource,value.resource)) throw Error('catalog_native_binding_invalid')
  return value
}
async function packageEntry(packageRoot, manifest) {
  if (!path.isAbsolute(packageRoot) || !object(manifest) || !object(manifest.native_pi_catalog)
    || Object.entries(nativeCatalogPackage).some(([k,v]) => manifest.native_pi_catalog[k] !== v)
    || !Array.isArray(manifest.files)) throw Error('catalog_native_package_unsupported')
  // Caller verifies the selected candidate/manifest and directory provenance
  // with the existing installation verifier before passing this package root.
  for (const name of nativeCatalogResources) {
    const entries = manifest.files.filter(v => v.path === name)
    if (entries.length !== 1) throw Error('catalog_native_resource_missing')
    let data
    try { data = await readFile(path.join(packageRoot,name)) } catch { throw Error('catalog_native_resource_missing') }
    if (entries[0].size !== data.length || entries[0].sha256 !== createHash('sha256').update(data).digest('hex')) throw Error('catalog_native_resource_changed')
  }
  return path.join(packageRoot,nativeCatalogPackage.entry)
}
function checkProfile(profileDir) {
  if (typeof profileDir !== 'string' || !path.isAbsolute(profileDir)) throw Error('catalog_selected_profile_required')
}
function checkProvider(modelsRaw, providerId) {
  let document
  try { document = JSON.parse(modelsRaw.replace(/^\uFEFF/,'')) } catch { throw Error('catalog_existing_provider_required') }
  const provider = document?.providers?.[providerId]
  if (!validProvider(providerId) || !object(provider) || !Array.isArray(provider.models)) throw Error('catalog_existing_provider_required')
}

// Stage inside the owner's existing STOPPED profile transaction. Return exact
// before/after bytes for its conflict check; do not apply this during `run`.
// Stale/different package bindings require an explicit reviewed owner migration.
export async function prepareNativePiCatalogProfile({ profileDir, packageRoot, manifest, settingsRaw, modelsRaw, providerId, intervalMs=60000 }) {
  checkProfile(profileDir); checkProvider(modelsRaw,providerId)
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1000) throw Error('catalog_interval_invalid')
  const resource = await packageEntry(packageRoot,manifest), settings = settingsFrom(settingsRaw)
  const binding = {schema:1,mode:'pi-in-process',providerId,intervalMs,resource}
  const old = nativeCatalogBindingFromSettings(settings)
  if (old && (old.providerId !== providerId || old.intervalMs !== intervalMs || !equalPath(old.resource,resource))) throw Error('catalog_native_binding_conflict')
  const extensions = settings.extensions ?? []
  for (const ext of extensions) {
    if (['pi-magpie-native-extension.mjs',nativeCatalogPackage.entry].includes(path.basename(ext)) && !equalPath(ext,resource)) throw Error('catalog_native_duplicate_resource')
  }
  const matches = extensions.filter(ext => equalPath(ext,resource))
  if (matches.length > 1) throw Error('catalog_native_duplicate_resource')
  const next = {...settings,extensions:matches.length ? extensions : [...extensions,resource],[nativeCatalogSettingsKey]:binding}
  return {settingsPath:path.join(profileDir,'settings.json'),settingsBefore:settingsRaw,
    settingsAfter:old && matches.length ? settingsRaw : JSON.stringify(next,null,2)+'\n',
    resource,requiresStoppedHost:true,piCatalogBinding:null}
}

// Read-only preflight for deploy run -> runForeground. An unprepared legacy
// profile is compatible when no catalog opt-in was requested; opt-in cannot
// silently fall back to the retired file writer. No configuration is repaired.
export async function nativePiCatalogHostOptions({ config, packageRoot, manifest, requestedProviderId=null }) {
  checkProfile(config.piConfigDir)
  let raw
  try { raw = await readFile(path.join(config.piConfigDir,'settings.json'),'utf8') }
  catch (error) { if (error.code !== 'ENOENT') throw Error('catalog_settings_unreadable'); raw = '{}' }
  const settings = settingsFrom(raw), binding = nativeCatalogBindingFromSettings(settings)
  if (!binding) {
    if (requestedProviderId !== null) throw Error('catalog_native_profile_not_prepared')
    return {piCatalogBinding:null,piCatalogMode:'disabled'}
  }
  if (requestedProviderId !== null && requestedProviderId !== binding.providerId) throw Error('catalog_native_provider_conflict')
  const resource = await packageEntry(packageRoot,manifest)
  nativeCatalogBindingFromSettings(settings,{resource})
  if (settings.extensions?.filter(v => equalPath(v,resource)).length !== 1) throw Error('catalog_native_resource_not_loaded')
  let modelsRaw
  try { modelsRaw = await readFile(path.join(config.piConfigDir,'models.json'),'utf8') } catch { throw Error('catalog_existing_provider_required') }
  checkProvider(modelsRaw,binding.providerId)
  return {piCatalogBinding:null,piCatalogMode:'native',piCatalogProviderId:binding.providerId}
}

// Defense for current legacy lifecycle call sites until the owner removes their
// old CLI binding. Invalid native claims also fail closed, before any GET/write.
export async function assertLegacyPiCatalogAllowed(profileDir, providerId) {
  let raw
  try { raw = await readFile(path.join(profileDir,'settings.json'),'utf8') }
  catch (error) { if (error.code === 'ENOENT') return; throw Error('catalog_native_mode_required') }
  const settings = settingsFrom(raw)
  const claim = settings[nativeCatalogSettingsKey]
  if (claim !== undefined && (!object(claim) || !validProvider(claim.providerId) || claim.providerId === providerId)) throw Error('catalog_native_mode_required')
}
