# Stopped host and producer transaction

This source contract extends PR6 after `c036d9a706abf463651f03676bf9e916696d4a83`.
It is not evidence that the current Windows host was stopped, upgraded or tested
against the NAS. The c036 artifact is unchanged and does not contain this code.

## Version and ownership boundary

New candidates and new staging retain the exact `dependencies.json` producer
pin `212ae2445fe7a5fbe95479a4f2024069bf83332b`. Read-only verification of an
already-recorded package additionally accepts only these native historical pairs:

| Program source | Producer source | Purpose |
| --- | --- | --- |
| `57ae131eff3fb675a51b6ea5ee945bfa0b9de837` | `0894a6eb8ff69c8796e2da5450fa172d4cd5ef81` | Verify the owned old package, original manifest digest, complete inventory, original producer-derived profile and pinned Runtime provenance. |
| `8351b9c433922762f579c1c7b70e755d45b6ed2c` | `1b7200d768c1231179725cfa2f85c8c3452882fb` | Verify the already-recorded explicit-filename candidate and its original profile before a package-local joint producer upgrade. |
| `890131d277e8d44301d4b4304f3054b761a4b38b` | `0813c7127faa2f6383b723d5f81ec05487c4e446` | Retain the already-recorded receipt-GET candidate/profile for a stopped package-local transaction; never stage or silently select it as the new producer. |
| `b2b0bfc1e963db90af6f6faeb480833c31cb1916` | `d25a7fcc4ad05ae43a5c42d3c7e79cfb99535d91` | Preserve the recorded read-only receipt-export candidate/profile before the same stopped transaction to the v2 endpoint-capable producer. |

This exception does not stage or execute historical programs. It does not accept
arbitrary old revisions, an invented profile or a substituted producer. Legacy
schema 1/2 execution remains retired. Historical task records remain readable.

`pluginRoot` inside `packages/<old-hash>/transfer` is an immutable package
reference. Replacing that EXE in place would invalidate the old manifest, so this
transaction moves only the reference to `packages/<new-hash>/transfer`. The old
package remains byte-verifiable for history and rollback. A configured external
path alone is not ownership evidence. The single recorded external source below
has a read-only reference adapter; it never imports, adopts, writes or deletes
that directory. In-place replacement at an external path is not supported.

The external source must be the exact manifest
`3ccaa153c386d8c4b6cda76c3201d39eebee0c6d747fda296ce7dc441491517a`,
already recorded with its original producer-derived profile in this installation.
Its program source is `41ddb9be845eae09a1ac49a7bde3e8a108e510b0`, producer
`0894a6eb8ff69c8796e2da5450fa172d4cd5ef81`; its EXE is 10254336 bytes,
SHA-256 `e34f3232f483380c4f141ecd0462ff1dc4a5cad26c0c12e1fb8781f5158bee01`.
These are provenance pins, not external-directory ownership grants. The current
host stays 57 until selection of the new target; it never selects or executes 41.
This external witness remains restricted to the original 57 starting point.
An already-recorded 8351 starting point uses its owned package-local producer;
an external producer for 8351 is not silently imported or rebound.

The adapter checks both manifest copies and complete eight-file producer
subtrees at the configured external path and recorded package path. Exact file
hashes, proof, canonical non-overlapping paths, object generations and full
owner/group/DACL descriptor digests must match the preview. Links, missing or
unknown files and unavailable security metadata refuse. Owner SIDs are recorded
and compared, never added to a trust whitelist. The current staging/run verifier
is unchanged: 41 is not made a stageable or executable candidate.

Both versions must use the existing explicit transfer config/state directory
pair. Any old enabled `memoh.delivery` hook refuses the operation. The transaction
never edits the registry, transfer configuration, state directory, credentials,
Pi profile or any independently installed official dependency.

## Preconditions and dry-run

Use the verified **new source entry**, with the original configured Node, for
the following `endpoint.mjs deploy` actions. The old selected 57 entry does not
implement them. These advanced maintenance actions are not aliases of the
existing stable `WindowsEndpoint.ps1 -Action Update` entry.

Stage the strictly pinned candidate through the existing update staging path;
its host-only selection must defer. Do not manually register a package or modify
`deployment.json`. The following actions consume an already-owned staged target:

