# Referencing existing official installations

This first implementation reuses user-selected official Pi/Herdr programs and
their explicitly selected configuration directories. It does not install a
second copy, update an official package, import historical sessions or enable
automatic upgrade/rollback. The prior bundle/TLS checkpoint remains
`5aa2dd5eb79c4ced4b6e8707d838a4b2710c0672`.

## Configuration

Use the existing endpoint config file, `<host root>/config/endpoint.json`, with
schema 2. This example is a path template, not an installer command or real
machine configuration. Official installers/package managers own these programs.
The referenced Node, Git and Agenvo installation must already exist.
Use physical paths, not version-manager junctions or ambient PATH discovery.
In particular, the official Windows Herdr `current` junction cannot currently
be used as Agenvo 0.2's binary path; see the update limitation below.

```json
{
  "schema": 2,
  "programs": {
    "node": "C:\\Tools\\node\\node.exe",
    "piPackage": "C:\\Tools\\npm\\node_modules\\@earendil-works\\pi-coding-agent",
    "piBin": "C:\\Tools\\npm",
    "gitRoot": "C:\\Tools\\Git",
    "connectorPackage": "C:\\Tools\\npm\\node_modules\\@agenvo\\herdr"
  },
  "sourceRoot": "C:\\EndpointWork",
  "herdrConfigRoot": "C:\\ExistingConfig\\herdr",
  "herdrStateRoot": "C:\\ExistingState\\herdr",
  "agenvoConfigDir": "C:\\ExistingConfig\\agenvo",
  "piConfigDir": "C:\\ExistingPiConfig",
  "deviceId": "11111111-1111-4111-8111-111111111111",
  "runtimeId": "22222222-2222-4222-8222-222222222222",
  "instanceId": "existing-instance",
  "session": "endpoint-work"
}
```

Replace example identifiers with the existing authorized mapping; this command
creates no identity or credential. Herdr's only program-path source is
`agenvoConfigDir/config.json`: the existing Herdr instance matching `instanceId`
must belong to `deviceId` and name the selected configRoot and cwd. The current
host still requires exactly one configured instance; a multi-instance connector
is rejected rather than implicitly managing unrelated instances. No registration
is rewritten. The host retains
only its own config/data/logs below its root. Component roots must not overlap
those owned directories or each other's data/program paths.

Older schema-2 files containing `programs.herdr` remain readable: that field is
an explicit equality constraint against the official instance. `doctor` reports
`herdrReference.source: legacy_explicit_match` and a one-time migration hint.
To follow that instance without maintaining two paths, remove only the optional
`programs.herdr` field from the endpoint configuration. No automatic file rewrite,
credential copy or business-history migration occurs. Schema 1 is unchanged.

Run `doctor --config FILE` to detect actual versions, package names, required CLI
flags and the Pi launcher resolved under the controlled Git Bash environment.
Executable probes are finite local version/help checks. After they pass, the
diagnostic also queries the selected Herdr session through native read commands;
it never starts a missing server. No model request is made.
`plan --config FILE` shows the local launch plan. `configure --from FILE
--config FILE` still creates references exclusively, without copying official
configuration, packages or credentials.

To explicitly start components, `<host root>/config/runtime.json` is:

```json
{"schema":2,"mode":"existing-installations","transfer":"disabled"}
```

Then `host run --root DIR` runs the foreground host. Its existing stdin
`{"action":"stop"}` drains/stops only components it owns. No service, scheduled
task or unattended startup is registered. Without runtime.json it remains an
observer. Schema 1 retains the inventory-bound bundle mode.

## Programs, configuration and sessions are separate

Sharing Pi's program does not share its sessions. Sharing `PI_CODING_AGENT_DIR`
is an explicit reference, not a credential copy; official Pi can itself write
that directory, so this is not a concurrent-write isolation guarantee. No auth
content is read by preflight; presence is not authentication success. The current
producer uses a distinct `--session-dir` and exact `--session-id` for batch tasks.
Keep those separate from a user's interactive TUI.

Reference mode requires a named, non-default Herdr session. Host startup refuses
a running server, even if its binary is selected. A persisted session with
workspaces or an unverified schema is refused before startup; this batch does not
adopt or resume historical Agent tasks. This is a startup ownership/restore gate,
not a corruption diagnosis. `doctor` separately reports saved-history structure
and may query an existing server without obtaining stop authority; see
[historical-session observation](session-observation.md). Other
sessions/configuration are not migrated or deleted.
Empty-session restart and observed owned-process recovery use the existing
PID/generation/pipe checks and device/config leases.

## Official updates and rechecking

