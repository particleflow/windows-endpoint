# Windows' own foreground folder dialog; uses the invoking user's existing
# filesystem/share access. No elevation, mount, credential or configuration write.
[CmdletBinding()]
param([string]$InitialPath, [switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
    Add-Type -AssemblyName System.Windows.Forms
    if ($CheckOnly) {
        @{ state = 'available'; interactiveDesktopRequired = $true } | ConvertTo-Json -Compress
        exit 0
    }
    if (-not [Environment]::UserInteractive) { throw 'interactive_desktop_required' }
    $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
    try {
        $dialog.Description = 'Windows workspace directory'
        $dialog.ShowNewFolderButton = $false
        $dialog.RootFolder = [Environment+SpecialFolder]::MyComputer
        if ($InitialPath -and [IO.Directory]::Exists($InitialPath)) { $dialog.SelectedPath = $InitialPath }
        if ($dialog.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) {
            @{ state = 'cancelled' } | ConvertTo-Json -Compress
        } else {
            if (-not [IO.Directory]::Exists($dialog.SelectedPath)) { throw 'directory_unavailable' }
            @{ state = 'selected'; path = $dialog.SelectedPath } | ConvertTo-Json -Compress
        }
    } finally { $dialog.Dispose() }
} catch {
    # Native errors may contain private paths. Return only a known category.
    [Console]::Error.WriteLine('{"error":"directory_picker_unavailable"}')
    exit 2
}
