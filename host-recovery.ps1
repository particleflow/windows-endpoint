# Read-only process/owner evidence. No stop, ACL change, service or credential action.
[CmdletBinding()]
param([string]$LifecycleFile,[string]$ConfigurationFile,[string]$StatusFile,[string]$RuntimeFile,
      [int]$OldProcessId,[int]$RecoveryProcessId,[string]$NodePath,[string]$HerdrPath,
      [string]$PiEntry,[string]$EnrollmentFile,[string]$HostRoot)
$ErrorActionPreference = 'Stop'
$stage = 'file_owner'
try {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    # Match the fixed official Runtime's trusted Windows principals. Elevated
    # file creation can legitimately select Administrators as owner. Read only.
    $trusted = @($sid, 'S-1-5-18', 'S-1-5-32-544', 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')
    foreach ($file in @($LifecycleFile,$ConfigurationFile,$RuntimeFile,$StatusFile)) {
        $acl = Get-Acl -LiteralPath $file
        if ($trusted -notcontains $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw 'owner_not_verified' }
        foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
            if ($rule.AccessControlType -ne 'Allow' -or $trusted -contains $rule.IdentityReference.Value -or ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly)) { continue }
            $unsafe = [Security.AccessControl.FileSystemRights]::Write -bor [Security.AccessControl.FileSystemRights]::Delete -bor [Security.AccessControl.FileSystemRights]::ChangePermissions -bor [Security.AccessControl.FileSystemRights]::TakeOwnership
            if ($rule.FileSystemRights -band $unsafe) { throw 'untrusted_file_writer' }
        }
    }
    $blocked = $false
    $stage = 'process_inventory'
    foreach ($p in @(Get-CimInstance Win32_Process)) {
        if ($p.ProcessId -eq $OldProcessId) { $blocked = $true; break }
        if ($p.ProcessId -eq $RecoveryProcessId -or $p.ProcessId -eq $PID) { continue }
        if ($p.Name -notin @('node.exe','herdr.exe')) { continue }
        if (-not $p.ExecutablePath -or -not $p.CommandLine) { throw 'process_observation_unknown' }
        if ($p.ExecutablePath -eq $HerdrPath) { $blocked = $true; break }
        if ($p.ExecutablePath -eq $NodePath) {
            foreach ($reference in @($PiEntry,$EnrollmentFile,$HostRoot)) {
                if ($p.CommandLine.IndexOf($reference,[StringComparison]::OrdinalIgnoreCase) -ge 0) { $blocked = $true; break }
            }
        }
        if ($blocked) { break }
    }
    $stage = 'process_absence'
    if ($blocked) { throw 'referenced_process_present' }
    '{"ownerVerified":true,"oldHostAbsent":true,"referencedProcessesAbsent":true}'
} catch {
    # Never emit command lines, private paths, identities or raw CIM/ACL errors.
    [Console]::Error.WriteLine(('{"error":"host_recovery_process_evidence_unavailable","stage":"' + $stage + '"}'))
    exit 2
}
