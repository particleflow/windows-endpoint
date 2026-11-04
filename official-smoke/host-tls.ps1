# Bounded disposable native Runtime/Pi fixture supervisor. No trust operation.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$BundleRoot, [Parameter(Mandatory=$true)][string]$Root, [switch]$UntrustedOnly, [switch]$PiWorkload, [switch]$NativeRuntime, [string]$RuntimePackage, [string]$RuntimeFileProbe, [string]$ProducerSource, [string]$CandidateRoot)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') { throw 'Disposable Windows GitHub runner required' }
if (-not $UntrustedOnly -or ([bool]$NativeRuntime -eq [bool]$PiWorkload)) { throw 'Exactly one native Runtime or Pi scenario with no trust mutation is required' }
if ($NativeRuntime -and -not $RuntimePackage) { throw 'Native Runtime requires its fixed package' }
if ($PiWorkload -and -not $ProducerSource) { throw 'Pi workload requires its fixed producer source' }
if ($CandidateRoot -and -not $NativeRuntime) { throw 'Packaged candidate requires the native Runtime scenario' }
$temp = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path.TrimEnd('\') + '\'
$Root = [IO.Path]::GetFullPath($Root)
if (-not $Root.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $Root)) { throw 'Fresh runner temp root required' }
$null = New-Item -ItemType Directory -Path $Root
$node = Join-Path $BundleRoot 'node/node.exe'
$emptyInput = Join-Path $Root 'empty-stdin'
[IO.File]::WriteAllText($emptyInput, '')
$pwsh = (Get-Process -Id $PID).Path
Write-Output '{"nativeFixtureStage":"initialize_supervisor","state":"started"}'
Add-Type -Path (Join-Path $PSScriptRoot 'fixture-job.cs')
$script:stageNumber = 0
function Invoke-BoundedFixture([string]$Stage, [string]$Program, [string[]]$Arguments, [int]$Seconds) {
    $script:stageNumber++
    $stem = Join-Path $Root ('stage-' + $script:stageNumber)
    $inputFile = $stem + '.json'
    $job = [OwnedFixtureJob]::new()
    [IO.File]::WriteAllText($inputFile, (@{ program = $Program; arguments = $Arguments; jobName = $job.Name } | ConvertTo-Json -Compress))
    $supervisor = (Join-Path $PSScriptRoot 'fixture-process.ps1').Replace("'", "''")
    $quotedInput = $inputFile.Replace("'", "''")
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("& '$supervisor' -InputFile '$quotedInput'"))
    Write-Output (@{ nativeFixtureStage = $Stage; state = 'started'; deadlineSeconds = $Seconds } | ConvertTo-Json -Compress)
    $process = $null
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $failure = $null
    try {
        $process = Start-Process -FilePath $pwsh -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',$encoded) -RedirectStandardInput $emptyInput -RedirectStandardOutput ($stem + '.out') -RedirectStandardError ($stem + '.err') -PassThru
        while (-not $process.WaitForExit(100)) {
            if ($watch.Elapsed.TotalSeconds -gt $Seconds) { $failure = 'deadline'; break }
            foreach ($suffix in @('.out','.err')) {
                if ((Get-Item -LiteralPath ($stem + $suffix)).Length -gt 1048576) { $failure = 'output_limit'; break }
            }
            if ($failure) { break }
        }
    } finally {
        try {
            if ($process -and -not $process.HasExited) {
                $process.Kill()
                if (-not $process.WaitForExit(10000)) { throw "Fixture supervisor termination unconfirmed: $Stage" }
            }
            if ($job.Finish()) { if (-not $failure) { $failure = 'owned_tree_required_termination' } }
            Write-Output (@{ nativeFixtureStage = $Stage; ownedTree = 'empty_confirmed' } | ConvertTo-Json -Compress)
        } finally {
            $job.Dispose()
        }
    }
    foreach ($suffix in @('.out','.err')) {
        $file = $stem + $suffix
        if ((Get-Item -LiteralPath $file).Length -gt 1048576) { $failure = 'output_limit' }
        else { Get-Content -LiteralPath $file | Write-Output }
    }
    $exitCode = $process.ExitCode
    $process.Dispose()
    Write-Output (@{ nativeFixtureStage = $Stage; state = $(if ($failure -or $exitCode -ne 0) { 'failed' } else { 'passed' }); exitCode = $exitCode; failure = $failure } | ConvertTo-Json -Compress)
    if ($failure -or $exitCode -ne 0) { throw "Fixture stage failed: $Stage ($failure; exit $exitCode)" }
}
    # Exercise owned fixture containment: an unrelated synthetic
    # peer must survive while the separate owned job and its grandchild vanish.
    $peer = Start-Process -FilePath $pwsh -ArgumentList @('-NoProfile','-NonInteractive','-Command','Start-Sleep 120') -PassThru
    try {
        $marker = Join-Path $Root 'containment-ready'
        $expectedTimeout = $false
        try { Invoke-BoundedFixture -Stage 'containment_probe' -Program $node -Arguments @((Join-Path $PSScriptRoot 'fixture-tree.mjs'),$marker) -Seconds 10 }
        catch {
            if ($_.Exception.Message -notmatch '^Fixture stage failed: containment_probe \(deadline; exit ') { throw }
            $expectedTimeout = $true
        }
        if (-not $expectedTimeout -or -not (Test-Path -LiteralPath $marker) -or $peer.HasExited) { throw 'Fixture containment/peer preservation failed' }
        Write-Output '{"fixtureContainment":"passed","ownedTree":"empty_confirmed","unrelatedSyntheticPeer":"preserved"}'
    } finally {
        if (-not $peer.HasExited) { $peer.Kill() }
        if (-not $peer.WaitForExit(10000)) { throw 'Synthetic peer cleanup unconfirmed' }
        $peer.Dispose()
    }

$scenario = if ($NativeRuntime) { 'native-runtime.mjs' } else { 'pi-workload.mjs' }
$scenarioArguments = @((Join-Path $PSScriptRoot $scenario),$BundleRoot)
if ($NativeRuntime) { $scenarioArguments += (Resolve-Path -LiteralPath $RuntimePackage).Path }
$scenarioArguments += (Join-Path $Root 'data')
if ($CandidateRoot) { $scenarioArguments += (Resolve-Path -LiteralPath $CandidateRoot).Path }
if ($NativeRuntime -and $RuntimeFileProbe) { $scenarioArguments += (Resolve-Path -LiteralPath $RuntimeFileProbe).Path }
if ($PiWorkload) { $scenarioArguments += (Resolve-Path -LiteralPath $ProducerSource).Path }
Invoke-BoundedFixture -Stage 'native_host' -Program $node -Arguments $scenarioArguments -Seconds 300
