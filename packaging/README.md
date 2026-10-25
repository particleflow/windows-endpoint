# Windows endpoint portable review candidate

This archive contains the executable Node foreground host and the fixed
source-built Windows transfer CLI. It needs no npm install. It is **not a
released installer**: production HTTPS success, physical PC/NAS acceptance,
active-task upgrade and unattended activation/rollback are not qualified.
`candidate.json` identifies exact sources and every file hash; the separate
`candidate-summary.json` identifies the archive hash. Obtain both from the same
reviewed CI run. These inventories are build evidence, not release signatures.

Pi, Herdr, Agenvo, Node and Git are **not copied into this package**. Use their
existing official installations/configuration. The producer's unchanged review
bundle includes two test executables and its fixture script; these are identified
in `candidate.json` and are not new services or user setup steps. The included
AGPL license applies to this endpoint and the referenced Memoh source; upstream
source and dependency declarations are available at the recorded exact commits.

## Existing configuration and foreground entry

Keep the extracted software directory separate from the existing host root and
all component configuration, workspaces, Pi sessions, journals and logs. Extraction
does not configure or activate anything. Never extract over a running installation.
Use the host's existing `config`, `data` and `logs` directories; for a first test,
create an empty host root and its `config` subdirectory only.

Fill `examples/endpoint.references.example.json` with the existing authorized
mapping and save the input outside the software directory. The placeholders
are intentionally invalid until configured; no identity or credential is minted.
Herdr's binary comes only from the matching instance in existing Agenvo
`config.json`. The current host expects exactly one configured instance.
The producer API base must match existing `transfer.json.origin` byte for byte.
Do not change a populated queue's binding or replace its original IDs.

From PowerShell, using the existing absolute Node path:

```powershell
& $NodePath (Join-Path $Candidate 'endpoint.mjs') configure --from $References --root $HostRoot
& $NodePath (Join-Path $Candidate 'endpoint.mjs') doctor --config (Join-Path $HostRoot 'config/endpoint.json')
$Summary = Get-Content -Raw $SummaryFile | ConvertFrom-Json
& $NodePath (Join-Path $Candidate 'endpoint.mjs') deploy install --root $HostRoot --source $Candidate --manifest-sha256 $Summary.manifest_sha256
& $NodePath (Join-Path $Candidate 'endpoint.mjs') deploy run --root $HostRoot
```

`configure` creates the endpoint file exclusively and refuses to overwrite it.
For an existing host, retain its configuration and skip that command.
To opt into components and the finite consumer, use the existing
`config/runtime.json` contract shown in `examples/runtime.example.json`; do not
overwrite an existing request. Without that file, the host only observes.
Doctor deliberately retains `ready:false` and exit 2 while unqualified: inspect
the individual checks. Missing components or grants do not mean the PC is offline.
The optional existing PowerShell bootstrap requires an explicitly trusted Node
hash and changes no execution policy.

The transfer plugin uses the official Herdr plugin registration, and its existing
config/state roots under the selected Herdr roots. For a first isolated setup,
use the official `plugin link <candidate-transfer-directory>` flow under those
same roots, then configure the existing `transfer.json` and device credential
through their existing owner. This archive supplies neither credentials nor
permission grants. Do not replace an active or differently bound plugin.
Control authorization and file-transfer authorization remain separate.

`configure` reports `transferConfiguration.networkPolicyFile` in that same
Herdr private plugin config directory. The new producer reads an optional
`transfer-network.json` there: `{"version":1,"lan_addresses":["192.0.2.10"]}`
(the example IP is documentation only). Existing setup owns this private file;
configure does not write a policy or credential. No policy preserves the old
route behavior. Do not copy LAN addresses into endpoint.json or change the bound
transfer.json. Explicit IPs are tried in order; only TCP connection failure falls
back to the original authority's IPv6. Certificate/auth failures never select
another route. An invalid policy or conflicting proxy fails visibly.

This candidate pins producer a51ddcb1cab8e246ee32fe50762e633f221ef271, plugin
0.10.0. The prior c292 candidate remains a separate checkpoint. Endpoint program
update does not replace/relink an external producer, and cross-producer candidate
switches remain rejected by the existing compatibility profile. Do not present
this new build as an automatic upgrade of a running old plugin.


The host's stdin accepts `{"action":"status"}` and `{"action":"stop"}`.
Status can also be read with `host status --root $HostRoot`. No system service,
scheduled task, listening command port, OS trust change or second Agent is added.
An already-running external Herdr/connector is not adopted or stopped.

## Updates and preserved data

Official owners/package managers update Pi, Herdr and Agenvo. After a controlled
stop, restart rechecks the existing program/configuration references. Herdr's
Windows updater can change its canonical version directory: update only the
existing Agenvo instance's `binary` mapping and complete any native scope approval;
the endpoint has no second Herdr path to maintain. Same-path version changes are
not themselves a new Agenvo scope. No session/history is imported or replayed.

The existing deployment journal now stages and selects **endpoint program only**
under `packages/<manifest hash>`. `deploy run` verifies and runs that selection
in the same foreground process and carries the host lease across launch. It uses
the original configuration and transfer-plugin path; it does not relink or update
the official components or producer. Pending queue bytes are never read as an
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

Running/draining hosts, attention, changed/unknown history, external lock/marker
evidence and existing producer attempt records defer switching. Attempt records
are **unreconciled**, not declared active or deleted: the task owner's handoff is
still needed even if a record may describe a completed task. No global task
admission barrier or active Pi upgrade handoff is claimed. A changed program-state
profile or producer revision refuses compatibility; no data-format migration or
automatic rollback follows a startup failure. Ordinary shell checkpoints and all
original data are retained. Keep old packages; no cleanup or uninstall is added.
The older `2009333` portable candidate remains runnable directly but lacks this
managed-deployment profile and cannot be silently adopted into this journal.

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
