# platforms: windows
[CmdletBinding()]
param(
    [string] $SkillId = 'poteto-mode',
    [string] $Workspace = 'D:\dev\simpsonm09',
    [string] $Project = (Join-Path $Workspace 'projects\repos\simpsonm09-repo-template'),
    [string] $OpenCodeBinary = 'opencode'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$command = Get-Command -Name $OpenCodeBinary -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $command) { throw "OpenCode CLI not found on PATH: $OpenCodeBinary" }

$prompt = "Call the skill tool with id $SkillId. Then read the file playbooks/investigation.md in that skill's own directory and post WORKSPACE_PSTACK_OK=<its first heading>. Do not edit files and do not run shell commands."
$json = Join-Path $env:TEMP ("workspace-skill-check.{0}.jsonl" -f [guid]::NewGuid().ToString('N'))

try {
    Push-Location $Project
    & $command.Source run --standalone --auto --format json $prompt *> $json
    if ($LASTEXITCODE -ne 0) { throw "OpenCode run failed with exit code $LASTEXITCODE" }
} finally {
    Pop-Location
}

$loaded = $false
$heading = $null
$unsafe = @()
foreach ($line in Get-Content -LiteralPath $json) {
    try { $event = $line | ConvertFrom-Json -ErrorAction Stop } catch { continue }
    if ($event.type -eq 'text' -and $event.part.text) {
        $match = [regex]::Match($event.part.text, 'WORKSPACE_PSTACK_OK=\s*[#*\s]*<?([A-Za-z]+)')
        if ($match.Success) { $heading = $match.Groups[1].Value }
    }
    if ($event.type -ne 'tool_use' -or $event.part.type -ne 'tool') { continue }
    $tool = $event.part.tool
    if ($tool -eq 'skill' -and $event.part.state.input.id -eq $SkillId) { $loaded = $true }
    if ($tool -in @('shell', 'edit', 'write', 'patch', 'subagent', 'execute')) { $unsafe += $tool }
}
Remove-Item -LiteralPath $json -Force -ErrorAction SilentlyContinue

if (-not $loaded) { throw "FAIL: no skill tool call loaded '$SkillId'." }
if ($heading -ne 'Investigation') { throw "FAIL: the agent did not read the skill's sibling playbook." }
if ($unsafe.Count -gt 0) { throw "FAIL: bounded run used restricted tools: $($unsafe -join ', ')" }

Write-Host "PASS: workspace skill '$SkillId' loaded and its sibling file was read."
