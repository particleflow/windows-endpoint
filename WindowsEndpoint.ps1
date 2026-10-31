# Product installer / stable foreground entry. Windows PowerShell 5.1; no
# execution-policy, service, scheduled-task, credential or trust-store changes.
[CmdletBinding()]
param(
    [ValidateSet('Install','Run','Status','Doctor','Dependencies','MigrationPlan','Update','Rollback','Recover','DeploymentRecover','UninstallPlan')][string]$Action = 'Run',
    [string]$ProductRoot,
    [string]$References,
    [string]$NodePath,
    [string]$Source,
    [ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestSha256,
    [ValidateSet('disabled','existing-queue')][string]$Transfer = 'existing-queue',
    [switch]$ReviewCandidate,
    [string]$ExpectedRun,
    [string]$ExpectedStateSha256,
    [string]$ExpectedConfigurationSha256,
    [ValidatePattern('^[A-Za-z0-9_.-]{1,100}$')][string]$PiCatalogProvider
)
$ErrorActionPreference = 'Stop'
function Require-RegularPath([string]$Path) {
    if (-not [IO.Path]::IsPathRooted($Path)) { throw 'installation_absolute_path_required' }
    $item = Get-Item -LiteralPath $Path
    if (-not ($item -is [IO.FileInfo])) { throw 'installation_file_required' }
    $ancestor = $item
    while ($null -ne $ancestor) {
        if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'installation_reparse_point_rejected' }
        if ($ancestor -is [IO.FileInfo]) { $ancestor = $ancestor.Directory } else { $ancestor = $ancestor.Parent }
    }
    return $item
}
function Read-SmallJson([string]$Path) {
    $item = Require-RegularPath $Path
    if ($item.Length -gt 262144) { throw 'installation_metadata_oversized' }
    return (Get-Content -Raw -Encoding UTF8 -LiteralPath $Path | ConvertFrom-Json)
}
function Verify-Package([string]$Directory, [string]$ExpectedHash) {
    if ($ExpectedHash -notmatch '^[a-f0-9]{64}$') { throw 'installation_manifest_hash_required' }
    $file = Join-Path $Directory 'candidate.json'
    $manifest = Read-SmallJson $file
    if ((Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $file -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() -ne $ExpectedHash) { throw 'installation_manifest_changed' }
    if ($manifest.entry -ne 'endpoint.mjs' -or $manifest.schema -ne 1 -or $manifest.files.Count -gt 256) { throw 'installation_inventory_invalid' }
    foreach ($entry in $manifest.files) {
        $segments = $entry.path -split '/'
        foreach ($segment in $segments) {
            if ($segment -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._-]*$' -or $segment -match '[.]$') { throw 'installation_inventory_invalid' }
        }
        $payload = Join-Path $Directory $entry.path
        $item = Require-RegularPath $payload
        if ($item.Length -ne $entry.size -or (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $payload -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() -ne $entry.sha256) { throw 'installation_payload_changed' }
    }
    if (-not ($manifest.files | Where-Object { $_.path -eq 'endpoint.mjs' })) { throw 'installation_inventory_invalid' }
    return $manifest
}
$savedOptions = $env:NODE_OPTIONS
$savedPath = $env:NODE_PATH
try {
    # Hash authority is the Utility shipped with this PowerShell, independent
    # of inherited module discovery. Loader failure retains the existing catch.
    Import-Module -Name "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop
    $installedEntry = (Split-Path -Leaf $PSScriptRoot) -eq 'control' -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'installation.json'))
    $fresh = $Action -in @('Install','MigrationPlan') -or ($Action -eq 'Dependencies' -and -not $installedEntry)
    if ($fresh) {
        if (-not $Source) { $Source = $PSScriptRoot }
        if (-not $ProductRoot) {
            $ProductRoot = if ($installedEntry) { Split-Path -Parent $PSScriptRoot } else { Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'NAS-Assistant' }
        }
        if (-not $References -and $installedEntry) { $References = Join-Path (Split-Path -Parent $PSScriptRoot) 'config/endpoint.json' }
        if (-not $References -and (Test-Path -LiteralPath (Join-Path $ProductRoot 'config/endpoint.json'))) { $References = Join-Path $ProductRoot 'config/endpoint.json' }
        $manifest = Verify-Package $Source $ManifestSha256
        if (-not $NodePath) {
            $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue
            if ($command) { $NodePath = $command.Source }
        }
    } else {
        $updateSource = $Source
        # A copied stable entry locates its own product root, never a developer
        # checkout, acceptance script or machine-wide current-profile pointer.
        $root = Split-Path -Parent $PSScriptRoot
        if ((Split-Path -Leaf $PSScriptRoot) -ne 'control' -or ($ProductRoot -and [IO.Path]::GetFullPath($ProductRoot) -ne $root)) { throw 'installation_entry_location_invalid' }
        $ProductRoot = $root
        $receipt = Read-SmallJson (Join-Path $ProductRoot 'control/installation.json')
        if ($receipt.schema -ne 1 -or $receipt.protocol -ne 1 -or $receipt.phase -ne 'complete' -or
            (Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256 -ErrorAction Stop).Hash.ToLowerInvariant() -ne $receipt.launcher_sha256) { throw 'installation_entry_recovery_required' }
        if ($Action -eq 'UninstallPlan') {
            @{state='uninstall_plan_only'; deletionImplemented=$false; filesChanged=$false; retained=@('config','data','logs','queues','workspaces','sessions','credentials','unknown_files','external_official_installations')} | ConvertTo-Json -Compress
            exit 0
        }
        $config = Read-SmallJson (Join-Path $ProductRoot 'config/endpoint.json')
        if ($receipt.owner -ne $config.deviceId) { throw 'installation_owner_mismatch' }
        $selection = Read-SmallJson (Join-Path $ProductRoot 'control/deployment.json')
        if ($selection.owner -ne $config.deviceId -or ($selection.pending -and $Action -ne 'DeploymentRecover') -or $selection.current -notmatch '^[a-f0-9]{64}$') { throw 'installation_selection_unavailable' }
        $Source = Join-Path $ProductRoot ('packages/' + $selection.current)
        $manifest = Verify-Package $Source $selection.current
        # Node is an existing official reference. The normal program preflight
        # rechecks versions/protocols; this inventory does not freeze updates.
        $NodePath = $config.programs.node
        if ($Action -eq 'Dependencies') { $References = Join-Path $ProductRoot 'config/endpoint.json' }
    }
    if (-not $NodePath) {
        $catalog = Read-SmallJson (Join-Path $Source 'dependencies.json')
        @{error='installation_node_missing'; source=$catalog.installationSources.node.source; minimum=$catalog.installationSources.node.minimum; installExecuted=$false} | ConvertTo-Json -Compress
        exit 2
    }
    $null = Require-RegularPath $NodePath
    $env:NODE_OPTIONS = $null; $env:NODE_PATH = $null
    $arguments = @()
    switch ($Action) {
        'Install' {
            if (-not $ReviewCandidate) { throw 'installation_release_qualification_pending' }
            $arguments = @('installation','install','--from',$References,'--root',$ProductRoot,'--source',$Source,'--manifest-sha256',$ManifestSha256,'--transfer',$Transfer,'--review','true')
        }
        'Dependencies' { $arguments = @('installation','dependencies','--from',$References) }
        'MigrationPlan' { $arguments = @('installation','migration-plan','--from',$References,'--root',$ProductRoot) }
        'Run' {
            $arguments = @('deploy','run','--root',$ProductRoot)
            if ($PiCatalogProvider) { $arguments += @('--pi-catalog-provider',$PiCatalogProvider) }
        }
        'Status' { $arguments = @('host','status','--root',$ProductRoot) }
        'Doctor' { $arguments = @('doctor','--config',(Join-Path $ProductRoot 'config/endpoint.json')) }
        'Update' {
            if (-not $updateSource) { throw 'installation_update_source_required' }
            $arguments = @('deploy','update','--root',$ProductRoot,'--source',$updateSource,'--manifest-sha256',$ManifestSha256)
        }
        'Rollback' { $arguments = @('deploy','rollback','--root',$ProductRoot,'--manifest-sha256',$ManifestSha256) }
        'Recover' { $arguments = @('host','recover','--root',$ProductRoot,'--expected-run',$ExpectedRun,'--expected-state-sha256',$ExpectedStateSha256,'--expected-configuration-sha256',$ExpectedConfigurationSha256) }
        'DeploymentRecover' { $arguments = @('deploy','recover','--root',$ProductRoot) }
    }
    & $NodePath (Join-Path $Source 'endpoint.mjs') @arguments
    $result = $LASTEXITCODE
} catch {
    $code = 'installation_entry_unavailable'
    if ($_.Exception.Message -match '^installation_[a-z_]+$') { $code = $_.Exception.Message }
    [Console]::Error.WriteLine(('{"error":"' + $code + '"}'))
    $result = 2
} finally {
    $env:NODE_OPTIONS = $savedOptions; $env:NODE_PATH = $savedPath
}
exit $result
