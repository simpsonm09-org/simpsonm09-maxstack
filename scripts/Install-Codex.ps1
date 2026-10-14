# platforms: windows
Set-StrictMode -Version Latest
# The codex runtime. Codex reads a skill from .agents\skills\<folder name>\SKILL.md, so each selected layer's skill folder
# is copied there under its own name. The rules are the generator's, scripts/lib/layers.mjs and scripts/lib/plan.mjs: a
# skill is a folder with a SKILL.md whose frontmatter name equals the folder and whose description is set, names are
# letters, digits, and hyphens, two layers cannot share a name even by case, and a model key, a link, or a second
# skill of the same name is refused. Every folder is an ownership record of the codex runtime, so -Remove and
# -Uninstall delete only what this file wrote. A folder maxstack did not write is never overwritten or deleted.

$script:CodexSkillFolder = '.agents/skills'
$script:CodexLaunchLine = 'Codex: start the T3 Codex (maxstack) instance with Launch arguments: -c ''project_root_markers=["stack.lock.json"]''. See docs/t3-setup.md#codex-maxstack.'
# A layer's installed copy is its opencode plugin folder. A Codex gate hook lives inside that copy, so the gate line can
# only be generated when the opencode runtime is selected too. The rule for a Codex gate hook is the two files below, which
# is how the org layer's adapter ships. scripts/codex-hook-trust.mjs reads the hook key, hash, and trust from Codex itself.
$script:CodexGateFolder = '.opencode/plugins'
$script:CodexGateHookRelative = 'hooks/pre-tool-use.mjs'
$script:CodexGateLibRelative = 'hooks/lib/codex.mjs'
$script:CodexGateScript = 'codex-hook-trust.mjs'
$script:CodexPasteNote = 'Codex: paste that line into the Launch arguments of the T3 "Codex (maxstack)" instance, and paste it again whenever this installer prints a different one. See docs/t3-setup.md#codex-maxstack.'
$script:CodexGateOneNote = 'Codex: only one gate hook is supported for now, so only the first layer with a Codex hook is used.'
$script:CodexGateAuditNote = 'Codex: a gate Launch-arguments line would be generated because a selected layer ships a Codex hook. Run -Apply to generate it.'
$script:CodexGateRuntimeNote = 'Codex: a gate hook lives inside the layer''s installed copy under .opencode\plugins, so select the opencode runtime with codex to generate the gate line.'

# Reads a SKILL.md frontmatter the way the generator does: the block between the first two --- lines, one key per line.
# A key that is not name or description is read and kept, so a model key is found and refused by the caller.
function Read-CodexSkillFields {
    param([string] $Path, [string] $Label)

    $text = [IO.File]::ReadAllText($Path)
    $lines = @($text.TrimStart([char] 0xFEFF) -split '\r?\n')
    $end = [Array]::IndexOf($lines, '---', 1)
    if ($lines.Count -eq 0 -or -not (Test-OrdinalEqual $lines[0] '---') -or $end -lt 1) { throw "$Label needs a --- frontmatter block." }
    $fields = [hashtable]::new([StringComparer]::Ordinal)
    for ($index = 1; $index -lt $end; $index++) {
        $match = [regex]::Match($lines[$index], '^([A-Za-z][\w-]*):\s*(.*)$')
        if (-not $match.Success) { continue }
        $value = $match.Groups[2].Value.Trim()
        $quoted = [regex]::Match($value, '^(["''])(.*)\1$')
        if ($quoted.Success) { $value = $quoted.Groups[2].Value }
        $fields[$match.Groups[1].Value] = $value
    }
    return $fields
}

# Every entry of a skill folder, with links listed and never followed. A link anywhere in the skill is refused.
function Assert-CodexSkillFolder {
    param([string] $Folder, [string] $Label)

    if (Test-ReparsePoint $Folder) { throw "$Label is a symbolic link or junction, so codex cannot take it. Replace it with a folder." }
    foreach ($entry in @(Get-TreeEntries -Root $Folder -Rule 'owned')) {
        if ($null -ne $entry.link) { throw "$Label holds a symbolic link or junction at $($entry.relative), which a skill may not hold." }
    }
}

