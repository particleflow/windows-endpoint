# Agenvo retirement: Windows source and onsite handoff

Audited source: `particleflow/windows-endpoint` PR5,
`1537fe39256bd7f208fe3da2b4323c6bf2a9fc04`. The original worktree was main
`b8bdd409`; this audit used a separate worktree at the exact PR5 head. PR5 is
Draft and has not been installed on the user's PC. No PC or NAS action was made.
This is an open retirement follow-up, not a clean-state certificate.

## Actual residual execution paths

| Residual | Exact source | Disposition and verification needed |
| --- | --- | --- |
| Agenvo binary/package pin | `dependencies.json.components.connector`; `official-smoke/package.json` and lock | The active npm root and 31 now-unreachable lock entries are removed offline; every retained version/resolved/integrity pin is unchanged. The catalog connector entry remains only for historical schema-1 bundle-manifest verification/path decoding, not current fixture installation or runtime start. Independent official Herdr/Pi installations are untouched. |
| Legacy launch | `endpoint.mjs` `programPaths`, `managedEnvironment`, `launchPlan`, `verifyToolchain`; `runtime.mjs` `validateRuntimeRequest`, `createExplicitRuntime` | Closed for startup in this delta: schema 1/2 runtime request, launch plan, NativeDriver command/start/recovery and toolchain execution fail with `legacy_execution_retired`; old environment emission and runtime branches are deleted. Legacy program-path/config decoding remains for exact old references; the later diagnostic delta removes standalone legacy qualification. |
| Legacy lifecycle | `lifecycle.mjs` `NativeDriver` legacy branch of `start`, `connectorStatus`, `recoverConnectorLock` (removed) | Closed: delete old connector spawn, status/run.lock reads, forceful stop and official stale-lock command. Native IPC owns connector shutdown; the coordinator now calls `recoverConnector`. Useful lease/exit/error assertions use actual native IPC fixtures. Unknown native cleanup retains the same ownership. |
| Legacy registration assumptions | `installed.mjs` `validateInstalledConfiguration`, `inspectPrograms`, `installedDoctor`; `host.mjs` old connector diagnostics | Closed in the subsequent diagnostic delta: native-only qualification replaces the old instance resolver and CLI probe. Old doctor returns a saved-history-only report; the foreground observer ignores legacy auth/status paths and reads only native enrollment metadata. Original identity bytes remain in the dedicated readers. |
| Old default/example | `endpoint.example.json`, `deployment-layout.json.references.agenvoConfigDir`, `packaging/endpoint.references.example.json`, `packaging/build_candidate.py.TEMPLATES` | The old root and packaged example are deleted; the build no longer ships the schema-2 template. `deployment-layout.json` old locator spelling remains for historical layout/identity reading. The native schema-3 sample is the current setup input. |
| Active old CI fixtures | `official-smoke/{verify,lifecycle,host,existing,pi-workload}.mjs`, `.github/workflows/windows-endpoint.yml` | Workflow no longer launches old lifecycle/reference/transfer-host scenarios. Standalone official Herdr/Pi checks and the Pi workload use native reference programs; the actual native Runtime fixture remains. Replacement native packaged upload/auth/TLS acceptance is an explicit failing gate, alongside the unchanged original positive-TLS gate. The subsequent diagnostic delta deletes legacy host/reference/lifecycle/inventory fixtures and their unused trust helper. The supported supervisor accepts only native Runtime/Pi scenarios; no trust-store operation remains. |
| Misleading current instructions | `README.md`, `packaging/README.md`, `docs/{delivery,lifecycle,existing-installations-plan,explicit-runtime,foreground-host,owner-handoff-transport}.md` | README, packaged instructions, explicit-runtime and lifecycle contracts now describe native-only startup and removed examples. The existing-installation diagnostic guide and TLS failure record are also corrected; The later writer delta rewrites delivery, foreground, transaction and owner-control instructions around native-only entries and deletes the unused relay probe. Other evidence documents still require precise historical-use review; no full documentation-zero claim is made. Exact-source provenance remains only to explain an actual result at its recorded commit. |
| Environment pollution guards | `endpoint.mjs` AGENVO_* removal and current native child environment filters | Keep current child pollution guards; the old artifact-only harness and its local filter are removed together, because that harness has no execution role. Do not remove a pollution rejection merely to erase a string. No global/user environment variable deletion is authorized by a source filter. |
| Historical path locators | `session-continuation.mjs`, old fields in data-layout/compatibility checks | Original saved locator/fingerprint decoding is necessary for old receipt/history access. It must not authorize an old process, switch a target, rewrite fingerprints or replay work. Inspect individual reader call sites before pruning; the name alone is insufficient. |

