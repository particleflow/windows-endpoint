# Persistent installation layout

The current archive is a review candidate, not a production installer. It owns
the endpoint program, the source-built Memoh Runtime connector and producer.
Official Pi/Herdr/Node/Git are existing installation references, not adopted
files or extra copies. The review producer bundle also contains identified test
executables. Fully managed prerequisite installation and a production-only
archive remain unimplemented; do not present the candidate as that deliverable.

## One persistent root, explicit native references

Choose a durable product root outside a source checkout, build output, temporary
directory or acceptance script directory. On Windows, the account's native
LocalApplicationData known folder is a suitable parent for an account-owned
installation; the caller supplies the actual root to existing `setup --root`.
There is no hardcoded drive, user name, default migration or new configuration
registry. Existing `endpoint.json` remains the sole reference configuration.

| Role | Existing reference / location for a fresh layout |
| --- | --- |
| Immutable endpoint, connector and producer | `packages/<manifest hash>` |
| Selection transaction | `control` |
| Endpoint and runtime request | `config/endpoint.json`, `config/runtime.json` |
| Host lifecycle / acknowledgements | `data/endpoint` |
| Herdr native config, session snapshots and socket markers | `herdrConfigRoot`, e.g. `config/herdr`; native `sessions/<session>` stays here |
| Herdr plugin state | `herdrStateRoot`, e.g. `data/herdr` |
| Pi profile (including its existing native auth boundary) | `piConfigDir`, e.g. `data/pi` from the existing layout template |
| Runtime enrollment | `connector.enrollmentFile`, e.g. `config/runtime/enrollment.json` |
| File principal config / queue | Existing `transferConfigDir` / `transferStateDir` pair, otherwise original Herdr-derived locations |
| Logs | `logs/host/<run UUID>.jsonl`; limit is per run, not total retention |
| Working files / task archives | User-selected `sourceRoot`; archives currently remain under `.memoh-computer/sessions` and `attempts` there |
| User-owned prerequisites | Existing `programs` references; official installers/updaters retain ownership |

`deployment-layout.json` supplies existing default reference paths. The shared
`hostReferenceLayout` check permits dedicated component data inside `config`
and `data` while reserving endpoint records, selection control, packages and
logs. It preserves canonical-path, reparse-point and existing permission checks.
It grants no access, credential or process ownership.

Use the extracted candidate's normal Node entry:

```text
node endpoint.mjs layout --config REFERENCES.json --root PRODUCT_ROOT
node endpoint.mjs setup --from REFERENCES.json --root PRODUCT_ROOT --source CANDIDATE --manifest-sha256 HASH --transfer existing-queue
node endpoint.mjs deploy run --root PRODUCT_ROOT
```

The layout report reads references, not credential contents or session files;
it does not prove that archives exist. Setup neither enrolls credentials nor
copies profiles nor installs a service. Existing authorization and readiness
checks still apply. Program selection refuses candidates lacking the
`central_component_data` reader capability when this layout is used.

## Existing installations are not silently relocated

Ordinary program update preserves endpoint configuration, enrollment, queues,
workspaces and component state. No production uninstall, old-log rotation or
exports purge is implemented. Unknown files and old packages are retained.
The developer/acceptance scripts outside this repository are not covered by
these preservation guarantees.

Changing an old `sourceRoot`, HostRoot, Pi profile or file principal is **not** a
program update. Existing exclusive configuration, queue binding, task identity,
continuation and compare-and-swap checks remain. Do not edit transfer.json,
move queues, copy credentials or re-root unknown attempts to obtain this layout.
A future authorized relocation must preserve original operation/session/receipt
locators and immutable raw HostBinding bytes; it is not performed by setup.

The NAS task wrapper currently supplies Pi's native `--session-dir` under the
original execution root and `--session-id` with the original identity. This is
why ordinary Pi's default cwd-grouped history does not automatically list these
archives. A separate durable archive root for **new** tasks needs a coordinated
NAS task-layout locator/version, using native Pi flags; old readers must keep
their original paths. This endpoint change does not invent that cross-end field.
For inspection, resolve an existing JSONL first. Pi's native
`--export EXISTING.jsonl NEW.html` exports an existing session without submitting
a model prompt; choose a new output file. Native `--session EXISTING.jsonl`
opens it interactively under the original profile and can write session state,
so it is not a read-only existence probe. Do not use
`--session-id` as an existence check: it may create a missing session.
