# Historical production Windows CLI trust failure

This is the failure record for the retired Agenvo transfer-host fixture. It is
not a current setup procedure or current acceptance. The fixture implementation
and certificate-store helper were removed with the legacy diagnostics/fixtures;
the current native Runtime/Pi supervisor performs no trust-store operation.
The original failing positive-TLS prerequisite remains in the workflow. Its
replacement native packaged upload/authentication/TLS gate also remains failed.
Neither is cleared by deleting the old fixture.

Run `39911092750` at `5aa2dd5eb79c4ced4b6e8707d838a4b2710c0672`
completed certificate generation, then `Import-Certificate` exited 1 with
`UI is not allowed in this operation.` Cleanup observed the generated
fingerprint absent and the owned process tree empty; it did not execute removal.
The legacy `removed_and_absent` label is not proof that import or deletion
happened. Positive upload, hostname-rejection and committed-reference recovery
assertions were not run. No alternative API, prompt suppression, larger trust
scope or new import is authorized by this record.

The earlier all-green checkpoint was
`aedf30f51a0aec03c05e3ef1255608c17991b9a7`, run `39903770625`.
Its real production CLI rejected the self-signed fixture. A producer test
background dispatcher injected a CA separately; that result was not production
CLI positive-TLS evidence. Neither checkpoint attests to the current native
control/file path.

Runs `39907414574` (`351105a`) and `39907573571` (`a9cea73`) reached
the job deadline before any confirmed import, trusted admission or cleanup
marker. Their recorded 34 native + 7 CLI tests and six host checks established
neither successful import nor cleanup. The preparation/import hang remained
unresolved from those logs; the separately bounded host stop was not observed
as their cause.

The historical fixture restricted its proposed trust action to one disposable
GitHub-hosted Windows account's CurrentUser Root store and one recorded
fingerprint. Those bounds were not permission to mutate LocalMachine, a real
PC/NAS store or a different account. An interrupted job could not prove its
finally cleanup ran. The deleted source remains inspectable in Git at its
recorded commits; it must not be rerun to qualify a native implementation.

Current source tests retain original queue, receipt, unknown and authentication
boundaries. The native actual-EXE empty-queue fixture and synthetic control/model
peers do not demonstrate a production transfer upload, trusted NAS certificate,
hostname failure, native owner/file association or recovered NAS reference.
Those remain required acceptance under the existing TLS/authentication rules.
No new CA option, verification bypass, trust change or retry is introduced.