There is no new user-maintained version/hash manifest or per-update approval
workflow. Preflight reads versions from the selected programs. Current probes
require Node >=24.13.0, Herdr >=0.9.5 and Pi >=1.2.0 plus required CLI flags,
official package names and matching package/runtime versions. Agenvo's currently
implemented status/lock protocol remains 0.2.0. These checks do not prove every
future release's semantics; unknown state/protocol behavior still fails clearly.
Herdr readiness/ping must report this run's observed version and
`endpoint_compatible:true`.

File hashes are observed evidence, not a provenance approval system. Program,
official instance configuration and package-tree metadata are captured for this run; changes stop
automatic recovery and persist `installation_changed_restart_required`.
Existing processes remain running until explicit stop. Owned pipe stop does not
invoke the replaced Herdr binary; unchanged connector cleanup remains available.
This detects ordinary official updates; it is not an OS write lock or protection
against a hostile writer racing metadata checks.

After an explicit clean stop, the next explicit run rechecks the installation
and may clear only that installation-change attention. Other errors, an uncertain
previous stop and nonempty historical sessions retain their gates. The endpoint
never runs an official updater, rolls state back or kills tasks to upgrade.
Coordinating upgrades while business tasks run is still unimplemented: no new
producer drain API is invented by this batch.

### Windows Herdr version-directory limitation

The official [Windows installer at the reviewed source](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/distribution/install.ps1)
installs `packages/standalone/releases/<version-target>` and switches `current`
and its visible bin junction. It does not overwrite the previous physical
binary. For this exact layout the endpoint now checks the current target lies
directly inside that physical releases directory and matches the selected
release. Retargeting suspends recovery even when old bytes are unchanged; a
fresh preflight reports `herdr_active_installation_changed` before invoking the
old release. This check is the endpoint's policy: Agenvo itself can still accept
the old canonical binary while that file exists. Other mutable links are still
rejected. Detection alone is not automatic adoption of the new release.

