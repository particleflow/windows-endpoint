# Windows owner and retirement source combination

The first PR6 combination `2ae308b25028a6dc9b8198c1d5d07e6a6b730cf3` has two exact source parents:

- Retirement head `deeeb51b860e50fc24f66bfb45ea43f58557850f`.
- Windows owner head `c48d2d14bf0f64dc2b1779864eb87672357840db`, including the
  final PiCatalogProvider forwarding fix. Their common ancestor is
  `1537fe39256bd7f208fe3da2b4323c6bf2a9fc04`.

The parent's separately tested local combination
`42194f622fb300cd73619f2a00e21e516e80b0b3` is not published to the remote and
cannot be read back in this workspace. Its reported three passing cases are not
counted as local verification of this tree. This combination is rebuilt from
the two published parents without fetching any later queue-interface work.

## Conflict decisions

- The workflow test list keeps the retirement/startup/diagnostic/writer cases
  and adds the owner's three Pi catalog suites. The removed old probe test is
  not reintroduced. Existing producer/native-host/TLS steps and explicit failure
  gates stay unchanged.
- CLI help adds the owner profile transaction entries while keeping retired
  bundle staging unadvertised. Actual legacy `stage` and schema-1/2 configure
  remain rejected.
- Program deployment combines the native-only early guard and saved legacy
  `status` reader with profile prepare/archive/commit/rollback and Pi catalog
  forwarding. Missing `runtime.json` cannot reopen a retired deployment.
- Test imports and the new owner tests use the existing native fixture and
  explicit runtime-request option. No legacy executing fixture is restored.

Owner profile CAS/reconciliation SDK, bounded health classification and catalog
logic are consumed from their published parent. No new queue interface,
server/SDK contract, authority rule, TLS/network/ACL permission or service is
implemented here. No Memoh repository or release branch is modified.

## Entry and selected-host compatibility

`WindowsEndpoint.ps1` validates PiCatalogProvider and forwards it only through
Run's `deploy run --pi-catalog-provider` argument mapping. The selected native
program receives the binding based on its current configured Pi profile.
Supplying a binding requires the selected host's version-1 capability; an old
selected host without that export still runs without the optional binding and
refuses enablement before discovery. A pending profile transaction continues to
fence startup.

A Windows-only test in the existing product-entry suite exercises the actual
installed PowerShell → Node → selected-host chain with and without the optional
flag, and an old host lacking the capability export. Host wrappers are inert;
no Agent, model, auth resolver or discovery is invoked. Configuration, selection
and synthetic enrollment bytes must remain unchanged. The source fixture now
includes the catalog replacement PowerShell resource used by the real builder.
The catalog foreground fixture also uses native references.

## Local differential checks

Linux / Node24.19.0; counts overlap and are not summed:

- Retirement/startup/diagnostic/writer boundary: PASS 16/16.
- Selected-host forwarding, owner SDK readback, profile preparation/commit,
  ordinary native program changes and old-candidate refusal: PASS 6/6.
- Catalog foreground drain and CLI enablement/refusal: PASS 3/3. The foreground
  case passed again after its fixture changed to native references.
- Selected-host forwarding passed after the package fixture resource update.
- Both new Windows host-wrapper variants compile and emit valid JSON under a
  local inert wrapper check. This is not PowerShell execution.
- Merged workflow YAML/test paths, changed JS syntax, conflict markers, Markdown
  local links and whitespace are checked before committing.

Actual PowerShell entry execution and combined native fixtures remain for the
single existing PR workflow run on the final merge head. Prior CI results belong
to their original heads. No unchanged Go/C# build or full suite was rerun locally.

This is source integration only. Existing HostRoot/exports/unknowns, Pi/Herdr
profiles and independent official installations remain untouched. Formal image,
NAS release and Windows installation are not performed. Independent review,
production Magpie/task association/file authentication/TLS and onsite acceptance
remain separate from source and fixture results.

## Recovery and ACL follow-up in the same candidate

The next source merge `7c8a64b931696cba5bb7a56a65d0aed248a9b667` has exact parents
`2ae308b25028a6dc9b8198c1d5d07e6a6b730cf3` and
`51d4567fbd26cf8bca56180da6ecc92900ff2253`. The owner chain is
`c48d2d14 → 4e84191183808b271d362ee959760d881730c01c → 51d4567f`.
Its tree was identical to the preserved locally tested recovery composition,
which remains in stash `d0a31caad8dc13847f78a539e58be59c30f7875a` and the exported
patch. No unknown data or source changes were discarded to perform the merge.

The exact ACL test correction `f85e65cebfdedb4b69908deff3c8a81d816620b4` is
cherry-picked with provenance as `f31cfbe98bdf1f66dbf25057f4b055df505a851e`;
the rest of its separate catalog branch is not merged. It preserves the ordered
original ACE prefix, owner/group/protection/null-DACL state, permits only appended
byte-identical inherited copies, and rejects extra subjects/masks/order changes.
Production replacement/ACL code is unchanged. The inspection helper's native
Windows PowerShell module path is bound to that subprocess only, with no global
environment or TEMP/TMP change. See [ACL evidence](pi-catalog-acl.md).

Additional local differential results: recovery-related 87/87, retained
retirement/history boundaries 16/16 and the changed stopped-recovery candidate
manifest assertion in one deterministic packaging test pass. These overlap the
previous local checks. The ACL assertion's pure rejection/normalization test
passes locally; actual Windows fixture execution still belongs to the exact-head
existing CI. No old seven-group Windows checkpoint is substituted for it.

### Compatibility gate before any onsite handoff

- Installed `57ae131` accepts only status/stop. Never send or probe
  `recheck-herdr` there: unknown input requests a stop. Herdr version does not
  identify the endpoint stdin protocol. Keep its original controller/channel.
- The new supported running-host command requires the original live ownership,
  unchanged program/configuration, same PID/generation and verified pipe peer,
  expected native status, clear connector/file attention and journal CAS. It
  changes observation state only. A later ordinary tick can resume the existing
  finite consumer; this is not queue-closure or business-completion evidence.
- If the old host is already safely controlled-stopped under the existing task
  and owner boundary, only the reviewed new entry may perform offline recovery
  with original run/config/state hashes, truthful stopped/observation status,
  proven original process absence and unchanged session/attempt evidence. Live
  or unknown processes, changed evidence or a handoff keep it blocked. No forced
  Pi stop or current journal edit is authorized by this source integration.
- Preserve original journal/status, exact before-recheck backup, unknown
  receipts, exports, queue identity, RootHash and raw HostBinding. No business
  replay or automatic resume follows infrastructure recheck.
- A compatible program update after this stopped checkpoint requires
  `native_stopped_observation_recovery`. Rollback to a reader without it remains
  rejected; never remove recovery fields, clear attention or rewrite history to
  make an older program selectable.
- Only one reviewed combined artifact containing retirement, both recovery
  commits and ACL correction can proceed to a separately approved onsite
  handoff. The older 2ae artifact and owner-only 51d artifact are not that result.
  Closed-only queue source consumption is still owned elsewhere and is not
  included or declared complete here. Formal image/NAS release and Windows
  installation remain unperformed.
