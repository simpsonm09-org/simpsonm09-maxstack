# platforms: windows
#requires -Version 7.0
Set-StrictMode -Version Latest

# The marker files that name a workspace, in the order a folder is checked.
$script:MaxstackMarkerNames = @('maxstack.settings.json', 'stack.lock.json')

# Control characters: C0, DEL, and the C1 range. A user value holding one is refused.
function Test-MaxstackControlCharacter {
    param([char] $Character)

    $code = [int] $Character
    return ($code -lt 32) -or ($code -ge 127 -and $code -le 159)
}

# A character that can reorder or split a line in a terminal: the bidi overrides and isolates, and the line and paragraph
# separators. A user value holding one is refused.
function Test-MaxstackLineBreakingCharacter {
    param([char] $Character)

    $code = [int] $Character
    return ($code -ge 0x202a -and $code -le 0x202e) -or ($code -ge 0x2066 -and $code -le 0x2069) -or $code -eq 0x2028 -or $code -eq 0x2029
}

# A character shown as an escape in every message: a control character, any Format character (a zero width space or
# joiner, a byte order mark), a line or paragraph separator, and a surrogate that is not part of a pair.
function Test-MaxstackEscapedCharacter {
    param([char] $Character, [bool] $Paired)

    if (Test-MaxstackControlCharacter $Character) { return $true }
    if (-not $Paired -and [char]::IsSurrogate($Character)) { return $true }
    $category = [Globalization.CharUnicodeInfo]::GetUnicodeCategory($Character)
    return $category -in @([Globalization.UnicodeCategory]::Format, [Globalization.UnicodeCategory]::LineSeparator, [Globalization.UnicodeCategory]::ParagraphSeparator)
}

# The text an error or the resolved line shows: every escaped character as \uXXXX, and at most 260 characters, with an
# ellipsis when cut. A surrogate pair is kept whole.
function Get-MaxstackSafePathDisplay {
    param([string] $Path)

    $display = [Text.StringBuilder]::new()
    for ($index = 0; $index -lt $Path.Length; $index++) {
        $character = $Path[$index]
        $paired = [char]::IsHighSurrogate($character) -and ($index + 1 -lt $Path.Length) -and [char]::IsLowSurrogate($Path[$index + 1])
        if ($paired) {
            [void] $display.Append($character).Append($Path[$index + 1])
            $index++
        }
        elseif (Test-MaxstackEscapedCharacter $character $false) {
            [void] $display.Append(('\u{0:X4}' -f [int] $character))
        }
        else {
            [void] $display.Append($character)
        }
    }
    $text = $display.ToString()
    if ($text.Length -le 260) { return $text }
    $cut = if ([char]::IsHighSurrogate($text[259])) { 259 } else { 260 }
    return $text.Substring(0, $cut) + '...'
}

# Refuses a user value holding a control character or a line-breaking character, or an unpaired surrogate. A Format
# character other than those is shown as an escape and accepted.
function Assert-MaxstackPathHasNoControlCharacters {
    param([string] $Path, [string] $Name)

    for ($index = 0; $index -lt $Path.Length; $index++) {
        $character = $Path[$index]
        $paired = [char]::IsHighSurrogate($character) -and ($index + 1 -lt $Path.Length) -and [char]::IsLowSurrogate($Path[$index + 1])
        if ($paired) {
            $index++
            continue
        }
        if (Test-MaxstackControlCharacter $character) {
            throw "$Name path contains control characters: $(Get-MaxstackSafePathDisplay $Path)"
        }
        if ((Test-MaxstackLineBreakingCharacter $character) -or [char]::IsSurrogate($character)) {
            throw "$Name path contains a character that reorders or splits a line: $(Get-MaxstackSafePathDisplay $Path). Give a plain path."
        }
    }
}

# Refuses a path by its text before any filesystem call. A device prefix and a UNC path would reach the network or a
# device, and an 8.3 short name would name the workspace by a name the lock does not record.
function Assert-MaxstackPathText {
    param([string] $Path, [string] $Name)

    Assert-MaxstackPathHasNoControlCharacters $Path $Name
    $safePath = Get-MaxstackSafePathDisplay $Path
    if ($Path -match '^[\\/]{2}[?.][\\/]') {
        throw "$Name path uses a device prefix (\\?\ or \\.\): $safePath. Give a drive path."
    }
    if ($Path -match '^[\\/]{2}') {
        throw "$Name path is a UNC path: $safePath. Workspace discovery reads only local folders. Give a drive path."
    }
}

