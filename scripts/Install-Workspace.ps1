# platforms: windows
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string] $Workspace = 'D:\dev\simpsonm09',
    [string] $PluginSource = '',
    [switch] $Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$layersFile = Join-Path $repoRoot 'layers.json'
$baseConfigFile = Join-Path $repoRoot 'workspace\opencode.jsonc'
$modelsFile = Join-Path $repoRoot 'models.json'
$lockFile = Join-Path $repoRoot 'pstack-opencode.lock.json'
$configTarget = Join-Path $Workspace 'opencode.jsonc'
$stackTarget = Join-Path $Workspace 'stack.lock.json'
$agentsTarget = Join-Path $Workspace '.opencode\agents'
$pluginItems = @('index.ts', 'package.json', 'README.md', 'docs', 'pstack.lock.json', 'NOTICE', 'NOTICE-port.md', 'LICENSE', 'LICENSE-cursor-team-kit', 'skills')
$roleByFile = @{
    'pstack-agent.md'         = 'worker'
    'pstack-reviewer.md'      = 'reviewer'
    'pstack-comment-sicko.md' = 'comment-sicko'
}

function Get-RoleModel {
    param($Models, [string] $Role)

    if ($Role) {
        $roles = $Models.PSObject.Properties['roles']
        if ($roles) {
            $property = $roles.Value.PSObject.Properties[$Role]
            if ($property) { return $property.Value }
        }
    }
    return $Models.PSObject.Properties['default'].Value
}

function Set-AgentModel {
    param([string] $Path, [string] $Model)

    $text = [IO.File]::ReadAllText($Path).Replace("`r`n", "`n")
    $text = [regex]::Replace($text, '(?m)^model:.*\n', '')
    if ($Model) { $text = ([regex]'^---\n').Replace($text, "---`nmodel: $Model`n", 1) }
    [IO.File]::WriteAllText($Path, $text, (New-Object System.Text.UTF8Encoding($false)))
}

function Get-LayerFragmentPath {
    param([string] $LayerRoot)

    $layerJson = Join-Path $LayerRoot 'layer.json'
    $fragment = 'opencode.fragment.jsonc'
    if (Test-Path -LiteralPath $layerJson -PathType Leaf) {
        $meta = Get-Content -LiteralPath $layerJson -Raw | ConvertFrom-Json
        $prop = $meta.PSObject.Properties['config']
        if ($prop -and $prop.Value) { $fragment = $prop.Value }
    }
    return (Join-Path $LayerRoot $fragment)
}

function Get-PluginItems {
    param([string] $LayerRoot)

    $layerJson = Join-Path $LayerRoot 'layer.json'
    if (Test-Path -LiteralPath $layerJson -PathType Leaf) {
        $meta = Get-Content -LiteralPath $layerJson -Raw | ConvertFrom-Json
        $prop = $meta.PSObject.Properties['files']
        if ($prop -and $prop.Value) { return @($prop.Value) }
    }
    return @($pluginItems)
}

if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) {
    throw "Workspace not found: $Workspace"
}

$models = Get-Content -LiteralPath $modelsFile -Raw | ConvertFrom-Json
$lock = Get-Content -LiteralPath $lockFile -Raw | ConvertFrom-Json
$primary = Get-RoleModel $models 'primary'
$manifest = Get-Content -LiteralPath $layersFile -Raw | ConvertFrom-Json
$layers = @($manifest.layers)

foreach ($layer in $layers) {
    $root = Join-Path $Workspace $layer.path
    if ($PluginSource -and $layer.PSObject.Properties['pluginTarget']) { $root = $PluginSource }
    $layer | Add-Member -NotePropertyName root -NotePropertyValue $root -Force
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
        throw "Layer '$($layer.name)' is not checked out at $root."
    }
    if ($layer.PSObject.Properties['pluginTarget'] -and -not (Test-Path -LiteralPath (Join-Path $root 'index.ts') -PathType Leaf)) {
        throw "Plugin layer '$($layer.name)' has no index.ts at $root."
    }
}

$pluginLayer = $layers | Where-Object { $_.kind -eq 'plugin' } | Select-Object -First 1
if ($pluginLayer) {
    $head = (& git -C $pluginLayer.root rev-parse HEAD 2>$null)
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Could not read the git HEAD of $($pluginLayer.root); skipping the pin check."
    } elseif ($head.Trim() -ne $lock.commit) {
        Write-Warning "Plugin source is at $($head.Trim()), not the locked $($lock.commit). Commit or update pstack-opencode.lock.json."
    }
}

Write-Host "Workspace:      $Workspace"
foreach ($layer in $layers) {
    Write-Host ("Layer:          {0} ({1}) at {2}" -f $layer.name, $layer.kind, $layer.root)
}
Write-Host "Config target:  $configTarget"
Write-Host "Primary model:  $primary"

if (-not $Apply) {
    Write-Host 'Audit only. No files or workspace configuration changed. Rerun with -Apply after reviewing.'
    return
}

$base = Get-Content -LiteralPath $baseConfigFile -Raw | ConvertFrom-Json
$serverMaps = @()
$extraPermissions = @()
foreach ($layer in $layers) {
    if ($layer.kind -ne 'config') { continue }
    $fragmentPath = Get-LayerFragmentPath $layer.root
    if (-not (Test-Path -LiteralPath $fragmentPath -PathType Leaf)) {
        throw "Layer '$($layer.name)' has no config fragment: $fragmentPath"
    }
    $fragment = Get-Content -LiteralPath $fragmentPath -Raw | ConvertFrom-Json
    $mcpProperty = $fragment.PSObject.Properties['mcp']
    if ($mcpProperty) {
        $serversProperty = $mcpProperty.Value.PSObject.Properties['servers']
        if ($serversProperty) { $serverMaps += $serversProperty.Value }
    }
    $permissionProperty = $fragment.PSObject.Properties['permissions']
    if ($permissionProperty) { $extraPermissions += $permissionProperty.Value }
}

