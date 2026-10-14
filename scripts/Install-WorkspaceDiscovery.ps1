# platforms: windows
#requires -Version 7.0
Set-StrictMode -Version Latest
# The ordinal helpers, which every comparison here uses. A driver that loads this file alone still has them.
. (Join-Path $PSScriptRoot 'Install-Ordinal.ps1')
. (Join-Path $PSScriptRoot 'Install-Paths.ps1')

# A user value is refused by its text when it holds a control, a format character, a line or paragraph separator, or an
# unpaired surrogate. A value of the boundary kind names the character that failed, shown escaped.
function Assert-MaxstackPathHasNoControlCharacters {
    param([string] $Path, [string] $Name)

    $index = Find-BoundaryIndex $Path
    if ($index -lt 0) { return }
    $character = $Path[$index]
    $shown = ConvertTo-SafeName $Path
    if ([char]::IsSurrogate($character)) { throw "$Name path contains a character that reorders or splits a line: $shown. Give a plain path." }
    $category = [Globalization.CharUnicodeInfo]::GetUnicodeCategory($character)
    if ($category -eq [Globalization.UnicodeCategory]::Control) { throw "$Name path contains control characters: $shown" }
    $code = [int] $character
    $bidi = (($code -ge 0x202A) -and ($code -le 0x202E)) -or (($code -ge 0x2066) -and ($code -le 0x2069))
    if (($category -eq [Globalization.UnicodeCategory]::Format) -and -not $bidi) { throw "$Name path contains a format character, which a path may not hold: $shown. Give a plain path." }
    throw "$Name path contains a character that reorders or splits a line: $shown. Give a plain path."
}

# The marker files that name a workspace, in the order a folder is checked.
$script:MaxstackMarkerNames = @('maxstack.settings.json', 'stack.lock.json')

# Refuses a path by its text before any filesystem call. A device prefix and a UNC path would reach the network or a
# device, and an 8.3 short name would name the workspace by a name the lock does not record.
function Assert-MaxstackPathText {
    param([string] $Path, [string] $Name)

    Assert-MaxstackPathHasNoControlCharacters $Path $Name
    $safePath = ConvertTo-SafeName $Path
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
    $literal = @(Get-ChildItem -LiteralPath $Parent -Force | Where-Object { (Test-OrdinalEqual $_.Name $Segment) })
    return $literal.Count -eq 0
}

