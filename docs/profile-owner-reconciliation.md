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

`createOwnerAdmissionReader({sdk,client,botId})` bridges the existing generated
SDK methods `getUsersMe`, `getBotsByBotIdWorkspaceTargets`, and
`getUsersMeRuntimesByIdAdmission` using the caller's existing authenticated
client. It verifies the account and exact native mount, then uses the admission
GET's atomic profile/gate snapshot. No Runtime credential-management list is
read. Authentication or transport failure stops the read without retry; no PUT
is issued. `reconcileProfileSwitchWithOwner(options,{sdk,client,botId})` is the
owner maintenance composition entry and supplies these reads to the transaction.
The SDK/client are reused in memory, not bundled, configured, minted or persisted
by this endpoint. A raw CLI receipt is not accepted. The local owner must invoke
this entry from its already authenticated maintenance process; it is not an
unauthenticated command or defense against arbitrary same-owner code.

The function rechecks both local original archives and the current local
generation, then checks the authenticated read twice before retiring the pending
marker into history. The durable receipt retains the new revision and original
pending digest. An interrupted receipt publication is reconciled by the same
request and fresh reads. No remote write, resume or task replay occurs. Errors,
stale revisions, wrong target/profile digests or unpaused admission leave startup
blocked. Rollback requires its own successful server cutover's fresh revision;
returning A->B->A never revives the first revision.

Memoh source `fa8348ee8da587238fc4d692e0916769b5561609` exposes
`agent_config_dir`, `config_sha256`, `target_fingerprint` and gate `revision`
from one admission GET SQL snapshot. After an uncertain PUT, the owner wrapper
queries this snapshot, requires the intended current local profile, original
identity/pause and exactly the next revision, and only then adopts its CAS facts.
A different winner or stale revision stays blocked; the wrapper never resends
PUT or resumes admission. The normal reconciliation re-reads the snapshot before
retiring pending. These checks observe a snapshot, not a lock on future NAS
writes; the owner must keep admission paused and use the returned revision for
any subsequent cutover or resume.

This source provides the local reconciliation state machine and synthetic
positive/negative tests, not deployed Memoh/Windows or authenticated end-to-end
acceptance. No production credentials or Windows data were accessed.