$servers = [ordered]@{}
foreach ($map in $serverMaps) {
    foreach ($property in $map.PSObject.Properties) {
        $servers[$property.Name] = $property.Value
    }
}

if (-not $base.PSObject.Properties['mcp']) {
    $base | Add-Member -NotePropertyName mcp -NotePropertyValue ([pscustomobject]@{}) -Force
}
if (-not $base.mcp.PSObject.Properties['servers']) {
    $base.mcp | Add-Member -NotePropertyName servers -NotePropertyValue ([pscustomobject]@{}) -Force
}
foreach ($name in $servers.Keys) {
    $base.mcp.servers | Add-Member -NotePropertyName $name -NotePropertyValue $servers[$name] -Force
}
if ($extraPermissions.Count -gt 0) {
    $base.permissions = @($base.permissions) + $extraPermissions
}
$base.model = $primary
$document = ($base | ConvertTo-Json -Depth 100)

New-Item -ItemType Directory -Path (Split-Path -Parent $configTarget) -Force | Out-Null
if ((Test-Path -LiteralPath $configTarget) -and ((Get-Content -LiteralPath $configTarget -Raw).Trim() -eq $document.Trim())) {
    Write-Host "Config already matches: $configTarget"
} else {
    if (Test-Path -LiteralPath $configTarget) {
        Copy-Item -LiteralPath $configTarget -Destination "$configTarget.bak" -Force
        Write-Host "Backed up the previous config to $configTarget.bak"
    }
    [IO.File]::WriteAllText($configTarget, $document, (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "Wrote $configTarget"
}

foreach ($layer in $layers) {
    if (-not $layer.PSObject.Properties['pluginTarget']) { continue }

    $items = Get-PluginItems $layer.root
    $target = Join-Path $Workspace ".opencode\plugins\$($layer.pluginTarget)"
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    foreach ($item in $items) {
        $source = Join-Path $layer.root $item
        if (-not (Test-Path -LiteralPath $source)) { throw "Plugin layer '$($layer.name)' is missing: $source" }
        $destination = Join-Path $target $item
        if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
        Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
    }
    Write-Host "Copied plugin layer '$($layer.name)' into $target"

    if (-not (Test-Path -LiteralPath (Join-Path $target 'node_modules\@opencode\plugin'))) {
        Write-Host 'Installing plugin dependencies'
        & npm install --prefix $target --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm install failed in $target" }
    }

    $agentsSource = Join-Path $layer.root 'agents'
    if (Test-Path -LiteralPath $agentsSource -PathType Container) {
        New-Item -ItemType Directory -Path $agentsTarget -Force | Out-Null
        Get-ChildItem -LiteralPath $agentsSource -Filter '*.md' | ForEach-Object {
            $role = if ($roleByFile.ContainsKey($_.Name)) { $roleByFile[$_.Name] } else { $null }
            $model = Get-RoleModel $models $role
            $destination = Join-Path $agentsTarget $_.Name
            Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
            Set-AgentModel -Path $destination -Model $model
            Write-Host "Installed agent profile $($_.Name) with model $model"
        }
    }
}

$layerRecords = foreach ($layer in $layers) {
    $head = (& git -C $layer.root rev-parse HEAD 2>$null)
    [pscustomobject]@{
        name   = $layer.name
        kind   = $layer.kind
        path   = $layer.path
        source = $layer.source
        commit = $(if ($head) { $head.Trim() } else { $null })
    }
}
$bytes = [Text.Encoding]::UTF8.GetBytes($document)
$stream = New-Object IO.MemoryStream(, $bytes)
$configHash = (Get-FileHash -InputStream $stream -Algorithm SHA256).Hash
$stack = [pscustomobject]@{
    generatedAt  = (Get-Date).ToUniversalTime().ToString('o')
    primaryModel = $primary
    configSha256 = $configHash
    layers       = $layerRecords
}
[IO.File]::WriteAllText($stackTarget, ($stack | ConvertTo-Json -Depth 6), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Wrote $stackTarget"

Write-Host 'Workspace bundle installed from the layer manifest.'

$managedDir = Join-Path $env:USERPROFILE '.config\openchamber\managed-opencode'
if (Test-Path -LiteralPath $managedDir -PathType Container) {
    $running = @()
    foreach ($file in Get-ChildItem -LiteralPath $managedDir -Filter '*.json' -ErrorAction SilentlyContinue) {
        try { $record = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json -ErrorAction Stop } catch { continue }
        if ($record.pid -and (Get-Process -Id $record.pid -ErrorAction SilentlyContinue)) { $running += $record }
    }
    if ($running.Count -gt 0) {
        $ids = ($running | ForEach-Object { "pid $($_.pid)" }) -join ', '
        Write-Host ''
        Write-Warning "A running OpenChamber server was found ($ids). It caches plugin resolution for the life of the process, so it may keep the previous plugin state."
        Write-Host 'Restart OpenChamber before relying on PStack in the GUI, then run:'
        Write-Host '  pwsh -File D:\dev\simpsonm09\projects\repos\simpsonm09-maxstack\scripts\verify-live-server.ps1'
    }
}
