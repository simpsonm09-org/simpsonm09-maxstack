# Master template

This document records the design for one maintained source of AI functionality that `maxstack` converts for seven runtimes and installs into a workspace. It is a plan. Nothing here is built yet except the four runtimes the installer already supports.

## Goal

Maintain skills, agents, hooks, MCP servers, and instructions once. Install them so that every repository and worktree under a workspace folder, opened by any supported harness, has all of them.

The runtimes are Claude Code, GitHub Copilot CLI, OpenCode, Pi, Antigravity, Cursor, and Codex. The first four install today. Codex, Cursor, and Antigravity have no installer support.

## What the research found

Each harness decides for itself where it looks for configuration. Most do not look above the repository.

| Artifact | Across the seven runtimes |
| --- | --- |
| `SKILL.md` | Portable. Keep the frontmatter to `name`, `description`, `license`, `compatibility`, `metadata`, and `allowed-tools`. Claude-only keys break the other harnesses. |
| `AGENTS.md` | Portable. All seven read it. |
| MCP | Mostly portable. Claude Code and Cursor share the `mcpServers` JSON shape. OpenCode and Codex (TOML) need a conversion. |
| Hooks | A script that exits 2 on deny works in Claude Code, Copilot, Cursor, and Codex. OpenCode and Pi need a TypeScript shim. Antigravity is unchecked. |
| Agents | Five formats: Claude Code and Cursor markdown, Copilot profiles, OpenCode markdown, Codex TOML. Conversion needed. |
| Plugin manifests | No shared format. Repackage per runtime. |

How a workspace folder reaches the repositories beneath it:

| Runtime | Delivery |
| --- | --- |
| Claude Code, Copilot, OpenCode, Pi | A launch wrapper, flag, or environment variable. `CLAUDE.md` and Pi's `AGENTS.md` also walk up from the repository. |
| Codex | User level or per repository. `CODEX_HOME` relocates the user layer. Files in a folder above the git root are not read. |
| Cursor | Per repository or user level. No configuration-directory variable is documented. |
| Antigravity | Reads `.agents/` at the workspace root. Whether that reaches repositories opened inside the folder is unverified. |

Three behaviors constrain the design:

- A skill in a parent folder is invisible to most harnesses, because skill discovery stops at the repository or worktree root.
- Copilot, OpenCode, and Cursor read both `.claude/skills` and `.agents/skills`, so a skill present in both appears twice. Each workspace needs one canonical location per harness.
- Claude Code, Copilot, and Cursor hooks fail open on timeout or crash. A hook is a guardrail and not a sandbox.

## Design

1. **Neutral source per layer.** The org and personal repositories stay the source. Each keeps one tree: `skills/`, `agents/` with neutral frontmatter, `mcp.json`, `hooks/` with the gate core and its adapters, and `AGENTS.md`. PStack stays a pinned git source.
2. **One generator in `maxstack`.** It turns each layer into every runtime's format: plugin manifests, Codex TOML agents, OpenCode configuration, and Cursor and Antigravity rules. It runs when the installer applies and writes only into the workspace.
3. **Generated files are not committed.** Only neutral source is committed. CI fails when the generator's output differs from what the installer would write.
4. **Three delivery paths.**
   - A wrapper for Claude Code, Copilot, OpenCode, Pi, and Codex (through `CODEX_HOME`).
   - Files at the workspace root for Antigravity, once verified.
   - A generated stamp in each repository and worktree for Cursor, and for any harness without a launch hook. The stamp is excluded through `.git/info/exclude`, so nothing is committed and `git status` stays clean. A worktree created later needs the stamp step too.
5. **PStack follows upstream.** The fork branch carries only what upstream lacks. The generator converts PStack's agents for other runtimes, so the fork keeps no per-runtime copies.
6. **A workspace selects layers.** A second workspace, such as `mds368`, lists its own layers and runtimes. It needs no new code.

## Constraints that carry over

- Pi runs with no third-party extensions. The org gate and PStack's own Pi extension are the only extensions.
- Claude subscription credentials are not routed through Pi. Claude stays on Claude Code.
- Nothing in the workspace config is global. The deathpie workspace is untouched.
- The access gate decision lives only in `gate.mjs`. Each runtime adapter gathers inputs and applies the answer.

## Phases

| Phase | Scope | Proof |
| --- | --- | --- |
| 0 | Neutral schema, and generation of skills, instructions, and MCP. One PStack pin. The duplicate skill trees go. | The generated output for the four installed runtimes matches today's installs. |
| 1 | Agents and hooks conversion for those four runtimes. | The gate denies the same commands as today in each runtime. |
| 2 | Codex: a `codex` runtime key, a `CODEX_HOME` wrapper, a gate adapter. | A denied command is blocked in a Codex session. |
| 3 | Cursor and Antigravity: stamping and workspace-root files. | A skill and the gate work in each, quota permitting. |
| 4 | A second workspace. | `mds368` installs from its own layer list. |

## Open items

- Antigravity hooks and whether `.agents/` at the workspace root reaches an opened repository.
- Whether T3 can run a hook or stamp step when it creates a worktree.
- Whether moving `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `COPILOT_HOME`, or `PI_CODING_AGENT_DIR` moves credentials too. Test each before relocating.
- Duplicate pins: one PStack commit sits in `layers.json`, `pstack.lock.json`, and `stack.lock.json`. Phase 0 reduces it to one.
