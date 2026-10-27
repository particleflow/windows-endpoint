# Offline deployment transactions: first verifiable batch

The sections below describe the original all-component selector and its test
boundaries. The portable **endpoint-program-only** adapter is now implemented in
`program-deployment.mjs`; its executable commands and limits are documented in
[the candidate instructions](../packaging/README.md). It uses this same journal,
staging, leases and recovery, with a candidate verifier and own-state format
profile. `deploy run` consumes the selection while transferring the host lease
to the existing foreground host in the same process. It leaves official programs,
plugin registrations and all external data unchanged. It does not supply the
missing global task admission barrier described below: active/unknown attempt or
history evidence defers program switching instead of claiming business quiescence.
Real component upgrade, active Pi handoff and physical installation qualification
remain unimplemented/unverified.

This branch builds on reviewed PR2 head
`5f06399329de31a3fc28f384b0bace5c6eeff814` without changing that branch.
It adds an internal **candidate-selection transaction**, not an installer that
starts a new runtime. Public `start`/`activate`/`update`/`rollback` remain blocked.
No Release, startup service, scheduled task, credential or OS permission change
is included. `transferAutomaticRecovery` remains false.

## Reused implementation and layout

`deployment.mjs` reuses `verifyBundle` and `stageBundle` from `endpoint.mjs` and
the same `leaseKeys`, OS lifetime leases and `StateStore` as `EndpointLifecycle`.
It adds no process supervisor, task queue or transfer implementation. The only
change to existing staging is an internal checkpoint callback for fault tests;
the public staging command and verification requirements are unchanged.

The selected local root has sibling directories:

| Relative directory | Owner and behavior |
| --- | --- |
| `packages/<manifest-sha256>` | Complete immutable verified software inventory. No user originals, credentials or business journals are copied here. |
| `control/deployment.json` | Small schema-checked deployment journal, owned by the existing endpoint device identity. |
| `config` | User/official configuration. Existing contents are preserved. |
| `data` | Official state, Pi sessions, producer source and endpoint lifecycle state. Existing contents are preserved. |
| `logs` | Reserved endpoint log root; previous logs are preserved. Official log redirection is not implemented or silently rewritten. |

`deployment-layout.json` contains only relative defaults.
`deploymentReferences(root, references)` resolves them and reuses `validateConfig`.
The caller must supply the existing device/runtime/instance identities, approved
origin, session and trusted bundle hash. It writes no configuration or credentials.
It is a template for a new installation; no existing root is migrated or renamed.
The transaction engine rejects mutable roots overlapping packages/control.

## Offline preflight and selection

Every operation acquires the original endpoint leases plus one deployment-root
lease. A running or draining endpoint therefore returns `deferred/endpoint_owned`.
The updater does not call stop or kill processes to make progress. After the
normal endpoint stop has drained its in-flight command, a non-stopped lifecycle
journal or any attention still defers selection. Tests use the real lifecycle
and journal with mock component drivers to verify both successful drain and the
PR2 failure-preserving drain.

Selection additionally needs two **currently unimplemented production adapters**:

- `qualify(bundleDirectory, manifestHash)` supplies a complete owner-reviewed
  component state-profile digest bound to that exact verified inventory. The
  tests return a digest of an explicitly synthetic queue format. No official
  format number, version compatibility or release qualification is inferred.
- `inspectWork()` must observe a real admission barrier covering all task and
  transfer producers, with tasks/transfers idle and a current state-profile
  digest. A cached UI state, connector online, empty-looking queue or legacy
  `idle` is insufficient. No production implementation is supplied here.

Absent/unknown/busy observations defer. Selection checks again after preparing
the journal and before publication while holding leases. This is still **not a
real admission barrier**: the future owner must keep admission closed across
that interval. Without that owner integration this code must not be activated.

