# Install and reload

## Model defaults

Every role defaults to `opencode-go/deepseek-v4.1-flash`. `models.json` maps `primary` (the workspace model), `worker` (`pstack-agent`), `reviewer` (`pstack-reviewer`), and `comment-sicko` (`pstack-comment-sicko`). Change a value there, then rerun `Install-Workspace.ps1 -Apply`. The OpenChamber per-project default model is separate app state and is changed in the OpenChamber UI.

## Runtimes

Windows runs the OpenChamber bundled OpenCode. Ubuntu WSL runs the OpenCode CLI. Both read the same workspace files under `D:\dev\simpsonm09`, which WSL sees at `/mnt/d/dev/simpsonm09`.

## Install and reload

The plugin must be checked out at `projects/repos/pstack-opencode-plugin`, or pass `-PluginSource`. The installer checks that checkout's git HEAD against `pstack-opencode.lock.json`.

```powershell
pwsh -File scripts/Install-Workspace.ps1 -Apply
```

The Windows OpenChamber app starts one long-lived OpenCode server and resolves plugins once, when that process starts. After an install, restart OpenChamber, then check the running server.

```powershell
pwsh -File D:\dev\simpsonm09\projects\repos\simpsonm09-maxstack\scripts\verify-live-server.ps1
```

`Install-Workspace.ps1` warns when a managed OpenChamber server is running.
