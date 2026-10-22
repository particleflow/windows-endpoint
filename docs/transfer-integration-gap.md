# Transfer integration: fixed producer gap and executable acceptance

This work starts from merged Windows endpoint `b8bdd409477d85b9d1ad6dc84ce91b43de8f5089`.
It does not invent a compatibility translation, queue, task ID, OAuth flow or
transfer service. Files still use the NAS transfer/association protocol; the
control plane supplies tasks and references.

## Fixed producer facts

Producer [PR 47](https://github.com/particleflow/Memoh/pull/47) remains at
`6ddf61dcd8199758e4110398645c556a3d6d7375`. The immutable candidate identity is in
[`transfer-artifact.json`](../official-smoke/transfer-artifact.json): artifact
`12444231490` from run `39819368622`, ZIP SHA-256
`48ac47ad36b0c21b350193d9f1b987f9c470354fc1bac07b722a701c36dde8df`.
GitHub reports expiry `2026-10-29T17:07:52Z`. This is an expiring review artifact,
not an install/update distribution channel.

The actual [CLI source](https://github.com/particleflow/Memoh/blob/6ddf61dcd8199758e4110398645c556a3d6d7375/cmd/transferqueue/main.go)
has no `lifecycle-summary` action. Unsupported actions exit 2 before accessing
state. `advance-results` can emit `{"state":"idle"}` or
`{"state":"pending_or_unavailable","feedback_status":""}`. Success emits
the existing delivery/phase/offset/admission/association/reference fields.
There is no versioned due-time or stable authentication/permission decision.

The [plugin](https://github.com/particleflow/Memoh/blob/6ddf61dcd8199758e4110398645c556a3d6d7375/contrib/herdr/memoh-delivery/herdr-plugin.toml)
has `verify-storage`, `collect-result`, `advance-delivery` and `fixture-check`.
`advance-delivery` invokes the finite CLI `advance-results`. The queue's `nextDue`
skips future retries, blocked jobs and uncertain creates. Therefore `idle` cannot
be translated into an empty queue or a fabricated retry deadline. `probe` only
reports storage availability; it is not complete config/auth/readiness evidence.

## Minimum change requested from the producer owner

1. Implement the existing [four-field contract](transfer-lifecycle-contract.md)
   as a finite read-only `lifecycle-summary` action and an explicit plugin action.
   Preserve queue/association due times and classify empty, waiting, due, blocked
   and unknown from authoritative component state. Do not call reclaim/admission,
   rewrite journals or reset backoff during summary. Tests must compare persisted
   state before/after the read.
2. Return the same decision fields alongside the existing `advance-results`
   result. Preserve all delivery/reference IDs and existing operation/attempt
   ownership. Use typed errors for authentication, NTFS permissions, configuration,
   capacity, transient transport and busy; do not make consumers parse stderr.
   Document correlation and shutdown behavior for a finite plugin invocation.
3. Supply a fixed, hash-addressed Windows artifact with the changed CLI/plugin,
   source commit and manifest in a durable download channel suitable for read-only
   consumer CI. Do not require a writable token or production secret on PR runs.
4. Add a packaged **real CLI-path test** using the existing implementation with a
   test-only injected TLS client/root, not a parallel protocol implementation or
   TLS bypass. It should run closed-result admission, finite advance, inspect and
   reference association against an ephemeral HTTPS NAS fixture, using a small
   payload and the same IDs across process invocations. Inject a lost response,
   reopen durable state, finish once, and assert no second original task/Pi run.
   A test entry in `cmd/transferqueue` can reuse the actual CLI dispatch and JSON
   output; production still uses its normal transport. No system trust/ACL repair
   or production credential is needed.

The existing packaged `transferqueue.test.exe` tests the component directly with
an injected TLS client. The production CLI hardcodes the normal transport. Running
the component test is useful evidence but must not be relabeled as external CLI
end-to-end evidence. The Windows endpoint will not copy Go code to close this gap.

## Executable consumer checks prepared here

`transfer-contract.test.mjs` checks the requested versioned response and explicitly
rejects actual legacy JSON shapes, missing/expired deadlines, unknown fields,
private payloads and malformed/oversized output. These are contract acceptance
tests, not evidence that the current producer implements it. No timer or mutation
is wired to an inferred legacy result.

For an already obtained fixed archive on an isolated Windows runner:

```powershell
./official-smoke/prepare-transfer.ps1 -ArchivePath $FixedArchive -Root $FreshTransferFixture
& $VerifiedNode ./official-smoke/transfer.mjs $FreshTransferFixture
if ($LASTEXITCODE -ne 0) { throw 'Transfer consumer fixture failed' }
```

Preparation verifies the exact ZIP hash, seven exact members, bounded extraction,
source commit, architecture and every producer payload hash. It installs nothing,
changes no OS permissions and builds no producer source. The harness requires the
actual current CLI's explicit unsupported-summary response and missing-root
failure without state creation. It also runs four named tests from the unchanged
packaged producer executable, checking that every test exists, runs and passes.
Those tests include a **seven-byte** TLS upload, durable reopen/lost-association
recovery, one final reference commit and unchanged source/operation identity, plus
config/source-root failures. The evidence remains component-level, not a new CLI
or automatic-wake completion claim.

## Execution limits at this checkpoint

The connected GitHub artifact read/download succeeded and returned a temporary
file reference. Materializing that file into this cloud workspace failed at the
network proxy's CONNECT stage with **403 Forbidden**. No bytes were obtained;
this is a file-download network-policy rejection, not a GitHub repository
permission failure. No alternate credential or route was tried after rejection.

Consequently the new artifact harness is prepared but **not executed** here.
Current CI runs its JavaScript/PowerShell syntax checks and the contract unit
tests; it does not quietly skip an advertised artifact integration job. Real
consumer artifact execution and external CLI data-chain acceptance remain pending
the producer handoff/materialization path. Automatic transfer wakes, product
activation, updates/rollback, Agent pending-tool recovery, large-file/count and
physical power-loss acceptance remain incomplete.
