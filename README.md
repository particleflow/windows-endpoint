# Windows endpoint

Windows endpoint delivery and lifecycle coordination around unchanged official
Herdr, Agenvo and Pi components. This repository owns the delivery layer; the
transfer queue/plugin implementation remains in Memoh and will be consumed as a
qualified, versioned artifact.

**Development baseline, not a released installer or runnable product bundle.**
Release activation remains blocked. The current CLI provides configuration
references, diagnostics, launch plans, verified offline staging and a runnable
foreground host. The host reports missing configuration and unavailable capabilities;
an explicit review request can start inventory-verified local official components
and consume an existing transfer queue. See [explicit runtime](docs/explicit-runtime.md)
for its separate component, authorization and business-readiness boundaries.
The [existing-installation mode](docs/existing-installations-plan.md) references
official programs/configuration directly, rechecks actual versions and starts
the same owned lifecycle. It does not install another Pi/Herdr copy or enable
business-task upgrade handoff. It can explicitly reference the existing transfer
plugin and queue; positive production TLS and file return remain unverified.

## Layout

- `endpoint.mjs`, `endpoint.ps1`: delivery CLI and explicit-hash Windows bootstrap.
- `host.mjs`: local foreground entry, status snapshots and bounded per-run logs.
- `runtime.mjs`: explicit local inventory/configuration checks and native adapter wiring.
- `installed.mjs`: existing official installation references, probes and profile comparison.
- `lifecycle.mjs`, `owned-herdr.ps1`: foreground coordination and owned-peer API client.
- `transfer-lifecycle.mjs`, `transfer-contract.mjs`: internal finite command consumer
  and strict producer decisions; no Agent task replay or second queue.
- `deployment.mjs`, `deployment-layout.json`: offline candidate-selection
  transactions and relative configuration defaults; no runtime activation.
- `*.test.mjs`: synthetic delivery and lifecycle regression tests, using Node builtins.
- `official-smoke/`: fixed official Windows binaries/npm lock and isolated CI fixtures.
- `docs/`: delivery/lifecycle contracts, provenance and the source hash inventory.
- `dependencies.json`, `endpoint.example.json`: investigated component versions and
  non-secret placeholder references; neither is a qualified release configuration.

## Development checks

Use Node 24. No npm install is needed for the unit suite:

```sh
node endpoint.mjs help
node --test --test-timeout=30000 endpoint.test.mjs lifecycle.test.mjs transfer-contract.test.mjs transfer-lifecycle.test.mjs deployment.test.mjs host.test.mjs runtime.test.mjs installed.test.mjs official-smoke/producer-fixtures.test.mjs official-smoke/nas-fixture.test.mjs
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
Future Windows updates must use a controlled stop/restore design; update and
rollback are not implemented by the current endpoint.

The finite consumer coalesces hints, honors producer deadlines and drains an
invocation before shutdown. The current candidate source is Memoh
`4c880e07ecdff1b6caadd86348779603fce9e8aa` / plugin 0.7.0; CI builds it using its
unchanged source build script. The older artifact and PR56 history in
[the original handoff](docs/transfer-integration-gap.md) are not current
qualification evidence. No denied artifact is downloaded or substituted.

The [offline deployment transaction batch](docs/deployment-transactions.md) reuses
verified staging and endpoint ownership to test candidate selection and recovery.
It preserves user config/data/logs, defers busy/unknown state and rejects incompatible
rollback. Its component/state observations are synthetic; the public launcher does
not consume the selection. Real installation and updates remain blocked pending
official path approval, admission control and complete component qualification.

The [foreground host](docs/foreground-host.md) can run in an existing canonical
root using `node endpoint.mjs host run --root DIR`. It accepts only local stdin
status/stop commands, holds a lifetime lease and reports configuration, authorization
and component qualification separately. It does not activate the offline selected
package. Real components require the separate explicit request and local checks;
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
