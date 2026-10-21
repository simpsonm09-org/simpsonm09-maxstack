# platforms: windows, macOS, linux
# Cursor Agent Skills are copied by skill folder into the project root's .cursor/skills folder.
# Each folder is recorded as one owned path so apply, status, remove, and uninstall use the common lock lifecycle.

$script:CursorSkillFolder = '.cursor/skills'
# The Cursor gate hook: a version-1 .cursor/hooks.json whose beforeShellExecution command runs the installed adapter.
$script:CursorHookConfigPath = '.cursor/hooks.json'
$script:CursorHookDefinition = 'hooks/cursor-hooks.json'

function Get-CursorRecord {
    param([object[]] $Owned, [string] $Relative)

    return @($Owned | Where-Object { $null -ne $_ -and (Test-OrdinalEqual $_.path $Relative) -and (Test-OrdinalEqual $_.kind 'dir') -and (Test-OrdinalEqual (Get-Field $_ 'runtime') 'cursor') }) | Select-Object -First 1
}

function Assert-CursorSkillsPath {
    $cursor = Join-MaxstackPath $Workspace '.cursor'
    $root = Join-MaxstackPath $Workspace (ConvertTo-MaxstackPath $script:CursorSkillFolder)
    foreach ($path in @($cursor, $root)) {
        if (-not (Test-Path -LiteralPath $path)) { continue }
        if (Test-ReparsePoint $path) { throw "Cursor target '$path' is a link or reparse point, so nothing was written." }
        if (-not (Test-Path -LiteralPath $path -PathType Container)) { throw "Cursor target '$path' exists and is not a directory, so nothing was written." }
    }
}

function Assert-CursorDestinationWithinWorkspace {
    param([string] $Path)

    $workspaceFull = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($Workspace))
    $targetFull = [IO.Path]::GetFullPath($Path)
    $prefix = $workspaceFull + [IO.Path]::DirectorySeparatorChar
    $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    if (-not $targetFull.StartsWith($prefix, $comparison)) {
        throw "Cursor target '$targetFull' resolves outside the workspace, so nothing was written."
    }
    $relative = [IO.Path]::GetRelativePath($workspaceFull, $targetFull)
    $current = $workspaceFull
    foreach ($segment in $relative.Split([IO.Path]::DirectorySeparatorChar, [StringSplitOptions]::RemoveEmptyEntries)) {
        $current = Join-Path $current $segment
        if ((Test-Path -LiteralPath $current) -and (Test-ReparsePoint $current)) {
            throw "Cursor target '$current' is a link or reparse point, so nothing was written."
        }
    }
}

function Assert-CursorSkillName {
    param([string] $Name)

    if ([string]::IsNullOrEmpty($Name) -or (Test-OrdinalIn $Name @('.', '..')) -or $Name -match '[/\\<>:"|?*]' -or $Name -match '[. ]$' -or $Name -match '[\x00-\x1f]') {
        throw "Cursor skill folder '$Name' is not a safe path segment, so nothing was written."
    }
    if ($Name -match '^(?i:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$') {
        throw "Cursor skill folder '$Name' is a reserved Windows device name, so nothing was written."
    }
}

