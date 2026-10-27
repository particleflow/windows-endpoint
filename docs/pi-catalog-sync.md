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
Binding is absent by default until the actual directory mapping is verified.
Current code does not include that production HTTP mapping or enable sync in CLI.

The host starts a background pass after an authorized runtime has started,
coalesces calls, retries on later existing ticks (60-second minimum spacing),
and cancels on stop, exit, or invalidated host configuration. Discovery receives
the abort signal. Even a late result from a discovery function ignoring abort
cannot publish. Only result codes are retained in memory; raw errors and lists
are not added to host logs. Refresh failure does not fail ongoing agent work.

Merge adds fully described new entries only. Existing model records, removed
upstream records, user overrides, provider fields and defaults remain intact.
Missing metadata defers a new entry. The file is untouched for equal catalogs,
errors and pre-commit cancellation. Embedded keys and literal headers are refused
before staging, because replacing models.json otherwise copies them to a new
temporary file. Environment references are supported; auth.json is never opened.

The store stages and syncs a same-directory temporary file, rechecks expected
bytes and identity/timestamps, then replaces atomically. Windows uses .NET
File.Replace (ReplaceFile), failing on ACL merge errors rather than falling back
to a rename; Unix fixtures preserve uid/gid/mode. It makes no backup and cleans
up temporary files. A cancelled Windows helper is observed before reporting its
result because replacement may already have committed. It never retries or
rolls back an uncertain write.

This is optimistic comparison followed by atomic replacement, not an OS atomic
CAS against arbitrary non-cooperating editors: an edit after the final comparison
and before replacement remains a race. The Windows helper rechecks the expected
hash after process startup, but does not eliminate this last race. Stronger CAS
requires shared writer coordination with the profile owner; do not claim that
all concurrent external edits are excluded. The fixture proves rejection of an
edit observed before commit, not a universal lock on every external editor.

Pi 1.4 reads models.json on startup and when /model refreshes. This adapter
does not forcibly replace an in-flight session model or issue a prompt/RPC to it.
Validation requires Windows CI for actual ReplaceFile/ACL behavior; Linux tests
are not Windows runtime evidence. No onsite deployment or package rebuild is
part of this change.
