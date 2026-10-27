# Native catalog product loading: exact local handoff

The native resource and package inventory are implemented locally. Normal Pi
JSON argv was exercised against the real official 1.4.0 CLI with only the
selected synthetic profile's resource references. The Windows owner's actively
edited `program-deployment.mjs` and `host.mjs` have deliberately not been edited
here. The owner call-site change below is still pending composition. This is not
evidence that the onsite WindowsEndpoint/deploy/Herdr chain has enabled it.

## Exact existing route and remaining owner call site

`WindowsEndpoint.ps1:109` maps Run to `deploy run --root ProductRoot`.
The existing producer command at particleflow/Memoh commit
`9601ac062a3b65477db8db76bcaa521265ba7ee2`,
`internal/agenvo/pi_batch.go:149`, launches
`pi --mode json --provider ... --model ... --session-dir ...` with no extension
flags. Its existing selected profile env is set in `internal/agenvo/agent.go:127`.
These source facts require profile-native loading rather than adding argv to
a separate probe process. No change to that producer or Agent core is required.

The combined Windows `49be5cc` source was read without modifying it:

- `program-deployment.mjs:550–572`: runSelectedProgram holds the host lease,
  verifies the selected package, then passes `piCatalogBinding` to runForeground.
- `program-deployment.mjs:599`: deploy run still builds
  `magpieCatalogBinding(options['--pi-catalog-provider'])`, the old file writer.
- The native extension must replace this route. Merely adding our resources to
  the archive does not change that old CLI behavior or write profile references.

The minimum owner edit, inside those existing guards, is:

```js
// Keep the existing host lease, pending-profile guard and selection checks.
// Carry the CLI provider ID as data, never call the old magpieCatalogBinding.
const packageRoot = path.join(manager.layout.packages, state.current)
const verified = await manager.verify(packageRoot, state.current)
let catalogOptions = { piCatalogBinding: null, piCatalogMode: 'disabled' }
if (verified.manifest.native_pi_catalog) {
  const { nativePiCatalogHostOptions } = await import(
    pathToFileURL(path.join(packageRoot, 'pi-native-catalog-profile.mjs')))
  catalogOptions = await nativePiCatalogHostOptions({
    config: manager.config, packageRoot, manifest: verified.manifest,
    requestedProviderId: requestedPiCatalogProvider, // ID or null; no default ID
  })
} else {
  demand(requestedPiCatalogProvider === null, 'deployment_pi_catalog_unsupported')
}
await manager.unchanged()
return await runForeground({
  root, input, output, inheritedHostLease: release,
  piCatalogBinding: catalogOptions.piCatalogBinding, // always null
})
```

Introduce `requestedPiCatalogProvider = null` as the runSelectedProgram option;
pass the validated existing `--pi-catalog-provider` value or null from deploy run.
Remove its old magpieCatalogBinding construction/import. If keeping the old
programmatic `piCatalogBinding` option for compatibility, explicitly reject any
nonnull value with `deployment_pi_catalog_file_sync_retired`; do not pass it on.
No `WindowsEndpoint.ps1` change is necessary for a prepared profile because
normal Run has no catalog flag and the read-only preflight recognizes the
binding. Keep the owner's actual config/profile forwarding unchanged. There is
no second SDK process, service, task scheduler, credential or subagent edit.

For old packages without native support, no opt-in still launches normally
with null legacy binding; opt-in fails explicitly. An update/rollback involving
an already bound native profile must reconcile its owned resource reference at
the owner's stopped transaction boundary. Do not load an obsolete package path
or mutate the binding during an active run.

## Package and profile contract

`packaging/build_candidate.py` inventories the three new files
pi-magpie-native-profile-entry.mjs, pi-magpie-native-extension.mjs and
pi-native-catalog-profile.mjs, plus the already inventoried projection/merge
dependencies. Its candidate.json advertises:

```json
{"native_pi_catalog":{"schema":1,"mode":"pi-in-process","piVersion":"1.4.0","entry":"pi-magpie-native-profile-entry.mjs","settingsKey":"windowsEndpointPiCatalog","legacyFileSync":false}}
```

No installation archive or release package was rebuilt here. The targeted
packaging test builds inert synthetic producer/runtime fixtures only, verifies
the resource inventory and hashes, and cleans its TemporaryDirectory.

The pure preparation API is:

```js
const plan = await prepareNativePiCatalogProfile({
  profileDir: config.piConfigDir, // existing selected absolute path
  packageRoot, manifest: verified.manifest, // existing verified selected package
  settingsRaw, modelsRaw, // original bytes; never log or copy credentials
  providerId: approvedExistingProviderId, intervalMs: 60000,
})
// plan: {settingsPath, settingsBefore, settingsAfter, resource,
//        requiresStoppedHost:true, piCatalogBinding:null}
```

