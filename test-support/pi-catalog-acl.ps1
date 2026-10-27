param([string]$Target, [ValidateSet('read','restrict-fixture','inherit-fixture')][string]$Mode = 'read')
$ErrorActionPreference = 'Stop'
# Windows PowerShell startup may prepend AllUsers paths even to an explicitly
# supplied PSModulePath. Pin discovery after startup too, in this child only.
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
if ($Mode -ne 'read') {
  # Only a newly created synthetic test file is eligible. No production helper
  # imports this script, and no user/profile/root ACL is modified.
  $info = Get-Item -LiteralPath $Target
  $data = Get-Content -LiteralPath $Target -Raw | ConvertFrom-Json
  if ($info.Name -ne 'models.json' -or $info.Directory.Name -notlike 'pi-catalog-*' -or
      $data.providers.approved.apiKey -cne '$EXISTING_AUTH_REFERENCE' -or
      $data.providers.approved.models[0].id -cne 'old') { throw 'Not a synthetic ACL fixture' }
  if ($Mode -eq 'restrict-fixture') {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl = [Security.AccessControl.FileSecurity]::new()
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
  } else {
    $acl = Get-Acl -LiteralPath $Target
    $acl.SetAccessRuleProtection($false, $true)
  }
  Set-Acl -LiteralPath $Target -AclObject $acl
}
$acl = Get-Acl -LiteralPath $Target
$raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
$entries = @()
if ($null -ne $raw.DiscretionaryAcl) {
  foreach ($ace in $raw.DiscretionaryAcl) {
    $bytes = New-Object byte[] $ace.BinaryLength
    $ace.GetBinaryForm($bytes, 0)
    # Remove only INHERITED_ACE from the serialized comparison key. SID,
    # access mask, type, object/callback data and every other flag stay exact.
    $bytes[1] = $bytes[1] -band 0xEF
    $entries += @{ inherited = [bool]$ace.IsInherited; binary = [Convert]::ToBase64String($bytes) }
  }
}
@{ owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value;
   group = $acl.GetGroup([Security.Principal.SecurityIdentifier]).Value;
   protected = $acl.AreAccessRulesProtected;
   nullDacl = ($null -eq $raw.DiscretionaryAcl); aces = $entries } | ConvertTo-Json -Depth 4 -Compress
