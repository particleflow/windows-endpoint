# Requested minimal transfer lifecycle interface

This is an interface request to the existing transfer owner, not an implemented
CLI/action or a second queue. The endpoint currently reports `interface_pending`
and does not invoke transfer work on an inferred retry policy.

Please expose one finite **read-only summary** (suggested existing CLI action
`-action lifecycle-summary`) and the same decision fields on the result of the
existing finite `advance-results` action:

```json
{
  "schema": "memoh.delivery.lifecycle.v1",
  "state": "waiting",
  "next_due_at": "2026-10-22T18:00:00Z",
  "error_class": "none"
}
```

Only four required fields:

| Field | Exact meaning |
| --- | --- |
| `schema` | Exact version literal, rejected on unknown versions. |
| `state` | `due`: existing eligible durable work now; `idle`: no work; `waiting`: existing work is not due yet; `blocked`: owner intervention needed; `unknown`: authoritative outcome not established. |
| `next_due_at` | UTC RFC3339 timestamp for the earliest eligible queue/association retry, or `null`. Mandatory and future for `waiting`; never invent or reset a queue deadline. `idle` is null. |
| `error_class` | `none`, `transient` (network/server retry already governed by the queue), `busy` (another owner/worker), `authentication` (missing/expired/revoked authorization), `permission` (private storage/NTFS access failure), `configuration` (origin/root/digest/schema mismatch), `capacity`, or `unknown`. |

Classification must come from the existing component's typed result, not from
the coordinator parsing stderr or treating exit 1 as retryable. Keep the CLI's
existing delivery/reference fields unchanged; do not include credentials, raw
paths, payloads, full logs, new task IDs or private journal details. The caller
owns one bounded command invocation and correlates only its returned stdout (or
that invocation's Herdr log ID), so no new persistent operation ID is needed.

Summary must be non-mutating: no `ReclaimConfirmed`, admission, journal rewrite,
retry reset, account-auth fallback or credential creation. A summary failure
must return the stable error class or leave the outcome unknown. For a malformed
or missing response the coordinator suspends wakes; it does not guess.

The component still selects the due job, owns concurrency/leases and persists
backoff. The coordinator coalesces startup/event/network/timer hints, invokes at
most one finite existing action, and honors the next due time. A periodic idle
summary covers missed events without a new task queue. `blocked`/`unknown` and
authentication/permission/configuration/capacity stop automatic advancement;
restore through the existing owner before explicit resume. `transient`/`busy`
must carry a bounded next due or a documented finite retry hint, never a reset.

Please document the allowed Herdr invocation and completion/result correlation
for these two finite actions, including multi-session contention and a host
restart during an action. The endpoint does not change transfer code, manifest,
capacity, receipt retention or migrations in this branch.
