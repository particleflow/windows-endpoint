# Agenvo retirement: Windows source and onsite handoff

Audited source: `particleflow/windows-endpoint` PR5,
`1537fe39256bd7f208fe3da2b4323c6bf2a9fc04`. The original worktree was main
`b8bdd409`; this audit used a separate worktree at the exact PR5 head. PR5 is
Draft and has not been installed on the user's PC. No PC or NAS action was made.
This is an open retirement follow-up, not a clean-state certificate.

## Actual residual execution paths

| Residual | Exact source | Disposition and verification needed |
| --- | --- | --- |
| Agenvo binary/package pin | `dependencies.json.components.connector`; `official-smoke/package.json` and lock | Remove after native-only fixture conversion. This is the old connector, not the independent official Herdr installation or Pi. Verify a fresh package inventory contains no old connector dependency. |
| Legacy launch | `endpoint.mjs` `programPaths`, `managedEnvironment`, `launchPlan`, `verifyToolchain`; `runtime.mjs` `validateRuntimeRequest`, `createExplicitRuntime` | Schema 1/2 still select the old connector and expose a run request. These are executable implementations, not historical decoders. Remove both legacy runtime modes and old environment emission; assert old input cannot start/probe a child or emit an executable plan. Retain only a separately justified historical configuration reader. |
| Legacy lifecycle | `lifecycle.mjs` `NativeDriver` legacy branch of `start`, `connectorStatus`, `removeConnectorLock` | Still starts `node <old connector> run`, consumes old status/run.lock and stop ownership. Replace fixtures with native Runtime/Herdr cases before deleting. Verify exact owned-child stop, unknown cleanup, unrelated-peer preservation and no stale old lock recovery. |
| Legacy registration assumptions | `installed.mjs` `validateInstalledConfiguration`, `inspectPrograms`, `installedDoctor`; `host.mjs` old connector diagnostics | Still resolves Herdr from old Agenvo instance mapping and checks old credential metadata. Remove that execution/qualification branch; keep original historical identity bytes in read-only ledgers. Native configuration must reference the official Herdr installation directly. |
| Old default/example | `endpoint.example.json`, `deployment-layout.json.references.agenvoConfigDir`, `packaging/endpoint.references.example.json`, `packaging/build_candidate.py.TEMPLATES` | Withdraw the old example/default and its packaged link together with legacy mode removal. Do not redirect the example to a renamed old mode. Verify every packaged example and link targets schema 3/current commands. |
| Active old CI fixtures | `official-smoke/{verify,lifecycle,host,existing,pi-workload}.mjs`, `.github/workflows/windows-endpoint.yml` | Workflow still launches the old mode. Native actual-process fixture exists separately; retain its coverage and convert useful Herdr/Pi/transfer assertions. A synthetic old-protocol success test is not a reason to ship a legacy executor. |
| Misleading current instructions | `README.md`, `packaging/README.md`, `docs/{delivery,lifecycle,existing-installations-plan,explicit-runtime,foreground-host,owner-handoff-transport}.md` | Still instruct old instance/OAuth/relay usage. Rewrite around actual native execution after source conversion. Remove obsolete setup text, links and copied old status claims. Exact-source logs in provenance remain only to explain an actual failed/passed gate at that commit. |
| Environment pollution guards | `endpoint.mjs` AGENVO_* removal; `official-smoke/transfer.mjs` inherited environment filter | Keep the deny/filter until old inherited variables can no longer influence a child; do not remove a pollution rejection merely to erase a string. No global/user environment variable deletion is authorized by a source filter. |
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

1. Obtain latest result bodies from retirement task
   `01a1725c-c085-7012-8659-5165724070e6` and Windows task
   `01a164cf-7585-769d-a224-c598d66260c8`. This environment exposes no thread-read
   or cross-thread-message tool; Personal Context returned unavailable. GitHub
   source evidence above does not substitute for those result bodies.
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
