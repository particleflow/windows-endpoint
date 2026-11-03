# Registers/unregisters the GarnetEndpointSupervisor scheduled task (design v2 section 1).
# Pure ASCII. Self-elevates (silent on this machine: ConsentPromptBehaviorAdmin=0).
param([ValidateSet('Register','Unregister','Status')][string]$Action = 'Register')
$ErrorActionPreference = 'Stop'
$TaskName = 'GarnetEndpointSupervisor'
$ScriptPath = 'F:\NAS-Assistant\deploy\supervisor\supervisor.ps1'
$RegLog = 'F:\NAS-Assistant\tmp\register-supervisor.log'
function RLog([string]$m) { Add-Content -LiteralPath $RegLog -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $m) }
$principalCheck = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Verb RunAs -ArgumentList @('-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File', ('"'+$PSCommandPath+'"'), '-Action', $Action) | Out-Null
    exit 0
}
try {
    RLog ('action=' + $Action + ' elevated-run-start')
    if ($Action -eq 'Status') {
        Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Format-List TaskName,State
        Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue | Format-List LastRunTime,LastTaskResult,NumberOfMissedRuns,NextRunTime
        exit 0
    }
    if ($Action -eq 'Unregister') {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction Stop
        RLog 'UNREGISTERED'
        exit 0
    }
    $taskAction = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}"' -f $ScriptPath)
    $triggerBoot = New-ScheduledTaskTrigger -AtStartup
    $triggerBeat = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
    $taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $triggerBoot,$triggerBeat -Principal $taskPrincipal -Settings $taskSettings -Force | Out-Null
    RLog 'REGISTERED'
    Start-ScheduledTask -TaskName $TaskName
    RLog 'STARTED'
} catch {
    RLog ('FAILED: ' + $_.Exception.Message)
    exit 2
}