```text
deploy plan-producer --root <original-host-root> --manifest-sha256 <new-manifest-hash> --request-id <new-uuid> --configuration-sha256 <original-endpoint-json-hash> --lifecycle-sha256 <original-lifecycle-hash> --selection-sha256 <original-deployment-json-hash>
deploy upgrade-producer <the same arguments>
deploy recover-producer --root <original-host-root> --request-id <same-uuid>
deploy rollback-producer --root <original-host-root> --request-id <same-uuid>
```

For the external case, dry-run returns `referenceSha256` and a source summary
including owner SID, descriptor digest, directory generation and EXE identity.
Supply that exact digest as `--reference-sha256 <preview-digest>` on
`upgrade-producer`; it binds fresh observations to the reviewed original plan,
and is not an authorization credential. No external path/policy override or
generic allow-external flag exists. The target must declare
`native_producer_reference: 1` and contain its recovery implementation. Earlier
c036/63a6 packages cannot be used as this external-mode target.

Hashes are of exact original file bytes, not parsed/reserialized JSON. The plan
reports the actual old/new producer paths and identity evidence without writing
configuration or history payloads. It acquires the ordinary maintenance leases;
an owned host defers. It does not stop an endpoint, infer ordinary state from
`agents: 0`, query NAS admission, or advance a queue.

The lifecycle must be confirmed stopped with no attention or handoff. The
original host status/run, installed Node and read-only Windows owner/process
evidence must prove the old host, referenced Pi/Runtime/Herdr and both producer
executables absent. A recovered original observation requires its original
infrastructure recovery configuration/attempt digests and backup. Process
metadata unavailable or a still-running old 57 means refusal, not a stop permit.

An actual saved Herdr v3 ordinary workspace snapshot must exist. Its configuration
and snapshot bytes must match the original checkpoint. Agent-bearing snapshots,
missing snapshots, changed Pi/enrollment/source/state roots or changed origin
refuse. Only `transfer.pluginRoot` may differ. The new checkpoint is calculated
from the real unchanged snapshot and new reference; no old digest is forged.

## Publication, CAS and recovery

The shared host/component/deployment leases span the transaction. An exclusive
pending marker and real `producer_upgrade_pending` lifecycle attention fence
block normal entry and the historical raw launcher during partial publication.
The existing selection journal records a pending switch. The transaction then
publishes configuration, the derived continuation and host selection. A durable
`upgrade-ready.json` (or `rollback-ready.json`) proves their joint state before
marker removal. The lifecycle fence is released **after** marker removal. This
also protects a pinned target whose launcher predates the marker, including
c036. Interruption between marker removal and fence release recovers only
against that exact ready receipt and the unchanged joint state.

Every publication checks exact configuration/lifecycle/selection bytes and
object generation, the original runtime request, registration, ordinary session,
attempt digest and an opaque transfer-state metadata inventory. It never opens
queue payloads or credentials and never writes task journals. New/changed files,
links, excessive inventories or an external writer cause refusal with the fence
retained. There is no queue replay, task reconciliation or business-idle claim.
This is guarded publication under cooperative leases, not a kernel CAS against
an administrator or arbitrary uncooperative writer.

The 0813 producer supports explicit original-result mappings in its own journal
v6. Windows still treats all queue payloads as opaque metadata. The final queue
comparison now follows asynchronous process, security and package observation,
before each publication and fence release. A new v6 registration, append or
checkpoint after the baseline blocks reverse publication/recovery; no frame is
converted, removed or reinterpreted. Rollback only restores archived program
references while work is unchanged; it never starts an old producer. The opaque
baseline does not certify that pre-existing records are old-format compatible.
Reverse publication now additionally requires the unchanged original runtime
request to have transfer disabled, or to be absent (persistent observer mode).
An existing-queue request fails with
`producer_upgrade_rollback_queue_compatibility_unverified` before reverse intent
or publication; no trusted old-format attestation entry exists. The same check
follows asynchronous observation and applies to durable rollback recovery, so
an interrupted reverse intent retains its marker/attention across restart.
The transaction does not disable transfer or rewrite the original request to
obtain this proof. Active queues retain the compatible producer instead.
Old admission scans can refuse the entire directory,
including other unmapped jobs. Server rollback does not authorize producer
downgrade, journal deletion or stripping a mapping. See the
[0813 qualification boundary](evidence/result-recovery-producer-qualification.md).

