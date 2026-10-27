# Native Pi catalog: completed local product wiring

The local product chain is wired, rather than left as an owner-only interface.
WindowsEndpoint.ps1 Run still invokes `deploy run --root ProductRoot`. That route
now verifies the selected candidate, preflights the already selected profile,
and passes a native binding to the selected actual foreground host. The host
rechecks that binding before starting components. It does not change identity,
profile, user extensions, model choice, task history or official Pi core.

## Explicit stopped preparation and normal startup

The new package carries the native entry and every local import, including
pi-native-catalog-transaction.mjs. candidate.json advertises native_pi_catalog
with bindingVersion=1, profileReference=extensions/windows-endpoint-magpie.js,
Pi version 1.4.0 and legacyFileSync=false. A resource-only older candidate cannot
silently claim the new preparation/host binding contract.

The unique writer may later use this EXISTING endpoint CLI, at its approved
stopped boundary, with the actual approved provider ID (not a model ID):

```text
node endpoint.mjs deploy prepare-pi-catalog --root PRODUCT_ROOT --request-id UUID --provider EXISTING_APPROVED_PROVIDER [--interval-ms 60000]
node endpoint.mjs deploy run --root PRODUCT_ROOT
```

These are interfaces, not authorization to execute them onsite now. No onsite
profile preparation, deployment, loading, push, PR or CI trigger occurred here.
The optional existing run flag --pi-catalog-provider now only validates a
prepared native binding. It never constructs the former file-writer binding.
An explicit run request with no prepared reference fails with a fixed error.
Normal Run needs no catalog flag after preparation. A profile with no opt-in
continues in disabled mode; no configuration is created by run.

Preparation obtains the existing deployment/host/component leases, requires a
stopped lifecycle without attention, uses the original work/history check,
verifies the selected package and freezes selection/config/lifecycle/attempt
and profile-input snapshots. Running/unknown work is deferred or rejected; no
process is stopped, restarted, resumed or replayed to make this check pass.
The same guards reject a pending profile-switch transaction as in 49be5cc.

It publishes one NEW nonsecret loader in the original profile's native
`extensions/windows-endpoint-magpie.js`. Official Pi auto-discovers this .js
resource in its existing agent directory, including the producer's unchanged
`pi --mode json --provider ... --model ... --session-dir ...` argv. The loader
contains only the approved provider ID, interval, original absolute profile and
verified package entry URI. Existing native authentication is read at runtime;
there is no credential in the loader or transaction journal.

The producer's original PI_CODING_AGENT_DIR remains authoritative. The loader
also checks that the process uses its bound profile before any directory GET.
Original settings.json, models.json, auth.json, ACLs and extension files are
never replaced or rewritten. The older settings.extensions/namespaced binding
from a5ad978 remains readable by startup; preparation refuses to add a second
loader beside it. The earlier pure settings planner remains available for
review but is not the ordinary product writer path.

Root index.ts/index.js/package.json entries can change Pi's smart discovery;
user negative filesystem resource filters can disable auto-discovery. These
cases fail explicitly and remain untouched instead of falsely claiming a loaded
reference. A different existing same-name loader or stale package binding is
also refused. The product does not overwrite or remove an old/user resource.

## Atomic boundary, interruptions and ACL limits

Publication uses an exclusively created ignored temporary file, fsync, and
same-directory hard-link CREATE to the previously absent final name. It never
uses ReplaceFile, rename-over-existing, chmod/chown or an ACL command. Thus
ordinary inherited ACLs on existing Pi settings do not enter the former
File.Replace inheritance bug at all. No existing destination's permissions are
changed. A filesystem that cannot publish this atomic new link fails explicitly
with catalog_native_atomic_publication_unavailable or a permission error; there
is no weaker replacement or ACL fallback. Real Windows NTFS publication remains
to be validated by the unique Windows writer in a new isolated fixture.

The pinned Node 24.14.0 Windows backend implements fs.link via
CreateHardLinkW(newPath, existingPath, NULL), in deps/uv/src/win/fs.c:2698.
Microsoft documents that the link shares its target's security descriptor and
this API does not modify that descriptor. This supports the new-file approach;
it is not evidence of a Windows execution or a TxF/power-loss transaction.

A durable pi-native-catalog-pending.json is saved before publication. Both
selected deploy run and direct host startup refuse it. Staging identity, exact
bytes, current snapshots and the published file are checked; an immutable
receipt records success before clearing the pending marker. No raw settings,
models or auth bytes are copied into this journal. Retrying the SAME explicit
preparation request can finish only its exact original inode/content and
unchanged baseline. It completes configuration, never execution. Different
requests or concurrent edits remain blocked and preserve all artifacts; there
is no automatic restoration over later changes. A crash before the pending
journal is saved may leave only an ignored nonsecret .tmp file; a later request
will not adopt or delete that unjournaled stage.

