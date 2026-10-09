# platforms: windows
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string] $Workspace = 'D:\dev\simpsonm09',
    [string] $LayersFile = '',
    [string[]] $LayerSource = @(),
    # The Copilot CLI to wrap: a command name on PATH, or a path. A match inside .maxstack\bin is never used.
    [string] $CopilotCommand = 'copilot',
    # The Pi CLI to wrap, by the same rule as CopilotCommand.
    [string] $PiCommand = 'pi',
    [switch] $Apply
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$layersPath = if ($LayersFile) { $LayersFile } else { Join-Path $repoRoot 'layers.json' }
$baseConfigFile = Join-Path $repoRoot 'workspace\opencode.jsonc'
$configTarget = Join-Path $Workspace 'opencode.jsonc'
$stackTarget = Join-Path $Workspace 'stack.lock.json'
$agentsTarget = Join-Path $Workspace '.opencode\agents'
$opencodePluginsTarget = Join-Path $Workspace '.opencode\plugins'
$claudePluginsTarget = Join-Path $Workspace '.claude\plugins'
$claudeCacheTarget = Join-Path $Workspace '.claude\cache'
$copilotBinTarget = Join-Path $Workspace '.maxstack\bin'
$copilotCmdTarget = Join-Path $copilotBinTarget 'copilot.cmd'
$copilotShTarget = Join-Path $copilotBinTarget 'copilot.sh'
# The Pi wrappers share .maxstack\bin. They name the agent folder, where Pi reads its settings.
$piCmdTarget = Join-Path $copilotBinTarget 'pi.cmd'
$piShTarget = Join-Path $copilotBinTarget 'pi.sh'
$piAgentDir = Join-Path $Workspace '.pi\agent'
$piSettingsTarget = Join-Path $piAgentDir 'settings.json'
$runtimeNames = @('claude', 'opencode', 'copilot', 'pi')
# The OpenCode port this repository used to pin. Its folder is removed on every apply,
# so a workspace that still has it ends with the same tree as one that never did.
$retiredOpenCodeFolders = @('pstack-opencode')

