# Windows PowerShell 5.1 bootstrap. No PATH lookup, installation or policy change.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$NodePath,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-f0-9]{64}$')][string]$NodeSha256,
    [Parameter(ValueFromRemainingArguments = $true)][string[]]$EndpointArguments
)
$ErrorActionPreference = 'Stop'
if (-not [IO.Path]::IsPathRooted($NodePath) -or -not (Test-Path -LiteralPath $NodePath -PathType Leaf)) {
    [Console]::Error.WriteLine('node_missing: supply the approved absolute node.exe path')
    exit 2
}
$nodeAncestor = Get-Item -LiteralPath $NodePath
while ($null -ne $nodeAncestor) {
    if ($nodeAncestor.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        [Console]::Error.WriteLine('node_reparse_point_rejected')
        exit 2
    }
    if ($nodeAncestor -is [IO.FileInfo]) { $nodeAncestor = $nodeAncestor.Directory }
    else { $nodeAncestor = $nodeAncestor.Parent }
}
try {
    # Resolve only the Utility shipped with this exact Windows PowerShell;
    # inherited PSModulePath and autoload settings are not hash authority.
    Import-Module -Name "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop
    $nodeHash = (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $NodePath -Algorithm SHA256 -ErrorAction Stop).Hash
    if ($nodeHash -notmatch '^[a-fA-F0-9]{64}$') { throw 'native_sha256_unavailable' }
} catch {
    [Console]::Error.WriteLine('node_hash_verifier_unavailable: native Windows PowerShell Utility SHA256 verification required')
    exit 2
}
if ($nodeHash.ToLowerInvariant() -ne $NodeSha256) {
    [Console]::Error.WriteLine('node_hash_mismatch: use the trusted release inventory')
    exit 2
}
$savedNodeOptions = $env:NODE_OPTIONS
$savedNodePath = $env:NODE_PATH
try {
    $env:NODE_OPTIONS = $null
    $env:NODE_PATH = $null
    & $NodePath (Join-Path $PSScriptRoot 'endpoint.mjs') @EndpointArguments
    $endpointExitCode = $LASTEXITCODE
} finally {
    $env:NODE_OPTIONS = $savedNodeOptions
    $env:NODE_PATH = $savedNodePath
}
exit $endpointExitCode
