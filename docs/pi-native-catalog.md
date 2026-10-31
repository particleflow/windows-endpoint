# Native Pi 1.4 in-process Magpie catalog (local implementation)

This path uses the actual existing Pi process's ExtensionAPI/registerProvider
and ctx.modelRegistry.refresh. It never creates a ModelRuntime/SDK session in
the endpoint host. The earlier models.json replacement mechanism and its ACL
guard are not the ordinary-profile solution and must not be enabled alongside
this extension. The ACL diagnostic archive remains historical evidence only.

## Loading contract for the existing launch/profile owner

Normal JSON product invocations now load the package entry through one new
nonsecret reference in the selected profile's native extensions directory.
The explicit stopped `deploy prepare-pi-catalog` transaction publishes that
reference without replacing settings/models/auth or editing ACLs. The actual
selected deploy/foreground host preflight and binding are implemented locally.
No extra task argv, SDK instance or service is used. The older explicit
settings.extensions/namespaced binding remains readable for compatibility.
See [the completed local product wiring](pi-native-catalog-product-wiring.md)
for the exact normal entry, transaction, directed evidence and Windows limits.

The resource is pi-magpie-native-extension.mjs, with its existing local imports
pi-magpie-catalog.mjs and pi-catalog-sync.mjs retained alongside it. Pi's normal
extension loader supplies the installed official SDK export readStoredCredential.
No npm plugin, second Pi installation, external service or new credential is
required for production loading. No writer/profile configuration is changed here.

The launch owner must pass the already selected absolute PI_CODING_AGENT_DIR.
For direct diagnostic loading of the raw extension rather than the product
profile entry, use `--magpie-native-provider EXISTING_APPROVED_ID`. There is no provider ID, URL,
profile path or model ID default. The provider must already exist in that profile's
models.json. A missing/invalid selection leaves it disabled/configuration_required.
`--magpie-native-interval-ms` defaults to 60000 and accepts at least 1000 ms.
Do not copy settings from another profile or replace an existing extension list.

The implementation supplies the future writer's interface; it does not authorize or
perform onsite loading, deployment, package rebuilding, Git push or PR changes.
An already running process lacking this resource cannot be retroactively refreshed
by get_available_models. In --mode json each invocation is separate: later safe
loading applies to future invocations; it is not an external refresh protocol for
an older process. The writer must choose a safe existing reload/launch boundary.

## Same-process behavior

session_start registers only refreshModels for the existing provider and awaits
`ctx.modelRegistry.refresh({providers:[id],allowNetwork:true,signal})`. One unref'd
interval inside that Pi process refreshes while idle, coalescing requests. /model
can also invoke the registered provider callback through Pi's ordinary refresh.
Commands magpie-native-status, magpie-native-refresh and magpie-native-cancel
use official extension command handling, with no inference call. Status contains
only result/counts, process ID, session ID and the selected model reference.
Cancellation aborts the current catalog request, not an agent turn. Shutdown
clears the interval, aborts active I/O and waits for its refresh to settle.

The callback honors allowNetwork=false by returning its current in-memory list,
without a GET. Its scoped callers explicitly request allowNetwork=true; do not
use the provider opt-in when an entirely offline process is required. Discovery
uses only the configured endpoint's models route, 15-second timeout, response
cap and redirect refusal already implemented in pi-magpie-catalog.mjs.

Authentication resolves the selected original profile's native API-key record
through Pi's readStoredCredential export or its existing environment reference;
there is no token copy, login, OAuth refresh or credential persistence owned here.
The official native model runtime remains responsible for its own auth semantics.

Existing configured models win over discoveries, and modelOverrides remain Pi's
topmost config layer. Complete discovered capabilities use the existing strict
projection; missing output limits are deferred. Returned model-level API/baseUrl
come from the same existing provider. No model is selected/switched. Display names
default to the ID. Missing cost uses the exact Pi 1.4 models.json parser convention
of zero accounting rates, NOT proof of an upstream zero price/free model; no
context/output/capability defaults are invented for discovered IDs. A selected
static model retains its configured cost/capabilities and user overrides.

No callback calls publish.persist; no dynamic entry is written to models.json,
models-store.json or another cache. Network failure retains already learned
models in that process. A new process offline has only its static config: learned
IDs are lost unless the user independently configured them. This is intentional
and is not offline durable discovery. The resource contains no file write,
replacement, permission or ACL operation.

Pi itself may still create its own generic empty models-store.json on a READ:
FileModelsStore.read calls FileAuthStorageBackend.withLockAsync, whose
ensureFileExists writes `{}` when absent. Thus no persist means no persisted
catalog data, not that an official Pi process can never create any store file.
The integration fixture requires its exact empty bytes and no provider entries.

## Actual-process evidence and reproduction

The local Linux development fixture uses the official npm Pi 1.4.0 CLI bundle,
not a mocked SDK/runtime. The package version and CLI --version are 1.4.0;
published distribution integrity is
`sha512-Z41LpZ3yYHSC/UUps6Mr39UMFPwH8elhJBG9DY1P7kuzsE5qSK/6eMj2EHzO5evJRQWLbKSqUMw+4nCNtIyiQg==`.
Source API contract is pinned to official release
4a080252f06caf63a525d7873c5d94d3c23887e0. Dependencies were isolated under /tmp,
with no install scripts and an isolated npm cache; the user's Pi was not changed.

Run against an existing isolated official 1.4.0 package directory:

```sh
PI_NATIVE_FIXTURE_PACKAGE=/path/to/existing/pi-package node --test official-smoke/pi-native-catalog.test.mjs
```

The fixture starts a deterministic loopback directory endpoint and the real CLI
in RPC mode. Actual get_available_models calls read snapshots only. After the
endpoint's generation changes, the in-process timer makes new IDs appear under
the same PID and session ID; selected model, user override and messageCount=0
remain unchanged. It verifies API-key resolution from synthetic native auth,
missing metadata deferral, live-process cancellation before exit, EOF shutdown
cancellation, no further requests after shutdown, network-failure retention,
and offline restart losing dynamic IDs. Original models.json bytes/mtime and
auth.json bytes remain exact. The loopback server counts any non-directory
request as inference and requires zero. No real provider/model endpoint is used.

The first actual run failed only because it incorrectly required models-store.json
to be absent. Source inspection established the official empty-store read behavior
above. That failed assertion was replaced with exact `{}` bytes; no dynamic data
may be present. The subsequent run passed. A further real-process run strengthened
the cancellation check to prove abortion while the PID was still alive, then
separately checked cancellation on shutdown; it passed 1/1, zero skips, zero
inference requests. This is Linux JS CLI evidence, not onsite Windows loading,
task execution, or production functional acceptance. No paid turn was executed.

## Official references

- https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/model-registry.ts#L55
- https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/provider-composer.ts#L618
- https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/provider-composer.ts#L242
- https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/models-store.ts
- https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/auth-storage.ts
- https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L488
- https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/docs/settings.md#resources