# A segment is an 8.3 short name when it has at most six characters before a tilde and a number, and no folder of that
# exact name exists beside it. A real folder named like that is a long name, so it is accepted.
function Test-MaxstackShortNameSegment {
    param([string] $Parent, [string] $Segment)

    if ($Segment -cnotmatch '^[^~]{1,6}~\d+(\.[^.]{0,3})?$') { return $false }
    if (-not (Test-Path -LiteralPath $Parent -PathType Container)) { return $true }
    $literal = @(Get-ChildItem -LiteralPath $Parent -Force | Where-Object { $_.Name -ceq $Segment })
    return $literal.Count -eq 0
}

# The 8.3 rule applies to a path the user supplied, because a short name would record a name the lock does not hold.
function Assert-MaxstackShortNames {
    param([string] $FullPath, [string] $Name)

    $prefix = ''
    foreach ($segment in ($FullPath -split '[\\/]')) {
        if ($segment -eq '') { continue }
        if ($prefix -ne '' -and (Test-MaxstackShortNameSegment $prefix $segment)) {
            throw "$Name path has an 8.3 short name ($(Get-MaxstackSafePathDisplay $segment)): $(Get-MaxstackSafePathDisplay $FullPath). Give the long path."
        }
        $prefix = if ($prefix -eq '') { "$segment\" } else { "$prefix$segment\" }
    }
}

# A folder under .git, under a layer cache (.claude\cache), or under a layer checkout (projects\repos, projects\worktrees)
# is never a workspace: a write there would change git metadata, a cache, or a checkout.
function Test-MaxstackInternalLocation {
    param([string] $Path)

    $segments = @($Path -split '[\\/]' | Where-Object { $_ -ne '' })
    for ($index = 0; $index -lt $segments.Count; $index++) {
        if ($segments[$index] -ieq '.git') { return $true }
        if ($index + 1 -lt $segments.Count -and (Test-MaxstackSegmentPair $segments[$index] $segments[$index + 1])) { return $true }
    }
    return $false
}

function Test-MaxstackSegmentPair {
    param([string] $First, [string] $Second)

    if ($First -ieq '.claude' -and $Second -ieq 'cache') { return $true }
    return $First -ieq 'projects' -and ($Second -ieq 'repos' -or $Second -ieq 'worktrees')
}

# The folder that holds the running scripts folder: the maxstack checkout this installer belongs to.
function Get-MaxstackRepoRoot {
    param([string] $ScriptRoot)

    $scriptDirectory = [IO.DirectoryInfo]::new([IO.Path]::GetFullPath($ScriptRoot))
    if (-not (Test-MaxstackDirectoryNamed $scriptDirectory 'scripts')) { return $null }
    # A drive root is never a checkout: treating it as one would refuse every path on that drive.
    $repo = $scriptDirectory.Parent
    if ($null -eq $repo -or $null -eq $repo.Parent) { return $null }
    return $repo.FullName
}

function Test-MaxstackUnder {
    param([string] $Path, [string] $Root)

    if ([string]::IsNullOrEmpty($Root)) { return $false }
    $trimmedRoot = [IO.Path]::TrimEndingDirectorySeparator($Root)
    $trimmedPath = [IO.Path]::TrimEndingDirectorySeparator($Path)
    return ($trimmedPath -ieq $trimmedRoot) -or $trimmedPath.StartsWith("$trimmedRoot\", [StringComparison]::OrdinalIgnoreCase)
}

# A maxstack checkout holds the layer manifest and this installer. Its own workspace folder is named workspace.
function Test-MaxstackCheckout {
    param([string] $Folder)

    if ([string]::IsNullOrEmpty($Folder)) { return $false }
    return (Test-Path -LiteralPath (Join-Path $Folder 'layers.json') -PathType Leaf) -and
        (Test-Path -LiteralPath (Join-Path $Folder 'scripts\Install-Workspace.ps1') -PathType Leaf)
}

# A folder that is the running checkout or lies under it, a maxstack checkout, or the workspace folder of one. None of
# these is a workspace: an apply there would overwrite the tracked config and add the install outputs to the repository.
function Test-MaxstackCheckoutLocation {
    param([string] $Path, [string] $RepoRoot)

    if (Test-MaxstackUnder $Path $RepoRoot) { return $true }
    $trimmed = [IO.Path]::TrimEndingDirectorySeparator($Path)
    if (Test-MaxstackCheckout $trimmed) { return $true }
    $leaf = [IO.Path]::GetFileName($trimmed)
    $parent = [IO.Path]::GetDirectoryName($trimmed)
    return ($leaf -ieq 'workspace') -and (Test-MaxstackCheckout $parent)
}

# The folder a path finally names: a junction or a symbolic link is followed, so the workspace is the folder it holds.
function Get-MaxstackFinalDirectory {
    param([string] $Path)

    $item = Get-Item -LiteralPath $Path -Force
    $linked = $item.ResolveLinkTarget($true)
    $final = if ($null -ne $linked) { $linked.FullName } else { $item.FullName }
    return [IO.Path]::TrimEndingDirectorySeparator($final)
}

function ConvertTo-MaxstackFullPath {
    param([string] $Path, [string] $Name, [string] $CurrentDirectory)

    Assert-MaxstackPathText $Path $Name
    $safePath = Get-MaxstackSafePathDisplay $Path
    if ([IO.Path]::IsPathRooted($Path) -and -not [IO.Path]::IsPathFullyQualified($Path)) {
        # C:ws resolves against the process location of drive C, and \ws against the drive of the process location.
        $kind = if ($Path -match '^[A-Za-z]:') { 'drive-relative' } else { 'root-relative' }
        throw "$Name path is $kind, so it would resolve against the process location: $safePath. Give a full path with a drive letter."
    }
    if (-not [IO.Path]::IsPathRooted($Path)) {
        $Path = Join-Path (Get-MaxstackCurrentDirectory $CurrentDirectory $Name) $Path
    }
    try {
        $full = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($Path))
    }
    catch {
        throw "$Name path is invalid: $safePath"
    }
    Assert-MaxstackShortNames $full $Name
    return $full
}

function Assert-MaxstackWorkspaceTarget {
    param([string] $Path, [string] $Source, [string] $RepoRoot)

    Assert-MaxstackPathText $Path $Source
    $safePath = Get-MaxstackSafePathDisplay $Path
    $missing = "$Source target does not exist or is not a directory: $safePath"
    if (Test-MaxstackDriveRoot $Path) { throw "$Source target is a drive root, not a workspace: $safePath. Give a folder under it." }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw $missing }
    try {
        $final = Get-MaxstackFinalDirectory $Path
    }
    catch {
        throw "$Source target could not be checked: $safePath"
    }
    if (-not (Test-Path -LiteralPath $final -PathType Container)) { throw $missing }
    if (Test-MaxstackDriveRoot $final) { throw "$Source target is a drive root, not a workspace: $safePath. Give a folder under it." }
    if (Test-MaxstackInternalLocation $final) {
        throw "$Source target is inside a git directory, a layer checkout, or a layer cache: $(Get-MaxstackSafePathDisplay $final)"
    }
    Assert-MaxstackPathText $final $Source
    if ((Test-MaxstackCheckoutLocation $Path $RepoRoot) -or (Test-MaxstackCheckoutLocation $final $RepoRoot)) {
        throw "$Source target is a maxstack checkout, not a workspace: $safePath. Give the folder of your own workspace."
    }
    # The path given is the workspace, as upstream main writes it and records its leaf name. The resolved folder is used
    # only for the checks above.
    return $Path
}

