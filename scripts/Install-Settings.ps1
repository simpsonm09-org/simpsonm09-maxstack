# platforms: windows
Set-StrictMode -Version Latest

$script:SettingsTopLevelKeys = @('$schema', 'version', 'os', 'runtimes', 'layers', 't3')
$script:SettingsRuntimeIds = @('claude', 'copilot', 'opencode', 'pi')
$script:SettingsCliModes = @('detect', 'install')
$script:SettingsOsModes = @('auto', 'windows', 'macos', 'linux')
$script:SettingsT3Defaults = @('leave-alone', 'apply-defaults')
$script:SettingsSourceMaxLength = 2048
$script:SettingsMaxDepth = 32
# The characters a diagnostic escapes: every control (C0, DEL, C1) and every format character, which includes the bidi controls.
$script:SettingsSafeNameForbidden = '[\p{Cc}\p{Cf}]'
# The characters a source may not hold: C0 controls and DEL, C1 controls, NBSP, and the bidi controls (ALM, LRM, RLM, LRE to RLO, LRI to PDI).
$script:SettingsSourceForbidden = '[\x00-\x1f\x7f-\x9f\xa0\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]'

function ConvertTo-CanonicalSettingsValue {
    param($Value)

    if ($Value -is [System.Collections.IDictionary]) {
        $sorted = [ordered]@{}
        $keys = [string[]] @($Value.Keys)
        [Array]::Sort($keys, [StringComparer]::Ordinal)
        foreach ($key in $keys) {
            $sorted[$key] = ConvertTo-CanonicalSettingsValue $Value[$key]
        }
        return $sorted
    }
    return $Value
}

function Assert-SettingsObjectKeys {
    param($Value, [string[]] $Allowed, [string] $Where)

    if ($Value -isnot [System.Collections.IDictionary]) { throw "maxstack.settings.json: $Where must be an object." }
    foreach ($key in $Value.Keys) {
        if ($Allowed -cnotcontains [string] $key) {
            $valid = $Allowed -join ', '
            throw "maxstack.settings.json: unknown key '$(ConvertTo-SettingsSafeName ([string] $key))' in $Where. Valid keys: $valid."
        }
    }
}

function ConvertTo-SettingsSafeName {
    param([string] $Value)

    $safe = [regex]::Replace($Value, $script:SettingsSafeNameForbidden, { param($match) '\u{0:X4}' -f [int] [char] $match.Value })
    if ($safe.Length -gt 80) { return $safe.Substring(0, 77) + '...' }
    return $safe
}

function Assert-SettingsSource {
    param([string] $Name, $Value)

    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt $script:SettingsSourceMaxLength -or $Value -match $script:SettingsSourceForbidden) {
        throw "maxstack.settings.json: layers.$Name.source must be a non-empty source string of at most $($script:SettingsSourceMaxLength) characters."
    }
    if ($Value -ceq 'default') { return }
    if ($Value.StartsWith('local:', [StringComparison]::Ordinal)) {
        $local = $Value.Substring(6)
        if ([string]::IsNullOrWhiteSpace($local) -or $local -match '(^|[\\/])\.\.([\\/]|$)') {
            throw "maxstack.settings.json: layers.$Name.source has an unsafe local path. Use local:<workspace-relative-path>."
        }
        if ([IO.Path]::IsPathRooted($local)) { Write-Warning "layers.$Name.source contains a machine path; use local: with a path relative to the workspace." }
        return
    }
    if ($Value -notmatch '^(?:[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+|https://[^/@\s]+/[^@\s]+)@[^@\s]+$') {
        throw "maxstack.settings.json: layers.$Name.source is not a supported source. Use owner/repo@ref, https://host/path.git@ref, local:<path>, or default."
    }
    $at = $Value.LastIndexOf('@')
    $location = $Value.Substring(0, $at)
    $ref = $Value.Substring($at + 1)
    $fault = Get-SpecFault $Value
    $validLocation = ($location -cmatch '^([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._-]+)$') -or (Test-HttpsGitUrl $location)
    if ($fault -or -not $validLocation -or -not (Test-SafeRefNameSyntax $ref)) {
        throw "maxstack.settings.json: layers.$Name.source is not a supported source. Use owner/repo@ref, https://host/path.git@ref, local:<path>, or default."
    }
}

function Assert-SettingsNoDuplicateKeys {
    param([System.Text.Json.JsonElement] $Element, [string] $At = 'root')

    if ($Element.ValueKind -eq [System.Text.Json.JsonValueKind]::Object) {
        $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($property in $Element.EnumerateObject()) {
            if (-not $seen.Add($property.Name)) { throw "duplicate key '$(ConvertTo-SettingsSafeName $property.Name)' at $At" }
            Assert-SettingsNoDuplicateKeys -Element $property.Value -At "$At.$(ConvertTo-SettingsSafeName $property.Name)"
        }
    } elseif ($Element.ValueKind -eq [System.Text.Json.JsonValueKind]::Array) {
        $index = 0
        foreach ($item in $Element.EnumerateArray()) {
            Assert-SettingsNoDuplicateKeys -Element $item -At "$At[$index]"
            $index += 1
        }
    }
}

