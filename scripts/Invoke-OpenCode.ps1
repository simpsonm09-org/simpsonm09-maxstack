# platforms: windows
# Dot-sourced by the verifiers that call OpenCode. Every call gets the same time limit,
# process-tree kill, and clear message, so no verifier can wait forever on a model.

# Runs one OpenCode command in a directory with its stdin closed. A call that outlasts
# the limit is stopped with its whole process tree, and the function throws and names
# the command. The caller passes the ApplicationInfo from Get-Command.
function Invoke-OpenCode {
    param($Command, [string[]] $Arguments, [string] $Directory, [int] $TimeoutSeconds)

    $fileName = $Command.Source
    $prefix = @()
    if ([IO.Path]::GetExtension($fileName) -eq '.ps1') {
        # The npm PowerShell shim is not a process of its own, so run it under this host.
        $prefix = @('-NoProfile', '-NonInteractive', '-File', $fileName)
        $fileName = (Get-Process -Id $PID).Path
    }

    $info = [Diagnostics.ProcessStartInfo]::new($fileName)
    $info.UseShellExecute = $false
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.WorkingDirectory = $Directory
    foreach ($argument in @($prefix + $Arguments)) { $info.ArgumentList.Add($argument) }

    $description = "opencode $($Arguments -join ' ')"
    $process = [Diagnostics.Process]::Start($info)
    $process.StandardInput.Close()
    $stdout = $process.StandardOutput.ReadToEndAsync()
    $stderr = $process.StandardError.ReadToEndAsync()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
        try { $process.Kill($true) } catch { }
        throw "FAIL: '$description' did not finish within $TimeoutSeconds seconds in $Directory. Run it there by hand to see where it stops."
    }
    if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]] @($stdout, $stderr), 10000)) {
        throw "FAIL: '$description' exited, but its output stayed open for 10 seconds in $Directory. A child process may still hold it."
    }
    return [pscustomobject]@{ ExitCode = $process.ExitCode; StdOut = $stdout.Result; StdErr = $stderr.Result }
}
