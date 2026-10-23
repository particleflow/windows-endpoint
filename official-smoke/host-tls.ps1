# Opt-in, disposable GitHub-hosted CI ONLY. Changes only CurrentUser Root.
# The test CA is never exported as an artifact or installed on a PC/NAS.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$BundleRoot, [Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') { throw 'Disposable Windows GitHub runner required' }
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
function Invoke-FixtureOpenSSL([string[]]$Arguments) {
    & $openssl @Arguments 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Ephemeral test certificate generation failed' }
}
$oldConfig = $env:OPENSSL_CONF
$thumbprint = $null
$cleanupArmed = $false
try {
    $env:OPENSSL_CONF = $config
    Invoke-FixtureOpenSSL -Arguments @('req','-x509','-newkey','rsa:2048','-nodes','-keyout',(Join-Path $certs 'root.key'),'-out',(Join-Path $certs 'root.pem'),'-days','1','-subj','/CN=Endpoint disposable CI root','-addext','basicConstraints=critical,CA:TRUE,pathlen:0','-addext','keyUsage=critical,keyCertSign,cRLSign')
    foreach ($name in @('server','mismatch')) {
        $san = if ($name -eq 'server') { 'DNS:localhost,IP:127.0.0.1' } else { 'DNS:wrong-name.invalid' }
        $extensions = Join-Path $certs ($name + '.ext')
        [IO.File]::WriteAllText($extensions, "basicConstraints=critical,CA:FALSE`nkeyUsage=critical,digitalSignature,keyEncipherment`nextendedKeyUsage=serverAuth`nsubjectAltName=$san`n")
        Invoke-FixtureOpenSSL -Arguments @('req','-new','-newkey','rsa:2048','-nodes','-keyout',(Join-Path $certs ($name + '.key')),'-out',(Join-Path $certs ($name + '.csr')),'-subj','/CN=Endpoint CI leaf')
        Invoke-FixtureOpenSSL -Arguments @('x509','-req','-in',(Join-Path $certs ($name + '.csr')),'-CA',(Join-Path $certs 'root.pem'),'-CAkey',(Join-Path $certs 'root.key'),'-set_serial',$(if ($name -eq 'server') { '2' } else { '3' }),'-days','1','-extfile',$extensions,'-out',(Join-Path $certs ($name + '.pem')))
    }
    $der = Join-Path $certs 'root.cer'
    Invoke-FixtureOpenSSL -Arguments @('x509','-in',(Join-Path $certs 'root.pem'),'-outform','DER','-out',$der)
    $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($der)
    $thumbprint = $certificate.Thumbprint
    $certificate.Dispose()
    if ($thumbprint -notmatch '^[A-F0-9]{40}$') { throw 'Invalid fixture certificate fingerprint' }
    $location = 'Cert:\CurrentUser\Root\' + $thumbprint
    if (Test-Path -LiteralPath $location) { throw 'Fixture root already trusted; refuse ownership' }
    # Arm BEFORE import, so an uncertain/partially successful import is cleaned.
    $cleanupArmed = $true
    $imported = @(Import-Certificate -FilePath $der -CertStoreLocation 'Cert:\CurrentUser\Root')
    if ($imported.Count -ne 1 -or $imported[0].Thumbprint -ne $thumbprint -or -not (Test-Path -LiteralPath $location)) { throw 'Test root import not confirmed' }
    Write-Output (@{ tlsTrust = 'imported'; scope = 'CurrentUser'; thumbprint = $thumbprint } | ConvertTo-Json -Compress)
    & $node (Join-Path $PSScriptRoot 'host.mjs') $BundleRoot (Join-Path $Root 'data') $certs
    if ($LASTEXITCODE -ne 0) { throw 'Trusted production CLI host fixture failed' }
} finally {
    $env:OPENSSL_CONF = $oldConfig
    if ($cleanupArmed) {
        $location = 'Cert:\CurrentUser\Root\' + $thumbprint
        if (Test-Path -LiteralPath $location) { Remove-Item -LiteralPath $location -ErrorAction Stop }
        if (Test-Path -LiteralPath $location) { throw 'CI test root cleanup failed' }
        Write-Output (@{ tlsTrust = 'removed_and_absent'; scope = 'CurrentUser'; thumbprint = $thumbprint } | ConvertTo-Json -Compress)
    }
}