function Read-MaxstackSettings {
    param([string] $Path, [string[]] $LayerNames)

    $entry = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -eq $entry) {
        return [pscustomobject]@{ present = $false; value = $null; hash = $null }
    }
    if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'maxstack.settings.json settings path is a symbolic link or reparse point.' }
    if ($entry.PSIsContainer) { throw 'maxstack.settings.json settings path is a directory.' }
    try { $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read) }
    catch { throw 'maxstack.settings.json could not be read: another process has it open, or it is not accessible.' }
    try {
        if ($stream.Length -gt 65536) { throw 'maxstack.settings.json is larger than the 65536 byte limit.' }
        $buffer = [byte[]]::new(65537)
        $read = 0
        while ($read -lt $buffer.Length) {
            $count = $stream.Read($buffer, $read, $buffer.Length - $read)
            if ($count -eq 0) { break }
            $read += $count
        }
        if ($read -gt 65536) { throw 'maxstack.settings.json is larger than the 65536 byte limit.' }
        $bytes = [byte[]]::new($read)
        [Array]::Copy($buffer, $bytes, $read)
    } finally { $stream.Dispose() }
    $offset = if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { 3 } else { 0 }
    try { $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes, $offset, $bytes.Length - $offset) }
    catch { throw 'maxstack.settings.json is not valid UTF-8.' }
    try {
        $jsonOptions = [System.Text.Json.JsonDocumentOptions]::new()
        $jsonOptions.CommentHandling = [System.Text.Json.JsonCommentHandling]::Disallow
        $jsonOptions.AllowTrailingCommas = $false
        $jsonOptions.MaxDepth = $script:SettingsMaxDepth
        $document = [System.Text.Json.JsonDocument]::Parse($text, $jsonOptions)
        try {
            if ($document.RootElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) { throw 'maxstack.settings.json must hold one JSON object.' }
            Assert-SettingsNoDuplicateKeys -Element $document.RootElement
        } finally { $document.Dispose() }
    }
    catch {
        if ($_.Exception.Message -eq 'maxstack.settings.json must hold one JSON object.') { throw $_.Exception.Message }
        if ($_.Exception.Message -match '^duplicate key ') { throw $_.Exception.Message }
        if ($_.Exception.Message -match 'maximum configured depth') { throw "maxstack.settings.json is nested deeper than $($script:SettingsMaxDepth) levels." }
        throw 'maxstack.settings.json is not strict JSON. Comments and trailing commas are not allowed.'
    }
    # -DateKind String keeps an ISO date a string, as the strict JSON says; it exists from PowerShell 7.5.
    if (-not (Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { throw 'maxstack.settings.json needs PowerShell 7.5 or later, which reads its dates as strings.' }
    try { $value = ConvertFrom-Json -InputObject $text -AsHashtable -Depth 32 -DateKind String -ErrorAction Stop }
    catch { throw 'maxstack.settings.json is not strict JSON. Comments and trailing commas are not allowed.' }
    Assert-SettingsObjectKeys $value $script:SettingsTopLevelKeys 'the top level'
    if ($value.Contains('$schema') -and $value['$schema'] -isnot [string]) { throw 'maxstack.settings.json: $schema must be a string.' }
    if (-not $value.Contains('version')) { throw 'maxstack.settings.json needs "version": 1.' }
    if (($value.version -isnot [long] -and $value.version -isnot [int]) -or $value.version -ne 1) { throw 'maxstack.settings.json needs "version": 1.' }
    if ($value.Contains('os') -and $value.os -cnotin $script:SettingsOsModes) {
        throw "maxstack.settings.json: os has an unsupported value. Valid values: $($script:SettingsOsModes -join ', ')."
    }
    if ($value.Contains('runtimes')) {
        if ($value.runtimes -isnot [System.Collections.IDictionary]) { throw 'maxstack.settings.json: runtimes must be an object.' }
        Assert-SettingsObjectKeys $value.runtimes $script:SettingsRuntimeIds 'runtimes'
        if ($value.runtimes.Count -eq 0) { throw 'maxstack.settings.json: runtimes names no runtime. Omit it to use the recorded selection.' }
        foreach ($runtime in $value.runtimes.Keys) {
            Assert-SettingsObjectKeys $value.runtimes[$runtime] @('cli') "runtimes.$runtime"
            if ($value.runtimes[$runtime].Contains('cli') -and $value.runtimes[$runtime].cli -cnotin $script:SettingsCliModes) {
                throw "maxstack.settings.json: runtimes.$runtime.cli must be detect or install."
            }
        }
    }
    if ($value.Contains('layers')) {
        if ($value.layers -isnot [System.Collections.IDictionary]) { throw 'maxstack.settings.json: layers must be an object.' }
        Assert-SettingsObjectKeys $value.layers @($LayerNames) 'layers'
        if ($value.layers.Count -eq 0) { throw 'maxstack.settings.json: layers names no layer. Omit it to use the recorded selection.' }
        foreach ($layer in $value.layers.Keys) {
            Assert-SettingsObjectKeys $value.layers[$layer] @('source') "layers.$layer"
            if ($value.layers[$layer].Contains('source')) { Assert-SettingsSource $layer $value.layers[$layer].source }
        }
    }
    if ($value.Contains('t3')) {
        if ($value.t3 -isnot [System.Collections.IDictionary]) { throw 'maxstack.settings.json: t3 must be an object.' }
        Assert-SettingsObjectKeys $value.t3 @('cli', 'snapshot', 'defaults') 't3'
        if ($value.t3.Contains('cli') -and $value.t3.cli -cnotin $script:SettingsCliModes) { throw 'maxstack.settings.json: t3.cli must be detect or install.' }
        if ($value.t3.Contains('snapshot') -and $value.t3.snapshot -isnot [bool]) { throw 'maxstack.settings.json: t3.snapshot must be true or false.' }
        if ($value.t3.Contains('defaults') -and $value.t3.defaults -cnotin $script:SettingsT3Defaults) {
            throw 'maxstack.settings.json: t3.defaults must be leave-alone or apply-defaults.'
        }
        if ($value.t3.Contains('defaults') -and $value.t3.defaults -ceq 'apply-defaults') { Write-Warning 't3.defaults apply-defaults is reserved and unsupported in this release; T3 settings are left alone.' }
    }
    $canonical = ConvertTo-Json -InputObject (ConvertTo-CanonicalSettingsValue $value) -Compress -Depth 100
    $sha = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($canonical)))
    return [pscustomobject]@{ present = $true; value = $value; hash = $sha }
}

