# Existing owner control path and the remaining host boundary

This inspection uses Memoh `acdb3c7aba0931929243921271abbb63afc54024`,
Agenvo `a89415e557c415faf5626354f8e87233eb69d877` (0.2.0), and Herdr
`5bd900d88c80d95f5b145397e45bbeea398b8165` (0.9.5). It adds no runtime,
credential, permission, admission policy or stop method.

## Existing authenticated direction

The usable direction is Memoh owner -> existing MCP connection -> Agenvo relay
-> approved device/instance -> official Herdr terminal -> finite endpoint CLI.
There is no need to give Windows a new NAS account or to reuse file credentials.

- Memoh `internal/agenvo/service.go`, `Client` / `resolve`: resolve the original
  Bot mount under `workspace_exec`, current grant, runtime owner and owned HTTP
  MCP connection; honor `PinRegistration`. `Client` captures that owner and
  rejects an owner change on subsequent resolution.
- Memoh `internal/agenvo/client.go`, `relay`: recheck the expected Target before
  each call; use the existing owner's `execute` MCP tool with JSON-encoded
  `call({deviceId,instanceId}, method, params)`. Its existing transport owns OAuth
  refresh. Network uncertainty is not retried as a new command.
- Agenvo `packages/relay/src/core.ts`: require the live grant and approved
  instance fingerprint before routing. `packages/connector/src/main.ts` checks
  instance/fingerprint again and rejects duplicate request IDs on the current
  connection. This is not durable exactly-once delivery across reconnects.
- Agenvo `apps/herdr/src/herdr.ts`: `pane.run` accepts
  `{session,paneId,command}` (command <=48,000 characters); `pane.read` accepts
  `{session,paneId,lines,source}` (1..500 lines). `pane.get` supplies current
  workspace/pane/terminal metadata. `accepted` means native input was delivered,
  not that the endpoint command completed or an upgrade succeeded.

This is already used by Memoh `AdvanceBatchDelivery` in
`internal/agenvo/pi_batch_producer.go`: after checking the original control pane,
it invokes the finite Herdr plugin command through `pane.run`. Agenvo does not
advertise a generic `plugin.action.invoke`, `server.stop` or `host.stop` method;
calling those names returns `unsupported_method`, execution `not_started`.

## What can reach the endpoint today

The existing packaged command `node endpoint.mjs host status --root DIR` can be
run through that terminal path. It reads the existing bounded host-status file;
its run ID, PID and cache age are observations, not stop authority or a proof of
native generation. Program/root paths must come from the configured installation,
not model text or PATH discovery. A dedicated control pane must be created and
persisted by the original owner; labels cannot recover ownership. Task/Pi panes
must never receive host control commands.

`host.mjs` currently accepts only status/stop on its foreground stdin and local
process signals. A command started in another Herdr pane has no handle to that
stdin. There is no host IPC receiver, remote stop command or plugin action to
forward a handoff. Running a second `host run` is rejected by the existing lease;
it is not an attachment operation. Killing the host by an observed PID would
discard these boundaries and is not an alternative.

The original owner can therefore use its existing authenticated connection for
delivery; it cannot yet perform a verified stop/version switch. The child
command does not receive an independently verifiable Memoh principal from
Agenvo. Local JSON claiming an owner or containing `reconciliation` must not be
treated as authentication or as an admission fence.

## Minimum coordinated next change

Memoh owns the missing admission fence, physical-target alias coverage and
operation revision set described in its reconciliation document. Its existing
owner/relay layer should issue the fixed command only while that fence remains
current. No new task IDs, receipts, Bot approvals or transfer credentials are
needed. Reconciliation remains an observation, not permission to stop.

On this side the remaining implementation belongs in `host.mjs`'s existing
foreground lifecycle and `endpoint.mjs`'s CLI dispatch: a local handoff receiver
and a finite sender, bound to the exact host run/configuration and original
native ownership, with a durable acknowledgement in the existing lifecycle
journal. This is not implemented by the transport test. Its accepted input and
acknowledgement fields must be agreed with the Memoh fence owner before enabling
stop. Nothing should accept a guessed gate schema or a user-supplied approval
flag. No new listener is opened in this increment.

Stopping the connector/Herdr also removes the terminal response channel. The
owner must distinguish delivery, durable acceptance and confirmed post-restart
observation; a missing response remains unknown, not permission to replay Pi or
send another stop. Existing `recovery_reader` remains solely operation-owned.
Herdr's get/run pair has no atomic expected-generation guard, so checking pane
metadata does not justify claiming that race has been eliminated.

## Verification scope

`official-smoke/owner-control-fixture.mjs` extends the existing extracted-candidate
Windows fixture. A synthetic loopback relay sends actual protocol calls to the
unchanged official connector and Herdr. It checks unsupported methods, wrong
fingerprint refusal, one finite invocation of the packaged host-status command,
the same host run/PID, original pane identities, and duplicate-request rejection.
Only the test owns the fresh control workspace. Existing fixture shutdown owns
cleanup; there is no search-by-label or external-process stop.

The local tests cover request/connection correlation and bounded uncertain
outcomes without retransmission. Windows execution must be reported with the
exact head/run; a local test pass is not native evidence. Neither test exercises
Memoh OAuth/grants, the real relay's approval path, admission fencing, actual
task recovery, a stop handoff, or production PC/NAS traffic. The existing
production-EXE positive TLS gate remains separate and unchanged.
