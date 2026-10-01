[CmdletBinding()]
param(
    [string] $Workspace = 'D:\dev\simpsonm09',
    [string] $LogPath = (Join-Path $env:USERPROFILE '.local\share\opencode\log\opencode.log'),
    [string] $ManagedConfigDir = (Join-Path $env:USERPROFILE '.config\openchamber\managed-opencode'),
    [string] $PluginId = 'pstack-opencode'
)

# The behavioral verifiers run `opencode run --standalone`, which starts a fresh
# process. A long-lived OpenChamber server resolves plugins once, when it starts,
# and never recovers if it started before the plugin's node_modules existed. This
# check inspects the running server instead, so that failure cannot hide.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$pluginDir = Join-Path $Workspace ".opencode\plugins\$PluginId"
if (-not (Test-Path -LiteralPath (Join-Path $pluginDir 'index.ts') -PathType Leaf)) {
    throw "Workspace plugin entrypoint not found: $pluginDir"
}

if (-not (Test-Path -LiteralPath $ManagedConfigDir -PathType Container)) {
    Write-Host 'SKIP: no OpenChamber managed-server registrations found; nothing to inspect.'
    return
}

$running = @()
foreach ($file in Get-ChildItem -LiteralPath $ManagedConfigDir -Filter '*.json' -ErrorAction SilentlyContinue) {
    $rawText = Get-Content -LiteralPath $file.FullName -Raw
    try { $record = $rawText | ConvertFrom-Json -ErrorAction Stop } catch { continue }
    if (-not $record.pid) { continue }
    if (-not (Get-Process -Id $record.pid -ErrorAction SilentlyContinue)) { continue }
    # Read startedAt as text; ConvertFrom-Json would turn the ISO string into a
    # local DateTime and lose the UTC offset used in the log.
    $stampMatch = [regex]::Match($rawText, '"startedAt"\s*:\s*"([^"]+)"')
    $running += [pscustomobject]@{
        pid       = $record.pid
        port      = $record.port
        startedAt = $(if ($stampMatch.Success) { $stampMatch.Groups[1].Value } else { $null })
    }
}

if ($running.Count -eq 0) {
    Write-Host 'SKIP: no running OpenChamber managed OpenCode server found.'
    return
}

$server = $running | Sort-Object { [datetimeoffset]::Parse($_.startedAt) } -Descending | Select-Object -First 1
$started = [datetimeoffset]::Parse($server.startedAt)

if (-not (Test-Path -LiteralPath $LogPath -PathType Leaf)) {
    Write-Host "SKIP: OpenCode log not found: $LogPath"
    return
}

# The log records Windows paths with doubled backslashes inside quoted fields.
$targetPattern = [regex]::Escape($pluginDir.Replace('\', '\\'))

# A load only counts if it happened after the plugin's files settled. Installing
# while the server runs can trigger a reload mid-copy that registers zero skills
# without logging a failure, so gate on the newest artifact write time.
$cutoff = $started.UtcDateTime
$artifactTime = (Get-Item -LiteralPath (Join-Path $pluginDir 'index.ts')).LastWriteTimeUtc
foreach ($directory in Get-ChildItem -LiteralPath (Join-Path $pluginDir 'skills') -Directory -ErrorAction SilentlyContinue) {
    if ($directory.LastWriteTimeUtc -gt $artifactTime) { $artifactTime = $directory.LastWriteTimeUtc }
}
if ($artifactTime -gt $cutoff) { $cutoff = $artifactTime }

$loads = 0
$failures = @()
foreach ($line in Get-Content -LiteralPath $LogPath) {
    if ($line -notmatch $targetPattern) { continue }
    $isLoad = $line -match 'msg="loading plugin"'
    $isFail = $line -match 'message="failed to load plugin"'
    if (-not ($isLoad -or $isFail)) { continue }
    $match = [regex]::Match($line, 'timestamp=(\S+)')
    if (-not $match.Success) { continue }
    $stamp = [datetimeoffset]::Parse($match.Groups[1].Value)
    if ($stamp.UtcDateTime -lt $cutoff) { continue }
    if ($isLoad) { $loads++ }
    if ($isFail) { $failures += $stamp }
}

$label = "pid $($server.pid), port $($server.port), started $($server.startedAt)"

if ($failures.Count -gt 0) {
    $last = $failures | Sort-Object -Descending | Select-Object -First 1
    throw ("FAIL: the running OpenChamber server ($label) failed to load '$PluginId' " +
        "$($failures.Count) time(s) since it started (last at $($last.ToString('u'))). " +
        'A server resolves plugins once per process. Restart OpenChamber, then rerun this check. ' +
        'The CLI verifiers pass because they start a fresh process.')
}
if ($loads -gt 0) {
    Write-Host "PASS: the running OpenChamber server ($label) loaded '$PluginId' after it started."
    return
}

Write-Host "SKIP: the running OpenChamber server ($label) has not attempted to load '$PluginId' yet."
Write-Host 'Open a session inside the workspace so the location boots, then rerun this check.'