Plan schema 2 additionally binds the exact nonsecret `transfer.json` bytes
(bounded SHA-256) and original file generation before asynchronous observation.
Dry-run reports both. Preparation, every publication, recovery, rollback and
transition validation compare that original evidence; even an appended newline
or same-byte replacement refuses without rewriting the file or old HostBinding.
The final comparison follows asynchronous process/package checks. A schema 1
plan lacking this original evidence remains audit data and is refused with
`producer_upgrade_transfer_configuration_unrecorded`; the current file is never
used to manufacture a missing historical baseline. Keep its records intact.

External mode adds a schema 3 read-only source witness to the same journal;
schema 2 package-local history retains its prior checks. Before completion and
for any rollback, source files, generations and SID/DACL evidence are rechecked
through the last asynchronous observation. A completed forward proof uses the
archived witness and matching ready receipt, so normal transition validation and
idempotent completed recovery no longer read the old external directory. A
missing or changed old source still refuses rollback; another same-byte copy
cannot substitute. No source binary or credential is copied into the archive.

Before replacement, read-only Windows PowerShell compares **complete security
descriptors for exact equality**, including owner/group/protection/order. A
different descriptor or unavailable native module refuses publication. There is
no ACL copy, inheritance exception, global module-path edit or fallback writer.
The source-only Linux fault fixtures inject this observation; they do not prove
Windows security or an actual producer EXE invocation.

`data/endpoint/producer-upgrade-history/<request-id>/` retains `configuration.json`,
`lifecycle.json` and `selection.json` as exact original bytes, plus the bounded
`plan.json`. The old infrastructure recovery hash is retained verbatim; the new
`producerUpgrade` pointer links the independently verified derived continuation
to the archived originals. It does not claim the old run used the new config.
An explicit rollback appends `rollback.json` before reverse publication, so
`recover-producer` completes the same rollback direction after interruption.

Recover only the same request. Do not run generic deployment recovery, delete
markers, restore a backup by hand or clear attention. Rollback restores the
three original files exactly only while all task/queue/session evidence is still
unchanged, no process has started, and the original runtime remains passive as
required above. It cannot undo work executed by the new
producer. A completed rollback needs a new request UUID for a later upgrade.
Partial pre-intent archives are retained; mismatched bytes are not overwritten
or deleted. If a pre-intent archive is complete, the same upgrade request can
resume preparation. This does not prove power-loss durability.

## Required onsite inputs and acceptance

Only the designated onsite writer can supply the original endpoint reference
metadata, selected old manifest/profile/hash and its relation to `pluginRoot`.
Do not scan the project root or read private credentials to find them. Confirm
the original transfer config/state roots, unchanged credential references and
the original journal/attempt inventory for two unknown and three committed
items. Neither names nor counts authorize changing their contents or status.

The running old 57 host and its stdin ownership remain unconfirmed here. It
understands only its original status/stop protocol; never send `recheck-herdr`
to it or force-stop Pi. A real ordinary snapshot, truthful normal-stop evidence,
original owner/profile mapping and no live external producer are prerequisites
for even the controlled local transaction. The external case additionally needs
the actual recorded 3ccaa manifest/subtree, stable SID/DACL evidence and reviewed
preview described above. Same EXE bytes or an owner display name alone do not
satisfy it. Do not invent a path, register a missing old package, or use Pi-only
`prepare-profile` to authorize the reference change. After acceptance, source
cleanup is a separate exact-path handoff; this transaction has no deletion code.

New source/fault tests do not replace the existing real Windows, strict-TLS
producer build and independent review. No new installer artifact or production
acceptance is claimed here. Controlled onsite upgrade/install/rollback actions
must stay within the parent's specific authorization and sole-writer handoff.
No certificate import, TLS gate change, ACL repair, identity rewrite, unknown
deletion, NAS publication or official Agent-core change is part of this work.
