# platforms: windows
[CmdletBinding()]
param(
    [string] $Workspace = 'D:\dev\simpsonm09',
    [string] $OpenCodeBinary = 'opencode',
    [int] $CallTimeoutSeconds = 60
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
#
# Every OpenCode call runs with a time limit and with its stdin closed, so it cannot
# read from the caller. A call that outlasts the limit is stopped, and the check fails
# and names the command instead of waiting forever.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$maxAttempts = 6

function Get-NormalPath {
    param([string] $Path)

    return [IO.Path]::GetFullPath($Path).TrimEnd('\').ToLowerInvariant()
}

# Runs one OpenCode command in a directory and returns its exit code and output.
function Invoke-OpenCode {
    param([string[]] $Arguments, [string] $Directory)

    $fileName = $command.Source
    $prefix = @()
    if ([IO.Path]::GetExtension($fileName) -eq '.ps1') {
        # The npm PowerShell shim is not a process of its own, so run it under this host.
        $prefix = @('-NoProfile', '-NonInteractive', '-File', $fileName)
        $fileName = (Get-Process -Id $PID).Path
    }

    $info = [Diagnostics.ProcessStartInfo]::new($fileName)
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.WorkingDirectory = $Directory
    foreach ($argument in @($prefix + $Arguments)) { $info.ArgumentList.Add($argument) }

    $description = "opencode $($Arguments -join ' ')"
    $process = [Diagnostics.Process]::Start($info)
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($CallTimeoutSeconds * 1000)) {
        try { $process.Kill($true) } catch { }
        throw "FAIL: '$description' did not finish within $CallTimeoutSeconds seconds in $Directory. Run it there by hand to see where it stops."
    }
    if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]] @($stdout, $stderr), 10000)) {
        throw "FAIL: '$description' exited, but its output stayed open for 10 seconds in $Directory. A child process may still hold it."
    }
    return [pscustomobject]@{ ExitCode = $process.ExitCode; StdOut = $stdout.Result; StdErr = $stderr.Result }
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

$configRun = Invoke-OpenCode -Arguments @('debug', 'config') -Directory $Workspace
if ($configRun.ExitCode -ne 0) { throw "opencode debug config failed with exit code $($configRun.ExitCode): $($configRun.StdErr.Trim())" }
$sourcesRaw = $configRun.StdOut

$failures = @()
$agents = @{}
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    $agentsRun = Invoke-OpenCode -Arguments @('debug', 'agents') -Directory $Workspace
    if ($agentsRun.ExitCode -ne 0) { throw "opencode debug agents failed with exit code $($agentsRun.ExitCode): $($agentsRun.StdErr.Trim())" }

    $agents = @{}
    foreach ($agent in @(($agentsRun.StdOut | ConvertFrom-Json))) { $agents[$agent.id] = $agent }
    $missing = @($roleByAgent.Keys | Where-Object { -not $agents.ContainsKey($_) })
    if ($missing.Count -eq 0) { break }
    if ($attempt -lt $maxAttempts) { Start-Sleep -Seconds 3 }
}

$sources = @(($sourcesRaw | ConvertFrom-Json) | ForEach-Object { Get-NormalPath $_.path })
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
