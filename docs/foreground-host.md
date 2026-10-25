# Foreground host

This is a runnable local host entry in the existing endpoint, not an installed
Windows service or a qualified product bundle. It owns a single foreground
process, observes configuration and writes bounded diagnostics. The default
remains observation-only; [explicit runtime review](explicit-runtime.md) adds
inventory-verified official component startup and an existing-queue consumer.
Release qualification and production connection authorization remain separate.
The public CLI cannot enable synthetic components or override verification.

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
`control` records the observed stdin state (`stdin_open` or `stdin_closed`);
older schema-1 snapshots report `unverified`. Like the phase/PID, this cached field
does not prove that a control channel is still reachable.

Use the existing `endpoint.ps1` in a visible foreground PowerShell session and
keep that session open. It inherits stdin/stdout/stderr and returns the actual
Node exit code; it does not detach a process or install a service. After it returns,
retain `$LASTEXITCODE` in that same session. A temporary caller that closes its
pipes or discards its process result can still lose its own exit evidence.
Do not pipe a one-shot input into a host intended to remain running: EOF is a
graceful stop request. While it runs, stdin accepts only the two JSON actions above.

## One root and explicit unavailable states

The host creates only its data/log directories; it never creates credentials or
fills in identity/configuration values. It reads `config/endpoint.json` and checks
the same schema as the existing delivery CLI. In schema 1 (bundle review), the
mutable paths must agree with `deployment-layout.json`, resolved under this root:

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

Fill the non-path placeholders in `endpoint.example.json`, then use
`node endpoint.mjs configure --from FILE --root DIR`. The existing root and its
`config` directory must already exist. This writes `config/endpoint.json`
exclusively, using `deploymentReferences` and `deployment-layout.json` for every
schema-1 component path. The example is an input template, not a runtime config.
Explicit paths in an existing input must match the selected root or configuration
is refused; choosing another root does not relocate any existing state. The
command does not generate credentials, create component directories or approve
a bundle. The legacy `--config FILE` form still saves fully specified references.
The offline package selection is
not consumed by this host. Bundle verification is read-only and does not establish
the missing component qualification.

In schema 2 ([existing official installations](existing-installations-plan.md)),
only the endpoint's own configuration, lifecycle/status journal and host logs use
this root. Official programs, Herdr/Pi/Agenvo configuration, source exports and
the existing transfer journal remain at their explicitly referenced locations.
Those references must not overlap the host's config/data/log directories; the
component data/program separation checks also remain in force. Do not copy user
configuration or historical sessions into the schema-1 layout to use this mode.
Reference acceptance does not grant ownership of an external process or permission
to resume a historical task.
The same `configure --from FILE --root DIR` command accepts full schema-2
references, saves their existing paths unchanged and checks that they do not
overlap the host-owned config/data/log directories.

Missing config is `host_configuration_missing`; invalid config and changed config
are distinct attention states. A config edit requires stop/restart and never hot
reloads identities or component roots. Missing/invalid bundles remain unavailable;
a valid inventory without an explicit request remains `unavailable_unqualified`. Missing credential
metadata or a fresh matching 401/403 observation is `authorization_required`,
not machine offline. Credential contents are not read. Existing credential
metadata alone is only `authorization_unverified`, not authorization success.

The status `phase` describes this host process. A running host with missing config
is useful for diagnosis, not PC capability readiness. `componentLifecycle`, when
present, separately describes the reused coordinator. The observation-only mode
reports `host_process_only` evidence and `transfer:not_included_pending_qualification`;
the explicit native mode and its narrower readiness states are described separately.

Snapshots and log events exclude configured addresses, identities, paths, credential
contents, arbitrary component output and task payloads. State-change logs stop at
64 KiB per run and report `capacity_reached`; they are retained with no automatic
cleanup, so cumulative retention requires a future owned-file policy. Unknown or
linked status files are preserved and cause failure. Leftover atomic-write temporary
files are retained. This is not a physical power-loss durability guarantee.