function Assert-CursorSkillTargets {
    param([object[]] $Skills, [object[]] $Owned)

    $root = Join-MaxstackPath $Workspace (ConvertTo-MaxstackPath $script:CursorSkillFolder)
    Assert-CursorSkillsPath
    $wanted = @($Skills | ForEach-Object { Assert-CursorSkillName $_.name; "$script:CursorSkillFolder/$($_.name)" })
    foreach ($record in @($Owned | Where-Object { $null -ne $_ -and (Test-OrdinalEqual (Get-Field $_ 'runtime') 'cursor') -and (Test-OrdinalEqual $_.kind 'dir') })) {
        $relative = $record.path.Replace('\', '/')
        $prefix = "$script:CursorSkillFolder/"
        if (-not $relative.StartsWith($prefix, [StringComparison]::Ordinal)) {
            throw "Cursor ownership path '$($record.path)' is outside $script:CursorSkillFolder, so nothing was written."
        }
        $name = $relative.Substring($prefix.Length)
        Assert-CursorSkillName $name
        $full = Join-MaxstackPath $Workspace (ConvertTo-MaxstackPath $record.path)
        Assert-CursorDestinationWithinWorkspace $full
    }
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { return }
    $existing = @(Get-ChildItem -LiteralPath $root -Force)
    foreach ($skill in $Skills) {
        $same = @($existing | Where-Object { Test-OrdinalEqualIgnoreCase $_.Name $skill.name })
        if ($same.Count -eq 0) { continue }
        $relative = "$script:CursorSkillFolder/$($same[0].Name)"
        $path = Join-MaxstackPath $Workspace (ConvertTo-MaxstackPath $relative)
        Assert-CursorDestinationWithinWorkspace $path
        if (Test-ReparsePoint $path) { throw "Cursor target '$path' is a link or reparse point, so nothing was written." }
        $record = Get-CursorRecord -Owned $Owned -Relative $relative
        if ($null -eq $record) {
            throw "$relative already exists and maxstack did not write it, so nothing was written. Move it aside, then rerun -Apply."
        }
        if (-not (Test-Path -LiteralPath $path -PathType Container)) {
            throw "$relative exists as a file, not an owned skill directory, so nothing was written. Move it aside, then rerun -Apply."
        }
        if (-not (Test-OrdinalEqual $same[0].Name $skill.name)) {
            throw "$relative collides with cursor skill '$($skill.name)' by case, so nothing was written. Rename one of the skills."
        }
        if (-not (Test-OrdinalEqual (Get-TreeSha256 $same[0].FullName) $record.sha256)) {
            Write-Host "Kept ${relative}: it changed since the last apply."
            $skill | Add-Member -NotePropertyName preserve -NotePropertyValue $true -Force
            $skill | Add-Member -NotePropertyName prior -NotePropertyValue $record -Force
        }
    }
}

function Write-CursorSkills {
    param([object[]] $Skills, [object[]] $Owned, [bool] $RemoveStale = $true)

    $wanted = @($Skills | ForEach-Object { "$script:CursorSkillFolder/$($_.name)" })
    if ($RemoveStale) {
        foreach ($record in @($Owned | Where-Object { $null -ne $_ -and (Test-OrdinalEqual (Get-Field $_ 'runtime') 'cursor') -and (Test-OrdinalEqual $_.kind 'dir') -and -not (Test-OrdinalIn $_.path $wanted) })) {
            $full = Join-MaxstackPath $Workspace (ConvertTo-MaxstackPath $record.path)
            Assert-CursorDestinationWithinWorkspace $full
            if (Test-ReparsePoint $full) {
                Write-Host "Kept $($record.path): it is a link or reparse point"
                continue
            }
            if (-not (Test-Path -LiteralPath $full -PathType Container)) { continue }
            if (-not (Test-OrdinalEqual (Get-TreeSha256 $full) $record.sha256)) {
                Write-Host "Kept $($record.path): it changed since the last apply, and no layer ships it now"
                continue
            }
            Remove-OwnedTree $full
            Write-Host "Removed the cursor skill $($record.path): no layer ships it now"
        }
    }
    foreach ($skill in $Skills) {
        if (Test-IsTrue (Get-Field $skill 'preserve')) { continue }
        $full = Join-MaxstackPath $Workspace (ConvertTo-MaxstackPath "$script:CursorSkillFolder/$($skill.name)")
        Assert-CursorDestinationWithinWorkspace $full
        Remove-OwnedTree $full
        Copy-SkillTree -Source $skill.source -Destination $full
        Write-Host "Copied cursor skill '$($skill.name)' from layer '$($skill.layer)' into $full"
    }
}

# The Cursor gate hook plan, owned like the Codex config: a changed copy or one maxstack did not write is kept.
function Get-CursorHookConfigPlan {
    param([object[]] $Layers)

    return Get-GateHookConfigPlan -Layers $Layers -Runtime 'cursor' -Relative $script:CursorHookConfigPath -Definition $script:CursorHookDefinition -Label 'Cursor'
}
