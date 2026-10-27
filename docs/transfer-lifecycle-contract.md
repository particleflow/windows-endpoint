# Finite transfer lifecycle interface

The existing finite consumer uses this contract in explicit review mode. Its
production-EXE positive TLS gate and real PC/NAS acceptance remain incomplete.
There is no second queue or legacy compatibility translation. Historical PR56
notes below are source history, not the current producer qualification.

## Closed snapshot capability

Reviewed source `62d27ed995c53f405297eb0069290f3aefba2c51` adds the separate
`advance-snapshots` action. It selects only due, already-admitted private upload
bytes for the original HostBinding. Registered/live sources, downloads, source
collection and producer feedback projection are outside this action.

This action has its own strict response parser. Every accepted response requires
`advance_scope: "retained_upload_snapshots"`. Idle is exactly that scope plus
`state: "idle"`; successful steps carry the original queue status envelope with
`admitted:true` and `registered:false`. They do not carry a lifecycle schema,
deadline or feedback. Ordinary `advance-results` still requires its original
lifecycle and feedback proof. An unsupported binary never falls back to that
general action. The existing inventory/provenance, config/credential, private
directory pair, TLS and producer queue validation apply to every invocation.
Plugin version `0.10.1` alone is not a capability or qualification check.

Only the existing lease owner's latched `herdr_observation_unknown`, with an
unchanged durable lifecycle and no handoff/journal/cleanup uncertainty, permits
this restricted tick. Other attention states remain fenced. The Herdr phase and
attention are not cleared by file progress. Scoped idle/steps stay `unverified`
in the host's global transfer projection, with no global queue-empty or business
completion claim. The existing finite polling interval applies; due selection
and durable retry scheduling remain producer-owned. Known waiting deadlines
are not shortened. Issued-command failures are classified and journaled even
when stop arrives during the command. No second queue, timer or service is added.

This consumer adaptation does not qualify or install a new producer binary.
The package source pin and installed inventory must separately accept the
reviewed capability. No deployed old program/binary is changed by source tests.

The producer exposes one finite **read-only summary** (CLI action
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
| `state` | `due`: existing eligible durable work now; `idle`: no eligible work in the existing queue, **not business completion or discovery of unadmitted results**; `waiting`: existing work is not due yet; `blocked`: owner intervention needed; `unknown`: authoritative outcome not established. |
| `next_due_at` | UTC RFC3339 timestamp (Go emits up to nine fractional digits) for the earliest eligible queue/association retry. Mandatory and future for `waiting`; all other states use `null`. Preserve the original string and round a Node wake up to the next millisecond. Never invent or reset a queue deadline. |
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
authentication/permission/configuration stop automatic advancement;
restore through the existing owner before explicit resume. `transient`/`busy`
must carry a bounded next due or a documented finite retry hint, never a reset.
At producer `648e4511f35fe2ce187509e9823d03c1d2e1d341`, persisted
`waiting/capacity/next_due_at` reuses that deadline without consuming network
retries. Other capacity outcomes still pause. Hints do not shorten its wake.

PR56 at `5e4b883df9e4e8e734722ba3f59abcb3708d56de` documents
`unknown` + `transient`/`busy` + `null` as allowing at most one read-only host
retry after 30 seconds per external event. The consumer implements that bound;
a repeated result requires explicit owner acknowledgement through the existing
endpoint attention mechanism. Polling itself never replenishes this allowance.
`advance-results` adds these four fields to its original delivery/reference
envelope; the consumer validates that separate envelope and projects decisions
only. A reference without confirmed association is not a delivered result.
Plugin 0.9 adds the optional boolean `registered` to this advance envelope.
`registered:true, admitted:false` is durable metadata awaiting finite indexing,
not a delivered result or a new lifecycle state. Older envelopes without the
field remain parseable; the read-only summary remains exactly four fields.
Nonzero `due`/`idle`, unsupported exits, malformed output, timeout or signal
suspend wakes, regardless of any optimistic state field.

The advance envelope must also state `feedback_status`. `recorded` satisfies
the existing advisory-feedback gate but is not business success. `unavailable`
fails with `transfer_feedback_unavailable`; missing/empty feedback fails with
`transfer_feedback_unknown`. Unknown values reject as an unsupported contract.
Producer `0894a6eb8ff69c8796e2da5450fa172d4cd5ef81` (plugin 0.10.1) adds
`not_applicable`, derived only from the validated durable download direction.
The consumer accepts it only at this advisory gate; all other checks remain.

At the earlier 648 producer, an inbound job without a matching outbound
producer-context and a real outbound feedback publication failure both become
`unavailable`. The consumer cannot safely distinguish them from that field.
The 0.10.1 contract separates downloads from outbound missing/foreign context
and actual write failure. The no-work/empty-job case still supplies empty
feedback and remains unknown; it is never relabeled inbound. Preserve original
delivery/reference fields and the four lifecycle fields; do not infer success
from `admitted`, `registered`, phase, exit zero or an absent feedback field.

`official-smoke/feedback-fixture.mjs` executes the packaged EXE with separate
fresh private roots. The existing untrusted TLS fixture yields durable backoff;
it then feeds the real advance stdout to the packaged parser. Inbound missing
context and an outbound feedback target replaced by a fixture-owned directory
now yield `not_applicable` and `unavailable` respectively. The packaged parser
retains inbound backoff and rejects the outbound error, with two non-advancing
process reopens and the outbound file restored byte-for-byte. The failed 766
run and pre-fix 53 checkpoint retain the old-contract reproduction. This is a
negative TLS fixture, not successful inbound delivery. The unchanged source
CLI test dispatcher separately verifies full bytes/hash/reference on NTFS and
completed reopens; its test-only CA is not production EXE system trust.
`inspect` can refresh advisory feedback with its
invocation clock; only `lifecycle-summary` is the non-mutating summary contract.

This is source-level interface alignment only. PR56's first head has a reviewed
corruption/advance failure and failed native CLI test. It is not an accepted
executable. The consumer does not advance its artifact trust pin to that head.

Please document the allowed Herdr invocation and completion/result correlation
for these two finite actions, including multi-session contention and a host
restart during an action. The endpoint does not change transfer code, manifest,
capacity, receipt retention or migrations in this branch.
