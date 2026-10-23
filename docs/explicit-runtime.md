# Explicit foreground component review

This document describes schema 1, the inventory-bound bundle review mode.
[Schema 2 existing-installation references](existing-installations-plan.md)
reuse selected official programs/configuration without a second package copy or
user-maintained version manifest; it can explicitly attach the existing registered
transfer plugin and queue with the same finite consumer.

This batch connects the public `host run` entry to the existing native lifecycle
and finite CLI consumer. It does not install a service, pair a device, authorize
an endpoint, activate the offline selector, or certify a release. The default
without `config/runtime.json` remains an observation-only host.

The user must already supply the unified roots, approved existing Herdr/Agenvo
configuration and credentials, and an inventory bound by the trusted
`manifestSha256` in `config/endpoint.json`. A local request has exactly this shape:

```json
{
  "schema": 1,
  "mode": "explicit-review",
  "manifestSha256": "REPLACE_WITH_THE_SAME_APPROVED_MANIFEST_SHA256",
  "transfer": "existing-queue"
}
```

`transfer` may instead be `disabled`. There is no executable/argv/credential/
qualification override or mock selector. Changes to either endpoint or runtime
configuration require a restart. No credential is created or refreshed. This is
an explicit request to execute reviewed local programs, not an authentication
grant; the supplied digest must come from the user's trusted review process.

Before starting, the existing native lifecycle takes its global device/config/
queue leases, verifies the full inventory and pinned versions, checks canonical
mutable roots, the single approved Agenvo instance, HTTPS relay, existing
credential metadata and Herdr configuration. Enabling transfer also validates
its existing registry mapping, source root, origin and credential metadata.
Official `--version` checks do not send model requests. Official connector status
reports authorization; file presence does not. Full checks repeat before component
recovery; manifest, CLI and provenance bytes repeat before each finite invocation.

The finite consumer invokes only `lifecycle-summary` and `advance-results`.
It does not initialize a missing queue, enqueue a result, run Pi, collect arbitrary
files, create delivery IDs, migrate state, or repair permissions. Work must already
be admitted through the producer's normal closed-result interface. The producer
continues to own queue journals, task identity and feedback files. A reported
`feedback_status: unavailable` is attention, including when the command otherwise
reports idle; failed result recording must not disappear on stop/restart.

`components: verified_local` / `evidence: native_components` report observed local
component execution. `componentLifecycle` and `connection` separately report
ownership/phase and the official connector's current snapshot. The finite
`transfer` projection reports producer scheduling, never business completion.
Overall `ready:false`, Agent/desktop unavailable and
`transferAutomaticRecovery:false` remain: production authentication/TLS,
full bundle qualification, pending-tool recovery and physical power-loss recovery
have not been established. There is no global READY inferred from living PIDs.

## Source and CI evidence boundaries

CI checks out public `particleflow/Memoh` at
`4c880e07ecdff1b6caadd86348779603fce9e8aa` (plugin 0.7.0) and calls its unchanged
`scripts/build-transferqueue-bundle.py`. The source is a separate build input,
not a second Go implementation in this repository. No blocked hosted artifact is
re-requested. The old `transfer-artifact.json` and its legacy seven-file fixture
remain historical, unexecuted inputs; they are not the new build's provenance.
The official dependency archives retain their fixed hashes/npm integrity lock.
The newly built inventory remains `review-only`.
The original native test binary exceeded its aggregate five-minute alarm in
run 39901771088 after 29 completed tests. The downstream
[fixture budget and complete coverage plan](producer-fixture-budget.md) preserves
the unchanged producer tests with bounded groups and verifies every selected
top-level test and all subtests; it does not modify the producer verifier.

The new Windows job exercises the public host process, official Herdr/Agenvo and
production `transferqueue.exe` with fresh isolated data. It admits one seven-byte
synthetic result through the producer, observes finite queue progress, stops and
reopens the same queue/identity, and checks authorization failure persistence.
It creates private fixture objects at creation time; it never repairs existing
ACLs or uses a real credential/model/NAS. The original untrusted scenario changes
no trust settings. The separately authorized positive TLS scenario below changes
only the disposable CI account's CurrentUser root store, with exact cleanup.

The production Go CLI uses system TLS roots and has no custom-CA option. Therefore
the host fixture's self-signed NAS endpoint must be rejected: no transfer HTTP
request is accepted, and a persisted pending retry/feedback must remain. Agenvo
uses a child-local CA for its separate synthetic relay; this does not change Go
trust. The upstream `transferqueue-cli.test.exe` positive TLS test injects a CA
only into a test dispatcher. Its successful small-file/lost-response chain, if
passed, is separate evidence, not production-CLI TLS or real PC-to-NAS acceptance.

The [positive TLS scenario](positive-tls.md) uses the same production CLI and an
explicitly authorized short-lived root in the disposable Windows CI account.
It retains the original untrusted rejection, adds hostname rejection and a
seven-byte upload/reference recovery against the existing loopback protocol
fixture, then removes only the recorded root fingerprint. This is not a new CA
configuration option, a TLS shim or a change to official/producer code. Actual
NAS certificate trust, authorization, durable Server/PG association and mobile
result delivery remain separate, unperformed acceptance work.

Unknown tasks, a non-stopped previous lifecycle or persisted attention still
block automatic startup. Owned cleanup failures retain the lease/evidence;
EOF does not magically reopen stdin. Forced host death has no new guarantee of
official child cleanup. No active update, rollback, service, desktop, large-scale
capacity or physical power-loss qualification is provided by this batch.
