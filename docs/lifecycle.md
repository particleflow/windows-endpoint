# Unified endpoint lifecycle implementation and remaining contract

Automatic recovery must work without an open chat, repeated result queries or a
user clicking a transfer action. This is owned by the **one Windows endpoint's
lifecycle coordinator**, alongside official Herdr and Agenvo process management.
It does not belong to a separately installed transfer server or a duplicate task
queue. The internal `lifecycle.mjs` coordinator now implements bounded component
management. Product activation remains gated; transfer wake is not wired while
the finite status contract is missing. It reports `ready:false` and
`transferAutomaticRecovery:false` explicitly.

## What the inspected hosts actually provide

| Source | Available trigger | Limit |
| --- | --- | --- |
| [Herdr plugin startup](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/docs/next/website/src/content/docs/plugins.mdx#startup-hooks), [implementation](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/src/app/api/plugins/runtime.rs) | One-shot after session restoration/API readiness; again for a new server during live handoff. Existing plugin config/state environment is supplied. | No rerun on client attach, config reload, linking or enabling a plugin. Asynchronous failure does not stop Herdr. The hook is not a supervised daemon. |
| [Herdr event hooks](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/src/api/schema/events.rs) | Workspace/worktree/tab/pane events, including pane exit and Agent status changes. | No idle timer, queue-next-due event, Windows network-restored event or guaranteed event replay in this hook contract. Pane exit does not prove a closed delivery manifest exists. Concurrent plugin commands are capped at 32; a hook can fail rather than wait. |
| [Agenvo connector](https://github.com/Xuanwo/agenvo/blob/a89415e557c415faf5626354f8e87233eb69d877/packages/connector/src/main.ts) | In-process WebSocket reconnect/backoff and heartbeat; status snapshots. | Does not launch/supervise Herdr or call transfer actions. 401/403/426 and terminal socket closes stop network retries and need attention. Restarting the connector must not erase those states. |
| [Agenvo Herdr events](https://github.com/Xuanwo/agenvo/blob/a89415e557c415faf5626354f8e87233eb69d877/apps/herdr/src/herdr-events.ts) | Reconnect native subscriptions and publish `agenvo.resync_required`. | A remote observer notification, not a local transfer wake. A missed subscription needs resync; it cannot be the sole durable wake source. |
| [PR47 plugin](https://github.com/particleflow/Memoh/blob/6ddf61dcd8199758e4110398645c556a3d6d7375/contrib/herdr/memoh-delivery/herdr-plugin.toml) | Finite `collect-result`, `advance-results` and storage-check actions via the official host. | Current manifest contains no startup or event hook. No independent timer or worker is registered. |
| [PR47 nextDue](https://github.com/particleflow/Memoh/blob/6ddf61dcd8199758e4110398645c556a3d6d7375/internal/transferclient/host_action.go), [bounded advancement](https://github.com/particleflow/Memoh/blob/6ddf61dcd8199758e4110398645c556a3d6d7375/internal/transferclient/producer.go) | Existing queue chooses an eligible persisted job, preserves IDs/backoff, serializes workers. `advance-results` performs up to 64 steps on one job and exits within two minutes. | Nothing invokes it when the endpoint is idle. `idle` also covers jobs not yet due; blocked/create-unknown jobs are deliberately skipped. Repeated task queries are a current trigger, not unattended recovery. |

Therefore startup/event hooks can accelerate recovery, but **cannot alone provide
reliable unattended retry**. Putting an endless loop in a one-shot hook would not
give it supervision and would hide the missing endpoint lifecycle owner. No
upstream Agent, Herdr or connector modification is required to resolve this gap.

## Minimum next implementation boundary

The internal coordinator belongs to this same endpoint product. It can initially run in the ordinary interactive user
session; OS login/startup integration is a separate, still unselected deployment
decision. It must be explicit that closing that coordinator or logging out stops
its wake guarantee until the product is started again. No startup/task-scheduler
registration, elevated service or permission change is included here.

The coordinator owns only process lifetime and **wake opportunities**, not
business tasks or transfer state. A wake invokes the existing finite transfer
action through the approved Herdr plugin command path. It never implements
upload/download, allocates delivery/operation IDs, edits a journal, chooses a new
business attempt, or rewrites queue retry budgets. The existing queue remains the
only authority for due selection, leases, retry counters and committed receipts.

Required wake sources, coalesced into at most one outstanding finite invocation
per existing endpoint identity:

1. After endpoint start and Herdr API/plugin readiness, run a bounded reconciliation
   pass on existing durable work. A Herdr startup hook may request the same wake;
   it must not start another coordinator or recreate a task.
2. After an official host restart/live handoff, revalidate the actual session and
   plugin mapping, then resync and wake. PID existence or an old status file is
   insufficient. Herdr session restoration is not proof that old processes or
   business operations survived.
3. After durable admission/completion events, request a wake. Existing pane/Agent
   events can be hints, but the transfer component must validate closed metadata.
4. While the endpoint is running with no open chat, a bounded periodic wake must
   remain available to cover missed events and elapsed backoff. A one-shot timer
   may use an exposed next-due timestamp; a conservative bounded interval is a
   fallback only after error classification is available. The queue checks its
   persisted due times, so this is not a second transfer scheduler.
5. Network/relay availability recovery can request an early wake; it must not
   reset existing queue due times or repeatedly restart a working connector.

Each invocation has an execution/output limit, no overlapping instance, bounded
coalescing, and backoff on host contention. Queue or process exit results are
observations; uncertain completion requires the existing inspect/reconcile
protocol. Update/stop first prevents new wakes, then waits for or cancels the
finite invocation within its documented budget and preserves unknown outcomes.
It must not stop a shared Herdr server or unrelated panes as a cleanup shortcut.

## Interface dependency before implementing unattended wakes

At the inspected SHA, the transfer CLI returns bounded public state but often
collapses an error to `pending_or_unavailable` or `unavailable`. `idle` does not
distinguish an empty queue, a future due time or all jobs being blocked. The
coordinator must not infer authorization or retryability from exit code 1, scan
private queue journals, or treat indefinitely repeated invocation as recovery.

Request the following **bounded public contract from the transfer owner**, without
implementing or copying it in this branch:

- A read-only/versioned queue readiness summary or an equivalent enriched finite
  action result: eligible work / idle-until (when known) / blocked / unknown;
  configuration identity/revision agreement; compact counts with no source paths,
  credentials, payloads or full logs. It must not alter due times or retry budget.
- Stable classes for retryable transport/host-busy versus authentication,
  permission/private-NTFS, configuration/schema mismatch, capacity and uncertain
  commit. Preserve per-delivery proof and let the existing component own the
  distinction; the coordinator only decides whether it may schedule another wake.
- A documented allowed invocation path and completion/result correlation for the
  existing `advance-delivery` action, including multi-session coordination and
  behavior when Herdr restarts while an action is running.

For authentication, revoked authorization, NTFS permission or incompatible config,
surface `needs_attention` and suspend the affected wake/restart circuit until the
existing owner restores it. Do not copy OAuth, repair ACLs, change trust or keep
restarting. Connector auth and transfer-device auth remain separate states under
one device identity; one being connected does not make the other ready.

## Required acceptance for that next milestone

Use an isolated clean Windows environment with a qualified component bundle.
Admit a synthetic transfer, close every chat/UI client, introduce a bounded
network outage, restore connectivity and observe delivery progress with the same
durable IDs **without any result-query requests**. Repeat across host/coordinator
process crashes, missed event hints and elapsed retry due times. Verify one active
worker, no duplicate business attempt, state preservation and a visible suspended
state for authentication/permission failures. The coordinator should recover on
next explicit product start; restart-on-login is not promised until selected and
authorized separately. Process termination is not proof of physical power-loss
recovery. Capacity/log/receipt limits and their evolution remain with the transfer
owner, not this coordinator.

## Implemented component lifecycle

`EndpointLifecycle` owns one foreground instance, with OS-lifetime named-pipe
leases for the device identity, Herdr root/session, and connector root. These
leases accept no commands or data. Herdr API/version compatibility precedes
connector startup. Every child uses the shared `managedEnvironment`, including
removal of inherited NODE_PATH, HERDR_* and AGENVO_* pollution. Launch-plan
`environment` remains only a display overlay and must not be used as a clean env.

Only owned child handles can be stopped. Preexisting hosts and stale locks without
saved ownership proof require handoff; there is no PID-based adoption or kill.
An exited owned connector's exact PID and saved lock nonce are checked before
invoking official `doctor --recover-lock`; the coordinator never deletes its lock.
Herdr uses the official `server.stop` API through `owned-herdr.ps1`. The finite
client verifies the actual named-pipe server PID using Windows
`GetNamedPipeServerProcessId`, checks the official `PID:creation-time` generation,
and sends the request on that same connection. It never resolves a PID to kill or
reopens a session endpoint after the ownership check. Readiness first probes the
owned peer; periodic read-only checks bracket status with generation checks.
PowerShell 5.1 and its standard .NET runtime are OS dependencies; no execution
policy is changed or bypassed. Distribution signing/policy qualification remains
pending. This is a client helper, not a service or Agent/core modification. Windows termination of the owned connector is
not claimed to execute POSIX shutdown handlers; official stale-lock recovery is
part of stopping it. Failed/uncertain cleanup retains the lease and attention.

One coalesced check recovers components in dependency order, after requalification
and unchanged official config fingerprints. Three restart attempts per ten-minute
window are persisted in the endpoint-owned small journal. Offline live connector
network retries remain owned by Agenvo. 401/403, protocol upgrade, config changes,
a published clean connector stop (including credential deletion), unknown host
observations and exhausted budgets suspend component recovery. An
explicit attention acknowledgement never clears the persisted restart budget.
Normal stop waits for an in-progress check and prevents respawn during backoff
and asynchronous requalification. Journal ENOSPC/EACCES never skips owned-child
cleanup: both components are attempted, the original failure/cause is preserved,
and uncertain cleanup retains the OS lease. Failed journal publication is reported
separately from component shutdown.

The coordinator does not submit Agent prompts, pane commands or business attempts.
Official interactive restoration is preserved without rewriting config or forcing
`resume_agents_on_restore=false`. At fixed Herdr 5bd900, the bundled Pi integration
v9 returns for non-TUI session_start (JSON/RPC/print); builtin Pi restore uses
`pi --session` without the original prompt or batch wrapper. Ordinary shell restore
does not replay the old command. These source facts are not proof about installed
old/custom integration or pending tools. Existing business operation/attempt IDs,
ledger and unknown outcomes remain authoritative; lifecycle never redispatches.

## Evidence and current boundaries

The unit suite covers ownership, order, coalescing, persisted budgets, auth and
unknown states, shutdown/backoff and data preservation. Windows CI additionally
assembles unchanged official binaries from fixed archive hashes/npm integrity,
uses a loopback TLS relay with an ephemeral synthetic registration, and exercises
component crashes through the coordinator's own foreground run loop (observation
polls do not drive recovery), original connector network reconnect, real HTTP 401, normal
stop, a lease-holder process death, and restoration of one ordinary shell command
without replay. TLS validation stays enabled; no system trust store is changed.
Results must be read from the exact commit's CI, not inferred from fixture code.
This is no full Agent business/transfer/GUI/physical-power-loss acceptance test.

Locking the desktop does not establish desktop capability readiness. Logging out
stops the ordinary user session; no startup registration or service is installed.
Coordinator process death releases its Windows leases but can leave owned children;
the next start refuses preexisting Herdr and requires handoff. Automatic orphan
adoption, active version switching, rollback and uninstall are not implemented.
The Windows full bundle stays blocked until transfer protocol/artifact qualification
and application/GUI checks are complete. Staging's interruption fixture precreates
pending remnants; it does not inject a crash after every write.

The exact requested read-only transfer interface is in
[transfer-lifecycle-contract.md](transfer-lifecycle-contract.md). It is a proposal,
not an assumed upstream implementation. No transfer/migration source is changed.

## Ownership checkpoint awaiting Windows evidence

The ownership increment adds an actual separate Herdr fixture, wrong-peer stop
rejection, and official live handoff. An exited owned child cannot confer ownership
of its successor; a live host found during recovery requires handoff and is not
adopted. These new checks are **pending until the exact checkpoint's Windows run
passes**. The earlier f79ca696 run proves the preexisting 43 checks and 8+8 official
smoke checks, not this newly added helper or handoff boundary.

Sources: [Herdr Windows generation](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/src/ipc.rs),
[official API](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/src/api/schema.rs),
[Windows peer identity API](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-getnamedpipeserverprocessid).
