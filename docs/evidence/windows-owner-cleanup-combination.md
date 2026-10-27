# Windows owner and retirement source combination

The combined PR6 tree has two exact source parents:

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
