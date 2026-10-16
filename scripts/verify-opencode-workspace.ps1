# platforms: windows
[CmdletBinding()]
param(
    [string] $Workspace = $env:MAXSTACK_WORKSPACE,
    [string] $OpenCodeBinary = 'opencode',
    [int] $CallTimeoutSeconds = 60
)

# Checks what OpenCode resolves from the workspace: the workspace config and .opencode
# directory, and the three PStack agent profiles. OpenCode debug commands start or
# reuse its managed background service, but make no model call. Plugin loading needs a model call, so
# scripts/verify-workspace-skill.ps1 covers it.
#
# maxstack sets no model. Each profile must resolve without one, so the session's
# model applies, and the workspace config must name none.
#
# On a fresh boot of a directory, `opencode debug agents` can list only the built-in
# agents or none at all for its first call or two. The check retries until the
# PStack agents appear, so it reports a failure only when they never do.
#
# Every OpenCode call runs with a time limit and with its stdin closed, so it cannot
# read from the caller. A call that outlasts the limit is stopped, and the check fails
# and names the command instead of waiting forever.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Workspace)) { throw 'Pass -Workspace or set MAXSTACK_WORKSPACE.' }

. (Join-Path $PSScriptRoot 'Invoke-OpenCode.ps1')

$maxAttempts = 6
$agentIds = @('pstack-agent', 'pstack-reviewer', 'pstack-comment-sicko')

function Get-NormalPath {
    param([string] $Path)

    return [IO.Path]::GetFullPath($Path).TrimEnd('\').ToLowerInvariant()
}

# Whether an entry of `opencode debug config` is the empty config document OpenCode 2.0.31
# appends after the documents it reads: a `document` with no path and no information. Only
# that shape is skipped, so a later entry without a path is reported rather than ignored.
function Test-EmptyConfigDocument {
    param($Entry)

    $type = $Entry.PSObject.Properties['type']
    if (-not $type -or -not (Test-OrdinalEqual ([string] $type.Value) 'document')) { return $false }
    $info = $Entry.PSObject.Properties['info']
    if (-not $info -or $null -eq $info.Value) { return $true }
    if ($info.Value -is [string]) { return [string]::IsNullOrWhiteSpace($info.Value) }
    return (@($info.Value.PSObject.Properties).Count -eq 0)
}

$command = Get-Command -Name $OpenCodeBinary -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $command) { throw "OpenCode CLI not found on PATH: $OpenCodeBinary" }
if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) { throw "Workspace not found: $Workspace" }

$configRun = Invoke-OpenCode -Command $command -TimeoutSeconds $CallTimeoutSeconds -Arguments @('debug', 'config') -Directory $Workspace
if ($configRun.ExitCode -ne 0) { throw "opencode debug config failed with exit code $($configRun.ExitCode): $($configRun.StdErr.Trim())" }
$sourcesRaw = $configRun.StdOut

$failures = @()
$agents = @{}
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    $agentsRun = Invoke-OpenCode -Command $command -TimeoutSeconds $CallTimeoutSeconds -Arguments @('debug', 'agents') -Directory $Workspace
    if ($agentsRun.ExitCode -ne 0) { throw "opencode debug agents failed with exit code $($agentsRun.ExitCode): $($agentsRun.StdErr.Trim())" }

    $agents = @{}
    foreach ($agent in @(($agentsRun.StdOut | ConvertFrom-Json))) { $agents[$agent.id] = $agent }
    $missing = @($agentIds | Where-Object { -not $agents.ContainsKey($_) })
    if ($missing.Count -eq 0) { break }
    if ($attempt -lt $maxAttempts) { Start-Sleep -Seconds 3 }
}

$sources = @()
foreach ($document in @($sourcesRaw | ConvertFrom-Json)) {
    $path = $document.PSObject.Properties['path']
    if ($path -and -not [string]::IsNullOrWhiteSpace([string] $path.Value)) {
        $sources += Get-NormalPath ([string] $path.Value)
        continue
    }
    if (Test-EmptyConfigDocument $document) { continue }
    $type = $document.PSObject.Properties['type']
    $kind = if ($type -and $type.Value -is [string]) { ConvertTo-SafeName ([string] $type.Value) } else { '<no type>' }
    $failures += "opencode debug config returned a $kind entry without a path; every entry must name where OpenCode read it"
}
foreach ($expected in @((Join-Path $Workspace 'opencode.jsonc'), (Join-Path $Workspace '.opencode'))) {
    if (-not (Test-OrdinalIn (Get-NormalPath $expected) $sources)) {
        $failures += "OpenCode does not read $expected from the workspace"
    }
}

$workspaceConfig = Join-Path $Workspace 'opencode.jsonc'
if (Test-Path -LiteralPath $workspaceConfig -PathType Leaf) {
    $config = Get-Content -LiteralPath $workspaceConfig -Raw | ConvertFrom-Json
    foreach ($key in 'model', 'small_model') {
        if ($config.PSObject.Properties[$key]) { $failures += "$workspaceConfig sets $key; maxstack sets no model. Rerun Install-Workspace.ps1 -Apply" }
    }
}

foreach ($id in $agentIds) {
    if (-not $agents.ContainsKey($id)) {
        $failures += "OpenCode does not list the agent $id after $maxAttempts attempts"
        continue
    }
    $model = $agents[$id].PSObject.Properties['model']
    if ($model -and $null -ne $model.Value) {
        $failures += "agent $id sets $($model.Value.providerID)/$($model.Value.id); maxstack sets no model. Rerun Install-Workspace.ps1 -Apply"
    }
}

if ($failures.Count -gt 0) {
    throw ("FAIL: " + ($failures -join '; '))
}

Write-Host "PASS: OpenCode resolves the workspace config and $($agentIds.Count) PStack agents from $Workspace (attempt $attempt)."
