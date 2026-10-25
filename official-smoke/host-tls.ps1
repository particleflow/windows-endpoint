# Opt-in, disposable GitHub-hosted CI ONLY. Changes only CurrentUser Root.
# The test CA is never exported as an artifact or installed on a PC/NAS.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$BundleRoot, [Parameter(Mandatory=$true)][string]$Root, [switch]$UntrustedOnly, [switch]$ExistingInstallations, [switch]$ReferencedTransfer, [switch]$PiWorkload, [switch]$NativeRuntime, [string]$RuntimePackage, [string]$ProducerSource, [string]$CandidateRoot)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') { throw 'Disposable Windows GitHub runner required' }
if ($ExistingInstallations -and -not $UntrustedOnly) { throw 'Installation references do not use OS trust mutation' }
if ($ReferencedTransfer -and (-not $UntrustedOnly -or $ExistingInstallations)) { throw 'Referenced transfer requires its isolated untrusted scenario' }
if ($PiWorkload -and (-not $UntrustedOnly -or $ExistingInstallations -or $ReferencedTransfer -or -not $ProducerSource)) { throw 'Pi workload requires only its isolated no-trust scenario and fixed producer source' }
if ($NativeRuntime -and (-not $UntrustedOnly -or $ExistingInstallations -or $ReferencedTransfer -or $PiWorkload -or -not $RuntimePackage)) { throw 'Native Runtime requires only its isolated no-trust control scenario and fixed package' }
if ($CandidateRoot -and ((-not $ReferencedTransfer -and -not $NativeRuntime) -or -not $UntrustedOnly)) { throw 'Packaged candidate requires existing-reference no-trust scenario' }
$temp = (Resolve-Path -LiteralPath $env:RUNNER_TEMP).Path.TrimEnd('\') + '\'
$Root = [IO.Path]::GetFullPath($Root)
if (-not $Root.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $Root)) { throw 'Fresh runner temp root required' }
$null = New-Item -ItemType Directory -Path $Root
$certs = Join-Path $Root 'certificates'
$null = New-Item -ItemType Directory -Path $certs
$openssl = Join-Path $BundleRoot 'git/usr/bin/openssl.exe'
if (-not (Test-Path -LiteralPath $openssl)) { $openssl = Join-Path $BundleRoot 'git/mingw64/bin/openssl.exe' }
$node = Join-Path $BundleRoot 'node/node.exe'
$config = Join-Path $certs 'openssl.cnf'
[IO.File]::WriteAllText($config, '')
$emptyInput = Join-Path $Root 'empty-stdin'
[IO.File]::WriteAllText($emptyInput, '')
$pwsh = (Get-Process -Id $PID).Path
Write-Output '{"tlsStage":"initialize_supervisor","state":"started"}'
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
    Write-Output (@{ tlsStage = $Stage; state = 'started'; deadlineSeconds = $Seconds } | ConvertTo-Json -Compress)
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
            Write-Output (@{ tlsStage = $Stage; ownedTree = 'empty_confirmed' } | ConvertTo-Json -Compress)
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
    Write-Output (@{ tlsStage = $Stage; state = $(if ($failure -or $exitCode -ne 0) { 'failed' } else { 'passed' }); exitCode = $exitCode; failure = $failure } | ConvertTo-Json -Compress)
    if ($failure -or $exitCode -ne 0) { throw "Fixture stage failed: $Stage ($failure; exit $exitCode)" }
}
function Invoke-FixtureOpenSSL([string]$Stage, [string[]]$Arguments) {
    Invoke-BoundedFixture -Stage $Stage -Program $openssl -Arguments $Arguments -Seconds 30
}
if ($UntrustedOnly) {
    # Exercise forced cleanup before any trust mutation: an unrelated synthetic
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
    $scenario = if ($NativeRuntime) { 'native-runtime.mjs' } elseif ($PiWorkload) { 'pi-workload.mjs' } elseif ($ExistingInstallations) { 'existing.mjs' } else { 'host.mjs' }
    $scenarioArguments = @((Join-Path $PSScriptRoot $scenario),$BundleRoot)
    if ($NativeRuntime) { $scenarioArguments += (Resolve-Path -LiteralPath $RuntimePackage).Path }
    $scenarioArguments += (Join-Path $Root 'data')
    if ($ReferencedTransfer) { $scenarioArguments += '--existing-installations' }
    if ($CandidateRoot) { $scenarioArguments += (Resolve-Path -LiteralPath $CandidateRoot).Path }
    if ($PiWorkload) { $scenarioArguments += (Resolve-Path -LiteralPath $ProducerSource).Path }
    Invoke-BoundedFixture -Stage 'untrusted_host' -Program $node -Arguments $scenarioArguments -Seconds 300
    return
}
$oldConfig = $env:OPENSSL_CONF
$thumbprint = $null
$cleanupArmed = $false
try {
    $env:OPENSSL_CONF = $config
    Invoke-FixtureOpenSSL -Stage 'generate_root' -Arguments @('req','-batch','-x509','-newkey','rsa:2048','-nodes','-keyout',(Join-Path $certs 'root.key'),'-out',(Join-Path $certs 'root.pem'),'-days','1','-subj','/CN=Endpoint disposable CI root','-addext','basicConstraints=critical,CA:TRUE,pathlen:0','-addext','keyUsage=critical,keyCertSign,cRLSign')
    foreach ($name in @('server','mismatch')) {
        $san = if ($name -eq 'server') { 'DNS:localhost,IP:127.0.0.1' } else { 'DNS:wrong-name.invalid' }
        $extensions = Join-Path $certs ($name + '.ext')
        [IO.File]::WriteAllText($extensions, "basicConstraints=critical,CA:FALSE`nkeyUsage=critical,digitalSignature,keyEncipherment`nextendedKeyUsage=serverAuth`nsubjectAltName=$san`n")
        Invoke-FixtureOpenSSL -Stage ('generate_' + $name) -Arguments @('req','-batch','-new','-newkey','rsa:2048','-nodes','-keyout',(Join-Path $certs ($name + '.key')),'-out',(Join-Path $certs ($name + '.csr')),'-subj','/CN=Endpoint CI leaf')
        Invoke-FixtureOpenSSL -Stage ('sign_' + $name) -Arguments @('x509','-req','-in',(Join-Path $certs ($name + '.csr')),'-CA',(Join-Path $certs 'root.pem'),'-CAkey',(Join-Path $certs 'root.key'),'-set_serial',$(if ($name -eq 'server') { '2' } else { '3' }),'-days','1','-extfile',$extensions,'-out',(Join-Path $certs ($name + '.pem')))
    }
    $der = Join-Path $certs 'root.cer'
    Invoke-FixtureOpenSSL -Stage 'encode_root' -Arguments @('x509','-in',(Join-Path $certs 'root.pem'),'-outform','DER','-out',$der)
    $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($der)
    $thumbprint = $certificate.Thumbprint
    $certificate.Dispose()
    if ($thumbprint -notmatch '^[A-F0-9]{40}$') { throw 'Invalid fixture certificate fingerprint' }
    $location = 'Cert:\CurrentUser\Root\' + $thumbprint
    if (Test-Path -LiteralPath $location) { throw 'Fixture root already trusted; refuse ownership' }
    # Arm BEFORE import, so an uncertain/partially successful import is cleaned.
    $cleanupArmed = $true
    Invoke-BoundedFixture -Stage 'import_current_user_root' -Program $pwsh -Arguments @('-NoLogo','-NoProfile','-NonInteractive','-File',(Join-Path $PSScriptRoot 'fixture-trust.ps1'),'-Action','Import','-CertificateFile',$der,'-Thumbprint',$thumbprint) -Seconds 30
    if (-not (Test-Path -LiteralPath $location)) { throw 'Test root import not confirmed' }
    Write-Output (@{ tlsTrust = 'imported'; scope = 'CurrentUser'; thumbprint = $thumbprint } | ConvertTo-Json -Compress)
    Invoke-BoundedFixture -Stage 'trusted_host' -Program $node -Arguments @((Join-Path $PSScriptRoot 'host.mjs'),$BundleRoot,(Join-Path $Root 'data'),$certs) -Seconds 420
} finally {
    $env:OPENSSL_CONF = $oldConfig
    if ($cleanupArmed) {
        $location = 'Cert:\CurrentUser\Root\' + $thumbprint
        Write-Output (@{ tlsTrust = 'cleanup_check'; scope = 'CurrentUser'; thumbprint = $thumbprint; present = [bool](Test-Path -LiteralPath $location) } | ConvertTo-Json -Compress)
        if (Test-Path -LiteralPath $location) {
            Invoke-BoundedFixture -Stage 'remove_current_user_root' -Program $pwsh -Arguments @('-NoLogo','-NoProfile','-NonInteractive','-File',(Join-Path $PSScriptRoot 'fixture-trust.ps1'),'-Action','Remove','-CertificateFile',$der,'-Thumbprint',$thumbprint) -Seconds 30
        }
        if (Test-Path -LiteralPath $location) { throw 'CI test root cleanup failed' }
        Write-Output (@{ tlsTrust = 'removed_and_absent'; scope = 'CurrentUser'; thumbprint = $thumbprint } | ConvertTo-Json -Compress)
    } else {
        Write-Output (@{ tlsTrust = 'not_attempted'; reason = 'preparation_not_completed' } | ConvertTo-Json -Compress)
    }
}
