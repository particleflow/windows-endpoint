# Exact-fingerprint CurrentUser operations; caller owns the bounded process job.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][ValidateSet('Import','Remove')][string]$Action,
      [Parameter(Mandatory=$true)][string]$CertificateFile,
      [Parameter(Mandatory=$true)][ValidatePattern('^[A-F0-9]{40}$')][string]$Thumbprint)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') { throw 'Disposable Windows CI required' }
$certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($CertificateFile)
if ($certificate.Thumbprint -ne $Thumbprint) { throw 'Fixture certificate changed' }
$certificate.Dispose()
$location = 'Cert:\CurrentUser\Root\' + $Thumbprint
if ($Action -eq 'Import') {
    if (Test-Path -LiteralPath $location) { throw 'Fixture certificate already present' }
    $imported = @(Import-Certificate -FilePath $CertificateFile -CertStoreLocation 'Cert:\CurrentUser\Root')
    if ($imported.Count -ne 1 -or $imported[0].Thumbprint -ne $Thumbprint) { throw 'Unexpected imported certificate' }
} else {
    if (Test-Path -LiteralPath $location) { Remove-Item -LiteralPath $location -ErrorAction Stop }
}
