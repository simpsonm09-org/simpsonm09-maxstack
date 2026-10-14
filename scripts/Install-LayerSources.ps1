# platforms: windows
# The ordinal helpers, which every comparison here uses.
. (Join-Path $PSScriptRoot 'Install-Ordinal.ps1')
. (Join-Path $PSScriptRoot 'Install-Paths.ps1')
# Layer sources: the -Source and -LayerSource overrides, how each layer's source is chosen, and the source
# record the lock keeps. A layer installs from a git source (a url, a ref, and the commit the ref resolved to) or
# from a local working tree. layers.json gives each layer's default source. An override changes the source for one
# run, and the lock records it, so a plain apply reuses it until -Source name=default drops it.
#
# Dot-sourced by Install-Workspace.ps1, so it shares that script's variables and functions.

# Whether a value is a string with text in it. The installer and the source grammar both use it, so it lives with the grammar.
function Test-NonEmptyString {
    param($Value)

    return (($Value -is [string]) -and $Value.Trim().Length -gt 0)
}

# A test seam, and nothing else. The owner/repo shorthand names a bare repository under MAXSTACK_TEST_GITHUB_ROOT instead
# of github.com, so the tests fetch from local repositories. The root is honoured only in a test run (MAXSTACK_TEST_MODE is 1)
# and only when it is under the temp folder. Each use is warned, so a stray variable in a real run shows.
function Get-GitHubRemoteUrl {
    param([string] $Owner, [string] $Repo)

    $testRoot = $env:MAXSTACK_TEST_GITHUB_ROOT
    if ($testRoot -and (Test-TestSeam) -and (Test-UnderTempFolder $testRoot)) {
        Write-Warning "MAXSTACK_TEST_GITHUB_ROOT is set, so $Owner/$Repo reads the local folder $testRoot, not GitHub. This is the test seam."
        return ((Join-MaxstackPath $testRoot "$Owner\$Repo.git") -replace '//', '/')
    }
    return "https://github.com/$Owner/$Repo.git"
}

