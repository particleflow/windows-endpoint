# Windows endpoint portable review candidate

This archive contains the executable Node foreground host, the fixed
source-built Memoh Runtime connector and Windows transfer CLI. It needs no npm
install on the PC. It is **not a
released installer**: production HTTPS success, physical PC/NAS acceptance,
active-task upgrade and unattended activation/rollback are not qualified.
`candidate.json` identifies exact sources and every file hash; the separate
`candidate-summary.json` identifies the archive hash. Obtain both from the same
reviewed CI run. These inventories are build evidence, not release signatures.

Pi, Herdr, Node and Git are **not copied into this package**. Use their existing
official installations/configuration. The native connector uses the original
Memoh Runtime CLI logic and its existing enrollment file; the host owns its foreground
process, with no separate Runtime daemon registration. The legacy Agenvo mode
remains available through its existing external installation/configuration.
The endpoint build exports the unchanged official `runCLI` session factory and
`RuntimeSession`. The host sets that session's `workspaceBase` to its already
configured `sourceRoot`; `/data` therefore maps to the project, not the Windows
user home. It does not change `HOME`, enrollment, ACLs, credentials or the
official source. This is a default path mapping, **not a filesystem sandbox**:
official HostFS also supports absolute host paths under the existing authority.
The producer's unchanged review
bundle includes two test executables and its fixture script; these are identified
in `candidate.json` and are not new services or user setup steps. The included
AGPL license applies to this endpoint and the referenced Memoh source; upstream
source and dependency declarations are available at the recorded exact commits.

## Existing configuration and foreground entry

Keep the extracted software directory separate from the existing host root and
all component configuration, workspaces, Pi sessions, journals and logs. Extraction
does not configure or activate anything. Never extract over a running installation.
Use the host's existing `config`, `data` and `logs` directories.

Fill `examples/endpoint.native-runtime.example.json` with the existing authorized
mapping and save the input outside the software directory. The placeholders
are intentionally invalid until configured; no identity or credential is minted.
This schema references the existing official Herdr/Pi installations and Runtime
enrollment file. Omitting `programs.connectorPackage` selects the connector in
the current candidate, so a compatible program update needs no second path edit.
The configured device/runtime mapping remains a declaration until verified by
the NAS; a connected process does not grant task stopping authority.
Schema 3 requires `deviceId` and `runtimeId` to contain the same registered native
Runtime UUID. The proposed native file contract uses that UUID for both
`connection_id` and `device_id`, and `herdr.instance_id` for `instance_id`; its
source implementation has not yet been released or qualified here. This local
declaration check does not clear the file-mapping diagnostic below or migrate
any existing Agenvo identity, credential, HostBinding or queue.
For legacy Agenvo use `examples/endpoint.references.example.json`; its Herdr
binary still comes from the single matching instance in Agenvo `config.json`.
The producer API base must match existing `transfer.json.origin` byte for byte.
Do not change a populated queue's binding or replace its original IDs.

From PowerShell, using the existing absolute Node path:

```powershell
$Summary = Get-Content -Raw $SummaryFile | ConvertFrom-Json
& $NodePath (Join-Path $Candidate 'endpoint.mjs') setup --from $References --root $HostRoot --source $Candidate --manifest-sha256 $Summary.manifest_sha256 --transfer existing-queue
& $NodePath (Join-Path $Candidate 'endpoint.mjs') deploy run --root $HostRoot
```

`setup` composes the existing configuration, runtime request, doctor and program
installation flow. Matching existing configuration is retained byte for byte;
different or malformed configuration is rejected rather than overwritten.
It does not start processes, enroll credentials, install a service or register a
login task. Inspect its prerequisite checks and selected-candidate result before
explicit `deploy run`. `--transfer disabled` is an explicit configuration choice,
not a substitute for the requested file capability. The existing
`config/runtime.json` format is unchanged, as shown in `examples/runtime.example.json`.
Doctor retains `ready:false` while unqualified; missing components or grants do
not mean the PC is offline.
The optional existing PowerShell bootstrap requires an explicitly trusted Node
hash and changes no execution policy.

