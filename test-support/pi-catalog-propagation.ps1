param([Parameter(Mandatory=$true)][string]$FixtureParent)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
# Diagnostic only. No production import, profile input, network, credential,
# existing-file ACL update, or registry/security-policy change is supported.
$parent = [IO.DirectoryInfo]::new([IO.Path]::GetFullPath($FixtureParent))
if (-not $parent.Exists -or ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Existing ordinary fixture parent required' }
$root = [IO.Path]::Combine($parent.FullName, 'pi-propagation-' + [Guid]::NewGuid().ToString('N'))
$sections = [Security.AccessControl.AccessControlSections]::Access -bor [Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Group
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$users = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-545')
$guests = [Security.Principal.SecurityIdentifier]::new('S-1-5-32-546')
$inherit = [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit
function Rule($sid, $rights) {
  return [Security.AccessControl.FileSystemAccessRule]::new($sid, $rights, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
}
function Snapshot([string]$file) {
  $acl = [IO.File]::GetAccessControl($file)
  $rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
    @{ sid=$_.IdentityReference.Value; rights=[int64]$_.FileSystemRights; inherited=$_.IsInherited; inheritance=[int]$_.InheritanceFlags; propagation=[int]$_.PropagationFlags; type=[int]$_.AccessControlType }
  })
  return @{ protected=$acl.AreAccessRulesProtected; sddl=$acl.GetSecurityDescriptorSddlForm($sections); rules=$rules }
}
function HasGrant($snapshot, [string]$sid, [bool]$inheritedOnly) {
  return @($snapshot.rules | Where-Object { $_.sid -eq $sid -and $_.type -eq 0 -and (-not $inheritedOnly -or $_.inherited) }).Count -gt 0
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class PiCatalogPropagationNative {
  [DllImport("kernel32.dll", EntryPoint="ReplaceFileW", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool Replace(string target, string source, string backup, uint flags, IntPtr exclude, IntPtr reserved);
  [DllImport("kernel32.dll", EntryPoint="MoveFileExW", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool Move(string source, string target, uint flags);
}
'@
$results = @()
try {
  [IO.Directory]::CreateDirectory($root) | Out-Null
  foreach ($mode in @('control','dotnet-replace','win32-replace','win32-replace-flag1','move-cloned-descriptor')) {
    $record = @{ mode=$mode; completed=$false }
    try {
      $dir = [IO.Path]::Combine($root, $mode)
      [IO.Directory]::CreateDirectory($dir) | Out-Null
      # Every permission operation is on our newly created synthetic subtree.
      # The owner remains FullControl; the two disposable grants carry no secrets.
      $acl = [Security.AccessControl.DirectorySecurity]::new()
      $acl.SetOwner($user); $acl.SetAccessRuleProtection($true, $false)
      $acl.AddAccessRule((Rule $user ([Security.AccessControl.FileSystemRights]::FullControl)))
      $initialGrant = Rule $users ([Security.AccessControl.FileSystemRights]::Read)
      $addedGrant = Rule $guests ([Security.AccessControl.FileSystemRights]::Read)
      $acl.AddAccessRule($initialGrant)
      [IO.Directory]::SetAccessControl($dir, $acl)
      $file = [IO.Path]::Combine($dir,'models.json')
      $source = [IO.Path]::Combine($dir,'next.json')
      $backup = [IO.Path]::Combine($dir,'previous.json')
      [IO.File]::WriteAllText($file,'{"synthetic":"original"}')
      [IO.File]::WriteAllText($source,'{"synthetic":"next"}')
      $record.before = Snapshot $file
      if (-not (HasGrant $record.before $users.Value $true)) { throw 'Control initialization did not create inherited grant' }
      switch ($mode) {
        'dotnet-replace' { [IO.File]::Replace($source,$file,$backup,$false) }
        'win32-replace' {
          if (-not [PiCatalogPropagationNative]::Replace($file,$source,$backup,0,[IntPtr]::Zero,[IntPtr]::Zero)) { $record.nativeError=[Runtime.InteropServices.Marshal]::GetLastWin32Error(); throw 'ReplaceFileW failed' }
        }
        'win32-replace-flag1' {
          # .NET Framework reference source uses flag 1; Win32 docs say that
          # WRITE_THROUGH flag is unsupported. Measure, do not assume a fix.
          if (-not [PiCatalogPropagationNative]::Replace($file,$source,$backup,1,[IntPtr]::Zero,[IntPtr]::Zero)) { $record.nativeError=[Runtime.InteropServices.Marshal]::GetLastWin32Error(); throw 'ReplaceFileW flag1 failed' }
        }
        'move-cloned-descriptor' {
          # Experimental only: cloning onto our own staging file is not a
          # production permission change and does not solve displaced-file CAS.
          [IO.File]::SetAccessControl($source,[IO.File]::GetAccessControl($file))
          $record.staged = Snapshot $source
          if (-not [PiCatalogPropagationNative]::Move($source,$file,1)) { $record.nativeError=[Runtime.InteropServices.Marshal]::GetLastWin32Error(); throw 'MoveFileExW failed' }
        }
      }
      $record.afterReplace = Snapshot $file
      if ([IO.File]::Exists($backup)) { $record.backupAfterReplace = Snapshot $backup }
      $acl = [IO.Directory]::GetAccessControl($dir)
      $acl.AddAccessRule($addedGrant)
      [IO.Directory]::SetAccessControl($dir,$acl)
      $record.afterParentAdd = Snapshot $file
      $acl = [IO.Directory]::GetAccessControl($dir)
      $acl.RemoveAccessRuleSpecific($initialGrant); $acl.RemoveAccessRuleSpecific($addedGrant)
      [IO.Directory]::SetAccessControl($dir,$acl)
      $record.afterParentRemove = Snapshot $file
      if ([IO.File]::Exists($backup)) { $record.backupAfterParentRemove = Snapshot $backup }
      $record.acceptedNewInheritedGrant = HasGrant $record.afterParentAdd $guests.Value $true
      $record.removedOldGrant = -not (HasGrant $record.afterParentRemove $users.Value $false)
      $record.removedNewGrant = -not (HasGrant $record.afterParentRemove $guests.Value $false)
      $record.initialInheritanceRetained = HasGrant $record.afterReplace $users.Value $true
      $record.propagationEquivalent = $record.acceptedNewInheritedGrant -and $record.removedOldGrant -and $record.removedNewGrant -and $record.initialInheritanceRetained
      $record.completed = $true
    } catch {
      # Errors arise solely from synthetic APIs/paths, not credentials/profile.
      $record.errorType = $_.Exception.GetType().FullName
      $record.errorHResult = $_.Exception.HResult
    }
    $results += $record
  }
  $control = $results[0]
  @{schema=1; diagnosticOnly=$true; productionEnabled=$false; controlValid=($control.completed -and $control.propagationEquivalent); results=$results} | ConvertTo-Json -Depth 9 -Compress
  # Exit 0 means a valid comparative experiment, NOT product/variant acceptance.
  if (-not $control.completed -or -not $control.propagationEquivalent -or @($results | Where-Object {-not $_.completed}).Count) { exit 2 }
} finally {
  # Only the fresh GUID subtree we allocated is eligible for cleanup.
  if ([IO.Directory]::Exists($root)) { [IO.Directory]::Delete($root,$true) }
}
