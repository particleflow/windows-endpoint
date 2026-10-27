# Offline profile owner reconciliation

`reconcileProfileSwitch` in `program-deployment.mjs` is an internal composition
entry for the existing trusted local owner maintenance process. It has no CLI
receipt input, credential reader, enrollment, network listener or automatic PUT.
The local signed-in operator controls that process and the existing authenticated
Memoh owner client. This boundary does not defend against a malicious local
administrator or arbitrary code running as that same owner.

The owner supplies the original transaction UUID, owner/runtime/target/instance,
pause UUID, previous and successful new decimal admission revisions, the known
new registration digest and target fingerprint, and the exact new local config
and lifecycle digests. Only revision +1 is accepted. Server registration digests
are distinct from the endpoint's raw configuration-file digest.

The injected `readOwnerState({ownerId,runtimeId,targetId})` must perform the
existing authenticated owner reads and verify the owned Bot mount still selects
that runtime. Its projection is `{ownerId,runtimeId,targetId,nativeHerdr,admission}`;
`nativeHerdr` is the existing Runtime DTO's `native_herdr` value and `admission`
is GET `/users/me/runtimes/{id}/admission`. Do not project caller-authored JSON
as an authenticated read. Production client wiring belongs to the owner
orchestrator, and is not included in this module. Tests inject synthetic reads.

The function rechecks both local original archives and the current local
generation, then checks the authenticated read twice before retiring the pending
marker into history. The durable receipt retains the new revision and original
pending digest. An interrupted receipt publication is reconciled by the same
request and fresh reads. No remote write, resume or task replay occurs. Errors,
stale revisions, wrong target/profile digests or unpaused admission leave startup
blocked. Rollback requires its own successful server cutover's fresh revision;
returning A->B->A never revives the first revision.

Memoh source `3424c1be9d19d98b68ec545e2f693ac0d525f592` returns Admission
from PUT `/users/me/runtimes/{id}/native-herdr/profile-cutover`. GET exposes the
registration digest/fingerprint, but not `agent.config_dir`. A lost PUT response
must first be queried, never blindly repeated. If the owner has no independently
known expected new digest, those GETs alone cannot distinguish its proposed
profile from a concurrent winning proposal. Keep the transaction blocked until
the existing owner API supplies sufficient profile/intent attribution; do not
derive success solely from an increased revision.

This source provides the local reconciliation state machine and synthetic
positive/negative tests, not deployed Memoh/Windows or authenticated end-to-end
acceptance. No production credentials or Windows data were accessed.
