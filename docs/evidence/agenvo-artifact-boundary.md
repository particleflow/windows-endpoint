# Obsolete artifact harness removal

Baseline: `ac3f2c70a5ec616811d3559d0cdb9250b1cc61f5` on PR6. This increment
changes only the Windows endpoint repository. No Memoh, deployment or onsite
operation is included.

## Removed scope

The earlier 0.3.0 artifact harness had no execution caller. Repository references
were its own `transfer-artifact.json` lock, two syntax-only workflow checks and
the historical integration-gap document. It asserted that the obsolete binary
lacked lifecycle-summary; it did not qualify the current native producer.

Delete `official-smoke/prepare-transfer.ps1`, `official-smoke/transfer.mjs` and
`official-smoke/transfer-artifact.json`, plus their JS/PowerShell syntax-only CI
calls. The archive ID, source/version, recorded expiry/hash and original CONNECT
403 failure remain in `docs/transfer-integration-gap.md` as refusal evidence.
No archive was retrieved, unpacked or executed by this cleanup. Neither the
denied download nor the CurrentUser trust operation was retried.

The current native Runtime, producer feedback, source-built CLI, Pi workload,
process containment, private-fixture and packaging checks remain. The two explicit
native transfer/TLS acceptance failure gates remain. Only obsolete harness checks
are removed from CI; no current verification assertion is weakened.

`real-integration-gap.md` now identifies the original pinned inspection and its
remaining native joint-task acceptance boundary, without recommending retired
MCP/OAuth setup. The real build failure, Nginx routing probe/hashes, unknown task
limits and lack of production acceptance remain. Foreground/handoff and source
comments are corrected where they described old control/configuration as current.

## Verification

- Workflow YAML parses; retained `node --check` targets exist.
- Deleted harness files have no remaining caller or operational reference in
  workflows, scripts, README, packaging or current docs.
- Relative links in the changed Markdown resolve; `git diff --check` passes.
- Syntax checks pass for retained feedback/native-runtime fixtures and the
  source files whose comments changed. No Go/C#/PowerShell implementation,
  credentials, network/TLS/ACL policy or runtime behavior is changed.
- No full test or unchanged build is repeated for this reversible removal.

## Prior source head's CI, not this increment

Run [40516358854](https://github.com/particleflow/windows-endpoint/actions/runs/40516358854)
for `ac3f2c70` reached terminal `failure`. Its PR merge ref was
`8bcfdfdfb9d67e04807a476b5aaafe22a492c5c7`, with unchanged base `1537fe39`.
Windows delivery passed 526 tests, packaging 7, installed entry 1 and bootstrap 3;
Ubuntu delivery passed 520 and packaging 7. Official Windows dependencies and
the 7 retirement-boundary tests passed. Native Runtime/Herdr reconnect, one Pi
invocation and original bytes, fixed-source producer fixtures and Pi preparation
passed. The original task/PG joint test, production Magpie and real PC/NAS were
not exercised.

The host job failed only at the retained native packaged transfer
upload/authentication/TLS acceptance gate. The later trust-import refusal gate
was skipped; no import occurred. Review artifact `12739223820` is unqualified,
not a production release. These results do not validate this new increment.

Still retained for specific uses: historical config/layout/bundle verification,
original session/receipt/hash decoding and unknown-state readback; inherited
environment pollution guards; exact historical failures and source provenance.
They grant no legacy execution or migration authority. Independent review,
production transfer/TLS, exact onsite inventory and identity-preserving profile
migration remain separate incomplete acceptance items.