The transfer plugin uses the official Herdr plugin registration and its existing
config/state roots under the selected Herdr roots. Native host direct CLI calls
may instead select the existing `transferConfigDir` and `transferStateDir` pair
in the same endpoint configuration. Both are required together; omitted fields
retain the original locations. The host fixes that pair for its consumer and
passes the producer's existing `HERDR_PLUGIN_CONFIG_DIR`/`HERDR_PLUGIN_STATE_DIR`.
This does not redirect Herdr plugin actions: official Herdr computes its own
plugin paths. With an explicit directory pair, a registered legacy delivery
plugin must already be disabled through its existing native configuration (for
example `herdr --session SESSION plugin disable memoh.delivery`); an absent
registration is also valid. Preflight observes this setting without changing it,
and rejects a change during the host run. It neither kills a previously issued
plugin command nor claims that disabling grants stop permission. Old actions
retain old roots; task-specific direct CLI calls must
retain their original pair. No global profile pointer, credential copy, queue
migration or principal grant occurs. A missing registration,
configuration or device credential is reported as an unmet prerequisite; the
archive supplies neither credentials nor permission grants. Setup does not
replace an active or differently bound plugin. The finite CLI remains part of
the one endpoint package, not a separately installed service.
Control authorization and file-transfer authorization remain separate.
The original file principal and HostBinding still use the existing Agenvo
connection/device/instance. A native Runtime connection and a passing local
`existing_transfer_reference` check do not establish a native control-to-file
identity mapping. With native mode and a transfer reference, doctor reports
`native_control_file_principal_mapping` as blocked with
`native_file_principal_mapping_unverified`; setup therefore provides no start
action until its prerequisites are resolved. This blocks claiming a new native
file chain is connected, not finite consumption of the original authorized
queue. Its existing credential, IDs, raw binding and references are retained.
Do not replace the file credential with a Runtime enrollment key or rewrite its
selector. No server-side mapping or authentication has been verified here.

`configure` reports `transferConfiguration.networkPolicyFile` in that same
Herdr private plugin config directory. The new producer reads an optional
`transfer-network.json` there: `{"version":1,"lan_addresses":["192.0.2.10"]}`
(the example IP is documentation only). Existing setup owns this private file;
configure does not write a policy or credential. No policy preserves the old
route behavior. Do not copy LAN addresses into endpoint.json or change the bound
transfer.json. Explicit IPs are tried in order; only TCP connection failure falls
back to the original authority's IPv6. Certificate/auth failures never select
another route. An invalid policy or conflicting proxy fails visibly.

This candidate pins producer 0894a6eb8ff69c8796e2da5450fa172d4cd5ef81, plugin
0.10.1. The prior 648/a51/c292 candidates remain separate checkpoints. Endpoint program
update does not replace/relink an external producer, and cross-producer candidate
switches remain rejected by the existing compatibility profile. Do not present
this new build as an automatic upgrade of a running old plugin.

This producer registers downloads as metadata and empty parts, without a total
payload-size/backlog allowance. Existing streaming/worker bounds and actual disk
space checks remain. `waiting` / `capacity` with a persisted `next_due_at` causes
the endpoint to re-read the original queue at that deadline; no new delivery or
network retry policy is created. Capacity without that deadline still pauses.
No budget file or user migration is needed: queue/locator formats, HostBinding
and existing configuration bytes are unchanged. The corrected publication
migration retains old receipts and objects. Older executables still reject
large retained states: cross-producer program update/rollback stays blocked,
never deletes state or switches an active external plugin to make rollback fit.
The fixed-source native tests and packaged EXE metadata check do not replace the
outstanding production-EXE positive TLS gate or PC/NAS acceptance.
The pinned producer derives `feedback_status:not_applicable` only from a durable
download. The consumer accepts that explicit value without inferring delivery;
it retains all lifecycle, exit, association and reference checks. Outbound
missing/foreign context or real feedback write failures still report
`unavailable` and suspend advancement; old missing/empty feedback is unknown.
No context is fabricated and no stored task, queue, configuration or binding is
migrated. The source test dispatcher exercises positive HTTPS/NTFS inbound
restarts with test-only CA injection; this is separate from the packaged EXE's
system-trust gate, which remains unpassed.


The host's stdin accepts `{"action":"status"}` and `{"action":"stop"}`.
Status can also be read with `host status --root $HostRoot`. No system service,
scheduled task, listening command port, OS trust change or second Agent is added.
An already-running external Herdr/connector is not adopted or stopped.

## Updates and preserved data

