// Official Pi loads this package resource from the selected profile's native
// settings.extensions, including the existing unmodified `--mode json` launch.
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import nativeExtension from './pi-magpie-native-extension.mjs'
import { nativeCatalogBindingFromSettings } from './pi-native-catalog-profile.mjs'

export function activateNativeCatalog(pi, binding) {
  let previous
  const onState = state => {
    if (state.result === previous) return
    previous = state.result
    // Fixed statuses only. Keep JSON task stdout clean and never print errors,
    // profile contents, endpoint URLs, provider responses or authentication.
    process.stderr.write(`windows_endpoint_pi_catalog: ${state.result}\n`)
  }
  nativeExtension(pi,{providerId:binding.providerId,profileDir:binding.profileDir,intervalMs:binding.intervalMs,onState})
}

export default async function (pi) {
  try {
    const profile = process.env.PI_CODING_AGENT_DIR
    if (!profile || !path.isAbsolute(profile)) throw Error('catalog_selected_profile_required')
    const settings = JSON.parse((await readFile(path.join(profile,'settings.json'),'utf8')).replace(/^\uFEFF/,''))
    const binding = nativeCatalogBindingFromSettings(settings,{resource:fileURLToPath(import.meta.url)})
    if (!binding) throw Error('catalog_native_binding_required')
    activateNativeCatalog(pi,binding)
  } catch { process.stderr.write('windows_endpoint_pi_catalog: configuration_required\n') }
}
