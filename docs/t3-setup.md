# T3 setup

T3 can run OpenCode, Claude Code, and the Copilot CLI against the same workspace. The three harnesses find the plugin layers differently, so each needs its own setup.

## OpenCode

Nothing to configure. OpenCode walks up from the session directory to the filesystem root and merges each `opencode.jsonc` and `.opencode` it finds. So `D:\dev\simpsonm09\opencode.jsonc` and `D:\dev\simpsonm09\.opencode` apply to every repository and git worktree under the workspace. This was verified with OpenCode 2.0.24.

The installer lists the PStack entry in the workspace `opencode.jsonc`, as `./.opencode/plugins/pstack/opencode`. The path is relative to that file, so it holds no machine-specific root and works from any session directory under the workspace.

## Claude Code

Claude Code does not walk up for plugins. The installer therefore builds one folder of Claude plugins at the workspace root, `D:\dev\simpsonm09\.claude\plugins`. Each child folder is one plugin. A T3 Claude provider instance points at that folder:

1. Generate the folder: `pwsh -File scripts/Install-Workspace.ps1 -Apply`.
2. In T3, add a Claude provider instance whose launch arguments are `--plugin-dir D:\dev\simpsonm09\.claude\plugins`.
3. Fleet projects select that instance through the project's default model.

Plain `claude` outside T3 takes the same flag, so `claude --plugin-dir D:\dev\simpsonm09\.claude\plugins` gives the same plugins.

The alternative is an instance environment entry, `CLAUDE_CODE_PLUGIN_DIRS`, with the child folders listed and separated by `;`. The installer does not generate that list; it is the same folders as the `--plugin-dir` route.

| Plugin | Folder | Source | Skills appear as |
| --- | --- | --- | --- |
| `pstack` | `.claude\plugins\pstack` | a copy of `plugins/pstack` from `simpsonm09/pstack-claude`, at the commit in `pstack.lock.json` | `pstack:poteto-mode`, and the other `pstack:*` skills |
| `simpsonm09-org-ai-plugin` | `.claude\plugins\simpsonm09-org-ai-plugin` | a junction to `.opencode\plugins\simpsonm09-org-ai-plugin` | `simpsonm09-org-ai-plugin:repo-standard`, and the other `simpsonm09-org-ai-plugin:*` skills |
| `simpsonm09-personal-ai-plugin` | `.claude\plugins\simpsonm09-personal-ai-plugin` | a junction to `.opencode\plugins\simpsonm09-personal-ai-plugin` | `simpsonm09-personal-ai-plugin:dev-tools`, and the other `simpsonm09-personal-ai-plugin:*` skills |

The local folders are junctions to the installed OpenCode copies, so there is still one installed copy for both harnesses. One `Install-Workspace.ps1 -Apply` updates both. A junction needs no administrator rights. Each plugin's hooks run only in sessions that load it, and they resolve their files through the junction.

The pstack folder is a copy, not a junction. It is not a junction because the OpenCode copy holds only `opencode/` and `skills/`, and the Claude plugin needs the whole folder. The installer fetches the fork into `.claude\cache\pstack`, sparse to `plugins/pstack`, and checks out the pinned commit. The cache is reused offline once it holds the commit.

## Copilot

The Copilot provider does not take plugin folders from the instance's arguments. T3 ignores `commandArgs` for registry ACP agents. So the installer writes a wrapper, `.maxstack\bin\copilot.cmd`, and the T3 instance starts the wrapper instead of `copilot`.

1. Generate the wrapper: `pwsh -File scripts/Install-Workspace.ps1 -Apply`. It needs the Copilot CLI installed. If Copilot is not on `PATH`, the installer skips the wrapper and says so. Install Copilot, then run it again.
2. In T3, copy the registry `copilot` provider instance. Set the copy's `config.commandPath` to `<workspace>/.maxstack/bin/copilot.cmd`, for example `D:/dev/simpsonm09/.maxstack/bin/copilot.cmd`.
3. Fleet projects select that instance through the project's default model.

The wrapper runs the Copilot CLI with one `--plugin-dir` for each layer that lists `copilot`, in layer order: pstack, then the org layer, then the personal layer. Each folder is the same `.claude\plugins` folder Claude Code uses. The wrapper then passes its own arguments through. The installer writes the Copilot executable's absolute path into the wrapper. If you move or reinstall Copilot, run the installer again.

### The ask switch

