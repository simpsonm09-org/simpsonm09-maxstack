# platforms: windows
# Dot-sourced by the verifiers that call OpenCode. Every call gets the same time limit,
# process-tree kill, and clear message, so no verifier can wait forever on a model.

# Runs one OpenCode command in a directory with its stdin closed. Its output goes to
# temporary files rather than pipes: an OpenCode service that outlives the CLI can
# inherit a pipe handle, keeping a verifier's caller waiting for EOF after the CLI
# exits. A call that outlasts the limit is stopped with its whole process tree, and
# the function throws and names the command. The caller passes the ApplicationInfo
# from Get-Command.
function Invoke-OpenCode {
    param($Command, [string[]] $Arguments, [string] $Directory, [int] $TimeoutSeconds)

    $fileName = $Command.Source
    $prefix = @()
    if ([IO.Path]::GetExtension($fileName) -eq '.ps1') {
        # The npm PowerShell shim is not a process of its own, so run it under this host.
        $prefix = @('-NoProfile', '-NonInteractive', '-File', $fileName)
        $fileName = (Get-Process -Id $PID).Path
    }

    $temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) ("invoke-opencode-$([guid]::NewGuid())")
    [IO.Directory]::CreateDirectory($temporaryDirectory) | Out-Null
    $wrapperPath = Join-Path $temporaryDirectory 'run.ps1'
    $launcherPath = Join-Path $temporaryDirectory 'run.cmd'
    $stdoutPath = Join-Path $temporaryDirectory 'stdout.txt'
    $stderrPath = Join-Path $temporaryDirectory 'stderr.txt'

    # Invoke through a short PowerShell wrapper so the real executable and every
    # argument are quoted by PowerShell, not by cmd.exe. cmd.exe supplies file-backed
    # standard handles; a service child may inherit those files, but never the
    # verifier's stdout/stderr pipes.
    $quote = {
        param([string] $Value)
        "'$($Value.Replace("'", "''"))'"
    }
    $wrapperLines = @(
        '$ErrorActionPreference = ''Continue''',
        "& $(& $quote $fileName) @("
    )
    $allArguments = @($prefix + $Arguments)
    for ($index = 0; $index -lt $allArguments.Count; $index++) {
        $suffix = if ($index -lt ($allArguments.Count - 1)) { ',' } else { '' }
        $wrapperLines += "    $(& $quote $allArguments[$index])$suffix"
    }
    $wrapperLines += @(
        ')',
        'exit $LASTEXITCODE'
    )
    [IO.File]::WriteAllLines($wrapperPath, $wrapperLines, [Text.UTF8Encoding]::new($false))

    $hostPath = (Get-Process -Id $PID).Path
    # A batch launcher performs the redirection before it starts PowerShell. Starting
    # the batch file directly avoids cmd.exe /c's fragile nested quoting for paths
    # such as the WindowsApps PowerShell installation path.
    $launcherCommand = '"' + $hostPath + '" -NoProfile -NonInteractive -File "' + $wrapperPath + '" 1> "' + $stdoutPath + '" 2> "' + $stderrPath + '" < NUL'
    $launcherLines = @('@echo off', $launcherCommand, 'exit /b %ERRORLEVEL%')
    [IO.File]::WriteAllLines($launcherPath, $launcherLines, [Text.UTF8Encoding]::new($false))
    $info = [Diagnostics.ProcessStartInfo]::new($launcherPath)
    $info.UseShellExecute = $false
    $info.WorkingDirectory = $Directory

    $description = "opencode $($Arguments -join ' ')"
    $process = $null
    try {
        $process = [Diagnostics.Process]::Start($info)
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            try { $process.Kill($true) } catch { }
            throw "FAIL: '$description' did not finish within $TimeoutSeconds seconds in $Directory. Run it there by hand to see where it stops."
        }
        $stdout = [IO.File]::ReadAllText($stdoutPath)
        $stderr = [IO.File]::ReadAllText($stderrPath)
        return [pscustomobject]@{ ExitCode = $process.ExitCode; StdOut = $stdout; StdErr = $stderr }
    } finally {
        if ($process) { $process.Dispose() }
        # A daemon can still have a file open. Leave that harmless temporary file for
        # the OS to clean up rather than turning a successful verification into a
        # cleanup failure.
        try { Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction Stop } catch { }
    }
}