# The current directory as the start of a walk, or $null when it cannot hold a marker. Discovery never asserts the current
# directory: a location it cannot read has no marker, and the later steps still run. A device path and a UNC path are
# never read, because a lookup there reaches the network.
function Get-MaxstackWalkStart {
    param([string] $CurrentDirectory)

    if ((Get-Location).Provider.Name -cne 'FileSystem') { return $null }
    if ($CurrentDirectory -match '^[\\/]{2}') { return $null }
    try {
        $full = [IO.Path]::GetFullPath($CurrentDirectory)
        if (Test-Path -LiteralPath $full -PathType Container) { return $full }
    }
    catch {
        return $null
    }
    return $null
}

# The current directory for a relative user value. A relative value has no other base, so an unusable one is an error.
function Get-MaxstackCurrentDirectory {
    param([string] $CurrentDirectory, [string] $Name)

    $start = Get-MaxstackWalkStart $CurrentDirectory
    if ($null -eq $start) {
        throw "$Name path is relative, and the current directory cannot resolve it: $(Get-MaxstackSafePathDisplay $CurrentDirectory)"
    }
    return $start
}

# The folder a walk candidate finally names, or $null when it cannot be read. A candidate that cannot be read is skipped,
# so one bad link cannot abort a run that would otherwise find its workspace.
function Get-MaxstackFinalOrNull {
    param([string] $Path)

    try {
        return Get-MaxstackFinalDirectory $Path
    }
    catch {
        return $null
    }
}