The wrapper sets `AGENT_ACCESS_COPILOT_ASK=allow` before it starts Copilot. This is needed because of how the org gate asks for approval.

The org gate answers a GitHub write that the access level permits with `ask`. Copilot then shows a prompt. Under T3 no one can answer that prompt, so the call fails. With the variable set to `allow`, the Copilot adapter turns that `ask` into `allow`. The denial reason and the rewrite stay the same.

The switch changes only that `ask`. Denials still apply, and the repository access level still applies. A call the gate denies is still denied.

A plain interactive `copilot` does not set the variable, so it keeps the prompt. The wrapper sets the variable only in its own process. Your shell and other programs do not see it.

The variable is set in the wrapper, not in the T3 instance, so other Copilot runs are not affected.

## Checks

- The audit prints drift for each child and each wrapper without writing anything: `pwsh -File scripts/Install-Workspace.ps1`. It reports `missing`, `differs`, `matches`, or `stale`. A `stale` line also marks a folder under `.opencode\plugins` that no layer names. `-Apply` removes such a folder only when the previous `stack.lock.json` recorded it as a layer folder, or when it is the retired `pstack-opencode` port, and reports any other one as kept.
- The OpenCode check runs from the workspace and starts no server: `pwsh -File scripts/verify-opencode-workspace.ps1`. It runs `opencode debug config` and `opencode debug agents`, each with a 60-second limit.
- The workspace verifier checks each runtime against `stack.lock.json`: `python scripts/verify-workspace-install.py`. For Copilot it checks each wrapper's hash, the ask switch, the plugin folders in order, and that the executable exists.
- A live probe from a scratch repository under `projects\repos`: `claude -p --model haiku --plugin-dir D:\dev\simpsonm09\.claude\plugins --output-format stream-json --verbose "List the plugin skills you have whose names start with simpsonm09. Reply with just the names."` The init event lists the loaded plugins and skills.

## Why not `--settings`

An earlier design gave each T3 instance `--settings <file>`, which holds a marketplace and enabled plugins. T3 passes its own settings through the Claude Agent SDK when thinking summaries are on. Claude keeps only the last `--settings` flag it is given, so one of the two was always silently dropped. `--plugin-dir` is not used by T3, so it does not collide with T3's flags. Multiple `--plugin-dir` flags add up rather than replacing each other.

## Behaviour to know

- Claude Code reads each plugin folder when a session starts. Re-run the installer, restart the running OpenCode server, then start a new session.
- T3 can reuse an already-running OpenCode server across sessions. Restart that server after reinstalling OpenCode plugins or skills; a new T3 session alone does not reliably reload them.
- The Copilot CLI reads its plugin folders when it starts, so a new Copilot session after an install is enough.
- The first session already sees pstack. Nothing is fetched at session start, because the folder is already on disk.
- The Claude folder has no absolute path in it. A junction records its target internally, and the installer recreates it on each apply. The Copilot wrapper does hold absolute paths, because the Copilot executable and the folders are named there.

## Verified

- `--plugin-dir <parent>` loads each child folder, junctions included. The plugin reports as `<name>@inline`.
- `CLAUDE_CODE_PLUGIN_DIRS` loads the listed folders with no flag.
- `--plugin-dir` alongside `--settings '{"showThinkingSummaries":true}'` keeps the plugins and all their skills loaded.
- The org SessionStart hook runs through the junction, and `${CLAUDE_PLUGIN_ROOT}` resolves there.
- The org PreToolUse hook runs through the junction. A Bash command that mentions the GitHub token launcher is denied by it.
- OpenCode 2.0.26 loads the nested pstack entry named in `opencode.jsonc`, and the root org and personal entries, from an installed workspace. The check used a temporary workspace and an unavailable model, so it made no model call.
- The generated `copilot.cmd` runs its executable with the switch set and every plugin folder in order, and passes arguments through. This was tested with a stand-in executable, not with T3 or a live Copilot session.

Not yet verified: a T3 Copilot provider instance that uses the wrapper, and a live Copilot session that loads the plugins through it.

## Generated files and git

The workspace root is not a git repository. Its `.gitignore` (`D:\dev\simpsonm09\.gitignore`) is defence in depth in case anyone runs `git init` there. It already ignores `.opencode/plugins/`, `opencode.jsonc`, and `stack.lock.json`. Add these lines for the generated runtime folders:

```gitignore
.claude/plugins/
.claude/cache/
.maxstack/bin/
```

This repository does not edit that file, because it sits outside the repository.
