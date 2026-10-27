# Product installation entry

`WindowsEndpoint.ps1` is one installer / stable foreground entry implementation,
not an official-component installer or a new background service. The current
artifact still has `not-for-production-release` qualification. **Install without
`-ReviewCandidate` refuses before executing installation code.** Production
release qualification and the existing positive TLS gate are not changed by
this feature. Do not distribute the review ZIP as a qualified production installer.

## First installation

From an extracted, hash-verified candidate, in the normal authorized account:

```powershell
& $Candidate/WindowsEndpoint.ps1 -Action Install -ProductRoot $ProductRoot -References $References -ManifestSha256 $ManifestSha256 -ReviewCandidate
```

`ProductRoot` is selectable; if omitted the Windows LocalApplicationData known
folder plus `NAS-Assistant` is used. No drive/user name or checkout is assumed.
`References` is the existing schema-3 endpoint reference configuration, containing
the already authorized identities and paths. It contains no inline credentials.
Missing grants/profiles remain missing prerequisites, not invented credentials.
Use `-NodePath` to select the existing official Node executable explicitly; when
omitted only the existing `node.exe` application on PATH is detected. No software
is downloaded or installed by this discovery.

The installer verifies the package, composes existing setup/deployment
transactions, and publishes `control/WindowsEndpoint.ps1` with a durable
`control/installation.json` preparation/completion receipt. Unknown or changed
entry files are retained and rejected. An interrupted entry publication is
resumable by repeating the same installer and manifest. Existing host leases,
attention, task handoff and compare-and-swap checks still defer installation.

Only an explicit program reference into this exact verified input package's
`transfer` or `runtime-connector` directory is rewritten to its staged
`packages/<manifest hash>` counterpart. This is program installation, not a
queue, profile, credential or work-root migration. External official component
references remain external. An already different endpoint configuration refuses
overwrite through the existing setup check.
The installer returns `programReferenceMappings`. When a NAS producer locator
previously named the extraction, the owner must configure its program path to
the saved persistent producer path before remote tasks. This installer does
not edit NAS locators or their authorization; the original config/state pair,
principal and raw HostBinding remain unchanged.

The stable entry starts from its own persistent location. The extraction can
be removed after successful installation. It verifies the selected package
inventory before executing its endpoint, then uses the original `deploy run`
foreground path with stdin/stdout preserved. It does not register anything with
Windows or use Codex/operator scripts.

## Dependencies and normal operation

```powershell
& $ProductRoot/control/WindowsEndpoint.ps1 -Action Dependencies
& $ProductRoot/control/WindowsEndpoint.ps1 -Action Doctor
& $ProductRoot/control/WindowsEndpoint.ps1 -Action Run
```

Program-only dependency inspection reuses the normal Node/Git/Herdr/Pi/Runtime
version, launcher and protocol checks, without opening enrollment, auth profiles
or task histories. The generated receipt records paths, observed versions/hashes
and ownership. It is an observation cache, not a second configuration, a
user-maintained lockfile, a credential or stopping authority. `endpoint.json`
remains the configuration source. Runtime rechecks still protect running tasks.

Missing/incompatible programs report the official sources from
`dependencies.json.installationSources`. Existing official installations are
reused; no unnecessary parallel Pi/Herdr/Node/Git copies are created. Official
Node/Git installers/archives and Pi/Herdr installers remain their owners. This
batch does not execute them, change PATH/policy, enroll Runtime, generate
credentials, or perform an official component update. After an official update,
run the same dependency check; incompatible protocols or changed unresolved
physical references fail visibly instead of being silently accepted. Reference
maintenance remains the original configuration workflow, not an automatic
official installation/update manager.

The installer reports actual layout references separately. Existing component
data outside the product root is retained; installing a stable entry does not
mean those old paths have been relocated or that PC capabilities are ready.

## Program update, recovery and removal boundary

Running the **new extracted installer** with `-Action Install -ProductRoot` and
the new manifest is also the one-step program/bootstrap upgrade path. On an
existing root, omitted `-References` reuses that root's original endpoint.json.
The installer chooses the existing update transaction when the selected program
differs, then publishes the compatible stable entry with its recorded recovery
phases. It does not rewrite those saved references or relocate data. A busy or
unknown original task still defers the operation.

```powershell
& $ProductRoot/control/WindowsEndpoint.ps1 -Action Update -Source $NextCandidate -ManifestSha256 $NextManifest
& $ProductRoot/control/WindowsEndpoint.ps1 -Action Rollback -ManifestSha256 $PreviousManifest
& $ProductRoot/control/WindowsEndpoint.ps1 -Action DeploymentRecover
```

These use the original package transactions. Active/unknown work, incompatible
state or producer profiles still refuse/defer switching. No command kills tasks
to make update succeed. Config/data/logs and externally referenced files are not
overwritten. Infrastructure recovery is separately `-Action Recover` with the
original explicit run/state/configuration CAS arguments; it never resumes Pi
business automatically. A prepared entry receipt requires repeating the same
installer source rather than bypassing it. The stable launcher protocol is 1;
future incompatible launcher changes require a separately reviewed installer.
An installation with this stable entry refuses selecting a previous program
that does not advertise launcher protocol 1. Its original package, data and
receipt are retained; rollback is only to a reader supporting the installed
entry and existing state/producer profile. Roots without an installed entry
retain their original compatibility rules.

`-Action UninstallPlan` is explicitly non-destructive: program deletion is not
implemented in this batch. It reports retention of config, credentials, queues,
workspaces, archives, unknown files and existing official installations. It must
not be reported as completed uninstall. No cleanup/rotation service is added.

For a proposed root change, run the installer source with `-Action MigrationPlan`,
the original `-References`, proposed `-ProductRoot` and trusted `-ManifestSha256`.
It outputs mappings only, preserves the selected work root and reads no data or
credentials. It does not relocate RootHash/HostBinding, old unknowns, queues,
receipts or original Pi session paths. Actual authorized migration remains a
separate sole-writer operation after original ownership/identity is established.
