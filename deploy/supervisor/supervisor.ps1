# Garnet endpoint supervisor. Design v2 (2026-10-31).
# Runs as SYSTEM via scheduled task "GarnetEndpointSupervisor".
# Pure ASCII only (PS 5.1 GBK parse trap with UTF-8 no-BOM).
$ErrorActionPreference = 'Continue'
$SupRoot   = 'F:\NAS-Assistant\deploy\supervisor'
$HostRoot  = 'F:\NAS-Assistant\deploy\.build\windows-endpoint\host'
$LogDir    = Join-Path $HostRoot 'logs\supervisor'
$CommandFile = Join-Path $SupRoot 'command.json'
$SupLog      = Join-Path $LogDir ('supervisor-' + (Get-Date -Format yyyyMMdd) + '.log')
$TickSeconds = 10
$FreshMs     = 5000
$AttentionTicks = 0
$script:Proc = $null

function Log([string]$m) {
    $line = ('{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $m)
    Add-Content -LiteralPath $SupLog -Value $line
}
function Read-JsonText([string]$path) {
    try {
        $raw = [IO.File]::ReadAllText($path)
        if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
        return ConvertFrom-Json -InputObject $raw
    } catch { return $null }
}
function Get-Config { return Read-JsonText (Join-Path $HostRoot 'config\endpoint.json') }
function Get-NodePath { $c = Get-Config; if ($null -eq $c) { throw 'config unreadable' }; return $c.programs.node }
function Get-DeployState { return Read-JsonText (Join-Path $HostRoot 'control\deployment.json') }
function Get-CurrentCli {
    $d = Get-DeployState
    if ($null -eq $d -or [string]::IsNullOrEmpty($d.current)) { throw 'deployment current missing' }
    return (Join-Path $HostRoot ('packages\' + $d.current + '\endpoint.mjs'))
}
function Get-Journal { return Read-JsonText (Join-Path $HostRoot 'data\endpoint\lifecycle.json') }
function Get-HostStatus { return Read-JsonText (Join-Path $HostRoot 'data\endpoint\host-status.json') }

function Get-Observation {
    # pid liveness + freshness only (no log generation parse: cheap tick path)
    $s = Get-HostStatus
    $alive = $false; $fresh = $false
    if ($null -ne $s -and $null -ne $s.pid -and $s.pid -gt 0) {
        try { $p = Get-Process -Id ([int]$s.pid) -ErrorAction Stop; if ($p.Name -eq 'node') { $alive = $true } } catch {}
    }
    if ($null -ne $s -and $null -ne $s.updatedAt) {
        $age = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [long]$s.updatedAt
        $fresh = ($age -ge 0 -and $age -lt $FreshMs)
    }
    return [pscustomobject]@{ status = $s; alive = $alive; fresh = $fresh }
}

function Test-MarkerBlocked {
    foreach ($m in 'profile-switch-pending.json','pi-native-catalog-pending.json','producer-upgrade-pending.json') {
        if (Test-Path (Join-Path $HostRoot ('data\endpoint\' + $m))) { return $true }
    }
    return $false
}
function Test-GateStopped {
    $j = Get-Journal
    if ($null -eq $j) { return $false }
    $noHandoff = ($null -eq $j.handoff) -or ($j.PSObject.Properties.Name -notcontains 'handoff')
    return ($j.phase -eq 'stopped' -and $null -eq $j.attention -and $noHandoff)
}

function Invoke-HostRecover {
    # running/null (or other recoverable arm) -> minted stopped/null.
    # All expected hashes computed by node itself (never hand-escaped here).
    $s = Get-HostStatus; $j = Get-Journal
    if ($null -eq $s -or $null -eq $j) { return $false }
    $node = Get-NodePath
    $cli = Get-CurrentCli
    $lifecyclePath = Join-Path $HostRoot 'data\endpoint\lifecycle.json'
    $stateHash = (Get-FileHash -LiteralPath $lifecyclePath -Algorithm SHA256).Hash.ToLowerInvariant()
    $hashCode = "const f=require('node:fs'),c=require('node:crypto');console.log(c.createHash('sha256').update(JSON.stringify([f.readFileSync(process.argv[1],'utf8'),f.readFileSync(process.argv[2],'utf8')])).digest('hex'))"
    $hashOut = & $node -e $hashCode (Join-Path $HostRoot 'config\endpoint.json') (Join-Path $HostRoot 'config\runtime.json') 2>&1
    $configHash = @($hashOut | Where-Object { $_ -match '^[0-9a-f]{64}$' } | Select-Object -First 1)
    if ($configHash.Count -ne 1 -or [string]::IsNullOrEmpty($configHash[0])) {
        Log ('RECOVER hash-compute failed exit=' + $LASTEXITCODE + ' out=' + (($hashOut | ForEach-Object { [string]$_ }) -join ' | '))
        return $false
    }
    $configHash = [string]$configHash[0]
    $out = & $node $cli host recover --root $HostRoot --expected-run $s.runId --expected-state-sha256 $stateHash.Trim() --expected-configuration-sha256 $configHash.Trim() 2>&1
    Log ('RECOVER out=' + ($out -join ' '))
    return ($LASTEXITCODE -eq 0)
}

function Start-HostChild {
    $node = Get-NodePath
    $cli = Get-CurrentCli
    $outLog = Join-Path $LogDir ('host-' + (Get-Date -Format yyyyMMdd-HHmmss) + '.log')
    # cmd /c keeps stdout/stderr on a file (no pipe buffer to drain) while the
    # stdin pipe stays ours and is inherited by node through cmd.
    $si = New-Object System.Diagnostics.ProcessStartInfo
    $si.FileName = "$env:SystemRoot\System32\cmd.exe"
    $si.Arguments = ('/c ""{0}" "{1}" deploy run --root "{2}" > "{3}" 2>&1"' -f $node, $cli, $HostRoot, $outLog)
    $si.UseShellExecute = $false
    $si.RedirectStandardInput = $true
    $si.CreateNoWindow = $true
    $si.WorkingDirectory = $HostRoot
    $p = New-Object System.Diagnostics.Process
    $p.StartInfo = $si
    $null = $p.Start()
    $script:Proc = $p
    Log ('START host via cmd pid=' + $p.Id + ' out=' + $outLog + ' cli=' + $cli)
    return $p
}
function Invoke-StopSequence {
    # Design section 3: rewrite stop up to 3 times; never hard-kill here.
    for ($i = 1; $i -le 3; $i++) {
        $null = Send-StopToChild
        if (Wait-CleanExit 40) { Log ('STOP clean on attempt ' + $i); return $true }
    }
    Log 'STOP 3 attempts failed - keep and log (no hard kill)'
    return $false
}
function Send-StopToChild {
    if ($null -eq $script:Proc -or $script:Proc.HasExited) { return $true }
    try {
        $script:Proc.StandardInput.WriteLine('{"action":"stop"}')
        $script:Proc.StandardInput.Flush()
        return $true
    } catch { Log ('STOP write failed: ' + $_.Exception.Message); return $false }
}
function Wait-CleanExit([int]$timeoutSeconds) {
    # Returns $true when process exited AND journal is stopped/null.
    $deadline = [DateTime]::UtcNow.AddSeconds($timeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if ($script:Proc.HasExited) { break }
        Start-Sleep -Seconds 2
    }
    if (-not $script:Proc.HasExited) { return $false }
    Start-Sleep -Seconds 3
    return (Test-GateStopped)
}
function Invoke-ControlledRecoveryStop {
    # G1 sequence: clean stop attempt -> controlled hard stop -> host recover.
    $hostPid = $null
    $obs = Get-Observation
    if ($null -ne $obs.status) { $hostPid = $obs.status.pid }
    Send-StopToChild
    $clean = Wait-CleanExit 90
    if ($clean) { Log 'G1 clean stop achieved'; return $true }
    if ($null -ne $hostPid -and $hostPid -gt 0) {
        try {
            Stop-Process -Id ([int]$hostPid) -Force -ErrorAction Stop
            Log ('G1 controlled hard stop pid=' + $hostPid)
        } catch { Log ('G1 hard stop failed: ' + $_.Exception.Message); return $false }
        Start-Sleep -Seconds 3
    }
    $ok = Invoke-HostRecover
    Log ('G1 recover result=' + $ok)
    return $ok
}
function Invoke-D1Reset([string]$code) {
    $statePath = Join-Path $HostRoot 'data\endpoint\lifecycle.json'
    $backup = $statePath + '.bak-d1-' + (Get-Date -Format yyyyMMddHHmmss)
    Copy-Item -LiteralPath $statePath -Destination $backup
    $cfg = Get-Config
    $default = @{ schema = 1; identity = $cfg.deviceId; phase = 'stopped'; restarts = @(); attention = $null } | ConvertTo-Json -Depth 3
    [IO.File]::WriteAllText($statePath, $default + "`n")
    Log ('D1 reset code=' + $code + ' backup=' + $backup)
    return $true
}

function Invoke-UpdateRestart([string]$sourceDir, [string]$manifest) {
    $ok = Invoke-ControlledRecoveryStop
    if (-not $ok) { Log 'UPDATE controlled stop failed'; return $false }
    $node = Get-NodePath
    $cli = Get-CurrentCli
    $out = & $node $cli deploy update --root $HostRoot --source $sourceDir --manifest-sha256 $manifest 2>&1
    Log ('UPDATE out=' + ($out -join ' '))
    if ($LASTEXITCODE -ne 0) {
        # deferred producer_transaction_required exit code 1 with staged state is acceptable;
        # anything else keeps and logs.
        $joined = $out -join ' '
        if ($joined -match 'producer_transaction_required') { Log 'UPDATE staged (transaction required)'; return $true }
        return $false
    }
    return $true
}

function Invoke-CommandFile {
    if (-not (Test-Path $CommandFile)) { return $false }
    $cmd = Read-JsonText $CommandFile
    if ($null -eq $cmd -or $null -eq $cmd.action) { Remove-Item -LiteralPath $CommandFile -Force; return $true }
    Log ('COMMAND ' + $cmd.action)
    switch ($cmd.action) {
        'restart' {
            $null = Invoke-StopSequence
        }
        'update-restart' {
            if ($cmd.source -and $cmd.manifest) { $null = Invoke-UpdateRestart $cmd.source $cmd.manifest }
            else { Log 'UPDATE missing source/manifest' }
        }
        'hold'   { Log 'HOLD entered (no start, no D1)'; $script:Holding = $true }
        'resume' { Log 'RESUME'; $script:Holding = $false }
        'start'  { Log 'START forced'; $script:Holding = $false }
        default  { Log ('COMMAND unknown ' + $cmd.action) }
    }
    Remove-Item -LiteralPath $CommandFile -Force
    return $true
}

# ---- main ----
$null = New-Item -ItemType Directory -Force -Path $LogDir
$script:Holding = $false
Log '=== supervisor invocation (SYSTEM task) ==='

# If a live host exists that is not our child, monitor it (health ladder only).
# When it exits, the gate path below adopts the endpoint under the supervisor.
$obs = Get-Observation
if ($obs.alive) {
    Log ('foreign/live host pid=' + $obs.status.pid + ' - monitor mode')
}

while ($true) {
    $null = Invoke-CommandFile
    if ($script:Holding) { Start-Sleep -Seconds $TickSeconds; continue }

    if ($null -ne $script:Proc -and -not $script:Proc.HasExited) {
        # --- child running: health ladder (design section 5) ---
        $obs = Get-Observation
        $myRun = $true
        if ($null -ne $obs.status -and $obs.status.pid -ne $script:Proc.Id) {
            # host-status reflects our child normally; mismatch = keep observing ours
            $myRun = $true
        }
        if ($null -ne $obs.status -and $null -ne $obs.status.attention) {
            $AttentionTicks = $AttentionTicks + 1
            Log ('attention=' + $obs.status.attention + ' ticks=' + $AttentionTicks)
            if ($AttentionTicks -eq 2) {
                try {
                    $script:Proc.StandardInput.WriteLine('{"action":"recheck-herdr"}')
                    $script:Proc.StandardInput.Flush()
                    Log 'ladder1 recheck-herdr sent'
                } catch { Log 'ladder1 send failed' }
            }
            if ($AttentionTicks -ge 6) {
                $code = $obs.status.attention
                if ($code -in @('transfer_provenance_mismatch','connector_needs_attention')) {
                    $null = Invoke-D1Reset $code
                } else {
                    Log ('non-whitelist attention ' + $code + ' - command stop then keep')
                    $null = Invoke-StopSequence
                }
                $AttentionTicks = 0
            }
        } elseif (-not $obs.fresh -and $null -ne $obs.status) {
            Log ('stale observation age>5s')
        } else {
            $AttentionTicks = 0
        }
        if ($script:Proc.HasExited) {
            Log ('host child exited code=' + $script:Proc.ExitCode)
            $clean = Test-GateStopped
            if (-not $clean) {
                $j = Get-Journal
                if ($null -ne $j -and $j.phase -eq 'running' -and $null -eq $j.attention) {
                    $null = Invoke-HostRecover
                } else { Log 'exit with non-clean journal - keep' }
            }
            $script:Proc = $null
        } else {
            Start-Sleep -Seconds $TickSeconds
            continue
        }
    }

    # --- not running: gate -> start (design section 2) ---
    $obs = Get-Observation
    if ($obs.alive) {
        # live host not ours (e.g. Operator console) - monitor only
        Start-Sleep -Seconds $TickSeconds
        continue
    }
    if (Test-MarkerBlocked) { Log 'markers present - keep'; Start-Sleep -Seconds $TickSeconds; continue }
    $j = Get-Journal
    if ($null -eq $j) { Log 'journal unreadable - keep'; Start-Sleep -Seconds $TickSeconds; continue }
    if (-not (Test-GateStopped)) {
        if ($j.phase -eq 'running' -and $null -eq $j.attention) {
            $null = Invoke-HostRecover
        } else {
            Log ('gate blocked phase=' + $j.phase + ' attention=' + $j.attention + ' - keep')
        }
        Start-Sleep -Seconds $TickSeconds
        continue
    }
    $null = Start-HostChild
    Start-Sleep -Seconds $TickSeconds
}
