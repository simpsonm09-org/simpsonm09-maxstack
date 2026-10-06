# platforms: windows
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^ses')]
    [string] $SessionId,

    [string[]] $RequiredSkillId = @('poteto-mode'),

    [string] $ExpectedModel,

    [string] $OpenCodeBinary = (Join-Path $env:LOCALAPPDATA 'Programs\@openchamberelectron\resources\opencode-cli\opencode.exe')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not $env:OPENCODE_CONFIG) {
    throw 'OPENCODE_CONFIG is unset. Run this in the OpenChamber Windows user environment or pass its managed OpenCode environment first.'
}
if (-not (Test-Path -LiteralPath $env:OPENCODE_CONFIG -PathType Leaf)) {
    throw "The configured OpenChamber OpenCode config is missing: $env:OPENCODE_CONFIG"
}
if (-not (Test-Path -LiteralPath $OpenCodeBinary -PathType Leaf)) {
    throw "OpenChamber's bundled OpenCode CLI was not found: $OpenCodeBinary"
}

$raw = & $OpenCodeBinary api get "/api/session/$SessionId/message"
if ($LASTEXITCODE -ne 0) { throw "OpenCode API could not read session $SessionId" }
$payload = ($raw -join "`n") | ConvertFrom-Json -ErrorAction Stop
$toolCalls = @()
$skillIds = @()
$models = @()
$unsafeTools = @()

foreach ($message in $payload.data) {
    $modelProperty = $message.PSObject.Properties['model']
    if ($modelProperty -and $modelProperty.Value.providerID -and $modelProperty.Value.id) {
        $models += "$($modelProperty.Value.providerID)/$($modelProperty.Value.id)"
    }
    $contentProperty = $message.PSObject.Properties['content']
    if (-not $contentProperty) { continue }
    foreach ($part in $contentProperty.Value) {
        if ($part.type -ne 'tool') { continue }
        $toolCalls += [string] $part.name
        $stateProperty = $part.PSObject.Properties['state']
        $inputProperty = if ($stateProperty) { $stateProperty.Value.PSObject.Properties['input'] } else { $null }
        $skillIdProperty = if ($inputProperty) { $inputProperty.Value.PSObject.Properties['id'] } else { $null }
        if ($part.name -eq 'skill' -and $skillIdProperty) {
            $skillIds += [string] $skillIdProperty.Value
        }
        if ($part.name -in @('shell', 'edit', 'write', 'patch', 'subagent', 'execute')) {
            $unsafeTools += [string] $part.name
        }
    }
}

$missing = @($RequiredSkillId | Where-Object { $_ -notin $skillIds })
if ($missing.Count -gt 0) {
    throw "Session $SessionId did not call the skill tool for: $($missing -join ', ')"
}
if ($unsafeTools.Count -gt 0) {
    throw "Session $SessionId used restricted tools: $($unsafeTools -join ', ')"
}
if ($ExpectedModel -and $ExpectedModel -notin $models) {
    throw "Session $SessionId did not use expected model $ExpectedModel. Observed: $($models -join ', ')"
}

Write-Host "PASS: OpenChamber session $SessionId loaded $($skillIds -join ', ')."
if ($ExpectedModel) { Write-Host "Model: $ExpectedModel" }
Write-Host "Tool calls: $($toolCalls -join ', '). No shell, edit, write, patch, subagent, or execute calls were found."
