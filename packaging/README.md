# Windows endpoint portable review candidate

This archive contains the executable Node foreground host and the fixed
source-built Windows transfer CLI. It needs no npm install. It is **not a
released installer**: production HTTPS success, physical PC/NAS acceptance,
active-task upgrade and automatic activation/rollback are not qualified.
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
& $NodePath (Join-Path $Candidate 'endpoint.mjs') host run --root $HostRoot
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

This candidate has no automatic endpoint upgrade or rollback entry. Public
`activate`, `update` and `rollback` still reject. The internal deployment selector
does not activate this archive. Keep the current software and data intact until
a checked replacement and controlled handoff are available; do not delete old
packages or force-stop active/unknown work to switch versions. Ordinary shell
restoration is verified separately from active Pi task/receipt recovery.

## Qualification boundary

The CI fixture uses official binaries, synthetic configuration and a local model;
it is not a user PC installation. A successful untrusted-certificate rejection
does not establish positive production TLS. The earlier CI CurrentUser-root
import failed with `UI is not allowed in this operation`; this package neither
retries that import nor changes the production trust source. The overall TLS gate
remains unmet. `transferAutomaticRecovery:false` and `ready:false` remain truthful
product outputs. This archive must not be labelled production-ready.
