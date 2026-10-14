# platforms: windows
# Filesystem link policy. Link paths are inspected and removed without walking into their targets.

function Get-MaxstackLinkRecordKind {
    param([string] $Platform = '')

    if (Test-OrdinalEqualIgnoreCase (Get-MaxstackPathPlatform $Platform) 'Windows') { return 'junction' }
    return 'symlink'
}

function Test-MaxstackLinkRecordKind {
    param([string] $Kind)

    return (Test-OrdinalIn $Kind @('junction', 'symlink'))
}

function Get-MaxstackLinkKind {
    param([string] $Path, [string] $Platform = '')

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return $null }
    $platformName = Get-MaxstackPathPlatform $Platform
    if (Test-OrdinalEqualIgnoreCase $platformName 'Windows') {
        if (Test-OrdinalEqual $item.LinkType 'Junction') { return 'junction' }
        if (Test-OrdinalEqual $item.LinkType 'SymbolicLink') { return 'symlink' }
        if ([bool]([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint)) { return 'junction' }
        return $null
    }
    if ($null -ne $item.LinkTarget -or [bool]([IO.File]::GetAttributes($Path) -band [IO.FileAttributes]::ReparsePoint)) { return 'symlink' }
    return $null
}

function Test-MaxstackLink {
    param([string] $Path, [string] $Platform = '')

    return ($null -ne (Get-MaxstackLinkKind -Path $Path -Platform $Platform))
}

function Get-MaxstackLinkTarget {
    param([string] $Path)

    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    $target = [string] (@($item.Target)[0])
    if (-not $target) { $target = [string] $item.LinkTarget }
    foreach ($prefix in @('\?\', '\??\')) {
        if ($target.StartsWith($prefix, [StringComparison]::Ordinal)) { $target = $target.Substring($prefix.Length) }
    }
    return $target.TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
}

function Test-MaxstackLinkTarget {
    param([string] $Path, [string] $Target, [string] $Kind = '', [string] $Platform = '')

    if (-not (Test-MaxstackLink -Path $Path -Platform $Platform)) { return $false }
    if ($Kind -and -not (Test-OrdinalEqual (Get-MaxstackLinkKind -Path $Path -Platform $Platform) $Kind)) { return $false }
    $linked = Get-MaxstackLinkTarget -Path $Path
    if (-not $linked) { return $false }
    if (-not (Test-MaxstackAbsolutePath $linked $Platform)) {
        $linked = Join-MaxstackPath ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path))) $linked $Platform
    }
    $expected = [IO.Path]::GetFullPath($Target)
    $actual = [IO.Path]::GetFullPath($linked)
    return (Test-MaxstackPathEqual $actual $expected $Platform)
}

function New-MaxstackDirectoryLink {
    param([string] $Path, [string] $Target, [string] $Platform = '')

    if (Test-OrdinalEqualIgnoreCase (Get-MaxstackPathPlatform $Platform) 'Windows') {
        New-Item -ItemType Junction -Path $Path -Target $Target -ErrorAction Stop | Out-Null
    } else {
        New-Item -ItemType SymbolicLink -Path $Path -Target $Target -ErrorAction Stop | Out-Null
    }
}

function Remove-MaxstackLink {
    param([string] $Path, [string] $Platform = '')

    if (-not (Test-MaxstackLink -Path $Path -Platform $Platform)) { return }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if ($item.PSIsContainer) { [IO.Directory]::Delete($Path, $false) }
    else { [IO.File]::Delete($Path) }
}
