// Test-only instrumentation of the exact 8351 launcher copy, before its inert
// fixture manifest/receipt are created. Never imported by a product entry.
import { createHash } from 'node:crypto'
export const originalEntrySha256 = '13e9721c9a430586b2cb3120157441a2be138519ac6828fcd34405bee10bbc8d'
const stages = new Set('entry.start path.absolute path.item path.kind path.reparse json.bound json.read_or_decode package.manifest_path hash.manifest package.inventory package.member package.payload_path payload.size_or_hash entry.location entry.root receipt.read receipt.contract_or_hash config.read owner.compare selection.read selection.contract source.reference node.reference node.invoke node.exit'.split(' '))
const contexts = new Set('entry package-manifest package-payload receipt config selection source node'.split(' '))
const commands = new Set(['none','other','Get-FileHash','Get-Item','Get-Content','ConvertFrom-Json','Test-Path','Split-Path','Join-Path'])
export function parseEntryProbe(raw) {
  if (Buffer.byteLength(raw) > 32768) throw Error('entry_probe_invalid')
  const rows = raw.trim() ? raw.trim().split(/\r?\n/).map(line => JSON.parse(line)) : []
  if (rows.length > 8) throw Error('entry_probe_invalid')
  for (const row of rows) {
    if (Object.keys(row).sort().join(',') !== 'command,context,contractCode,exceptionType,innerType,nativeExitCode,schema,stage' ||
      row.schema !== 1 || !stages.has(row.stage) || !contexts.has(row.context) || !commands.has(row.command) ||
      ![row.exceptionType,row.innerType].every(value => typeof value === 'string' && /^[A-Za-z0-9_.+]{1,180}$/.test(value)) ||
      typeof row.contractCode !== 'string' || !/^(none|other|installation_[a-z_]+)$/.test(row.contractCode) ||
      !Number.isInteger(row.nativeExitCode) || row.nativeExitCode < -2147483648 || row.nativeExitCode > 2147483647) throw Error('entry_probe_invalid')
  }
  return rows
}
export function productEntryProbe(source) {
  if (createHash('sha256').update(source).digest('hex') !== originalEntrySha256) throw Error('entry_probe_source_mismatch')
  let text = source.toString('utf8')
  const before = (anchor, added) => {
    if (text.split(anchor).length !== 2) throw Error('entry_probe_anchor_mismatch')
    text = text.replace(anchor, () => added + '\n' + anchor)
  }
  before('function Require-RegularPath([string]$Path) {', `
$script:fixtureEntryStage = 'entry.start'
$script:fixtureEntryContext = 'entry'
function Save-FixtureEntryProbe($Record, [int]$NativeExitCode = -999) {
    try {
        $type = 'none'; $inner = 'none'; $command = 'none'; $contract = 'none'
        if ($null -ne $Record) {
            $type = $Record.Exception.GetType().FullName
            if ($null -ne $Record.Exception.InnerException) { $inner = $Record.Exception.InnerException.GetType().FullName }
            $command = $Record.InvocationInfo.MyCommand.Name
            if (@('Get-FileHash','Get-Item','Get-Content','ConvertFrom-Json','Test-Path','Split-Path','Join-Path') -notcontains $command) { $command = 'other' }
            if ($Record.Exception.Message -match '^installation_[a-z_]+$') { $contract = $Record.Exception.Message } else { $contract = 'other' }
        }
        if ($type -notmatch '^[A-Za-z0-9_.+]{1,180}$') { $type = 'other' }
        if ($inner -notmatch '^[A-Za-z0-9_.+]{1,180}$') { $inner = 'other' }
        $file = $env:WINDOWS_ENDPOINT_FIXTURE_ENTRY_TRACE
        if (-not [IO.Path]::IsPathRooted($file) -or -not [IO.File]::Exists($file)) { return }
        if ([IO.FileInfo]::new($file).Length -gt 32768) { return }
        $row = '{"schema":1,"stage":"' + $script:fixtureEntryStage + '","context":"' + $script:fixtureEntryContext + '","exceptionType":"' + $type + '","innerType":"' + $inner + '","command":"' + $command + '","contractCode":"' + $contract + '","nativeExitCode":' + $NativeExitCode + '}'
        [IO.File]::AppendAllText($file, $row + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
    } catch { } # Only probe failure is suppressed; the original catch still runs.
}
Save-FixtureEntryProbe $null
`)
  const stage = (anchor, value, context) => before(anchor,
    `    $script:fixtureEntryStage = '${value}'` + (context ? `\n    $script:fixtureEntryContext = '${context}'` : ''))
  stage('    if (-not [IO.Path]::IsPathRooted($Path))', 'path.absolute')
  stage('    $item = Get-Item -LiteralPath $Path', 'path.item')
  stage('    if (-not ($item -is [IO.FileInfo]))', 'path.kind')
  stage('        if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint)', 'path.reparse')
  stage('    if ($item.Length -gt 262144)', 'json.bound')
  stage('    return (Get-Content -Raw -Encoding UTF8 -LiteralPath $Path | ConvertFrom-Json)', 'json.read_or_decode')
  stage("    $file = Join-Path $Directory 'candidate.json'", 'package.manifest_path', 'package-manifest')
  stage('    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256)', 'hash.manifest')
  stage("    if ($manifest.entry -ne 'endpoint.mjs'", 'package.inventory')
  stage("        $segments = $entry.path -split '/'", 'package.member', 'package-payload')
  stage('        $payload = Join-Path $Directory $entry.path', 'package.payload_path', 'package-payload')
  stage('        if ($item.Length -ne $entry.size -or (Get-FileHash', 'payload.size_or_hash')
  stage('    $installedEntry = ', 'entry.location', 'entry')
  stage('        $root = Split-Path -Parent $PSScriptRoot', 'entry.root')
  stage('        $receipt = Read-SmallJson ', 'receipt.read', 'receipt')
  stage('        if ($receipt.schema -ne 1', 'receipt.contract_or_hash')
  stage('        $config = Read-SmallJson ', 'config.read', 'config')
  stage('        if ($receipt.owner -ne $config.deviceId)', 'owner.compare')
  stage('        $selection = Read-SmallJson ', 'selection.read', 'selection')
  stage('        if ($selection.owner -ne $config.deviceId', 'selection.contract')
  stage("        $Source = Join-Path $ProductRoot ('packages/' + $selection.current)", 'source.reference', 'source')
  stage('    $null = Require-RegularPath $NodePath', 'node.reference', 'node')
  stage("    & $NodePath (Join-Path $Source 'endpoint.mjs') @arguments", 'node.invoke', 'node')
  before("    & $NodePath (Join-Path $Source 'endpoint.mjs') @arguments", '    Save-FixtureEntryProbe $null')
  before('} catch {\n    $code = ', '    $script:fixtureEntryStage = \'node.exit\'\n    Save-FixtureEntryProbe $null $result')
  text = text.replace('} catch {\n    $code = ', () => '} catch {\n    Save-FixtureEntryProbe $_\n    $code = ')
  return text
}
