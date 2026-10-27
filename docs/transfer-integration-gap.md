# Transfer consumer boundary and historical artifact refusal

The current source-built native producer and explicit endpoint adapter are
described in [explicit runtime](explicit-runtime.md). Qualification of the real
packaged executable's upload/authentication/system-trust TLS remains an explicit
failure gate. This record preserves why an earlier artifact was never accepted;
it is not a download, extraction or installation recipe.

## Current consumer contract

`transfer-lifecycle.mjs` drives only finite `lifecycle-summary` and
`advance-results` actions through the existing endpoint lifecycle. Calls coalesce
and do not overlap. A positive due result is paced at one advance per second;
waiting follows the persisted producer deadline; idle summary checks use 30
seconds. A busy/transient unknown result permits at most one bounded read-only
retry per external event. No additional timer, queue or task replay is created.

Typed deadlines, error classes and process outcomes remain separate from task
success. Nonzero `due`/`idle`, malformed output, timeout or ambiguous result
suspends the consumer and persists attention. Stop drains an issued call before
releasing original leases; only cancellation before spawn means not invoked.
The existing producer owns native storage, authentication, original journal and
raw HostBinding checks. The endpoint does not repair ACLs or trust.

The original PR56 examination at
`5e4b883df9e4e8e734722ba3f59abcb3708d56de` found that a damaged record could coexist
with a legal due record while reclamation failed. That checkpoint was not
accepted. Its lesson remains in the consumer's nonzero due/idle refusal tests;
it does not justify running the old producer or a replacement task.

## Historical artifact evidence

| Recorded property | Value |
| --- | --- |
| Repository / source | particleflow/Memoh, `6ddf61dcd8199758e4110398645c556a3d6d7375` |
| Version / architecture | 0.3.0 / amd64 |
| Run / artifact | 39819368622 / 12444231490 |
| Recorded ZIP SHA-256 | `48ac47ad36b0c21b350193d9f1b987f9c470354fc1bac07b722a701c36dde8df` |
| Recorded expiry | `2026-10-29T17:07:52Z` |
| Acceptance | Unexecuted; lifecycle-summary absent; never production-qualified |

The prior hosted download stopped before receiving a body at proxy CONNECT
with `403 Forbidden`. No archive bytes were obtained. That rejected request was
not retried through another URL, credential, proxy or machine. The old seven-file
allowlist was not widened to accept another artifact.

Its unused extractor, execution harness and active artifact lock are removed
from the delivery tree, along with their syntax-only CI calls. Their behavior
only targeted this unaccepted obsolete artifact. The table preserves the exact
refusal/provenance evidence; it is not an active build dependency or acceptance
result. Git retains the original implementation.

The current source-built fixtures and native candidate verifier remain in place.
Their results must identify their own source SHA/run. Mock consumer tests,
fixture-dispatcher CA injection and a packaged empty queue do not establish real
upload authentication/TLS, original-task completion, live handoff or PC/NAS
acceptance. Unknown attempts and original references remain unchanged.
