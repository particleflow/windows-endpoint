# Windows endpoint

Windows endpoint delivery and lifecycle coordination around unchanged official
Memoh Runtime, Herdr and Pi components. This repository owns the delivery layer; the
transfer queue/plugin implementation remains in Memoh and will be consumed as a
qualified, versioned artifact.

**Development baseline, not a released installer.** The existing Windows CI now
retains a [portable review candidate](packaging/README.md) after archive and native
reference-mode checks. It contains this foreground host and the unchanged
source-built transfer review bundle, references existing official installations,
and keeps the positive production TLS gate unmet. It is not a production release.
Release activation remains blocked. The current CLI provides configuration
references, diagnostics, launch plans, verified program deployment and a runnable
foreground host. The host reports missing configuration and unavailable capabilities;
an explicit review request can start inventory-verified local official components
and consume an existing transfer queue. See [explicit runtime](docs/explicit-runtime.md)
for its separate component, authorization and business-readiness boundaries.
The [existing-installation mode](docs/existing-installations-plan.md) references
official programs/configuration directly, rechecks actual versions and starts
the same owned lifecycle using schema 3 and an explicit official Herdr reference.
Schema 1/2 configuration remains readable for original history and bindings;
launch requests and plans fail with `legacy_execution_retired`. No legacy
connector launch or stale-lock recovery is available. This does not enable
business-task upgrade handoff. It can explicitly reference the existing transfer
plugin and queue; positive production TLS and file return remain unverified.
The [historical-session diagnostic](docs/session-observation.md) can inspect saved
layout counts and query an already running server without acquiring stop rights.
Historical task restoration and external-process adoption remain unimplemented.

## Layout

- `endpoint.mjs`, `endpoint.ps1`: delivery CLI and explicit-hash Windows bootstrap.
- `host.mjs`: local foreground entry, status snapshots and bounded per-run logs.
- `runtime.mjs`: explicit local inventory/configuration checks and native adapter wiring.
- `installed.mjs`: existing official installation references, probes and profile comparison.
- `session-diagnostics.mjs`: bounded saved-history and native session observations.
- `lifecycle.mjs`, `owned-herdr.ps1`: foreground coordination and owned-peer API client.
- `transfer-lifecycle.mjs`, `transfer-contract.mjs`: internal finite command consumer
  and strict producer decisions; no Agent task replay or second queue.
- `deployment.mjs`, `deployment-layout.json`: shared staging/selection transactions
  and relative configuration defaults.
- `candidate.mjs`, `program-deployment.mjs`: portable program verification,
  stopped-program install/update/rollback and selected foreground launch.
- `*.test.mjs`: synthetic delivery and lifecycle regression tests, using Node builtins.
- `official-smoke/`: fixed official Windows binaries/npm lock and isolated CI fixtures.
- `docs/`: delivery/lifecycle contracts, provenance and the source hash inventory.
- `dependencies.json`, `packaging/endpoint.native-runtime.example.json`: investigated component versions and
  native placeholder references; neither is a qualified release configuration.

## Development checks

Use Node 24. No npm install is needed for the unit suite:

```sh
node endpoint.mjs help
node --test --test-timeout=30000 endpoint.test.mjs lifecycle.test.mjs transfer-contract.test.mjs transfer-lifecycle.test.mjs deployment.test.mjs program-deployment.test.mjs host.test.mjs runtime.test.mjs installed.test.mjs session-diagnostics.test.mjs official-smoke/producer-fixtures.test.mjs official-smoke/nas-fixture.test.mjs
```

The `Windows endpoint delivery checks` workflow runs on every pull request and
on pushes to `main`. Its checks are `delivery (ubuntu-latest)`,
`delivery (windows-2025)`, `Official Windows dependencies in isolated roots` and
`Explicit Windows host with source-built transfer CLI`.
It uses read-only repository permissions and no repository secrets. Windows
behavior is verified on Windows runners; Linux fixture results are not Windows
runtime evidence. Branch protection is configured separately in GitHub.

The migration started from `Persisted panes were not restored`; the fixture now
waits for the official persisted snapshot before injecting a crash. See
[lifecycle diagnosis](docs/lifecycle-diagnosis.md) for source and CI evidence.
Passing tests apply only to the tested commit.

Official Herdr 0.9.5 live handoff is Unix-only. The Windows fixture asserts its
exact unsupported response while preserving the server, panes and an in-flight
synthetic command. This is rejection safety, not seamless handoff support.
The endpoint program can switch compatible candidates after normal shutdown.
Updating official components and handing off active Pi work remain separate;
no Windows live handoff or automatic task replay is added.

The finite consumer coalesces hints, honors producer deadlines and drains an
invocation before shutdown. The current candidate source is Memoh
`62d27ed995c53f405297eb0069290f3aefba2c51` / plugin 0.10.1; CI builds it using its
unchanged source build script. The optional LAN policy is read from the same
private Herdr plugin config root; `configure` reports its path without copying
addresses into endpoint configuration or changing an existing queue binding.
See the [candidate configuration instructions](packaging/README.md). The older artifact and PR56 history in
[the original handoff](docs/transfer-integration-gap.md) are not current
qualification evidence. No denied artifact is downloaded or substituted.

The endpoint budget-configuration command added in `cc0a9cc` has been withdrawn:
it is not the requested product workflow. The original finite producer calls and
its native validation remain. No existing policy, queue or user file is deleted
or rewritten. New uploads now register metadata through that same producer,
without reserving total source bytes or copying payloads at enqueue. Registration
is pending work, not delivery. Existing snapshot queues remain readable; new v5
records require a compatible reader and must not be handed to an older binary.
No budget edit or user migration is added. This is not large-file end-to-end
acceptance. See the
[retained failure evidence](docs/explicit-runtime.md#withdrawn-endpoint-budget-setup).

The [deployment transaction engine](docs/deployment-transactions.md) now also serves
`deploy install/update/rollback/recover/status` for the portable endpoint program.
`deploy run` consumes its verified selection in the existing foreground host,
holding the host lease continuously. The adapter preserves config/data/logs and
official program/plugin references. It never upgrades the producer or official
Agent, kills busy work, reconciles task receipts or deletes old packages. Unknown
task/history evidence defers switching. The older all-component offline selector
still has no production admission-barrier implementation.

The [foreground host](docs/foreground-host.md) can run in an existing canonical
root using `node endpoint.mjs host run --root DIR`. It accepts only local stdin
status/stop commands and an explicit owned Herdr observation recheck (see the
version boundary in that document), holds a lifetime lease and reports configuration, authorization
and component qualification separately. Direct `host run` uses that supplied
program; `deploy run` uses the selected portable program. Real components require
the existing explicit request and local checks;
process liveness never implies PC readiness.

## Boundaries

No Agent core, transfer queue implementation, NAS deployment, private endpoint
configuration, credentials or user data is included. All test identities,
loopback services and payloads are synthetic and temporary.

Full bundle qualification, pending-tool Agent restoration, automatic transfer
wakes against an authorized production NAS, active update/rollback, real UI, capacity and physical power-loss
acceptance remain incomplete. The [transfer lifecycle contract](docs/transfer-lifecycle-contract.md)
defines the consumer boundary. Real executable CI and synthetic dispatcher TLS
fixtures have distinct scopes; neither proves a user's PC-to-NAS deployment.
No production PC/NAS execution is part of CI.

See the [delivery reference](docs/delivery.md), [lifecycle contract](docs/lifecycle.md)
and [source provenance](docs/provenance.md). The imported source retains its
[GNU Affero General Public License v3](LICENSE); official dependencies retain
their respective upstream licenses.