It performs no writes. The owner applies settingsAfter to the *same* settingsPath
only through its existing stopped profile transaction and original-byte conflict
check, preserving permissions and retaining the original as that transaction
requires. No file-replacement experiment is used for models.json. Never apply
the plan merely because `deploy run` was invoked. Existing fields, packages,
extensions, default provider/model and unrelated custom settings are retained;
the resource is appended once. Repeated unchanged preparation returns original
bytes. BOM input is accepted consistently with official Pi. No auth file, key,
URL or model capability is stored in this new binding.

The same settings.json then contains this explicit block, filled by the API
from the approved ID and verified package path, never from model-name guesses:

```text
windowsEndpointPiCatalog = {
  schema: 1, mode: "pi-in-process", providerId: APPROVED_EXISTING_ID,
  intervalMs: 60000, resource: ABSOLUTE_VERIFIED_PACKAGE_ENTRY
}
extensions = ORIGINAL_EXTENSION_LIST + [ABSOLUTE_VERIFIED_PACKAGE_ENTRY]
```

A different/stale binding, duplicate native resource, incomplete package or
missing configured provider fails without repair. Package upgrades require the
owner's explicit owned-reference migration; this helper intentionally refuses
to guess which older user extension may be removed.

`nativePiCatalogHostOptions({config,packageRoot,manifest,requestedProviderId:null})`
is the startup-only, read-only API. It validates manifest capability, resource
hashes, exact reference and existing provider. It returns native mode with
`piCatalogBinding:null`. An old profile without opt-in returns disabled/null.
An explicit request with no prepared reference fails
`catalog_native_profile_not_prepared`; missing or changed resources have fixed
`catalog_native_*` errors. The owner must still use its existing full candidate
verifier for directory/link provenance before passing manifest/packageRoot.

As defense while callers are being combined, PiCatalogLifecycle now checks the
same native claim before discovery or any store read. The claimed provider
returns terminal `conflict`; no legacy GET/write happens. This is not a hot
handover protocol: an already running old binary or a request started before
preparation is not retroactively disabled. Stop/drain it before the transaction.

The profile entry emits only fixed stderr statuses
`windows_endpoint_pi_catalog: refreshed|unavailable|cancelled|configuration_required`
on a change. Broken binding/provider selection leaves sync disabled and the
ordinary Pi usable; no secret exception/provider response is printed. JSON
task stdout remains the official event stream. Session shutdown uses the
existing native extension cleanup; the profile entry adds no lifecycle service.

## Directed evidence and reproduction

```sh
node --test pi-native-catalog-profile.test.mjs
PI_NATIVE_FIXTURE_PACKAGE=/path/to/existing/official/1.4.0/package node --test official-smoke/pi-native-product-entry.test.mjs
python packaging/test_candidate.py CandidateTests.test_reproducible_archive_runs_existing_entry_without_checkout_or_npm -v
```

Results: profile wiring 3/3, real CLI normal-JSON integration 1/1 zero skips,
targeted synthetic packaging 1/1. The real CLI test runs the profile-prepared
case, broken enablement and legacy compatibility once each. It starts a loopback
catalog, uses synthetic native auth in a fresh temporary profile, preserves an
existing user extension that observes the same PID/session/registry through
its command, and sends only that extension command as stdin. There is no LLM
prompt or SDK runtime probe. No extra --extension/native-provider flag is passed.
The selected model remains selected, new directory ID appears in that very
process, and normal JSON completion aborts a held periodic GET. No requests
continue after exit. Settings/models/auth bytes are exact after runtime, with
UTF-8 BOM models input included. Any nondirectory request is counted as inference;
the required observed count was zero. All temp profiles/packages are removed.

The first packaging command used the module-style unittest path, which collided
with the Python packaging namespace and failed before test collection. The
documented script-style command above passed; no implementation assertion was
relaxed. The earlier directory/ACL matrices were not rerun for this wiring task.

This is Linux real-official-CLI evidence using the production JSON argv/resource
mechanism, not a completed WindowsEndpoint -> selected host -> live Herdr
end-to-end execution. The owner-only call-site combination, stopped profile
application and actual Windows normal launcher validation remain pending.
No Git push/PR change, onsite profile load/write, real Magpie query, ACL change,
service creation or paid turn was performed. Purely in-memory learned models
remain unavailable after an offline restart, exactly as in the prior native test.

Official sources:

- https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#resources
- https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/settings-manager.ts
- https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/modes/print-mode.ts
- https://github.com/particleflow/windows-endpoint/blob/49be5cc/program-deployment.mjs#L550
- https://github.com/particleflow/Memoh/blob/9601ac062a3b65477db8db76bcaa521265ba7ee2/internal/agenvo/pi_batch.go#L149
- https://github.com/particleflow/Memoh/blob/9601ac062a3b65477db8db76bcaa521265ba7ee2/internal/agenvo/agent.go#L127
