# Native program selection and recovery

`program-deployment.mjs` adapts the shared transaction journal in `deployment.mjs`
to the endpoint program candidate. Its public install/update/rollback/recover/run
entries require endpoint schema 3 before reading runtime requests, preparing
folders, acquiring leases or changing selection. Missing `runtime.json` cannot
re-enable a legacy program. A recorded old candidate remains readable but cannot
be selected for native execution.

[Packaging](../packaging/README.md) documents the stable product entry and the
review-only candidate. Official Runtime/Herdr/Pi configuration, credentials,
producer journals and source exports keep their existing roots and owners.
`configure` saves complete native references exclusively; it does not generate
legacy component layouts or migrate old state.

## Inventory and staging

`candidate.mjs` verifies the exact candidate hash, complete file inventory,
producer revision, state profile and native Runtime provenance. New staging
requires native Runtime support. It copies to a fresh `.pending-*`, flushes each
file, verifies the complete copy and publishes under its content hash. Existing
valid publication is idempotent; corrupt or unowned content is retained and
refused. No `bundle.json` writer or public all-component staging entry remains.
The old bundle verifier is a read-only historical inventory check.

The generic transaction engine has no default verifier/stager for retired
components. Its production adapter supplies native candidate verification and
staging. Transaction fault fixtures also use native candidate inventories;
the synthetic state-profile digest is a test contract, not an official schema.

| Path | Purpose |
| --- | --- |
| `packages/<candidate-sha256>` | Immutable owned program candidate, without mutable component data. |
| `control/deployment.json` | Original device-owned selection, package profiles and pending transaction. |
| `config`, `data`, `logs` | Persistent configuration, source/history/receipt data and host logs. |

## Selection and original-work checks

The updater holds the original endpoint and deployment leases; an owned endpoint
causes deferral. It never stops or kills a process to make progress. Selection
requires stopped compatible lifecycle state and an unchanged configuration,
original attempt evidence and saved session continuation. Unknown/busy/attention
states fail closed. Native stale marker retention requires the existing exact
recovery proof; an observed marker or missing PID alone grants no authority.
Active-task handoff remains unqualified.

Native feature checks reject candidates lacking the required Runtime, project
root, transfer directory-pair or current recovery support. Rollback selects only
a recorded compatible previous candidate after the same checks. A historical
ownership receipt does not waive these checks or restore a retired executable.
No producer queue, RootHash, raw HostBinding or saved task is rewritten.

A producer revision change is outside ordinary `update`/`rollback`. These
commands defer with `producer_transaction_required` when the recorded current
profile belongs to the old producer. The separate
[host/producer transaction](producer-upgrade.md) preserves old package evidence
and requires an unchanged actual ordinary snapshot before changing its program
reference. It does not use the Pi profile preparation authority.

## Durable transaction history

The bounded journal records packages/profiles, current/previous selection and at
most one pending stage or switch. Updates use an exclusive temporary file, flush
and same-directory atomic rename. Unknown schemas are never initialized over.

| Interrupted point | Recovery |
| --- | --- |
| Stage intent or partial copy | Retain incomplete files; abandon the pending intent without selecting it. |
| Complete publication before ownership receipt | Verify the exact candidate/profile against the original pending intent. |
| Switch prepared | Retain the previous selection rather than finish automatically. |
| Switch selected before acknowledgement | Verify and retain the recorded selected version. |
| Already committed | Repeated recovery has no effect. |

Recovery retains uncertainty if state or work changed. Atomic publication errors
leave the previous complete journal and temporary evidence intact. These checks
cover process interruption; they do not prove physical power-loss durability.

`deploy status` for schema 1/2 reads only the saved bounded selection journal,
including original pending state. It does not acquire a lease, verify old
executables, inspect private component config, recover, stage or execute. Old
receipts and unknown data remain in their original locations. Native status
continues to report verified inventory and retained unknown entries.

No cleanup policy adopts or deletes unrecorded files. Review fixtures check
install/update/rollback, same-operation recovery, owned-process interruption and
preservation of original synthetic data. They do not establish production
transfer TLS, non-admin/ACL acceptance, live Pi handoff or onsite migration.
See [retirement evidence](evidence/agenvo-writer-boundary.md) for this increment.
