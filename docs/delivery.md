# Windows native program delivery

The supported execution path is official Memoh Runtime → official Herdr/Pi.
The endpoint coordinates existing installations and their original references.
It does not install an Agenvo connector or restore the retired OAuth/provider path.

Use the stable `WindowsEndpoint.ps1` installation entry described in
[packaging](../packaging/README.md). Its `control` entry, immutable program
`packages`, and persistent `config`, `data` and `logs` have separate ownership.
Existing official Pi/Herdr/Node/Git installations remain independently owned.

| Entry | Boundary |
| --- | --- |
| `configure --from FILE --root DIR` | Exclusively save complete schema-3 references to `config/endpoint.json`; root/config directory must already exist. No credentials, identities or component roots are created or moved. |
| `configure --from FILE --config FILE` | Save complete native references exclusively, outside component-owned locations. Refuse an existing destination. |
| `doctor --config FILE` | Native inventory/protocol checks and separately reported authentication limits. For old configurations, bounded saved-history projection only, with activation blocked. |
| `deploy install/update/rollback` | Native program candidate selection under original leases and retained-work checks; official program/config/state roots remain unchanged. See [transactions](deployment-transactions.md). |
| `deploy status` | Native inventory, or saved selection/pending records for a retired configuration. Historical status does not stage, recover or launch an old program. |
| `host handoff-status` | Read an original durable acknowledgement. No stop, replay or retry authority follows from a cached observation. |

The old public `stage` command, schema-1 path-generating configure, and schema-2
configure/deployment mutation paths return `legacy_execution_retired`. Native
candidate staging uses only `candidate.json` and requires native Runtime
provenance; `bundle.json` has no product staging adapter. Saved legacy
configuration, manifest and receipt readers remain for exact history/diagnostics.
They do not turn historical data into a new installation or execution request.

Current boundaries are documented in [explicit runtime](explicit-runtime.md),
[foreground host](foreground-host.md), [handoff journal](host-handoff-journal.md)
and [retirement follow-up](agenvo-retirement-followup.md). Original unknown
operations, RootHash, raw HostBinding, Pi sessions and source exports must retain
their original identities and locations. An update never invents a handoff.

Source tests and isolated Windows fixtures do not qualify real PC/NAS operation.
Native packaged transfer upload/authentication/system-trust TLS, active-task
handoff and onsite migration still require their own evidence. The explicit
failure gates remain; see [TLS evidence](positive-tls.md). No production rollout
or existing user installation is authorized by these instructions.