The same run log now records `stopTrigger` (command, EOF, signal, invalid input,
observer failure or lifecycle/observation failure). A `foreground_result` records
the controlled return code before closing the log, separately from the launcher's
actual OS exit code. An unexpected JavaScript process exit while the log is open
records `process_exit`, its exit code and an allowlisted exception type/origin.
This observer does not intercept the exception, release ownership or restart work.
The last 2 KiB of the existing 64-KiB per-run cap is reserved for terminal evidence.

Owned component diagnostics contain PID, observed exit code/signal, process-error
flag, stderr byte count and a fixed classification where supported. One previous
generation per component is retained so replacement cannot erase its exit summary.
Herdr/legacy stderr is deliberately `unclassified_stderr`: arbitrary child text,
error messages/stacks, arguments, environment, addresses and credentials are not
copied to the host log. These summaries are diagnostic evidence, never stop or
replay authority. Windows TerminateProcess, SIGKILL, power loss and an unwritable
log cannot guarantee a final record. Missing final evidence remains unknown;
this patch cannot reconstruct an earlier launcher's discarded output/ExitCode.
Logs and status remain in the existing host root, created by the foreground
account under that root's current permissions. Read them using the same authorized
identity; the endpoint does not impersonate another user, change ACLs or provide an
alternate privileged reader. An OS access denial still blocks that observation
and cannot be treated as permission to restart, clear the journal or take ownership.

## Drain and restart boundaries

The wrapper uses `EndpointLifecycle` and its existing ownership and finite transfer
consumer interfaces. It does not introduce another queue, task identifier, component
watchdog or transfer service. Stop signals the existing lifecycle immediately,
then waits for startup/ticks/finite commands to settle. In-flight failures remain
attention and persist before owned cleanup. Unknown tasks are never recreated or
replayed. An existing lifecycle journal with attention or a non-stopped phase blocks
component startup; there is no public acknowledge/reset command in this batch.

If owned cleanup is unconfirmed, the host reports `stop_failed` and retains its
lease and failure journal. An explicit stdin stop retry is possible only while
`control:stdin_open`. EOF sets `control:stdin_closed`: that stream cannot be reopened
or used for another stop command. The host remains alive holding ownership, but
this batch provides no replacement control connection or guaranteed Windows
graceful recovery for EOF plus failed cleanup. The existing signal handlers remain;
delivery and semantics depend on the platform, and forced termination is not a
graceful retry. No automatic retry/replay, lease release or task deletion is used
to hide this unresolved boundary.

A concurrent status write failure must not abandon ownership. The host never
kills another PID to force cleanup. Windows lifetime pipe leases disappear on process death. Unix
development socket leases fail closed after a crash; only tests remove the known
sockets of their already-observed-dead fixture process.

Clean stop returns zero, including a host started without config. The first
terminating error is recorded separately from configuration observations: early
invalid/oversized stdin still returns two even if startup later finds no config,
and an error arriving during a clean drain cannot be silently discarded. Attention
or failed shutdown returns exit code two after confirmed cleanup. While cleanup is
unconfirmed, the foreground process stays alive; it does not falsely report a
successful shutdown. External forced termination bypasses those guarantees.

## Evidence and remaining dependencies

`host.test.mjs` starts actual Node host processes in isolated Unicode/space paths.
The separate `test-support/host-runtime.mjs` injects the existing lifecycle with
inert child processes and mock finite command results. These fixtures exercise
single-instance ownership, startup/stop crossings, component crash/recovery,
authorization rejection, in-flight failure drain, restart gating, unknown transfer
outcomes, failed cleanup, corrupt observations and abrupt host death. The inert
fixture children voluntarily exit on parent IPC disconnect; `NativeDriver` has no
equivalent guarantee. This test proves stale observation and restart gating only,
not absence of surviving Herdr/Agenvo processes after host termination. That real
component outcome remains unknown. These fixtures are not
Herdr/Agenvo/transfer binary qualification or NAS/NTFS integration evidence.

The regression checkpoint `49d9040` retains the `b589549` host implementation with
four added failing tests. A fixture-only config-read barrier makes early invalid,
oversized and invalid-after-clean-stop input reproducibly return the incorrect
zero exit status; the EOF test also demonstrates missing closed-stream reporting
while ownership and the failed lifecycle journal remain held. The fix separates
the first terminating error from config observations and reports stdin closure;
it does not add a new recovery control protocol.

