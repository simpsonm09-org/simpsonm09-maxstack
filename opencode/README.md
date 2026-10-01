# OpenCode adapter sources

These files are the OpenCode-specific translation of PStack. The sync script copies them into `packages/pstack-opencode`, and the plugin ships them from there.

- `AGENTS.md` is the historical global routing instruction. It is kept for reference and for the global-removal match. New installs get routing from the plugin's session hook instead.
- `agents/` holds the three native agent profiles: `pstack-agent`, `pstack-reviewer`, and `pstack-comment-sicko`. `Install-Workspace.ps1` copies them into `D:\dev\simpsonm09\.opencode\agents`.
- `skills/pstack-opencode` maps PStack's Claude tool names to OpenCode tools and documents the limits.
- `skills/setup-pstack-opencode` documents how to set a per-role model on an agent profile, since OpenCode cannot load the upstream model sheet.

Edit these sources, then run `scripts/sync-pstack-package.ps1`. Do not edit the copies under `packages/pstack-opencode`.

## Why agents are files

OpenCode's plugin API exposes `AgentEditor` with `list`, `get`, `default`, `update`, and `remove`. It has no `add`, so a plugin cannot create an agent. Agent profiles therefore ship as Markdown files and are installed into the workspace.

## Why the plugin owns skills

`SkillEditor.add` works, so the plugin registers every pinned skill at load time. A session in any nested repository under the workspace sees them. The one difference from a directory skill is that a transform-registered skill has no `<skill_files>` sample; PStack skills name their own supporting files, and the plugin sets each skill's `path` so the base directory resolves.
