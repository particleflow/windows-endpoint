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
