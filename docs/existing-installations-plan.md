# Referencing existing official installations

Only endpoint schema 3 qualifies or executes existing official Memoh Runtime,
Herdr, Pi, Node and Git. Use the [native configuration sample](../packaging/endpoint.native-runtime.example.json)
and [candidate instructions](../packaging/README.md). Official installers and
package managers retain ownership of prerequisites; the endpoint neither copies
them nor installs another provider, OAuth client or service.

## Native qualification and diagnostics

`validateInstalledConfiguration` checks the selected native references and
existing enrollment metadata without reading its contents. It resolves the
explicit official Herdr installation, reads the saved session projection and
requires a valid ordinary-session continuation checkpoint before restoring a
nonempty layout. Unknown Agent/task state remains a handoff boundary.

`inspectPrograms` verifies the selected program bytes, package identity, version
and required CLI flags. It requires `@memohai/runtime` and its fixed-source
endpoint session-factory entry; no old connector `--version` or instance mapping
is used. Pi launcher resolution is checked inside the controlled Git Bash
environment, including sibling Node and injected-environment rejection. Native
Runtime enrollment is loaded only by the official Runtime when it runs.

For the recognized official Herdr `packages/standalone/releases` layout, a fresh
check resolves `current` to the selected canonical release inside `releases`.
The running owner retains the link and program fingerprints; a selection or
same-path payload change suspends it. A clean fresh check may follow an official
update. No endpoint update, diagnostic or old configuration edit changes the
official selection or adopts an external process.

The native `doctor` reports local program/protocol checks separately from saved
history, unowned live session observation, native identity and file-principal
mapping. A successful local check never grants stop authority, makes the PC ready
or authenticates the NAS. Live session queries use the explicit native Herdr
reference and validate bounded status/snapshot responses; uncertain protocol,
marker or program changes cannot establish a server identity.

## Retired configurations are history only

Schema 1/2 remains decodable for original path, identity, manifest, continuation
and receipt compatibility. `doctor` on either schema returns
`mode:retired-history-only`, `versions:null` and a blocked
`legacy_execution_retired` check. It may project the saved Herdr/Pi session
snapshot through the bounded history reader. It does not read old credentials,
instance configuration or status.json, query a server or launch an old program.

Direct qualification, transfer qualification and live-session observation APIs
reject those schemas before resolving private references. The old approved
instance resolver, OAuth relay/config validation, legacy connector version probe
and migration-by-omitting-Herdr hint have been removed. An old online/auth error
snapshot is not current diagnostic authority. The foreground observer also
ignores old auth/status paths. It checks native enrollment metadata only; it
does not read a credential to report presence.

Do not change a saved schema number or copy an old device ID into native
configuration. Existing unknown operations and raw HostBinding/RootHash values
remain under their original identities. [Read-only handoff status](host-handoff-journal.md)
and saved session readers remain available without starting a component. The
[retirement handoff](agenvo-retirement-followup.md) records their exact purpose.

## Producer and update boundaries

The native profile keeps the original work directory, Pi configuration and
explicit producer location/config/state pair. A direct-CLI pair must be complete
and cannot overlap protected program or unrelated component state. Its existing
Herdr delivery hook must be absent or disabled; diagnostics only observe that
setting. Native references without the explicit pair keep the original matching
plugin-registration checks. Neither mode edits registration, queues or credentials.

The finite producer still owns its bytes, provenance receipt, source/API binding,
private credential and journals. Qualified references are fingerprinted before
finite calls; a replacement package or self-consistent new receipt cannot be
accepted silently by a running consumer. The endpoint supplies no new file
principal, TLS route, queue identity or delivery attempt. Control authentication
and file authentication remain separate, and their unverified mapping is visible.

Program deployment preserves configuration and official installations. Changed
profiles, Pi roots, Herdr roots or work directories are not ordinary program
updates: they can change task fingerprints and strand original locators. The
current `.build` Pi/Herdr/HostRoot migration has not happened. No data or
credential move is authorized by this document or by a passing source test.

The new diagnostic regression evidence applies only to its recorded source
commit. The earlier Windows candidate `1537fe39` has not consumed these cleanup
commits. Native packaged upload/authentication/TLS acceptance, current Windows
fixture execution and actual PC/NAS acceptance remain separate open gates.
