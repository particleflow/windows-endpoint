# Pi catalog synchronization integration

The NAS Magpie process cannot write a Windows profile with its local SyncCatalog.
This adapter runs in the existing ForegroundHost, driven by its startup and tick;
it creates no service, scheduled task, timer, Pi installation or extension.
The selected endpoint configuration supplies piConfigDir. It does not choose or
migrate a profile, change settings.json, select a model, or change subagents.

The composition owner passes `piCatalogBinding: { providerId, discover }` to
ForegroundHost/runForeground. The provider ID must be the approved existing
Magpie provider. `discover({signal})` uses the existing authentication resolver
and returns only verified Pi metadata (`id`, `contextWindow`, `maxTokens`,
`reasoning`, `input`). It must never log credential material or send inference.
There is deliberately no default provider, URL, key, model ID or capability.
`pi-magpie-catalog.mjs` provides the production binding. Enable explicitly with
`node endpoint.mjs deploy run --root DIR --pi-catalog-provider EXISTING_PROVIDER_ID`.
The stable installed entry accepts the same selection as
`control/WindowsEndpoint.ps1 -Action Run -PiCatalogProvider EXISTING_PROVIDER_ID`.
The selected package must advertise binding protocol 1; an older selected host
is rejected with `deployment_pi_catalog_unsupported` instead of silently ignoring
the binding. Profile-switch pending and selection/lease checks run first.
This authorizes only the existing named provider in the profile already selected
by endpoint configuration; it does not create a provider or change profile paths.
The option alone does not start a missing/unauthorized runtime. Existing callers
of runForeground can inject this same binding without a second process. The
adapter's CLI path is implemented; it has not been enabled or deployed onsite.

Authentication uses Pi 1.4.0's exported `readStoredCredential(providerId, authPath)`
from the existing configured Pi package, resolving the selected api_key credential
in memory only. It never instantiates a mutable credential store. If none exists,
the provider's existing `$NAME`/`${NAME}` apiKey reference is resolved. Headers must
also be environment references. Missing SDK exports, OAuth credentials, commands
and unavailable references fail closed; there is no login or credential refresh.
There is no credential file copy or key in a CLI argument, diagnostic, or new
config file. Embedded credentials in models.json prevent staged replacement.
Source: https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/src/core/auth-storage.ts#L497

Discovery is one GET to the existing baseUrl's /v1/models (or /models when baseUrl
already ends /v1), with redirects refused, a 15-second timeout and 1 MiB response
limit. It never sends a prompt. Projection uses context_window/context_length,
max_output_tokens, reasoning and modalities.input from the upstream modelObject
contract. Differing window values, missing output limits and unknown input types
are deferred, without name-based guesses. Output modality is not a required Pi
chat metadata field. The sanitized onsite 1.1739 fixture has 14 rows: seven full
projections and seven lacking max output. Existing user metadata for deferred IDs
is preserved, not relabeled as upstream proof. discover.gaps retains field gaps
in memory; host status exposes only the deferred count and result code.
Source: https://github.com/yetone/magpie/blob/a47596ea61811ee14ba18c0b0fc03238f7a02bb8/internal/gateway/gateway.go#L962

The host starts a background pass after an authorized runtime has started,
coalesces calls, retries on later existing ticks (60-second minimum spacing),
and cancels on stop, exit, or invalidated host configuration. Discovery receives
the abort signal. Even a late result from a discovery function ignoring abort
cannot publish. Only result codes are retained in memory; raw errors and lists
are not added to host logs. The optional piCatalog status field and bounded host
state-change log expose a terminal conflict without failing ongoing agent work.

Merge adds fully described new entries only. Existing model records, removed
upstream records, user overrides, provider fields and defaults remain intact.
Missing metadata defers a new entry. The file is untouched for equal catalogs,
errors and pre-commit cancellation. Embedded keys and literal headers are refused
before staging, because replacing models.json otherwise copies them to a new
temporary file. Environment references are supported; auth.json is never opened.

The store stages and syncs a same-directory temporary file, rechecks expected
bytes and identity/timestamps, and syncs an exclusive pending transaction marker
containing hashes/identity only. Windows .NET File.Replace atomically displaces
the target into a unique same-directory .previous file and preserves its DACL
on the replacement. ACL merge errors are not ignored. The displaced original
is then checked for both expected bytes and file identity; the installed file
must also contain exactly the staged bytes. Success renames the marker to a
.verified.json record. A replacement error or cancellation retains the marker,
the staged file if still present, and the displaced original if present. No
automatic retry, cleanup, restore or rollback can overwrite another user edit.

This does not exclude arbitrary external editors, and is not strict CAS. An edit
in the last comparison/replacement window is displaced but retained and detected;
it may briefly cease to be the active models.json. Conflict stops this lifecycle
and the pending marker prevents synchronization even after restart. Verified
originals are also retained, since an editor may later write through its old
handle. Every later pass checks each retained original's bytes and identity;
late changes stop synchronization and remain available. At 128 retained records
sync stops for explicit owner reconciliation rather than automatically deleting
old user bytes. Artifacts retain file content privacy and must not be logged or
uploaded. Recovery is a manual owner reconciliation while automatic sync remains
disabled: inspect original/current/staged versions and choose deliberately. There
is no recovery command that writes models.json or clears a marker automatically.

Official Windows semantics: https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew
The ReplaceFile backup captures the displaced original, rather than copying an
earlier snapshot; failure modes may leave different files at their old/new paths.
Pending markers therefore conservatively require reconciliation even when an
error happened before commit. Neither ReplaceFile nor fsync on the marker is a
claim of whole-transaction durability through physical power loss. Backups are
not immutable against a user deleting them; a missing/changed one stops sync.
Linux tests inject a two-rename transition simulator; production replacement
refuses non-Windows execution. Windows CI must verify the actual backup, file
identity and ACL behavior. There is no named lock/flock claim against editors.

Pi 1.4 reads models.json on startup and when /model refreshes. This adapter
does not forcibly replace an in-flight session model or issue a prompt/RPC to it.
Validation requires Windows CI for actual ReplaceFile/ACL behavior; Linux tests
are not Windows runtime evidence. No onsite deployment or package rebuild is
part of this change.
