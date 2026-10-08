# platforms: windows
[CmdletBinding()]
param(
    [string] $Workspace = 'D:\dev\simpsonm09',
    [string] $OpenCodeBinary = 'opencode'
)

# Checks what a fresh OpenCode process resolves from the workspace: the workspace
# config and .opencode directory, and the PStack agent profiles with the models
# models.json names. It starts no server and makes no model call, so it does not
# depend on a running server; T3 starts its own `opencode serve` per session.
# Plugin loading needs a model call, so scripts/verify-workspace-skill.ps1 covers it.
#
# On a fresh boot of a directory, `opencode debug agents` can list only the built-in
# agents or none at all for its first call or two. The check retries until the
# PStack agents appear, so it reports a failure only when they never do.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$maxAttempts = 6

function Get-NormalPath {
    param([string] $Path)

    return [IO.Path]::GetFullPath($Path).TrimEnd('\').ToLowerInvariant()
}

$command = Get-Command -Name $OpenCodeBinary -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $command) { throw "OpenCode CLI not found on PATH: $OpenCodeBinary" }
if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) { throw "Workspace not found: $Workspace" }

$models = Get-Content -LiteralPath (Join-Path $repoRoot 'models.json') -Raw | ConvertFrom-Json
$roleByAgent = [ordered]@{
    'pstack-agent'         = 'worker'
    'pstack-reviewer'      = 'reviewer'
    'pstack-comment-sicko' = 'comment-sicko'
}

Push-Location -LiteralPath $Workspace
try {
    $configRaw = & $command.Source debug config
    if ($LASTEXITCODE -ne 0) { throw "opencode debug config failed with exit code $LASTEXITCODE" }
    $sourcesRaw = $configRaw
} finally {
    Pop-Location
}

$failures = @()
$agents = @{}
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    Push-Location -LiteralPath $Workspace
    try {
        $agentsRaw = & $command.Source debug agents
        if ($LASTEXITCODE -ne 0) { throw "opencode debug agents failed with exit code $LASTEXITCODE" }
    } finally {
        Pop-Location
    }

    $agents = @{}
    foreach ($agent in @((($agentsRaw -join "`n") | ConvertFrom-Json))) { $agents[$agent.id] = $agent }
    $missing = @($roleByAgent.Keys | Where-Object { -not $agents.ContainsKey($_) })
    if ($missing.Count -eq 0) { break }
    if ($attempt -lt $maxAttempts) { Start-Sleep -Seconds 3 }
}

$sources = @((($sourcesRaw -join "`n") | ConvertFrom-Json) | ForEach-Object { Get-NormalPath $_.path })
foreach ($expected in @((Join-Path $Workspace 'opencode.jsonc'), (Join-Path $Workspace '.opencode'))) {
    if ((Get-NormalPath $expected) -notin $sources) {
        $failures += "OpenCode does not read $expected from the workspace"
    }
}

foreach ($id in $roleByAgent.Keys) {
    if (-not $agents.ContainsKey($id)) {
        $failures += "OpenCode does not list the agent $id after $maxAttempts attempts"
        continue
    }
    $expected = $models.roles.PSObject.Properties[$roleByAgent[$id]].Value
    $provider, $model = $expected -split '/', 2
    $actual = $agents[$id].model
    if ($actual.providerID -ne $provider -or $actual.id -ne $model) {
        $failures += "agent $id uses $($actual.providerID)/$($actual.id), not $expected from models.json"
    }
}

if ($failures.Count -gt 0) {
    throw ("FAIL: " + ($failures -join '; '))
}

Write-Host "PASS: OpenCode resolves the workspace config and $($roleByAgent.Count) PStack agents from $Workspace (attempt $attempt)."