# A symbolic link or a junction: a reparse point. A marker that is one is not read, and a linked lock is refused by the
# destructive modes, so the folder is never identified, or written, through a link.
function Test-MaxstackLinkedPath {
    param([string] $Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    return ($null -ne $item) -and (([int] $item.Attributes -band [int] [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Test-MaxstackDriveRoot {
    param([string] $Path)

    $root = [IO.Path]::GetPathRoot($Path)
    return [IO.Path]::TrimEndingDirectorySeparator($Path) -ieq [IO.Path]::TrimEndingDirectorySeparator($root)
}

# The nearest folder from the current directory upward that holds a marker file. A marker must be a file, so a directory
# with a marker's name is not one. A folder inside .git, a layer cache, or a layer checkout is skipped, and the walk goes on.
function Find-MaxstackCwdMarker {
    param([string] $CurrentDirectory, [string] $RepoRoot)

    $cursor = [IO.DirectoryInfo]::new($CurrentDirectory)
    while ($null -ne $cursor) {
        if ((Test-MaxstackDriveRoot $cursor.FullName) -or (Test-MaxstackCheckoutLocation $cursor.FullName $RepoRoot)) {
            $cursor = $cursor.Parent
            continue
        }
        foreach ($name in $script:MaxstackMarkerNames) {
            if (-not (Test-Path -LiteralPath (Join-Path $cursor.FullName $name) -PathType Leaf)) { continue }
            if (Test-MaxstackLinkedPath (Join-Path $cursor.FullName $name)) { continue }
            $final = Get-MaxstackFinalOrNull $cursor.FullName
            if ($null -ne $final -and -not (Test-MaxstackInternalLocation $final)) {
                return [pscustomobject]@{ Path = $cursor.FullName; Marker = $name }
            }
            break
        }
        $cursor = $cursor.Parent
    }
    return $null
}

function Test-MaxstackDirectoryNamed {
    param($Directory, [string] $Name)

    return ($null -ne $Directory) -and ($Directory.Name -ieq $Name)
}

# The workspace a script's own location names: <workspace>\projects\repos\<repo>\scripts or <workspace>\projects\worktrees\<repo>\scripts.
# A result inside a checkout, a cache, or .git is not a workspace, so it is not returned.
function Get-MaxstackScriptLayoutWorkspace {
    param([string] $ScriptRoot, [string] $RepoRoot)

    Assert-MaxstackPathHasNoControlCharacters $ScriptRoot 'Script root'
    try { $fullScriptRoot = [IO.Path]::GetFullPath($ScriptRoot) }
    catch { throw "Script root is invalid: $(Get-MaxstackSafePathDisplay $ScriptRoot)" }
    $scriptDirectory = [IO.DirectoryInfo]::new($fullScriptRoot)
    if (-not (Test-MaxstackDirectoryNamed $scriptDirectory 'scripts')) { return $null }
    $repo = $scriptDirectory.Parent
    $layout = $null
    if ($null -ne $repo) { $layout = $repo.Parent }
    if ($null -eq $layout -or ($layout.Name -ine 'repos' -and $layout.Name -ine 'worktrees')) { return $null }
    $projects = $layout.Parent
    if (-not (Test-MaxstackDirectoryNamed $projects 'projects')) { return $null }
    $workspace = $projects.Parent
    if ($null -eq $workspace -or (Test-MaxstackInternalLocation $workspace.FullName)) { return $null }
    if (Test-MaxstackCheckoutLocation $workspace.FullName $RepoRoot) { return $null }
    if (Test-MaxstackDriveRoot $workspace.FullName) { return $null }
    return $workspace.FullName
}

function New-MaxstackResolution {
    param([string] $Workspace, [string] $Origin, [bool] $Warning, $Note = $null)

    return [pscustomobject]@{ Workspace = $Workspace; Origin = $Origin; Warning = $Warning; Note = $Note }
}

# The note when the script layout names a different workspace than the marker or environment target that won. The
# installer prints it once, after the resolved line.
function Get-MaxstackLayoutNote {
    param([string] $ScriptRoot, [string] $RepoRoot, [string] $Target, [string] $Origin)

    $layout = Get-MaxstackScriptLayoutWorkspace $ScriptRoot $RepoRoot
    if ($null -eq $layout -or -not (Test-Path -LiteralPath $layout -PathType Container)) { return $null }
    if ($layout -ieq $Target) { return $null }
    return "script layout names $(Get-MaxstackSafePathDisplay $layout); using $Origin $(Get-MaxstackSafePathDisplay $Target)"
}

# Discovery order: -Workspace, MAXSTACK_WORKSPACE, the nearest marker from the current directory upward, the script's own
# layout, then the legacy default with a warning. An explicit or environment value never falls through to a later source.
function Resolve-MaxstackWorkspace {
    [CmdletBinding()]
    param(
        [switch] $ExplicitSpecified,
        [AllowNull()][string] $ExplicitValue,
        [string] $CurrentDirectory = (Get-Location).Path,
        [string] $ScriptRoot = $PSScriptRoot,
        [AllowNull()][string] $LegacyWorkspace = $null
    )

    $repoRoot = Get-MaxstackRepoRoot $ScriptRoot
    if ($ExplicitSpecified) {
        if ([string]::IsNullOrWhiteSpace($ExplicitValue)) { throw '-Workspace was explicitly supplied but is empty.' }
        $target = Assert-MaxstackWorkspaceTarget (ConvertTo-MaxstackFullPath $ExplicitValue '-Workspace' $CurrentDirectory) '-Workspace' $repoRoot
        return New-MaxstackResolution $target '-Workspace' $false
    }

    $environmentWorkspace = [Environment]::GetEnvironmentVariable('MAXSTACK_WORKSPACE')
    if ($null -ne $environmentWorkspace) {
        if ([string]::IsNullOrWhiteSpace($environmentWorkspace)) { throw 'MAXSTACK_WORKSPACE is set but empty.' }
        $target = Assert-MaxstackWorkspaceTarget (ConvertTo-MaxstackFullPath $environmentWorkspace 'MAXSTACK_WORKSPACE' $CurrentDirectory) 'MAXSTACK_WORKSPACE' $repoRoot
        return New-MaxstackResolution $target 'MAXSTACK_WORKSPACE' $false (Get-MaxstackLayoutNote $ScriptRoot $repoRoot $target 'MAXSTACK_WORKSPACE')
    }

    $walkStart = Get-MaxstackWalkStart $CurrentDirectory
    $marker = if ($null -ne $walkStart) { Find-MaxstackCwdMarker $walkStart $repoRoot } else { $null }
    if ($null -ne $marker) {
        $target = Assert-MaxstackWorkspaceTarget $marker.Path "cwd marker $($marker.Marker)" $repoRoot
        return New-MaxstackResolution $target "cwd marker $($marker.Marker)" $false (Get-MaxstackLayoutNote $ScriptRoot $repoRoot $target "cwd marker $($marker.Marker)")
    }

    $layoutWorkspace = Get-MaxstackScriptLayoutWorkspace $ScriptRoot $repoRoot
    if ($null -ne $layoutWorkspace) {
        Assert-MaxstackPathText $layoutWorkspace 'script layout'
        if (Test-Path -LiteralPath $layoutWorkspace -PathType Container) {
            $target = Assert-MaxstackWorkspaceTarget $layoutWorkspace 'script layout' $repoRoot
            return New-MaxstackResolution $target 'script layout' $false
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($LegacyWorkspace)) {
        Assert-MaxstackPathText $LegacyWorkspace 'legacy default'
        if (Test-Path -LiteralPath $LegacyWorkspace -PathType Container) {
            $target = Assert-MaxstackWorkspaceTarget $LegacyWorkspace 'legacy default' $repoRoot
            return New-MaxstackResolution $target 'legacy default' $true
        }
    }

    throw 'Workspace discovery failed. Tried -Workspace, MAXSTACK_WORKSPACE, cwd marker (maxstack.settings.json or stack.lock.json), script layout (projects/repos/<repo> or projects/worktrees/<repo>), and legacy default.'
}