This intentionally implements safe initial preparation, not arbitrary in-place
migration of an existing bound resource. An update/rollback to another package
path with a stale binding fails closed and needs an explicit future resource
migration at a stopped boundary. No existing inherited ACL is converted to
protected, and the old unsupported_acl restriction is not used to claim success.

The old file-writing catalog lifecycle is absent from host imports/start/tick/
stop. Nonnull piCatalogBinding injections are explicitly rejected by host and
selected deployment. The old pure historical module/tests remain only for
retained evidence; they are not a concurrently running product synchronizer.
Host status reports only unverified for native discovery because a host is not
a snapshot of the actual Pi registry. Fixed native stderr statuses and the
extension's in-process status command provide diagnostics without credentials.

## Actual local evidence and remaining acceptance

```sh
node --test pi-native-catalog-profile.test.mjs pi-native-catalog-transaction.test.mjs
PI_NATIVE_FIXTURE_PACKAGE=/path/to/existing/official/1.4.0/package node --test official-smoke/pi-native-selected-deploy.test.mjs
python packaging/test_candidate.py CandidateTests.test_reproducible_archive_runs_existing_entry_without_checkout_or_npm -v
```

The new actual-process integration invokes the normal endpoint deploy CLI for
preparation and run, verifies/stages a selected inert review candidate, and
executes the actual foreground host. Only the external Herdr start boundary is
a source-only fixture wrapper; it is absent from production packaging. It starts
the EXISTING official Pi 1.4.0 CLI at the original configuration's package/node
paths and PI_CODING_AGENT_DIR, in JSON mode with no extra extension/provider-
refresh flags and no SDK runtime instance. The existing user extension observes
that very Pi's PID/session/registry through its command, with no LLM turn.
A loopback directory adds a complete synthetic model; current model and override
remain unchanged. Normal host stop releases that command, normal Pi shutdown
aborts a held directory GET, and no later request occurs. Settings/models/auth
bytes and settings inode/mode/timestamps stay exact. A second normal launch with
unknown durable work/attention starts no Pi and changes no unknown receipt or
lifecycle bytes. Any nondirectory HTTP request would count as inference: zero.

Directed transaction tests cover no-change idempotence, existing user reference,
three interruption points and explicit same-request completion, concurrent edits,
pending startup guards, live lease/unknown work refusal, unsupported publication,
and smart-discovery/filter conflicts. Source tests also exercise old no-opt-in
profiles and the ordinary host/deployment behavior. The first new transaction
run exposed a legitimately absent fresh lifecycle.json; the implementation now
freezes and compares that absence instead of creating a fabricated state file.
Final focused run: 87/87 passed, zero skipped, including the actual selected
deploy/official-Pi test; synthetic packaging inventory test 1/1 passed. The old
catalog/ACL matrix was not repeated. No production archive was rebuilt.

The original local branch was not based on the full 49be5cc owner tree. Its host
and selected-deploy sources were read as a reference, including pending-profile
guards and the old file-sync CLI route. This local independent diff changes the
corresponding functions and does not overwrite the owner's branch. Unified
composition must retain all of 49be5cc's profile-switch actions/transactions when
merging the CLI parser and runSelectedProgram edits. A uniquely named catalog
digest avoids colliding with the owner's existing sha256 helper.

This is real Linux endpoint CLI plus official Pi evidence, with the explicit
Herdr boundary fixture above. Actual WindowsEndpoint.ps1/Windows Herdr EXE,
Windows filesystem/ACL observation, onsite loading and real task execution are
not accepted by this test. No real Magpie query or paid model call was made.
Purely in-memory learned models still disappear on an offline restart.

Official API/source contracts:

- https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/extensions/loader.ts
- https://github.com/nodejs/node/blob/v24.14.0/deps/uv/src/win/fs.c#L2698
- https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createhardlinkw
- https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/core/package-manager.ts
- https://github.com/earendil-works/pi/blob/4a080252f06caf63a525d7873c5d94d3c23887e0/packages/coding-agent/src/modes/print-mode.ts
- https://github.com/particleflow/windows-endpoint/blob/49be5cc/program-deployment.mjs#L550
- https://github.com/particleflow/Memoh/blob/9601ac062a3b65477db8db76bcaa521265ba7ee2/internal/agenvo/pi_batch.go#L149
