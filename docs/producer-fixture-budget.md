# Source-built producer fixture budget

The failed checkpoint is endpoint `5ea4f1977b457a8a6ad44f1e242daa6224e595b8`,
run [39901771088](https://github.com/particleflow/windows-endpoint/actions/runs/39901771088),
job `120244732320`. The dedicated GitHub job-log tool returned the actual output.
The earlier generic URL allowlist rejection did not establish that this dedicated
tool was unavailable. No old denied download or URL was retried.

The native executable began at 04:43:57 UTC and its **whole-process** Go alarm
fired at 04:48:57 (`panic: test timed out after 5m0s`, native exit 2; wrapper exit 1).
Twenty-nine top-level tests had passed, totalling 291.16 seconds. The largest
completed cases were:

| Test suffix (after `TestWindowsNative`) | Seconds | Result |
| --- | ---: | --- |
| PublicationBucketBudget | 130.19 | PASS |
| ActiveJournal | 52.82 | PASS |
| PublicationPublishCancelRace | 29.23 | PASS |
| PublicationReceiptBoundary | 23.43 | PASS |
| PublicationExplicitMigration | 9.51 | PASS |

At the alarm, `PublicationMigrationProcessCrash` had run for 9 seconds and its
`publication_after_migration_gate` subtest for 4 seconds. Its stack was in native
metadata rebuild/usage/initialization/migration. This is evidence of exhausted
aggregate budget, not an observed assertion failure or proof that migration hung.
Unfinished tests and the subsequent CLI group were not passed.

The bucket case intentionally fills 128 receipt slots in one bucket, then checks
rejection and replay; it retains real native synchronization. There is no measured
production performance claim or optimization here. That failed checkpoint used
public Memoh
`4c880e07ecdff1b6caadd86348779603fce9e8aa`, plugin 0.7.0.

## Bounded downstream scheduling

Only this repository's CI orchestration changes. `producer-fixtures.mjs` verifies
all seven original payload hashes, exact bundle membership, architecture and
source SHA, then enumerates the **compiled binaries** using the original
`^TestWindowsNative` and `^TestCLIPath` selections. It divides native tests into
three disjoint groups and retains the CLI group. No producer source, binary,
manifest, assertion, synchronization or original `verify-fixtures.ps1` is edited.
That original verifier remains hash-checked; its aggregate invocation is replaced
only in this downstream job.

The current source pin is `f7479c56f9d9e67be0ddff2ef73bcc6d0b952f75`.
Its new `TestAPIBaseContractVectors` is outside those two historical selections,
so the same packaged test executable runs that test separately from the fixed
source's `internal/transferclient` directory. The original test reads its own
`testdata/api-base-v1.json`; those bytes must match the endpoint's shared vectors.
All 30 named subcases and the top-level pass are required, with zero skips or
duplicates. This extra test retains a 30-second Go alarm and 40-second wrapper
bound inside the existing 12-minute suite deadline. The original 41 tests and
their limits remain intact; no testdata or extra file is added to the bundle.

Every group retains Go's 5-minute timeout, so no individual test can run longer
than the original 5-minute maximum. The wrapper adds a 310-second process watchdog
and a 12-minute deadline for the complete fixture suite. The workflow job keeps
its existing 25-minute bound, including build, assembly and native host testing.
The observed native groups require about 80 seconds of core work, 130 seconds for
the bucket case, and the remaining publication work; these no longer consume one
shared 300-second alarm. This changes test budgeting, not workload or disk safety.

The plan, complete names, results and elapsed group times are printed to CI.
Partition union/disjointness is checked against both binary inventories. Each
group must exit 0, emit final `PASS`, and report exactly its expected top-level
passes. A missing/duplicate/unexpected pass, skipped subtest, assertion failure,
timeout or output overflow fails the suite. Regexes have no slash component, so
all existing subtests and crash stages run. No retry or success on a partial plan
is permitted. Process-timeout cleanup is not claimed to contain every descendant;
a failing run stops and leaves final teardown to the disposable CI runner.

The following source inventory contains 34 native and 7 CLI top-level tests.
Runtime enumeration verifies the actual compiled coverage; the CLI child helper
and owner diagnostic are included as before and are not counted as business
capability acceptance.

### native-core (18)

```text
TestWindowsNativeActiveJournal
TestWindowsNativeAdmissionCancelAndRetire
TestWindowsNativeConfiguredHost
TestWindowsNativeCrossProcessLocks
TestWindowsNativeLifecycle
TestWindowsNativePrivacyAndPathBinding
TestWindowsNativeProducerClosedManifest
TestWindowsNativeProducerFeedback
TestWindowsNativeProducerInvalidManifest
TestWindowsNativeProducerMissingSource
TestWindowsNativeProducerMultiple
TestWindowsNativeQueueReleaseCapacity
TestWindowsNativeQueueReleaseProcessCrash
TestWindowsNativeQueueReleaseUnknown
TestWindowsNativeRejectsLinksAndTraversal
TestWindowsNativeReleaseUsesJournalIdentity
TestWindowsNativeSnapshotSharingAndSourceGuard
TestWindowsNativeTLSUploadOutboxAndDownload
```

### native-bucket-budget (1)

```text
TestWindowsNativePublicationBucketBudget
```

### native-publication (15)

```text
TestWindowsNativePublicationByteBoundarySurvivesQueueRetire
TestWindowsNativePublicationDirectoryIdentity
TestWindowsNativePublicationExplicitMigration
TestWindowsNativePublicationFenceAndScope
TestWindowsNativePublicationFenceReopenAndRevocation
TestWindowsNativePublicationFiniteHerdrAction
TestWindowsNativePublicationMigrationBusyAndPermanentLock
TestWindowsNativePublicationMigrationProcessCrash
TestWindowsNativePublicationNeverOverwritesTarget
TestWindowsNativePublicationProcessCrash
TestWindowsNativePublicationPublishCancelRace
TestWindowsNativePublicationReceiptBoundary
TestWindowsNativePublicationRejectsLinksAndReplacement
TestWindowsNativePublicationRenameCollision
TestWindowsNativePublicationRoundTrip
```

### cli-path (7)

```text
TestCLIPathChild
TestCLIPathCorruptQueueCannotAdvertiseIndependentDue
TestCLIPathHistoryMigration
TestCLIPathPublicationMigration
TestCLIPathSummaryMissingConfigurationDoesNotCreateState
TestCLIPathTLSRestartAndLostResponses
TestCLIPathWindowsDefaultOwnerDiagnostic
```

Passing these fixtures remains distinct from production CLI positive TLS or real
PC-to-NAS acceptance. Their ephemeral TLS dispatcher uses test-only CA injection;
the public host fixture's production CLI still must reject that untrusted CA.
