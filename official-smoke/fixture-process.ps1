# Child supervisor used ONLY by the disposable CI harness. Its nested Windows
# job contains this child and descendants started AFTER assignment; never peers.
[CmdletBinding()]
param([Parameter(Mandatory=$true)][string]$InputFile)
$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted' -or $env:RUNNER_OS -ne 'Windows') { throw 'Disposable Windows CI required' }
Add-Type -Path (Join-Path $PSScriptRoot 'fixture-job.cs')
$spec = Get-Content -Raw -LiteralPath $InputFile | ConvertFrom-Json
[OwnedFixtureJob]::Join($spec.jobName)
$nativeArgs = @($spec.arguments)
& $spec.program @nativeArgs
exit $LASTEXITCODE