# maxstack sets no model. An installed profile keeps no model line, so the session's
# model applies; the copy from the plugin source is stripped if it carries one.
function Remove-AgentModel {
    param([string] $Path)

    $text = [IO.File]::ReadAllText($Path).Replace("`r`n", "`n")
    $frontmatter = [regex]::Match($text, '(?s)\A---\n.*?\n---\n')
    if (-not $frontmatter.Success) { return }
    $stripped = [regex]::Replace($frontmatter.Value, '(?m)^model:.*\n', '')
    $text = $stripped + $text.Substring($frontmatter.Length)
    [IO.File]::WriteAllText($Path, $text, (New-Object System.Text.UTF8Encoding($false)))
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

function Test-RelativePath {
    param($Value)

    return ((Test-NonEmptyString $Value) -and -not [IO.Path]::IsPathRooted($Value) -and $Value -notmatch '(^|[\\/])\.\.([\\/]|$)')
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

function Read-LayerJson {
    param([string] $Root)

    $layerJson = Join-Path $Root 'layer.json'
    if (-not (Test-Path -LiteralPath $layerJson -PathType Leaf)) { return $null }
    return (Get-Content -LiteralPath $layerJson -Raw | ConvertFrom-Json)
}

# Turns one layers.json entry into the record the rest of the installer reads. A
# string source is a local checkout at path; an object source is a git pin.
function New-LayerModel {
    param($Raw)

    $name = Get-Field $Raw 'name'
    if (-not (Test-NonEmptyString $name) -or $name -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]*$') {
        throw "Layer name '$name' must be a non-empty folder-safe name."
    }
    $kind = Get-Field $Raw 'kind'
    if ($kind -notin @('plugin', 'config')) { throw "Layer '$name' kind must be plugin or config." }

    $runtimes = @{}
    $runtimeBlock = Get-Field $Raw 'runtimes'
    if ($null -ne $runtimeBlock) {
        foreach ($property in $runtimeBlock.PSObject.Properties) {
            if ($property.Name -notin $runtimeNames) { throw "Layer '$name' names an unknown runtime '$($property.Name)'." }
            $runtimes[$property.Name] = $property.Value
        }
    }

    $source = Get-Field $Raw 'source'
    $path = $null
    $url = $null
    $sourcePath = $null
    $commit = $null
    if ($source -is [string]) {
        $path = Get-Field $Raw 'path'
        if (-not (Test-RelativePath $path)) { throw "Layer '$name' needs a relative checkout path." }
        $sourceText = $source
    } elseif ($null -ne $source) {
        if ($kind -ne 'plugin') { throw "Layer '$name' is pinned to a git source, so its kind must be plugin." }
        $url = Get-Field $source 'url'
        $sourcePath = Get-Field $source 'path'
        $commit = Get-Field $source 'commit'
        if (-not (Test-NonEmptyString $url)) { throw "Layer '$name' source needs a url." }
        if (-not (Test-RelativePath $sourcePath)) { throw "Layer '$name' source.path must be a relative path inside the repository." }
        if (-not (Test-NonEmptyString $commit) -or $commit -cnotmatch '^[0-9a-f]{40}$') {
            throw "Layer '$name' source.commit must be a 40-character lowercase commit SHA."
        }
        $sourceText = $url
    } else {
        throw "Layer '$name' needs a source."
    }

    if ($runtimes.ContainsKey('copilot') -and -not $runtimes.ContainsKey('claude')) {
        throw "Layer '$name' declares copilot, which loads the Claude plugin folder, so it also needs claude."
    }
    if ($runtimes.ContainsKey('pi') -and -not $runtimes.ContainsKey('claude')) {
        throw "Layer '$name' declares pi, which lists the Claude plugin folder's skills, so it also needs claude."
    }
    if ($runtimes.ContainsKey('claude') -and $null -ne $path -and -not $runtimes.ContainsKey('opencode')) {
        throw "Layer '$name' declares claude from a local checkout, which links to its OpenCode copy, so it also needs opencode."
    }

    return [pscustomobject]@{
        name       = $name
        kind       = $kind
        path       = $path
        url        = $url
        sourcePath = $sourcePath
        commit     = $commit
        source     = $sourceText
        runtimes   = $runtimes
        root       = $null
    }
}

# Where OpenCode finds the entry. A plugin folder's index.ts loads from the folder itself.
# Any other entry is named in opencode.jsonc, which takes a folder that holds the entry.
function Get-OpenCodeSpec {
    param($Layer)

    $runtime = $Layer.runtimes['opencode']
    $entry = Get-Field $runtime 'entry'
    if ($null -eq $entry) { $entry = 'index.ts' }
    if (-not (Test-RelativePath $entry) -or $entry -notmatch '\.(ts|js)$') {
        throw "Layer '$($Layer.name)' opencode.entry must be a relative .ts or .js file."
    }
    $entry = $entry.Replace('\', '/')
    $slash = $entry.LastIndexOf('/')
    $dir = if ($slash -lt 0) { '' } else { $entry.Substring(0, $slash) }
    if ($dir -eq '' -and $entry -ne 'index.ts') {
        throw "Layer '$($Layer.name)' has the root entry $entry. Only index.ts loads from the plugin folder itself; put other entries in a subfolder."
    }
    $agents = Get-Field $runtime 'agents'
    if ($null -ne $agents -and -not (Test-RelativePath $agents)) {
        throw "Layer '$($Layer.name)' opencode.agents must be a relative folder."
    }
    return [pscustomobject]@{
        entry  = $entry
        dir    = $dir
        loader = $(if ($dir -eq '') { 'discovery' } else { 'config' })
        agents = $agents
    }
}

# The items copied into the installed plugin folder. A layer names them under
# runtimes.opencode.files, or in its layer.json files list.
function Get-OpenCodeItems {
    param($Layer)

    $files = Get-Field $Layer.runtimes['opencode'] 'files'
    if ($null -eq $files) { $files = Get-Field (Read-LayerJson $Layer.root) 'files' }
    if ($null -eq $files -or @($files).Count -eq 0) {
        throw "Layer '$($Layer.name)' names no OpenCode files: set runtimes.opencode.files, or add a layer.json with files."
    }
    return @($files)
}

# The entry path opencode.jsonc names for a nested entry, relative to the config file.
# A root index.ts loads from its folder without a config entry, so it has none.
function Get-OpenCodePluginPath {
    param($Layer, $Spec)

    if ($Spec.loader -ne 'config') { return $null }
    return "./.opencode/plugins/$($Layer.name)/$($Spec.dir)"
}

# Whether an installed OpenCode folder is missing, or matches what the last apply
# recorded. Audit uses it, so it never writes.
function Get-OpenCodeState {
    param([string] $EntryPath, $Prior, [string] $Entry, $Plugin)

    if (-not (Test-Path -LiteralPath $EntryPath -PathType Leaf)) { return 'missing' }
    if ($null -eq $Prior -or (Get-Field $Prior 'entry') -ne $Entry -or (Get-Field $Prior 'plugin') -ne $Plugin) { return 'differs' }
    return 'matches'
}

# Turns one layer's claude runtime into a record. A local layer is a junction under
# .claude\plugins to its installed copy in .opencode\plugins, so both harnesses share
# one copy. A git layer is a copy of its pinned folder.
function Get-ClaudeRecord {
    param($Layer)

    if (-not $Layer.runtimes.ContainsKey('claude')) { return $null }
    if ($null -ne $Layer.url) {
        return [pscustomobject]@{ layer = $Layer.name; plugin = $Layer.name; kind = 'git'; url = $Layer.url; path = $Layer.sourcePath; commit = $Layer.commit }
    }

    $manifestPath = Join-Path $Layer.root '.claude-plugin\plugin.json'
    if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
        throw "Layer '$($Layer.name)' has a claude runtime but no .claude-plugin\plugin.json at $($Layer.root). Add the manifest to that repository or remove its claude runtime."
    }
    $declared = Get-Field (Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json) 'name'
    if ($declared -ne $Layer.name) {
        throw "Layer '$($Layer.name)' is the Claude plugin '$($Layer.name)' but its .claude-plugin\plugin.json names '$declared'."
    }
    if (@(Get-OpenCodeItems $Layer) -notcontains '.claude-plugin') {
        throw "Layer '$($Layer.name)' has a claude runtime but its file list omits .claude-plugin, so the installed copy would not carry the manifest."
    }
    return [pscustomobject]@{ layer = $Layer.name; plugin = $Layer.name; kind = 'junction'; target = ".opencode/plugins/$($Layer.name)" }
}

function Get-NormalPath {
    param([string] $Path)

    return [IO.Path]::GetFullPath($Path).TrimEnd('\').ToLowerInvariant()
}

# The folders directly under .opencode\plugins that no current layer names.
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

# Brings the layer's cache to the pinned commit and returns the cache path. The cache
# is named for the layer, and its origin is set to the layer's url on every sync, so a
# cache cloned from another remote is never fetched from. A partial, sparse clone keeps
# only the plugin folder. Once the commit is in the cache, no network is used.
function Sync-GitPlugin {
    param($Layer)

    $cache = Join-Path $claudeCacheTarget $Layer.name
    if (-not (Test-Path -LiteralPath (Join-Path $cache '.git'))) {
        New-Item -ItemType Directory -Path $claudeCacheTarget -Force | Out-Null
        Write-Host "Cloning $($Layer.url) (partial, sparse) into $cache"
        & git clone --quiet --filter=blob:none --no-checkout --sparse $Layer.url $cache
        if ($LASTEXITCODE -ne 0) { throw "git clone of $($Layer.url) failed for '$($Layer.name)'." }
        & git -C $cache config core.autocrlf false
        & git -C $cache config core.eol lf
    }
    & git -C $cache remote set-url origin $Layer.url
    & git -C $cache sparse-checkout set $Layer.sourcePath
    if ($LASTEXITCODE -ne 0) { throw "git sparse-checkout of $($Layer.sourcePath) failed in $cache." }

    & git -C $cache cat-file -e "$($Layer.commit)^{commit}" 2>$null
    if ($LASTEXITCODE -ne 0) {
        & git -C $cache fetch --quiet --filter=blob:none origin $Layer.commit
        if ($LASTEXITCODE -ne 0) {
            throw "Could not fetch the pinned commit $($Layer.commit) from $($Layer.url) for '$($Layer.name)'. Check source.commit in layers.json."
        }
    }
    & git -C $cache -c advice.detachedHead=false checkout --quiet --detach $Layer.commit
    if ($LASTEXITCODE -ne 0) { throw "git checkout of $($Layer.commit) failed in $cache." }
    $head = (& git -C $cache rev-parse HEAD).Trim()
    if ($head -ne $Layer.commit) { throw "The cache is at $head, not the pinned $($Layer.commit) for '$($Layer.name)'." }
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

# Whether a wrapper can run a path. On Windows that is an .exe, .cmd, or .bat. Elsewhere a
# file has no extension to show it, so anything but a PowerShell or cmd script is a candidate.
# Get-Command finds only executable files off Windows, so a plain file with no mode bit is
# already left out. The platform is a parameter so both rules can be tested on any host.
function Test-WrapperTarget {
    param([string] $Path, [bool] $Windows)

    $extension = [IO.Path]::GetExtension($Path)
    if ($Windows) { return $extension -in @('.exe', '.cmd', '.bat') }
    return $extension -notin @('.ps1', '.cmd', '.bat')
}

# The first application named $Name that a wrapper can run, outside .maxstack\bin, so a
# generated wrapper can never wrap itself.
function Find-WrappedExecutable {
    param([string] $Name)

    $binPrefix = (Get-NormalPath $copilotBinTarget) + '\'
    $candidates = @(Get-Command -Name $Name -All -CommandType Application -ErrorAction SilentlyContinue)
    foreach ($candidate in $candidates) {
        if (-not $candidate.Source) { continue }
        if (-not (Test-WrapperTarget -Path $candidate.Source -Windows $IsWindows)) { continue }
        if ((Get-NormalPath $candidate.Source).StartsWith($binPrefix)) { continue }
        return $candidate.Source
    }
    return $null
}

# T3 spawns binaryPath directly, so a .sh wrapper must carry the executable bit off Windows.
# Windows has no mode bits to set, and the call is skipped there.
function Set-ShellExecutable {
    param([string] $Path)

    if ($IsWindows) { return }
    $mode = [IO.UnixFileMode]::UserRead -bor [IO.UnixFileMode]::UserWrite -bor [IO.UnixFileMode]::UserExecute `
        -bor [IO.UnixFileMode]::GroupRead -bor [IO.UnixFileMode]::GroupExecute `
        -bor [IO.UnixFileMode]::OtherRead -bor [IO.UnixFileMode]::OtherExecute
    [IO.File]::SetUnixFileMode($Path, $mode)
}

function Assert-QuotablePath {
    param([string[]] $Paths)

    foreach ($path in $Paths) {
        if ($path -match '["%\r\n]') { throw "Path '$path' holds a quote, a percent sign, or a line break, which the Copilot wrapper cannot quote." }
    }
}

# The Windows wrapper. A .cmd or .bat executable must run through call, or cmd.exe
# would end this script after it returns.
function New-CopilotCmdText {
    param([string] $Executable, [string[]] $PluginDirs)

    Assert-QuotablePath (@($Executable) + @($PluginDirs))
    $plugins = @($PluginDirs | ForEach-Object { " --plugin-dir ""$_""" }) -join ''
    $invoke = if ([IO.Path]::GetExtension($Executable) -in @('.cmd', '.bat')) { 'call ' } else { '' }
    $lines = @(
        '@echo off',
        'rem Generated by scripts\Install-Workspace.ps1. Rerun the installer instead of editing this file.',
        'rem Starts the GitHub Copilot CLI with the workspace plugin folders, in layer order.',
        'rem T3 has no one to answer a hook confirmation, so the org gate ask is allowed here.',
        'rem Denials and the repo access level still apply. A plain copilot keeps the prompt.',
        'set "AGENT_ACCESS_COPILOT_ASK=allow"',
        "$invoke""$Executable""$plugins %*"
    )
    return (($lines -join "`r`n") + "`r`n")
}

# The POSIX wrapper. It runs the copilot that PATH finds, with the same plugin folders,
# using forward slashes so Git Bash passes them to the Windows executable as written.
function New-CopilotShText {
    param([string[]] $PluginDirs)

    Assert-QuotablePath $PluginDirs
    $plugins = @($PluginDirs | ForEach-Object { ' --plugin-dir "' + ($_ -replace '\\', '/') + '"' }) -join ''
    $lines = @(
        '#!/bin/sh',
        '# Generated by scripts/Install-Workspace.ps1. Rerun the installer instead of editing this file.',
        '# Starts the GitHub Copilot CLI with the workspace plugin folders, in layer order. See copilot.cmd.',
        'export AGENT_ACCESS_COPILOT_ASK=allow',
        'command -v copilot >/dev/null 2>&1 || { echo "copilot is not on PATH" >&2; exit 127; }',
        ('exec copilot' + $plugins + ' "$@"')
    )
    return (($lines -join "`n") + "`n")
}

# The Windows Pi wrapper. It sets the workspace agent folder, so Pi's settings there load the
# layers, and runs the Pi CLI found at install time. MAXSTACK_PI_BIN names another at run time.
function New-PiCmdText {
    param([string] $Executable, [string] $AgentDir)

    Assert-QuotablePath @($Executable, $AgentDir)
    $lines = @(
        '@echo off',
        'rem Generated by scripts\Install-Workspace.ps1. Rerun the installer instead of editing this file.',
        'rem Starts Pi with the workspace agent folder, so its settings load the pstack, org, and personal layers.',
        'rem T3 has no one to answer a hook confirmation, so the org gate ask is allowed here.',
        'rem Denials and the repo access level still apply. A plain pi keeps the prompt.',
        ('set "PI_CODING_AGENT_DIR={0}"' -f $AgentDir),
        'set "AGENT_ACCESS_PI_ASK=allow"',
        ('set "PI_BIN={0}"' -f $Executable),
        'if defined MAXSTACK_PI_BIN set "PI_BIN=%MAXSTACK_PI_BIN%"',
        'for %%F in ("%PI_BIN%") do set "PI_EXT=%%~xF"',
        'if /i "%PI_EXT%"==".cmd" goto call_pi',
        'if /i "%PI_EXT%"==".bat" goto call_pi',
        '"%PI_BIN%" %*',
        'exit /b %ERRORLEVEL%',
        ':call_pi',
        'call "%PI_BIN%" %*'
    )
    return (($lines -join "`r`n") + "`r`n")
}

# The POSIX Pi wrapper. It runs the pi that PATH finds, unless MAXSTACK_PI_BIN names another.
function New-PiShText {
    param([string] $AgentDir)

    Assert-QuotablePath @($AgentDir)
    $lines = @(
        '#!/bin/sh',
        '# Generated by scripts/Install-Workspace.ps1. Rerun the installer instead of editing this file.',
        '# Starts Pi with the workspace agent folder, so its settings load the pstack, org, and personal layers. See pi.cmd.',
        ('export PI_CODING_AGENT_DIR="' + ($AgentDir -replace '\\', '/') + '"'),
        'export AGENT_ACCESS_PI_ASK=allow',
        'pi_bin="${MAXSTACK_PI_BIN:-$(command -v pi 2>/dev/null)}"',
        '[ -n "$pi_bin" ] || { echo "pi is not on PATH" >&2; exit 127; }',
        'exec "$pi_bin" "$@"'
    )
    return (($lines -join "`n") + "`n")
}

# A layer's Pi record. A pinned layer's package is the root of its cache, because a pi key
# names paths from the repository root, and that root also holds the package.json. A local
# layer's package is its installed Claude folder. The skills folder is the installed one.
# pending is set when a pinned layer's cache is not synced yet, which only audit sees.
function Get-PiLayerRecord {
    param($Layer)

    if (-not $Layer.runtimes.ContainsKey('pi')) { return $null }
    $pinned = $null -ne $Layer.url
    $sourceRoot = if ($pinned) { Join-Path $claudeCacheTarget $Layer.name } else { $Layer.root }
    $pluginSource = if ($pinned) { Join-Path $sourceRoot ($Layer.sourcePath -replace '/', '\') } else { $Layer.root }
    $manifest = Join-Path $sourceRoot 'package.json'
    $piKey = $null
    if (Test-Path -LiteralPath $manifest -PathType Leaf) {
        $piKey = Get-Field (Get-Content -LiteralPath $manifest -Raw | ConvertFrom-Json) 'pi'
    }
    $installed = ".claude/plugins/$($Layer.name)"
    return [pscustomobject]@{
        layer   = $Layer.name
        pi      = $piKey
        package = $(if ($null -ne $piKey) { if ($pinned) { ".claude/cache/$($Layer.name)" } else { $installed } } else { $null })
        skills  = $(if (Test-Path -LiteralPath (Join-Path $pluginSource 'skills') -PathType Container) { "$installed/skills" } else { $null })
        pending = [bool]($pinned -and -not (Test-Path -LiteralPath (Join-Path $sourceRoot '.git')))
    }
}

# Every path a pi key names must exist in the installed copy, or Pi would load less than the
# layer declares. A local layer that names pi files it does not list in its files fails here.
function Assert-PiKeyInstalled {
    param($Record)

    $installed = Join-Path $Workspace ($Record.package -replace '/', '\')
    foreach ($kind in @('extensions', 'skills', 'prompts', 'themes')) {
        foreach ($entry in @(Get-Field $Record.pi $kind)) {
            if (-not (Test-NonEmptyString $entry)) { continue }
            if (-not (Test-Path -LiteralPath (Join-Path $installed ($entry -replace '/', '\')))) {
                throw "Layer '$($Record.layer)' names the $kind entry $entry in its package.json pi key, but $installed does not carry it. Add the folder to the layer's files list."
            }
        }
    }
}

# The canonical text of one Pi entry, so a string or an object compares by what it says.
function Get-PiEntryKey {
    param($Entry)

    return (ConvertTo-Json -InputObject $Entry -Compress -Depth 20)
}

# One Pi list: every current entry except the ones the installer wrote last time, in order,
# then each wanted entry the list does not already hold. Entries the user wrote are kept as
# they are, even when two are alike, because Pi reads each of them.
function Merge-PiEntries {
    param($Current, [string[]] $Wanted, $Owned)

    $ownedKeys = @{}
    foreach ($entry in @($Owned)) {
        if ($null -ne $entry) { $ownedKeys[(Get-PiEntryKey $entry)] = $true }
    }
    $merged = [System.Collections.Generic.List[object]]::new()
    $present = @{}
    foreach ($entry in @($Current)) {
        if ($null -eq $entry) { continue }
        $key = Get-PiEntryKey $entry
        if ($ownedKeys.ContainsKey($key)) { continue }
        $merged.Add($entry)
        $present[$key] = $true
    }
    foreach ($entry in $Wanted) {
        $key = Get-PiEntryKey $entry
        if ($present.ContainsKey($key)) { continue }
        $merged.Add($entry)
        $present[$key] = $true
    }
    return $merged.ToArray()
}

# The text of the workspace Pi settings. packages and skills are the only keys the installer
# owns; every other key, such as defaultProvider or defaultModel, is written back unchanged.
function Get-PiSettingsText {
    param([string[]] $Packages, [string[]] $Skills, $Prior)

    $settings = [ordered]@{}
    if (Test-Path -LiteralPath $piSettingsTarget -PathType Leaf) {
        $existing = Get-Content -LiteralPath $piSettingsTarget -Raw | ConvertFrom-Json
        if ($null -ne $existing) {
            foreach ($property in $existing.PSObject.Properties) { $settings[$property.Name] = $property.Value }
        }
    }
    # @() keeps a one-entry list an array; PowerShell would otherwise unroll it to a string.
    $settings['packages'] = @(Merge-PiEntries -Current $settings['packages'] -Wanted $Packages -Owned (Get-Field $Prior 'packages'))
    $settings['skills'] = @(Merge-PiEntries -Current $settings['skills'] -Wanted $Skills -Owned (Get-Field $Prior 'skills'))
    return (($settings | ConvertTo-Json -Depth 20) + "`n")
}

if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) {
    throw "Workspace not found: $Workspace"
}

$workspaceName = Split-Path -Leaf $Workspace.TrimEnd('\', '/')
if ([string]::IsNullOrWhiteSpace($workspaceName)) {
    throw "Could not derive a workspace name from: $Workspace"
}

$layerManifest = Get-Content -LiteralPath $layersPath -Raw | ConvertFrom-Json
$layers = @($layerManifest.layers | ForEach-Object { New-LayerModel $_ })
$layerNames = @($layers | ForEach-Object { $_.name })
if (@($layerNames | Select-Object -Unique).Count -ne $layerNames.Count) { throw 'layers.json names a layer twice.' }

# Each -LayerSource entry is name=path. Under pwsh -File, separate tokens do not bind
# to an array, so entries may also be comma-separated in one token.
$sourceOverrides = @{}
foreach ($entry in @($LayerSource | ForEach-Object { $_ -split ',' } | Where-Object { $_ })) {
    $overrideName, $overridePath = $entry -split '=', 2
    if (-not (Test-NonEmptyString $overridePath)) { throw "LayerSource expects name=path, got '$entry'." }
    $target = $layers | Where-Object { $_.name -eq $overrideName }
    if (-not $target) { throw "LayerSource names an unknown layer: $overrideName" }
    if ($null -eq $target.path) { throw "LayerSource applies to a local checkout, and $overrideName is pinned to a git source in layers.json." }
    $sourceOverrides[$overrideName] = $overridePath
}

foreach ($layer in $layers) {
    if ($null -eq $layer.path) { continue }
    $root = Join-Path $Workspace $layer.path
    if ($sourceOverrides.ContainsKey($layer.name)) { $root = $sourceOverrides[$layer.name] }
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
        throw "Layer '$($layer.name)' is not checked out at $root."
    }
    $layer.root = $root
}

# Git sources are synced before anything is written, so a bad pin stops the run with
# the workspace unchanged. Audit reads no git source; it reports what the last apply left.
if ($Apply) {
    foreach ($layer in @($layers | Where-Object { $null -ne $_.url })) {
        $cache = Sync-GitPlugin $layer
        $layer.root = Join-Path $cache ($layer.sourcePath -replace '/', '\')
        if (-not (Test-Path -LiteralPath $layer.root -PathType Container)) {
            throw "Layer '$($layer.name)' has no $($layer.sourcePath) folder at the pinned commit."
        }
    }
}

$claudeRecords = @($layers | ForEach-Object { Get-ClaudeRecord $_ } | Where-Object { $null -ne $_ })

$openCodeLayers = @($layers | Where-Object { $_.runtimes.ContainsKey('opencode') })
$openCodeSpecs = @{}
foreach ($layer in $openCodeLayers) { $openCodeSpecs[$layer.name] = Get-OpenCodeSpec $layer }

# The previous lock records what the last apply installed. Audit compares against it, and
# apply removes only the folders it recorded.
$priorLayers = @{}
$priorPi = $null
if (Test-Path -LiteralPath $stackTarget -PathType Leaf) {
    try {
        $priorStack = Get-Content -LiteralPath $stackTarget -Raw | ConvertFrom-Json
        foreach ($priorLayer in @($priorStack.layers)) {
            $priorLayers[$priorLayer.name] = $priorLayer
        }
        $priorPi = Get-Field $priorStack 'pi'
    } catch {
        Write-Warning "Could not read the previous $stackTarget; every Claude child and plugin folder will report as differs until the next apply."
    }
}
$priorOpenCodeFolders = @($priorLayers.Values | ForEach-Object { Get-Field (Get-Field $_ 'opencode') 'folder' } | Where-Object { $_ } | ForEach-Object { Split-Path -Leaf $_ })

$copilotLayers = @($layers | Where-Object { $_.runtimes.ContainsKey('copilot') })
$copilotDirs = @($copilotLayers | ForEach-Object { Join-Path $claudePluginsTarget $_.name })
$copilotExecutable = if ($copilotLayers.Count -gt 0) { Find-WrappedExecutable $CopilotCommand } else { $null }
$copilotCmdText = $null
$copilotShText = $null
if ($copilotExecutable) {
    $copilotCmdText = New-CopilotCmdText -Executable $copilotExecutable -PluginDirs $copilotDirs
    $copilotShText = New-CopilotShText -PluginDirs $copilotDirs
} elseif ($copilotLayers.Count -gt 0) {
    Write-Warning "Copilot CLI not found: no '$CopilotCommand' application outside .maxstack\bin. Skipping $copilotCmdTarget and $copilotShTarget. Install Copilot, then rerun with -Apply."
}

# Pi lists each layer's package when its package.json has a pi key, and each layer's skills
# folder. The settings and the lock's pi list hold those entries relative to the agent folder;
# each layer's lock record holds its folder relative to the workspace.
$piLayers = @($layers | Where-Object { $_.runtimes.ContainsKey('pi') })
$piRecords = @($piLayers | ForEach-Object { Get-PiLayerRecord $_ })
$piByLayer = @{}
foreach ($record in $piRecords) { $piByLayer[$record.layer] = $record }
$piPending = @($piRecords | Where-Object { $_.pending }).Count -gt 0
$piPackageEntries = @($piRecords | Where-Object { $_.package } | ForEach-Object { '../../' + $_.package })
$piSkillEntries = @($piRecords | Where-Object { $_.skills } | ForEach-Object { '../../' + $_.skills })
$piExecutable = if ($piLayers.Count -gt 0) { Find-WrappedExecutable $PiCommand } else { $null }
$piCmdText = $null
$piShText = $null
if ($piExecutable) {
    $piCmdText = New-PiCmdText -Executable $piExecutable -AgentDir $piAgentDir
    $piShText = New-PiShText -AgentDir $piAgentDir
} elseif ($piLayers.Count -gt 0) {
    Write-Warning "Pi CLI not found: no '$PiCommand' application outside .maxstack\bin. Skipping $piCmdTarget and $piShTarget. Install Pi, then rerun with -Apply."
}
$piSettingsText = $null
if ($piLayers.Count -gt 0 -or (Test-Path -LiteralPath $piSettingsTarget -PathType Leaf)) {
    $piSettingsText = Get-PiSettingsText -Packages $piPackageEntries -Skills $piSkillEntries -Prior $priorPi
}

$base = Get-Content -LiteralPath $baseConfigFile -Raw | ConvertFrom-Json
$serverMaps = @()
$extraPermissions = @()
foreach ($layer in $layers) {
    if ($layer.kind -ne 'config') { continue }
    $layerJson = Read-LayerJson $layer.root
    $fragmentName = Get-Field $layerJson 'config'
    $fragmentPath = Join-Path $layer.root $(if ($fragmentName) { $fragmentName } else { 'opencode.fragment.jsonc' })
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
# A nested entry point is named here, relative to this file, so the path holds no
# machine-specific root. Root-level index.ts entries load on their own and are not listed.
$pluginEntries = @($openCodeLayers | ForEach-Object { Get-OpenCodePluginPath -Layer $_ -Spec $openCodeSpecs[$_.name] } | Where-Object { $_ })
if ($pluginEntries.Count -gt 0) {
    $base | Add-Member -NotePropertyName plugin -NotePropertyValue $pluginEntries -Force
}
$document = ($base | ConvertTo-Json -Depth 100)

if (-not $Apply) {
    Write-Host "Workspace:      $Workspace"
    foreach ($layer in $layers) {
        $where = if ($layer.root) { $layer.root } else { "pinned $($layer.url) at $($layer.commit)" }
        Write-Host ("Layer:          {0} ({1}) at {2}" -f $layer.name, $layer.kind, $where)
    }
    Write-Host "Config target:  $configTarget"
    Write-Host ("Drift:          {0}: {1}" -f $configTarget, (Get-DriftState -Path $configTarget -Text $document))
    $wantedClaude = @($claudeRecords | ForEach-Object { $_.plugin })
    foreach ($record in $claudeRecords) {
        $child = Join-Path $claudePluginsTarget $record.plugin
        $target = if ($record.kind -eq 'junction') { Join-Path $Workspace $record.target } else { $null }
        $prior = Get-Field $priorLayers[$record.layer] 'claude'
        Write-Host ("Drift:          {0}: {1}" -f $child, (Get-ClaudeChildState -Record $record -Prior $prior -Child $child -Target $target))
    }
    if (Test-Path -LiteralPath $claudePluginsTarget -PathType Container) {
        foreach ($entry in Get-ChildItem -LiteralPath $claudePluginsTarget -Force) {
            if ($wantedClaude -notcontains $entry.Name) { Write-Host ("Drift:          {0}: stale" -f $entry.FullName) }
        }
    }
    foreach ($layer in $openCodeLayers) {
        $spec = $openCodeSpecs[$layer.name]
        $folder = Join-Path $opencodePluginsTarget $layer.name
        $entryPath = Join-Path $folder ($spec.entry -replace '/', '\')
        $prior = Get-Field $priorLayers[$layer.name] 'opencode'
        $plugin = Get-OpenCodePluginPath -Layer $layer -Spec $spec
        Write-Host ("Drift:          {0}: {1}" -f $folder, (Get-OpenCodeState -EntryPath $entryPath -Prior $prior -Entry $spec.entry -Plugin $plugin))
    }
    foreach ($entry in Get-StalePluginFolders -Wanted @($openCodeLayers | ForEach-Object { $_.name })) {
        Write-Host ("Drift:          {0}: stale" -f $entry.FullName)
    }
    if ($copilotCmdText) {
        Write-Host ("Drift:          {0}: {1}" -f $copilotCmdTarget, (Get-DriftState -Path $copilotCmdTarget -Text $copilotCmdText))
        Write-Host ("Drift:          {0}: {1}" -f $copilotShTarget, (Get-DriftState -Path $copilotShTarget -Text $copilotShText))
    } else {
        foreach ($path in @($copilotCmdTarget, $copilotShTarget)) {
            if (Test-Path -LiteralPath $path -PathType Leaf) { Write-Host ("Drift:          {0}: stale" -f $path) }
        }
    }
    if ($piCmdText) {
        Write-Host ("Drift:          {0}: {1}" -f $piCmdTarget, (Get-DriftState -Path $piCmdTarget -Text $piCmdText))
        Write-Host ("Drift:          {0}: {1}" -f $piShTarget, (Get-DriftState -Path $piShTarget -Text $piShText))
    } else {
        foreach ($path in @($piCmdTarget, $piShTarget)) {
            if (Test-Path -LiteralPath $path -PathType Leaf) { Write-Host ("Drift:          {0}: stale" -f $path) }
        }
    }
    if ($piPending) {
        Write-Host ("Drift:          {0}: unknown until -Apply syncs the pstack cache" -f $piSettingsTarget)
    } elseif ($piSettingsText) {
        Write-Host ("Drift:          {0}: {1}" -f $piSettingsTarget, (Get-DriftState -Path $piSettingsTarget -Text $piSettingsText))
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

# Each OpenCode layer gets its own folder under .opencode\plugins, holding the items the
# layer names. The entry's own folder is the npm install point, so its SDK resolves there.
$agentNamesByLayer = @{}
foreach ($layer in $openCodeLayers) {
    $spec = $openCodeSpecs[$layer.name]
    $claudeDeclared = $layer.runtimes.ContainsKey('claude')
    $folder = Join-Path $opencodePluginsTarget $layer.name
    New-Item -ItemType Directory -Path $folder -Force | Out-Null
    foreach ($item in (Get-OpenCodeItems $layer)) {
        if ($item -eq '.claude-plugin' -and -not $claudeDeclared) { continue }
        $source = Join-Path $layer.root $item
        if (-not (Test-Path -LiteralPath $source)) { throw "Plugin layer '$($layer.name)' is missing: $source" }
        $destination = Join-Path $folder $item
        if (Test-Path -LiteralPath $destination) { Remove-Item -LiteralPath $destination -Recurse -Force }
        Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
    }
    $staleManifest = Join-Path $folder '.claude-plugin'
    if (-not $claudeDeclared -and (Test-Path -LiteralPath $staleManifest)) {
        Remove-Item -LiteralPath $staleManifest -Recurse -Force
        Write-Host "Removed the stale Claude manifest from $folder"
    }
    $entryPath = Join-Path $folder ($spec.entry -replace '/', '\')
    if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) {
        throw "Plugin layer '$($layer.name)' has no entry at $entryPath. Check runtimes.opencode.entry in layers.json."
    }
    Write-Host "Copied plugin layer '$($layer.name)' into $folder"

    $installDir = if ($spec.dir -eq '') { $folder } else { Join-Path $folder ($spec.dir -replace '/', '\') }
    if ((Test-Path -LiteralPath (Join-Path $installDir 'package.json') -PathType Leaf) -and -not (Test-Path -LiteralPath (Join-Path $installDir 'node_modules\@opencode\plugin'))) {
        Write-Host 'Installing plugin dependencies'
        & npm install --prefix $installDir --omit=dev --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw "npm install failed in $installDir" }
    }

    $agentNamesByLayer[$layer.name] = @()
    if ($spec.agents) {
        $agentsSource = Join-Path $layer.root ($spec.agents -replace '/', '\')
        if (-not (Test-Path -LiteralPath $agentsSource -PathType Container)) {
            throw "Plugin layer '$($layer.name)' names agents at $agentsSource, which does not exist."
        }
        New-Item -ItemType Directory -Path $agentsTarget -Force | Out-Null
        foreach ($agent in @(Get-ChildItem -LiteralPath $agentsSource -Filter '*.md')) {
            $destination = Join-Path $agentsTarget $agent.Name
            Copy-Item -LiteralPath $agent.FullName -Destination $destination -Force
            Remove-AgentModel -Path $destination
            Write-Host "Installed agent profile $($agent.Name)"
            $agentNamesByLayer[$layer.name] += $agent.Name
        }
    }
}

# A folder under .opencode\plugins that no layer names goes when the previous lock
# recorded it, or when it is the retired port's folder. Any other folder is kept.
foreach ($entry in Get-StalePluginFolders -Wanted @($openCodeLayers | ForEach-Object { $_.name })) {
    if (($priorOpenCodeFolders -contains $entry.Name) -or ($retiredOpenCodeFolders -contains $entry.Name)) {
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
$layerByName = @{}
foreach ($layer in $layers) { $layerByName[$layer.name] = $layer }
New-Item -ItemType Directory -Path $claudePluginsTarget -Force | Out-Null
foreach ($record in $claudeRecords) {
    $child = Join-Path $claudePluginsTarget $record.plugin
    if ($record.kind -eq 'junction') {
        $target = Join-Path $Workspace $record.target
        if (-not (Test-ClaudeJunction -Child $child -Target $target)) {
            Remove-ClaudeChild $child
            New-Item -ItemType Junction -Path $child -Target $target | Out-Null
            Write-Host "Linked Claude plugin '$($record.plugin)' to $target"
        }
    } else {
        Remove-ClaudeChild $child
        Copy-Item -LiteralPath $layerByName[$record.layer].root -Destination $child -Recurse -Force
        Write-Host "Copied Claude plugin '$($record.plugin)' from $($record.url) at $($record.commit)"
    }
    $declared = Get-Field (Get-Content -LiteralPath (Join-Path $child '.claude-plugin\plugin.json') -Raw | ConvertFrom-Json) 'name'
    if ($declared -ne $record.plugin) {
        throw "Claude plugin '$($record.plugin)' materialised at $child names '$declared' in its manifest."
    }
}
if (Test-Path -LiteralPath $claudePluginsTarget -PathType Container) {
    $wantedClaude = @($claudeRecords | ForEach-Object { $_.plugin })
    foreach ($entry in Get-ChildItem -LiteralPath $claudePluginsTarget -Force) {
        if ($wantedClaude -notcontains $entry.Name) {
            Remove-ClaudeChild $entry.FullName
            Write-Host "Removed the stale Claude plugin $($entry.Name)"
        }
    }
}

# The Copilot wrappers run the Claude folders above, so they are written last.
if ($copilotCmdText) {
    New-Item -ItemType Directory -Path $copilotBinTarget -Force | Out-Null
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($copilotCmdTarget, $copilotCmdText, $utf8)
    [IO.File]::WriteAllText($copilotShTarget, $copilotShText, $utf8)
    Set-ShellExecutable $copilotShTarget
    Write-Host "Wrote $copilotCmdTarget and $copilotShTarget"
} else {
    foreach ($path in @($copilotCmdTarget, $copilotShTarget)) {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Remove-Item -LiteralPath $path -Force
            Write-Host "Removed the stale Copilot wrapper $path"
        }
    }
}

# The Pi settings and wrappers come after the Claude folders, so every package and skills folder
# they name is installed when they are written.
foreach ($record in $piRecords) {
    if ($record.package) { Assert-PiKeyInstalled $record }
    if ($record.skills -and -not (Test-Path -LiteralPath (Join-Path $Workspace ($record.skills -replace '/', '\')) -PathType Container)) {
        throw "Layer '$($record.layer)' has no skills folder at $($record.skills) after the install. Check runtimes.pi and the layer's files list."
    }
}
if ($piSettingsText) {
    New-Item -ItemType Directory -Path $piAgentDir -Force | Out-Null
    if ((Test-Path -LiteralPath $piSettingsTarget -PathType Leaf) -and ((Get-Content -LiteralPath $piSettingsTarget -Raw).Trim() -eq $piSettingsText.Trim())) {
        Write-Host "Pi settings already match: $piSettingsTarget"
    } else {
        if (Test-Path -LiteralPath $piSettingsTarget -PathType Leaf) {
            Copy-Item -LiteralPath $piSettingsTarget -Destination "$piSettingsTarget.bak" -Force
            Write-Host "Backed up the previous Pi settings to $piSettingsTarget.bak"
        }
        [IO.File]::WriteAllText($piSettingsTarget, $piSettingsText, (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "Wrote $piSettingsTarget"
    }
}
if ($piCmdText) {
    New-Item -ItemType Directory -Path $copilotBinTarget -Force | Out-Null
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($piCmdTarget, $piCmdText, $utf8)
    [IO.File]::WriteAllText($piShTarget, $piShText, $utf8)
    Set-ShellExecutable $piShTarget
    Write-Host "Wrote $piCmdTarget and $piShTarget"
} else {
    foreach ($path in @($piCmdTarget, $piShTarget)) {
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Remove-Item -LiteralPath $path -Force
            Write-Host "Removed the stale Pi wrapper $path"
        }
    }
}

$claudeByLayer = @{}
foreach ($record in $claudeRecords) { $claudeByLayer[$record.layer] = $record }
$layerRecords = foreach ($layer in $layers) {
    $record = $claudeByLayer[$layer.name]
    if ($null -eq $layer.url) {
        $head = (& git -C $layer.root rev-parse HEAD 2>$null)
        $commit = if ($head) { $head.Trim() } else { $null }
    } else {
        $commit = $layer.commit
    }
    if ($record) {
        $child = Join-Path $claudePluginsTarget $record.plugin
        $treeSha = Get-TreeSha256 $child
        if ($record.kind -eq 'junction') {
            $claude = [pscustomobject]@{
                enabled    = $true
                plugin     = $record.plugin
                kind       = 'junction'
                child      = ".claude/plugins/$($record.plugin)"
                target     = $record.target
                treeSha256 = $treeSha
            }
        } else {
            $claude = [pscustomobject]@{
                enabled    = $true
                plugin     = $record.plugin
                kind       = 'git'
                child      = ".claude/plugins/$($record.plugin)"
                repository = $record.url
                path       = $record.path
                commit     = $record.commit
                treeSha256 = $treeSha
            }
        }
    } else {
        $claude = [pscustomobject]@{ enabled = $false }
    }

    if ($openCodeSpecs.ContainsKey($layer.name)) {
        $spec = $openCodeSpecs[$layer.name]
        $opencode = [pscustomobject]@{
            enabled = $true
            folder  = ".opencode/plugins/$($layer.name)"
            entry   = $spec.entry
            loader  = $spec.loader
            plugin  = Get-OpenCodePluginPath -Layer $layer -Spec $spec
            agents  = @($agentNamesByLayer[$layer.name])
        }
    } else {
        $opencode = [pscustomobject]@{ enabled = $false }
    }

    $copilotRecord = if ($layer.runtimes.ContainsKey('copilot')) {
        [pscustomobject]@{ enabled = $true; pluginDir = ".claude/plugins/$($layer.name)" }
    } else {
        [pscustomobject]@{ enabled = $false }
    }

    $piRecord = if ($piByLayer.ContainsKey($layer.name)) {
        [pscustomobject]@{ enabled = $true; package = $piByLayer[$layer.name].package; skills = $piByLayer[$layer.name].skills }
    } else {
        [pscustomobject]@{ enabled = $false }
    }

    [pscustomobject]@{
        name     = $layer.name
        kind     = $layer.kind
        path     = $layer.path
        source   = $layer.source
        commit   = $commit
        claude   = $claude
        opencode = $opencode
        copilot  = $copilotRecord
        pi       = $piRecord
    }
}

$copilotLock = if ($copilotCmdText) {
    [pscustomobject]@{
        enabled    = $true
        executable = [IO.Path]::GetFileName($copilotExecutable)
        wrappers   = @('.maxstack/bin/copilot.cmd', '.maxstack/bin/copilot.sh')
        cmdSha256  = Get-TextSha256 $copilotCmdText
        shSha256   = Get-TextSha256 $copilotShText
    }
} else {
    $reason = if ($copilotLayers.Count -eq 0) { 'no layer declares copilot' } else { "no '$CopilotCommand' application outside .maxstack\bin" }
    [pscustomobject]@{ enabled = $false; reason = $reason }
}

$piLock = if ($piCmdText) {
    [pscustomobject]@{
        enabled    = $true
        executable = [IO.Path]::GetFileName($piExecutable)
        wrappers   = @('.maxstack/bin/pi.cmd', '.maxstack/bin/pi.sh')
        cmdSha256  = Get-TextSha256 $piCmdText
        shSha256   = Get-TextSha256 $piShText
        agentDir   = '.pi/agent'
        packages   = @($piPackageEntries)
        skills     = @($piSkillEntries)
    }
} else {
    $reason = if ($piLayers.Count -eq 0) { 'no layer declares pi' } else { "no '$PiCommand' application outside .maxstack\bin" }
    [pscustomobject]@{
        enabled  = $false
        reason   = $reason
        agentDir = '.pi/agent'
        packages = @($piPackageEntries)
        skills   = @($piSkillEntries)
    }
}

$stack = [pscustomobject]@{
    generatedAt  = (Get-Date).ToUniversalTime().ToString('o')
    workspace    = $workspaceName
    configSha256 = Get-TextSha256 $document
    copilot      = $copilotLock
    pi           = $piLock
    layers       = $layerRecords
}
[IO.File]::WriteAllText($stackTarget, ($stack | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Wrote $stackTarget"

Write-Host 'Workspace bundle installed from the layer manifest.'
Write-Host 'Restart the running OpenCode server, then start a new T3 session to load it: T3 can reuse that server across sessions. Claude Code reads plugins when a session starts. Pi reads its settings when a session starts.'
