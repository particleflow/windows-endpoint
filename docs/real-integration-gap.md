# Original-task result integration checkpoint

This inspection preserves endpoint runtime checkpoint
`e2f61151c88557e8846e5778691d72f33e7bfa7b` and examines public Memoh source
`4c880e07ecdff1b6caadd86348779603fce9e8aa`. It does not qualify a production
installation, a historical-session takeover, or a PC/NAS connection.

## Existing implementation and test seams

The existing `computer_task_result` path already observes the original operation.
Memoh `internal/computertask/source.go:114` calls the service observation path;
`internal/computertask/pi_batch.go:123,197,243` uses `ObserveBatch` and
`ReadBatchPage`. The receipt, original attempt, Pi session and bounded page offsets
belong to that existing record. No replacement result collector or ledger is
needed here. Reading a batch file can issue a bounded read command to the original
dedicated control pane; this is not permission to replay the Pi invocation.

The fixtures presently cover separate boundaries:

| Existing fixture | Evidence | Missing from this fixture |
| --- | --- | --- |
| Endpoint `official-smoke/existing.mjs:31-36` | Real official component processes with a synthetic relay's welcome/pong responses | Real Memoh MCP dispatch, scope authorization, original task and PG |
| Memoh `internal/computertask/pi_batch_test.go:329` | Original-ID, receipt, page-offset and restart rules using a synthetic transport and in-memory stores | Native Windows processes and persistent PG integration |
| Memoh `internal/db/computer_delivery_native_windows_test.go:190-224` | Native delivery handler, NTFS and disposable PG using `server.NewServer` inside `httptest.NewTLSServer` | Full `cmd/agent` process and the actual Agenvo/Herdr/Pi task-result path |

Memoh's `scripts/test-native-delivery-postgres.ps1` already supplies a disposable
loopback PG cluster using the Windows runner's installed `PGBIN`. It does not
install or start the machine's PostgreSQL service. It is a reusable test setup,
not an existing end-to-end original-task fixture.

The missing integration setup must drive a real trusted application turn and an
authorized official Agenvo MCP connection. A public `/bots/{bot_id}/tools` call
with invented conversation headers is not equivalent:
`internal/handlers/mcp_tools.go:99` marks it `PublicRequest`, and
`internal/toolcontext/computer_binding.go:76-91` rejects that as computer-task
authority. The real binding is supplied by
`internal/agent/application/service_workspace_target.go:88-90`;
`cmd/internal/core/agenvo.go:17-36` resolves the owned active HTTP MCP connection
and existing OAuth path. No new production API is established as necessary by
this inspection.

The minimum remaining test joins those existing pieces with a deterministic
synthetic workload, then disconnects/reconnects the official connector and reads
the same operation. It must compare the original attempt, Pi session and receipt,
prove one execution, and read the committed result/reference from the same PG
state. It must not seed a completion record and label that an actual execution,
replace the transport with a mock and label it native, or submit another task to
recover an unknown outcome. No such joined test ran in this checkpoint.

## Build preflight blocked before compilation

A bounded cloud build attempted `GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build
-mod=readonly -buildvcs=false ./cmd/agent` against the fixed producer checkout,
mounted read-only in the official Go 1.25.7 image. Dependency retrieval from
`proxy.golang.org` failed with `x509: certificate signed by unknown authority`.
There is no Windows server compiler result or executable. This is a TLS trust
failure, not a GitHub permission rejection or proof the server is Unix-only.
No trust/proxy bypass or alternative retrieval was attempted. The temporary
build container exited; no Memoh server or PG was started.

Build log SHA-256:
`32f2fad4f6e7ab554f4f27d8e16c95961905939113fb7c951ecfd8c40c07456d`.
The earlier Windows CurrentUser Root import UI rejection remains separately
blocked; this inspection neither retries it nor changes that CI gate.

## Default Web gateway API prefix mismatch at the inspected checkpoint

At endpoint `e2f61151`, `endpoint.mjs:89-102` accepts a bare HTTPS `nasOrigin` only. Memoh's
`internal/transferclient/client.go:50-89` accepts an HTTPS base path and appends
`/internal/computer-transfers/<operation>/<delivery>`, retaining an existing
`/api` prefix. The endpoint fixture in `official-smoke/nas-fixture.mjs:10` serves
that namespace at the root, so its results do not establish Web gateway support.

A separate cloud probe ran real Nginx 1.31.8 with the unchanged producer
`docker/nginx.conf` and `docker/nginx-app.conf` templates, using their supported
upstream substitutions. A synthetic SPA and synthetic upstream made routing
observable. The unprivileged container had no external network or published
ports; requests used its own loopback. Results:

- `/internal/computer-transfers/fixture-operation/fixture-delivery/status?probe=1`
  returned the SPA index, with zero upstream requests.
- The same path prefixed with `/api` reached the upstream once. Only `/api` was
  removed; operation/delivery path and query were unchanged.
- The Nginx process exited and the temporary container was removed.

This proves default gateway routing only, using HTTP and a synthetic upstream.
It does not prove TLS, Memoh authentication, native CLI transfer or a NAS result.
The first readiness connection was refused before Nginx started; the bounded
readiness retry and both routing assertions then passed, exit zero.

Probe image: `nginx@sha256:a3554c0d0b48177b1413c26e01f695334428020d9df01243fbae3e11cfd17417`.
Probe log SHA-256: `ec4b1ddfe4fa537e89ed26fa998672e771685e0c8a4fcfac5566bb88d18d9951`.
Input `nginx.conf` SHA-256: `30bd2cbb4cec8154c35225afca319c1923d8277e25b9df56430893e6d3dc39f1`.
Input `nginx-app.conf` SHA-256: `9d41c5f8e2e07d388c1e0c78b006841f5e393764de5d3d970325e553f09878f6`.

The shared transfer contract owner must settle API base and LAN/IPv6 routing
together. Simply changing `transfer.json` is not a safe queue migration:
`internal/transferclient/host_config.go:91-92` hashes the raw configuration into
`HostBinding`; `host_action.go:101` rejects an existing job with a different
binding. `host_config_test.go:106-111` already asserts that an origin change
fails before networking. Routing changes must preserve existing queue, attempt,
receipt and delivery identities. This endpoint batch adds no competing field,
origin alias, queue reset or new transfer service.

The subsequent endpoint fix adopts the shared syntax contract at Memoh
`91149ad7` for both configuration schemas; see
[API base configuration and existing-binding limits](existing-installations-plan.md#existing-transfer-plugin-reference).
The original routing probe and build failure above remain historical evidence.
Accepting the correct prefix does not complete positive TLS, real task recovery
or production PC/NAS acceptance, and does not implement dynamic route selection.
