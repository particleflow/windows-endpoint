# Retained snapshot consumer and producer qualification

The consumer source `3c970163feeb949a3d5b73af590f6ca1116bc3fd` is locally
cherry-picked onto retirement head `c221aedfb600249ca2f8547a036c5b21019943ba`
as `a95604338dccba237d9f2762c51ccbb0b5218b90`. It changes only the finite
transfer consumer, envelope parser, their fixtures and contract documentation;
it does not add a service, stop a process or change host/program deployment.

While the original Herdr observation latch remains, an owned host can invoke
only `advance-snapshots` for already-admitted private upload bytes. It retains
the original journal/unknown task, checks publication state, drains issued work
on stop and never interprets scoped idle as an empty or healthy full queue.
Authentication/configuration/unknown failures do not fall back to a general
action. Local composition checks pass 38 selected JS cases with zero skips;
these are consumer tests, not producer or Windows executable qualification.

The required producer is exactly
`62d27ed995c53f405297eb0069290f3aefba2c51`. The previous Windows CI
40588745818 uses `0894a6eb8ff69c8796e2da5450fa172d4cd5ef81`; its producer
results cannot qualify this new action. The producer owner's cloud attempt
reported exit 1 while downloading go.sum-locked dependencies from
proxy.golang.org: x509 unknown authority. Go tests and Linux/Windows builds
were not executed there. This is neither an onsite certificate diagnosis nor
a safety-approval rejection. No TLS/verification/trust setting is changed and
no untrusted dependency mirror is substituted.

The existing Windows source-build workflow now selects the exact producer pin
and its unchanged seven-payload build script. Candidate inventory requires the
same source SHA, architecture and hashes and rejects changed or extra files.
Its existing compiled-test dispatcher additionally requires the four upstream
`TestSnapshotProducer*` cases and
`TestCLISnapshotScopeNeverActivatesRegisteredInput`, with exact inventory and
no zero/missing/duplicate/skipped tests. These cover retained private bytes after
source removal, registered/indexed input exclusion, missing-byte rejection and
original TLS/authorization guards. Existing Linux Go steps select the same
contract cases using ordinary strict TLS and go.sum resolution.

This is preparation for one complete candidate after the separately owned
native Pi host/deploy wiring arrives. No CI was dispatched or repeated for this
local composition. No exact-62d Windows executable, producer pass or artifact
is claimed yet. The original transfer/authentication/system-trust acceptance
gates remain required, and earlier failed ACL/entry records remain preserved.
There is no installation, production task replay, queue/root/profile migration,
credential copy or identity/permission change.