[Agenvo's canonical-path validation](https://github.com/Xuanwo/agenvo/blob/a89415e557c415faf5626354f8e87233eb69d877/packages/connector/src/config.ts)
requires the configured binary to equal `realpath` and includes it in the
instance scope fingerprint. A new canonical physical path is valid, but its
changed fingerprint no longer matches the previously approved scope. The
[official usage guide](https://github.com/Xuanwo/agenvo/blob/a89415e557c415faf5626354f8e87233eb69d877/docs/usage.md)
requires restarting the connector and approving the changed scope through its
native administration flow. Existing deviceId/instanceId and pairing are kept.

For a version-directory update: cleanly stop the endpoint, update Herdr through
its official owner, maintain the existing Agenvo instance's `binary` in its
existing config to the new canonical physical executable, then explicitly run
the endpoint again. It re-reads that single official path, validates the actual
program/protocol and starts the connector. Complete any changed-scope approval
through the native owner; `online` alone does not prove instance authorization.
The endpoint file needs no second path edit after the one-time migration above.
There is no official `instance update/upsert` command in the examined version;
`instance add` with the same ID is not an update. This endpoint neither edits
official configuration nor approves scope, re-pairs or invents that command.

A version change at the same path does not by itself change this fingerprint:
the version number is not in it. Pi updates at the selected package path can
be rechecked after a clean stop. Herdr's Windows managed installer (including
`-InstallDir`) rotates version directories/junctions; it provides no general
flat-path in-place-update guarantee. Neither case establishes safe upgrades
during Agent work or session migration.

## Existing transfer plugin reference

For a new configuration using the default Web gateway, the optional schema-2
endpoint field is:

```json
"transfer": {
  "pluginRoot": "C:\\ExistingPlugins\\memoh.delivery",
  "nasOrigin": "https://nas.example.test/api"
}
```

The runtime opt-in is then
`{"schema":2,"mode":"existing-installations","transfer":"existing-queue"}`.
Without that opt-in the finite consumer remains absent. No package or credential
is copied. The plugin must already be registered and enabled in the referenced
Herdr `plugins.json`, with the exact same root and manifest. Its existing
configuration is derived from `herdrConfigRoot/plugins/config/memoh.delivery`
and its queue from `herdrStateRoot/plugins/memoh.delivery`; these are the same
producer locations and acquire the same transfer lease as bundle mode.

Both schema-1 `nasOrigin` and schema-2 `transfer.nasOrigin` now mean HTTPS API
base under the shared
[`memoh.file-api-base.v1` contract](https://github.com/particleflow/Memoh/blob/91149ad7ab5c0d24a57f10e7d9ff1df4b71cf51c/docs/file-service-endpoint-contract.md).
Direct Server roots, `/api`, nested prefixes and a single trailing slash are
accepted, including explicit LAN/IPv6 addresses. Ambiguous separators, dot
segments, escaping, query/fragment delimiters and invalid ports are rejected.
The endpoint's existing `.invalid` destination rejection remains. Validation
does not resolve DNS, choose routes, prove authorization or alter TLS checks.

The selected value must match existing `transfer.json.origin` **exactly**.
Case, port spelling and trailing-slash differences are not silently normalized.
The producer binds queued work to the original configuration bytes: this change
is not permission to edit a populated queue's address, migrate its binding or
create replacement deliveries. Existing-queue migration remains separate;
automatic LAN preference/IPv6 fallback is not implemented.

The 30 shared vectors run against both endpoint schemas. The existing native
Windows reference-mode fixture uses a fresh `/api/` configuration and checks
that changing its spelling makes the production CLI return
`configuration_changed` without altering the admitted delivery; it then restores
the fixture's original bytes and exercises the same pending queue. This is
admission/binding and untrusted-TLS coverage, not a positive `/api` upload proof.

The producer's existing `SHA256SUMS.json` must identify reviewed source
`4c880e07ecdff1b6caadd86348779603fce9e8aa`, amd64 and the complete build output.
Preflight verifies those file hashes, then each finite invocation rechecks the
captured executable, manifest, receipt and plugin-registration bytes. A changed
receipt cannot silently replace the running component. This is an integrity
check on a deliberately selected local source build, not signed provenance or
production qualification; the user supplies no second manual hash/version list.

The same `NativeTransferDriver` and `TransferLifecycle` handle bounded summary,
advance, deadline wake, draining and persistent attention. They never collect a
new task, create a second queue, infer task completion from idle, or replay Pi.
Unknown and in-flight stop failures retain the existing gates. Native permissions,
credentials, journal compatibility and TLS remain the producer's responsibility.
No new producer field or API was required for this connection.

## Existing producer profile comparison

The fixed producer is `4c880e07ecdff1b6caadd86348779603fce9e8aa`.
`internal/agenvo/client.go` defines `Target.WorkDir/BashPath` and
`AgentProfile.ExecutionMode/Provider/Model/ConfigDir/Path`. `profile.go` and
`internal/handlers/user_runtime.go` expose the existing owner route
`PUT /users/me/runtimes/{id}/agenvo-agent`. No new producer field/API or source
change is required for this first batch.

For a local export of existing Target JSON, `doctor --config FILE --target FILE`
compares device/instance/session/work root, Bash, `pi-json-v1`, Pi config and any
explicit PATH override. It does not fetch credentials or call that production
route here. `configuration_matches` proves supplied configuration agreement,
not live registration/authentication or task execution. Configure the actual
runtime target/profile through its existing owner.

`pi_batch_service.go` overrides the tab's Pi config/PATH; host PATH alone does
not prove mobile-task resolution. `pi_batch.go` retains session IDs and attempt/
result handling. A future upgrade gate needs authoritative stopped-admission/
active/unknown evidence from the existing computer-task owners. Transfer idle
and an empty Agent profile cannot supply it. This is a remaining handoff, not
a new task queue, installation registry or update service.

## Evidence limits

Local tests use inert files and injected probe output; they prove validation,
preservation, change detection and public observer behavior, not native execution.
The added Windows CI scenario uses unchanged official programs in external
temporary installation directories and a synthetic relay. It exercises the
public host, owned stop/recheck, same-device contention, external-peer refusal
and synthetic history preservation without model calls or OS trust changes.
Its path-change scenario copies the same unchanged official release only within
the temporary fixture, maintains the synthetic Agenvo config, and reads the
actual running process image path. It verifies a new explicit host uses that
new path while endpoint.json is byte-identical. It does not execute Herdr's
updater or prove real native scope approval against a production relay.
Read results at the exact CI head; writing a fixture is not a pass.

Reference mode can explicitly attach that existing finite consumer; the initial
`7ff45204538d7f2baecaf3dde3f843daedeff45f` checkpoint left it disabled. The new
Windows scenario reuses the original production CLI seven-byte admission,
untrusted-TLS rejection and same-queue reopen assertions against schema 2,
in addition to the preserved schema-1 scenario. A synthetic network refusal
does not prove successful file return, associated references or production TLS.
Neither mode is a qualified production installation. Overall
`ready:false`, Agent/desktop unavailable and `transferAutomaticRecovery:false`
remain. No real PC/NAS, model task, installation/update or physical-power-loss
acceptance has been performed.

Positive native transfer TLS remains an explicitly failing CI prerequisite.
The rejected CurrentUser Root import is not retried by these independent commits;
the positive fixture and its assertions remain present and unverified.
