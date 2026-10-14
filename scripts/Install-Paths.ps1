# Platform path rules. Text identifiers still use Install-Ordinal.ps1; only filesystem paths use these helpers.
# On macOS and Linux identity is ordinal and case-sensitive. A macOS volume may still be case-insensitive.

function Get-MaxstackPathPlatform {
    param([string] $Platform = '')

    if ($Platform) { return $Platform }
    if ($IsWindows) { return 'Windows' }
    if ($IsMacOS) { return 'macOS' }
    return 'Linux'
}

function ConvertTo-MaxstackPath {
    param([string] $Path, [string] $Platform = '')

    $platformName = Get-MaxstackPathPlatform $Platform
    if (Test-OrdinalEqualIgnoreCase $platformName 'Windows') { return $Path.Replace('/', '\') }
    return $Path
}

function Join-MaxstackPath {
    param([string] $Parent, [string] $Child, [string] $Platform = '')

    $normalized = ConvertTo-MaxstackPath $Child $Platform
    if (Test-MaxstackAbsolutePath $normalized $Platform) { return $normalized }
    $platformName = Get-MaxstackPathPlatform $Platform
    $separator = if (Test-OrdinalEqualIgnoreCase $platformName 'Windows') { '\' } else { '/' }
    $parentPath = Trim-MaxstackPathEndingSeparator $Parent $platformName
    if ($parentPath.EndsWith($separator, [StringComparison]::Ordinal)) { return $parentPath + $normalized }
    return $parentPath + $separator + $normalized
}

function Trim-MaxstackPathEndingSeparator {
    param([string] $Path, [string] $Platform = '')

    $platformName = Get-MaxstackPathPlatform $Platform
    $normalized = ConvertTo-MaxstackPath $Path $platformName
    $separators = if (Test-OrdinalEqualIgnoreCase $platformName 'Windows') { [char[]] @('\', '/') } else { [char[]] @('/') }
    $trimmed = $normalized.TrimEnd($separators)
    if (-not $trimmed) {
        if (Test-OrdinalEqualIgnoreCase $platformName 'Windows') { return '\' }
        return '/'
    }
    if ((Test-OrdinalEqualIgnoreCase $platformName 'Windows') -and $trimmed -match '^[A-Za-z]:$') { return "$trimmed\" }
    return $trimmed
}

function ConvertTo-MaxstackLockPath {
    param([string] $Path, [string] $Platform = '')

    if (Test-OrdinalEqualIgnoreCase (Get-MaxstackPathPlatform $Platform) 'Windows') { return $Path.Replace('\', '/') }
    return $Path
}

function Test-MaxstackAbsolutePath {
    param([string] $Path, [string] $Platform = '')

    if ([string]::IsNullOrEmpty($Path)) { return $false }
    $platformName = Get-MaxstackPathPlatform $Platform
    if (Test-OrdinalEqualIgnoreCase $platformName 'Windows') {
        return $Path -match '^[A-Za-z]:[\\/]' -or $Path -match '^[\\/]{2}[^\\/]'
    }
    return $Path.StartsWith('/', [StringComparison]::Ordinal)
}

function Test-MaxstackPathEqual {
    param([string] $Left, [string] $Right, [string] $Platform = '')

    if ([string]::IsNullOrEmpty($Left) -or [string]::IsNullOrEmpty($Right)) { return $false }
    $platformName = Get-MaxstackPathPlatform $Platform
    $comparison = if (Test-OrdinalEqualIgnoreCase $platformName 'Windows') { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    $normalizedLeft = Trim-MaxstackPathEndingSeparator $Left $platformName
    $normalizedRight = Trim-MaxstackPathEndingSeparator $Right $platformName
    return [string]::Equals($normalizedLeft, $normalizedRight, $comparison)
}

function Test-MaxstackPathInside {
    param([string] $Child, [string] $Parent, [string] $Platform = '')

    if ([string]::IsNullOrEmpty($Child) -or [string]::IsNullOrEmpty($Parent)) { return $false }
    $platformName = Get-MaxstackPathPlatform $Platform
    $separator = if (Test-OrdinalEqualIgnoreCase $platformName 'Windows') { '\' } else { '/' }
    $trimmedParent = Trim-MaxstackPathEndingSeparator $Parent $platformName
    $trimmedChild = Trim-MaxstackPathEndingSeparator $Child $platformName
    if (Test-MaxstackPathEqual $trimmedChild $trimmedParent $platformName) { return $true }
    if ($trimmedParent.EndsWith($separator, [StringComparison]::Ordinal) -or ((Test-OrdinalEqualIgnoreCase $platformName 'Windows') -and $trimmedParent -match '^[A-Za-z]:\\$')) { $prefix = $trimmedParent }
    else { $prefix = $trimmedParent + $separator }
    return $trimmedChild.StartsWith($prefix, $(if (Test-OrdinalEqualIgnoreCase $platformName 'Windows') { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }))
}

function Resolve-MaxstackOpenCodePermissions {
    param([object[]] $Permissions, [string] $Workspace, [string] $Platform = '')

    $platformName = Get-MaxstackPathPlatform $Platform
    $workspacePath = ConvertTo-MaxstackLockPath $Workspace
    $workspaceWslPath = $null
    if ((Test-OrdinalEqualIgnoreCase $platformName 'Windows') -and $Workspace -match '^[A-Za-z]:[\\/]') {
        $workspaceWslPath = '/mnt/' + $Workspace.Substring(0, 1).ToLowerInvariant() + $Workspace.Substring(2).Replace('\', '/')
    }
    foreach ($permission in @($Permissions)) {
        $resource = $permission.resource
        if (Test-OrdinalEqual $resource '__MAXSTACK_WORKSPACE__/.opencode/*') {
            $permission.resource = "$workspacePath/.opencode/*"
            $permission
        } elseif (Test-OrdinalEqual $resource '__MAXSTACK_WORKSPACE_WSL__/.opencode/*') {
            if ($workspaceWslPath) {
                $permission.resource = "$workspaceWslPath/.opencode/*"
                $permission
            }
        } else { $permission }
    }
}

function Get-MaxstackRelativePath {
    param([string] $BasePath, [string] $TargetPath, [string] $Platform = '')

    $platformName = Get-MaxstackPathPlatform $Platform
    $windows = Test-OrdinalEqualIgnoreCase $platformName 'Windows'
    $separator = if ($windows) { '\' } else { '/' }
    $base = ConvertTo-MaxstackPath $BasePath $platformName
    $target = ConvertTo-MaxstackPath $TargetPath $platformName
    if (-not (Test-MaxstackAbsolutePath $base $platformName) -or -not (Test-MaxstackAbsolutePath $target $platformName)) {
        return ConvertTo-MaxstackLockPath ([IO.Path]::GetRelativePath($BasePath, $TargetPath))
    }
    if ($windows) {
        $baseRoot = [regex]::Match($base, '^(?:[A-Za-z]:|\\\\[^\\]+\\[^\\]+)')
        $targetRoot = [regex]::Match($target, '^(?:[A-Za-z]:|\\\\[^\\]+\\[^\\]+)')
        if (-not [string]::Equals($baseRoot.Value, $targetRoot.Value, [StringComparison]::OrdinalIgnoreCase)) { return ConvertTo-MaxstackLockPath $target }
    }
    $baseParts = @($base -split [regex]::Escape($separator) | Where-Object { $_ })
    $targetParts = @($target -split [regex]::Escape($separator) | Where-Object { $_ })
    $comparison = if ($windows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    $common = 0
    while ($common -lt $baseParts.Count -and $common -lt $targetParts.Count -and [string]::Equals($baseParts[$common], $targetParts[$common], $comparison)) { $common++ }
    $relativeParts = @()
    for ($index = $common; $index -lt $baseParts.Count; $index++) { $relativeParts += '..' }
    for ($index = $common; $index -lt $targetParts.Count; $index++) { $relativeParts += $targetParts[$index] }
    return $relativeParts -join '/'
}
