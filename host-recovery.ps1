# Read-only process/owner evidence. No stop, ACL change, service or credential action.
[CmdletBinding()]
param([string]$LifecycleFile,[string]$ConfigurationFile,[string]$StatusFile,[string]$RuntimeFile,
      [int]$OldProcessId,[int]$RecoveryProcessId,[string]$NodePath,[string]$HerdrPath,
      [string]$PiEntry,[string]$EnrollmentFile,[string]$HostRoot,[string]$SourceRoot,[string]$HerdrSession,[string]$RuntimeEntry)
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
    $stage = 'process_inventory'
    # Use the OS command-line decoder; never split quoted paths on whitespace.
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RecoveryArgv {
 [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CommandLineToArgvW(string line, out int count);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
 public static string[] Decode(string line) {
  int count; IntPtr p=CommandLineToArgvW(line,out count);
  if(p==IntPtr.Zero) throw new InvalidOperationException();
  try { string[] a=new string[count]; for(int i=0;i<count;i++)a[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(p,i*IntPtr.Size)); return a; }
  finally { LocalFree(p); }
 }
}
'@
    function Same-Path([string]$a,[string]$b) {
        try { return [IO.Path]::IsPathRooted($a) -and ([IO.Path]::GetFullPath($a).TrimEnd('\') -eq [IO.Path]::GetFullPath($b).TrimEnd('\')) } catch { return $false }
    }
    function Inside-Path([string]$a,[string]$b) {
        try {
            if (-not [IO.Path]::IsPathRooted($a)) { return $false }
            $x = [IO.Path]::GetFullPath($a).TrimEnd('\'); $y = [IO.Path]::GetFullPath($b).TrimEnd('\')
            return $x -eq $y -or $x.StartsWith($y+'\',[StringComparison]::OrdinalIgnoreCase)
        } catch { return $false }
    }
    function Base-Name([string]$value) { try { return [IO.Path]::GetFileName($value) } catch { return '' } }
    function Flag-Value($argv,[string]$flag) {
        $values = @()
        for ($i=1;$i -lt $argv.Count;$i++) {
            if ($argv[$i] -eq $flag) { if ($i+1 -ge $argv.Count) { return '!unknown' }; $values += $argv[$i+1]; $i++ }
            elseif ($argv[$i].StartsWith($flag+'=')) { $values += $argv[$i].Substring($flag.Length+1) }
        }
        if ($values.Count -gt 1) { return '!unknown' }
        if ($values.Count -eq 0) { return '' }
        return $values[0]
    }
    $records = @()
    $currentSession = [Diagnostics.Process]::GetCurrentProcess().SessionId
    foreach ($p in @(Get-CimInstance Win32_Process)) {
        # Win32_Process can retain an exiting row with empty detail fields.
        # One same-provider/same-generation recheck; a live unreadable process
        # or PID reuse remains unknown. No looping, stop, or alternate arg read.
        if ($p.Name -in @('node.exe','herdr.exe') -and (-not $p.ExecutablePath -or -not $p.CommandLine)) {
            $fresh = @(Get-CimInstance Win32_Process -Filter ("ProcessId="+[int]$p.ProcessId) -OperationTimeoutSec 3)
            if ($fresh.Count -eq 0) {
                try { $live=[Diagnostics.Process]::GetProcessById([int]$p.ProcessId); $live.Dispose() }
                catch [ArgumentException] { continue } # Observed absent, not merely unreadable.
            } elseif ($fresh.Count -eq 1 -and $null -ne $p.CreationDate -and $fresh[0].CreationDate -eq $p.CreationDate -and $fresh[0].ParentProcessId -eq $p.ParentProcessId) {
                $p = $fresh[0]
            }
        }
        $role = 'other'; $scope = 'unknown'; $referencesOriginal = $false
        $created = $null
        if ($null -ne $p.CreationDate) { $created = ([DateTimeOffset]$p.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds() }
        if ($p.ProcessId -ne $RecoveryProcessId -and $p.ProcessId -ne $PID -and $p.Name -in @('node.exe','herdr.exe')) {
            # A known different Node executable is outside the configured
            # component inventory, even if its arguments are not readable.
            if ($p.Name -eq 'node.exe' -and $p.ExecutablePath -and -not (Same-Path $p.ExecutablePath $NodePath)) { $role='other' }
            elseif (-not $p.ExecutablePath -or -not $p.CommandLine) { $role = 'unknown' }
            elseif ($p.Name -eq 'herdr.exe' -or (Same-Path $p.ExecutablePath $NodePath)) {
                $argv = [RecoveryArgv]::Decode($p.CommandLine)
                $role = 'node'
                foreach ($arg in $argv) {
                    if ((Inside-Path $arg $HostRoot) -or (Inside-Path $arg $SourceRoot) -or (Same-Path $arg $EnrollmentFile)) { $referencesOriginal = $true }
                    if (Same-Path $arg $PiEntry) { $role = 'pi' }
                }
                if ($role -eq 'node') {
                    foreach ($arg in $argv) {
                        if ((Same-Path $arg $RuntimeEntry) -or (Base-Name $arg) -eq 'native-connector-child.mjs') { $role='connector' }
                    }
                }
                if ($p.Name -eq 'herdr.exe') {
                    $role = 'herdr'; $session = Flag-Value $argv '--session'
                    $canonical = ($argv.Count -eq 4 -and $argv[1] -eq '--session' -and $argv[3] -eq 'server') -or
                        ($argv.Count -eq 3 -and $argv[1].StartsWith('--session=') -and $argv[2] -eq 'server') -or
                        ($argv.Count -eq 2 -and $argv[1] -eq 'server')
                    if (-not $canonical) { $session='!unknown' }
                    elseif (-not $session) { if ($argv.Count -eq 2) { $session = 'default' } else { $session='!unknown' } }
                    if ($session -eq $HerdrSession) { $scope = 'same' }
                    elseif ($session -ne '!unknown' -and $argv -contains 'server') { $scope = 'different_session' }
                } elseif ($role -eq 'pi') {
                    $dir = Flag-Value $argv '--session-dir'; $history = Flag-Value $argv '--session'; $mode = Flag-Value $argv '--mode'
                    if ($dir -and $dir -ne '!unknown' -and [IO.Path]::IsPathRooted($dir)) {
                        if (Inside-Path $dir $SourceRoot) { $scope='same' } else { $scope='different_task_root' }
                    } elseif (-not $dir -and -not $history -and (-not $mode -or $mode -eq 'text')) { $scope='interactive' }
                    if ($history -and (Inside-Path $history $SourceRoot)) { $referencesOriginal=$true }
                } elseif ($role -eq 'connector') {
                    $selected = Flag-Value $argv '--config'
                    if ($argv.Count -eq 4 -and (Base-Name $argv[1]) -eq 'native-connector-child.mjs') { $selected=$argv[3] }
                    if ($selected -and [IO.Path]::IsPathRooted($selected) -and -not (Same-Path $selected $EnrollmentFile) -and -not (Inside-Path $selected $HostRoot)) { $scope='different_enrollment' }
                } else { $scope='other_program' }
            }
        }
        $records += [ordered]@{ id=[int]$p.ProcessId; parent=[int]$p.ParentProcessId; created=$created; windowsSession=[int]$p.SessionId;
            role=$role; scope=$scope; originalReference=$referencesOriginal }
    }
    # Only IDs/times and bounded classifications cross this private child pipe.
    # No command lines, arguments, paths, environment or credentials are emitted.
    @{ ownerVerified=$true; oldHostAbsent=(@($records | Where-Object {$_.id -eq $OldProcessId}).Count -eq 0);
       currentSession=$currentSession; processes=$records } | ConvertTo-Json -Depth 4 -Compress

} catch {
    # Never emit command lines, private paths, identities or raw CIM/ACL errors.
    [Console]::Error.WriteLine(('{"error":"host_recovery_process_evidence_unavailable","stage":"' + $stage + '"}'))
    exit 2
}
