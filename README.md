# Windows endpoint

Windows endpoint delivery and lifecycle coordination around unchanged official
Herdr, Agenvo and Pi components. This repository owns the delivery layer; the
transfer queue/plugin implementation remains in Memoh and will be consumed as a
qualified, versioned artifact.

**Development baseline, not a released installer or runnable product bundle.**
Public activation remains blocked. The current CLI provides configuration
references, diagnostics, launch plans and verified offline staging. The internal
foreground lifecycle is exercised only in isolated tests.

## Layout

- `endpoint.mjs`, `endpoint.ps1`: delivery CLI and explicit-hash Windows bootstrap.
- `lifecycle.mjs`, `owned-herdr.ps1`: foreground coordination and owned-peer API client.
- `*.test.mjs`: synthetic delivery and lifecycle regression tests, using Node builtins.
- `official-smoke/`: fixed official Windows binaries/npm lock and isolated CI fixtures.
- `docs/`: delivery/lifecycle contracts, provenance and the source hash inventory.
- `dependencies.json`, `endpoint.example.json`: investigated component versions and
  non-secret placeholder references; neither is a qualified release configuration.

## Development checks

Use Node 24. No npm install is needed for the unit suite:

```sh
node endpoint.mjs help
node --test --test-timeout=30000 endpoint.test.mjs lifecycle.test.mjs transfer-contract.test.mjs
```

The `Windows endpoint delivery checks` workflow runs on every pull request and
on pushes to `main`. Its checks are `delivery (ubuntu-latest)`,
`delivery (windows-2025)` and `Official Windows dependencies in isolated roots`.
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

The next transfer milestone consumes the fixed producer artifact instead of
copying its Go implementation. The current artifact lacks the requested lifecycle
summary, so automatic transfer wakes remain blocked. See the concrete
[producer handoff and consumer acceptance entry points](docs/transfer-integration-gap.md).

## Boundaries

No Agent core, transfer queue implementation, NAS deployment, private endpoint
configuration, credentials or user data is included. All test identities,
loopback services and payloads are synthetic and temporary.

Full bundle qualification, pending-tool Agent restoration, automatic transfer
wakes, active update/rollback, real UI, capacity and physical power-loss
acceptance remain incomplete. The [transfer lifecycle contract](docs/transfer-lifecycle-contract.md)
is a proposal, not wired functionality. No production PC/NAS execution is part of CI.

See the [delivery reference](docs/delivery.md), [lifecycle contract](docs/lifecycle.md)
and [source provenance](docs/provenance.md). The imported source retains its
[GNU Affero General Public License v3](LICENSE); official dependencies retain
their respective upstream licenses.
