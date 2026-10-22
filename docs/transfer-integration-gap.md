# Transfer consumer and remaining producer handoff

The consumer starts from Windows endpoint main
`b8bdd409477d85b9d1ad6dc84ce91b43de8f5089`. All transfer implementation stays in
Memoh. This repository adds no Go copy, service, delivery ID, queue, credentials
or Pi task replay.

## Source interface examined, not a qualified component

The fixed reference for this increment is producer
[PR56 at 5e4b883df9e4e8e734722ba3f59abcb3708d56de](https://github.com/particleflow/Memoh/tree/5e4b883df9e4e8e734722ba3f59abcb3708d56de).
The examined files are `cmd/transferqueue/main.go`, `cli_path_test.go`,
`internal/transferclient/lifecycle.go` and its tests,
`contrib/herdr/memoh-delivery/herdr-plugin.toml`, and
`docs/delivery-lifecycle-summary.md`. The plugin version is 0.5.0.

It implements `lifecycle-summary`, returns the same four decision fields in
`advance-results`, and supplies a test-only CLI dispatch subprocess with injected
TLS trust. The production CLI has no TLS bypass. This first source head is
**not accepted**: review found that a damaged record can coexist with a legal
`due` record while `advance-results` fails during reclamation; native Windows run
`39839491654` also failed its enqueue-result CLI subprocess and skipped packaging.
The producer owner is fixing the original PR. A later unreviewed head is not an
implicit trust update here.

Three concrete differences from the earlier proposed consumer contract are now
handled explicitly:

- `advance-results` has the four fields alongside its existing delivery/reference
  envelope. Summary remains exactly four fields; the parsers are separate.
- Go timestamps can have nine fractional digits. The consumer retains them and
  rounds a wake up, never before the persisted deadline.
- `unknown` + `busy`/`transient` with a null deadline permits at most one read-only
  retry after 30 seconds per external event. It is not a transfer retry deadline.
  Repeated failure suspends this consumer until explicit owner acknowledgement.

`idle` describes this existing queue only. It says nothing about unfinished
producer closure/admission or business completion. A ready reference does not
prove NAS association. Nonzero `due`/`idle` suspends rather than immediately
advancing again, including the reported corruption case.

## Executable consumer increment

`transfer-lifecycle.mjs` integrates with the existing `EndpointLifecycle`:

- Startup reads the producer summary on the first tick. Each tick may invoke at
  most one finite `advance-results`; calls coalesce and never overlap. A positive
  due result is paced at no more than one advance per second.
- Waiting uses the producer deadline; idle gets a 30-second read-only summary.
  Completion hints and observed offline-to-online edges coalesce. Hints never
  shorten the documented 30-second busy/transient retry floor. There is no new
  timer process; the foreground endpoint loop drives checks.
- Stop closes the hint gate, waits for the finite invocation to finish, then
  stops owned components and releases the existing lease. A shared transfer root
  adds a lease key even across different device/session settings.
- Unknown/error/malformed/timeout outcomes suspend. Attention is persisted in the
  existing endpoint lifecycle journal, so ordinary stop/start cannot bypass it.
  Recovery re-reads the producer queue and never calls collect/enqueue/Pi.
- The internal native adapter permits only summary and advance, uses the fixed
  executable with no shell, bounded output and a 125-second process ceiling for
  the producer's 120-second budget. Invocation results are correlated by the
  owned child callback; raw stderr, paths and credentials are not diagnostics.
- Shared config checks bind origin, source, plugin config and state roots to the
  endpoint configuration. Existing credential presence is checked without reading
  its contents. Actual private storage/NTFS and authorization checks stay with the
  producer. No ACL or trust-store repair is attempted.

The native adapter requires an explicit qualification function. There is no
qualified producer supplied by the public CLI or official-component fixture;
the old catalog pin remains unchanged. `start`/activation still fails closed.
The endpoint reports automatic transfer recovery as false. An explicit completion
hint entry point exists, but connecting the real task completion/collection owner
is not claimed by these tests.

`transfer-contract.test.mjs` and `transfer-lifecycle.test.mjs` exercise mock command
outputs, time, errors and stop/restart races. Lifecycle tests also use the actual
endpoint journal and OS lease with mock official drivers. These are consumer unit
tests on Linux/Windows, **not real transfer CLI, TLS, NTFS or NAS data-chain proof**.
The unchanged official Herdr/Agenvo fixture verifies its own separate lifecycle.

## Artifact handoff remains blocked

The old review pin is still artifact `12444231490` from run `39819368622`, source
`6ddf61dcd8199758e4110398645c556a3d6d7375`, ZIP SHA-256
`48ac47ad36b0c21b350193d9f1b987f9c470354fc1bac07b722a701c36dde8df`, reported expiry
`2026-10-29T17:07:52Z`. It has no lifecycle-summary. Its prepared
`official-smoke/prepare-transfer.ps1` and `transfer.mjs` acceptance harness remains
an **unexecuted legacy artifact check**, not a PR56 harness. Its old hash/seven-file
allowlist was not silently changed to accept the proposed eight-file bundle.

The GitHub connector previously returned a hosted file reference, but workspace
materialization failed before receiving a body at proxy CONNECT with **403
Forbidden**. No ZIP bytes were obtained. That download is paused; no new request,
alternate address, proxy, credential or machine is used. This does not imply all
GitHub access failed.

The minimal next dependency is a reviewed, fixed producer commit with successful
native Windows CLI-path CI and its exact Windows artifact/manifest/hash, followed
by an approved supported artifact handoff. Then update the immutable pin and
explicit member list, verify the real small-file CLI chain and only then wire a
qualification closure. The seven-byte synthetic TLS fixture must preserve original
IDs across lost responses/restarts and collect one associated reference without
another Pi run. The current mock results do not establish that outcome.

Full bundle qualification, actual transfer wake/restart acceptance, update/rollback,
pending-tool Agent restoration, real GUI/capacity/large-file-count and physical
power-loss acceptance remain incomplete. No production PC or NAS is used here.