# The frontmatter a skill must carry. A model key is refused, since maxstack sets no model. A missing name or description is refused.
function Assert-CodexSkillFields {
    param([string] $Path, [string] $Name, [string] $Label)

    $fields = Read-CodexSkillFields -Path $Path -Label $Label
    if ($fields.ContainsKey('model')) { throw "$Label`: frontmatter model is not allowed; maxstack sets no model." }
    if (-not (Test-NonEmptyString $fields['name'])) { throw "$Label`: frontmatter name is missing or empty." }
    if (-not (Test-OrdinalEqual $fields['name'] $Name)) { throw "$Label`: frontmatter name '$($fields['name'])' must equal the folder name '$Name'." }
    if (-not (Test-NonEmptyString $fields['description'])) { throw "$Label`: frontmatter description is missing or empty." }
}

# Copies a skill folder, leaving out node_modules at any depth, as the generator does. The copy hashes like its source.
function Copy-CodexSkillTree {
    param([string] $Source, [string] $Destination)

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    foreach ($child in @(Get-ChildItem -LiteralPath $Source -Force)) {
        if (Test-OrdinalEqual $child.Name 'node_modules') { continue }
        $target = Join-Path $Destination $child.Name
        if ($child.PSIsContainer) { Copy-CodexSkillTree -Source $child.FullName -Destination $target }
        else { Copy-Item -LiteralPath $child.FullName -Destination $target -Force }
    }
}

# The skills the selected codex layers contribute, in layer order. Each entry names the skill, its layer, its source folder,
# and the owned hash its installed copy will hold. A layer whose root is not known yet (a pinned cache not at its pin) adds
# nothing, so only audit sees it, and its records read as drifted until an apply syncs it.
function Get-CodexSkills {
    param([object[]] $Layers)

    $skills = [System.Collections.Generic.List[object]]::new()
    $claimed = [hashtable]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($layer in @($Layers | Where-Object { $_.runtimes.ContainsKey('codex') })) {
        if ($null -eq $layer.root) { continue }
        $skillsRoot = Join-Path $layer.root 'skills'
        if (-not (Test-Path -LiteralPath $skillsRoot -PathType Container)) { continue }
        if (Test-ReparsePoint $skillsRoot) { throw "Layer '$($layer.name)' has a symbolic link or junction at skills, which codex cannot read." }
        $names = [System.Collections.Generic.List[string]]::new()
        foreach ($child in @(Get-ChildItem -LiteralPath $skillsRoot -Force)) {
            if ($child.Name.StartsWith('.', [StringComparison]::Ordinal)) { continue }
            if (-not $child.PSIsContainer) { Write-Warning "ignored skills/$($child.Name) in layer '$($layer.name)': not a skill folder"; continue }
            $names.Add($child.Name)
        }
        $seen = [hashtable]::new([StringComparer]::OrdinalIgnoreCase)
        foreach ($name in $names) {
            if ($seen.ContainsKey($name)) { throw "Layer '$($layer.name)' has skill folders whose names differ only by case, which codex cannot tell apart: $($seen[$name]) and $name." }
            $seen[$name] = $name
        }
        foreach ($name in (Sort-Utf8 $names.ToArray())) {
            $label = "Layer '$($layer.name)' skill '$name'"
            if (-not [regex]::IsMatch($name, '^[A-Za-z0-9][A-Za-z0-9-]*\z')) { throw "$label`: skill folder names must be letters, digits, and hyphens." }
            $folder = Join-Path $skillsRoot $name
            Assert-CodexSkillFolder -Folder $folder -Label $label
            $skillFile = @(Get-ChildItem -LiteralPath $folder -File -Force | Where-Object { Test-OrdinalEqual $_.Name 'SKILL.md' })
            if ($skillFile.Count -eq 0) { throw "$label`: a file named exactly SKILL.md is required." }
            Assert-CodexSkillFields -Path $skillFile[0].FullName -Name $name -Label $label
            if ($claimed.ContainsKey($name)) {
                throw "duplicate skill $name across layers: $($claimed[$name]) and $($layer.name) both name it, and codex finds a skill by its folder name. Rename one of them."
            }
            $claimed[$name] = $layer.name
            $skills.Add([pscustomobject]@{ name = $name; layer = $layer.name; source = $folder; sha256 = (Get-TreeSha256 $folder) })
        }
    }
    return $skills.ToArray()
}

