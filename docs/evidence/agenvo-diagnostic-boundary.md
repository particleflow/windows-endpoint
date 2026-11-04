# Legacy qualification and diagnostic removal

Baseline: `a7fb5c5fa1a503c0fd2b3f8bdbfbbea484d98514` on the independent
`cleanup/agenvo-retirement` branch. The Windows owner has not consumed that
baseline. All results here are source-workspace results, not deployed behavior.

## Removed execution and unused fixtures

`validateInstalledConfiguration`, `inspectPrograms`, `inspectInstalled`,
`inspectInstalledTransfer` and live `observeExistingSession` accept native
configuration only. The guard runs before private-reference resolution or any
probe callback. The old instance-config resolver, relay validation, credential
metadata check, connector `--version` probe, legacy package branch and implicit
Herdr migration hint are removed rather than retained behind a test-only switch.

The endpoint doctor no longer contains its old bundle/instance/auth/status/plugin
qualification pipeline. Both legacy schemas return a blocked history-only
report with null versions. The foreground observer ignores retired auth/status
paths and checks native enrollment metadata without reading its contents.

The legacy host, existing-installation, lifecycle and bundle-inventory scripts
are deleted, together with their unused certificate-store helper. The existing
supervisor keeps only the native Runtime/Pi scenarios and the same bounded
owned-job containment. No certificate-generation/import/removal branch remains.
No trust operation or TLS policy change was executed. The workflow's original
failed TLS gate and replacement native transfer acceptance gate are unchanged.

Native fixtures are now built directly, without first writing a legacy package,
configuration or credential. The remaining legacy fixture creates only original
non-secret reference/mapping and history data for refusal/preservation tests;
its probe callback always fails. Tests specific to the deleted positive legacy
pipeline are removed. Useful version/launcher/update/transfer consistency tests
use native configuration and remain enforced.

## Deliberately retained readers

- `validateConfig`, original layout/path decoding and catalog manifest validation
  retain historical field spelling and IDs without probing a component.
- `readSessionHistory` projects bounded saved Herdr/Pi snapshots only. Legacy
  doctor uses this reader and never an old config/auth/status or live server.
- StateStore/handoff/continuation/receipt readers retain original unknown state,
  revisions, hash order and locators. No operation is remapped or replayed.

The native inspector still verifies explicit official Herdr selection, program
fingerprints, minimum versions, Pi launcher resolution and Runtime CLI protocol.
Unowned native session observation never grants stop authority. File-principal
mapping remains a separate blocked diagnostic; it is not inferred from control.

## Actual differential checks

Environment: isolated Linux cloud workspace, Node v24.19.0. No installed Windows
program, production provider, private credential, PC/NAS or OS trust store.
Counts below belong to separate commands and must not be added as unique tests.
The earlier 198-case run and full seven-case package suite were not rerun.

| Differential check | Result |
| --- | --- |
| `node --test --test-timeout=30000 diagnostic-retirement.test.mjs` | PASS 4/4. Both schemas reject before program/private access; direct and public doctor preserve saved history without old auth/status/server reads; native version/protocol checks stay available. |
| Installed tests selected by `references inspect\|configure host root\|official compatible\|same-version\|unsafe or missing\|foreign package\|necessary CLI\|launcher for\|producer existing\|default native transfer\|native control-only\|reference mode shares\|external producer\|missing producer\|running consumer\|external transfer` | PASS 16/16 native qualification/producer regressions. |
| Session/continuation tests selected by `historical workspaces\|missing, empty\|oversized and linked\|diagnostic preflight\|matching CLI selector\|not running\|protocol uncertainty\|clean-stop checkpoint\|data identity` | PASS 9/9, including legacy saved-history reads and native unowned observations. |
| Host tests selected by `loaded config and absent\|retired linked\|retired implicit\|public observer` | PASS 4/4. Retired linked private paths are ignored; original files remain. |
| Endpoint test `historical inventory verification` | PASS 1/1. Original bundle inventory remains verifiable while retired diagnostics stay blocked. |
| Installed test `native direct-CLI directory pair is optional` | PASS 1/1 after correcting that test's explicit historical fixture selection; no runtime rule was weakened. |
| `PYTHONPATH=packaging python -m unittest test_candidate.CandidateTests.test_reproducible_archive_runs_existing_entry_without_checkout_or_npm -v` | PASS 1/1, including extracted schema-3 entry and its eight archive assertions. No full package-suite rerun. |
| Changed MJS syntax, YAML parse, exact removed-fixture reference scan and `git diff --check` | PASS. The native supervisor has only its two supported scenarios; the original TLS failure remains a failing prerequisite. |

An initial affected check exposed one test still selecting the now-native
fixture as if it were legacy. Its explicit historical fixture selection was
corrected and the exact test passed. That intermediate run is not described as
a final all-green aggregate.

No PowerShell parser is available in this Linux environment. The changed native
supervisor requires exact-head Windows parsing/execution; unchanged C# and
previous Windows/Go builds were not repeated. Real UI/device acceptance, native
packaged upload/authentication/TLS and the onsite inventory remain open. Source
reversibility is Git-based; no user data, secret, RootHash/HostBinding, ACL or
unknown task was changed. The fixed Windows candidate and live runtime remain
unchanged until their owner explicitly composes and validates this source.
