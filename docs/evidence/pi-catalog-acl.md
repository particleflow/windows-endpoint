# Pi catalog Windows ACL regression

Failure source: run 40571503333, Windows job 122426609495, checked-out PR5
merge 67e4624ffc33cee3e5f99609385a3e319efdecf2 (51d4567fbd26cf8bca56180da6ecc92900ff2253
into c5a63bcf1cd39065c73911e6b7ca7847dd5ec8df), Node 24.14.0, Server 2025.
The Windows delivery suite passed 586/587. The only failure was the string
comparison at pi-catalog-lifecycle.test.mjs:105, test beginning at line 100.
The owner retained raw log SHA256
e1099c9c26b825a17159105853b808112c835688551b7225c470617cf4932b93 in its own
environment. This investigation fetched the same job's decoded log from GitHub;
it does not claim byte identity with the owner's separately saved file.

The before ACL listed SYSTEM, Administrators and runneradmin FullControl. The
after ACL kept those explicit entries and appended inherited FullControl for
the same three identities. Thus the observed delta has no new principal or
access mask, and does not demonstrate an effective access expansion. The onsite
2938274/Node 24.14 targeted 7/7 result remains a separate historical fact; it does
not invalidate the CI failure or prove this fix on the CI image.

Microsoft documents ReplaceFile preserving/merging the destination DACL, and
Windows inheritance propagation appending inherited entries after explicit
entries. DACL display text need not be byte-identical after this operation:

- https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew
- https://learn.microsoft.com/en-us/windows/win32/secauthz/automatic-propagation-of-inheritable-aces
- https://learn.microsoft.com/en-us/dotnet/api/system.io.file.replace

The fixture now compares structured security descriptors. Owner, group, DACL
protection and null-versus-present DACL must be identical. The original ordered
ACE sequence must be an exact prefix of the result, including original inherited
flags. Any suffix entry must be inherited and binary-identical to an original
ACE except for INHERITED_ACE. No SID/mask union, reordering or generic inheritance
allowlist is used. The serialized comparison preserves ACE type, access mask,
SID, object/callback data and all remaining flags. Appending duplicates after
the original entries changes no earlier allow/deny decision. New principals,
rights, explicit entries, reordered denies, removed entries or lost protection
are rejected by negative fixtures.

The Windows test covers both the default inherited fixture and a protected,
current-user-only synthetic file under its own newly allocated pi-catalog-*
directory. Only that test file's ACL is restricted; no real Pi profile, directory
ACL, runtime permission, script policy or production replacement code changes.
Both installed and displaced backup ACLs are checked. The regular mkdtemp/t.after
cleanup boundary is unchanged.

The ACL code and test in 51d4567 match 2938274; this fixture-only fix can be
cherry-picked onto the owner/PR6 combination without modifying profile or
selected-launcher logic. Source CI and onsite Windows revalidation are still
required; the existing TLS gate is outside this change and is not converted to
success.

Targeted owner revalidation, under the existing isolated TEMP/TMP fixture root:

```powershell
& $node --test --test-timeout=30000 --test-name-pattern '^(Windows ReplaceFile preserves the destination ACL|ACL comparison allows only)' pi-catalog-lifecycle.test.mjs
```

Expect both selected tests to pass on Windows, with both inherited/protected
subcases and original/backup checks executed. Run on both the failing CI image
and the owner's isolated Windows directory; do not relabel Linux or historical
onsite results as this new Windows result. No model endpoint is contacted.

## Subsequent owner verification and module-path isolation

The owner subsequently reported f85e65ce's two selected real Windows tests passing
2/2 with zero skips. Its first attempt failed before ACL comparison because the
inherited PSModulePath prevented Get-Acl from loading. Restricting that test
process to Windows PowerShell's own modules resolved it; the owner restored
TEMP/TMP/PSModulePath. This report is separate from the earlier CI ACL failure.

Microsoft documents that PowerShell 7's module-path compatibility handling applies
only to directly launched Windows PowerShell. Node as an intermediate process
can forward incompatible module paths:
https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_psmodulepath

The source now supplies the ACL test child with a cloned environment, removes
case variants of PSModulePath, and names the invoked Windows PowerShell's Modules
directory. The test script pins $PSHOME/Modules again after startup, since Windows
PowerShell may insert AllUsers paths during startup. Parent environment, TEMP/TMP,
registry, global module paths and script policies are untouched. This changes only
test support, not the production replacement helper or ACL assertions.

A new targeted child-process regression, including mixed-case pollution, confirms
that the intended environment reaches a child and the parent values remain exact.
It passes locally 1/1; no prior Windows ACL tests or old seven-case suite were
repeated. The owner's successful Windows run used equivalent manual isolation;
it is not relabeled as execution of the subsequent source patch.

## New inherited-to-explicit counterexample, local-only revision

CI40575784260 Windows job 122441714650 passed 589/590 on the existing remote
49be5cc combination. The module-loading issue was resolved. At installed-file
ACL comparison (pi-catalog-lifecycle.test.mjs:120), three original inherited ACEs
became explicit with unchanged serialized SID/mask/type. The backup/protected
subcases after this assertion were not reached. The earlier 7/7, f85 two-case
2/2 owner result and earlier CI failure remain separate historical results.

This is not proved to be fixture initialization noise. Microsoft states that
removing a parent's inheritable ACE removes its inherited copies in children;
an explicit grant is not such a copy. Therefore the observed conversion can
change future revocation and evaluation-order semantics, even with equal rights
today. The strict inherited-flag assertion is retained, including a new direct
negative case. No current-SID/mask-only relaxation is allowed.

Product correction is fail-closed: check native DACL before replacement and before
the durable pending marker; refuse unprotected or inherited DACLs without setting
or rewriting them. Retain success only for already protected explicit DACLs,
then verify owner/group/DACL of the actual backup and installed file. An unsafe
ACL returns terminal `unsupported_acl`; the existing target is untouched and no
new transaction remains. The PowerShell product helper uses .NET file/security
APIs, avoiding module autoloading for the new native guard.

Windows fixtures now make their newly allocated positive-test files explicitly
protected (current-user-only) and separately prove that an unprotected fixture
is refused with exact bytes, identity, ACL/flags and directory contents unchanged.
The fixture initialization is explicit because the product's supported scope
changed; it is not presented as a reinterpretation of the failed inherited case.
The same-byte/different-identity race fixture also remains protected so it reaches
the identity guard instead of being refused by the new ACL prerequisite.

This does not yet enable safe writes for an actual inherited Pi profile; a fully
functional inherited-ACL-preserving publication method remains an open gap. No
real ACL normalization, security-policy change, environment permission bypass,
remote push, PR update, model call or onsite write is part of this revision.
New Windows protected-write and unchanged-refusal tests remain unexecuted in this
Linux environment. Local unit regressions verify flag-change rejection, terminal
unsupported status and no repeat discovery/write; they are not Windows proof.