Rollback selects only the recorded previous package, revalidates both packages,
and requires exact equality between its reviewed state profile and observed
state. Unknown or different state refuses selection; no migration, truncation or
"clean install" fallback is performed. Version strings alone never authorize
rollback. Profiles and observations are test doubles in this milestone.

## Transaction and recovery rules

The journal contains owned package hashes/profiles, current/previous selection,
and at most one pending stage/switch. There is no separate pointer that can
disagree with it. Each update writes a fresh exclusive temporary file, flushes
it and atomically renames it in the same control directory.

| Interruption point | Explicit recovery |
| --- | --- |
| Stage intent written, before/during copy | No target is selected. Abandon that intent, retain incomplete `.pending-*` copies, retry normal verified staging. |
| Candidate published, before ownership receipt | Verify the exact candidate and profile against the recorded intent, then record it as owned. |
| Switch prepared | Keep the old selection; do not automatically finish the requested update. |
| Switch selected, before final acknowledgement | Verify and retain the new selection; do not silently reverse it. |
| Switch committed | Repeated recovery is a no-op. |

Recovery takes the same leases. Switch recovery checks state compatibility;
unknown/busy state leaves the pending evidence intact. A corrupt/unknown journal
schema is never initialized over. Atomic-rename failures retain the last complete
journal and temporary files. This demonstrates process-interruption recovery;
it does **not** claim NTFS physical power-loss durability or complete directory
flush guarantees.

First-time initialization accepts only the expected mutable directories and
creates packages/control without adopting foreign content. If first-time setup
fails before its initial ownership journal exists, partial directories are
retained and initialization fails closed for owner inspection. Automatic repair
of that unowned initial layout is outside this batch.

## Retention and diagnostics

`inventory()` reports unrecorded root/package/control entries and recorded
packages whose full inventory no longer verifies. A preexisting valid hash-named
directory is not automatically adopted; only a recorded staging intent can
recover publication ownership. Extra files inside a package invalidate it and
leave all bytes untouched. Mutable config/data/log roots are not scanned for
deletion candidates.

There is deliberately **no deletion/cleanup operation** yet: old owned packages,
unrecorded temporary files and unknown files all remain. This is a bounded first
batch, not an uninstall or retention policy. A future cleanup must use recorded
ownership plus exact inventory and protect active/previous/pending references;
filename prefixes alone cannot grant deletion authority. Local inventory output
contains relative names and should remain local.

## Verification and exact remaining gaps

`deployment.test.mjs` builds tiny inert complete inventories, not real executable
components. Linux and Windows CI exercise install/update/rollback selection,
repeated calls, missing/altered dependencies, busy/unknown/attention, incompatible
state, owned-process termination at six transaction checkpoints, and preservation
of synthetic original files, config, credentials, task/session state, transfer
journal and logs. Disk exhaustion and `EACCES`/`EROFS`/`ENOSPC` are injected into
filesystem calls; no disk is filled and no ACL is changed. These tests do not
claim real non-admin Windows install or real NTFS ACL acceptance.

Windows process-death tests use actual lifetime pipes. Unix socket paths outlive
processes; production intentionally does not steal them. The Linux test harness
removes only this isolated fixture's known socket names after observing its owned
child's exit. That fixture cleanup is not an updater lock-recovery capability.

Before real activation, supply a reviewed complete component distribution and
trusted state profiles, a task-owner admission barrier/quiescence observer,
and an official approved binary-path transition. Agenvo currently fingerprints
absolute binary paths, so changing a package directory can require scope
reapproval. No shortcut through a symlink, in-place binary replacement, approval
rewrite or Windows live handoff is implemented. A launcher must then consume the
selection under the same lease and reconcile failure before any business starts.
The current public launcher ignores this journal and remains blocked.

The rejected hosted artifact download and PR2 metadata update remain untouched.
Real installer/update/rollback acceptance, qualified transfer data chain, Agent
tool restoration, GUI/capacity and physical power-loss tests remain incomplete.
