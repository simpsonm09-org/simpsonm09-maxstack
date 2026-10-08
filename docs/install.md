# Install and reload

## Model defaults

Every role defaults to `opencode-go/deepseek-v4.1-flash`. `models.json` maps `primary` (the workspace model), `worker` (`pstack-agent`), `reviewer` (`pstack-reviewer`), and `comment-sicko` (`pstack-comment-sicko`). Change a value there, then rerun `Install-Workspace.ps1 -Apply`. A model chosen inside T3 for a thread or project is separate app state and is not applied by this file.

## Hosts

T3 Code hosts the agent sessions. It runs two providers against the same workspace:

- The OpenCode provider starts its own `opencode serve` for each session. OpenCode reads the workspace `opencode.jsonc` and `.opencode` directory from the session directory upward.
- The Claude provider runs Claude Code with `--plugin-dir` pointing at `<workspace>\.claude\plugins`. See [T3 setup](t3-setup.md).

Ubuntu WSL can also run the OpenCode CLI. It reads the same workspace files under `D:\dev\simpsonm09`, which WSL sees at `/mnt/d/dev/simpsonm09`.

## Install and reload

The plugin must be checked out at `projects/repos/pstack-opencode-plugin`, or pass `-PluginSource`. The installer checks that checkout's git HEAD against `pstack-opencode.lock.json`.

```powershell
pwsh -File scripts/Install-Workspace.ps1 -Apply
```

After an install, start a new session in T3. There is no long-lived server to restart. Each session reads the installed plugins when it starts: the OpenCode provider's new `opencode serve`, and Claude Code's `.claude\plugins` folder.

Check the installed workspace:

```powershell
pwsh -File scripts/verify-opencode-workspace.ps1
python scripts/verify-workspace-install.py
```

`verify-opencode-workspace.ps1` runs `opencode debug config` and `opencode debug agents` from the workspace. It checks that OpenCode reads the workspace config and `.opencode` directory, and that the three PStack agents carry the models from `models.json`. It starts no server and makes no model call. Plugin loading needs a model call, so `scripts/verify-workspace-skill.ps1` runs a bounded OpenCode session that loads a skill.

## Claude Code

The same install also builds `.claude/plugins` at the workspace root: one child folder per Claude plugin. The local plugins are junctions to the installed OpenCode copies, and pstack is a copy of its pinned upstream folder. Claude Code reads the folder when a session starts, so a new session is enough. A T3 Claude provider instance passes `--plugin-dir <workspace>\.claude\plugins`. See [T3 setup](t3-setup.md).

Audit mode prints drift for `opencode.jsonc` and for each Claude child, without writing or fetching anything.
