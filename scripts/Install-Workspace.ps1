# platforms: windows
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string] $Workspace = 'D:\dev\simpsonm09',
    [string] $PluginSource = '',
    [string] $LayersFile = '',
    [string[]] $LayerSource = @(),
    [switch] $Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$layersPath = if ($LayersFile) { $LayersFile } else { Join-Path $repoRoot 'layers.json' }
$baseConfigFile = Join-Path $repoRoot 'workspace\opencode.jsonc'
$modelsFile = Join-Path $repoRoot 'models.json'
$lockFile = Join-Path $repoRoot 'pstack-opencode.lock.json'
$configTarget = Join-Path $Workspace 'opencode.jsonc'
$stackTarget = Join-Path $Workspace 'stack.lock.json'
$agentsTarget = Join-Path $Workspace '.opencode\agents'
$opencodePluginsTarget = Join-Path $Workspace '.opencode\plugins'
$claudePluginsTarget = Join-Path $Workspace '.claude\plugins'
$claudeCacheTarget = Join-Path $Workspace '.claude\cache'
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

function Get-Field {
    param($Object, [string] $Name)

    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($property) { return $property.Value }
    return $null
}

function Test-NonEmptyString {
    param($Value)

    return (($Value -is [string]) -and $Value.Trim().Length -gt 0)
}

function Get-TextSha256 {
    param([string] $Text)

    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    $stream = New-Object IO.MemoryStream(, $bytes)
    return (Get-FileHash -InputStream $stream -Algorithm SHA256).Hash
}

# Reports whether the config file is missing, differs from the text the installer
# would write, or matches it. Audit mode uses it and writes nothing.
function Get-DriftState {
    param([string] $Path, [string] $Text)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return 'missing' }
    if (([IO.File]::ReadAllText($Path)).Trim() -eq $Text.Trim()) { return 'matches' }
    return 'differs'
}

# Turns one layer's optional claude block into a record. A local layer (no git
# block) is a junction under .claude\plugins to its installed copy in
# .opencode\plugins, so both harnesses share one copy. A git block materialises a
# plugin subfolder of a repository at an exact commit into .claude\plugins.
function Get-ClaudeRecord {
    param($Layer)

    $block = Get-Field $Layer 'claude'
    if ($null -eq $block) { return $null }

    $plugin = Get-Field $block 'plugin'
    if (-not (Test-NonEmptyString $plugin) -or $plugin -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
        throw "Layer '$($Layer.name)' claude.plugin must be a non-empty folder-safe name."
    }

    $git = Get-Field $block 'git'
    if ($null -ne $git) {
        $url = Get-Field $git 'url'
        $path = Get-Field $git 'path'
        $commit = Get-Field $git 'commit'
        if (-not (Test-NonEmptyString $url)) { throw "Layer '$($Layer.name)' claude.git needs a url." }
        if (-not (Test-NonEmptyString $path) -or [IO.Path]::IsPathRooted($path) -or $path -match '(^|[\\/])\.\.([\\/]|$)') {
            throw "Layer '$($Layer.name)' claude.git.path must be a relative path inside the repository."
        }
        if (-not (Test-NonEmptyString $commit) -or $commit -cnotmatch '^[0-9a-f]{40}$') {
            throw "Layer '$($Layer.name)' claude.git.commit must be a 40-character lowercase commit SHA."
        }
        return [pscustomobject]@{ layer = $Layer.name; plugin = $plugin; kind = 'git'; url = $url; path = $path; commit = $commit }
    }

    $target = Get-Field $Layer 'pluginTarget'
    if (-not (Test-NonEmptyString $target)) {
        throw "Layer '$($Layer.name)' has a claude block without a pluginTarget. The Claude plugin links to the installed copy under .opencode\plugins, so the layer needs one."
    }
    $manifestPath = Join-Path $Layer.root '.claude-plugin\plugin.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Layer '$($Layer.name)' has a claude block but no .claude-plugin\plugin.json at $($Layer.root). Add the manifest to that repository or remove its claude block."
    }
    $declared = Get-Field (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json) 'name'
    if ($declared -ne $plugin) {
        throw "Layer '$($Layer.name)' claude.plugin is '$plugin' but its .claude-plugin\plugin.json names '$declared'."
    }
    if (@(Get-PluginItems $Layer.root) -notcontains '.claude-plugin') {
        throw "Layer '$($Layer.name)' has a claude block but its layer.json files list omits .claude-plugin, so the installed copy would not carry the manifest."
    }
    return [pscustomobject]@{ layer = $Layer.name; plugin = $plugin; kind = 'junction'; target = $target }
}

