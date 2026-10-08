# Install and reload

## Model

maxstack sets no model. The workspace `opencode.jsonc` has no `model` or `small_model` key, and the installed agent profiles have no `model:` line, so each agent runs the model the session uses. You pick that model in the harness: the T3 Code model picker for a thread or project, or your own OpenCode or Claude Code settings. The PStack Claude plugin's per-role models are set with its own `/setup-pstack` command.

## Hosts

T3 Code hosts the agent sessions. It runs two providers against the same workspace:

- The OpenCode provider can reuse an already-running `opencode serve` across sessions. OpenCode reads the workspace `opencode.jsonc` and `.opencode` directory from the session directory upward.
- The Claude provider runs Claude Code with `--plugin-dir` pointing at `<workspace>\.claude\plugins`. See [T3 setup](t3-setup.md).

Ubuntu WSL can also run the OpenCode CLI. It reads the same workspace files under `D:\dev\simpsonm09`, which WSL sees at `/mnt/d/dev/simpsonm09`.

## Install and reload

The plugin must be checked out at `projects/repos/pstack-opencode-plugin`, or pass `-PluginSource`. The installer checks that checkout's git HEAD against `pstack-opencode.lock.json`.

```powershell
pwsh -File scripts/Install-Workspace.ps1 -Apply
```

After an install, restart the running OpenCode server, then start a new session in T3. T3 can reuse a long-lived server across sessions, and that server does not reliably reload plugins or skills after reinstall. Claude Code reads its `.claude\plugins` folder when a session starts.

Check the installed workspace:

```powershell
pwsh -File scripts/verify-opencode-workspace.ps1
python scripts/verify-workspace-install.py
```

`verify-opencode-workspace.ps1` runs `opencode debug config` and `opencode debug agents` from the workspace. It checks that OpenCode reads the workspace config and `.opencode` directory, and that the three PStack agents resolve with no model. It starts no server and makes no model call. Each OpenCode call has a 60-second limit; a call that runs past it fails the check and names the command. Plugin loading needs a model call, so `scripts/verify-workspace-skill.ps1 -Model <provider/model>` runs a bounded OpenCode session that loads a skill. It has a 180-second limit, and it needs a model because the workspace names none. `scripts/verify-workspace-skill.sh` takes the model as its second argument and the limit as its third.

## Claude Code

The same install also builds `.claude/plugins` at the workspace root: one child folder per Claude plugin. The local plugins are junctions to the installed OpenCode copies, and pstack is a copy of its pinned upstream folder. Claude Code reads the folder when a session starts, so a new session is enough. A T3 Claude provider instance passes `--plugin-dir <workspace>\.claude\plugins`. See [T3 setup](t3-setup.md).

Audit mode prints drift for `opencode.jsonc`, for each Claude child, and for each stale folder under `.opencode\plugins`, without writing or fetching anything.

A layer that is renamed leaves its old folder under `.opencode\plugins`. `-Apply` removes a folder there that no current layer names, but only when the previous `stack.lock.json` recorded it as a layer's `pluginTarget`, so the installer made it. Any other unnamed folder is reported as stale and kept. The same cleanup applies to `.claude\plugins`: `-Apply` removes a child that no layer declares, and audit reports it as stale.

## A legacy global install

The workspace bundle is the only PStack install. If an older global install is ever found, remove it by hand, on Windows under `%USERPROFILE%` and on WSL under `$HOME`. `scripts/verify-workspace-install.py` reports what remains. It checks these paths:

- `.agents/skills` holds no PStack skill (`poteto-mode` or a `principle-*` folder). Other tools, such as the Cursor CLI, install their own skills there, and those are left alone.
- `.config/opencode/AGENTS.md` is absent.
- `.config/opencode/agents/pstack-*.md` are absent.

An old `.config/opencode/opencode.jsonc` may still hold the `model` and `default_agent` lines from that install. Delete the ones it wrote. A model you chose yourself stays.
