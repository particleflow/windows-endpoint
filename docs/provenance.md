# Source provenance and migration baseline

The delivery source was imported only from the already-pushed Git commit
[`906f021ca9488a41911b41648a184ae2c3c7b2d6`](https://github.com/particleflow/Memoh/commit/906f021ca9488a41911b41648a184ae2c3c7b2d6)
in `particleflow/Memoh`, [PR 49](https://github.com/particleflow/Memoh/pull/49),
based on `c29391f543743b879bb7e09055fd1c121cae0f7a` (PR 48).
No files were taken from an existing endpoint or NAS.

[source-manifest.json](source-manifest.json) records every imported source path,
destination path and original SHA-256. It includes `contrib/windows-endpoint/**`,
its Windows workflow and the unchanged upstream `LICENSE`. Existing authorship
and source history remain available through the fixed commit link. This is a
modified downstream delivery repository; no license grant is being replaced.

Migration changes before lifecycle diagnosis:

- Move the delivery files to the repository root and technical Markdown to `docs/`.
- Adjust command paths and documentation links; replace the old repository's
  development history and contribution policy with this repository's scope.
- Keep only generic placeholder configuration; rename example installation folders.
- Run the Windows workflow for every PR and for `main` pushes, without path filters,
  write permissions, secrets, automatic approval or deployment.
- Preserve runtime source, all assertions, official dependency versions, archive
  hashes and npm integrity records at the migration checkpoint.

Memoh-specific contribution workflows/rules, backend/Agent source, Go
transferqueue/plugin implementation, migrations and deployment configuration
are excluded. The transfer dependency remains an unqualified candidate reference;
this repository must consume versioned artifacts and a public CLI contract rather
than duplicate its implementation. Dependency licenses must accompany any future
distributed bundle; this repository does not redistribute those binaries.

## Inherited failed checkpoint

Source CI [39829936595](https://github.com/particleflow/Memoh/actions/runs/39829936595)
tested the PR merge `80a25388bc5508ac60996699bde88d9620048c39` containing source
head `906f021ca9488a41911b41648a184ae2c3c7b2d6`:

- Passed: 45 unit tests on Windows and Ubuntu; eight official dependency checks.
- Failed: `Official Windows dependencies in isolated roots`, lifecycle fixture
  `official-smoke/lifecycle.mjs:119` in that recorded imported revision,
  `Persisted panes were not restored`. That retired fixture is no longer part
  of the current tree; the original failure remains historical evidence.
- Not reached: subsequent authentication/shutdown, foreign-peer and official
  live-handoff assertions in that lifecycle fixture.

The cause was unknown at migration. Earlier green runs do not validate this
checkpoint. Diagnostic/fix commits must remain separate from the migration,
preserve the restore assertion and default official Agent restore behavior, and
report their own Windows CI evidence. Official Herdr/Pi/Agenvo source is not patched.

No full installer, real Agent pending-tool, automatic transfer, update/rollback,
real UI, capacity or physical power-loss acceptance is established by these tests.

An earlier explicit runtime checkpoint built public Memoh source
[`40f0a69fd4b7e34dfcf36ec8a44a9805403e7be8`](https://github.com/particleflow/Memoh/commit/40f0a69fd4b7e34dfcf36ec8a44a9805403e7be8)
using that commit's unchanged build script. Current CI uses the fixed source in
`dependencies.json`; the earlier build is historical provenance only. Its plugin version is 0.7.0. No Go
implementation is imported, no old denied artifact is fetched, and no binary is
redistributed by this repository. See [scope and limits](explicit-runtime.md).

`test-support/api-base-v1.json` is the byte-identical shared syntax-vector file
from Memoh `internal/transferclient/testdata/api-base-v1.json` at
[`91149ad7ab5c0d24a57f10e7d9ff1df4b71cf51c`](https://github.com/particleflow/Memoh/commit/91149ad7ab5c0d24a57f10e7d9ff1df4b71cf51c),
Git blob `67cc407e6b914dd52ce7a244a82a580c72ad2ec1`, under the retained AGPL-3.0
license. Only those 30 data vectors are imported; no Go implementation is copied.
They retain the same blob at the current producer pin. The source-built test
executable runs its original contract test against all 30 cases in that checkout.
It separately runs both task API-base boundary tests and requires all 13 cases.
That API-base migration validates the original base's 2048-byte limit before
appending the fixed task namespace and validated IDs; it preserves TLS, ID and
authentication checks without changing configuration or queue bytes.

At that API-base migration checkpoint, compared with `4c880e07`, the build closure
changed only `internal/transferclient/api_base.go`, `api_base_test.go`,
`client.go` and that vector file. CLI JSON/actions, queue and publication code,
`deliverymeta`, raw-byte `HostBinding`, plugin 0.7.0, module dependencies and the
seven-payload build script were unchanged at that checkpoint. The Agenvo catalog entry remains only for
historical bundle-manifest decoding, without an installation or staging adapter.
Previously ambiguous direct-CLI API bases now fail validation; no configuration
bytes, queue identities or stored records are normalized or migrated. A source
pin update alone does not establish a safe live component upgrade or production
qualification.

The current retained-snapshot candidate instead selects producer
`62d27ed995c53f405297eb0069290f3aefba2c51`, with additional producer/CLI changes.
The historical four-file closure above does not describe that source. Its exact
strict-TLS build, Windows executable inventory and new upstream Go/CLI cases
remain subject to the [qualification record](evidence/closed-snapshot-producer-qualification.md).
