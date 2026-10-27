param([string]$Target, [string]$Temporary, [string]$ExpectedHash)
$ErrorActionPreference = 'Stop'
try {
  # The Node caller compares content and metadata immediately before invoking us.
  # Recheck content across process startup. Do not ignore ACL merge
  # errors, create a backup, print paths/content, or copy a credential file.
  $info = Get-Item -LiteralPath $Target
  if ($info.Attributes -band [IO.FileAttributes]::ReparsePoint) { exit 3 }
  if ((Get-FileHash -LiteralPath $Target -Algorithm SHA256).Hash -ine $ExpectedHash) { exit 3 }
  [IO.File]::Replace($Temporary, $Target, $null, $false)
} catch { exit 2 }