Windows CI at `2024533` ([run 39892964425](https://github.com/particleflow/windows-endpoint/actions/runs/39892964425))
failed two host cases although Linux passed. The diagnostic checkpoint `2dc1a53`
([run 39893646453](https://github.com/particleflow/windows-endpoint/actions/runs/39893646453))
keeps the original fixture identities and strengthens startup assertions: both
original failures explicitly report `endpoint_already_owned`. Its controlled
Windows experiment holds the same device lease in another directory, verifies
rejection before component launch, checks that stopping the rejected host preserves
the owner, then verifies startup after that owner releases its own lease.

The host and deployment fixtures had shared one constant device UUID across
concurrent test files. Windows device leases use a machine-wide named pipe;
Unix development sockets include the state directory and did not expose that
collision. Independent fixtures now use distinct synthetic device identities,
retained across each fixture's restarts. A regression holds a deployment lease
while two independent hosts run concurrently. It failed with one distinct identity
instead of three before the fixture fix. Production lease keys/paths and host code
are unchanged; no lock deletion, serial test mode, skipped cases or weaker ownership
assertions are used. Synthetic identity generation is not production registration.

The existing official Windows dependency/lifecycle job remains separate. Its
coverage alone does not qualify the public host. The new explicit runtime job
covers that entry with native components; it still requires approved official
runtime paths, existing credentials and local inventory verification, and does
not confer release qualification or production connection authorization.
Agent pending-tool recovery, automatic transfer wakes, active updates/rollback,
desktop GUI/session behavior and physical power-loss/capacity acceptance remain
unimplemented or unverified. No service, production PC or NAS is used by these tests.

## Explicit recheck after an observed coordinator failure

`host recover --root ROOT --expected-run UUID --expected-state-sha256 HASH
--expected-configuration-sha256 HASH` is a finite **native Windows** infrastructure
recheck, not a task resume, process stop or journal reset. Only the exact
`needs_attention/herdr_observation_unknown` case is eligible, with no handoff.
Use the original reviewed configuration and run; do not infer identity from a
label, a missing PID or an idle queue. The configuration hash is SHA256 of UTF-8
`JSON.stringify([rawEndpointJson, rawRuntimeJson])`; the state hash covers the exact
original lifecycle bytes. The original normal Windows identity is used to inspect the configuration,
runtime request, lifecycle and status files. File-owner principals follow the
fixed official Runtime's Windows policy (current user, SYSTEM, Administrators,
TrustedInstaller); untrusted file writers are rejected. Permission failures
remain failures; this command changes no ACL and does not bypass a denied read.

The command holds the existing host/component/deployment leases, rechecks official
program/configuration inventory, requires the cached original host PID to be
absent, rejects referenced Herdr/Runtime/Pi processes, and requires the official
Herdr status command to return `running:false`. Unknown process visibility fails
closed. Ordinary shell snapshot bytes may be retained; managed Agent/launch
history still requires handoff. No old workspace is claimed to be alive.

Before publication it rechecks the exact configuration/status/journal bytes,
ordinary snapshot and original attempt-file hashes. It fsyncs a byte-identical
`data/endpoint/lifecycle-before-recheck-<original-sha256>.json` backup, then uses the
existing atomic journal publication. The journal records the original reason,
run/configuration/attempt hashes and `businessReplayed:false`. A lost result is
checked by repeating the same expected evidence; `already_rechecked` performs no
second state transition. Write failures can have unknown publication outcomes;
inspect that same record before any next action. Original unknown tasks, receipt,
Pi session, queue and source files are not edited, moved or replayed. There is no
automatic rollback/reset command; the retained original bytes support diagnosis
without granting permission to erase later work.

Success means **infrastructure rechecked, no process started**. Explicit foreground
start remains separate, through the existing selected program and same HostRoot.
Deployment update still retains `task_handoff_unverified` for original attempts;
this acknowledgement does not authorize an active-task upgrade or stop. Business
continuation uses the original NAS operation/attempt and its authenticated resume
entry, after the original Runtime connection is restored. The CLI never calls it.
