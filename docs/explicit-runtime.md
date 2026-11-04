# Explicit native foreground component review

The foreground host executes only schema 3 references to the existing official
Memoh Runtime, Herdr and Pi. Schema 1/2 configuration remains decodable so old
identities and saved evidence can be read. It cannot authorize a launch: explicit
runtime requests, NativeDriver commands/start/recovery and launch plans return
`legacy_execution_retired` before any legacy component execution. The old
inventory-bound `explicit-review` request and stale-lock recovery are removed.
Do not edit an old schema number to force it through native enrollment.

Use the [native candidate instructions](../packaging/README.md) and an existing
native Runtime enrollment, official installation references and approved Magpie
profile. The existing local request has this shape:

```json
{
  "schema": 2,
  "mode": "existing-installations",
  "transfer": "existing-queue"
}
```

The request schema number is distinct from endpoint configuration schema 3.
`transfer` can explicitly be `disabled`. No executable/argv, provider, credential,
qualification or test-driver override is accepted. Setup creates no service,
credential or process. With no request the host remains an observer. Changing
configuration requires a restart; it never hot-starts or relocates data.

Before component execution, the native lifecycle verifies official programs,
existing enrollment metadata, configured Herdr/Pi roots, original identity and
unchanged inventory. It holds existing device/config/queue leases. Only the
owned Runtime IPC bridge can stop the connector; an unknown cleanup retains its
child record and ownership. Herdr retains generation-checked stop semantics.
No old status.json/run.lock or `doctor --recover-lock` controls a child.

The finite consumer invokes only `lifecycle-summary` and `advance-results` on
the existing producer and original directory pair. It never submits Pi, creates
business attempts, reassigns a queue identity or rewrites RootHash/HostBinding.
Missing feedback or unknown outcomes stay attention. Runtime control credentials
and file credentials remain separate. Local online or empty-queue observations
cannot authenticate the NAS or prove a delivered file.

## Current verification boundary

`agenvo-retirement.test.mjs` checks both retired schemas, refusal before private
reference resolution, no component start/lease creation, original unknown
acknowledgement and receipt/Pi-history preservation, large decimal revisions and
an actual owned native IPC child. These are synthetic isolated tests, not PC/NAS
acceptance. Existing native connector, lifecycle, setup and handoff suites retain
their original ownership and no-replay checks.

Windows CI retains the actual fixed-source native Runtime/Herdr fixture, the
standalone official Herdr/Pi/Node/Git checks, producer tests and synthetic Pi
workload. Old Agenvo lifecycle/reference/transfer-host scenarios are withdrawn;
their historical results cannot qualify this branch. A separate failing gate
requires replacement native packaged transfer upload/authentication/TLS
acceptance. The native fixture's real EXE empty queue does not replace that gate.
The original positive-TLS gate also remains failed after the recorded CurrentUser
root import rejection; no new import, trust bypass or TLS option is introduced.

The producer remains the unchanged Memoh source pinned in `dependencies.json`.
The [fixture budget](producer-fixture-budget.md) records selected upstream test
coverage; [positive TLS](positive-tls.md) records the prior failure and its exact
scope. Neither is proof of a new-head Windows run. `ready:false`,
`transferAutomaticRecovery:false`, production TLS/authentication, active task
update/rollback, pending-tool recovery and physical power-loss gaps remain.

Original saved configuration, StateStore schema 1/2, handoff observations,
continuation bindings and session snapshot readers keep their old field spelling
and hash order. An unresolved acknowledgement remains `outcome_unknown`, never a
stop/retry permit. These retained readers do not restore old provider execution.
See the [retirement handoff](agenvo-retirement-followup.md) for exact boundaries.

## Withdrawn endpoint budget setup

The user rejected a product workflow requiring total-volume budgets and manual
migration. The endpoint command introduced in `cc0a9cc`, its policy-file writer,
consumer projection and command-specific tests have therefore been withdrawn.
The host fixture again invokes the original production CLI directly. This is a
reversible removal of an unwanted feature, not a repaired permission check or a
claim that its failed native acceptance passed. The `699a7e3` unified-path fix,
producer source pin/tests, lifecycle/Pi checks and positive-TLS gate remain.

The failures remain at [run 40091026322](https://github.com/particleflow/windows-endpoint/actions/runs/40091026322)
(`cc0a9cc`, job `120863542863`) and
[run 40093517205](https://github.com/particleflow/windows-endpoint/actions/runs/40093517205)
(`699a7e3`, job `120870893631`). After the endpoint created a budget policy,
production `enqueue-result` returned `blocked/configuration`, exit 1. Both
fixtures confirmed zero remaining hosts; the later Pi/TLS steps did not run.
Saved complete native-log SHA256 values, respectively:

- `d3e97ab37493788929a72336f656c299930a521aadc23ae693d80804b6fdaaec`
- `e6f61b9d9690b469914669511d6aed4164e89ebe0a9d75ee53e6be4e7798ff45`

The default-owner diagnostic in those runs did not match the process user;
the new policy file's actual owner was not captured, so that suspected cause
was not conclusively established. No owner/ACL check was weakened. Existing
policy files and state are left untouched. The upstream compatibility tests
still cover the pinned producer; they are not a user setup requirement or
evidence that the replacement metadata-queue contract is implemented.
