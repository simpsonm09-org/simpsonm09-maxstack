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
    [switch] $Apply,
    # Reports each owned path against the ownership record in stack.lock.json. Writes nothing.
    [switch] $Status,
    # With -Status, exits 1 when a path is not matching, or when the workspace has no record.
    [switch] $Strict
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Apply -and $Status) { throw '-Apply writes the workspace and -Status only reports it. Choose one.' }
if ($Strict -and -not $Status) { throw '-Strict applies to -Status.' }

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
# The version of the owned list in stack.lock.json. A reader checks it before it reads owned.
$ownedSchemaVersion = 1

# The text an installed profile holds once its model line is removed, or $null when the profile
# has no frontmatter, which leaves the copy as it is.
function Get-AgentProfileText {
    param([string] $Path)

    $text = [IO.File]::ReadAllText($Path).Replace("`r`n", "`n")
    $frontmatter = [regex]::Match($text, '(?s)\A---\n.*?\n---\n')
    if (-not $frontmatter.Success) { return $null }
    $stripped = [regex]::Replace($frontmatter.Value, '(?m)^model:.*\n', '')
    return $stripped + $text.Substring($frontmatter.Length)
}

# maxstack sets no model. An installed profile keeps no model line, so the session's
# model applies; the copy from the plugin source is stripped if it carries one.
function Remove-AgentModel {
    param([string] $Path)

    $text = Get-AgentProfileText $Path
    if ($null -eq $text) { return }
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
    param($Layer, [string] $Root)

    $files = Get-Field $Layer.runtimes['opencode'] 'files'
    if ($null -eq $files) { $files = Get-Field (Read-LayerJson $Root) 'files' }
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
    if (@(Get-OpenCodeItems -Layer $Layer -Root $Layer.root) -notcontains '.claude-plugin') {
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

    Remove-OwnedTree $Path
}

# Whether a path is a junction or a symbolic link. The walk lists such a path and never reads
# what it points to.
function Test-ReparsePoint {
    param([string] $Path)

    return [bool]([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint)
}

# The target a link names, without the \?\ or \??\ prefix that the Windows API adds, so
# PowerShell and Python write the same text for one junction.
function Get-LinkTargetText {
    param([string] $Path)

    $text = [string] (@((Get-Item -LiteralPath $Path -Force).Target)[0])
    foreach ($prefix in @('\?\', '\??\')) {
        if ($text.StartsWith($prefix, [StringComparison]::Ordinal)) { $text = $text.Substring($prefix.Length) }
    }
    return $text.TrimEnd('\')
}

# The folders a tree hash leaves out, by the path relative to the tree root. The legacy rule is
# the one the claude tree hashes have always used: the top-level node_modules, matched without
# regard to case, because PowerShell's -ne did that. The owned rule leaves out node_modules and
# .git at any depth, exactly, because npm and git write those beside what the installer copies.
function Test-TreeFolderExcluded {
    param([string] $Relative, [string] $Rule)

    if ($Rule -eq 'legacy') { return ($Relative -imatch '^node_modules$') }
    return ($Relative -cmatch '(^|/)(node_modules|\.git)$')
}

# The entries of a tree, each with its path relative to the root in forward slashes. A link is
# listed with its target and never followed, so a junction cannot pull outside content in, and a
# junction that loops back cannot make the walk run forever. The root itself is read even when it
# is a link: a claude child is a junction to its installed copy.
function Get-TreeEntries {
    param([string] $Root, [string] $Rule)

    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $pending = [System.Collections.Generic.Stack[string]]::new()
    $pending.Push($rootFull)
    $entries = [System.Collections.Generic.List[object]]::new()
    while ($pending.Count -gt 0) {
        $directory = $pending.Pop()
        foreach ($child in [IO.Directory]::GetDirectories($directory)) {
            $relative = $child.Substring($rootFull.Length + 1).Replace('\', '/')
            if (Test-ReparsePoint $child) {
                $entries.Add([pscustomobject]@{ relative = $relative; full = $child; link = (Get-LinkTargetText $child) })
            } elseif (-not (Test-TreeFolderExcluded -Relative $relative -Rule $Rule)) {
                $pending.Push($child)
            }
        }
        foreach ($file in [IO.Directory]::GetFiles($directory)) {
            $relative = $file.Substring($rootFull.Length + 1).Replace('\', '/')
            if (Test-ReparsePoint $file) {
                $entries.Add([pscustomobject]@{ relative = $relative; full = $file; link = (Get-LinkTargetText $file) })
            } else {
                $entries.Add([pscustomobject]@{ relative = $relative; full = $file; link = $null })
            }
        }
    }
    return $entries.ToArray()
}

# One line per entry: the relative path, a tab, and the file's SHA-256, or the word link and the
# target for a link. Prefix puts the lines under a folder name, for an item copied into a folder.
function Get-EntryLines {
    param($Entries, [string] $Prefix = '')

    return @($Entries | ForEach-Object {
        $name = if ($Prefix) { "$Prefix/$($_.relative)" } else { $_.relative }
        if ($null -ne $_.link) { "$name`tlink:$($_.link)" } else { "$name`t$((Get-FileHash -LiteralPath $_.full -Algorithm SHA256).Hash)" }
    })
}

# Compares two strings by their UTF-8 bytes. That order is the code point order, so PowerShell and
# Python sort a name with any character the same way. A UTF-16 comparison would not.
function Compare-Utf8Bytes {
    param([string] $Left, [string] $Right)

    $a = [Text.Encoding]::UTF8.GetBytes($Left)
    $b = [Text.Encoding]::UTF8.GetBytes($Right)
    $count = [Math]::Min($a.Length, $b.Length)
    for ($i = 0; $i -lt $count; $i++) {
        if ($a[$i] -ne $b[$i]) { return ([int] $a[$i]) - ([int] $b[$i]) }
    }
    return $a.Length - $b.Length
}

# The one sort every list the installer writes or hashes uses.
function Sort-Utf8 {
    param([string[]] $Values)

    $list = [System.Collections.Generic.List[string]]::new()
    foreach ($value in @($Values)) { $list.Add($value) }
    $list.Sort([Comparison[string]] { param($left, $right) Compare-Utf8Bytes $left $right })
    return $list.ToArray()
}

# The hash of a tree from its lines: sorted, one line per entry, then the SHA-256 of that text.
function Get-TreeLinesSha256 {
    param([string[]] $Lines)

    return (Get-TextSha256 ((@(Sort-Utf8 $Lines) -join "`n") + "`n"))
}

# The owned hash of a folder: every entry under it, under the owned rule. A folder the installer
# owns is wholly its own, so each file a user adds to it changes this hash.
function Get-TreeSha256 {
    param([string] $Root)

    return (Get-TreeLinesSha256 (Get-EntryLines (Get-TreeEntries -Root $Root -Rule 'owned')))
}

# The legacy hash of a claude child, under the legacy rule. Lock values written before the owned
# record use it, so it stays the rule for treeSha256 in stack.lock.json.
function Get-LegacyTreeSha256 {
    param([string] $Root)

    return (Get-TreeLinesSha256 (Get-EntryLines (Get-TreeEntries -Root $Root -Rule 'legacy')))
}

# The owned hash a folder holds once the named items are copied from a layer root, so the status
# report can compare it without copying. $null when an item is missing from the root.
function Get-ItemsTreeSha256 {
    param([string] $Root, [string[]] $Items)

    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($item in $Items) {
        $name = $item.Replace('\', '/')
        if (Test-TreeFolderExcluded -Relative $name -Rule 'owned') { continue }
        $source = Join-Path $Root ($item -replace '/', '\')
        if (Test-Path -LiteralPath $source -PathType Leaf) {
            $lines.AddRange([string[]] (Get-EntryLines @([pscustomobject]@{ relative = $name; full = $source; link = $null })))
        } elseif (Test-Path -LiteralPath $source -PathType Container) {
            $lines.AddRange([string[]] (Get-EntryLines (Get-TreeEntries -Root $source -Rule 'owned') $name))
        } else {
            return $null
        }
    }
    return (Get-TreeLinesSha256 $lines.ToArray())
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
    # The cache holds exactly the pinned commit: a file the checkout does not track is removed, and printed.
    foreach ($line in @(& git -C $cache clean -ffdx)) { Write-Host "Cache $($Layer.name): $line" }
    return $cache
}

# Whether a pinned layer's cache is a checkout of the pinned commit. It reads only the local
# repository, so audit and status can tell whether the desired state is known without a fetch.
function Test-CacheAtPin {
    param($Layer)

    $cache = Join-Path $claudeCacheTarget $Layer.name
    if (-not (Test-Path -LiteralPath (Join-Path $cache '.git'))) { return $false }
    $head = & git -C $cache rev-parse HEAD 2>$null
    return ($LASTEXITCODE -eq 0 -and ([string] $head).Trim() -eq $Layer.commit)
}

# The folder a layer installs from: its checkout, or the pinned folder of its cache. $null when
# the cache is not at its pin yet, so the desired state cannot be known until an apply syncs it.
function Get-LayerRoot {
    param($Layer)

    if ($null -eq $Layer.url) { return $Layer.root }
    if (-not (Test-CacheAtPin $Layer)) { return $null }
    return (Join-Path (Join-Path $claudeCacheTarget $Layer.name) ($Layer.sourcePath -replace '/', '\'))
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
    if ((Get-Field $Prior 'treeSha256') -ne (Get-LegacyTreeSha256 $Child)) { return 'differs' }
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

# A path inside the double quotes of a POSIX script. A quote, a dollar sign, a backtick, or a
# line break (a backslash before a line break is one) would change what the shell runs. A
# percent sign is plain text to sh, so it is allowed.
function Assert-ShellPath {
    param([string[]] $Paths)

    foreach ($path in $Paths) {
        if ($path -match '["$`\r\n]') {
            throw "Path '$path' holds a double quote, a dollar sign, a backtick, or a line break, so the Pi shell wrapper cannot quote it."
        }
    }
}

# The POSIX Pi wrapper. It runs the pi that PATH finds, unless MAXSTACK_PI_BIN names another.
function New-PiShText {
    param([string] $AgentDir)

    Assert-ShellPath @($AgentDir)
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
        pending = [bool]($pinned -and -not (Test-CacheAtPin $Layer))
    }
}

# Every path a pi key names must exist in the installed copy, or Pi would load less than the
# layer declares. A local layer that names pi files it does not list in its files fails here.
function Assert-PiKeyInstalled {
    param($Record)

    $installed = Join-Path $Workspace ($Record.package -replace '/', '\')
    if (-not (Test-Path -LiteralPath (Join-Path $installed 'package.json') -PathType Leaf)) {
        throw "Layer '$($Record.layer)' has a pi key in its package.json, but its installed copy at $installed has no package.json. Add package.json to the layer's files list."
    }
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

# One Pi list. Each recorded entry accounts for one copy of itself in the list: the installer
# removes that copy and writes the entry again as its own. A copy the user wrote beside it is kept,
# and a wanted entry the user already lists, with no record of its own, stays the user's.
function Merge-PiEntries {
    param($Current, [string[]] $Wanted, [object[]] $Owned)

    $remaining = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in @($Current)) {
        if ($null -ne $entry) { $remaining.Add($entry) }
    }
    $ownedKeys = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in @($Owned)) {
        if ($null -eq $entry) { continue }
        $key = Get-PiEntryKey $entry
        $ownedKeys.Add($key) | Out-Null
        for ($index = 0; $index -lt $remaining.Count; $index++) {
            if ((Get-PiEntryKey $remaining[$index]) -ceq $key) {
                $remaining.RemoveAt($index)
                break
            }
        }
    }
    $present = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($entry in $remaining) { $present.Add((Get-PiEntryKey $entry)) | Out-Null }
    $added = [System.Collections.Generic.List[object]]::new()
    foreach ($entry in $Wanted) {
        $key = Get-PiEntryKey $entry
        if ($ownedKeys.Contains($key) -or -not $present.Contains($key)) { $added.Add($entry) }
    }
    return [pscustomobject]@{
        merged = @($remaining.ToArray()) + @($added.ToArray())
        added  = @($added.ToArray())
    }
}

# The Pi entries a previous apply recorded as its own under one key. A lock written before the
# ownership record has no record, so the entries its pi section listed under that key stand in.
function Get-OwnedPiEntries {
    param($Owned, $LegacyPi, [string] $Key)

    if ($null -eq $Owned) { return @(Get-Field $LegacyPi $Key) }
    $record = @($Owned | Where-Object { $_.kind -eq 'json-entries' -and $_.path -eq '.pi/agent/settings.json' -and $_.key -eq $Key })
    if ($record.Count -eq 0) { return @() }
    return @($record[0].entries)
}

# The workspace Pi settings the installer would write, and the entries it adds to each list.
# packages and skills are the only keys the installer owns; every other key, such as
# defaultProvider or defaultModel, is written back unchanged.
function Get-PiSettings {
    param([string[]] $Packages, [string[]] $Skills, [object[]] $OwnedPackages, [object[]] $OwnedSkills)

    $settings = [ordered]@{}
    if (Test-Path -LiteralPath $piSettingsTarget -PathType Leaf) {
        $existing = Get-Content -LiteralPath $piSettingsTarget -Raw | ConvertFrom-Json
        if ($null -ne $existing) {
            foreach ($property in $existing.PSObject.Properties) { $settings[$property.Name] = $property.Value }
        }
    }
    $packagesMerge = Merge-PiEntries -Current $settings['packages'] -Wanted $Packages -Owned $OwnedPackages
    $skillsMerge = Merge-PiEntries -Current $settings['skills'] -Wanted $Skills -Owned $OwnedSkills
    # @() keeps a one-entry list an array; PowerShell would otherwise unroll it to a string.
    $settings['packages'] = @($packagesMerge.merged)
    $settings['skills'] = @($skillsMerge.merged)
    return [pscustomobject]@{
        text  = (($settings | ConvertTo-Json -Depth 20) + "`n")
        added = [ordered]@{ packages = @($packagesMerge.added); skills = @($skillsMerge.added) }
    }
}

# One record of the ownership list. A file or folder holds its SHA-256, a folder a tree hash; a link
# holds its target; a json-entries record holds its key and entries, and createdKey when the installer
# created that key in a settings file that already existed.
function New-OwnedRecord {
    param(
        [string] $Path,
        [string] $Kind,
        [string] $Sha256 = $null,
        [string] $Target = $null,
        [string] $Key = $null,
        [object[]] $Entries = $null,
        [bool] $CreatedKey = $false
    )

    switch ($Kind) {
        'link' { return [pscustomobject]@{ path = $Path; kind = $Kind; target = $Target } }
        'json-entries' {
            $record = [pscustomobject]@{ path = $Path; kind = $Kind; key = $Key; entries = $Entries }
            if ($CreatedKey) { $record | Add-Member -NotePropertyName createdKey -NotePropertyValue $true }
            return $record
        }
        default { return [pscustomobject]@{ path = $Path; kind = $Kind; sha256 = $Sha256 } }
    }
}

# The identity of a record: its path, its kind, and for a Pi list its key.
function Get-OwnedKey {
    param($Record)

    return "$($Record.path)`t$($Record.kind)`t$(Get-Field $Record 'key')"
}

# The records in one order, so the lock diffs cleanly: by path, then kind, then key, by UTF-8 bytes.
function Sort-OwnedRecords {
    param([object[]] $Records)

    $byKey = [hashtable]::new([StringComparer]::Ordinal)
    foreach ($record in @($Records)) { $byKey[(Get-OwnedKey $record)] = $record }
    $keys = Sort-Utf8 @($byKey.Keys)
    return @($keys | ForEach-Object { $byKey[$_] })
}

# Fails when the disk does not hold what the plan says the install wrote. A record is never written
# from a disk that disagrees with the plan, because the record would then hide the difference.
function Assert-Written {
    param([string] $Path, [string] $Disk, [string] $Planned)

    if ($Disk -ne $Planned) {
        throw "$Path holds different content from what the install wrote, so no ownership record was written. Remove the file or folder and apply again."
    }
}

# What the installer would own after an apply, from the same layers and texts the apply writes.
# -Apply writes its record from this plan once the disk matches it, and -Status compares the plan
# with the disk and with the record. A null hash or entries means the value is not known yet.
function Get-OwnedPlan {
    param(
        [string] $Document,
        [object[]] $Layers,
        [object[]] $ClaudeRecords,
        [object[]] $OpenCodeLayers,
        [hashtable] $OpenCodeSpecs,
        [string] $CopilotCmdText,
        [string] $CopilotShText,
        [string] $PiCmdText,
        [string] $PiShText,
        $PiSettings,
        [bool] $PiPending,
        [hashtable] $PiUnknown
    )

    $records = [System.Collections.Generic.List[object]]::new()
    $layerByName = @{}
    foreach ($layer in $Layers) { $layerByName[$layer.name] = $layer }

    # An apply that finds the config matching by trimmed text leaves the file as it is.
    $configExists = Test-Path -LiteralPath $configTarget -PathType Leaf
    $configText = $null
    if ($configExists) { $configText = Get-Content -LiteralPath $configTarget -Raw }
    $configUnchanged = ($null -ne $configText) -and ($configText.Trim() -eq $Document.Trim())
    $configSha = Get-TextSha256 $Document
    if ($configUnchanged) { $configSha = (Get-FileHash -LiteralPath $configTarget -Algorithm SHA256).Hash }
    $records.Add((New-OwnedRecord -Path 'opencode.jsonc' -Kind 'file' -Sha256 $configSha))

    # A backup holds the config that the last change replaced, so an apply that changes the config
    # writes a new one. An earlier backup stays as it is.
    $backupSha = $null
    if ($configExists -and -not $configUnchanged) {
        $backupSha = (Get-FileHash -LiteralPath $configTarget -Algorithm SHA256).Hash
    } elseif (Test-Path -LiteralPath "$configTarget.bak" -PathType Leaf) {
        $backupSha = (Get-FileHash -LiteralPath "$configTarget.bak" -Algorithm SHA256).Hash
    }
    if ($null -ne $backupSha) {
        $backup = New-OwnedRecord -Path 'opencode.jsonc.bak' -Kind 'file' -Sha256 $backupSha
        $backup | Add-Member -NotePropertyName backup -NotePropertyValue $true
        $records.Add($backup)
    }

    foreach ($record in $ClaudeRecords) {
        $path = ".claude/plugins/$($record.plugin)"
        if ($record.kind -eq 'junction') {
            $records.Add((New-OwnedRecord -Path $path -Kind 'link' -Target $record.target))
            continue
        }
        $root = Get-LayerRoot $layerByName[$record.layer]
        $sha = $null
        if ($null -ne $root) { $sha = Get-TreeSha256 $root }
        $records.Add((New-OwnedRecord -Path $path -Kind 'dir' -Sha256 $sha))
    }

    foreach ($layer in @($Layers | Where-Object { $null -ne $_.url })) {
        $sha = $null
        if (Test-CacheAtPin $layer) { $sha = Get-TreeSha256 (Join-Path $claudeCacheTarget $layer.name) }
        $records.Add((New-OwnedRecord -Path ".claude/cache/$($layer.name)" -Kind 'dir' -Sha256 $sha))
    }

    # A profile that two layers install is recorded once, with the later layer's copy, as the apply writes it.
    $agents = [ordered]@{}
    foreach ($layer in $OpenCodeLayers) {
        $root = Get-LayerRoot $layer
        $sha = $null
        if ($null -ne $root) {
            $claudeDeclared = $layer.runtimes.ContainsKey('claude')
            $items = @(Get-OpenCodeItems -Layer $layer -Root $root | Where-Object { $_ -ne '.claude-plugin' -or $claudeDeclared })
            $sha = Get-ItemsTreeSha256 -Root $root -Items $items
            $spec = $OpenCodeSpecs[$layer.name]
            $agentsSource = $null
            if ($spec.agents) { $agentsSource = Join-Path $root ($spec.agents -replace '/', '\') }
            if ($agentsSource -and (Test-Path -LiteralPath $agentsSource -PathType Container)) {
                foreach ($agent in @(Get-ChildItem -LiteralPath $agentsSource -Filter '*.md')) {
                    $text = Get-AgentProfileText $agent.FullName
                    $agentSha = (Get-FileHash -LiteralPath $agent.FullName -Algorithm SHA256).Hash
                    if ($null -ne $text) { $agentSha = Get-TextSha256 $text }
                    $path = ".opencode/agents/$($agent.Name)"
                    $agents[$path] = New-OwnedRecord -Path $path -Kind 'file' -Sha256 $agentSha
                }
            }
        }
        $records.Add((New-OwnedRecord -Path ".opencode/plugins/$($layer.name)" -Kind 'dir' -Sha256 $sha))
    }
    foreach ($agent in $agents.Values) { $records.Add($agent) }

    if ($CopilotCmdText) {
        $records.Add((New-OwnedRecord -Path '.maxstack/bin/copilot.cmd' -Kind 'file' -Sha256 (Get-TextSha256 $CopilotCmdText)))
        $records.Add((New-OwnedRecord -Path '.maxstack/bin/copilot.sh' -Kind 'file' -Sha256 (Get-TextSha256 $CopilotShText)))
    }
    if ($PiCmdText) {
        $records.Add((New-OwnedRecord -Path '.maxstack/bin/pi.cmd' -Kind 'file' -Sha256 (Get-TextSha256 $PiCmdText)))
        $records.Add((New-OwnedRecord -Path '.maxstack/bin/pi.sh' -Kind 'file' -Sha256 (Get-TextSha256 $PiShText)))
    }

    if ($null -ne $PiSettings) {
        $settingsPath = Join-Path $Workspace '.pi\agent\settings.json'
        $settingsExists = Test-Path -LiteralPath $settingsPath -PathType Leaf
        $settingsUnchanged = $PiPending
        if ($settingsExists -and -not $PiPending) {
            $existingSettings = Get-Content -LiteralPath $settingsPath -Raw
            $settingsUnchanged = ($null -ne $existingSettings) -and ($existingSettings.Trim() -eq $PiSettings.text.Trim())
        }
        $settingsBackupSha = $null
        if ($settingsExists -and -not $settingsUnchanged) {
            $settingsBackupSha = (Get-FileHash -LiteralPath $settingsPath -Algorithm SHA256).Hash
        } elseif (Test-Path -LiteralPath "$settingsPath.bak" -PathType Leaf) {
            $settingsBackupSha = (Get-FileHash -LiteralPath "$settingsPath.bak" -Algorithm SHA256).Hash
        }
        if ($null -ne $settingsBackupSha) {
            $backup = New-OwnedRecord -Path '.pi/agent/settings.json.bak' -Kind 'file' -Sha256 $settingsBackupSha
            $backup | Add-Member -NotePropertyName backup -NotePropertyValue $true
            $records.Add($backup)
        }

        foreach ($key in @('packages', 'skills')) {
            $known = @($PiSettings.added[$key])
            $unknown = @(@($PiUnknown[$key]) | Where-Object { $known -cnotcontains $_ })
            if ($known.Count -eq 0 -and $unknown.Count -eq 0) { continue }
            $record = New-OwnedRecord -Path '.pi/agent/settings.json' -Kind 'json-entries' -Key $key -Entries $known
            $record | Add-Member -NotePropertyName unknown -NotePropertyValue $unknown
            $records.Add($record)
        }
    }
    return $records.ToArray()
}

# The ownership list an apply writes, from the plan once the disk matches it. A json-entries record
# holds only the entries the apply added, and none when it added none.
function Get-OwnedRecords {
    param([object[]] $Plan, [hashtable] $CreatedKeys)

    $records = foreach ($record in $Plan) {
        $full = Join-Path $Workspace ($record.path -replace '/', '\')
        # A planned backup is recorded once the apply has written it, and not before.
        if ((Get-Field $record 'backup') -and -not (Test-Path -LiteralPath $full -PathType Leaf)) { continue }
        switch ($record.kind) {
            'file' {
                $disk = (Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash
                Assert-Written -Path $record.path -Disk $disk -Planned $record.sha256
                New-OwnedRecord -Path $record.path -Kind 'file' -Sha256 $disk
            }
            'dir' {
                $disk = Get-TreeSha256 $full
                Assert-Written -Path $record.path -Disk $disk -Planned $record.sha256
                New-OwnedRecord -Path $record.path -Kind 'dir' -Sha256 $disk
            }
            'link' { New-OwnedRecord -Path $record.path -Kind 'link' -Target $record.target }
            'json-entries' {
                $entries = @($record.entries | Where-Object { $null -ne $_ })
                if ($entries.Count -gt 0) {
                    New-OwnedRecord -Path $record.path -Kind 'json-entries' -Key $record.key -Entries $entries -CreatedKey ([bool] $CreatedKeys[$record.key])
                }
            }
        }
    }
    return (Sort-OwnedRecords @($records))
}

# The state of one recorded file, folder, or link. missing and modified compare the disk with the
# record; drifted means the disk matches the record but an apply would write something else; matching
# means neither holds.
function Get-OwnedState {
    param($Record, $Planned)

    $full = Join-Path $Workspace ($Record.path -replace '/', '\')
    $plannedSame = ($null -ne $Planned) -and ($Planned.kind -eq $Record.kind)
    switch ($Record.kind) {
        'link' {
            $item = Get-Item -LiteralPath $full -Force -ErrorAction SilentlyContinue
            if ($null -eq $item) { return 'missing' }
            if (-not (Test-ClaudeJunction -Child $full -Target (Join-Path $Workspace ($Record.target -replace '/', '\')))) { return 'modified' }
            $plannedSame = $plannedSame -and ($Planned.target -eq $Record.target)
        }
        'file' {
            if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { return 'missing' }
            if ((Get-FileHash -LiteralPath $full -Algorithm SHA256).Hash -ne $Record.sha256) { return 'modified' }
            $plannedSame = $plannedSame -and ($Planned.sha256 -eq $Record.sha256)
        }
        'dir' {
            if (-not (Test-Path -LiteralPath $full -PathType Container)) { return 'missing' }
            if ((Get-TreeSha256 $full) -ne $Record.sha256) { return 'modified' }
            $plannedSame = $plannedSame -and ($Planned.sha256 -eq $Record.sha256)
        }
    }
    if ($plannedSame) { return 'matching' }
    return 'drifted'
}

# Compares the recorded ownership with the disk and with the plan, and writes nothing. A Pi list is
# reported per entry, so one removed entry shows alone. An entry whose state cannot be known until an
# apply syncs a pinned source is drifted, and it is reported once, like every other path.
function Get-OwnershipReport {
    param([object[]] $Recorded, [object[]] $Plan)

    $results = [System.Collections.Generic.List[object]]::new()
    $plannedByKey = [hashtable]::new([StringComparer]::Ordinal)
    foreach ($planned in @($Plan)) { $plannedByKey[(Get-OwnedKey $planned)] = $planned }
    $recordedKeys = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $recordedPaths = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $recordedEntries = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($record in @($Recorded)) {
        $recordedKeys.Add((Get-OwnedKey $record)) | Out-Null
        $recordedPaths.Add($record.path) | Out-Null
    }

    foreach ($record in @($Recorded)) {
        if ($record.kind -ne 'json-entries') {
            $state = Get-OwnedState -Record $record -Planned $plannedByKey[(Get-OwnedKey $record)]
            $results.Add([pscustomobject]@{ state = $state; label = $record.path })
            continue
        }
        $settingsPath = Join-Path $Workspace ($record.path -replace '/', '\')
        $settings = $null
        if (Test-Path -LiteralPath $settingsPath -PathType Leaf) { $settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json }
        $present = [hashtable]::new([StringComparer]::Ordinal)
        foreach ($entry in @(Get-Field $settings $record.key)) {
            if ($null -ne $entry) { $present[(Get-PiEntryKey $entry)] = $true }
        }
        $planned = $plannedByKey[(Get-OwnedKey $record)]
        $known = [hashtable]::new([StringComparer]::Ordinal)
        if ($null -ne $planned) {
            foreach ($entry in @($planned.entries)) {
                if ($null -ne $entry) { $known[(Get-PiEntryKey $entry)] = $true }
            }
        }
        foreach ($entry in @($record.entries)) {
            $entryKey = Get-PiEntryKey $entry
            $recordedEntries.Add("$($record.path)`t$($record.key)`t$entryKey") | Out-Null
            if (-not $present.ContainsKey($entryKey)) { $state = 'missing' }
            elseif ($known.ContainsKey($entryKey)) { $state = 'matching' }
            else { $state = 'drifted' }
            $results.Add([pscustomobject]@{ state = $state; label = "$($record.path) [$($record.key)] $entryKey" })
        }
    }

    foreach ($planned in @($Plan)) {
        if ($planned.kind -ne 'json-entries') {
            # A backup that the next apply would write is not reported until it exists.
            if ((Get-Field $planned 'backup') -and -not (Test-Path -LiteralPath (Join-Path $Workspace ($planned.path -replace '/', '\')) -PathType Leaf)) { continue }
            if (-not $recordedKeys.Contains((Get-OwnedKey $planned))) {
                $results.Add([pscustomobject]@{ state = 'drifted'; label = $planned.path })
            }
            continue
        }
        $candidates = @($planned.entries) + @(Get-Field $planned 'unknown')
        foreach ($entry in $candidates) {
            if ($null -eq $entry) { continue }
            $entryKey = Get-PiEntryKey $entry
            if ($recordedEntries.Contains("$($planned.path)`t$($planned.key)`t$entryKey")) { continue }
            $results.Add([pscustomobject]@{ state = 'drifted'; label = "$($planned.path) [$($planned.key)] $entryKey" })
        }
    }

    # A file in .maxstack\bin that no record names is one the installer did not write.
    $bin = Join-Path $Workspace '.maxstack\bin'
    if (Test-Path -LiteralPath $bin -PathType Container) {
        foreach ($file in @(Get-ChildItem -LiteralPath $bin -File -Force)) {
            $path = ".maxstack/bin/$($file.Name)"
            if (-not $recordedPaths.Contains($path)) { $results.Add([pscustomobject]@{ state = 'untracked'; label = $path }) }
        }
    }
    return $results.ToArray()
}

# Deletes a file, or a folder and everything in it. A junction or a symbolic link is removed as a
# link, so the folder it names and its contents are never touched.
function Remove-OwnedTree {
    param([string] $Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return }
    if (Test-ReparsePoint $item.FullName) {
        if ($item.PSIsContainer) { [IO.Directory]::Delete($item.FullName, $false) } else { [IO.File]::Delete($item.FullName) }
        return
    }
    if ($item.PSIsContainer) {
        foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force)) { Remove-OwnedTree $child.FullName }
        [IO.Directory]::Delete($item.FullName, $false)
    } else {
        [IO.File]::Delete($item.FullName)
    }
}

# Removes from a layer folder what the layer does not install now. Items are relative paths under the
# folder, forward-slashed. Each removal is printed, so a file that went away shows in the apply output.
function Remove-FolderExtras {
    param([string] $Folder, [string[]] $Items, [switch] $Top)

    foreach ($child in @(Get-ChildItem -LiteralPath $Folder -Force)) {
        $name = $child.Name
        # The layer folder's node_modules is npm's output from the last install, so it stays.
        if ($Top -and $child.PSIsContainer -and $name -ceq 'node_modules') { continue }
        if (@($Items | Where-Object { $_ -ceq $name }).Count -gt 0) { continue }
        $within = @($Items | Where-Object { $_.StartsWith("$name/", [StringComparison]::Ordinal) } | ForEach-Object { $_.Substring($name.Length + 1) })
        if ($within.Count -gt 0 -and $child.PSIsContainer -and -not (Test-ReparsePoint $child.FullName)) {
            Remove-FolderExtras -Folder $child.FullName -Items $within
            continue
        }
        Remove-OwnedTree $child.FullName
        Write-Host "Removed $($child.FullName): the layer does not install it"
    }
}

# The directories an install may create, named relative to the workspace. An apply reads this list
# before and after its writes, to tell what it created from what was there first.
function Get-InstallerDirectories {
    param([object[]] $Layers)

    $dirs = [System.Collections.Generic.List[string]]::new()
    foreach ($dir in @('.claude', '.claude/plugins', '.claude/cache', '.opencode', '.opencode/plugins', '.opencode/agents', '.maxstack', '.maxstack/bin', '.pi', '.pi/agent')) {
        $dirs.Add($dir)
    }
    foreach ($layer in $Layers) {
        $dirs.Add(".claude/plugins/$($layer.name)")
        $dirs.Add(".claude/cache/$($layer.name)")
        $dirs.Add(".opencode/plugins/$($layer.name)")
    }
    return $dirs.ToArray()
}

# The candidates that exist now and either were not there before this apply, or were recorded as
# created by an earlier one. A prior entry that is gone from the disk is dropped.
function Get-CreatedPaths {
    param([string[]] $Candidates, [string[]] $Prior, [string[]] $ExistedBefore, [string] $Kind)

    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    $created = [System.Collections.Generic.List[string]]::new()
    foreach ($path in @($Candidates) + @($Prior)) {
        if (-not $seen.Add($path)) { continue }
        $full = Join-Path $Workspace ($path -replace '/', '\')
        if ($Kind -eq 'dir') { $exists = Test-Path -LiteralPath $full -PathType Container }
        else { $exists = Test-Path -LiteralPath $full -PathType Leaf }
        if (-not $exists) { continue }
        if (($Prior -ccontains $path) -or -not ($ExistedBefore -ccontains $path)) { $created.Add($path) }
    }
    return (Sort-Utf8 $created.ToArray())
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

# Before any write, an apply records what already exists: the directories an install may create, the
# settings file, and its Pi keys. The ownership record then tells the paths this install created from
# the paths that were there first, so an uninstall never removes what it did not create.
$installerDirs = @(Get-InstallerDirectories -Layers $layers)
$existedBefore = @()
$existedBeforeFiles = @()
$settingsKeysBefore = @()
$settingsFileBefore = $false
if ($Apply) {
    $existedBefore = @($installerDirs | Where-Object { Test-Path -LiteralPath (Join-Path $Workspace ($_ -replace '/', '\')) -PathType Container })
    $settingsFileBefore = Test-Path -LiteralPath $piSettingsTarget -PathType Leaf
    if ($settingsFileBefore) {
        $settingsBefore = Get-Content -LiteralPath $piSettingsTarget -Raw | ConvertFrom-Json
        if ($null -ne $settingsBefore) { $settingsKeysBefore = @($settingsBefore.PSObject.Properties | ForEach-Object { $_.Name }) }
        $existedBeforeFiles = @('.pi/agent/settings.json')
    }
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
# The ownership list the previous apply wrote. $null means the lock predates it, or there is no lock.
$priorOwned = $null
# The directories and files an earlier apply recorded as created by the installer.
$priorCreatedDirs = @()
$priorCreatedFiles = @()
if (Test-Path -LiteralPath $stackTarget -PathType Leaf) {
    try {
        $priorStack = Get-Content -LiteralPath $stackTarget -Raw | ConvertFrom-Json
        foreach ($priorLayer in @($priorStack.layers)) {
            $priorLayers[$priorLayer.name] = $priorLayer
        }
        $priorPi = Get-Field $priorStack 'pi'
        if ($null -ne $priorStack.PSObject.Properties['owned']) { $priorOwned = @($priorStack.owned) }
        if ($null -ne $priorStack.PSObject.Properties['createdDirs']) { $priorCreatedDirs = @($priorStack.createdDirs) }
        if ($null -ne $priorStack.PSObject.Properties['createdFiles']) { $priorCreatedFiles = @($priorStack.createdFiles) }
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
$piSettings = $null
if ($piLayers.Count -gt 0 -or (Test-Path -LiteralPath $piSettingsTarget -PathType Leaf)) {
    $piSettings = Get-PiSettings -Packages $piPackageEntries -Skills $piSkillEntries `
        -OwnedPackages (Get-OwnedPiEntries -Owned $priorOwned -LegacyPi $priorPi -Key 'packages') `
        -OwnedSkills (Get-OwnedPiEntries -Owned $priorOwned -LegacyPi $priorPi -Key 'skills')
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

# Apply needs the plan, and status needs it only to compare with a record. Audit does not need it.
# A pinned layer whose cache is not at its pin cannot say which Pi entries it adds. Only those entries
# are unknown; every other entry is known.
$piUnknown = @{ packages = @(); skills = @() }
foreach ($record in $piRecords) {
    if (-not $record.pending) { continue }
    $piUnknown.packages += "../../.claude/cache/$($record.layer)"
    $piUnknown.skills += "../../.claude/plugins/$($record.layer)/skills"
}

$plan = @()
if ($Apply -or ($Status -and $null -ne $priorOwned)) {
    $plan = Get-OwnedPlan -Document $document -Layers $layers -ClaudeRecords $claudeRecords -OpenCodeLayers $openCodeLayers `
        -OpenCodeSpecs $openCodeSpecs -CopilotCmdText $copilotCmdText -CopilotShText $copilotShText `
        -PiCmdText $piCmdText -PiShText $piShText -PiSettings $piSettings -PiPending $piPending -PiUnknown $piUnknown
}

if ($Status) {
    if ($null -eq $priorOwned) {
        Write-Host 'no ownership record; run -Apply once to create it'
        if ($Strict) { exit 1 }
        return
    }
    $results = @(Get-OwnershipReport -Recorded $priorOwned -Plan $plan)
    foreach ($result in $results) { Write-Host ('{0,-10} {1}' -f $result.state, $result.label) }
    $counts = foreach ($state in @('matching', 'drifted', 'modified', 'missing', 'untracked')) {
        "$(@($results | Where-Object { $_.state -eq $state }).Count) $state"
    }
    Write-Host ('Summary: ' + ($counts -join ', '))
    if ($Strict -and @($results | Where-Object { $_.state -ne 'matching' }).Count -gt 0) { exit 1 }
    return
}

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
    } elseif ($piSettings) {
        Write-Host ("Drift:          {0}: {1}" -f $piSettingsTarget, (Get-DriftState -Path $piSettingsTarget -Text $piSettings.text))
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
    # The folder is wholly the installer's. What the layer no longer installs is removed, and each item is
    # replaced by a fresh copy, so the folder holds exactly what the layer names.
    $items = @(Get-OpenCodeItems -Layer $layer -Root $layer.root | Where-Object { $_ -ne '.claude-plugin' -or $claudeDeclared })
    Remove-FolderExtras -Folder $folder -Items $items -Top
    foreach ($item in $items) {
        $source = Join-Path $layer.root $item
        if (-not (Test-Path -LiteralPath $source)) { throw "Plugin layer '$($layer.name)' is missing: $source" }
        $destination = Join-Path $folder $item
        Remove-OwnedTree $destination
        New-Item -ItemType Directory -Path (Split-Path -Parent $destination) -Force | Out-Null
        Copy-Item -LiteralPath $source -Destination $destination -Recurse -Force
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
    # npm writes a package-lock.json beside the package.json it installs from. The folder holds what the
    # installer copied, so that file goes unless a layer item named it.
    $lockRelative = 'package-lock.json'
    if ($spec.dir -ne '') { $lockRelative = "$($spec.dir)/package-lock.json" }
    # Windows names are case-insensitive, so an item named Package-Lock.json is the same file as npm's.
    $lockCopied = @($items | Where-Object { $lockRelative -ieq $_ -or $lockRelative.StartsWith("$_/", [StringComparison]::OrdinalIgnoreCase) }).Count -gt 0
    $npmLock = Join-Path $installDir 'package-lock.json'
    if (-not $lockCopied -and (Test-Path -LiteralPath $npmLock -PathType Leaf)) {
        Remove-OwnedTree $npmLock
        Write-Host "Removed the package-lock.json that npm wrote beside $($layer.name)'s package.json"
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
        Remove-OwnedTree $entry.FullName
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
if ($piSettings) {
    $piSettingsText = $piSettings.text
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
        $treeSha = Get-LegacyTreeSha256 $child
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

# The Pi keys this apply created in a settings file that already existed, or kept from an earlier apply.
# A settings file the apply created is listed in createdFiles instead.
$priorCreatedKeys = @()
if ($null -ne $priorOwned) {
    $priorCreatedKeys = @($priorOwned | Where-Object { $_.kind -eq 'json-entries' -and (Get-Field $_ 'createdKey') -eq $true } | ForEach-Object { $_.key })
}
$settingsNow = $null
if (Test-Path -LiteralPath $piSettingsTarget -PathType Leaf) { $settingsNow = Get-Content -LiteralPath $piSettingsTarget -Raw | ConvertFrom-Json }
$createdKeys = @{}
foreach ($key in @('packages', 'skills')) {
    $presentNow = ($null -ne $settingsNow) -and ($null -ne $settingsNow.PSObject.Properties[$key])
    $createdHere = $settingsFileBefore -and -not ($settingsKeysBefore -ccontains $key)
    $createdKeys[$key] = [bool]($presentNow -and ($createdHere -or ($priorCreatedKeys -ccontains $key)))
}
$createdDirs = @(Get-CreatedPaths -Candidates $installerDirs -Prior $priorCreatedDirs -ExistedBefore $existedBefore -Kind 'dir')
$createdFiles = @(Get-CreatedPaths -Candidates @('.pi/agent/settings.json') -Prior $priorCreatedFiles -ExistedBefore $existedBeforeFiles -Kind 'file')

# The ownership record: every path this apply wrote, after the writes, so -Status and a later
# remove or uninstall know what is theirs. It holds no path outside the workspace and not the lock.
$owned = Get-OwnedRecords -Plan $plan -CreatedKeys $createdKeys

$stack = [pscustomobject]@{
    generatedAt  = (Get-Date).ToUniversalTime().ToString('o')
    workspace    = $workspaceName
    configSha256 = Get-TextSha256 $document
    copilot      = $copilotLock
    pi           = $piLock
    layers       = $layerRecords
    ownedSchema  = $ownedSchemaVersion
    owned        = @($owned)
    createdDirs  = $createdDirs
    createdFiles = $createdFiles
}
[IO.File]::WriteAllText($stackTarget, ($stack | ConvertTo-Json -Depth 8), (New-Object System.Text.UTF8Encoding($false)))
Write-Host "Wrote $stackTarget"

Write-Host 'Workspace bundle installed from the layer manifest.'
Write-Host 'Restart the running OpenCode server, then start a new T3 session to load it: T3 can reuse that server across sessions. Claude Code reads plugins when a session starts. Pi reads its settings when a session starts.'
