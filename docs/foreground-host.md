# Foreground host

This is a runnable local host entry in the existing endpoint, not an installed
Windows service or a qualified product bundle. It owns a single foreground
process, observes configuration and writes bounded diagnostics. Real component
activation remains unavailable pending complete qualification and connection
authorization. The public CLI cannot enable synthetic components or override
qualification with a config flag, environment variable or command argument.

## Run and observe

Use an existing, absolute, canonical directory as `DIR`. The host rejects linked
directory ancestors. With an approved Node executable, run:

```sh
node endpoint.mjs host run --root DIR
```

The existing Windows bootstrap also forwards these arguments:

```powershell
& ./endpoint.ps1 -NodePath $ApprovedNodePath -NodeSha256 $ApprovedNodeSha256 host run --root $EndpointRoot
```

The bootstrap verifies the supplied Node hash and clears Node injection variables.
It does not install Node or change PowerShell policy. The direct Node command is
the development entry and assumes the caller controls that runtime/environment.

Keep the foreground process's stdin open. In that same input stream, each command
is one JSON line:

```json
{"action":"status"}
{"action":"stop"}
```

Only these two actions are accepted. Unknown fields/actions or a buffered input
over 1 KiB cause a controlled stop without echoing input. EOF, SIGINT and SIGTERM
also request a drain. Windows forced process termination does not promise signal
handlers or cleanup; the controlled stdin command is the tested graceful path.
There is no HTTP/TCP command server, remote command execution, service registration
or scheduled task. A second host for the same root fails with
`endpoint_already_owned` without replacing the first host's observation.

From another process, read the last snapshot:

```sh
node endpoint.mjs host status --root DIR
```

This command does not probe a PID or prove liveness. It labels the disk snapshot
`cached`, or `stale_unknown` after five seconds (also on a future timestamp).
Even a fresh snapshot always has `ready:false`, `desktop:unavailable`,
`agent:unavailable_unqualified` and `transferAutomaticRecovery:false`.

## One root and explicit unavailable states

The host creates only its data/log directories; it never creates credentials or
fills in identity/configuration values. It reads `config/endpoint.json` and checks
the same schema as the existing delivery CLI. The mutable paths must agree with
`deployment-layout.json`, resolved under this root:

| Location | Purpose |
| --- | --- |
| `config/endpoint.json` | User-supplied component references and existing identities |
| `config/herdr`, `config/agenvo` | Existing official component configuration |
| `config/herdr/plugins/config/memoh.delivery` | Existing transfer plugin configuration |
| `data/exports`, `data/herdr`, `data/pi` | Source exports and official state |
| `data/herdr/plugins/memoh.delivery` | Existing producer journal, never rewritten by the host |
| `data/endpoint/lifecycle.json` | Reused coordinator attention/phase journal |
| `data/endpoint/host-status.json` | Atomic, schema-checked host observation |
| `logs/endpoint-host/<run-id>.jsonl` | Bounded state-change log for one run |

`deploymentReferences(root, existingReferences)` produces these references in code;
it does not generate credentials or approve a bundle. The older delivery example
with separate roots is not a host configuration. The offline package selection is
not consumed by this host. Bundle verification is read-only and does not establish
the missing component qualification.

Missing config is `host_configuration_missing`; invalid config and changed config
are distinct attention states. A config edit requires stop/restart and never hot
reloads identities or component roots. Missing/invalid bundles remain unavailable;
a valid inventory still remains `unavailable_unqualified`. Missing credential
metadata or a fresh matching 401/403 observation is `authorization_required`,
not machine offline. Credential contents are not read. Existing credential
metadata alone is only `authorization_unverified`, not authorization success.

The status `phase` describes this host process. A running host with missing config
is useful for diagnosis, not PC capability readiness. `componentLifecycle`, when
present in tests, separately describes the reused coordinator. Public production
status reports `host_process_only` evidence and
`transfer:not_included_pending_qualification`.

Snapshots and log events exclude configured addresses, identities, paths, credential
contents, arbitrary component output and task payloads. State-change logs stop at
64 KiB per run and report `capacity_reached`; they are retained with no automatic
cleanup, so cumulative retention requires a future owned-file policy. Unknown or
linked status files are preserved and cause failure. Leftover atomic-write temporary
files are retained. This is not a physical power-loss durability guarantee.

## Drain and restart boundaries

The wrapper uses `EndpointLifecycle` and its existing ownership and finite transfer
consumer interfaces. It does not introduce another queue, task identifier, component
watchdog or transfer service. Stop signals the existing lifecycle immediately,
then waits for startup/ticks/finite commands to settle. In-flight failures remain
attention and persist before owned cleanup. Unknown tasks are never recreated or
replayed. An existing lifecycle journal with attention or a non-stopped phase blocks
component startup; there is no public acknowledge/reset command in this batch.

If owned cleanup is unconfirmed, the host reports `stop_failed`, retains its lease
and local control channel, and allows an explicit stop retry. A concurrent status
write failure must not abandon that ownership. The host never kills another PID
to force cleanup. Windows lifetime pipe leases disappear on process death. Unix
development socket leases fail closed after a crash; only tests remove the known
sockets of their already-observed-dead fixture process.

Clean stop returns zero, including a host started without config. Attention or
failed shutdown returns exit code two after confirmed cleanup. While cleanup is
unconfirmed, the foreground process stays alive; it does not falsely report a
successful shutdown. External forced termination bypasses those guarantees.

## Evidence and remaining dependencies

`host.test.mjs` starts actual Node host processes in isolated Unicode/space paths.
The separate `test-support/host-runtime.mjs` injects the existing lifecycle with
inert child processes and mock finite command results. These fixtures exercise
single-instance ownership, startup/stop crossings, component crash/recovery,
authorization rejection, in-flight failure drain, restart gating, unknown transfer
outcomes, failed cleanup, corrupt observations and abrupt host death. They are not
Herdr/Agenvo/transfer binary qualification or NAS/NTFS integration evidence.

The existing official Windows dependency/lifecycle job remains separate. Its
coverage does not make this new host a qualified real-component launcher. Needed
before activation: complete supported artifact handoff and qualification, approved
official runtime paths, connection authorization and real executable integration.
Agent pending-tool recovery, automatic transfer wakes, active updates/rollback,
desktop GUI/session behavior and physical power-loss/capacity acceptance remain
unimplemented or unverified. No service, production PC or NAS is used by these tests.