function Get-NormalPath {
    param([string] $Path)

    return [IO.Path]::GetFullPath($Path).TrimEnd('\').ToLowerInvariant()
}

# The folders directly under .opencode\plugins that no current layer's pluginTarget
# names. A layer that was renamed or removed leaves its folder behind.
function Get-StalePluginFolders {
    param([string[]] $Wanted)

    if (-not (Test-Path -LiteralPath $opencodePluginsTarget -PathType Container)) { return @() }
    return @(Get-ChildItem -LiteralPath $opencodePluginsTarget -Directory -Force | Where-Object { $Wanted -notcontains $_.Name })
}

function Test-ClaudeJunction {
    param([string] $Child, [string] $Target)

    $item = Get-Item -LiteralPath $Child -Force -ErrorAction SilentlyContinue
    if ($null -eq $item -or $item.LinkType -ne 'Junction') { return $false }
    $linked = @($item.Target)[0]
    return ([bool]$linked -and (Get-NormalPath $linked) -eq (Get-NormalPath $Target))
}

# Removes a junction by deleting the link itself, which never touches its target.
# Anything else at the path is ours, a materialised copy, and is removed in full.
function Remove-ClaudeChild {
    param([string] $Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return }
    if ($item.LinkType -eq 'Junction') {
        [IO.Directory]::Delete($item.FullName, $false)
    } elseif ($item.PSIsContainer) {
        Remove-Item -LiteralPath $Path -Recurse -Force
    } else {
        Remove-Item -LiteralPath $Path -Force
    }
}

# A hash over the tree's relative paths and file hashes, leaving out a top-level
# node_modules. Audit and the lock both use it, so a changed or missing file shows.
function Get-TreeSha256 {
    param([string] $Root)

    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $files = @(Get-ChildItem -LiteralPath $Root -Force | Where-Object { $_.Name -ne 'node_modules' } | ForEach-Object {
        if ($_.PSIsContainer) { Get-ChildItem -LiteralPath $_.FullName -Recurse -File -Force } else { $_ }
    })
    $lines = @($files | ForEach-Object {
        $relative = $_.FullName.Substring($rootFull.Length + 1).Replace('\', '/')
        "$relative`t$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)"
    })
    [string[]] $sorted = $lines
    [Array]::Sort($sorted, [StringComparer]::Ordinal)
    return (Get-TextSha256 (($sorted -join "`n") + "`n"))
}

# Brings the cached repository to the pinned commit and returns the cache path. A
# partial, sparse clone keeps only the plugin folder. Once the commit is in the
# cache, no network is used.
function Sync-GitPlugin {
    param($Record)

    $name = ($Record.url.TrimEnd('/') -split '/')[-1] -replace '\.git$', ''
    $cache = Join-Path $claudeCacheTarget $name
    if (-not (Test-Path -LiteralPath (Join-Path $cache '.git'))) {
        New-Item -ItemType Directory -Path $claudeCacheTarget -Force | Out-Null
        Write-Host "Cloning $($Record.url) (partial, sparse) into $cache"
        & git clone --quiet --filter=blob:none --no-checkout --sparse $Record.url $cache
        if ($LASTEXITCODE -ne 0) { throw "git clone of $($Record.url) failed for '$($Record.plugin)'." }
        & git -C $cache config core.autocrlf false
        & git -C $cache config core.eol lf
        & git -C $cache sparse-checkout set $Record.path
        if ($LASTEXITCODE -ne 0) { throw "git sparse-checkout of $($Record.path) failed in $cache." }
    }

    & git -C $cache cat-file -e "$($Record.commit)^{commit}" 2>$null
    if ($LASTEXITCODE -ne 0) {
        & git -C $cache fetch --quiet --filter=blob:none origin $Record.commit
        if ($LASTEXITCODE -ne 0) {
            throw "Could not fetch the pinned commit $($Record.commit) from $($Record.url) for '$($Record.plugin)'. Check claude.git.commit in layers.json."
        }
    }
    & git -C $cache -c advice.detachedHead=false checkout --quiet --detach $Record.commit
    if ($LASTEXITCODE -ne 0) { throw "git checkout of $($Record.commit) failed in $cache." }
    $head = (& git -C $cache rev-parse HEAD).Trim()
    if ($head -ne $Record.commit) { throw "The cache is at $head, not the pinned $($Record.commit) for '$($Record.plugin)'." }
    return $cache
}

# Whether a claude child is missing, differs from what the last apply recorded, or
# matches it. Audit uses it, so it never writes and never touches the network.
function Get-ClaudeChildState {
    param($Record, $Prior, [string] $Child, [string] $Target)

    $item = Get-Item -LiteralPath $Child -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return 'missing' }
    if ($Record.kind -eq 'junction') {
        if (-not (Test-ClaudeJunction -Child $Child -Target $Target)) { return 'differs' }
        if (-not (Test-Path -LiteralPath $Target -PathType Container)) { return 'differs' }
    } elseif ($item.LinkType) {
        return 'differs'
    }
    if ($null -eq $Prior -or (Get-Field $Prior 'kind') -ne $Record.kind) { return 'differs' }
    if ($Record.kind -eq 'git' -and (Get-Field $Prior 'commit') -ne $Record.commit) { return 'differs' }
    if ((Get-Field $Prior 'treeSha256') -ne (Get-TreeSha256 $Child)) { return 'differs' }
    return 'matches'
}

if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) {
    throw "Workspace not found: $Workspace"
}