# Whether a path is inside the temp folder. Both sides are resolved, so a junction or symbolic link on either one counts as
# the folder it names: a link under the temp folder that leads elsewhere is not inside it. Case is ignored.
function Test-UnderTempFolder {
    param([string] $Path)

    $temp = Get-NormalPath (Get-FullFolderPath ([IO.Path]::GetTempPath()))
    $full = Get-NormalPath $Path
    return $full.StartsWith("$temp\", [StringComparison]::Ordinal)
}

# Whether the test seam is on. The tests set MAXSTACK_TEST_MODE, and a real run never does.
function Test-TestSeam {
    return ((Test-OrdinalEqual $env:MAXSTACK_TEST_MODE '1'))
}

# The form of a path that comparisons use: a long-path prefix is dropped, and each junction or symbolic link on the
# way is followed, so a path through a link compares equal to the folder it names. Case follows the platform. A drive that is not
# present yields the path as written, so a folder on it compares as missing rather than failing the run.
function Get-NormalPath {
    param([string] $Path)

    $text = [IO.Path]::GetFullPath((Remove-LongPathPrefix $Path))
    $root = [IO.Path]::GetPathRoot($text)
    $current = $root
    foreach ($segment in @($text.Substring($root.Length).Split([IO.Path]::DirectorySeparatorChar, [StringSplitOptions]::RemoveEmptyEntries))) {
        $current = Resolve-PathLink ([IO.Path]::Combine($current, $segment))
    }
    return [IO.Path]::TrimEndingDirectorySeparator($current)
}

# The folder a junction or symbolic link names, or the path itself when it is not a link or cannot be read.
function Resolve-PathLink {
    param([string] $Path)

    try {
        $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
        if ($null -eq $item -or -not ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $Path }
        $target = $item.ResolveLinkTarget($true)
        if ($null -ne $target) { return $target.FullName }
        $text = @($item.Target)[0]
        if ($text) { return [IO.Path]::GetFullPath([string] $text) }
        return $Path
    } catch {
        return $Path
    }
}

# The settings every git command the installer runs under. They stop git from running a program that a checkout names
# (core.fsmonitor and hooks), or that the user's config names (core.askPass, which the empty string turns off, so a credential
# prompt runs no askpass program), and refuse every transport but https. The test seam also allows file, since its remotes
# are local bare repositories. Each filter driver that a tree names is turned off as well (-FilterNames): a clean,
# smudge, or process command is a program that git runs while it reads a file, and a driver that is missing is not required.
function Get-GitGuardSettings {
    param([string[]] $FilterNames = @())

    $settings = @(
        [pscustomobject]@{ key = 'core.fsmonitor'; value = '' }
        [pscustomobject]@{ key = 'core.hooksPath'; value = 'NUL' }
        [pscustomobject]@{ key = 'core.askPass'; value = '' }
        [pscustomobject]@{ key = 'protocol.allow'; value = 'never' }
        [pscustomobject]@{ key = 'protocol.https.allow'; value = 'always' }
    )
    if (Test-TestSeam) { $settings += [pscustomobject]@{ key = 'protocol.file.allow'; value = 'always' } }
    foreach ($name in $FilterNames) {
        foreach ($part in @('clean', 'smudge', 'process')) {
            $settings += [pscustomobject]@{ key = "filter.$name.$part"; value = '' }
        }
        $settings += [pscustomobject]@{ key = "filter.$name.required"; value = 'false' }
    }
    return $settings
}

# The variables a git child runs with: the two that stop a credential prompt, and the settings as GIT_CONFIG_COUNT with
# GIT_CONFIG_KEY_<n> and GIT_CONFIG_VALUE_<n>, which git 2.31 reads. A name is never split at "=", and the argument list has no
# length limit.
function Get-GitChildVariables {
    param($Settings)

    $list = @($Settings)
    $variables = @{ GIT_TERMINAL_PROMPT = '0'; GCM_INTERACTIVE = 'never'; GIT_CONFIG_COUNT = [string] $list.Count }
    for ($index = 0; $index -lt $list.Count; $index++) {
        $variables["GIT_CONFIG_KEY_$index"] = [string] $list[$index].key
        $variables["GIT_CONFIG_VALUE_$index"] = [string] $list[$index].value
    }
    return $variables
}

# git's variables that name a repository, a worktree, a config, a program, or a transport policy. A child inherits them from the
# installer, so one of them could point git at another repository, add a setting or run a program that the guard does not name, or
# allow a transport the guard refuses (GIT_ALLOW_PROTOCOL overrides protocol.allow). They are removed from the child only.
# GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM are not here: the guard reads the same file that a status reads, so a user's relocated
# config keeps its credential helper. GIT_CONFIG_NOSYSTEM is not here either: it is a hardening flag, so the user's choice is left.
$script:GitInheritedVariables = @(
    'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_NAMESPACE', 'GIT_PREFIX', 'GIT_CONFIG', 'GIT_CONFIG_PARAMETERS', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER', 'GIT_ASKPASS',
    'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_PROXY_COMMAND', 'GIT_EXEC_PATH', 'GIT_TEMPLATE_DIR', 'GIT_ALLOW_PROTOCOL', 'GIT_PROTOCOL_FROM_USER',
    'SSH_ASKPASS', 'SSH_ASKPASS_REQUIRE'
)

# Sets a git child's environment to those variables. The child inherits the installer's environment, so the variables in
# GitInheritedVariables and any GIT_CONFIG_* entry it holds are removed from the child first. Names match case-insensitively,
# as Windows environment names do. Only the child's environment is set, never the installer's.
function Set-GitChildEnvironment {
    param($Environment, $Settings)

    foreach ($key in @($Environment.Keys)) {
        if ($key -match '^GIT_CONFIG_(COUNT|KEY_[0-9]+|VALUE_[0-9]+)\z' -or (Test-OrdinalIn $key.ToUpperInvariant() @($script:GitInheritedVariables | ForEach-Object { $_.ToUpperInvariant() }))) { [void] $Environment.Remove($key) }
    }
    foreach ($entry in (Get-GitChildVariables -Settings $Settings).GetEnumerator()) {
        $Environment[$entry.Key] = $entry.Value
    }
}

# The result of a command the guard refused to run, or whose output it could not read. Nothing ran, or the output is not used, so there
# is no exit code, and the reason is the stderr. InvalidUtf8 marks an output that is not valid UTF-8, so a caller can name it.
function New-GitFault {
    param([string] $Reason, [switch] $InvalidUtf8)

    return [pscustomobject]@{ unreadable = $Reason; timedOut = $false; code = $null; text = ''; stdout = @(); stderr = @($Reason); incomplete = $false; invalidUtf8 = [bool] $InvalidUtf8 }
}

# Decodes git's output as UTF-8, strictly. A byte that is not UTF-8 is not replaced with U+FFFD: a name with a replaced byte is a
# different name, so a guard that turned it off would miss the filter that git runs. Returns $null for bytes that are not valid
# UTF-8, and for text that holds U+FFFD, which a replaced byte would also produce.
function ConvertFrom-GitUtf8 {
    param([byte[]] $Bytes)

    try {
        $text = [Text.UTF8Encoding]::new($false, $true).GetString($Bytes)
    } catch [Text.DecoderFallbackException] {
        return $null
    }
    if ($text.Contains([char] 0xFFFD)) { return $null }
    return $text
}

# Runs git with the settings in the child's environment, and a time limit when one is given (zero waits without one). A run past
# the limit is stopped with its process tree, so a silent remote cannot hold the installer. Returns the exit code and each stream.
# The process and its pipes are disposed on every path. Callers go through Invoke-GitGuarded, which applies the guard.
# WorkingDirectory is the folder the child starts in, and CeilingDirectory is one git does not search above for a repository.
# Standard output is copied as bytes and decoded strictly (ConvertFrom-GitUtf8). An output that is not valid UTF-8 is a refused
# result with InvalidUtf8 set, so no caller reads a name, a path, or a commit that git did not print.
function Invoke-GitProcess {
    param([string[]] $Arguments, $Settings, [int] $TimeoutSeconds = 0, [string] $WorkingDirectory = '', [string] $CeilingDirectory = '')

    $info = [Diagnostics.ProcessStartInfo]::new('git')
    foreach ($argument in $Arguments) { $info.ArgumentList.Add([string] $argument) }
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.UseShellExecute = $false
    if ($WorkingDirectory) { $info.WorkingDirectory = $WorkingDirectory }
    Set-GitChildEnvironment -Environment $info.Environment -Settings $Settings
    if ($CeilingDirectory) { $info.Environment['GIT_CEILING_DIRECTORIES'] = $CeilingDirectory }
    try {
        $process = [Diagnostics.Process]::Start($info)
    } catch {
        return (New-GitFault "git could not start: $($_.Exception.Message)")
    }
    # The raw bytes are kept. A stream reader would replace an invalid byte with U+FFFD before anything could see it.
    $outBytes = [IO.MemoryStream]::new()
    $errBytes = [IO.MemoryStream]::new()
    $stdout = $process.StandardOutput.BaseStream.CopyToAsync($outBytes)
    $stderr = $process.StandardError.BaseStream.CopyToAsync($errBytes)
    try {
        $timedOut = $false
        if ($TimeoutSeconds -gt 0) {
            $timedOut = -not $process.WaitForExit($TimeoutSeconds * 1000)
        } else {
            $process.WaitForExit()
        }
        if ($timedOut) {
            try { $process.Kill($true) } catch { }
            [void] $process.WaitForExit(5000)
        }
        $outComplete = Read-GitPipeBounded -Task $stdout
        $errComplete = Read-GitPipeBounded -Task $stderr
        $text = ''
        if ($outComplete) {
            $text = ConvertFrom-GitUtf8 -Bytes $outBytes.ToArray()
            if ($null -eq $text) { return (New-GitFault 'git output is not valid UTF-8' -InvalidUtf8) }
        }
        # stderr is only shown and matched for a reason, so a byte that is not UTF-8 is replaced there, and nothing decides on it.
        $errText = if ($errComplete) { [Text.UTF8Encoding]::new($false).GetString($errBytes.ToArray()) } else { '' }
        return [pscustomobject]@{
            unreadable  = $null
            timedOut    = $timedOut
            code        = $(if ($timedOut) { $null } else { $process.ExitCode })
            text        = $text
            stdout      = @(($text -split "`r?`n") | Where-Object { $_ })
            stderr      = @(($errText -split "`r?`n") | Where-Object { $_ })
            incomplete  = -not ($outComplete -and $errComplete)
            invalidUtf8 = $false
        }
    } finally {
        foreach ($task in @($stdout, $stderr)) {
            if ($task.IsCompleted) { $task.Dispose() }
        }
        $process.Dispose()
    }
}

# The reasons a layer or a command is refused for the git it runs on, and not for its tree. The apply names the repair for each.
$script:DubiousOwnershipReason = 'git refused the folder: it is owned by another user; add it to safe.directory or fix its ownership'
$script:GitVersionReason = 'git 2.31 or later is needed, so the filter guard cannot be passed'
$script:GitConfigReason = 'git could not read its configuration, so the filter guard cannot be passed'

# Whether this git reads the GIT_CONFIG_* settings, which git 2.31 added. Without them the guard does not hold, so a git
# that cannot read them runs no guarded command. The probe reads back a value that it sets, and runs once per run.
$script:gitEnvConfigSupported = $null
$script:gitEnvConfigFault = $null
function Test-GitEnvConfigSupport {
    if ($null -eq $script:gitEnvConfigSupported) {
        $probe = @([pscustomobject]@{ key = 'maxstack.guardprobe'; value = 'on' })
        $run = Invoke-GitNeutral -Arguments @('config', '--get', 'maxstack.guardprobe') -Settings $probe
        $script:gitEnvConfigSupported = ($run.code -eq 0 -and ((Test-OrdinalIn 'on' @($run.stdout))))
        if (-not $script:gitEnvConfigSupported) { $script:gitEnvConfigFault = Get-GitEnvConfigFault $run }
    }
    return $script:gitEnvConfigSupported
}

# The reason no guarded command runs when the probe fails. A probe that prints an error names it: git prints one when its config
# cannot be parsed (a global or system file, for one), and the reason gives git's own message, since git is new enough to read
# the settings. A probe that prints nothing is a git older than 2.31, or one that did not read the settings, and its version says which.
function Get-GitEnvConfigFault {
    param($Run)

    $detail = [string] (@($Run.stderr) | Where-Object { $_ } | Select-Object -First 1)
    if ($detail -and -not $detail.StartsWith('git could not start', [StringComparison]::Ordinal)) { return "$($script:GitConfigReason): $detail" }
    $version = Get-GitVersion
    if ($null -ne $version -and $version -ge [version] '2.31') { return 'git did not read the guard settings, so the filter guard cannot be passed' }
    if ($detail) { return "$($script:GitVersionReason): $detail" }
    return $script:GitVersionReason
}

# The version of the git on the path, or $null when it cannot be read. Only a probe that printed nothing gets here, so the config is readable.
function Get-GitVersion {
    $run = Invoke-GitNeutral -Arguments @('version') -Settings (Get-GitGuardSettings)
    if ($run.code -ne 0) { return $null }
    $line = Get-GitLine $run
    if ($line -cmatch '(\d+)\.(\d+)') { return [version] "$($Matches[1]).$($Matches[2])" }
    return $null
}

# The words an apply adds after a layer's unreadable reason. A dubious-ownership reason already names its fix, and a git reason
# names the config or the git install that git reports. A tree reason names the tree's config.
function Get-UnreadableRemedy {
    param([string] $Reason)

    if ((Test-OrdinalEqual $Reason $script:DubiousOwnershipReason)) { return '' }
    if ($Reason.StartsWith($script:GitVersionReason, [StringComparison]::Ordinal)) { return '. Install git 2.31 or later' }
    if ($Reason.StartsWith($script:GitConfigReason, [StringComparison]::Ordinal)) { return '. Fix the config file that the reason names' }
    return ". Fix the tree's git config"
}

# The driver name of one config key: everything between the first "filter." and the last dot, so a subsection may hold
# dots, and may be empty (filter..clean, from [filter ""]). Only the key is read. A value is never parsed, since it can hold any text.
function Get-FilterDriverName {
    param([string] $Key)

    if ($Key -cmatch '^filter\.([\s\S]*)\.[^.]+\z') { return $Matches[1] }
    return $null
}

# The filter driver names a tree's git config names, read from the keys alone. -z keeps each name whole, so a name that
# holds a newline is seen as one. Returns the names and a fault. A name with a control character cannot be passed to git,
# so the tree is refused with that reason. A config that cannot be read is refused too, and a tree that names none has no names.
# By default only the tree's own scopes are read. -AllScopes reads every scope, the user's global and system config included.
function Read-TreeFilterNames {
    param([string] $Dir, [switch] $AllScopes)

    $settings = Get-GitGuardSettings
    $repo = Invoke-GitProcess -Arguments @('-C', $Dir, 'rev-parse', '--git-dir') -Settings $settings
    if ($null -ne $repo.unreadable) { return [pscustomobject]@{ names = @(); fault = $repo.unreadable } }
    if ($repo.incomplete) { return [pscustomobject]@{ names = @(); fault = 'git output was cut off, so the tree is unreadable' } }
    # A folder that is not a repository has no config of its own, so it names no filter. A folder with a .git entry that git
    # stops on is different: git reads its config first, so a config it cannot parse fails here, and the tree is unreadable.
    if ($repo.code -ne 0) {
        $reason = [string] (@($repo.stderr) | Select-Object -First 1)
        $hasGitEntry = Test-Path -LiteralPath (Join-MaxstackPath $Dir '.git')
        if (-not $hasGitEntry -or $reason -match 'not a git repository') { return [pscustomobject]@{ names = @(); fault = $null } }
        if ($reason -match 'dubious ownership') { return [pscustomobject]@{ names = @(); fault = $script:DubiousOwnershipReason } }
        return [pscustomobject]@{ names = @(); fault = "config cannot be read: $reason" }
    }
    # --worktree is valid only when extensions.worktreeConfig is enabled. Probe that setting with the same guarded,
    # timed wrapper as every other git read, then inspect its scope only when git supports it.
    $scopes = @('')
    if (-not $AllScopes) {
        $scopes = @('--local')
        $worktreeConfig = Invoke-GitProcess -Arguments @('-C', $Dir, 'config', '--local', '--bool', '--get', 'extensions.worktreeConfig') -Settings $settings -TimeoutSeconds 15
        if ($null -ne $worktreeConfig.unreadable) { return [pscustomobject]@{ names = @(); fault = $worktreeConfig.unreadable } }
        if ($worktreeConfig.incomplete) { return [pscustomobject]@{ names = @(); fault = 'git output was cut off, so worktree config is unknown' } }
        if ($worktreeConfig.code -eq 0 -and (Test-OrdinalEqualIgnoreCase $worktreeConfig.text.Trim() 'true')) { $scopes += '--worktree' }
        elseif ($worktreeConfig.code -ne 1 -and $worktreeConfig.code -ne 0) { return [pscustomobject]@{ names = @(); fault = 'git could not read the worktree config of this folder' } }
    }
    $keys = [System.Collections.Generic.List[string]]::new()
    foreach ($scope in $scopes) {
        $scopeArgs = @()
        if ($scope) { $scopeArgs = @($scope) }
        $run = Invoke-GitProcess -Arguments (@('-C', $Dir, 'config') + $scopeArgs + @('--includes', '--name-only', '-z', '--get-regexp', '^filter\.')) -Settings $settings
        # A name that is not valid UTF-8 is refused by name, since the guard cannot turn off the name git would look up.
        if ($run.invalidUtf8) { return [pscustomobject]@{ names = @(); fault = 'a filter driver name is not valid UTF-8' } }
        if ($null -ne $run.unreadable) { return [pscustomobject]@{ names = @(); fault = $run.unreadable } }
        # A read that was cut off has no end, so its names are not known. It is unreadable, not a list with fewer names.
        if ($run.incomplete) { return [pscustomobject]@{ names = @(); fault = 'git output was cut off, so the filter names are unknown' } }
        if ($run.code -eq 1) { continue }
        if ($run.code -ne 0) { return [pscustomobject]@{ names = @(); fault = 'git could not read the config of this folder' } }
        $keys.AddRange([string[]] @($run.text -split "`0" | Where-Object { $_ }))
    }
    $seen = [System.Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
    foreach ($key in $keys) {
        $name = Get-FilterDriverName $key
        if ($null -eq $name) { continue }
        if ($name -cmatch '[\x00-\x1f\x7f]') {
            return [pscustomobject]@{ names = @(); fault = 'a filter driver name holds a control character, which the guard cannot pass to git' }
        }
        if ($name.Length -gt $script:MaxFilterNameLength) {
            return [pscustomobject]@{ names = @(); fault = "filter name too long: a name holds $($name.Length) characters, and the guard passes at most $($script:MaxFilterNameLength)" }
        }
        [void] $seen.Add($name)
    }
    # Each name takes four settings, so the count is capped. A tree past the cap is refused, not read partly.
    $maxFilterDrivers = 100
    if ($seen.Count -gt $maxFilterDrivers) {
        return [pscustomobject]@{ names = @(); fault = "too many filter drivers: $($seen.Count) are named, and the guard passes at most $maxFilterDrivers" }
    }
    $environmentFault = Get-GitEnvironmentFault -Names @($seen)
    if ($environmentFault) { return [pscustomobject]@{ names = @(); fault = $environmentFault } }
    return [pscustomobject]@{ names = @($seen); fault = $null }
}

# The longest filter name the guard passes. A longer one is refused, since its settings would not fit the child's environment.
$script:MaxFilterNameLength = 4096

# The environment a child takes its settings in. Windows caps an environment block at 32767 characters, and a child whose block
# is too long does not start, so the names are checked against a budget below that cap. The count is the characters of the
# guard's settings plus the installer's own variables, which a child inherits. No names need no budget.
$script:GitEnvironmentBudget = 30000

function Get-GitEnvironmentFault {
    param([string[]] $Names)

    if ($Names.Count -eq 0) { return $null }
    $settingChars = 0
    foreach ($entry in (Get-GitChildVariables -Settings (Get-GitGuardSettings -FilterNames $Names)).GetEnumerator()) {
        $settingChars += ([string] $entry.Key).Length + ([string] $entry.Value).Length + 2
    }
    $ownChars = 0
    foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
        $ownChars += ([string] $entry.Key).Length + ([string] $entry.Value).Length + 2
    }
    $total = $settingChars + $ownChars
    if ($total -le $script:GitEnvironmentBudget) { return $null }
    return "filter name too long: the names together need $total characters of environment, and the guard passes at most $($script:GitEnvironmentBudget)"
}

# Runs a git command that names no tree (a ref lookup, a clone, a version probe) in a fresh empty folder, outside any repository.
# git reads the config of the folder it starts in, so the installer's folder, which may be a repository, is never read. The
# folder's parent is a ceiling, so git does not search above it. The folder is removed when the command ends.
function Invoke-GitNeutral {
    param([string[]] $Arguments, $Settings, [int] $TimeoutSeconds = 0)

    $folder = Join-MaxstackPath ([IO.Path]::GetTempPath()) ('maxstack-git-' + [guid]::NewGuid().ToString('N'))
    [void] [IO.Directory]::CreateDirectory($folder)
    try {
        $ceiling = ([IO.Path]::GetDirectoryName($folder)) -replace '\\', '/'
        return (Invoke-GitProcess -Arguments $Arguments -Settings $Settings -TimeoutSeconds $TimeoutSeconds -WorkingDirectory $folder -CeilingDirectory $ceiling)
    } finally {
        Remove-Item -LiteralPath $folder -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# Runs one git command under the guard. With Dir, the filter drivers that the tree names are turned off first, and a tree that
# cannot be passed is refused before git runs: the result then has unreadable set and no exit code, so a caller never reads a
# tree whose filters it could not turn off. With AllFilterScopes, the names come from every config scope (see Read-TreeFilterNames).
# Without Dir the command names no tree, and it runs through Invoke-GitNeutral. Every guarded command is run here.
function Invoke-GitGuarded {
    param([string[]] $Arguments, [string] $Dir = '', [int] $TimeoutSeconds = 0, [switch] $AllFilterScopes)

    if (-not (Test-GitEnvConfigSupport)) { return (New-GitFault $script:gitEnvConfigFault) }
    $arguments = @('--no-optional-locks') + $Arguments
    if (-not $Dir) { return (Invoke-GitNeutral -Arguments $arguments -Settings (Get-GitGuardSettings) -TimeoutSeconds $TimeoutSeconds) }
    $tree = Read-TreeFilterNames -Dir $Dir -AllScopes:$AllFilterScopes
    if ($null -ne $tree.fault) { return (New-GitFault $tree.fault) }
    return (Invoke-GitProcess -Arguments $arguments -Settings (Get-GitGuardSettings -FilterNames $tree.names) -TimeoutSeconds $TimeoutSeconds)
}

# The first line that a git command printed, trimmed, or an empty string when it printed none.
function Get-GitLine {
    param($Run)

    $line = @($Run.stdout | Where-Object { $_ }) | Select-Object -First 1
    if ($null -eq $line) { return '' }
    return ([string] $line).Trim()
}

# Shows the stderr of a git command that failed. The guard captures the streams, so this keeps the reason in front of the user.
function Write-GitStderr {
    param($Run)

    foreach ($line in @($Run.stderr)) { Write-Host $line }
}

# The reason a git -Source spec is refused, or $null when its characters and parts are acceptable.
function Get-SpecFault {
    param([string] $Spec)

    if ($Spec -match '[\s\x00-\x1f\x7f]') { return 'it holds a space or a control character' }
    if ($Spec.StartsWith('-', [StringComparison]::Ordinal)) { return 'it starts with a dash' }
    if ($Spec.Contains('..')) { return 'it holds ..' }
    return $null
}

# Whether a ref is a full commit SHA, which is pinned, or a branch or tag name, which moves.
function Test-CommitRef {
    param([string] $Ref)

    return ($Ref -cmatch '^[0-9a-f]{40}\z')
}

# The ref-name rules git check-ref-format enforces for refs/heads/<name>, without starting git.
# This lets callers reject malformed input before any guarded git command runs.
function Test-SafeRefNameSyntax {
    param([string] $Ref)

    if ([string]::IsNullOrEmpty($Ref) -or $Ref.StartsWith('-', [StringComparison]::Ordinal)) { return $false }
    if ($Ref -match '[\x00-\x20\x7f~^:?*\[\\]' -or $Ref.Contains('..') -or $Ref.Contains('@{') -or $Ref.Contains('//')) { return $false }
    if ($Ref.StartsWith('/', [StringComparison]::Ordinal) -or $Ref.EndsWith('/', [StringComparison]::Ordinal) -or $Ref.EndsWith('.', [StringComparison]::Ordinal)) { return $false }
    foreach ($part in $Ref.Split('/')) {
        if ($part.StartsWith('.', [StringComparison]::Ordinal) -or $part.EndsWith('.lock', [StringComparison]::Ordinal)) { return $false }
    }
    return $true
}

# Whether a ref is a safe git ref name. git check-ref-format is the authority. A leading dash is refused here too,
# because the ref is passed to git as an argument.
function Test-SafeRefName {
    param([string] $Ref)

    if (Test-CommitRef $Ref) { return $true }
    if (-not (Test-SafeRefNameSyntax $Ref)) { return $false }
    return ((Invoke-GitGuarded -Arguments @('check-ref-format', "refs/heads/$Ref")).code -eq 0)
}

# A long-path prefix is dropped from a drive path only: \\?\C:\x becomes C:\x. A UNC share keeps its share form, so
# \\?\UNC\server\share becomes \\server\share and is not read as a folder under the current directory. Other forms are kept.
function Remove-LongPathPrefix {
    param([string] $Path)

    if ($Path -cmatch '^\\\\\?\\UNC\\') { return ('\\' + $Path.Substring(8)) }
    if ($Path -cmatch '^\\\\\?\\[A-Za-z]:') { return $Path.Substring(4) }
    return $Path
}

# The full path of a folder. A trailing separator is dropped, except on a root, which keeps its own: C:\ stays C:\ and
# does not become the drive-relative C:.
function Get-FullFolderPath {
    param([string] $Path)

    $full = [IO.Path]::GetFullPath((Remove-LongPathPrefix $Path))
    $root = [IO.Path]::GetPathRoot($full)
    if ($full.Length -gt $root.Length) { return [IO.Path]::TrimEndingDirectorySeparator($full) }
    return $full
}

# The text fault of a local path, or $null. A UNC path and a device-namespace path (\\?\, \\.\, and the forward-slash forms)
# reach the network or a device, so they are refused by their text before any lookup. A folder name with a trailing dot or
# space is refused too: Windows drops it when it normalises a path, so the folder used is not the one the path names.
function Get-LocalTextFault {
    param([string] $Path, [string] $Platform = '')

    $platformName = Get-MaxstackPathPlatform $Platform
    if ((Test-OrdinalEqualIgnoreCase $platformName 'Windows') -and $Path -match '^[\\/]{2}') { return 'has a UNC or device path, which cannot be a layer source.' }
    foreach ($segment in @($Path -split '[\\/]')) {
        if ((Test-OrdinalEqual $segment '') -or (Test-OrdinalEqual $segment '.') -or (Test-OrdinalEqual $segment '..')) { continue }
        if ((Test-OrdinalEqualIgnoreCase $platformName 'Windows') -and ($segment.EndsWith('.', [StringComparison]::Ordinal) -or $segment.EndsWith(' ', [StringComparison]::Ordinal))) {
            return 'has a folder name with a trailing dot or space, which cannot be a layer source.'
        }
    }
    return $null
}


# The fault of a recorded local path, read by its text alone: no folder is looked at and no link is followed, so -InitSettings
# checks the path the lock holds and nothing else. The rules are the text rules of Get-LocalPathFault.
function Get-LocalPathTextFault {
    param([string] $Path, [string] $Platform = '')

    $platformName = Get-MaxstackPathPlatform $Platform
    $windows = Test-OrdinalEqualIgnoreCase $platformName 'Windows'
    $textFault = Get-LocalTextFault $Path $platformName
    if ($textFault) { return $textFault }
    if (-not (Test-NonEmptyString $Path) -or -not (Test-MaxstackAbsolutePath $Path $platformName)) { return 'needs an absolute path.' }
    if ($windows) {
        foreach ($segment in @($Path -split '[\\/]')) {
            if ($segment -cmatch '^[^~]{1,6}~\d+(\.[^.]{0,3})?$') { return 'has an 8.3 short name, which the seed would write and apply then refuses. Give the long path.' }
        }
    }
    $normal = Get-FullFolderPath $Path
    $root = [IO.Path]::GetPathRoot($normal)
    if (Test-MaxstackPathEqual $normal $root $platformName) { return 'is a drive or share root, which cannot be a layer source.' }
    $workspaceNormal = Get-FullFolderPath $Workspace
    if (Test-MaxstackPathEqual $normal $workspaceNormal $platformName) { return 'is the workspace itself, which cannot be a layer source.' }
    if (Test-MaxstackPathInside $workspaceNormal $normal $platformName) {
        return 'is an ancestor of the workspace, and a layer cannot contain the installer that reads it.'
    }
    foreach ($output in @('.claude', '.opencode', '.pi', '.maxstack')) {
        $folder = Join-MaxstackPath $Workspace $output
        if ((Test-MaxstackPathEqual $normal $folder $platformName) -or (Test-MaxstackPathInside $normal $folder $platformName)) {
            return "is inside $output, which the installer writes, so it cannot be a layer source."
        }
    }
    return $null
}


# The reason a path cannot be a local layer source, or $null. It must be an absolute path that is not a drive or share
# root, not the workspace, and not one of the folders the installer writes into. It need not exist: a recorded folder
# that is gone is reported.
function Get-LocalPathFault {
    param($Path)

    $platformName = Get-MaxstackPathPlatform
    $windows = Test-OrdinalEqualIgnoreCase $platformName 'Windows'
    $textFault = Get-LocalTextFault $Path $platformName
    if ($textFault) { return $textFault }
    if (-not (Test-NonEmptyString $Path) -or -not (Test-MaxstackAbsolutePath $Path $platformName)) { return 'needs an absolute path.' }
    if ($windows) { try { Assert-MaxstackShortNames $Path 'local' } catch { return $_.Exception.Message.Substring('local path '.Length) } }
    $full = Get-FullFolderPath $Path
    if (Test-MaxstackPathEqual $full ([IO.Path]::GetPathRoot($full)) $platformName) { return 'is a drive or share root, which cannot be a layer source.' }
    $normal = Get-NormalPath $full
    $workspaceNormal = Get-NormalPath $Workspace
    if (Test-MaxstackPathEqual $normal $workspaceNormal $platformName) { return 'is the workspace itself, which cannot be a layer source.' }
    if (Test-MaxstackPathInside $workspaceNormal $normal $platformName) {
        return 'is an ancestor of the workspace, and a layer cannot contain the installer that reads it.'
    }
    foreach ($output in @('.claude', '.opencode', '.pi', '.maxstack')) {
        $folder = Get-NormalPath (Join-MaxstackPath $Workspace $output)
        if ((Test-MaxstackPathEqual $normal $folder $platformName) -or (Test-MaxstackPathInside $normal $folder $platformName)) {
            return "is inside $output, which the installer writes, so it cannot be a layer source."
        }
    }
    # A maxstack checkout cannot be a source, whether the path is absolute or relative. An 8.3 short name is refused the way the
    # -Workspace rule refuses one, since it would record a name the lock does not hold.
    if (Test-MaxstackCheckoutLocation -Path $normal -RepoRoot '') { return 'is a maxstack checkout, which cannot be a layer source.' }
    return $null
}

# A local source is a working tree that is never fetched. It must be a folder that exists and passes Get-LocalPathFault.
function Read-LocalSpec {
    param([string] $Name, [string] $Path)

$textFault = Get-LocalTextFault $Path
    if ($textFault) { throw "-Source $Name=local:$(ConvertTo-SafeName $Path) $textFault" }
    $fault = Get-LocalPathFault $Path
    $shown = ConvertTo-SafeName $Path
    if ($fault) { throw "-Source $Name=local:$shown $fault" }
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "-Source $Name=local:${shown}: that folder does not exist." }
    return [pscustomobject]@{ kind = 'local'; path = (Get-FullFolderPath $Path) }
}

# Whether a url is an https address with a host and a path. A -Source spec and a recorded override both use this rule.
# \z, not $, so a trailing newline is not accepted.
function Test-HttpsGitUrl {
    param([string] $Url)

    return ($Url -cmatch '^https://[^/\\?#@]+/[^\\?#@]+\z')
}

# The characters a source may not hold, for every source form: C0 controls and DEL, the C1 controls, NBSP, and the bidi
# controls (ALM, LRM, RLM, LRE to RLO, LRI to PDI). A -Source value and a settings value are refused alike.
$script:SourceExtraForbidden = [string] [char] 0x00A0

function New-SourceFault {
    param([string] $Code, [string] $Reason)

    return [pscustomobject]@{ code = $Code; reason = $Reason; kind = $null }
}

# The one source grammar. -Source, -LayerSource's local form, and layers.<name>.source in maxstack.settings.json all parse
# here, so a value means the same in each. A spec is default, local:<path>, owner/repo@ref, or https://host/path@ref. The
# grammar reads text only: no folder is looked at, and git runs only to check a ref, which -NoGit replaces with the syntax
# check. -Settings also takes a relative local path, which the caller resolves from the workspace; a path that is drive-
# relative, root-relative, or climbs with .. is a fault there. A fault has a code and a reason that starts after the spec.
function Read-SourceGrammar {
    param([string] $Spec, [switch] $Settings, [switch] $NoGit)

    # A format, control, or separator character, or a non-breaking space, is refused before any keyword is compared, so a
    # culture-equal keyword such as default with a soft hyphen is never read as the keyword.
    if ((-not (Test-BoundaryText $Spec)) -or $Spec.Contains($script:SourceExtraForbidden)) {
        $badIndex = Find-BoundaryIndex $Spec
        $held = if ($badIndex -ge 0) { 'the character ' + ('\u{0:X4}' -f [int] $Spec[$badIndex]) } else { 'a non-breaking space' }
        return (New-SourceFault 'forbidden' " holds $held, which a source may not hold.")
    }
    if ((Test-OrdinalEqual $Spec 'default') -or ((Test-OrdinalEqual $Spec '') -and -not $Settings)) { return [pscustomobject]@{ kind = 'default'; code = $null } }
    if ($Spec.StartsWith('local:', [StringComparison]::Ordinal)) { return (Read-LocalGrammar -Path $Spec.Substring(6) -Settings:$Settings) }
    $spaceFault = Get-SpecFault $Spec
    if ($spaceFault) { return (New-SourceFault 'spec' " is refused: $spaceFault. Use owner/repo@ref, https://host/path.git@ref, or local:<absolute path>.") }
    return (Read-GitGrammar -Spec $Spec -NoGit:$NoGit)
}

# The local form of the grammar. The -Source form needs an absolute path, which Read-LocalSpec checks. The settings form
# needs one that is absolute or relative to the workspace: a drive-relative or root-relative path, an empty one, or a
# relative path with a .. component is unsafe. An absolute path may hold .. and is normalized, as -Source has always done.
function Read-LocalGrammar {
    param([string] $Path, [switch] $Settings, [string] $Platform = '')

    $platformName = Get-MaxstackPathPlatform $Platform
    $textFault = Get-LocalTextFault $Path $platformName
    if ($textFault) { return (New-SourceFault 'local-text' " $textFault") }
    $absolute = Test-MaxstackAbsolutePath $Path $platformName
    if ($Settings) {
        if ([string]::IsNullOrWhiteSpace($Path)) { return (New-SourceFault 'unsafe-local' ' has an unsafe local path.') }
        if ((Test-OrdinalEqualIgnoreCase $platformName 'Windows') -and -not $absolute -and $Path -match '^([A-Za-z]:|[\\/])') { return (New-SourceFault 'unsafe-local' ' has an unsafe local path.') }
        if (-not $absolute -and $Path -match '(^|[\\/])\.\.([\\/]|$)') { return (New-SourceFault 'unsafe-local' ' has an unsafe local path.') }
    }
    return [pscustomobject]@{ kind = 'local'; code = $null; path = $Path; absolute = [bool] $absolute }
}

# The git form: owner/repo@ref, or https://host/path@ref. The ref is the part after the last @. The owner/repo form leaves
# the url null, since its remote is built only when the source is used, and that build reads the test seam.
function Read-GitGrammar {
    param([string] $Spec, [switch] $NoGit)

    $at = $Spec.LastIndexOf('@')
    if ($at -lt 1) { return (New-SourceFault 'ref' " needs @ref: the branch, tag, or full commit to install.") }
    $location = $Spec.Substring(0, $at)
    $ref = $Spec.Substring($at + 1)
    $refIsSafe = if ($NoGit) { Test-SafeRefNameSyntax $ref } else { Test-SafeRefName $ref }
    if (-not $refIsSafe) { return (New-SourceFault 'ref' " has a ref that is not a safe git ref name.") }
    if ($location -match '^([A-Za-z]:[\\/]|[\\/])') {
        return (New-SourceFault 'folder-ref' " names a folder with an @ref, which is not a git source: did you mean local:$(ConvertTo-SafeName $location)?")
    }
    if ($location -match '^[A-Za-z][A-Za-z0-9+.-]*:') {
        if (-not (Test-HttpsGitUrl $location)) { return (New-SourceFault 'scheme' ': only https:// URLs with a host and a path are allowed.') }
        return [pscustomobject]@{ kind = 'git'; code = $null; url = $location; ref = $ref; owner = $null; repo = $null }
    }
    if ($location -cmatch '^([A-Za-z0-9][A-Za-z0-9-]*)/([A-Za-z0-9._-]+)$') {
        return [pscustomobject]@{ kind = 'git'; code = $null; url = $null; ref = $ref; owner = $Matches[1]; repo = ($Matches[2] -replace '\.git$', '') }
    }
    return (New-SourceFault 'location' ': the location must be owner/repo or an https:// URL.')
}

# Reads one -Source spec. Empty or default drops the override. The forms are owner/repo@ref, https://host/path@ref, and
# local:<absolute path>. Anything else is refused with the rule it broke, and the spec is shown escaped and cut.
function Read-SourceSpec {
    param([string] $Name, [string] $Spec)

    $grammar = Read-SourceGrammar -Spec $Spec
    if ($null -ne $grammar.code) { throw "-Source $Name=$(ConvertTo-SafeName $Spec)$($grammar.reason)" }
    if ((Test-OrdinalEqual $grammar.kind 'default')) { return [pscustomobject]@{ kind = 'default' } }
    if ((Test-OrdinalEqual $grammar.kind 'local')) { return (Read-LocalSpec -Name $Name -Path $grammar.path) }
    $url = if ($null -ne $grammar.url) { $grammar.url } else { Get-GitHubRemoteUrl -Owner $grammar.owner -Repo $grammar.repo }
    return [pscustomobject]@{ kind = 'git'; url = $url; ref = $grammar.ref }
}

# The explicit sources a run names. -Source name=spec and -LayerSource name=path, which is -Source name=local:path.
# Each entry may be comma-separated in one token, since pwsh -File passes separate tokens as separate values.
function Read-SourceSpecs {
    param([string[]] $Specs, [string[]] $LayerSpecs, [string[]] $LayerNames)

    $table = [hashtable]::new([StringComparer]::Ordinal)
    foreach ($entry in @($Specs | ForEach-Object { $_ -split ',' } | Where-Object { $_ })) {
        $name, $spec = $entry -split '=', 2
        Assert-BoundaryText $name '-Source name'
        if ($null -eq $spec) { throw "-Source expects name=spec, got '$entry'. A comma separates -Source entries, so a path cannot hold one." }
        Add-ExplicitSource -Table $table -Name $name -Spec (Read-SourceSpec -Name $name -Spec $spec) -LayerNames $LayerNames
    }
    foreach ($entry in @($LayerSpecs | ForEach-Object { $_ -split ',' } | Where-Object { $_ })) {
        $name, $path = $entry -split '=', 2
        Assert-BoundaryText $name '-LayerSource name'
        if (-not (Test-NonEmptyString $path)) { throw "LayerSource expects name=path, got '$entry'." }
        Assert-BoundaryText $name '-LayerSource name'
        $grammar = Read-SourceGrammar -Spec "local:$path"
        if ($null -ne $grammar.code) { throw "-LayerSource $name=$(ConvertTo-SafeName $path)$($grammar.reason)" }
        $full = if ([IO.Path]::IsPathRooted($path)) { $path } else { Join-MaxstackPath (Get-Location).ProviderPath $path }
        Add-ExplicitSource -Table $table -Name $name -Spec (Read-LocalSpec -Name $name -Path $full) -LayerNames $LayerNames
    }
    return $table
}

function Add-ExplicitSource {
    param($Table, [string] $Name, $Spec, [string[]] $LayerNames)

    if ((-not (Test-OrdinalIn $Name $LayerNames))) { throw "-Source names an unknown layer: $Name. Layers in layers.json: $($LayerNames -join ', ')." }
    if ($Table.ContainsKey($Name)) { throw "-Source names layer $Name twice." }
    $Table[$Name] = $Spec
}

# Joins a folder inside a checkout or cache. '.' names the whole repository.
function Join-SourceSub {
    param([string] $Root, [string] $Sub)

    if ([string]::IsNullOrEmpty($Sub) -or (Test-OrdinalEqual $Sub '.')) { return $Root }
    return Join-MaxstackPath $Root $Sub
}

# The state of a local checkout, read without writing: its HEAD commit and whether it holds uncommitted changes.
# A folder that is not a git checkout has neither, so nothing is invented for it.
# The state of a local checkout. A failure inside the probe is an unreadable checkout with its reason, never a throw, since a throw
# would stop -Status, -Update, and -Remove, which all resolve every layer.
function Get-LocalCheckoutState {
    param([string] $Root)

    try {
        return (Read-LocalCheckoutState -Root $Root)
    } catch {
        return (New-UnreadableState "the checkout could not be read: $($_.Exception.Message)")
    }
}

function Read-LocalCheckoutState {
    param([string] $Root)

    $none = [pscustomobject]@{ commit = $null; dirty = $null; unreadable = $null }
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return $none }
    $head = Invoke-GitGuarded -Dir $Root -Arguments @('-C', $Root, 'rev-parse', 'HEAD')
    if ($null -ne $head.unreadable) { return (New-UnreadableState $head.unreadable) }
    if ($head.code -ne 0 -or -not (Get-GitLine $head)) { return $none }
    # A folder inside another repository reads that repository's HEAD. It is a checkout only when it is the top level.
    $top = Invoke-GitGuarded -Dir $Root -Arguments @('-C', $Root, 'rev-parse', '--show-toplevel')
    if ($top.code -ne 0 -or -not (Get-GitLine $top) -or (Get-NormalPath (Get-GitLine $top)) -ne (Get-NormalPath $Root)) { return $none }
    # A status reads the worktree through the clean filters. Every filter name that any config scope defines is turned off, the
    # user's global config included, since a global filter that the tree's attributes name would write into the tree. The tree's
    # attributes are still read, so an eol or text setting compares correctly. A tree whose attributes name a filter is compared as
    # raw content, so it can read dirty. --ignore-submodules=all keeps the status out of each populated submodule: git runs a
    # status inside it, which reads that submodule's own config, and a submodule's changes are not part of the dirty flag.
    $status = Invoke-GitGuarded -Dir $Root -AllFilterScopes -Arguments @('-C', $Root, 'status', '--porcelain', '--ignore-submodules=all', '--', '.')
    if ($null -ne $status.unreadable) { return (New-UnreadableState $status.unreadable) }
    # A status whose output was cut off lists fewer changes than it made, so its dirty state is unknown too.
    if ($status.incomplete) { return (New-UnreadableState 'git output was cut off, so the worktree state is unknown') }
    # A status that fails says nothing about the worktree, so its dirty state is unknown rather than clean.
    $dirty = if ($status.code -eq 0) { (@($status.stdout).Count -gt 0) } else { $null }
    return [pscustomobject]@{ commit = (Get-GitLine $head); dirty = $dirty; unreadable = $null }
}

# The state of a local checkout the guard cannot read. Its commit and dirty flag are unknown, and the reason is reported.
function New-UnreadableState {
    param([string] $Reason)

    return [pscustomobject]@{ commit = $null; dirty = $null; unreadable = $Reason }
}

# Whether a git output pipe's copy completed within the given time. A pipe that a stopped git's child still holds open gives
# no end, so the wait is bounded and the read gives up rather than holding the installer. A copy that gave up is incomplete,
# which is not the same as empty output, so the caller reads the bytes only when this returns true.
function Read-GitPipeBounded {
    param($Task, [int] $Milliseconds = 5000)

    return [bool] $Task.Wait($Milliseconds)
}

# The commit a branch, tag, or full commit names on a remote, read with git ls-remote. Nothing is written. A
# branch wins over a tag of the same name, and an annotated tag resolves to the commit it points at. A remote that
# does not answer within the limit is stopped, and the error says so.
function Find-GitRefCommit {
    param([string] $Url, [string] $Ref, [int] $TimeoutSeconds = 60)

    $run = Invoke-GitGuarded -Arguments @('ls-remote', '--', $Url) -TimeoutSeconds $TimeoutSeconds
    if ($run.timedOut) {
        throw "could not read the refs of ${Url}: git ls-remote took longer than $TimeoutSeconds seconds, so it was stopped. Check the network and the url."
    }
    if ($null -ne $run.unreadable) { throw "could not read the refs of ${Url}: $($run.unreadable)." }
    # A read that gave up is not an empty listing: git may have printed the refs, and the output was cut off before they arrived.
    if ($run.incomplete) { throw "could not read the refs of ${Url}: git output was cut off, so the refs are unknown. A process may still hold the output open." }
    if ($run.code -ne 0) { throw "could not read the refs of ${Url}: $((@($run.stdout) + @($run.stderr)) -join ' ')" }
    $output = $run.stdout
    $refs = [hashtable]::new([StringComparer]::Ordinal)
    foreach ($line in $output) {
        $sha, $name = $line -split "`t", 2
        if ($name) { $refs[$name] = $sha }
    }
    foreach ($candidate in @("refs/heads/$Ref", "refs/tags/$Ref^{}", "refs/tags/$Ref")) {
        if ($refs.ContainsKey($candidate)) { return $refs[$candidate] }
    }
    throw "$Url has no branch or tag named $Ref."
}

# The choice a layer takes when no override names it: layers.json's pin, or its local checkout.
function New-DefaultChoice {
    param($Layer)

    if ($Layer.defaultGit) {
        return [pscustomobject]@{ kind = 'git'; url = $Layer.defaultUrl; ref = $Layer.defaultRef; commit = $Layer.defaultCommit; path = $null; checkout = $null; override = $false }
    }
    $checkout = Join-MaxstackPath $Workspace $Layer.path
    return [pscustomobject]@{ kind = 'local'; url = $Layer.defaultUrl; ref = $null; commit = $null; path = $Layer.path; checkout = $checkout; override = $false }
}

# A git choice. A commit is taken as given, a branch or tag is resolved on the remote unless the commit is known. A
# choice equal to the layers.json pin is the default, not an override.
function New-GitChoice {
    param($Layer, [string] $Url, [string] $Ref, [string] $Commit)

    $resolved = $Commit
    if (-not $resolved) { $resolved = if (Test-CommitRef $Ref) { $Ref } else { Find-GitRefCommit -Url $Url -Ref $Ref } }
    if ($Layer.defaultGit -and (Test-OrdinalEqual $Url $Layer.defaultUrl) -and (Test-OrdinalEqual $resolved $Layer.defaultCommit)) { return (New-DefaultChoice $Layer) }
    return [pscustomobject]@{ kind = 'git'; url = $Url; ref = $Ref; commit = $resolved; path = $null; checkout = $null; override = $true }
}

# A local choice. The folder that equals the layers.json checkout is the default, not an override.
function New-LocalChoice {
    param($Layer, [string] $Path)

    $full = Get-FullFolderPath $Path
    if (-not $Layer.defaultGit -and (Test-MaxstackPathEqual (Get-NormalPath $full) (Get-NormalPath (Join-MaxstackPath $Workspace $Layer.path)))) {
        return (New-DefaultChoice $Layer)
    }
    return [pscustomobject]@{ kind = 'local'; url = $null; ref = $null; commit = $null; path = $full; checkout = $full; override = $true }
}

# The choice for one layer. An explicit -Source wins. Otherwise a recorded override is reused. Otherwise the default.
function Resolve-LayerChoice {
    param($Layer, $Explicit, $Recorded, [bool] $Updating)

    if ($null -ne $Explicit) {
        if ((Test-OrdinalEqual $Explicit.kind 'default')) { return (New-DefaultChoice $Layer) }
        if ((Test-OrdinalEqual $Explicit.kind 'unavailable')) { return (New-UnavailableChoice -Path $Explicit.path -Reason $Explicit.reason) }
        if ((Test-OrdinalEqual $Explicit.kind 'local')) { return (New-LocalChoice -Layer $Layer -Path $Explicit.path) }
        return (New-GitChoice -Layer $Layer -Url $Explicit.url -Ref $Explicit.ref -Commit $null)
    }
    if ($null -ne $Recorded) {
        if ((Test-OrdinalEqual $Recorded.kind 'local')) { return (New-LocalChoice -Layer $Layer -Path $Recorded.path) }
        # -Update moves a branch or tag to its current commit. A commit stays as recorded.
        $commit = if ($Updating -and -not (Test-CommitRef $Recorded.ref)) { $null } else { $Recorded.commit }
        return (New-GitChoice -Layer $Layer -Url $Recorded.url -Ref $Recorded.ref -Commit $commit)
    }
    return (New-DefaultChoice $Layer)
}

# Writes a choice into the layer model the rest of the installer reads. A local layer reads its checkout, and
# records HEAD and the dirty flag of that checkout. A git layer keeps its url, ref, and commit.
# A choice that cannot be used: a settings declaration whose folder is missing or unsafe, or whose git ref cannot be read. The
# layer is skipped in every run, and an apply refuses it before any write.
function New-UnavailableChoice {
    param([string] $Path, [string] $Reason)

    return [pscustomobject]@{ kind = 'unavailable'; url = $null; ref = $null; commit = $null; path = $Path; checkout = $null; override = $true; reason = $Reason }
}

function Set-LayerChoice {
    param($Layer, $Choice, [bool] $FromSettings = $false)

    $Layer.override = [bool] $Choice.override
    $Layer.recordUrl = $Choice.url
    $Layer.settingsSourced = $FromSettings
    $Layer.settingsFault = $null
    if ((Test-OrdinalEqual $Choice.kind 'unavailable')) {
        $Layer.sourceKind = 'local'
        $Layer.url = $null
        $Layer.ref = $null
        $Layer.commit = $null
        $Layer.dirty = $null
        $Layer.unreadable = $Choice.reason
        $Layer.localPath = $Choice.path
        $Layer.repoRoot = $null
        $Layer.root = $null
        $Layer.folderMissing = $false
        $Layer.settingsFault = $Choice.reason
        return
    }
    if ((Test-OrdinalEqual $Choice.kind 'git')) {
        $Layer.sourceKind = 'git'
        $Layer.url = $Choice.url
        $Layer.ref = $Choice.ref
        $Layer.commit = $Choice.commit
        $Layer.dirty = $null
        $Layer.unreadable = $null
        $Layer.localPath = $null
        $Layer.folderMissing = $false
        $Layer.repoRoot = $null
        $Layer.root = $null
        return
    }
    $state = Get-LocalCheckoutState $Choice.checkout
    $Layer.sourceKind = 'local'
    $Layer.url = $null
    $Layer.ref = $null
    $Layer.commit = $state.commit
    $Layer.dirty = $state.dirty
    $Layer.unreadable = $state.unreadable
    $Layer.localPath = $Choice.path
    $Layer.repoRoot = $Choice.checkout
    # A folder that is gone, or a tree the guard cannot read, has no root. Only an apply refuses either; every other run reports it.
    $Layer.folderMissing = -not (Test-Path -LiteralPath $Choice.checkout -PathType Container)
    $Layer.root = if ($Layer.folderMissing -or $Layer.unreadable) { $null } else { Join-SourceSub $Choice.checkout $Layer.sourcePath }
}

# Resolves every layer's source for this run. Explicit maps names to parsed sources, and Recorded maps names to the override
# the lock recorded. FromSettings names the Explicit entries that came from maxstack.settings.json, not from -Source. -Update
# moves only the selected layers: an unselected layer keeps its recorded commit, so a remote that only it uses is never read.
function Set-LayerSources {
    param([object[]] $Layers, [hashtable] $Explicit, [hashtable] $Recorded, [bool] $Updating, [string[]] $SelectedLayers, [string[]] $FromSettings = @())

    foreach ($layer in $Layers) {
        $moves = $Updating -and ((Test-OrdinalIn $layer.name $SelectedLayers))
        $fromSettingsFile = (Test-OrdinalIn $layer.name $FromSettings)
        $choice = Resolve-LayerChoiceOrUnavailable -Layer $layer -Explicit $Explicit[$layer.name] -Recorded $Recorded[$layer.name] -Updating $moves -FromSettings $fromSettingsFile
        Set-LayerChoice -Layer $layer -Choice $choice -FromSettings $fromSettingsFile
    }
}

# A settings git declaration whose ref cannot be read is unavailable, not a stop: the layer is skipped, and an apply refuses it.
# A -Source spec that fails still stops the run, as it always has.
function Resolve-LayerChoiceOrUnavailable {
    param($Layer, $Explicit, $Recorded, [bool] $Updating, [bool] $FromSettings)

    if (-not $FromSettings) { return (Resolve-LayerChoice -Layer $Layer -Explicit $Explicit -Recorded $Recorded -Updating $Updating) }
    try { return (Resolve-LayerChoice -Layer $Layer -Explicit $Explicit -Recorded $Recorded -Updating $Updating) }
    catch { return (New-UnavailableChoice -Path $null -Reason "cannot be used: its git ref could not be read: $(ConvertTo-SafeName $_.Exception.Message).") }
}

# The source record the lock keeps for one layer. A git source records its url, ref, and commit. A local source records
# its folder, HEAD, and the dirty flag, and never a commit it cannot read.
function New-SourceRecord {
    param($Layer)

    if ((Test-OrdinalEqual $Layer.sourceKind 'git')) {
        return [pscustomobject]@{ kind = 'git'; url = $Layer.url; ref = $Layer.ref; commit = $Layer.commit; override = $Layer.override }
    }
    return [pscustomobject]@{ kind = 'local'; url = $Layer.recordUrl; ref = $null; commit = $Layer.commit; dirty = $Layer.dirty; override = $Layer.override; path = $Layer.localPath }
}

# The recorded overrides the lock holds, split into those that pass the -Source rules and those that do not. A plain apply
# reuses the valid ones. An invalid one is never used: the caller decides whether it stops the run or is ignored.
function Get-RecordedOverrides {
    param($Stack)

    $overrides = [hashtable]::new([StringComparer]::Ordinal)
    $invalid = [hashtable]::new([StringComparer]::Ordinal)
    foreach ($layer in @($Stack.layers)) {
        $block = Get-Field $layer 'source'
        if (-not (($block -is [pscustomobject]) -and ((Test-IsTrue (Get-Field $block 'override'))))) { continue }
        $fault = Get-RecordedSourceFault $block
        if ($fault) { $invalid[$layer.name] = $fault } else { $overrides[$layer.name] = $block }
    }
    return [pscustomobject]@{ overrides = $overrides; invalid = $invalid }
}

# The first field of a recorded override that the -Source rules refuse, as { field; reason }, or $null when every field
# passes. The lock is a file a user can edit, so its url, ref, commit, and path are checked before a git command or a
# path use takes them. A git record holds an https url (or a local path under the test seam), a safe ref, and a full
# commit. A local record holds a path that passes Get-LocalPathFault.
function Get-RecordedSourceFault {
    param($Block)

    $kind = Get-Field $Block 'kind'
    if ((Test-OrdinalEqual $kind 'local')) {
        $reason = Get-LocalPathFault (Get-Field $Block 'path')
        if ($reason) { return [pscustomobject]@{ field = 'path'; reason = $reason } }
        return $null
    }
    if ((-not (Test-OrdinalEqual $kind 'git'))) { return [pscustomobject]@{ field = 'kind'; reason = 'it is neither git nor local.' } }
    $url = Get-Field $Block 'url'
    # The same two rules a -Source spec passes: its characters and parts (Get-SpecFault), and its url or ref form.
    $httpsUrl = (Test-NonEmptyString $url) -and (Test-HttpsGitUrl $url) -and -not (Get-SpecFault $url)
    $seamUrl = (Test-TestSeam) -and (Test-NonEmptyString $url) -and ($url -cmatch '^([A-Za-z]:/|/)[^\x00-\x1f\x7f@]+\z')
    if (-not ($httpsUrl -or $seamUrl)) { return [pscustomobject]@{ field = 'url'; reason = 'it is not an https address with a host and a path.' } }
    $ref = Get-Field $Block 'ref'
    if (-not ((Test-NonEmptyString $ref) -and -not (Get-SpecFault $ref) -and (Test-SafeRefName $ref))) { return [pscustomobject]@{ field = 'ref'; reason = 'it is not a safe git ref name.' } }
    if (-not (Test-CommitRef (Get-Field $Block 'commit'))) { return [pscustomobject]@{ field = 'commit'; reason = 'it is not a full 40-character lowercase commit SHA.' } }
    return $null
}

# The one-line words for a layer's invalid recorded override.
function Format-RecordedFault {
    param([string] $Name, $Fault)

    return "stack.lock.json: layer '$Name' has an invalid $($Fault.field): $($Fault.reason)"
}

# Warns about each invalid recorded override that this run does not write, and prints the report line for it. A layer
# named in -Source is replaced by that spec, so it is not reported. The layer takes its layers.json source for this run.
function Write-InvalidRecordedSources {
    param($Invalid, [string[]] $Skip)

    foreach ($name in @(Get-OrdinalSorted @($Invalid.Keys))) {
        if ((Test-OrdinalIn $name $Skip)) { continue }
        Write-Warning "$(Format-RecordedFault $name $Invalid[$name]) This run ignores the recorded override and uses the layers.json source. Repair it with -Source $name=default -Apply."
        Write-Host "  ${name}: invalid recorded source, ignored for this run"
    }
}

# The source a lock records for a layer, or the one its layers.json entry implies when the lock predates the source
# block. A legacy layer is a local checkout when it has a path, and a git pin otherwise.
function Get-RecordedSourceOf {
    param($Record)

    $block = Get-Field $Record 'source'
    if ($block -is [pscustomobject]) {
        # A copy with every field, so a missing or invalid field reads as null and no later property access fails.
        return [pscustomobject]@{
            kind = Get-Field $block 'kind'; url = Get-Field $block 'url'; ref = Get-Field $block 'ref'; commit = Get-Field $block 'commit'
            dirty = Get-Field $block 'dirty'; override = Get-Field $block 'override'; path = Get-Field $block 'path'
        }
    }
    $local = $null -ne (Get-Field $Record 'path')
    return [pscustomobject]@{
        kind     = $(if ($local) { 'local' } else { 'git' })
        url      = $(if ($local) { $null } else { Get-Field $Record 'source' })
        ref      = $null
        commit   = Get-Field $Record 'commit'
        dirty    = $null
        override = $false
        path     = Get-Field $Record 'path'
    }
}

# The dirty flag as the block words it. A record from before the flag was kept has none, and says so rather than guessing.
function Format-DirtyLabel {
    param($Dirty)

    if ($null -eq $Dirty) { return 'dirty state not recorded' }
    if ($Dirty) { return 'uncommitted changes' }
    return 'clean'
}

# The lines of the layer-source block: every override, every local source, and every source whose ref moves. A git
# source that is pinned by commit and not overridden is at its committed pin, so it is not listed. Empty when none is.
function Get-SourcePinLines {
    param([object[]] $Entries)

    $lines = [System.Collections.Generic.List[string]]::new()
    foreach ($entry in $Entries) {
        if ($entry.settingsFault) { $lines.Add("  $($entry.name): declared source skipped: $(ConvertTo-SafeName ([string] $entry.settingsFault))"); continue }
        $source = $entry.source
        if ((Test-OrdinalEqual $source.kind 'git')) {
            if (Test-IsTrue $source.override) { $lines.Add("  $($entry.name): override, git $($source.url) ref $($source.ref) at $($source.commit)") }
            continue
        }
        $kind = if (Test-IsTrue $source.override) { 'override, local' } else { 'local, default' }
        $shown = ConvertTo-SafeName ([string] $source.path)
        if (Test-NonEmptyString $source.path) {
            if (-not (Test-Path -LiteralPath (Get-LocalSourceFolder $source.path) -PathType Container)) {
                $lines.Add("  $($entry.name): $kind ${shown}: folder missing")
                continue
            }
        }
        if ($entry.unreadable) {
            $lines.Add("  $($entry.name): $kind ${shown}: unreadable: $(ConvertTo-SafeName ([string] $entry.unreadable))")
            continue
        }
        $where = if ($null -eq $source.commit) { 'not a git checkout' } else { "HEAD $($source.commit), $(Format-DirtyLabel $source.dirty)" }
        $lines.Add("  $($entry.name): $kind $shown ($where)")
    }
    return $lines.ToArray()
}

# Prints the block at the top of -Status and of an audit, so a workspace never runs from a test source unnoticed.
function Write-SourcePinBlock {
    param([object[]] $Entries)

    $lines = @(Get-SourcePinLines -Entries $Entries)
    if ($lines.Count -eq 0) { return }
    Write-Host 'Layer sources not at their committed pin:'
    foreach ($line in $lines) { Write-Host $line }
}

# The folder a local source's path names. A default path is relative to the workspace, so it is joined to it.
function Get-LocalSourceFolder {
    param([string] $Path)

    if ([IO.Path]::IsPathRooted($Path)) { return $Path }
    return (Join-MaxstackPath $Workspace $Path)
}

# The reason the guard cannot read a recorded local folder now, or $null. A folder that is gone is reported as missing instead.
function Get-RecordedUnreadable {
    param($Source)

    if ((-not (Test-OrdinalEqual $Source.kind 'local')) -or -not (Test-NonEmptyString $Source.path)) { return $null }
    try {
        $folder = Get-LocalSourceFolder $Source.path
        if (-not (Test-Path -LiteralPath $folder -PathType Container)) { return $null }
        return (Read-TreeFilterNames -Dir $folder).fault
    } catch {
        return "the folder could not be read: $($_.Exception.Message)"
    }
}

# The entries -Status reads from the lock, and the entries an audit reads from the layers it resolved. Each entry names
# the reason its local tree cannot be read, or null.
function Get-RecordedSourceEntries {
    param($Stack)

    if ($null -eq $Stack) { return @() }
    return @(@($Stack.layers) | ForEach-Object {
        $source = Get-RecordedSourceOf $_
        [pscustomobject]@{ name = $_.name; source = $source; unreadable = (Get-RecordedUnreadable $source); settingsFault = $null }
    })
}

function Get-ResolvedSourceEntries {
    param([object[]] $Layers)

    return @($Layers | ForEach-Object { [pscustomobject]@{ name = $_.name; source = New-SourceRecord $_; unreadable = $_.unreadable; settingsFault = $_.settingsFault } })
}

# ---- -Update: move branch and tag overrides to their current commit, re-read local sources, and report the change ----

function Format-Commit {
    param($Commit)

    if ($null -eq $Commit) { return 'none' }
    return [string] $Commit
}

function Format-DirtyState {
    param($Dirty)

    if ($null -eq $Dirty) { return 'unknown' }
    if ($Dirty) { return 'yes' }
    return 'no'
}

# Whether a commit is in a layer's cache. The check reads the cache and never fetches: --no-lazy-fetch stops git from
# pulling a missing object from origin, so a check leaves the cache byte for byte as it was.
function Test-CachedCommit {
    param([string] $Cache, [string] $Commit)

    if ([string]::IsNullOrEmpty($Commit) -or -not (Test-Path -LiteralPath (Join-MaxstackPath $Cache '.git'))) { return $false }
    $present = Invoke-GitGuarded -Dir $Cache -Arguments @('--no-lazy-fetch', '-C', $Cache, 'cat-file', '-e', "$Commit^{commit}")
    return ($present.code -eq 0)
}

# Whether this git accepts --no-lazy-fetch, which needs git 2.44. The probe runs once per run. Without the flag a check
# could fetch from origin, so the changed files are reported unknown instead.
$script:noLazyFetchSupported = $null
function Test-NoLazyFetchSupport {
    if ($null -eq $script:noLazyFetchSupported) {
        $script:noLazyFetchSupported = ((Invoke-GitGuarded -Arguments @('--no-lazy-fetch', 'version')).code -eq 0)
    }
    return $script:noLazyFetchSupported
}

# What a git source's move changes under the layer's folder, read from the cache. A commit the cache does not hold
# is named as needing a fetch, since a check writes nothing and cannot read it. Renames are off: rename detection reads
# blobs, and a partial clone may not hold them, so git would fail rather than count.
function Get-MoveFilesNote {
    param($Layer, [string] $OldCommit)

    $cache = Join-MaxstackPath $claudeCacheTarget $Layer.name
    if (-not (Test-NoLazyFetchSupport)) { return 'changed files unknown: git 2.44 or later is needed to read the cache without fetching' }
    if (-not (Test-CommitRef $OldCommit)) { return 'changed files unknown: the recorded commit is not a full SHA' }
    if (-not (Test-CachedCommit $cache $Layer.commit)) {
        return 'needs fetch: the new commit is not in the cache, so the changed files are known after an apply fetches it'
    }
    if (-not (Test-CachedCommit $cache $OldCommit)) { return 'changed files unknown: the old commit is not in the cache' }
    $diff = Invoke-GitGuarded -Dir $cache -Arguments @('--no-lazy-fetch', '-C', $cache, 'diff', '--no-renames', '--name-only', $OldCommit, $Layer.commit, '--', $Layer.sourcePath)
    if ($diff.code -ne 0) { return 'changed files unknown: git could not list the changed files from the cache' }
    $changed = @($diff.stdout | Where-Object { $_ })
    return "$($changed.Count) files changed under $($Layer.sourcePath)"
}

# One layer's line in the -Update report, and whether the layer's source changes. A branch or tag override moves to its
# current commit. A commit pin never moves, and neither does a layers.json pin. A local source is read again, and its
# HEAD and dirty flag are compared with the record. The owned paths an apply would rewrite are reported separately.
function Get-SourceUpdate {
    param($Layer, $PriorSource)

    $oldCommit = Get-Field $PriorSource 'commit'
    if ((Test-OrdinalEqual $Layer.sourceKind 'local')) {
        if ($Layer.folderMissing) { return [pscustomobject]@{ line = "  $($Layer.name): local $($Layer.localPath): folder missing"; changed = $true } }
        if ($Layer.unreadable) { return [pscustomobject]@{ line = "  $($Layer.name): local $($Layer.localPath): unreadable: $($Layer.unreadable)"; changed = $true } }
        $was = Format-DirtyState (Get-Field $PriorSource 'dirty')
        $now = Format-DirtyState $Layer.dirty
        $head = "HEAD $(Format-Commit $oldCommit) -> $(Format-Commit $Layer.commit)"
        return [pscustomobject]@{
            line    = "  $($Layer.name): local $($Layer.localPath): $head, uncommitted changes $was -> $now"
            changed = (((-not (Test-OrdinalSame $oldCommit $Layer.commit))) -or ((-not (Test-OrdinalEqual $was $now))))
        }
    }
    if (-not $Layer.override) {
        return [pscustomobject]@{ line = "  $($Layer.name): pinned at $($Layer.commit) in layers.json"; changed = $false }
    }
    if (Test-CommitRef $Layer.ref) {
        return [pscustomobject]@{ line = "  $($Layer.name): override pinned to commit $($Layer.commit), not moved"; changed = $false }
    }
    if ((Test-OrdinalSame $oldCommit $Layer.commit)) {
        return [pscustomobject]@{ line = "  $($Layer.name): $($Layer.ref) is at $($Layer.commit), unchanged"; changed = $false }
    }
    $note = Get-MoveFilesNote -Layer $Layer -OldCommit $oldCommit
    return [pscustomobject]@{ line = "  $($Layer.name): $($Layer.ref) $oldCommit -> $($Layer.commit); $note"; changed = $true }
}

# The hint for a layers.json pin whose branch has moved on. -Update never moves a pin, so the line names the change to
# make by hand. A branch that cannot be read is named, and the report goes on, since no install depends on the hint.
function Get-PinHint {
    param($Layer)

    if (-not $Layer.defaultGit -or (Test-CommitRef $Layer.defaultRef)) { return $null }
    try {
        $head = Find-GitRefCommit -Url $Layer.defaultUrl -Ref $Layer.defaultRef
    } catch {
        return "  $($Layer.name): cannot read $($Layer.defaultRef) to check the pin: $($_.Exception.Message)"
    }
    if ((Test-OrdinalEqual $head $Layer.defaultCommit)) { return $null }
    return "  $($Layer.name): layers.json pins $($Layer.defaultCommit), and $($Layer.defaultRef) is at $head. -Update never moves a pin. To move it, change source.commit in layers.json (and the matching pin in pstack.lock.json), then run verify-manifests."
}

# The record one layer has in the lock, or $null when the lock names none.
function Get-PriorLayerRecord {
    param($Stack, [string] $Name)

    if ($null -eq $Stack) { return $null }
    return (@($Stack.layers | Where-Object { (Test-OrdinalEqual $_.name $Name) }) | Select-Object -First 1)
}

# The -Update report: each selected layer's source as it stands and as -Update would resolve it, the pin hints, and each
# owned path an apply would rewrite. It writes nothing. Returns the number of changes, which -Strict counts.
function Write-UpdateReport {
    param(
        [object[]] $Layers,
        $PriorStack,
        [string[]] $SelectedLayers,
        [string[]] $SelectedRuntimes,
        [object[]] $Plan,
        $Owned,
        [string[]] $NotSelected
    )

    Write-Host 'Layer sources (-Update):'
    $changes = 0
    foreach ($layer in @($Layers | Where-Object { (Test-OrdinalIn $_.name $SelectedLayers) })) {
        $prior = Get-PriorLayerRecord -Stack $PriorStack -Name $layer.name
        $priorSource = $null
        if ($null -ne $prior) { $priorSource = Get-RecordedSourceOf $prior }
        $update = Get-SourceUpdate -Layer $layer -PriorSource $priorSource
        Write-Host $update.line
        if ($update.changed) { $changes++ }
        $hint = Get-PinHint $layer
        if ($hint) { Write-Host $hint }
    }
    if ($null -eq $Owned) {
        Write-Host 'no ownership record; -Update -Apply writes one'
        return $changes
    }
    $results = @(Get-OwnershipReport -Recorded $Owned -Plan $Plan -SelectedRuntimes $SelectedRuntimes -NotSelected $NotSelected)
    $moving = @($results | Where-Object { (Test-OrdinalIn $_.state @('drifted', 'modified', 'missing')) })
    foreach ($item in $moving) { Write-Host ('  would change {0,-9} {1}' -f $item.state, $item.label) }
    return ($changes + $moving.Count)
}

function Write-UpdateSummary {
    param([int] $Changes)

    if ($Changes -eq 0) {
        Write-Host 'Nothing would change.'
        return
    }
    Write-Host "Would change: $Changes item(s)."
}
