# Consume an already obtained fixed producer ZIP. No network, source build,
# dependency installation, production configuration or OS permission changes.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ArchivePath,
    [Parameter(Mandatory = $true)][string]$Root
)
$ErrorActionPreference = 'Stop'
$lock = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'transfer-artifact.json') | ConvertFrom-Json
if (Test-Path -LiteralPath $Root) { throw 'Transfer fixture destination already exists' }
if (-not [IO.Path]::IsPathRooted($Root)) { throw 'Absolute fixture destination required' }
if ((Get-Item -LiteralPath $ArchivePath).Length -gt 20MB) { throw 'Transfer archive exceeds fixture budget' }
if ((Get-FileHash -LiteralPath $ArchivePath -Algorithm SHA256).Hash.ToLowerInvariant() -ne $lock.archiveSha256) {
    throw 'Transfer archive hash mismatch'
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
$expected = @('README.md', 'SHA256SUMS.json', 'herdr-plugin.toml', 'transfer.example.json', 'transferqueue.exe', 'transferqueue.test.exe', 'verify-fixtures.ps1')
try {
    $names = @($zip.Entries | ForEach-Object { $_.FullName })
    if ($names.Count -ne 7 -or @($names | Sort-Object -Unique).Count -ne 7 -or (Compare-Object $expected $names)) {
        throw 'Unexpected or duplicated transfer ZIP member'
    }
    $total = 0L
    foreach ($entry in $zip.Entries) {
        if ($entry.Length -gt 64MB) { throw 'Transfer member exceeds fixture budget' }
        $total += $entry.Length
    }
    if ($total -gt 96MB) { throw 'Transfer extraction exceeds fixture budget' }
    $null = New-Item -ItemType Directory -Path $Root
    foreach ($entry in $zip.Entries) {
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $Root $entry.FullName), $false)
    }
} finally { $zip.Dispose() }
$manifestPath = Join-Path $Root 'SHA256SUMS.json'
if ((Get-Item -LiteralPath $manifestPath).Length -gt 16384) { throw 'Oversized producer manifest' }
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if ($manifest.source_commit -ne $lock.sourceCommit -or $manifest.arch -ne $lock.arch) { throw 'Producer provenance mismatch' }
$payloads = @($expected | Where-Object { $_ -ne 'SHA256SUMS.json' })
$listed = @($manifest.files | ForEach-Object { $_.name })
if ($listed.Count -ne 6 -or @($listed | Sort-Object -Unique).Count -ne 6 -or (Compare-Object $payloads $listed)) { throw 'Invalid producer inventory' }
foreach ($entry in $manifest.files) {
    if ($entry.sha256 -notmatch '^[0-9a-f]{64}$' -or (Get-FileHash -LiteralPath (Join-Path $Root $entry.name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) {
        throw 'Producer payload hash mismatch'
    }
}
Write-Output 'Fixed producer artifact verified for isolated consumer tests; not a release bundle.'