$workspaceName = Split-Path -Leaf $Workspace.TrimEnd('\', '/')
if ([string]::IsNullOrWhiteSpace($workspaceName)) {
    throw "Could not derive a workspace name from: $Workspace"
}

$models = Get-Content -LiteralPath $modelsFile -Raw | ConvertFrom-Json
$lock = Get-Content -LiteralPath $lockFile -Raw | ConvertFrom-Json
$primary = Get-RoleModel $models 'primary'
$layerManifest = Get-Content -LiteralPath $layersPath -Raw | ConvertFrom-Json
$layers = @($layerManifest.layers)

# Each -LayerSource entry is name=path. Under pwsh -File, separate tokens do not bind
# to an array, so entries may also be comma-separated in one token.
$sourceOverrides = @{}
foreach ($entry in @($LayerSource | ForEach-Object { $_ -split ',' } | Where-Object { $_ })) {
    $overrideName, $overridePath = $entry -split '=', 2
    if (-not (Test-NonEmptyString $overridePath)) { throw "LayerSource expects name=path, got '$entry'." }
    if (-not ($layers | Where-Object { $_.name -eq $overrideName })) { throw "LayerSource names an unknown layer: $overrideName" }
    $sourceOverrides[$overrideName] = $overridePath
}

foreach ($layer in $layers) {
    $root = Join-Path $Workspace $layer.path
    if ($sourceOverrides.ContainsKey($layer.name)) { $root = $sourceOverrides[$layer.name] }
    if ($PluginSource -and $layer.PSObject.Properties['pluginTarget']) { $root = $PluginSource }
    $layer | Add-Member -NotePropertyName root -NotePropertyValue $root -Force
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
        throw "Layer '$($layer.name)' is not checked out at $root."
    }
    if ($layer.PSObject.Properties['pluginTarget'] -and -not (Test-Path -LiteralPath (Join-Path $root 'index.ts') -PathType Leaf)) {
        throw "Plugin layer '$($layer.name)' has no index.ts at $root."
    }
}

$claudeRecords = @()
foreach ($layer in $layers) {
    $record = Get-ClaudeRecord -Layer $layer
    if ($record) { $claudeRecords += $record }
}

