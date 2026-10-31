# Cross-producer upgrade source checkpoint

Baseline: PR6 `c036d9a706abf463651f03676bf9e916696d4a83`. This is source and
isolated contract evidence. It is not a field upgrade, an installation candidate
qualification, a real queue receipt or a TLS result.

Independent readback of Git source confirmed that the complete original
`session-continuation.mjs` bytes in 57 and c036 are identical:
SHA-256 `2dc418e45f8ca2b513fe4433ae7ba7848f636b9ea7a4a54fa2375e1e907949e9`.
The implementation retains that exact source prefix and its existing binding
algorithm. The new producer-only transition calculates the derived binding
separately from an actual unchanged ordinary snapshot. Both historical lifecycle
sources also contain the same default attention refusal before driver validation.

The original failure is reproduced by verifying a synthetic owned native package
with the exact 57/0894 metadata boundary against the current strict verifier:
`candidate_kind_or_producer_mismatch`. Its bounded historical read verifies the
original manifest/profile/payload; a new stage still rejects an old producer.
The fixture copies inert test source/EXE bytes. It is not a released 57 artifact
or evidence that either producer executable ran.

Targeted commands:

```text
node --test --test-timeout=30000 producer-upgrade.test.mjs
node --test --test-timeout=30000 deployment.test.mjs program-deployment.test.mjs session-continuation.test.mjs host-recovery.test.mjs lifecycle.test.mjs host.test.mjs
python -m unittest discover -s packaging -p 'test_*.py' -v
git diff --check
```

The existing affected regression group passed 275/275, zero skipped. Packaging
passed 7/7. The producer group covers real saved-snapshot shape, absent/Agent
refusals, unchanged credential references, two synthetic unknown plus three
committed records retained byte-for-byte, 11 publication interruption points,
durable rollback direction, exact raw rollback, inode/byte CAS, original recovery
hash preservation, process-absence refusal and security-observation refusal.
Its Linux fixtures inject process/security observations. A separately registered
Windows-only test invokes the actual read-only full-security-descriptor gate;
Linux results cannot qualify that gate or NTFS replacement.

No c036 build/CI rerun, producer build, image publication, certificate import,
permission change or onsite action was performed to obtain these local results.
Current field `pluginRoot`, old selected ownership relationship, an actual saved
ordinary snapshot, stopped-host/stdin proof and real Windows transaction evidence
remain required. See the [transaction contract](../producer-upgrade.md) for exact
commands, retained files and refusal conditions. An external producer path is
explicitly unsupported until its original ownership and safe publication contract
are established; this checkpoint does not close that field acceptance item.

CI `40667963322`, source `012a1af16ef6a81c6a7c545028128c9ff94886c1`, passed
Windows 662/662 and Linux 655/655 with zero skips, both packaging groups and the
actual PowerShell product entry. Its real native reconnect fixture failed at
the stale Herdr marker positive case with `host_recovery_herdr_marker_owner_present`,
before the TLS acceptance gate. The original marker's Herdr PID was not held
against reuse, although the old host PID was. The fixture correction retains
the ping-verified original Herdr process handle before normal stop and observes
its absence while retaining that handle through recovery. Production PID reuse
and marker refusal checks are unchanged. The original failure is retained; this
fixture correction still needs its own exact-head real Windows CI result.

Independent review of d087 found that `transfer.json`, the producer's raw-byte
HostBinding input, was absent from the CAS plan. A local narrow reproduction
appended only a newline after archive: d087 returned success and the expected
rejection assertion failed (0/1). The correction binds raw SHA-256 plus file
generation in plan schema 2, refuses unbound historical plans and checks the
evidence through publication/recovery/rollback/transition. The affected producer
transaction group then passed 45/45, zero skips, including same-byte replacement,
late asynchronous observation, interrupted recovery and unchanged synthetic two
unknown/three committed records. Process/security observations remain injected
in these Linux fixtures; no onsite upgrade or credential read was performed.

The subsequent external-source adapter keeps the current 57 host separate from
the already-recorded 3ccaa/41ddb producer witness. Its production identity is
fixed; synthetic source-only tests inject an inert identity/security observer
and do not qualify the actual external candidate. Public CLI/config cannot
replace that policy. Tests cover the full subtree, preview/path binding,
SID/DACL/generation drift, interrupted recovery/rollback, strict target capability
and completed transition after removal of the disposable source fixture. No
onsite source adoption, staging, installation, permission change or deletion was
performed; the existing final upload/auth/TLS acceptance requirement is retained.

The first external-mode CI (`40683385221`, a62ae19) passed Linux and all injected
transaction cases, but the actual Windows SID/DACL reader failed: 702/703 passed,
one `producer_upgrade_external_reference_unverified`. That is not a TLS failure
or a qualified candidate. The reader now transports its bounded UTF-8 path list
as base64 and verifies a request SHA in the response, with bounded stage-only
diagnostics. It retains the same exact descriptor checks and refusal behavior;
the corrected actual Windows case requires a new exact-head CI result.