A case-insensitive tracked-tree `agenvo` scan at the stated PR5 head matched
49 paths across MJS, JSON, PS1, Markdown, Python and YAML. This includes tests,
current legacy execution and provenance. The table identifies concrete remaining
work; neither the number nor the presence of native mode proves zero residue.
The root workflow filename is `windows-endpoint.yml`. The scan excludes `.git`, user
files, installed dependencies and untracked build outputs; it is not onsite evidence.

## Existing files and identity boundary

| Item from parent evidence | Ownership / current disposition | After-change check |
| --- | --- | --- |
| `F:\NAS-Assistant\deploy\.build\agenvo\windows\pi-magpie` | Active official Pi profile, despite the old parent name. Preserve. No secret read/copy/move, recursive removal or directory rename. | Same approved Magpie provider/model/profile reference; existing Pi invocation and original session history remain usable. |
| `F:\NAS-Assistant\deploy\.build\windows-endpoint\host` | Existing HostRoot; journal, selection, acknowledgements and history may reference it. Preserve until original locator migration is reviewed. | Original run/operation IDs and receipt paths still resolve; no added task submission. |
| HostRoot `data\exports` and unknown entries | Active exports and unresolved evidence. Preserve in place. | Original sourceRoot, RootHash, raw HostBinding and unknown state unchanged. |
| Pi/Herdr/Node/Git installations | Independently installed official prerequisites. They are not Agenvo residue. | Same official installation/version selection and native host references, no second installation or uninstaller action. |
| Runtime enrollment and transfer credentials/config/state | Existing separate authentication owners and original bindings. Preserve. | Same Runtime UUID; file principal remains separately authenticated; old queue is not reassociated. |
| Old binaries, tasks, services, PIDs and user/machine variables | Not verified by this cloud audit. No exact removal target is established. | Parent must supply original writer's exact inventory and ownership evidence, then re-read exact targets before reversible disable/removal. Do not infer their absence. |

## Executable offline dry-run

`scripts/plan-agenvo-retirement.mjs` consumes only a **new, operator-authored
non-secret manifest** named `.agenvo-retirement-plan-input.json`. Never pass an
existing private endpoint/Pi/Herdr/enrollment/credential file or reopen a denied
file. The script reads no declared reference, checks no real filesystem path,
starts no child and writes no configuration, data, environment or registry.
Its `executionPermitted:false` and empty eligible-path list are deliberate:
metadata supplied by an operator cannot prove a file or process is unused.

Prepare the input from already-authorized evidence. Its complete strict shape
is the synthetic `manifest()` in `scripts/plan-agenvo-retirement.test.mjs`;
replace the synthetic values with verified **non-secret references only**.
`runtimeId` and `deviceId` are the same original native Runtime UUID. They must
never be replaced with an old Agenvo ID to preserve a cosmetic match. Supply
the actual canonical LocalApplicationData product root; the code invents no
user account, drive or RootHash. Original sourceRoot may be a canonical UNC path.

```text
node scripts/plan-agenvo-retirement.mjs --manifest PATH/.agenvo-retirement-plan-input.json
node --test scripts/plan-agenvo-retirement.test.mjs
```

The plan proposes the persistent product root and Herdr/Pi destinations while
retaining all current references. Changing Pi config_dir or Herdr roots changes
the task target fingerprint; it is not an ordinary program update. A stopped,
known task boundary and the existing owner native-profile CAS must be reviewed
before any new-task configuration switch. Old operations keep old locators.
The planner deliberately cannot perform that switch.

Under the instruction prohibiting credential movement, an entire Pi profile
cannot be relocated while guaranteeing its embedded native auth follows it.
The next migration gate is a supported credential-preserving procedure from the
installed official Pi/Herdr owners, based on non-secret reference metadata. Until
then, the exact active leaf stays at its current path and is not counted as
abandoned Agenvo implementation. Do not create a junction, new provider, copied
credential, new Runtime identity or fabricated migration to erase the old name.
A rollback keeps the original references and program selection; it never
restores old Agenvo/OAuth execution or rewrites saved evidence.

## Sole onsite writer and exact next handoff

Only thread `01a157e3-ab3a-7534-81d6-68d7202e000c` may perform onsite actions,
after the parent explicitly transfers the concrete action and evidence.
This branch neither invokes nor authorizes that writer directly.

