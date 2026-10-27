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
