# Read-only process/owner evidence. No stop, ACL change, service or credential action.
[CmdletBinding()]
param([string]$LifecycleFile,[string]$ConfigurationFile,[string]$StatusFile,[string]$RuntimeFile,
      [int]$OldProcessId,[int]$RecoveryProcessId,[string]$NodePath,[string]$HerdrPath,
      [string]$PiEntry,[string]$EnrollmentFile,[string]$HostRoot)
$ErrorActionPreference = 'Stop'
try {
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    foreach ($file in @($LifecycleFile,$ConfigurationFile,$RuntimeFile,$StatusFile)) {
        $owner = (Get-Acl -LiteralPath $file).GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($owner -ne $sid) { throw 'owner_not_verified' }
    }
    $blocked = $false
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
    if ($blocked) { throw 'referenced_process_present' }
    '{"ownerVerified":true,"oldHostAbsent":true,"referencedProcessesAbsent":true}'
} catch {
    # Never emit command lines, private paths, identities or raw CIM/ACL errors.
    [Console]::Error.WriteLine('host_recovery_process_evidence_unavailable')
    exit 2
}