# Whether a path under .agents\skills is one the lock records as codex's own folder, with the record.
function Get-CodexRecord {
    param([object[]] $Owned, [string] $Relative)

    return @($Owned | Where-Object { $null -ne $_ -and (Test-OrdinalEqual $_.path $Relative) -and (Test-OrdinalEqual $_.kind 'dir') -and (Test-OrdinalEqual (Get-Field $_ 'runtime') 'codex') }) | Select-Object -First 1
}

# Before any write: a skill folder that exists must be one the lock records as codex's and still holds the recorded tree.
# Anything else is a folder maxstack did not write, or one a person changed, and the apply stops with nothing written.
function Assert-CodexSkillTargets {
    param([object[]] $Skills, [object[]] $Owned)

    foreach ($skill in $Skills) {
        $relative = "$script:CodexSkillFolder/$($skill.name)"
        $full = Join-Path $Workspace ($relative -replace '/', '\')
        if (-not (Test-Path -LiteralPath $full)) { continue }
        $record = Get-CodexRecord -Owned $Owned -Relative $relative
        if ($null -eq $record) {
            throw "$relative already exists and maxstack did not write it, so nothing was written. Move it aside, then rerun -Apply."
        }
        if ((Test-ReparsePoint $full) -or -not (Test-OrdinalEqual (Get-TreeSha256 $full) $record.sha256)) {
            throw "$relative changed since the last apply, so nothing was written. Move its changes aside, or delete it, then rerun -Apply."
        }
    }
}

# Writes the codex skills, after the checks above. With -RemoveStale, a recorded skill that no layer ships now is removed when
# it still holds its recorded tree, and a changed one is kept and named. A removal passes no -RemoveStale: the folders of the
# layers it removes are deleted by its own plan, which keeps any record it cannot delete.
function Write-CodexSkills {
    param([object[]] $Skills, [object[]] $Owned, [bool] $RemoveStale = $true)

    $wanted = @($Skills | ForEach-Object { "$script:CodexSkillFolder/$($_.name)" })
    $stale = @()
    if ($RemoveStale) { $stale = @($Owned | Where-Object { $null -ne $_ -and (Test-OrdinalEqual (Get-Field $_ 'runtime') 'codex') -and (Test-OrdinalEqual $_.kind 'dir') -and -not (Test-OrdinalIn $_.path $wanted) }) }
    foreach ($record in $stale) {
        $full = Join-Path $Workspace ($record.path -replace '/', '\')
        if (-not (Test-Path -LiteralPath $full -PathType Container)) { continue }
        if ((Test-ReparsePoint $full) -or -not (Test-OrdinalEqual (Get-TreeSha256 $full) $record.sha256)) {
            Write-Host "Kept $($record.path): it changed since the last apply, and no layer ships it now"
            continue
        }
        Remove-OwnedTree $full
        Write-Host "Removed the codex skill $($record.path): no layer ships it now"
    }
    $root = Join-Path $Workspace ($script:CodexSkillFolder -replace '/', '\')
    foreach ($skill in $Skills) {
        $full = Join-Path $root $skill.name
        Remove-OwnedTree $full
        Copy-CodexSkillTree -Source $skill.source -Destination $full
        Write-Host "Copied codex skill '$($skill.name)' from layer '$($skill.layer)' into $full"
    }
}

# The installed copy of a selected layer.
function Get-CodexGateFolder {
    param([object] $Layer)

    return (Join-Path $Workspace (($script:CodexGateFolder + '/' + $Layer.name) -replace '/', '\'))
}

# The selected layers whose installed copy carries a Codex gate hook: the hook script and the codex runtime library.
# A layer is checked in layer order, and only the layers that selected codex take part.
function Get-CodexGateLayers {
    param([object[]] $Layers)

    $found = [System.Collections.Generic.List[object]]::new()
    foreach ($layer in @($Layers | Where-Object { $_.runtimes.ContainsKey('codex') })) {
        $folder = Get-CodexGateFolder -Layer $layer
        $hook = Join-Path $folder ($script:CodexGateHookRelative -replace '/', '\')
        $lib = Join-Path $folder ($script:CodexGateLibRelative -replace '/', '\')
        if ((Test-Path -LiteralPath $hook -PathType Leaf) -and (Test-Path -LiteralPath $lib -PathType Leaf)) { $found.Add($layer) }
    }
    return $found.ToArray()
}

# The codex lines an apply and a status print when codex is selected. Nothing is printed when it is not. On an apply, a
# layer whose installed copy carries a Codex gate hook gets a Launch-arguments line with the trusted hook, read from Codex
# itself by scripts/codex-hook-trust.mjs. Any failure, or a path the line cannot carry, falls back to the plain marker line,
# and the install still succeeds. A run without -Apply says only that a gate line would be generated, and starts no Codex.
function Write-CodexNotes {
    param([object[]] $Layers, [bool] $Applying, [bool] $OpenCodeSelected, $WorkspaceInstructionPlan)

    if ($null -ne $WorkspaceInstructionPlan -and $WorkspaceInstructionPlan.text) {
        $agentsFile = @($WorkspaceInstructionPlan.files | Where-Object { Test-OrdinalEqual $_.path 'AGENTS.md' }) | Select-Object -First 1
        if ($null -ne $agentsFile) {
            if (Test-IsTrue (Get-Field $agentsFile 'preserve')) { $agentsNote = 'Codex: workspace AGENTS.md was kept because it changed by hand.' }
            else { $agentsNote = 'Codex: workspace AGENTS.md was generated from the selected layers.' }
        } elseif (Test-OrdinalIn 'AGENTS.md' $WorkspaceInstructionPlan.collisionNames) {
            $agentsNote = 'Codex: workspace AGENTS.md was kept because it was not written by maxstack.'
        } else {
            $agentsNote = 'Codex: no workspace AGENTS.md was generated; shared instructions were written to .maxstack/workspace-instructions.md.'
        }
    } else {
        $agentsNote = 'Codex: no workspace AGENTS.md was generated. Any existing one is read only when the launch arguments name stack.lock.json.'
    }
    $agentsNote += ' Codex reads it only with the marker launch argument.'

    $gateLayers = @(Get-CodexGateLayers -Layers $Layers)
    if ($gateLayers.Count -gt 1) { Write-Host $script:CodexGateOneNote }
    if (-not $Applying) {
        if ($gateLayers.Count -gt 0) { Write-Host $script:CodexGateAuditNote } else { Write-Host $script:CodexLaunchLine }
        Write-Host $agentsNote
        return
    }
    if ($gateLayers.Count -eq 0) {
        if (-not $OpenCodeSelected) { Write-Host $script:CodexGateRuntimeNote }
        Write-Host $script:CodexLaunchLine
        Write-Host $agentsNote
        return
    }
    $hook = Join-Path (Get-CodexGateFolder -Layer $gateLayers[0]) ($script:CodexGateHookRelative -replace '/', '\')
    $text = ''
    $code = 1
    try {
        $output = @(& node (Join-Path $PSScriptRoot $script:CodexGateScript) --workspace $Workspace --hook $hook 2>&1 | ForEach-Object { [string] $_ })
        $code = $LASTEXITCODE
        $text = ($output -join "`n").Trim()
    } catch {
        $text = $_.Exception.Message
    }
    $parsed = $null
    if ($code -eq 0) { try { $parsed = $text | ConvertFrom-Json } catch { $parsed = $null } }
    $launch = Get-Field $parsed 'launchArguments'
    if ($null -ne $parsed -and (Test-NonEmptyString $launch)) {
        Write-Host ("Codex: Launch arguments: {0}" -f $launch)
        Write-Host $script:CodexPasteNote
    } else {
        Write-Host $script:CodexLaunchLine
        $reason = if (Test-NonEmptyString $text) { $text } else { "the gate generator exited with code $code" }
        Write-Warning "Codex: the gate Launch-arguments line could not be generated, so the plain marker line is printed: $reason"
    }
    Write-Host $agentsNote
}
