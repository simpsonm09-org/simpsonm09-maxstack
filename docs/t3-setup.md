# T3 setup

T3 can run OpenCode and Claude Code against the same workspace. The two harnesses find the plugin layers differently, so each needs its own setup.

## OpenCode

Nothing to configure. OpenCode walks up from the session directory to the filesystem root and merges each `opencode.jsonc` and `.opencode` it finds. So `D:\dev\simpsonm09\opencode.jsonc` and `D:\dev\simpsonm09\.opencode` apply to every repository and git worktree under the workspace. This was verified with OpenCode 2.0.24.

## Claude Code

Claude Code does not walk up for plugins. The installer therefore builds one folder of Claude plugins at the workspace root, `D:\dev\simpsonm09\.claude\plugins`. Each child folder is one plugin. A T3 Claude provider instance points at that folder:

1. Generate the folder: `pwsh -File scripts/Install-Workspace.ps1 -Apply`.
2. In T3, add a Claude provider instance whose launch arguments are `--plugin-dir D:\dev\simpsonm09\.claude\plugins`.
3. Fleet projects select that instance through the project's default model.

Plain `claude` outside T3 takes the same flag, so `claude --plugin-dir D:\dev\simpsonm09\.claude\plugins` gives the same plugins.

The alternative is an instance environment entry, `CLAUDE_CODE_PLUGIN_DIRS`, with the child folders listed and separated by `;`. The installer does not generate that list; it is the same folders as the `--plugin-dir` route.

| Plugin | Folder | Source | Skills appear as |
| --- | --- | --- | --- |
| `pstack` | `.claude\plugins\pstack` | a copy of `plugins/pstack` at commit `8d3aa57` of `michael-denyer/pstack-claude` | `pstack:poteto-mode`, and the other `pstack:*` skills |
| `simpsonm09-org-ai-plugin` | `.claude\plugins\simpsonm09-org-ai-plugin` | a junction to `.opencode\plugins\simpsonm09-org-ai-plugin` | `simpsonm09-org-ai-plugin:repo-standard`, and the other `simpsonm09-org-ai-plugin:*` skills |
| `simpsonm09-personal-ai-plugin` | `.claude\plugins\simpsonm09-personal-ai-plugin` | a junction to `.opencode\plugins\simpsonm09-personal-ai-plugin` | `simpsonm09-personal-ai-plugin:dev-tools`, and the other `simpsonm09-personal-ai-plugin:*` skills |

The local folders are junctions to the installed OpenCode copies, so there is still one installed copy for both harnesses. One `Install-Workspace.ps1 -Apply` updates both. A junction needs no administrator rights. Each plugin's hooks run only in sessions that load it, and they resolve their files through the junction.

The pstack folder is a copy, not a junction. Its OpenCode copy comes from the port repository, not from upstream's `plugins/pstack`, so the Claude side needs its own copy of the upstream folder. The installer clones the upstream repository into `.claude\cache\pstack-claude`, sparse to `plugins/pstack`, and checks out the pinned commit. The cache is reused offline once it holds the commit.

## Checks

- The audit prints drift for each child without writing anything: `pwsh -File scripts/Install-Workspace.ps1`. It reports `missing`, `differs`, `matches`, or `stale`. A `stale` line also marks a folder under `.opencode\plugins` that no layer names. `-Apply` removes such a folder only when the previous `stack.lock.json` recorded it as a layer target, and reports any other one as kept.
- The OpenCode check runs from the workspace and starts no server: `pwsh -File scripts/verify-opencode-workspace.ps1`. It runs `opencode debug config` and `opencode debug agents`, each with a 60-second limit.
- The workspace verifier checks each child against `stack.lock.json`: `python scripts/verify-workspace-install.py`.
- A live probe from a scratch repository under `projects\repos`: `claude -p --model haiku --plugin-dir D:\dev\simpsonm09\.claude\plugins --output-format stream-json --verbose "List the plugin skills you have whose names start with simpsonm09. Reply with just the names."` The init event lists the loaded plugins and skills.

## Why not `--settings`

An earlier design gave each T3 instance `--settings <file>`, which holds a marketplace and enabled plugins. T3 passes its own settings through the Claude Agent SDK when thinking summaries are on. Claude keeps only the last `--settings` flag it is given, so one of the two was always silently dropped. `--plugin-dir` is not used by T3, so it does not collide with T3's flags. Multiple `--plugin-dir` flags add up rather than replacing each other.

## Behaviour to know

- Each plugin folder is read when a session starts. Re-run the installer, then start a new session.
- The OpenCode provider starts its own `opencode serve` for each session, so a new session loads the installed OpenCode plugins too. There is no long-lived server to restart.
- The first session already sees pstack. Nothing is fetched at session start, because the folder is already on disk.
- The folder has no absolute path in it. A junction records its target internally, and the installer recreates it on each apply.

## Verified

- `--plugin-dir <parent>` loads each child folder, junctions included. The plugin reports as `<name>@inline`.
- `CLAUDE_CODE_PLUGIN_DIRS` loads the listed folders with no flag.
- `--plugin-dir` alongside `--settings '{"showThinkingSummaries":true}'` keeps the plugins and all their skills loaded.
- The org SessionStart hook runs through the junction, and `${CLAUDE_PLUGIN_ROOT}` resolves there.
- The org PreToolUse hook runs through the junction. A Bash command that mentions the GitHub token launcher is denied by it.

## Generated files and git

The workspace root is not a git repository. Its `.gitignore` (`D:\dev\simpsonm09\.gitignore`) is defence in depth in case anyone runs `git init` there. It already ignores `.opencode/plugins/`, `opencode.jsonc`, and `stack.lock.json`. Add these two lines for the Claude folders:

```gitignore
.claude/plugins/
.claude/cache/
```

This repository does not edit that file, because it sits outside the repository.
