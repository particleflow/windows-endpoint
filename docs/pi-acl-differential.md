# Windows Pi catalog ACL publication differential (local only)

This is a bounded diagnostic, not a new publisher or activation. Local guard
81076c20dade687dc5d97487888a4391cf449427 prevents unsafe writes but does not deliver
automatic sync for ordinary inherited profiles. It is not proposed as the final
functional solution. No real profile is made protected or changed by this work.

## What is determined from primary sources

Microsoft .NET Framework reference source's File.InternalReplace calls
Win32Native.ReplaceFile. With ignoreMetadataErrors=false it does not add the
IGNORE_MERGE_ERRORS flag; the reference source still sets WRITE_THROUGH (flag 1),
which the Win32 documentation lists as unsupported. Thus switching from .NET to
P/Invoke is not by itself an independent ACL-preserving mechanism. The diagnostic
measures both native flag 0 and flag 1 rather than assuming flag equivalence.

- https://github.com/microsoft/referencesource/blob/main/mscorlib/system/io/file.cs#L1341
  (read blob cdfa40d88d45fd7e9e8cf307a6a2ed074ee0bd8d)
- https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew

The real CI40575784260 counterexample remains: inherited flags became explicit
after replacement, and the original strict test stopped before backup/protected
checks. Microsoft documents removal of inherited copies when a parent grant is
removed. Equal current rights therefore do not prove equal future revocation.
There is no evidence that fixture initialization alone caused that difference.

- https://learn.microsoft.com/en-us/windows/win32/secauthz/automatic-propagation-of-inheritable-aces
- https://learn.microsoft.com/en-us/windows/win32/secauthz/ace-inheritance-rules

SetSecurityInfo supports file handles and propagation; it can be investigated
for a supported security-descriptor update. However, applying it after a separate
ReplaceFile would be a second mutation with an intermediate/crash state, not an
atomic content+ACL transaction. A handle avoids updating a subsequently rebound
path, but does not remove that atomicity gap. No production ACL-restoration write
has been added. SetKernelObjectSecurity is explicitly not recommended for file
system objects, so it is not used to force descriptor bits. TxF is not adopted:
Microsoft recommends alternatives rather than new dependence on that platform.

- https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo
- https://learn.microsoft.com/en-us/windows/win32/api/securitybaseapi/nf-securitybaseapi-setkernelobjectsecurity
- https://learn.microsoft.com/en-us/windows/win32/fileio/deprecation-of-txf

## Finite synthetic experiment

`test-support/pi-catalog-propagation.ps1` accepts an existing disposable project
fixture parent. It creates one fresh GUID subtree, never reads a Pi profile,
does not contact a model endpoint, and changes permissions only inside that new
synthetic subtree. Its parent/owner retains FullControl. Users and Guests get
temporary read-only grants on synthetic strings, not private user data. The
script uses Windows PowerShell's own module directory in its child process and
cleans only the GUID subtree it created. It does not change the supplied parent
ACL, registry, global environment or security policy.

The five independent cases are an untouched control, .NET File.Replace,
ReplaceFileW flag 0, ReplaceFileW flag 1, and same-directory MoveFileExW with
REPLACE_EXISTING after cloning the original DACL onto our staging fixture.
Each records the full owner/group/DACL SDDL and typed grant flags before and
after publication, after adding a new inherited parent grant, and after removing
both the old and new grants from the parent. ReplaceFile variants record their
actual backups too. The control must receive and lose the grants correctly;
otherwise the experiment is inconclusive. No masks or inherited flags are
normalized to turn a difference into a pass. The experiment completes all cases
even if one native call fails, and reports native error codes without user data.

Example for the Windows owner, ONLY inside its independently approved temporary
project/source staging root, using existing Windows PowerShell:

```powershell
& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" `
  -NoLogo -NoProfile -NonInteractive -File .\test-support\pi-catalog-propagation.ps1 `
  -FixtureParent $isolatedProjectTemp
```

`controlValid=true` and all `completed=true` mean the diagnostic completed, not
that a product path is accepted. Each variant's `initialInheritanceRetained`,
`acceptedNewInheritedGrant`, `removedOldGrant`, `removedNewGrant` and complete
snapshots must be assessed separately. `propagationEquivalent` is a summary of
these particular grants only; it is not proof for every possible DACL or writer.
The current Linux environment has neither Windows PowerShell nor Wine. This
script has NOT executed here; Windows syntax/native/propagation validation is
pending. No additional Windows success is claimed.

## Exact publishing boundary and an ACL-free route

ReplaceFile provides an actual displaced-original backup, but the observed
inheritance conversion prevents claiming the required security semantics.
MoveFileEx permits replacement using the staging object's descriptor, which the
experiment measures. It supplies no atomically captured displaced destination:
an earlier hardlink/read backup can miss a different file an editor swapped in
between comparison and rename. Separate renames add a missing-target/crash window.
Do not substitute either and claim both arbitrary-writer CAS and retained edits.

- https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw

No reviewed API contract here establishes all three requirements together:
atomic publication with real displaced-original retention, arbitrary external
writer conflict protection, and unchanged inherited revocation behavior. This
is a limit of the investigated paths, not a proof that all Windows designs are
impossible. Stronger coordinated single-writer ownership or a separately proven
native implementation would require an explicit design/acceptance change.

An alternative that does not touch user ACLs or models.json is Pi's official
in-process provider discovery: register the existing Magpie provider through
registerProvider/refreshModels in the actual Pi process, compose the user's
existing definitions over discovered metadata, and retain the current model.
The existing Magpie projection/GET logic can supply that callback; unknown output
limits remain deferred. Both interactive /model and an awaited JSON session-start
refresh must be wired. A host's separate SDK instance cannot silently mutate an
already running Pi registry. This needs the real Pi launch/resource composition
owner to expose an approved existing extension hook; it is not authorization to
install another plugin, replace Pi/profile, invent an RPC command or add a service.
Until that hook is established under the existing constraints, it is a feasible
official integration route, not a completed or enabled feature.

- https://github.com/earendil-works/pi/blob/v1.4.0/packages/coding-agent/docs/custom-provider.md#L153

This revision adds only diagnostic source/evidence. It neither weakens the
strict ACL assertion nor removes the local safety guard. It remains unpushed;
no PR, remote workflow, onsite configuration or permission was changed.
