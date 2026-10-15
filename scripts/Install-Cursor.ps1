# platforms: windows, macOS, linux
# Cursor Agent Skills are copied by skill folder into the project root's .cursor/skills folder.
# Each folder is recorded as one owned path so apply, status, remove, and uninstall use the common lock lifecycle.

$script:CursorSkillFolder = '.cursor/skills'

function Get-CursorRecord {
    param([object[]] $Owned, [string] $Relative)

    return @($Owned | Where-Object { $null -ne $_ -and (Test-OrdinalEqual $_.path $Relative) -and (Test-OrdinalEqual $_.kind 'dir') -and (Test-OrdinalEqual (Get-Field $_ 'runtime') 'cursor') }) | Select-Object -First 1
}

function Assert-CursorSkillTargets {
    param([object[]] $Skills, [object[]] $Owned)

    $root = Join-MaxstackPath $Workspace (ConvertTo-MaxstackPath $script:CursorSkillFolder)
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { return }
    $existing = @(Get-ChildItem -LiteralPath $root -Directory -Force)
    foreach ($skill in $Skills) {
        $same = @($existing | Where-Object { Test-OrdinalEqualIgnoreCase $_.Name $skill.name })
        if ($same.Count -eq 0) { continue }
        $relative = "$script:CursorSkillFolder/$($same[0].Name)"
        $record = Get-CursorRecord -Owned $Owned -Relative $relative
        if ($null -eq $record) {
            throw "$relative already exists and maxstack did not write it, so nothing was written. Move it aside, then rerun -Apply."
        }
        if (-not (Test-OrdinalEqual $same[0].Name $skill.name)) {
            throw "$relative collides with cursor skill '$($skill.name)' by case, so nothing was written. Rename one of the skills."
        }
        if ((Test-ReparsePoint $same[0].FullName) -or -not (Test-OrdinalEqual (Get-TreeSha256 $same[0].FullName) $record.sha256)) {
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
            if (-not (Test-Path -LiteralPath $full -PathType Container)) { continue }
            if ((Test-ReparsePoint $full) -or -not (Test-OrdinalEqual (Get-TreeSha256 $full) $record.sha256)) {
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
        Remove-OwnedTree $full
        Copy-SkillTree -Source $skill.source -Destination $full
        Write-Host "Copied cursor skill '$($skill.name)' from layer '$($skill.layer)' into $full"
    }
}