1. Parent supplied latest result excerpts from retirement task
   `01a1725c-c085-7012-8659-5165724070e6` and Windows task
   `01a164cf-7585-769d-a224-c598d66260c8`. The parent supplied the Oct25 `0d5e045c` / PR84 same-operation PowerShell recovery scope, plus Windows `1537fe39`, CI40487432492 and candidate12726421524 status. This environment still has no thread-read tool; these excerpts are parent evidence, not a fresh onsite inventory.
2. Supply already-read, redacted exact legacy task/service/binary/PID/environment
   identifiers, plus the allowed non-secret current references. Do not repeat
   rejected project-root Get-ChildItem, elevation, ACL edits or private config
   reads. Unknown exact paths remain pending, not blanket removal candidates.
3. The parent can hand the writer the offline plan invocation only. It needs no
   admin, network, private config read, secret or file move. The writer returns
   the JSON and the original evidence references. No cleanup follows from that
   report alone.
4. For each proven obsolete exact leaf, prepare a separate reversible action:
   exact task/service disable (same original definition retained), or tracked
   source removal in Git. Check exact target state, unrelated official processes,
   native routing and original receipts afterward. Any uncertain outcome is
   read back before another action. Permanent user-data deletion requires exact
   separately confirmed paths and is outside this handoff.
5. Native Bot delegation thread `01a17d56-dfe5-7049-bdee-b8d28a24c03a` needs only
   the retirement fact: old target IDs fail before dispatch; schedules/children
   must retain existing native authority and no fallback. Do not modify that
   thread's authority design.

The general cleanup owner's three removed UI verification files are outside
this audit and untouched. No retirement acceptance is claimed until source
execution residue, the exact onsite inventory and migration checks are closed.

## Startup boundary delta and remaining acceptance

The delta is based on PR5 `1537fe39256bd7f208fe3da2b4323c6bf2a9fc04`, after the
offline-plan commit `4a1dbe7`. No installed endpoint or live file changes occur.
Exact historical readers retained are `validateConfig`/`deploymentReferences`
for original schema/path decoding, `StateStore.load` and `handoffStatus` for
schema-1/2 unknown acknowledgements, `handoffPayload` for original decimal/hash
validation, `session-continuation`'s legacy hash order, and
`readSessionHistory` for saved Herdr/Pi references. Their old field names cannot
be removed or rehashed without stranding evidence. They confer no execution,
stop, cleanup, migration or retry authority.

`agenvo-retirement.test.mjs` tests both legacy schemas, early rejection before
private reference resolution, an actual public-host refusal, no setup/lease
creation, exact original unknown/receipt/Pi-history bytes and decimal revisions,
and a real synthetic native IPC start/stop. Existing native component, journal,
setup, installation and program-deployment suites provide additional regressions.
The Windows native actual-binary fixtures have not been rerun for this delta;
Linux tests cannot establish their result. The new explicit transfer acceptance
gate prevents withdrawing old fixtures from being reported as restored native
upload/TLS coverage. Existing failed TLS trust operations are not retried.

The subsequent diagnostic delta removes legacy installed qualification and its
unused fixture source. Still open: other outdated documents and the exact onsite
binary/startup/service/environment inventory. They are not all retained-history
exceptions. No global zero-residue or actual configuration migration is claimed.

## Writer and candidate follow-up

The increment based on `84710fafa974690bcd0c47c123e6bdb4cb0c4c65` closes the
remaining public configure/schema-1/2 writes, old bundle stage, and no-runtime-file
legacy ProgramDeployment path. Native candidate staging no longer accepts an
injected historical bundle verifier. Generic transaction fixtures now use native
candidates. `deploy status` retains only the bounded saved selection/pending
reader for retired configuration. The no-caller owner-control relay probe and
its dedicated test are removed; its exact historical limits remain documented.

See [writer boundary and differential checks](evidence/agenvo-writer-boundary.md).
This does not remove historical bundle/config/receipt readers, independently
installed official programs, current onsite profiles or unknown work. The exact
onsite binary/startup/service/environment inventory and credential-preserving
Pi/Herdr root migration are still outstanding. Memoh transport implementation
cleanup is a separate repository step; no global zero-residue result is claimed.

The later artifact/document increment removes the obsolete 0.3.0 extractor,
execution harness and lock; they had no execution caller, only syntax CI calls.
The original artifact ID/hash/expiry and CONNECT 403 are retained as refusal
evidence in `transfer-integration-gap.md`, not as a runnable handoff. The original
integration-gap document now specifies native acceptance and no longer proposes
retired MCP/OAuth setup. No archive retrieval, old CLI or trust operation ran.

Checks and exact scope for that increment are in
[artifact boundary evidence](evidence/agenvo-artifact-boundary.md).
