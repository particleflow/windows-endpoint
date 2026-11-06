# CI fixture assembly only; no installer, pairing or persistent system changes.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$Root)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $Root) { throw 'Fixture root already exists' }
$null = New-Item -ItemType Directory -Path $Root
$artifacts = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'artifacts.json') | ConvertFrom-Json
$sevenZip = (Get-Command 7z.exe -ErrorAction Stop).Source # build runner tool only
foreach ($component in @('node', 'herdr', 'git')) {
    $artifact = $artifacts.$component
    $archive = Join-Path $Root ($component + '.archive')
    Invoke-WebRequest -Uri $artifact.url -OutFile $archive -UseBasicParsing
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $artifact.sha256) {
        throw ('Official artifact hash mismatch: ' + $component)
    }
    $target = Join-Path $Root $component
    & $sevenZip x $archive ('-o' + $target) -y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw ('Official archive extraction failed: ' + $component) }
    if ($component -eq 'node') {
        $nested = Join-Path $target 'node-v24.14.0-win-x64'
        Get-ChildItem -LiteralPath $nested | Move-Item -Destination $target
        Remove-Item -LiteralPath $nested
    }
    Remove-Item -LiteralPath $archive
}
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Destination $Root
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'package-lock.json') -Destination $Root
$node = Join-Path $Root 'node/node.exe'
$npm = Join-Path $Root 'node/node_modules/npm/bin/npm-cli.js'
$savedPath = $env:PATH
try {
    $env:PATH = (Join-Path $Root 'node') + ';' + $savedPath
    & $node $npm ci --prefix $Root --ignore-scripts --no-audit --no-fund --cache (Join-Path $Root 'build-cache')
    if ($LASTEXITCODE -ne 0) { throw 'Locked official npm assembly failed' }
} finally { $env:PATH = $savedPath }
Write-Output 'Official dependency fixture assembled from fixed hashes and npm integrity lock; not a release bundle.'