# Says each runtime or layer that maxstack.settings.json adds and the selection does not hold yet. An apply selects it, so the
# note says so; an update selects nothing from the file, so it says that instead. An audit or status says it will be selected
# on -Apply, and that -Apply refuses a runtime that needs claude when claude is not listed anywhere.
function Write-PendingSettingsNotes {
    param([string[]] $Runtimes, [string[]] $Layers, [bool] $ClaudeAvailable, [bool] $Applying, [bool] $Updating)

    foreach ($name in $Runtimes) {
        if ($Updating) { Write-Host "Settings: pending runtime '$name' from maxstack.settings.json is not selected by -Update; run -Apply to select it."; continue }
        if ($Applying) { Write-Host "Settings: runtime '$name' from maxstack.settings.json is selected by this apply."; continue }
        $refusal = if (($name -in @('copilot', 'pi')) -and -not $ClaudeAvailable) { ' -Apply refuses it: it needs claude, which nothing lists.' } else { '' }
        Write-Host "Settings: pending runtime '$name' from maxstack.settings.json will be selected on -Apply.$refusal"
    }
    foreach ($name in $Layers) {
        if ($Updating) { Write-Host "Settings: pending layer '$name' from maxstack.settings.json is not selected by -Update; run -Apply to select it."; continue }
        if ($Applying) { Write-Host "Settings: layer '$name' from maxstack.settings.json is selected by this apply."; continue }
        Write-Host "Settings: pending layer '$name' from maxstack.settings.json will be selected on -Apply."
    }
}

# Says each layer source the file records. This release records a source and does not apply it, so the note says so.
function Write-UnappliedSourceNotes {
    param($Settings)

    if (-not $Settings.present -or -not $Settings.value.Contains('layers')) { return }
    foreach ($name in @(Get-SettingsNames -Settings $Settings -Key 'layers')) {
        if ($Settings.value.layers[$name].Contains('source')) {
            Write-Host "Settings: layers.$name.source is recorded but not applied in this release."
        }
    }
}

function Get-SettingsNames {
    param($Settings, [string] $Key)

    if (-not $Settings.present -or -not $Settings.value.Contains($Key)) { return @() }
    return @($Settings.value[$Key].Keys)
}

# The settings a removal reads, for its notes only. It never throws: a file that cannot be read is not a reason to refuse
# a removal, so it reads as absent. Its warnings are silenced, because a removal does not depend on them.
function Read-SettingsForRemoval {
    param([string] $Path, [string[]] $LayerNames)

    $WarningPreference = 'SilentlyContinue'
    try { return Read-MaxstackSettings -Path $Path -LayerNames $LayerNames }
    catch { return [pscustomobject]@{ present = $false; value = $null; hash = $null } }
}

# Says each removed runtime or layer that the settings file still lists. The next apply selects a listed name again.
function Write-RemovalSettingsNotes {
    param($Settings, [string[]] $Runtimes, [string[]] $Layers)

    if (-not $Settings.present) { return }
    $listedRuntimes = @(Get-SettingsNames -Settings $Settings -Key 'runtimes')
    $listedLayers = @(Get-SettingsNames -Settings $Settings -Key 'layers')
    $tail = 'the next -Apply will select it again. Remove it from the settings file to keep it removed.'
    foreach ($name in @($Runtimes | Where-Object { $listedRuntimes -ccontains $_ })) {
        Write-Host "Settings: runtime '$name' is still listed in maxstack.settings.json; $tail"
    }
    foreach ($name in @($Layers | Where-Object { $listedLayers -ccontains $_ })) {
        Write-Host "Settings: layer '$name' is still listed in maxstack.settings.json; $tail"
    }
}