Official owners/package managers update Pi, Herdr and legacy Agenvo. After a controlled
stop, restart rechecks the existing program/configuration references. Herdr's
Windows updater can change its canonical version directory: update only the
existing Agenvo instance's `binary` mapping and complete any native scope approval
in legacy mode. Native mode references the official installation directly and
rechecks its recognized current selection on a fresh run. Same-path version changes are
not themselves a new Agenvo scope. No session/history is imported or replayed.

The existing deployment journal stages and selects the **endpoint program and
its bundled Runtime connector**
under `packages/<manifest hash>`. `deploy run` verifies and runs that selection
in the same foreground process and carries the host lease across launch. It uses
the original configuration and transfer-plugin path; it does not relink or update
the external Pi/Herdr/Node/Git installations or producer. Pending queue bytes are never read as an
instruction to migrate or replay work.
If the existing plugin registration refers to the original extracted candidate's
`transfer` directory, retain that directory: program installation does not relocate
or rewrite that registration. `doctor` checks the referenced original components.

After an explicit normal stop, `deploy update --root DIR --source NEW-CANDIDATE
--manifest-sha256 HASH` stages/selects a checked compatible endpoint program.
`deploy rollback --root DIR --manifest-sha256 PREVIOUS-HASH` selects only the
recorded previous compatible package. Neither command starts a process. Use
`deploy run --root DIR` for explicit foreground activation; no service or login
startup is registered. `deploy recover --root DIR` reconciles an interrupted
transaction, retaining its selected version, incomplete copies and unknown files.
`deploy status --root DIR` reports the retained inventory.

Running/draining hosts, attention, changed/unknown history and external lock/marker
evidence defer switching. Attempt records are **unreconciled**, not declared active
or deleted. A native endpoint may retain unchanged historical attempts across a
compatible program-only switch when the existing infrastructure-recovery record
binds their exact bytes and the unchanged endpoint/runtime configuration. It also
requires the normal stopped status, verified ordinary session checkpoint, original
process absence and current trusted Windows file ownership through the existing
native recheck. It starts/stops no component, moves no execution and does not
complete or replay an unknown task. Missing/changed recovery evidence remains
`task_handoff_unverified`; an unverified handoff or owner observation cannot enable
this path. No HTTP identity, file credential or local JSON declaration is added
as a stop/upgrade permit. Selection output explicitly says
`taskHistory:preserved_unreconciled`, `businessReplayed:false`, `stopAuthority:false`.
The first configuration/lifecycle/attempt/session evidence is frozen through
both selection checks and fsync-to-rename publication; native absence is rechecked
before each selector publication. Changed evidence rejects publication and pending
transactions require the normal `deploy recover`; originals are retained.
The original task owner's handoff is still required for execution migration,
Agent history or changed/unknown evidence. No global task
admission barrier or active Pi upgrade handoff is claimed. A changed program-state
profile or producer revision refuses compatibility; no data-format migration or
automatic rollback follows a startup failure. Ordinary shell checkpoints and all
original data are retained. Keep old packages; no cleanup or uninstall is added.
Native-mode selection refuses older candidates without
`native_runtime_project_root`, including `41ddb9be`, so rollback cannot silently
restore the previous home mapping. Switching requires the same normal stop and
task reconciliation as other program updates. No existing attempt's WorkDir,
configuration root, receipt or unknown result is rewritten by this correction.
The older `2009333` portable candidate remains runnable directly but lacks this
managed-deployment profile and cannot be silently adopted into this journal.

The CLI preserves deployment JSON result fields but returns exit **2** for
`state:deferred`, as it already does for unavailable prerequisites. Successful
selection remains exit0. Scripts must still check the exact `state`, `reason` and
selected manifest; exit0 alone is not a readiness or release qualification claim.

## Qualification boundary

The CI fixture uses official binaries, synthetic configuration and a local model;
it is not a user PC installation. A successful untrusted-certificate rejection
does not establish positive production TLS. The earlier CI CurrentUser-root
import failed with `UI is not allowed in this operation`; this package neither
retries that import nor changes the production trust source. The overall TLS gate
remains unmet. `transferAutomaticRecovery:false` and `ready:false` remain truthful
product outputs. This archive must not be labelled production-ready.


A read-only `host handoff-status --root DIR --request-id UUID` command queries
unresolved acknowledgement evidence in the existing lifecycle journal. It never
requests stop or retry. The internal recorder has no public mutation/authorization
entry yet; its records remain unverified. A journal containing such a record uses
schema 2 so older programs reject it, and new host starts/program switches defer.
Do not downgrade/delete this evidence to force an update.
