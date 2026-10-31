param([string]$Target)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
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
