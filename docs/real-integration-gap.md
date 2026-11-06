# Original-task result integration checkpoint

This inspection preserves endpoint runtime checkpoint
`e2f61151c88557e8846e5778691d72f33e7bfa7b` and examines public Memoh source
`4c880e07ecdff1b6caadd86348779603fce9e8aa`. It does not qualify a production
installation, a historical-session takeover, or a PC/NAS connection.

## Original operation integration boundary

The saved operation, original attempt, Pi session, receipt and page offsets
remain the result authority. A bounded read through the original dedicated
control pane does not permit a new Pi invocation or replacement result collector.
Current execution uses official Memoh Runtime → Herdr/Pi, with the existing
trusted application-turn binding, native target checks and task ledger. The
old inspection's MCP/OAuth connection proposal is retired and is not an
integration instruction for this branch.

The earlier checkpoint examined separate in-memory task/result tests, a
Windows NTFS/PG delivery fixture and an endpoint fixture with synthetic relay
welcome/pong responses. Those checks did not join real authenticated application
execution, original task identity, persistent PG, native processes and result
association. The removed relay fixture has no current invocation. Its historical
result cannot qualify the native replacement.

A remaining joined acceptance test must execute one deterministic task through
the existing authenticated native path, disconnect/reconnect control, then read
the same operation and compare the original attempt, Pi session and receipt.
It must demonstrate one invocation and one associated result in the same PG
state. Seeding a completion row, substituting a mock transport or submitting
another task after uncertainty does not establish that result. A public tools
HTTP call with invented conversation headers does not supply the trusted turn
binding. This document adds no production API or competing authority.

`official-smoke/pi-workload.mjs` is a prerequisite fixture using real official
Herdr/Pi, a disposable loopback model and the fixed producer projection. It offers
one deterministic write and one final reply, without external inference or real
credentials. Repeated reads must preserve the original file, Pi session and
single invocation. Its isolated process-tree supervisor owns cleanup. It does
not create a Memoh operation/producer association or prove the PG joint task,
historical-session recovery, production Magpie request or physical PC/NAS path.
The separate native Runtime fixture covers its own reconnect and original
process/session preservation boundaries; the two results must not be conflated.
See [current runtime evidence and limits](explicit-runtime.md).

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
`91149ad7` for native references and historical schema decoding; see
[API base configuration and existing-binding limits](existing-installations-plan.md#existing-transfer-plugin-reference).
The original routing probe and build failure above remain historical evidence.
Accepting the correct prefix does not complete positive TLS, real task recovery
or production PC/NAS acceptance, and does not implement dynamic route selection.
