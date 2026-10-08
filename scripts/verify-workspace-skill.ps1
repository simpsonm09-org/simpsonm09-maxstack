# platforms: windows
[CmdletBinding()]
param(
    [string] $SkillId = 'poteto-mode',
    [string] $Workspace = 'D:\dev\simpsonm09',
    [string] $Project = (Join-Path $Workspace 'projects\repos\simpsonm09-repo-template'),
    [string] $OpenCodeBinary = 'opencode',
    # The model the bounded run uses, as provider/model. The workspace sets none.
    [string] $Model,
    [int] $CallTimeoutSeconds = 180
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'Invoke-OpenCode.ps1')

if (-not $Model) {
    throw 'FAIL: pass -Model provider/model. The workspace sets no model, so this check names the model its bounded run uses.'
}
if ($Model -notmatch '^[^/\s]+/\S+$') { throw "FAIL: -Model must be provider/model, got '$Model'." }

$command = Get-Command -Name $OpenCodeBinary -CommandType Application, ExternalScript -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $command) { throw "OpenCode CLI not found on PATH: $OpenCodeBinary" }
if (-not (Test-Path -LiteralPath $Project -PathType Container)) { throw "Project not found: $Project" }

$prompt = "Call the skill tool with id $SkillId. Then read the file playbooks/investigation.md in that skill's own directory and post WORKSPACE_PSTACK_OK=<its first heading>. Do not edit files and do not run shell commands."
$run = Invoke-OpenCode -Command $command -TimeoutSeconds $CallTimeoutSeconds -Directory $Project -Arguments @('run', '--standalone', '--auto', '--format', 'json', '--model', $Model, $prompt)
if ($run.ExitCode -ne 0) { throw "OpenCode run failed with exit code $($run.ExitCode): $($run.StdErr.Trim())" }

$loaded = $false
$heading = $null
$unsafe = @()
foreach ($line in ($run.StdOut -split '\r?\n' | Where-Object { $_.Trim() })) {
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

if (-not $loaded) { throw "FAIL: no skill tool call loaded '$SkillId'." }
if ($heading -ne 'Investigation') { throw "FAIL: the agent did not read the skill's sibling playbook." }
if ($unsafe.Count -gt 0) { throw "FAIL: bounded run used restricted tools: $($unsafe -join ', ')" }

Write-Host "PASS: workspace skill '$SkillId' loaded and its sibling file was read."
