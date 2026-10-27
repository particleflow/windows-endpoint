# Windows legacy startup retirement delta

Baseline: PR5 `1537fe39256bd7f208fe3da2b4323c6bf2a9fc04`, with the independent
offline plan at `4a1dbe71b99bfca5b73b96fd29ce9172d3d69c46`. This record covers the
subsequent startup-boundary source delta, not an installed PC/NAS or a release.

## Changed boundary

- Endpoint schema 1/2 still decode original paths/identities. Their runtime
  requests, CLI plans, NativeDriver commands/start/recovery and toolchain runs
  fail with `legacy_execution_retired`; no implicit schema/provider migration.
- Delete the old connector spawn, status/run.lock reader, forced connector stop,
  lock-recovery command and schema-1 runtime implementation. The remaining
  connector recovery uses the exact owned official Runtime IPC child.
- Remove inherited AGENVO environment emission; retain pollution rejection.
  Remove the two old setup examples and the packaged schema-2 template link.
- Convert useful setup/lease/process tests and standalone Herdr/Pi fixtures to
  native configuration. Withdraw active CI calls to old relay/reference/host
  fixtures. Keep the real native Runtime/Herdr test, original producer tests,
  synthetic Pi work and existing failed positive-TLS prerequisite.
- Explicitly fail a separate native packaged upload/authentication/TLS gate
  until that replacement acceptance exists. Empty native queues and synthetic
  process tests are not substitutes for the withdrawn transfer-host scenarios.
- Remove @agenvo/herdr from the active fixture package and prune 31 unreachable
  lock entries with npm --offline. Retained version/resolved/integrity pins are
  byte-value unchanged. No dependency download, model call or trust change.

## Preserved compatibility and its exact purpose

`StateStore.load` and `handoffStatus` keep schema-1/2 original unknown
acknowledgements readable. Handoff payload validation keeps decimal revisions
above 2^53 as strings. Session history/continuation readers retain original
Herdr/Pi paths and hash order. These readers confer no execution, stop or retry
permit. The regression checks exact lifecycle/receipt/Pi-history bytes after
old-start refusal and queries the actual read-only host handoff CLI.

The old configuration/catalog/layout spelling also supports original bundle
manifest and saved path validation. `docs/source-manifest.json` records the
original imported tree at its original commit, including now-deleted examples;
it is historical provenance, not this candidate's file inventory or setup link.
Legacy installed qualification/diagnostic implementations and unused old fixture
source remain a separate pending cleanup, not protected historical executors.

## Checks actually run

Environment: isolated Linux cloud source workspace, Node v24.19.0. No real
Windows binary, PC/NAS, provider, production credential or certificate store.

| Command / check | Actual result |
| --- | --- |
| `node --test --test-timeout=30000 agenvo-retirement.test.mjs` | PASS, 7/7, zero skips. Covers both old schemas, pre-reference rejection, no setup/lease creation, public CLI retirement code, saved unknown/receipt/history preservation and actual synthetic native IPC start/stop. |
| `node --test --test-timeout=30000 agenvo-retirement.test.mjs lifecycle.test.mjs runtime.test.mjs installed.test.mjs setup.test.mjs host.test.mjs session-continuation.test.mjs native-connector.test.mjs handoff.test.mjs` | PASS, 198/198, zero skips. Ran before the final additional public setup CLI case; the seven-case command above includes that new case. Counts overlap and are not additive. |
| `node --test --test-timeout=30000 endpoint.test.mjs agenvo-retirement.test.mjs host.test.mjs` | PASS, 127/127, zero skips, at the preceding sample-removal checkpoint. Later host/lifecycle interface changes are covered by the 198-case run. |
| `python -m unittest discover -s packaging -p 'test_*.py' -v` | PASS, 7/7; includes deterministic archive inventory, absent legacy template, actual extracted entry and its eight packaging assertions, source/payload tamper rejection. |
| `node --check official-smoke/verify.mjs`, `node --check official-smoke/pi-workload.mjs`, `node --check test-support/host-runtime.mjs` | PASS; syntax only, not Windows execution. |
| YAML parse and prerequisite inspection | PASS: same three jobs, original positive-TLS rejection remains the final prerequisite; separate native transfer acceptance remains a failing gate. |
| npm offline lock pruning + retained-pin comparison | PASS: old root/package absent; 31 unreachable package entries removed; all retained version/resolved/integrity values unchanged. |
| `git diff --check`; exact startup-pattern scan | PASS. No stale-lock recovery command, old connector spawn expression, old recovery method or AGENVO_CONFIG_DIR assignment in endpoint/runtime/lifecycle source. |

An intermediate affected-suite run exposed old positive activation assumptions
and the host's generic error mapping. Those fixtures now test native execution
or explicit retirement, and the public CLI returns the bounded retirement code.
The final passing commands above supersede those intermediate failures.

## Unperformed acceptance and handoff

The fixed-source Windows native binary smoke, the changed standalone Windows
Herdr/Pi fixture and packaged candidate were not executed here. Existing Windows
CI40487432492 and artifact12726421524 apply to baseline `1537fe39`, not this delta.
No unchanged Go/TLS dependency fetch, failed trust import, elevation, ACL or
network action was retried. No new UI/service, install, live migration, secret
read/copy/move, RootHash/HostBinding rewrite or unknown-task replay occurred.

PR creation remains blocked by its earlier automatic approval rejection and is
not retried. The parent owns exact PR authorization and onsite handoff to writer
`01a157e3-ab3a-7534-81d6-68d7202e000c`. The source guard is reversible in Git; a
rollback must preserve original records and must not reactivate old execution.
Global zero-residue retirement and actual Pi/Herdr migration are still open.
