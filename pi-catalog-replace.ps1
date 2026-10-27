param([string]$Target, [string]$Temporary, [string]$Backup)
$ErrorActionPreference = 'Stop'
try {
  # Keep the actual displaced file; do not restore automatically or ignore ACL errors.
  $info = Get-Item -LiteralPath $Target
  if ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 3 }
  [IO.File]::Replace($Temporary, $Target, $Backup, $false)
} catch { exit 2 }
