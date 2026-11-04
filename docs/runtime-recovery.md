# Foreground component recovery configuration

The existing product root's `config/runtime.json` accepts an optional
`restartPolicy`. This configures the endpoint-owned component supervisor, not
official Runtime reconnect, Pi task retry, file retry or a new service:

```json
{
  "schema": 2,
  "mode": "existing-installations",
  "transfer": "existing-queue",
  "restartPolicy": {
    "maxRestarts": 5,
    "windowMs": 600000,
    "retryMs": 1000
  }
}
```

Keep the installation's existing `transfer` value and references. Omitting the
policy or its individual fields preserves three restarts per ten minutes with
a one-second base delay. Zero `maxRestarts` explicitly disables crash restarts;
`windowMs` and `retryMs` must remain positive safe integers. Unknown fields,
non-integers and values outside the existing journal/timer representation are
rejected before component execution. The existing journal supports at most 100
restart timestamps; a configured delay multiplied by that policy's maximum
count must fit Node's signed 32-bit timer range. These bounds do not constrain
business task/file quantities or change the journal format.

Each recovery persists its timestamp before component actions, then waits
`retryMs * restartsInWindow`. Normal foreground stop cancels that wait without
respawning or erasing the charged attempt. The owner lease, installation checks,
component generation and existing cleanup/unknown gates still apply. Permanent
authentication, permission, protocol or TLS failures remain explicit attention,
even with a larger policy. A live disconnected Runtime still owns its official
reconnect; the endpoint does not restart it merely for being offline.

The validated request is copied/frozen for one run. Apply a policy change only
through the existing stopped local configuration/normal startup flow; it does
not mutate a live policy, reset persisted counts, clear attention, authorize
handoff or replay a task. A restart reads the original timestamps against the
new window/count. Protected old task/session/queue/receipt and exact
`transfer.json` HostBinding bytes are untouched. Existing setup conflicts remain
explicit and cannot silently overwrite a customized runtime request.

This optional field requires an endpoint source that supports it. Older strict
runtime-request readers reject it; do not represent an old selected program as
supporting this setting or alter an old manifest to make it appear compatible.
There is no automatic queue migration or producer downgrade.

The HC-06 regression exercises the real factory and StateStore with owned inert
Node child processes, plus a separate fresh coordinator process that reads the
persisted state. Its opaque queue/receipt files test non-interference only;
it does not certify producer format compatibility, official Agent execution,
Windows permissions, a NAS connection or production transfer acceptance.
