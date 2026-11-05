# Windows execution endpoint delivery boundary

This is the first reviewable delivery-layer implementation, **not a released
Windows installer or a runnable endpoint bundle**. It adds one command surface
for configuration references, preflight, a launch plan and verified offline
staging. `start`, `activate`, `update`, `rollback` and `uninstall` fail closed.
There is no qualified component combination yet. No production service, startup
entry, permission, power setting, OAuth flow or credential is changed.

The user-facing destination is one Windows execution endpoint: one installation,
configuration, launch, diagnosis and coordinated update flow, including Agent
execution and bidirectional files. The implementation boundary is packaging and
lifecycle coordination around existing official components. It is not the Memoh
Server, a new GUI, a second task scheduler, or a new transfer service.

## Source findings and smallest implementation

Migrated from the fixed source in [provenance.md](provenance.md). Official component
implementations remain unchanged. `dependencies.json` records investigated versions, **not a signed
release lock or compatibility claim**.

| Component / owner | Proven interface | Delivery consequence |
| --- | --- | --- |
| [Herdr 0.9.5](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/src/main.rs) | Official `herdr --session NAME server`; `status server --json`; native plugin argv actions. | Preserve official binary, sessions and plugin ownership. Do not implement another execution runtime. |
| [Agenvo 0.2.0](https://github.com/Xuanwo/agenvo/blob/a89415e557c415faf5626354f8e87233eb69d877/apps/herdr/package.json) | `node dist/cli.js run`, Node >=24.13.0; `AGENVO_CONFIG_DIR`. | Windows foreground process; network reconnect is not process supervision or Herdr startup. |
| [Agenvo approved instance](https://github.com/Xuanwo/agenvo/blob/a89415e557c415faf5626354f8e87233eb69d877/apps/herdr/src/backend.ts) | Canonical absolute binary, cwd and configRoot; root basename must be `herdr`. Instance settings enter its [fingerprint](https://github.com/Xuanwo/agenvo/blob/a89415e557c415faf5626354f8e87233eb69d877/packages/connector/src/config.ts). | Reject path mismatch. Switching a version directory may need official scope reapproval; never rewrite registration or silently create another identity. |
| [Herdr data paths](https://github.com/herdrdev/herdr/blob/5bd900d88c80d95f5b145397e45bbeea398b8165/src/config/io.rs) | `XDG_CONFIG_HOME/herdr`, `XDG_STATE_HOME/herdr`; plugin config/state supplied by Herdr. | Config and state roots must stay consistent in the launch environment, including the transfer plugin. |
| [Pi 1.2.0](https://github.com/earendil-works/pi/blob/06a466935536f8c9bcacb2d5efc0fc021be1bdff/packages/coding-agent/package.json) | `@earendil-works/pi-coding-agent`, Node >=22.19.0, official `dist/bundle/cli.js`; existing Memoh `pi-json-v1` protocol. | Use the official package unchanged and reference existing `PI_CODING_AGENT_DIR`. Pi is launched by existing tasks, not a permanent extra daemon. |
| Node 24.14.0 | The pinned CI fixture satisfies connector and Pi engine floors. | Investigated candidate only; official artifact hash and whole-bundle acceptance are still missing. |
| Git for Windows | Existing Memoh task envelope uses explicit Git Bash and `base64`, `cygpath`, `sha256sum`, `wc`, `mkdir`, `mv`, `rm`, `rmdir`. | Fixed absolute Bash path, controlled child PATH, MSYS/MINGW host check; never bare system `bash`/WSL. Git release still needs selection and qualification. |
| [PR47 transfer facts](https://github.com/particleflow/Memoh/blob/6ddf61dcd8199758e4110398645c556a3d6d7375/contrib/herdr/memoh-delivery/README.md#unified-windows-endpoint-implemented-and-missing) | `memoh.delivery` 0.3.0, Herdr >=0.9.5; finite `transferqueue.exe` actions; `transfer.json`, separate private `device.credential`, native queue state. | Consume its exact binary/manifest/hash package. Do not modify its implementation, migrations 171/172 or PR. This draft SHA is an interface reference, not a releasable dependency. |

The [unattended lifecycle contract](lifecycle.md) records the inspected startup,
event and reconnect triggers, their limits, and the minimum internal coordinator
and the implemented internal component coordinator. Transfer-owner status and
finite wake integration remain pending. Installing the CLI does not provide
idle queue retry; users must not be required to keep
a chat open to drive future recovery. Diagnostics expose this missing capability.

## Commands and trust

The contributor CLI uses Node builtins only; it introduces no npm dependency.
The PowerShell 5.1 bootstrap selects an explicit Node executable and checks its
SHA-256 before invoking the CLI. It never changes execution policy or PATH
persistently. In a final distribution the approved bootstrap, exact Node path
and hash must be supplied by the authenticated release; the end user must not be
asked to discover and assemble dependencies. This first cut does not download or
install that distribution.

Cloud development checks:

```sh
node endpoint.mjs help
node --test --test-timeout=30000 endpoint.test.mjs lifecycle.test.mjs
```

Review/test use in a disposable Windows environment with a trusted bootstrap and
Node inventory (not authorization to run on an existing user machine):

```powershell
./endpoint.ps1 -NodePath 'C:\Review\node\node.exe' -NodeSha256 $TrustedNodeHash help
```

| Command | Implemented behavior |
| --- | --- |
| `configure --from FILE --config FILE` | Strictly validate non-secret references; create endpoint config exclusively; refuse existing files and component-owned locations. Does not create directories, identities, official config or credentials. |
| `doctor --config FILE` | Full inventory/hash check, config/identity/root agreement, native Windows-only bounded version and Git Bash probes. Credential presence is metadata only. Structured redacted checks; exit 2 while unqualified. |
| `plan --config FILE` | Verify payload; display exact official Herdr/connector argv and controlled process environment. No process launch, pairing, plugin install, task submission or network request. |
| `stage --source DIR --destination DIR --manifest-sha256 SHA256` | Verify a complete unpacked review bundle against a separately trusted manifest hash; check disk budget; copy to a fresh `.pending-*`; flush each file; verify the copy; publish by same-parent rename to the hash-named candidate. |

No command fetches `latest`, invokes official self-update, runs an installer,
changes a registry key/ACL, or operates on credentials. Do not bypass an existing
PowerShell execution policy. Diagnostics omit native command output, private
paths and unrecognized error text. `plan` deliberately displays local paths for
review and should remain local.

`doctor` exposes four distinct capabilities and always keeps overall `ready:false`
in this milestone. A fresh official connector status snapshot can indicate
`authentication_required` (401/403), `protocol_upgrade_required` (426), or an
unverified connected snapshot. A PID is never treated as READY. Pi authentication
validity, live relay authorization, desktop control and actual transfer route are
not established by installed files. The current command connector does not provide
desktop control. No authentication error triggers automatic restart or Pi resubmission.

## Review bundle contract

The bundle is an unpacked directory containing `bundle.json` plus **every**
payload, dependency, npm shim and license file from the controlled build. No
archive extraction or npm install occurs on the target. The manifest shape is:

```json
{
  "schema": 1,
  "platform": "win32-x64",
  "qualification": "review-only",
  "components": {
    "<each dependencies.json component id>": {
      "version": "<exact version>",
      "source": "<official source URL from dependencies.json>",
      "revision": "<exact source revision>",
      "entry": "<fixed package-relative entry>"
    }
  },
  "files": [
    {"path": "<package-relative path>", "size": 123, "sha256": "<64 lowercase hex>"}
  ]
}
```

All six components are required, along with package metadata, Pi's official npm
shims, Git executable, transfer plugin manifest and its `SHA256SUMS.json`.
Transfer provenance must match the pinned source SHA, architecture and hashes.
The complete manifest must come from a reviewed controlled build; hash validation
alone cannot prove that an author included every transitive dependency. Missing,
extra, altered, linked, hardlinked, case-colliding or path-escaping content fails
closed. Runtime version probes supplement the inventory on Windows. A colocated
checksum is not authenticity; `--manifest-sha256` must come from the trusted review
channel. There is intentionally no production manifest or payload in this PR.

Limits for this staging tool are 50,000 files / 4 GiB per **software bundle**, with
64 MiB free-space headroom. These are not file-transfer limits or throughput claims.
The source, staged copy and any interrupted copies consume separate disk space.
There is no background downloader, automatic garbage collection or endless retry.

## Ownership, recovery and updates

| Data | Owner and preservation rule |
| --- | --- |
| Endpoint JSON | Delivery layer; references only, no OAuth or transfer credential. Existing device and runtime IDs are reused, never minted. |
| Official executable/package files | Controlled immutable candidate directory. Original upstream code is unchanged. |
| Agenvo config/authentication | Official Agenvo owner; only config read and credential metadata checked. No copied/refreshed tokens or lock recovery. |
| Herdr config, session layouts and logs | Official Herdr roots; retained independently of package versions. No elevated-client policy change. |
| Pi auth, models, sessions | Existing official Pi root; never copied into an update package. |
| Producer originals | Configured source root, shared with the approved task working root; never deleted by staging/uninstall. |
| Transfer snapshots, receipts and retained downloads | Existing Herdr plugin state; preserve unresolved/unknown/canceled evidence and unconsumed results. Do not rewrite its config digest or move its queue. |

All paths inside a software bundle are relative. Official approved roots are
canonical absolute references because the existing connector and queue require
them. A changed NAS origin or transfer config formatting can invalidate the
existing queue digest: do not regenerate `transfer.json` on every startup.

Interruption before publication leaves only an inert `.pending-*` directory;
retry validates the source and creates a fresh copy. Interruption after publication
is handled by verifying the exact hash-named directory and reporting
`already_staged`. Corrupt published candidates are not overwritten. Leftovers are
retained, never deleted automatically. Staging does not switch an active version,
guarantee NTFS directory durability through physical power loss, migrate a queue,
or roll back component state.

The later [offline transaction batch](deployment-transactions.md) records package
ownership and recoverable candidate selection on top of this staging primitive.
It is tested with synthetic packages and does not activate a real installation.

Before implementing activation/update, resolve the approved absolute binary-path
contract with the connector owner: a version-directory switch changes the
instance fingerprint, while an in-place switch needs an offline journal/backup
and recovery protocol. Neither can be called a safe transparent update today.
Keep the original device identity, validate the entire next combination, drain or
explicitly preserve ongoing tasks and queue state, and only then activate through
the existing official lifecycle. Follow official releases through review and a
new fixed inventory, never component-by-component `latest`. No MSIX, GUI, startup
service or crash supervisor has been selected by this PR.

## Remaining qualification and capacity work

1. Qualify PR47's final green/reviewed transfer SHA and schema 171/172 with its owner.
   Fix an exact official Git/Node/package artifact inventory, provenance and
   license set; resolve npm transitive dependencies at build time. No failed
   candidate may be published.
2. Test the full real bundle in a clean Windows interactive session with no ambient
   PATH or manually installed dependencies: blank machine, missing/wrong
   dependency, non-admin policy failure, Unicode/space paths, approved root and
   identity matching, official Herdr plugin registration and correct state roots.
3. Exercise real Agent/relay/desktop/transfer readiness separately. Verify
   authentication expiry produces an authentication state, existing offline
   reconnect, process exit/recovery and session reconciliation without replaying
   unknown business operations. Internal component supervision is implemented in `lifecycle.mjs`; product
   activation, orphan handoff and transfer wake integration remain gated.
4. Coordinate stopped-state update/rollback and interruption at every publication
   step; preserve credentials, sessions, queues, originals and undelivered results.
   Uninstall must be ownership-based and preserve user data by default.
5. Reuse transfer-owner fixtures for disconnection, lost receipt, crash recovery,
   Range/hash validation and retained publications. The current native profile is
   8 jobs / 256 MiB reserved snapshots / 8 MiB journal / one worker; producer
   declaration is 1–16 files with a 1,024-record receipt catalog. These are stage
   limits, not evidence of massive file-count or large-file acceptance. Capacity
   changes belong to that owner and require reviewed quota/locator evolution.
6. Define bounded later large-file/many-small-file tests against available disk,
   metadata growth, free-space failure and Windows handle limits before generating
   data. Never fill the cloud environment. A process kill is not a physical
   power-loss test; no user-machine power operation is authorized here.

