# platforms: windows
[CmdletBinding()]
param(
    [string] $Workspace = $env:MAXSTACK_WORKSPACE,
    [string] $ConfigFile = ''
)

# Checks every MCP server in the composed workspace config for reachability.
# Remote servers get a JSON-RPC initialize POST; local npx servers get an npm
# registry lookup. This tests prerequisites, not the live OpenCode session.
# Run Install-Workspace.ps1 -Apply first so the config is composed.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Install-Ordinal.ps1')

if ([string]::IsNullOrWhiteSpace($Workspace)) { throw 'Pass -Workspace or set MAXSTACK_WORKSPACE.' }

if (-not $ConfigFile) { $ConfigFile = Join-Path $Workspace 'opencode.jsonc' }
$document = Get-Content -LiteralPath $ConfigFile -Raw | ConvertFrom-Json
$servers = $document.mcp.servers
if (-not $servers) { throw "No mcp.servers found in $ConfigFile. Run Install-Workspace.ps1 -Apply first." }

$init = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}'

function Test-Remote {
    param([string] $Url)

    try {
        $response = Invoke-WebRequest -Method Post -Uri $Url -ContentType 'application/json' `
            -Headers @{ Accept = 'application/json, text/event-stream' } -Body $init -TimeoutSec 20 -SkipHttpErrorCheck
        switch ($response.StatusCode) {
            200 { return @{ status = 'ok'; detail = 'reachable, no auth needed' } }
            401 { return @{ status = 'auth'; detail = 'reachable, sign in required' } }
            404 { return @{ status = 'bad-url'; detail = 'not an MCP endpoint (404)' } }
            default { return @{ status = "http-$($response.StatusCode)"; detail = "HTTP $($response.StatusCode)" } }
        }
    } catch {
        return @{ status = 'unreachable'; detail = $_.Exception.Message }
    }
}

function Get-PackageFromCommand {
    param($Command)

    $parts = @($Command)
    if ($parts.Count -eq 0) { return $null }
    if (Test-OrdinalEqual $parts[0] 'npx') { return ($parts[-1] -replace '@latest$', '') }
    if (Test-OrdinalEqual $parts[0] 'docker') { return 'docker-image:' + ($parts[-1]) }
    return $parts[-1]
}

function Test-Local {
    param($Command)

    $package = Get-PackageFromCommand $Command
    if (-not $package) { return @{ status = 'unknown'; detail = 'no command' } }
    if (([string] $package).StartsWith('docker-image:', [StringComparison]::Ordinal)) { return @{ status = 'needs-docker'; detail = 'requires a Docker daemon' } }

    $version = npm view $package version 2>&1 | Select-Object -First 1
    if ($LASTEXITCODE -eq 0) { return @{ status = 'ok'; detail = "npm package $version" } }
    return @{ status = 'missing-package'; detail = 'not found on npm' }
}

"Server                     Type    Default  Result"
"------                     ----    -------  ------"
foreach ($property in $servers.PSObject.Properties) {
    $name = $property.Name
    $server = $property.Value
    $enabled = -not ((Test-OrdinalIn 'disabled' @($server.PSObject.Properties.Name)) -and $server.disabled)
    $default = if ($enabled) { 'on' } else { 'off' }

    if (Test-OrdinalEqual $server.type 'remote') {
        $result = Test-Remote $server.url
    } else {
        $result = Test-Local $server.command
    }
    "{0,-26} {1,-7} {2,-8} {3} ({4})" -f $name, $server.type, $default, $result.status, $result.detail
}
