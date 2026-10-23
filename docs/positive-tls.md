# Production Windows CLI with isolated test trust

The prior all-green checkpoint is `aedf30f51a0aec03c05e3ef1255608c17991b9a7`,
run `39903770625`. Its real CLI correctly rejected the self-signed fixture.
The earlier producer test dispatcher injected a CA; that was not production CLI
positive TLS evidence. This increment retains both existing checks unchanged in
purpose and adds a separately authorized positive scenario in the same CI job.

`host-tls.ps1` requires a GitHub-hosted Windows runner and a fresh root beneath
its temporary directory. It generates a one-day CA and two server-auth leaves:
one valid for localhost/127.0.0.1, one for `wrong-name.invalid`. No certificate
or key is uploaded. The public CA certificate is imported only into
`Cert:\CurrentUser\Root`; LocalMachine, production accounts and PC/NAS stores
are untouched. This is account-scoped trust, not process-scoped trust. No account,
token permission, firewall rule, system service or Agent core is changed.

Before import, the generated fingerprint must be absent. Cleanup is armed before
import so partial/uncertain success cannot escape the `finally` block. Cleanup
removes only that exact fingerprint and checks absence. Any import, test or
cleanup error fails the step. Logs record only the public fingerprint and scope.
A hard VM termination cannot promise execution of `finally`; that job cannot
pass and the disposable VM owns final destruction. Never reuse this wrapper on
a self-hosted runner or treat it as an installation command.

The same production `transferqueue.exe` is built from unchanged public source
`4c880e07ecdff1b6caadd86348779603fce9e8aa` and retains normal TLS verification:

1. The original isolated host test still requires untrusted TLS rejection with
   no transfer HTTP request, queue persistence and connector-auth failure checks.
2. After account trust, both leaves' signatures are checked against the same CA.
   The wrong-name leaf must fail in the production CLI: exit 1, persisted waiting
   state, no uploaded bytes/association, TLS failure and no HTTP request. A killed
   process, timeout or another exit code cannot satisfy the assertion.
3. Switching only the served leaf to the matching name allows the real host's
   existing finite consumer to upload the original seven bytes in two chunks.
   The fixture checks original task/delivery namespace, synthetic authorization,
   size, per-chunk hash/offset, whole-file hash and one original receipt.
4. The fixture accepts commit but drops its response. The host stops with the
   persisted association unknown, and a fresh host reopens that queue. It must
   resolve the original commit, expose `associated:true` and exactly the original
   immutable result reference, without a second upload/complete/commit.
5. Reopening the completed queue produces no new NAS requests. Original files,
   official configuration and producer context survive. Local feedback remains
   `unknown/awaiting_nas_ledger`, because local association is not the actual
   Server's committed business ledger.

`nas-fixture.mjs` is a seven-byte in-memory protocol fixture, adapted from the
fixed producer's `cmd/transferqueue/cli_path_test.go`, not a transfer service or
durable NAS implementation. Its Linux/Windows unit tests test the fixture's
strictness only. Windows CI separately executes the unchanged production CLI,
official Herdr/Agenvo and public host. No model request is sent.

Even a passing isolated positive scenario leaves overall `ready:false` and
`transferAutomaticRecovery:false`. It does not qualify real PC-to-NAS transfer,
Server/PG grants, mobile task/result presentation, actual Agent tool recovery,
large files, physical power loss, or release/install/update readiness.
