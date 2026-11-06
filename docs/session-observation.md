# Historical Herdr sessions: observation and ownership

The refusal at checkpoint `8fbab3b28c3c470f29c613283d1026ad837d2825`
was endpoint policy in `validateInstalledConfiguration`: a saved session had to
be version 3 with no workspaces before component startup. Herdr itself supports
historical workspaces and older snapshot migration. History alone is not damage.
The gate prevents a new host from implicitly resuming unknown work or treating
an external process as one it may stop.

## Native contract and task tracking

The reviewed upstream is Herdr
`5bd900d88c80d95f5b145397e45bbeea398b8165` (0.9.5).
Its [session-state documentation](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/docs/versions/0.9.5/website/src/content/docs/session-state.mdx)
distinguishes detach, restart, screen history and native Agent session restore:

- Detaching retains the original server and pane processes. A server restart
  restores layout and directories, not those original processes.
- Native Agent restore is enabled by default. Eligible Pi references use
  `pi --session <path-or-id>` through the supported integration. Deferred Agent
  restore runs after a client supplies attach context. Missing, stale or duplicate
  references do not prove resumability; fallback shells are possible.
- Snapshots and Agent references do not prove business-task completion, tool-call
  recovery or protection from power loss. Windows live handoff remains unsupported.

The [snapshot parser](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/src/persist/snapshot.rs)
and [restore implementation](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/src/persist/restore.rs)
own format migration and restoration. This endpoint does neither. It does not
change `resume_agents_on_restore`, import NAS Bot history, open Pi session files,
write snapshots or run saved commands.

The existing Memoh producer at
[`4c880e07ecdff1b6caadd86348779603fce9e8aa`](https://github.com/particleflow/Memoh/blob/4c880e07ecdff1b6caadd86348779603fce9e8aa/internal/agenvo/pi_batch_service.go)
creates attempt-specific workspaces/tabs. Its
[Pi batch contract](https://github.com/particleflow/Memoh/blob/4c880e07ecdff1b6caadd86348779603fce9e8aa/internal/agenvo/pi_batch.go)
retains the attempt, Pi session ID, output and result receipt. A visible Herdr
pane or a Pi conversation reference cannot replace that task record. Unknown
attempts must be reconciled by their existing owner, never automatically replayed.

## This diagnostic batch

`node endpoint.mjs doctor --config FILE` retains `ready:false` and exit 2.
The existing schema-2 selection, single-instance and non-default-session
requirements still apply; it does not enumerate arbitrary user sessions.

`history` reads at most 4 MiB of the explicitly selected `session.json` and
projects only counts and format state. It distinguishes absent, current empty,
historical, legacy, newer, unrecognized, invalid JSON, read-limit, path, concurrent
change and access failures. It does not label unread or unfamiliar history
corrupt. Titles, directories, commands, conversation IDs and session paths are
not emitted. A Pi-reference count only observes the expected reference shape:
`restoreEligibility:not_verified`, `businessTasks:not_inferred` remain.

After program/configuration checks pass, `sessionObservation` uses only
`herdr --session NAME status server --json` and, for a compatible running
server, `herdr --session NAME api snapshot`. These
[native read commands](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/src/cli/api.rs)
connect to the existing server without an attach/start operation. Each query has
a 10-second deadline and 2-MiB output limit. The observation checks the CLI's
session-selector echo, protocol, program stability and marker-file consistency.
Official `status.session` is generated from the CLI `--session` selection, not
reported by the server. Windows CLI IPC derives the named-pipe name from the
path without reading the marker's PID/generation bytes. The snapshot contains
no session/PID/generation identity. An unchanged marker therefore proves only
that the file bytes were unchanged across those reads; it cannot establish
that the separate status and snapshot queries reached one server generation.
This is not an atomic freeze or an owned named-pipe stop capability.

Successful observation reports `observed_unowned`, `ownership:not_acquired`,
`stopAuthority:false` and `serverIdentity:not_verified`. Those identity and
authority limits also apply when no server is observed or a query fails.
Diagnostic marker errors are `query_marker_invalid` / `query_marker_changed`,
not claims about a server generation. Only a successful native status response reports
`not_running`; failed/denied queries remain unavailable or permission-denied,
never a claim that the PC is offline. The server continues its normal activity
and may autosave while observed. The endpoint acquires no lifecycle lease and
does not call start, stop, pane execution, attach, restore or delete.

Normal host startup retains the historical-session gate and its prior 64-KiB
empty-snapshot admission boundary. Diagnostic access does not authorize
component management. Transfer behavior and readiness are unchanged.

## Smallest remaining handoff

No producer API change is needed for this read-only batch. A later connection
mode can reuse the existing native status/snapshot interface for external
servers while keeping their lifecycle under the original owner. Starting or
stopping historical sessions is a separate unfinished step: reconcile existing
attempt/session/receipt records, distinguish active/unknown work, and establish
which process this host owns before a controlled stop/restore. Do not infer
permission from a config path or implement it by clearing history, disabling
native restoration or creating another task queue/runtime.

Unit tests use inert files and injected CLI output. The Windows fixture adds a
public doctor invocation against a real official fixture-owned Herdr with one
persisted workspace and an ordinary shell side effect. The fixture owner
separately checks its owned child's liveness, marker bytes and owned-pipe ping,
along with pane identity and no command replay. The doctor itself continues to
report unverified server identity; these fixture-owner checks do not turn its
two CLI queries into an identity-bound observation. The fixture owner alone
performs cleanup. This does not test real Pi session restoration,
phone-to-Agent tasks, user PC history, production authorization or NAS delivery.
Only the exact CI result establishes whether the added native scenario passed.