# The 8.3 rule applies to a path the user supplied, because a short name would record a name the lock does not hold.
function Assert-MaxstackShortNames {
    param([string] $FullPath, [string] $Name)

    $prefix = ''
    foreach ($segment in ($FullPath -split '[\\/]')) {
        if ((Test-OrdinalEqual $segment '')) { continue }
        if ((-not (Test-OrdinalEqual $prefix '')) -and (Test-MaxstackShortNameSegment $prefix $segment)) {
            throw "$Name path has an 8.3 short name ($(ConvertTo-SafeName $segment)): $(ConvertTo-SafeName $FullPath). Give the long path."
        }
        $prefix = if ((Test-OrdinalEqual $prefix '')) { "$segment\" } else { "$prefix$segment\" }
    }
}

# A folder under .git, under a layer cache (.claude\cache), or under a layer checkout (projects\repos, projects\worktrees)
# is never a workspace: a write there would change git metadata, a cache, or a checkout.
function Test-MaxstackInternalLocation {
    param([string] $Path)

    $segments = @($Path -split '[\\/]' | Where-Object { (-not (Test-OrdinalEqual $_ '')) })
    for ($index = 0; $index -lt $segments.Count; $index++) {
        if (Test-OrdinalEqualIgnoreCase $segments[$index] '.git') { return $true }
        if ($index + 1 -lt $segments.Count -and (Test-MaxstackSegmentPair $segments[$index] $segments[$index + 1])) { return $true }
    }
    return $false
}

function Test-MaxstackSegmentPair {
    param([string] $First, [string] $Second)

    if ((Test-OrdinalEqualIgnoreCase $First '.claude') -and (Test-OrdinalEqualIgnoreCase $Second 'cache')) { return $true }
    return (Test-OrdinalEqualIgnoreCase $First 'projects') -and ((Test-OrdinalEqualIgnoreCase $Second 'repos') -or (Test-OrdinalEqualIgnoreCase $Second 'worktrees'))
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
    return Test-MaxstackPathInside -Child $Path -Parent $Root
}

# A maxstack checkout holds the layer manifest and this installer. Its own workspace folder is named workspace.
function Test-MaxstackCheckout {
    param([string] $Folder)

    if ([string]::IsNullOrEmpty($Folder)) { return $false }
    # [IO.Path]::Combine, not Join-Path: Join-MaxstackPath raises an error on a drive that is not present, and a missing drive is not a checkout.
    return (Test-Path -LiteralPath ([IO.Path]::Combine($Folder, 'layers.json')) -PathType Leaf) -and
        (Test-Path -LiteralPath ([IO.Path]::Combine($Folder, 'scripts', 'Install-Workspace.ps1')) -PathType Leaf)
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
    return (Test-OrdinalEqualIgnoreCase $leaf 'workspace') -and (Test-MaxstackCheckout $parent)
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
    param([string] $Path, [string] $Name, [string] $CurrentDirectory, [string] $Platform = '')

    Assert-MaxstackPathText $Path $Name
    $safePath = ConvertTo-SafeName $Path
    $platformName = Get-MaxstackPathPlatform $Platform
    if ((Test-OrdinalEqualIgnoreCase $platformName 'Windows') -and [IO.Path]::IsPathRooted($Path) -and -not [IO.Path]::IsPathFullyQualified($Path)) {
        # C:ws resolves against the process location of drive C, and \ws against the drive of the process location.
        $kind = if ($Path -match '^[A-Za-z]:') { 'drive-relative' } else { 'root-relative' }
        throw "$Name path is $kind, so it would resolve against the process location: $safePath. Give a full path with a drive letter."
    }
    if (-not (Test-MaxstackAbsolutePath $Path $platformName)) {
        $Path = Join-MaxstackPath (Get-MaxstackCurrentDirectory $CurrentDirectory $Name) $Path
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
    $safePath = ConvertTo-SafeName $Path
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
        throw "$Source target is inside a git directory, a layer checkout, or a layer cache: $(ConvertTo-SafeName $final)"
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

    if (-not (Test-OrdinalEqual ((Get-Location).Provider.Name) 'FileSystem')) { return $null }
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
        throw "$Name path is relative, and the current directory cannot resolve it: $(ConvertTo-SafeName $CurrentDirectory)"
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
    return Test-MaxstackPathEqual ([IO.Path]::TrimEndingDirectorySeparator($Path)) ([IO.Path]::TrimEndingDirectorySeparator($root))
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
            if (-not (Test-Path -LiteralPath (Join-MaxstackPath $cursor.FullName $name) -PathType Leaf)) { continue }
            if (Test-MaxstackLinkedPath (Join-MaxstackPath $cursor.FullName $name)) { continue }
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

    return ($null -ne $Directory) -and (Test-OrdinalEqualIgnoreCase $Directory.Name $Name)
}

# The workspace a script's own location names: <workspace>\projects\repos\<repo>\scripts or <workspace>\projects\worktrees\<repo>\scripts.
# A result inside a checkout, a cache, or .git is not a workspace, so it is not returned.
function Get-MaxstackScriptLayoutWorkspace {
    param([string] $ScriptRoot, [string] $RepoRoot)

    Assert-MaxstackPathHasNoControlCharacters $ScriptRoot 'Script root'
    try { $fullScriptRoot = [IO.Path]::GetFullPath($ScriptRoot) }
    catch { throw "Script root is invalid: $(ConvertTo-SafeName $ScriptRoot)" }
    $scriptDirectory = [IO.DirectoryInfo]::new($fullScriptRoot)
    if (-not (Test-MaxstackDirectoryNamed $scriptDirectory 'scripts')) { return $null }
    $repo = $scriptDirectory.Parent
    $layout = $null
    if ($null -ne $repo) { $layout = $repo.Parent }
    if ($null -eq $layout -or ((-not (Test-OrdinalEqualIgnoreCase $layout.Name 'repos')) -and (-not (Test-OrdinalEqualIgnoreCase $layout.Name 'worktrees')))) { return $null }
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
    if (Test-OrdinalEqualIgnoreCase $layout $Target) { return $null }
    return "script layout names $(ConvertTo-SafeName $layout); using $Origin $(ConvertTo-SafeName $Target)"
}

# Discovery order: -Workspace, MAXSTACK_WORKSPACE, the nearest marker from the current directory upward, then the script's own
# layout. An explicit or environment value never falls through to a later source.
function Resolve-MaxstackWorkspace {
    [CmdletBinding()]
    param(
        [switch] $ExplicitSpecified,
        [AllowNull()][string] $ExplicitValue,
        [string] $CurrentDirectory = (Get-Location).Path,
        [string] $ScriptRoot = $PSScriptRoot,
        [string] $Platform = ''
    )

    $repoRoot = Get-MaxstackRepoRoot $ScriptRoot
    if ($ExplicitSpecified) {
        if ([string]::IsNullOrWhiteSpace($ExplicitValue)) { throw '-Workspace was explicitly supplied but is empty.' }
        $target = Assert-MaxstackWorkspaceTarget (ConvertTo-MaxstackFullPath $ExplicitValue '-Workspace' $CurrentDirectory $Platform) '-Workspace' $repoRoot
        return New-MaxstackResolution $target '-Workspace' $false
    }

    $environmentWorkspace = [Environment]::GetEnvironmentVariable('MAXSTACK_WORKSPACE')
    if ($null -ne $environmentWorkspace) {
        if ([string]::IsNullOrWhiteSpace($environmentWorkspace)) { throw 'MAXSTACK_WORKSPACE is set but empty.' }
        $target = Assert-MaxstackWorkspaceTarget (ConvertTo-MaxstackFullPath $environmentWorkspace 'MAXSTACK_WORKSPACE' $CurrentDirectory $Platform) 'MAXSTACK_WORKSPACE' $repoRoot
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

    throw 'Workspace discovery failed. Name a workspace with -Workspace, MAXSTACK_WORKSPACE, a cwd marker (maxstack.settings.json or stack.lock.json), or the script layout (projects/repos/<repo> or projects/worktrees/<repo>).'
}
