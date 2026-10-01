---
name: pstack-opencode
description: Translate PStack's Claude-specific tools, agents, model references, and runtime assumptions to OpenCode V2 and OpenChamber
---

# PStack on OpenCode

PStack's shared skills use Claude Code tool names. OpenCode loads the same skill tree, but the agent must translate the calls and respect OpenCode's configuration model.

The global `AGENTS.md` routing instruction is best-effort. For guaranteed activation, select or request `poteto-mode` with `/poteto-mode` before the task.

## Tool mapping

| PStack reference | OpenCode V2 behavior |
| --- | --- |
| `Skill` or `/skill-name` | Call the `skill` tool with the exact path-derived skill ID. |
| `AskUserQuestion` | Call `question` when the current client supports the interactive form. Otherwise ask the question in plain text and wait. |
| `Agent` or `Task` | Call `subagent` with an installed agent ID, a description, and a prompt. Use `pstack-agent` for a worker, `pstack-reviewer` for a read-only review, or `pstack-comment-sicko` for comment review. |
| `subagent_type` | No equivalent field. Select an agent by its OpenCode ID. |
| `model` on an agent call | No per-call model field. A configured agent may name a `provider/model` and `#variant`; otherwise it inherits the parent session model. |
| `TaskCreate`, `TaskUpdate`, or `TodoWrite` | Use an uncommitted `todo.md` checklist when no task-tracking tool is available. |
| Claude Code `run` | No equivalent built-in skill. Use a project verification skill and OpenCode's available shell or browser tools. |
| Claude Code `loop` | No equivalent built-in skill. Re-check manually or use an explicit OpenChamber scheduled task when the task fits. |

Do not translate PStack's Claude model aliases such as `opus`, `fable`, or `sonnet` into OpenCode model IDs. Select real provider/model IDs from `/models`. Use the current session model unless a named OpenCode agent profile sets a model.

## Model configuration

OpenCode V2 accepts an `instructions` array in `opencode.json(c)` but does not load its entries. Do not use `~/.config/opencode/pstack-models.md` through that setting. The upstream `setup-pstack` sheet does not control OpenCode subagent models.

For the current setup, PStack subagents inherit the active session model. To add a role-specific model, create or edit a named agent profile under `~/.config/opencode/agents/` or the project's `.opencode/agents/`. Put the confirmed `provider/model` and optional `#variant` in the profile. Keep the agent ID mapping in `AGENTS.md`. Do not claim role-specific routing until a real child session reports the selected model.

## OpenChamber-specific options

OpenChamber runs on an OpenCode server. Its personal skills and project skills use the app's Settings UI; OpenCode's global and project skill paths also work when the managed server can see them.

OpenChamber Multi-run can start separate sessions with the same prompt and optionally isolate them in worktrees. Use it as a user-selected way to compare runs. It does not run PStack's cross-judge or synthesis steps automatically. The Agent Control Tool can create and follow sessions on a managed local server, but it is not available to the OpenCode CLI and is not a required PStack tool.

## Runtime-only paths

Do not read Claude Code transcript paths such as `~/.claude/projects/` from OpenCode. Use OpenCode's documented session API or mark a transcript-dependent PStack workflow unsupported. Do not inspect OpenCode or OpenChamber databases directly. Keep app credentials and session state in their local stores.
