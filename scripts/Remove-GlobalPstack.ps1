[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [switch] $Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$cloneSkills = Join-Path $env:LOCALAPPDATA 'maxstack\pstack-claude\plugins\pstack\skills'
$adapterSkills = Join-Path $repoRoot 'opencode\skills'
$skillsHome = Join-Path $env:USERPROFILE '.agents\skills'
$configHome = Join-Path $env:USERPROFILE '.config\opencode'
$agentsHome = Join-Path $configHome 'agents'
$remove = New-Object System.Collections.Generic.List[string]
$conflicts = New-Object System.Collections.Generic.List[string]

function Get-NormalizedText {
    param([string] $Path)

    return ((Get-Content -LiteralPath $Path -Raw) -replace "`r`n", "`n")
}

function Test-SameText {
    param([string] $Left, [string] $Right)

    return (Get-NormalizedText $Left) -ceq (Get-NormalizedText $Right)
}

if (Test-Path -LiteralPath $skillsHome) {
    foreach ($entry in Get-ChildItem -LiteralPath $skillsHome -Force) {
        if ($entry.LinkType -ne 'Junction' -and $entry.LinkType -ne 'SymbolicLink') { continue }
        $target = [string]@($entry.Target)[0]
        if (-not $target) { continue }
        $isOurs = $target.StartsWith($cloneSkills, [StringComparison]::OrdinalIgnoreCase) -or
            $target.StartsWith($adapterSkills, [StringComparison]::OrdinalIgnoreCase)
        if ($isOurs) { $remove.Add($entry.FullName) }
    }
}

$sourceAgentsMd = Join-Path $repoRoot 'opencode\AGENTS.md'
$destAgentsMd = Join-Path $configHome 'AGENTS.md'
if (Test-Path -LiteralPath $destAgentsMd) {
    if ((Test-Path -LiteralPath $sourceAgentsMd) -and (Test-SameText $destAgentsMd $sourceAgentsMd)) {
        $remove.Add($destAgentsMd)
    } else {
        $conflicts.Add($destAgentsMd)
    }
}

if (Test-Path -LiteralPath $agentsHome) {
    foreach ($profile in Get-ChildItem -LiteralPath (Join-Path $repoRoot 'opencode\agents') -Filter '*.md') {
        $destination = Join-Path $agentsHome $profile.Name
        if (-not (Test-Path -LiteralPath $destination)) { continue }
        if (Test-SameText $destination $profile.FullName) {
            $remove.Add($destination)
        } else {
            $conflicts.Add($destination)
        }
    }
}

$configPath = Join-Path $configHome 'opencode.jsonc'
$rewriteConfig = $false
if (Test-Path -LiteralPath $configPath) {
    $normalized = (Get-Content -LiteralPath $configPath -Raw) -replace '\s', ''
    $expected = '{"$schema":"https://opencode.ai/config.json","model":"opencode-go/gpt-6-luna","default_agent":"build"}'
    if ($normalized -ceq $expected) {
        $rewriteConfig = $true
    } else {
        $conflicts.Add("$configPath (remove the model and default_agent lines manually)")
    }
}

if ($remove.Count -gt 0) { Write-Host 'Will remove:'; $remove | ForEach-Object { Write-Host "  $_" } }
if ($rewriteConfig) { Write-Host "Will reset $configPath to the schema only" }
if ($conflicts.Count -gt 0) { Write-Host 'Left for manual review:'; $conflicts | ForEach-Object { Write-Host "  $_" } }

if (-not $Apply) {
    Write-Host 'Audit only. No global files changed. Rerun with -Apply after reviewing.'
    return
}

foreach ($path in $remove) {
    Remove-Item -LiteralPath $path -Force -Recurse
    Write-Host "Removed $path"
}
if ($rewriteConfig) {
    [IO.File]::WriteAllText($configPath, '{' + "`n" + '  "$schema": "https://opencode.ai/config.json"' + "`n" + '}', (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Reset $configPath"
}
Write-Host 'Global PStack install removed for the Windows OpenCode runtime.'
