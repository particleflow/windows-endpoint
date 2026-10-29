# Native EXE upload acceptance seam

This is an acceptance tool, outside the product payload. It changes no release
gate, installation, trust store, credential, queue format or task identity. No
production NAS/Windows call was made while developing it. Offline tests exercise
the evidence checks and bounded driver; they are not positive TLS acceptance.

## Exact existing candidate

Use the already-built candidate from source
`890131d277e8d44301d4b4304f3054b761a4b38b`, run
[40834351440](https://github.com/particleflow/windows-endpoint/actions/runs/40834351440),
artifact `12879724489`. No rebuild is needed for this tool.

| Member | SHA256 from the existing extraction evidence |
| --- | --- |
| `windows-endpoint-review-890131d277e8-win32-x64.zip` | `7fcfa3ca570a30d4aff0aa7ba8551adea77737f68654f19c60c5f6c64727b51f` |
| `candidate.json` | `ad050a0d1772481b5d70ef235e4da921dd7ddd74a8d6933a4d97605977145396` |
| `transfer/transferqueue.exe` | `8d99378eca82d8f6c74425a4c43356797b3687ba0d9fa6d4446d13e867d42b68` |

Producer source is Memoh `0813c7127faa2f6383b723d5f81ec05487c4e446`.
The candidate remains `not-for-production-release`. The Explicit job failed at
the explicit unfulfilled-acceptance throw, before the following trusted-TLS
step. That is not an observed TLS handshake failure. The Windows delivery job's
cancellation cause remains unknown; passing tests do not identify its actor.

## Inputs and execution boundary

The sole authorized Windows writer uses an already selected, original closed
test result and its existing configured queue. Do not use the unresolved `f33`
result, create a replacement task identity, rename an output, synthesize a
closure, enqueue a duplicate or alter a private journal to satisfy this tool.

Required non-secret references:

- Verified extracted/selected candidate directory and manifest SHA256.
- Existing schema-3 endpoint configuration file, already pointing to that
  candidate's producer and its original paired config/state directories.
  `transfer.json` origin/source root and the existing credential must already
  be valid; this tool neither writes nor prints them. A current old-57/0894
  configuration cannot be silently retargeted to 0813 by this command.
- Original single-file `deliverymeta.Closed` JSON: version, task identity
  (operation/bot/user/session/target/run/attempt/generation/root hash), explicit
  artifact basename/MIME, closed flag, SHA256 and byte count. The artifact must
  still be present unchanged under the configured source root. For a multi-file
  original plan, use its existing per-file closed declaration.
- A new local evidence output filename. Existing evidence is never overwritten.

The selected delivery must already be registered/admitted, phase `queued`,
offset zero, without an association/reference. A cached successful delivery is
not a fresh positive upload. The writer must coordinate this acceptance with
the normal host consumer; a busy queue or an already-advanced delivery fails
closed. The tool does not stop the host or grant maintenance permission.

Run from the reviewed source checkout containing this tool; do not copy it into
an unchanged candidate or edit that candidate's manifest/receipt. Variables below
are existing local references, not new configuration fields or secret values:

```powershell
& $Node (Join-Path $ReviewedSource 'acceptance/native-upload.mjs') capture `
  --candidate $VerifiedCandidate `
  --manifest-sha256 ad050a0d1772481b5d70ef235e4da921dd7ddd74a8d6933a4d97605977145396 `
  --config $ExistingEndpointConfig --expected $OriginalClosedManifest `
  --out $NewNativeCaptureFile
```

Capture verifies the complete candidate inventory, configured producer path and
source-root identity, and streams the source SHA256 before/after the run. It uses
the normal `transferEnvironment`, including the fixed original plugin directory
pair. The actual EXE resolves existing credentials and uses its production TLS
certificate and hostname checks. There is no CA, token, endpoint, HTTP client or
verification-bypass argument. It retains the existing LAN/IPv6 policy file.

Commands are only `inspect -delivery ORIGINAL_ID`, up to 16 successful finite
`advance -delivery ORIGINAL_ID` steps, and final inspect, under a 120-second total
deadline. This small acceptance bound is not a product file/count limit. There
is no collect, enqueue, recovery, global queue advance, task execution or failure
retry. Error/backoff, no progress, unknown outcome, timeout or the step bound
stops the capture. `inspect` can publish the existing advisory feedback; it is
not described as a server-side read-only operation.

A failed run retains bounded sanitized status evidence when the output file can
be written. An empty/unwritable evidence file or interrupted process leaves an
unknown outcome. Preserve it and obtain the original owner's receipt/ledger
readback before any retry; do not rerun merely because this tool exited 2.
`native_capture_saved` still requires receipt and owner-result readback.

## Receipt and committed-reference verification

The current formal EXE does **not** expose its receipt ID in `inspect` or
`advance` stdout. It cannot independently supply this remaining owner evidence.
Use the existing authorized owner to obtain:

1. Prefer `local_receipt_capture`: the output of the `receipt` command below,
   using the native read-only `receipt-binding` capability. This exports only
   the original queue record's receipt binding; it performs no server GET and
   never creates a receipt, repairs a journal or publishes feedback.
   For an already available authorized owner export, the previous
   `recovery_request` input also remains supported: the unchanged output of internal
   `Service.PrepareProducerResultRecovery` for this original operation/file,
   **not** a call to `RecoverProducerResult`. Its `remote_outcome` must be
   `existing`; `known_receipt` is the upload ID from the original ledger.
2. `receipt_response`: `{status, body}` captured from the existing authorized
   `GET /bots/{bot_id}/media/uploads/{known_receipt}` (preserve the deployment's
   API base). Status must be 200, state ready, complete offset, matching
   hash/size/MIME. This GET may record the existing ready proof; it is not a
   guarantee of zero server effects.
3. `task_result`: the normal result object returned by existing authenticated
   `computer_task_result({operation_id: ORIGINAL_OPERATION_ID})` for the same
   target. The selected delivery must be `delivered` with its committed upload
   reference; a successful Pi result, pending delivery or ready receipt alone
   does not suffice.

The evidence wrapper is a local test input, not an API, authentication protocol
or new authorization source:

```json
{
  "local_receipt_capture": "EXACT LOCAL RECEIPT CAPTURE OBJECT",
  "receipt_response": {"status": 200, "body": "EXACT RECEIPT GET BODY OBJECT"},
  "task_result": "EXACT ORIGINAL TASK RESULT OBJECT"
}
```

The strings above denote actual captured objects, not literal accepted values.
No credential or Authorization header belongs in this wrapper.

### Minimal native receipt export

0813 has no existing public receipt-ID export. Ordinary `inspect` opens the queue
writable and can publish feedback; `recover-result` is not a substitute read.
The source companion adds only `-action receipt-binding -delivery ORIGINAL_ID`
to the existing transferqueue host, plus `ReadReceiptBinding` and focused tests.
It reuses `openHerdrQueue(..., true)` and `Inspect` on that read-only queue,
including existing checksum/checkpoint/release/history readers and OS locks.
Read-only mode opens only existing lock/locator/journal/history files; it never
initializes, migrates, truncates, syncs or reclaims them. No private queue parsing
is added to JavaScript. The reader does not load `device.credential`, open source
bytes, call HTTP, publish feedback, perform recovery or record NAS ready proof.

Receipt source is the validated original record's `Job.ReceiptID`, retained
through existing terminal history. It is bound to the original task, exact
config-byte HostBinding and source-root hash. Missing receipt is not inferred
server absence. Wrong binding/direction, missing/busy/corrupt/incompatible state
or an unknown schema is refused, without trying a write-capable reader.

After the source companion is qualified, published with its own exact producer
revision and adopted through the existing candidate pin/build process:

```powershell
& $Node (Join-Path $ReviewedSource 'acceptance/native-upload.mjs') receipt `
  --candidate $VerifiedCandidate --manifest-sha256 $VerifiedManifestSha256 `
  --config $ExistingEndpointConfig --expected $OriginalClosedManifest `
  --out $NewLocalReceiptCaptureFile
```

This wrapper uses the normal fixed plugin directory pair, verifies the candidate
and native output, and checks HostBinding against unchanged `transfer.json`
bytes. It reads no credential or source body and cannot change server state.
Its capture must match the upload capture's producer, EXE and manifest hashes;
the original receipt GET and committed task-result checks remain required.

**Current binary boundary:** existing 890/0813 EXE does not contain this new
capability. It returns unsupported-action exit 2 and the wrapper reports
`acceptance_receipt_export_unsupported`; it never falls back to recovery or
pretends the old EXE supports it. No producer pin, package, manifest or gate was
changed for this source work. The companion's Go tests/runtime qualification and
a future normally paired producer build remain outstanding; do not execute it
against a production queue to qualify the source.

No additional NAS owner-export API is required by this alternative. The existing
authorized receipt GET can still record a ready proof; that server effect is
separate from the local export's `server_effects:none`. A local receipt ID never
proves ready, committed, authenticated remote access or successful delivery.

Offline comparison, on any supported Node platform:

```powershell
& $Node (Join-Path $ReviewedSource 'acceptance/native-upload.mjs') verify `
  --expected $OriginalClosedManifest --capture $NativeCaptureFile `
  --owner $AuthorizedOwnerEvidenceFile
```

The verifier checks the unchanged operation/attempt/generation/root and explicit
file, original receipt binding, exact byte hash/size/MIME, and committed NAS
reference. The output `captured_chain_matches` means only that the supplied
captures match. It does not authenticate arbitrary JSON, attest to the writer's
provenance, authorize an action or clear CI/release gates. The unique writer and
reviewer retain responsibility for the captures' actual source.

`receipt_observed` / `recovery_scope:receipt_get_only` / exit 0 is rejected as
upload completion. Receipt observation can record a ready proof; it is not the
NAS committed task result.

## Current verification scope

```text
node --test acceptance/native-upload.test.mjs
node --check acceptance/native-upload.mjs
```

Only these new offline checks are applicable here. No old suite, candidate build,
CA import, live upload or model invocation is required for their execution.
Actual Windows EXE plus the existing trusted NAS entry still requires the sole
writer's positive run. W02 control, W03 accepted-task continuation while NAS is
disconnected, and W04 same-task reconnect without replay remain separate; this
upload check proves none of them on its own. It also does not prove NAS-to-PC or
multi-end file exchange.
