# platforms: windows, macOS, linux
Set-StrictMode -Version Latest
# The ordinal helpers, which every comparison here uses.
. (Join-Path $PSScriptRoot 'Install-Ordinal.ps1')
. (Join-Path $PSScriptRoot 'Install-Paths.ps1')

$script:SettingsTopLevelKeys = @('$schema', 'version', 'os', 'runtimes', 'layers', 't3')
$script:SettingsRuntimeIds = @('antigravity', 'claude', 'codex', 'copilot', 'cursor', 'opencode', 'pi')
$script:SettingsCliModes = @('detect', 'install')
$script:SettingsOsModes = @('auto', 'windows', 'macos', 'linux')
$script:SettingsT3Defaults = @('leave-alone', 'apply-defaults')
$script:SettingsSourceMaxLength = 2048
$script:SettingsMaxDepth = 32

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
        if ((-not (Test-OrdinalIn ([string] $key) $Allowed))) {
            $valid = $Allowed -join ', '
            throw "maxstack.settings.json: unknown key '$(ConvertTo-SafeName ([string] $key))' in $Where. Valid keys: $valid."
        }
    }
}

# The settings reader's check of one layers.<name>.source. It is the shared source grammar (Read-SourceGrammar), read without
# git, and it names the rule that failed. A settings source is validated here, before any git command can start.
function Assert-SettingsSource {
    param([string] $Name, $Value, [string] $Platform = '')

    $where = "maxstack.settings.json: layers.$Name.source"
    if ($Value -isnot [string] -or [string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt $script:SettingsSourceMaxLength) {
        throw "$where must be a non-empty source string of at most $($script:SettingsSourceMaxLength) characters."
    }
    $grammar = Read-SourceGrammar -Spec $Value -Settings -NoGit -Platform $Platform
    switch ($grammar.code) {
        $null { }
        'forbidden' { throw "$where$($grammar.reason)" }
        'unsafe-local' { throw "$where has an unsafe local path. Use local:<workspace-relative-path>." }
                'local-text' { throw "$where$($grammar.reason)" }
        default { throw "$where is not a supported source. Use owner/repo@ref, https://host/path.git@ref, local:<path>, or default." }
    }
    if ((Test-OrdinalEqual $grammar.kind 'local') -and $grammar.absolute) { Write-SettingsMachinePathWarning -Name $Name }
}

# Whether a folder can be listed. The first entry is read and the enumerator is disposed, so a folder that cannot be listed is
# unreadable and nothing else is read from it.
function Test-SettingsLocalReadable {
    param([string] $Path)

    try {
        $items = [IO.Directory]::EnumerateFileSystemEntries($Path).GetEnumerator()
        try { [void] $items.MoveNext() } finally { if ($items -is [IDisposable]) { $items.Dispose() } }
        return $true
    } catch { return $false }
}

# A settings local source resolved from the workspace folder. A relative path may not leave the workspace through a link,
# name the workspace or a folder the installer writes, or name a maxstack checkout. A folder that is missing or unreadable is
# unavailable, which a read-only run skips and an apply refuses. The path is shown as the user wrote it, never as the link names.
function Get-SettingsLocalSource {
    param([string] $Name, [string] $Path, [bool] $Absolute, [string] $WorkspaceRoot, [string] $RepoRoot)

    # The 8.3 rule reads the path as the user wrote it: .NET expands a short name when it normalises a path, so the check runs first.
    $written = if ($Absolute) { $Path } else { [IO.Path]::Combine($WorkspaceRoot, (ConvertTo-MaxstackPath $Path)) }
    $fault = Get-LocalPathFault $written
    $candidate = Get-FullFolderPath $written
    if ($fault) { return (New-SettingsLocalChoice -Path $candidate -Reason "local path $fault") }
    if (-not $Absolute) {
        $normal = Get-NormalPath $candidate
        if (-not (Test-MaxstackPathInside $normal (Get-NormalPath $WorkspaceRoot))) {
            return (New-SettingsLocalChoice -Path $candidate -Reason 'local path resolves outside the workspace through a link, which cannot be a layer source.')
        }
        if (Test-MaxstackCheckoutLocation -Path $normal -RepoRoot $RepoRoot) {
            return (New-SettingsLocalChoice -Path $candidate -Reason 'local path is a maxstack checkout, which cannot be a layer source.')
        }
    }
    if (-not (Test-Path -LiteralPath $candidate -PathType Container)) {
        return (New-SettingsLocalChoice -Path $candidate -Reason "resolves to no folder at $(ConvertTo-SafeName $candidate).")
    }
    if (-not (Test-SettingsLocalReadable -Path $candidate)) {
        return (New-SettingsLocalChoice -Path $candidate -Reason "cannot be read at $(ConvertTo-SafeName $candidate): the folder could not be listed.")
    }
    $state = Get-LocalCheckoutState -Root $candidate
    if ($state.unreadable) {
        return (New-SettingsLocalChoice -Path $candidate -Reason "cannot be read at $(ConvertTo-SafeName $candidate): $(ConvertTo-SafeName ([string] $state.unreadable)).")
    }
    return [pscustomobject]@{ kind = 'local'; path = $candidate; reason = $null; url = $null; ref = $null }
}

# The unavailable form of a settings local source: the path it names and the reason it cannot be used.
function New-SettingsLocalChoice {
    param([string] $Path, [string] $Reason)

    return [pscustomobject]@{ kind = 'unavailable'; path = $Path; reason = $Reason; url = $null; ref = $null }
}

# The source one layers.<name>.source declares, for this run. A git declaration is kept as parsed: its ref is resolved by the
# layer's choice, and only when the declaration is used. A local one is resolved with Get-SettingsLocalSource. A fault in the
# grammar, which the reader already refused, comes back as unavailable rather than thrown.
function Get-SettingsLayerSource {
    param([string] $Name, [string] $Spec, [string] $WorkspaceRoot, [string] $RepoRoot)

    $grammar = Read-SourceGrammar -Spec $Spec -Settings
    if ($null -ne $grammar.code) { return [pscustomobject]@{ kind = 'unavailable'; path = $null; reason = 'is not a usable source.'; url = $null; ref = $null } }
    if ((Test-OrdinalEqual $grammar.kind 'default')) { return [pscustomobject]@{ kind = 'default'; path = $null; reason = $null; url = $null; ref = $null } }
    if ((Test-OrdinalEqual $grammar.kind 'local')) { return (Get-SettingsLocalSource -Name $Name -Path $grammar.path -Absolute $grammar.absolute -WorkspaceRoot $WorkspaceRoot -RepoRoot $RepoRoot) }
    $url = if ($null -ne $grammar.url) { $grammar.url } else { Get-GitHubRemoteUrl -Owner $grammar.owner -Repo $grammar.repo }
    return [pscustomobject]@{ kind = 'git'; path = $null; reason = $null; url = $url; ref = $grammar.ref }
}

# Whether a declared source names the same source as a recorded override: the same kind, the same url and ref for git, and the
# same folder for local, with links followed. Case matters for a url and a ref, as git treats them.
function Test-SettingsSourceMatchesRecord {
    param($Declared, $Recorded)

    if ((-not (Test-OrdinalEqual $Declared.kind (Get-Field $Recorded 'kind')))) { return $false }
    if ((Test-OrdinalEqual $Declared.kind 'git')) {
        return ((Test-OrdinalEqual $Declared.url ([string] (Get-Field $Recorded 'url')))) -and ((Test-OrdinalEqual $Declared.ref ([string] (Get-Field $Recorded 'ref'))))
    }
    return (Test-OrdinalEqual (Get-NormalPath ([string] $Declared.path)) (Get-NormalPath ([string] (Get-Field $Recorded 'path'))))
}

# Says what the settings file declares for each layer source, in the words of this run. A declaration that cannot be used is
# reported by Write-SettingsSourceProblems instead, so each line has one code path. A status or update reports a declaration
# without taking it: only an apply uses it.
function Write-SettingsSourceNotes {
    param($Settings, [hashtable] $Declared, [hashtable] $Recorded, [bool] $Reporting)

    foreach ($name in @(Get-SettingsNames -Settings $Settings -Key 'layers')) {
        if (-not $Declared.ContainsKey($name)) { continue }
        $source = $Declared[$name]
        if ((Test-OrdinalEqual $source.kind 'unavailable')) { continue }
        if ((Test-OrdinalEqual $source.kind 'default')) {
            if ($Recorded.ContainsKey($name)) { Write-Host "Settings: layers.$name.source is default; an apply drops the recorded override." }
            continue
        }
        if ($Reporting) { Write-Host "Settings: layers.$name.source is declared; a read-only run uses the recorded source, and only an apply uses the declaration." }
        if ($Recorded.ContainsKey($name) -and -not (Test-SettingsSourceMatchesRecord -Declared $source -Recorded $Recorded[$name])) {
            Write-Host "Settings: layers.$name.source differs from its recorded override."
        }
    }
    foreach ($name in @(Get-OrdinalSorted @($Recorded.Keys))) {
        if (-not $Declared.ContainsKey($name)) { Write-Host "Settings: layers.$name has no source in maxstack.settings.json; its recorded override is kept." }
    }
}

# A settings source this run cannot use, for a selected layer. An apply refuses it before any write and names the repair. Any
# other run says the layer is skipped, and that it has no fallback to its recorded override or its layers.json source.
function Write-SettingsSourceProblems {
    param([object[]] $Layers, [string[]] $SelectedLayers, [bool] $Applying)

    foreach ($layer in @($Layers | Where-Object { $_.settingsSourced -and $null -ne $_.settingsFault -and (Test-OrdinalIn $_.name $SelectedLayers) })) {
        if ($Applying) {
            throw "maxstack.settings.json: layers.$($layer.name).source $($layer.settingsFault) Fix it there, or repair with: pwsh -File scripts/Install-Workspace.ps1 -Source $($layer.name)=default -Apply"
        }
        Write-Host "Settings: layers.$($layer.name).source $($layer.settingsFault) This run skips layer $($layer.name) and has no fallback."
    }
}

function Assert-SettingsNoDuplicateKeys {
    param([System.Text.Json.JsonElement] $Element, [string] $At = 'root')

    if ($Element.ValueKind -eq [System.Text.Json.JsonValueKind]::Object) {
        $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($property in $Element.EnumerateObject()) {
            if (-not $seen.Add($property.Name)) { throw "duplicate key '$(ConvertTo-SafeName $property.Name)' at $At" }
            Assert-SettingsNoDuplicateKeys -Element $property.Value -At "$At.$(ConvertTo-SafeName $property.Name)"
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
    param([string] $Path, [string[]] $LayerNames, [string] $Platform = '')

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
    Assert-SurrogateEscapes $text 'maxstack.settings.json'
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
        if ((Test-OrdinalEqual $_.Exception.Message 'maxstack.settings.json must hold one JSON object.')) { throw $_.Exception.Message }
        if ($_.Exception.Message -match '^duplicate key ') { throw $_.Exception.Message }
        if ($_.Exception.Message -match 'maximum configured depth') { throw "maxstack.settings.json is nested deeper than $($script:SettingsMaxDepth) levels." }
        throw 'maxstack.settings.json is not strict JSON. Comments and trailing commas are not allowed.'
    }
    # -DateKind String keeps an ISO date a string, as the strict JSON says; it exists from PowerShell 7.5.
    if (-not (Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) { throw 'maxstack.settings.json needs PowerShell 7.5 or later, which reads its dates as strings.' }
    try { $value = ConvertFrom-Json -InputObject $text -AsHashtable -Depth 32 -DateKind String -ErrorAction Stop }
    catch { throw 'maxstack.settings.json is not strict JSON. Comments and trailing commas are not allowed.' }
    Assert-TextBoundaryTree $value 'maxstack.settings.json'
    Assert-SettingsObjectKeys $value $script:SettingsTopLevelKeys 'the top level'
    if ($value.Contains('$schema') -and $value['$schema'] -isnot [string]) { throw 'maxstack.settings.json: $schema must be a string.' }
    if (-not $value.Contains('version')) { throw 'maxstack.settings.json needs "version": 1.' }
    if (($value.version -isnot [long] -and $value.version -isnot [int]) -or $value.version -ne 1) { throw 'maxstack.settings.json needs "version": 1.' }
    if ($value.Contains('os') -and (-not (Test-OrdinalIn $value.os $script:SettingsOsModes))) {
        throw "maxstack.settings.json: os has an unsupported value. Valid values: $($script:SettingsOsModes -join ', ')."
    }
    if ($value.Contains('runtimes')) {
        if ($value.runtimes -isnot [System.Collections.IDictionary]) { throw 'maxstack.settings.json: runtimes must be an object.' }
        Assert-SettingsObjectKeys $value.runtimes $script:SettingsRuntimeIds 'runtimes'
        if ($value.runtimes.Count -eq 0) { throw 'maxstack.settings.json: runtimes names no runtime. Omit it to use the recorded selection.' }
        foreach ($runtime in $value.runtimes.Keys) {
            Assert-SettingsObjectKeys $value.runtimes[$runtime] @('cli') "runtimes.$runtime"
            if ($value.runtimes[$runtime].Contains('cli') -and (-not (Test-OrdinalIn $value.runtimes[$runtime].cli $script:SettingsCliModes))) {
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
            if ($value.layers[$layer].Contains('source')) { Assert-SettingsSource $layer $value.layers[$layer].source $Platform }
        }
    }
    if ($value.Contains('t3')) {
        if ($value.t3 -isnot [System.Collections.IDictionary]) { throw 'maxstack.settings.json: t3 must be an object.' }
        Assert-SettingsObjectKeys $value.t3 @('cli', 'snapshot', 'defaults', 'gatedInstances', 'readOnlyInstances') 't3'
        if ($value.t3.Contains('cli') -and (-not (Test-OrdinalIn $value.t3.cli $script:SettingsCliModes))) { throw 'maxstack.settings.json: t3.cli must be detect or install.' }
        if ($value.t3.Contains('snapshot') -and $value.t3.snapshot -isnot [bool]) { throw 'maxstack.settings.json: t3.snapshot must be true or false.' }
        if ($value.t3.Contains('defaults') -and (-not (Test-OrdinalIn $value.t3.defaults $script:SettingsT3Defaults))) {
            throw 'maxstack.settings.json: t3.defaults must be leave-alone or apply-defaults.'
        }
        if ($value.t3.Contains('defaults') -and (Test-OrdinalEqual $value.t3.defaults 'apply-defaults')) { Write-Warning 't3.defaults apply-defaults is reserved and unsupported in this release; T3 settings are left alone.' }
        $allT3Instances = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($listName in @('gatedInstances', 'readOnlyInstances')) {
            if (-not $value.t3.Contains($listName)) { continue }
            $list = $value.t3[$listName]
            if ($list -isnot [array]) { throw "maxstack.settings.json: t3.$listName must be an array of unique instance ids." }
            $seenInstances = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
            foreach ($instance in $list) {
                if ($instance -isnot [string] -or $instance -cnotmatch '^[A-Za-z0-9_-]+$' -or -not $seenInstances.Add($instance)) {
                    throw "maxstack.settings.json: t3.$listName must contain unique non-empty ids made only of letters, digits, hyphens, and underscores."
                }
                if (-not $allT3Instances.Add($instance)) { throw "maxstack.settings.json: T3 instance id '$instance' cannot appear in both t3.gatedInstances and t3.readOnlyInstances." }
            }
        }
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
        $refusal = if (((Test-OrdinalIn $name @('copilot', 'pi'))) -and -not $ClaudeAvailable) { ' -Apply refuses it: it needs claude, which nothing lists.' } else { '' }
        Write-Host "Settings: pending runtime '$name' from maxstack.settings.json will be selected on -Apply.$refusal"
    }
    foreach ($name in $Layers) {
        if ($Updating) { Write-Host "Settings: pending layer '$name' from maxstack.settings.json is not selected by -Update; run -Apply to select it."; continue }
        if ($Applying) { Write-Host "Settings: layer '$name' from maxstack.settings.json is selected by this apply."; continue }
        Write-Host "Settings: pending layer '$name' from maxstack.settings.json will be selected on -Apply."
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
    foreach ($name in @($Runtimes | Where-Object { (Test-OrdinalIn $_ $listedRuntimes) })) {
        Write-Host "Settings: runtime '$name' is still listed in maxstack.settings.json; $tail"
    }
    foreach ($name in @($Layers | Where-Object { (Test-OrdinalIn $_ $listedLayers) })) {
        Write-Host "Settings: layer '$name' is still listed in maxstack.settings.json; $tail"
    }
}

# The settings file a seed is written to, from the lock. -InitSettings reads the lock and nothing else: no source is resolved,
# no git runs, and an existing file, folder, or link is never overwritten. A lock is read only when it is strictly valid.
function Get-InitSettingsOverrides {
    param($Stack)

    $overrides = [hashtable]::new([StringComparer]::Ordinal)
    foreach ($layer in @($Stack.layers)) {
        $block = Get-Field $layer 'source'
        if (-not (($block -is [pscustomobject]) -and ((Test-IsTrue (Get-Field $block 'override'))))) { continue }
        $kind = Get-Field $block 'kind'
        if ((Test-OrdinalEqual $kind 'git')) {
            $url = [string] (Get-Field $block 'url')
            $ref = [string] (Get-Field $block 'ref')
            $commit = [string] (Get-Field $block 'commit')
            if (-not (Test-HttpsGitUrl $url) -or (Get-SpecFault $url) -or -not (Test-SafeRefNameSyntax $ref) -or -not (Test-CommitRef $commit)) {
                throw "-InitSettings cannot migrate the recorded git source for '$($layer.name)' because its URL, ref, or commit is invalid."
            }
        } elseif ((Test-OrdinalEqual $kind 'local')) {
            $fault = Get-LocalPathTextFault ([string] (Get-Field $block 'path'))
            if ($fault) { throw "-InitSettings cannot migrate the recorded local source for '$($layer.name)': $fault" }
        } else { throw "-InitSettings cannot migrate the recorded source for '$($layer.name)' because its kind is invalid." }
        $overrides[$layer.name] = $block
    }
    return $overrides
}

# The spec a recorded override becomes in the settings file. A github https url is written as owner/repo, another https url as
# url@ref, a folder inside the workspace as local: with a relative path, and any other folder as local: with its absolute path.
function ConvertTo-InitSettingsSpec {
    param([string] $Name, $Source, [string] $WorkspaceRoot)

    if ((Test-OrdinalEqual $Source.kind 'git')) {
        $url = [string] $Source.url
        if ($url -cmatch '^https://github\.com/([^/]+)/([^/]+?)(?:\.git)?$') { return "$($Matches[1])/$($Matches[2])@$($Source.ref)" }
        return "$url@$($Source.ref)"
    }
    $path = [IO.Path]::GetFullPath([string] $Source.path)
    $root = [IO.Path]::TrimEndingDirectorySeparator([IO.Path]::GetFullPath($WorkspaceRoot))
    if (Test-MaxstackPathEqual $path $root) {
        throw "-InitSettings cannot represent layer '$Name' as a local source at the workspace root."
    }
    if (Test-MaxstackPathInside $path $root) {
        return 'local:' + (Get-MaxstackRelativePath $root $path)
    }
    return "local:$path"
}

# The seed value: the lock's selection, and a source for each recorded override. A source the grammar would refuse is never
# written, so the seed always reads back.
function ConvertTo-InitSettingsValue {
    param($Stack, [string] $WorkspaceRoot)

    $selection = Get-Field $Stack 'selection'
    $runtimes = @(Get-OrdinalSorted (Get-OrdinalUnique $selection.runtimes))
    $layers = @(Get-OrdinalSorted (Get-OrdinalUnique $selection.layers))
    $overrides = Get-InitSettingsOverrides $Stack
    $settingsLayers = [ordered]@{}
    foreach ($name in $layers) {
        $entry = [ordered]@{}
        if ($overrides.ContainsKey($name)) {
            $spec = ConvertTo-InitSettingsSpec -Name $name -Source $overrides[$name] -WorkspaceRoot $WorkspaceRoot
            $grammar = Read-SourceGrammar -Spec $spec -Settings -NoGit
            if ($null -ne $grammar.code) { throw "-InitSettings cannot represent the recorded source of layer '$name' as a settings source." }
            if ((Test-OrdinalEqual $grammar.kind 'local') -and $grammar.absolute) { Write-SettingsMachinePathWarning -Name $name }
            $entry.source = $spec
        }
        $settingsLayers[$name] = $entry
    }
    $settings = [ordered]@{ version = 1; runtimes = [ordered]@{}; layers = $settingsLayers }
    foreach ($name in $runtimes) { $settings.runtimes[$name] = [ordered]@{} }
    return $settings
}

# The seed as text. Each JSON string is written with any format or separator character as \uXXXX, so no bidi control or
# invisible character reaches the terminal. The escaped text is what -Apply writes, and it reads back to the same values.
function ConvertTo-InitSettingsText {
    param($Settings)

    $json = ConvertTo-Json -InputObject $Settings -Depth 8
    $escape = { param($match) '\u{0:X4}' -f [int] [char] $match.Value }
    $escapeString = { param($string) [regex]::Replace($string.Value, '[\p{Cf}\p{Zl}\p{Zp}\p{Cs}]', $escape) }
    return [regex]::Replace($json, '"(?:[^"\\]|\\.)*"', $escapeString)
}

# The keys a stack.lock.json holds, at every level. A name that differs from one of these only by case is refused by Assert-LockKeySpelling.
$script:LockKeyVocabulary = @(
    'generatedAt', 'workspace', 'selection', 'runtimes', 'layers', 'configSha256', 'copilot', 'pi', 'ownedSchema', 'owned',
    'createdDirs', 'createdFiles', 'settings', 'file', 'version', 'sha256', 'claudeMarketplaceSha256', 'claudeSettingsSha256',
    'name', 'kind', 'source', 'claude', 'opencode', 'enabled', 'commit', 'dirty', 'override', 'url', 'ref', 'path',
    'wrappers', 'cmdSha256', 'agentDir', 'shSha256', 'runtime', 'target', 'plugin', 'key', 'entries', 'items', 'createdKey',
    'quarantine', 'treeSha256', 'role', 'backup', 'skills', 'layer', 'unknown', 'loader', 'dir', 'entry', 'state'
)

# The keys a stack.lock.json holds, at every level. PowerShell reads a property without regard to case, so a key spelled another way
# would stand in for the right one: a key that matches a known key only by case is refused, at any depth.
function Assert-LockKeySpelling {
    param($Value, [string] $Where)

    if ($Value -is [string]) { return }
    if ($Value -is [pscustomobject]) {
        foreach ($property in @($Value.PSObject.Properties)) {
            if (-not (Test-OrdinalIn $property.Name $script:LockKeyVocabulary)) {
                $spelled = @($script:LockKeyVocabulary | Where-Object { [string]::Equals($_, $property.Name, [StringComparison]::OrdinalIgnoreCase) })
                if ($spelled.Count -gt 0) { throw "$Where key '$(ConvertTo-SafeName $property.Name)' must be spelled $($spelled[0])." }
            }
            Assert-LockKeySpelling -Value $property.Value -Where "$Where.$(ConvertTo-SafeName $property.Name)"
        }
        return
    }
    if ($Value -is [System.Collections.IEnumerable]) {
        foreach ($item in $Value) { Assert-LockKeySpelling -Value $item -Where "$Where[]" }
    }
}

# The lock's shape the readers rely on: each top-level key is spelled as the installer writes it, and each layer's recorded
# source, when it is an object, names a git or a local kind. A malformed one is a named error, not a raw property error later.
function Assert-LockShape {
    param($Stack)

    Assert-LockKeySpelling -Value $Stack -Where 'stack.lock.json'
    foreach ($record in @(Get-Field $Stack 'owned')) {
        $claimsProperty = $record.PSObject.Properties['runtimes']
        $runtimeProperty = $record.PSObject.Properties['runtime']
        $path = Get-Field $record 'path'
        $agentSkillPath = $path -is [string] -and $path.StartsWith('.agents/skills/', [StringComparison]::Ordinal)
        $skillName = if ($agentSkillPath) { $path.Substring('.agents/skills/'.Length) } else { '' }
        if ($agentSkillPath -and ($null -eq $claimsProperty -and $null -eq $runtimeProperty)) {
            throw 'stack.lock.json has an agent skill ownership record with no runtime attribution.'
        }
        if ($null -ne $claimsProperty -and $null -ne $runtimeProperty) {
            throw 'stack.lock.json must use runtime or runtimes, not both.'
        }
        if ($agentSkillPath -and $null -ne $runtimeProperty -and ((-not (Test-OrdinalEqual $runtimeProperty.Value 'codex')) -or -not (Test-OrdinalEqual (Get-Field $record 'kind') 'dir') -or -not [regex]::IsMatch($skillName, '^[A-Za-z0-9][A-Za-z0-9-]*$'))) {
            throw 'stack.lock.json has an invalid legacy Codex skill ownership record.'
        }
        if ($null -eq $claimsProperty) { continue }
        $runtimeClaims = $claimsProperty.Value
        if (-not $agentSkillPath -or -not (Test-OrdinalEqual (Get-Field $record 'kind') 'dir') -or -not [regex]::IsMatch($skillName, '^[A-Za-z0-9][A-Za-z0-9-]*$') -or $runtimeClaims -isnot [array] -or $runtimeClaims.Count -eq 0) {
            throw 'stack.lock.json has an invalid shared skill ownership record.'
        }
        $previous = $null
        foreach ($runtime in $runtimeClaims) {
            if ($runtime -isnot [string] -or -not (Test-OrdinalIn $runtime @('antigravity', 'codex')) -or ($null -ne $previous -and [string]::CompareOrdinal($previous, $runtime) -ge 0)) {
                throw 'stack.lock.json has invalid or unsorted shared skill runtime claims.'
            }
            $previous = $runtime
        }
    }
    foreach ($layer in @(Get-Field $Stack 'layers')) {
        $source = Get-Field $layer 'source'
        if ($source -isnot [pscustomobject]) { continue }
        $kind = Get-Field $source 'kind'
        # A kind that is present but not git or local is an invalid override, which the readers report and ignore. A source with
        # no kind at all is a malformed lock.
        if ($null -eq $kind) {
            throw "stack.lock.json layer '$(ConvertTo-SafeName ([string] (Get-Field $layer 'name')))' has a malformed source: it names no kind."
        }
    }
}


# Reads the lock as strict JSON, for a seed only. The lock must be a regular file no larger than 64 KiB, hold valid UTF-8 and
# strict JSON with no duplicate key, be ownedSchema 1 or 2, and name a selection and layer records the layers.json and the
# runtime list allow.
function Read-InitSettingsLock {
    param([string] $Path, [string[]] $LayerNames)

    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -gt 65536) { throw '-InitSettings cannot read stack.lock.json because it is larger than the 65536 byte limit.' }
        $buffer = [byte[]]::new(65537)
        $read = 0
        while ($read -lt $buffer.Length) {
            $count = $stream.Read($buffer, $read, $buffer.Length - $read)
            if ($count -eq 0) { break }
            $read += $count
        }
        if ($read -gt 65536) { throw '-InitSettings cannot read stack.lock.json because it is larger than the 65536 byte limit.' }
        $bytes = [byte[]]::new($read)
        [Array]::Copy($buffer, $bytes, $read)
    } finally { $stream.Dispose() }
    $offset = if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { 3 } else { 0 }
    try { $text = [Text.UTF8Encoding]::new($false, $true).GetString($bytes, $offset, $bytes.Length - $offset) }
    catch { throw '-InitSettings cannot read stack.lock.json because it is not valid UTF-8.' }
    Assert-SurrogateEscapes $text 'stack.lock.json'
    try {
        $options = [System.Text.Json.JsonDocumentOptions]::new()
        $options.CommentHandling = [System.Text.Json.JsonCommentHandling]::Disallow
        $options.AllowTrailingCommas = $false
        $options.MaxDepth = $script:SettingsMaxDepth
        $document = [System.Text.Json.JsonDocument]::Parse($text, $options)
        try {
            if ($document.RootElement.ValueKind -ne [System.Text.Json.JsonValueKind]::Object) { throw 'root is not an object' }
            Assert-SettingsNoDuplicateKeys -Element $document.RootElement
        } finally { $document.Dispose() }
    } catch {
        if ($_.Exception.Message -match '^duplicate key ') { throw '-InitSettings cannot read stack.lock.json because it has a duplicate key.' }
        throw '-InitSettings cannot read stack.lock.json as strict JSON.'
    }
    $stack = ConvertFrom-Json -InputObject $text -Depth 32 -ErrorAction Stop
    Assert-TextBoundaryTree $stack 'stack.lock.json'
        Assert-LockShape $stack
    $schema = Get-Field $stack 'ownedSchema'
    if (($schema -isnot [long] -and $schema -isnot [int]) -or (($schema -ne 1) -and ($schema -ne 2))) {
        throw '-InitSettings needs a stack.lock.json with ownedSchema 1 or 2.'
    }
    $selection = Get-Field $stack 'selection'
    if ($selection -isnot [pscustomobject]) { throw '-InitSettings needs a valid recorded selection in stack.lock.json.' }
    foreach ($property in $selection.PSObject.Properties) {
        if ((-not (Test-OrdinalIn $property.Name @('runtimes', 'layers')))) { throw '-InitSettings cannot migrate a selection with an unknown field.' }
    }
    foreach ($pair in @(@('runtimes', $script:SettingsRuntimeIds), @('layers', $LayerNames))) {
        $names = Get-Field $selection $pair[0]
        if ($names -isnot [array] -or $names.Count -eq 0) { throw "-InitSettings needs a valid recorded $($pair[0]) selection in stack.lock.json." }
        $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
        foreach ($name in $names) {
            if ($name -isnot [string] -or (-not (Test-OrdinalIn $name $pair[1])) -or -not $seen.Add($name)) {
                throw "-InitSettings cannot migrate an unknown, duplicate, or invalid $($pair[0]) selection."
            }
        }
    }
    $layerRecords = Get-Field $stack 'layers'
    if ($layerRecords -isnot [array]) { throw '-InitSettings cannot migrate a lock without a valid layers list.' }
    $seenLayers = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($layer in $layerRecords) {
        $layerName = Get-Field $layer 'name'
        if ($layer -isnot [pscustomobject] -or $layerName -isnot [string] -or (-not (Test-OrdinalIn $layerName $LayerNames)) -or -not $seenLayers.Add($layerName)) {
            throw '-InitSettings cannot migrate an unknown, duplicate, or invalid layer record.'
        }
        $block = Get-Field $layer 'source'
        if ($null -ne $block -and $block -isnot [string] -and $block -isnot [pscustomobject]) {
            throw '-InitSettings cannot migrate a malformed recorded source.'
        }
        if ($block -is [pscustomobject] -and $null -ne $block.PSObject.Properties['override'] -and $block.override -isnot [bool]) {
            throw '-InitSettings cannot migrate a malformed recorded source.'
        }
    }
    return $stack
}

# Prints the seed, or with -Write creates the file when it is absent. A folder or link at the path is refused in both modes.
# The file is created with CreateNew, so an existing file is never replaced, even by a race, and a failed write removes the
# partial file it made.
function Invoke-InitSettings {
    param([string] $Path, [string] $WorkspaceRoot, [string[]] $LayerNames, [switch] $Write)

    $shown = ConvertTo-SafeName $Path
    $entry = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -ne $entry) {
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "-InitSettings refuses ${shown}: it is a symbolic link or junction." }
        if ($entry.PSIsContainer) { throw "-InitSettings cannot write because $shown is a directory." }
        if ($Write) { throw "-InitSettings refuses to overwrite existing $shown." }
    }
    $stackPath = Join-MaxstackPath $WorkspaceRoot 'stack.lock.json'
    if (Test-MaxstackLinkedPath $stackPath) { throw '-InitSettings refuses stack.lock.json: it is a symbolic link or junction.' }
    if (-not (Test-Path -LiteralPath $stackPath -PathType Leaf)) {
        [Console]::Error.WriteLine('-InitSettings needs stack.lock.json. Copy workspace/maxstack.settings.json to the workspace, or run Install-Workspace.ps1 -Apply first.')
        exit 1
    }
    $stack = Read-InitSettingsLock -Path $stackPath -LayerNames $LayerNames
    $text = ConvertTo-InitSettingsText (ConvertTo-InitSettingsValue -Stack $stack -WorkspaceRoot $WorkspaceRoot)
    if (-not $Write) {
        Write-Host 'InitSettings: derived settings file (dry run, no files written):'
        if ($null -ne $entry) { Write-Host "InitSettings: $shown exists, so -Apply would refuse to overwrite it." }
        Write-Output $text
        return
    }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($text + "`n")
    try { $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None) }
    catch { throw "-InitSettings could not create ${shown}: the file already exists, or the folder cannot take a new file." }
    try {
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } catch {
        $stream.Dispose()
        [IO.File]::Delete($Path)
        throw "-InitSettings could not write $shown, so the partial file was removed."
    }
    $stream.Dispose()
    Write-Host "InitSettings: wrote $shown. No runtime files were changed."
}

# The machine-path warning for a settings source. The reader and the seed say it in one wording.
function Write-SettingsMachinePathWarning {
    param([string] $Name)

    Write-Warning "layers.$Name.source contains a machine path; use local: with a path relative to the workspace."
}
