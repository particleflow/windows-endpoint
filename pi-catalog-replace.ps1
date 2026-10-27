param([string]$Target, [string]$Temporary, [string]$Backup, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
try {
  # Keep the actual displaced file; do not restore automatically or ignore ACL errors.
  if ([IO.File]::GetAttributes($Target) -band [IO.FileAttributes]::ReparsePoint) { exit 3 }
  $before = [IO.File]::GetAccessControl($Target)
  # ReplaceFile has been observed converting inherited ACEs to explicit ACEs.
  # Never normalize/protect the user's ACL to make replacement possible.
  if (-not $before.AreAccessRulesProtected) { exit 4 }
  $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($before.GetSecurityDescriptorBinaryForm(), 0)
  if ($null -eq $descriptor.DiscretionaryAcl) { exit 4 }
  foreach ($rule in $before.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.IsInherited) { exit 4 }
  }
  if ($CheckOnly) { exit 0 }
  [IO.File]::Replace($Temporary, $Target, $Backup, $false)
  # Verify the actual displaced original and installed descriptor. On mismatch
  # retain both files and the caller's pending marker; never restore over edits.
  $old = [IO.File]::GetAccessControl($Backup)
  $new = [IO.File]::GetAccessControl($Target)
  $sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
  if (-not $old.AreAccessRulesProtected -or -not $new.AreAccessRulesProtected -or
      $old.GetSecurityDescriptorSddlForm($sections) -cne $new.GetSecurityDescriptorSddlForm($sections)) { exit 5 }
} catch { exit 2 }
