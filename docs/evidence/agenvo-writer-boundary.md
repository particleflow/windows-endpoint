# Retired writer and program entry boundary

Differential baseline: `84710fafa974690bcd0c47c123e6bdb4cb0c4c65`, the previous
PR6 head. This increment remains on `cleanup/agenvo-retirement`. Source-workspace
results below do not certify a deployed installation or replace independent review.

## Closed entries and retained readers

`configure` rejects schema 1/2 immediately after reading the explicitly supplied
reference JSON, before the directory picker, package-reference mapping, root
validation or output creation. The old schema-1 path-generation writer is deleted.
Native schema-3 exclusive creation and original-root overlap checks remain.

The old public `stage` spelling returns `legacy_execution_retired` without reading
or copying its source. It is no longer advertised by help. `stageBundle` and the
transaction engine's old default verifier/stager are removed. The copying logic
needed by current installation moves into `stageCandidate`, bound to
`verifyCandidate`, `candidate.json` and native Runtime provenance. Callers cannot
inject a bundle verifier or alternate manifest. Partial-copy retention, exact
inventory checks, file flushes and atomic publication remain. This removes the
old writer rather than renaming its format.

`programDeployment` rejects old configuration before reading `runtime.json`,
preparing directories, acquiring leases or creating a manager. Every public
install/update/rollback/recover/run entry uses that boundary. Absence of a
runtime request is not an exception. Old connector lock checks are deleted.
Native candidate selection continues to reject a recorded old candidate.

`deploy status` can still decode the original bounded selection journal for
schema 1/2. It returns selected/previous/pending records with
`executionPermitted:false`; it acquires no lease and performs no binary
verification, private-config lookup, recovery or mutation. The journal decoder
is the same validation used by native transactions. Configuration, original
decimal revisions, unknown receipt bytes, RootHash and raw HostBinding remain
unchanged. Existing bundle/config/session/receipt readers remain read-only.

Transaction and public program fixtures now use native candidate inventories.
The synthetic old bundle helper remains solely for saved-layout/inventory
diagnostic tests. The unused old relay owner-control probe and its dedicated
test are deleted after confirming no workflow or source caller. Delivery,
transaction, foreground and owner-control documents now describe the actual
native entries; only the precise historical transport result and its limitations
remain as provenance.

## Differential verification

Linux source environment, Node 24.19.0. No unchanged Go/C# build or trust/TLS
operation was repeated. Counts below overlap; they must not be added together.

| Check | Result |
| --- | --- |
| `legacy-writer-retirement.test.mjs` | PASS 5/5: both schemas refuse reference writes, public staging refuses, no-runtime legacy deploy refuses before prepare, saved selection/unknown bytes remain readable. |
| Endpoint configure/staging/policy/API-base-preflight selection | PASS 7/7. Native candidate copy idempotence, interrupted-copy retention and corrupt publication refusal remain. |
| Affected program-deployment file after native-fixture conversion | PASS 41/41, zero skips: native install/update/rollback, actual extracted JS foreground entry, original-work/recovery/unknown retention and old-candidate refusal. |
| Affected transaction file after native candidate conversion | 19/21 passed on the affected run; two assertions expected the retired generic verifier error. Updated to the precise native `candidate_inventory_mismatch`; those two then PASS 2/2. Another earlier targeted run passed 5/5 including stage intent/copy/publication process-interruption checkpoints. |
| Shared central-layout configure/setup/update plus native doctor | PASS 2/2. |
| Unified setup, stable repeatable installation and four affected directory-picker cases | PASS 6/6. |
| Changed MJS syntax, removed writer/probe references, local documentation links, `git diff --check` | PASS. |

The first local attempt found a constructor parameter typo in this refactor and
a missing synthetic marker parent after fixture conversion. Both were corrected;
the affected cases above then passed. No product admission or identity check was
weakened to make fixtures pass. The two transaction assertion changes use more
specific native verifier errors and retain their preservation assertions.

The previous head's terminal CI is separate evidence: Windows run 40513135030
passed delivery/native host/producer/Pi preparation but failed the explicit native
packaged transfer acceptance gate; Memoh PR90's Go run 40513051464 passed, while
its Windows delivery run 40513051476 exhausted the unchanged transfer-suite
budget. None of those results proves this increment's Windows CI or onsite state.
New CI, independent review, real UI/PC/NAS, file authentication/system-trust TLS
and actual root/profile migration remain unaccepted. No legacy TLS gate was
rerun, removed or converted into success.

## Explicit workflow list correction

A later final audit of the hidden workflow's explicit test arguments found that
the deleted `official-smoke/owner-control-fixture.test.mjs` remained listed and
`legacy-writer-retirement.test.mjs` was not listed. The earlier source-reference
check did not cover that argument list. The local writer tests above did run,
but ac3f2c70's remote 526/520 counts do not include those five new tests. The
workflow list is corrected to remove the nonexistent input and schedule the
actual writer regression. Every listed test path is checked for existence.
This correction changes no runtime implementation or transfer/TLS gate; no
previous passing build is rerun manually.