$seenPlugins = @{}
foreach ($record in $claudeRecords) {
    if ($seenPlugins.ContainsKey($record.plugin)) { throw "Claude plugin '$($record.plugin)' is declared by more than one layer." }
    $seenPlugins[$record.plugin] = $true
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

# The previous lock records what the last apply put in each Claude child; audit
# compares against it.
$priorLayers = @{}
if (Test-Path -LiteralPath $stackTarget -PathType Leaf) {
    try {
        foreach ($priorLayer in @((Get-Content -LiteralPath $stackTarget -Raw | ConvertFrom-Json).layers)) {
            $priorLayers[$priorLayer.name] = $priorLayer
        }
    } catch {
        Write-Warning "Could not read the previous $stackTarget; every Claude child will report as differs until the next apply."
    }
}

# The plugin folders the current layers name, and the ones the previous lock recorded
# the installer creating. Stale folders are removed only when the lock recorded them.
$wantedTargets = @($layers | Where-Object { $_.PSObject.Properties['pluginTarget'] } | ForEach-Object { $_.pluginTarget })
$priorTargets = @($priorLayers.Values | ForEach-Object { Get-Field $_ 'pluginTarget' } | Where-Object { $_ })

Write-Host "Workspace:      $Workspace"
foreach ($layer in $layers) {
    Write-Host ("Layer:          {0} ({1}) at {2}" -f $layer.name, $layer.kind, $layer.root)
}
Write-Host "Config target:  $configTarget"
Write-Host "Primary model:  $primary"
Write-Host "Claude plugins: $($claudeRecords.Count) declared in $claudePluginsTarget"

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

# Git sources are synced before anything is written, so a bad pin stops the run
# with the workspace unchanged.
$gitCaches = @{}
if ($Apply) {
    foreach ($record in $claudeRecords) {
        if ($record.kind -eq 'git') { $gitCaches[$record.plugin] = Sync-GitPlugin $record }
    }
}

if (-not $Apply) {
    Write-Host ("Drift:          {0}: {1}" -f $configTarget, (Get-DriftState -Path $configTarget -Text $document))
    $wanted = @($claudeRecords | ForEach-Object { $_.plugin })
    foreach ($record in $claudeRecords) {
        $child = Join-Path $claudePluginsTarget $record.plugin
        $target = if ($record.kind -eq 'junction') { Join-Path $Workspace ".opencode\plugins\$($record.target)" } else { $null }
        $prior = Get-Field $priorLayers[$record.layer] 'claude'
        $state = Get-ClaudeChildState -Record $record -Prior $prior -Child $child -Target $target
        Write-Host ("Drift:          {0}: {1}" -f $child, $state)
    }
    if (Test-Path -LiteralPath $claudePluginsTarget -PathType Container) {
        foreach ($entry in Get-ChildItem -LiteralPath $claudePluginsTarget -Force) {
            if ($wanted -notcontains $entry.Name) { Write-Host ("Drift:          {0}: stale" -f $entry.FullName) }
        }
    }
    foreach ($entry in Get-StalePluginFolders -Wanted $wantedTargets) {
        Write-Host ("Drift:          {0}: stale" -f $entry.FullName)
    }
    Write-Host 'Audit only. No files or workspace configuration changed. Rerun with -Apply after reviewing.'
    return
}

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

    $claudeDeclared = $null -ne (Get-Field $layer 'claude')
    $items = Get-PluginItems $layer.root
    $target = Join-Path $Workspace ".opencode\plugins\$($layer.pluginTarget)"
    New-Item -ItemType Directory -Path $target -Force | Out-Null
    foreach ($item in $items) {
        if ($item -eq '.claude-plugin' -and -not $claudeDeclared) { continue }
        $source = Join-Path $layer.root $item
        if (-not (Test-Path -LiteralPath $source)) { throw "Plugin layer '$($layer.name)' is missing: $source" }
        $destination = Join-Path $target $item
        if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
        Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
    }
    $staleManifest = Join-Path $target '.claude-plugin'
    if (-not $claudeDeclared -and (Test-Path -LiteralPath $staleManifest)) {
        Remove-Item -LiteralPath $staleManifest -Recurse -Force
        Write-Host "Removed the stale Claude manifest from $target"
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

# A stale plugin folder goes only when the previous lock recorded it as a layer target,
# so the installer made it. Any other folder is reported and left in place.
foreach ($entry in Get-StalePluginFolders -Wanted $wantedTargets) {
    if ($priorTargets -contains $entry.Name) {
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
            [IO.Directory]::Delete($entry.FullName, $false)
        } else {
            Remove-Item -LiteralPath $entry.FullName -Recurse -Force
        }
        Write-Host "Removed the stale plugin folder $($entry.FullName)"
    } else {
        Write-Host ("Drift:          {0}: stale, kept because the previous stack.lock.json does not record it" -f $entry.FullName)
    }
}

# Build the Claude children. A local child is a junction to the installed copy; a
# git child is a copy of the pinned plugin folder.
New-Item -ItemType Directory -Path $claudePluginsTarget -Force | Out-Null
foreach ($record in $claudeRecords) {
    $child = Join-Path $claudePluginsTarget $record.plugin
    if ($record.kind -eq 'junction') {
        $target = Join-Path $Workspace ".opencode\plugins\$($record.target)"
        if (-not (Test-ClaudeJunction -Child $child -Target $target)) {
            Remove-ClaudeChild $child
            New-Item -ItemType Junction -Path $child -Target $target | Out-Null
            Write-Host "Linked Claude plugin '$($record.plugin)' to $target"
        }
    } else {
        Remove-ClaudeChild $child
        $source = Join-Path $gitCaches[$record.plugin] ($record.path -replace '/', '\')
        Copy-Item -LiteralPath $source -Destination $child -Recurse -Force
        Write-Host "Copied Claude plugin '$($record.plugin)' from $($record.url) at $($record.commit)"
    }
    $declared = Get-Field (Get-Content -LiteralPath (Join-Path $child '.claude-plugin\plugin.json') -Raw | ConvertFrom-Json) 'name'
    if ($declared -ne $record.plugin) {
        throw "Claude plugin '$($record.plugin)' materialised at $child names '$declared' in its manifest."
    }
}
if (Test-Path -LiteralPath $claudePluginsTarget -PathType Container) {
    $wanted = @($claudeRecords | ForEach-Object { $_.plugin })
    foreach ($entry in Get-ChildItem -LiteralPath $claudePluginsTarget -Force) {
        if ($wanted -notcontains $entry.Name) {
            Remove-ClaudeChild $entry.FullName
            Write-Host "Removed the stale Claude plugin $($entry.Name)"
        }
    }
}

$claudeByLayer = @{}
foreach ($record in $claudeRecords) { $claudeByLayer[$record.layer] = $record }
$layerRecords = foreach ($layer in $layers) {
    $head = (& git -C $layer.root rev-parse HEAD 2>$null)
    $record = $claudeByLayer[$layer.name]
    if ($record) {
        $child = Join-Path $claudePluginsTarget $record.plugin
        $relativeChild = ".claude/plugins/$($record.plugin)"
        $treeSha = Get-TreeSha256 $child
        if ($record.kind -eq 'junction') {
            $claude = [pscustomobject]@{
                enabled    = $true
                plugin     = $record.plugin
                kind       = 'junction'
                child      = $relativeChild
                target     = ".opencode/plugins/$($record.target)"
                treeSha256 = $treeSha
            }
        } else {
            $claude = [pscustomobject]@{
                enabled    = $true
                plugin     = $record.plugin
                kind       = 'git'
                child      = $relativeChild
                repository = $record.url
                path       = $record.path
                commit     = $record.commit
                treeSha256 = $treeSha
            }
        }
    } else {
        $claude = [pscustomobject]@{ enabled = $false }
    }
    [pscustomobject]@{
        name         = $layer.name
        kind         = $layer.kind
        path         = $layer.path
        pluginTarget = Get-Field $layer 'pluginTarget'
        source       = $layer.source
        commit       = $(if ($head) { $head.Trim() } else { $null })
        claude       = $claude
    }
}
$stack = [pscustomobject]@{
    generatedAt  = (Get-Date).ToUniversalTime().ToString('o')
    workspace    = $workspaceName
    primaryModel = $primary
    configSha256 = Get-TextSha256 $document
    layers       = $layerRecords
}
[IO.File]::WriteAllText($stackTarget, ($stack | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Wrote $stackTarget"

Write-Host 'Workspace bundle installed from the layer manifest.'
Write-Host 'Start a new T3 session to load it. OpenCode and Claude Code read the plugins when a session starts.'
