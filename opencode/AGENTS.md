# PStack on OpenCode

Before analysis or planning, call the `skill` tool with ID `poteto-mode` for any task that changes more than one file, changes a function signature or shared API, involves an architecture choice, has an unknown bug cause, or requires performance investigation. Do not answer with a plan first. Small, isolated edits can proceed directly.

This is a model instruction, not an enforcement hook. If the task needs guaranteed PStack routing, explicitly select or request `poteto-mode` with `/poteto-mode`.

When a PStack skill names Claude tools, apply the OpenCode mapping:

- Load a skill with the `skill` tool and its exact ID.
- Use the `question` tool for `AskUserQuestion` when the client supports interactive questions.
- Use the `subagent` tool with an installed OpenCode agent ID for `Agent` or `Task`. Use `pstack-agent` for a worker, `pstack-reviewer` for a read-only review, and `pstack-comment-sicko` for comment review. Do not pass Claude's `subagent_type` or per-call `model` fields.
- Use the PStack role profile's model when it has one. Otherwise, let the subagent inherit the current session model. Never pass PStack's Claude model names to OpenCode.
- Use an uncommitted `todo.md` when a workflow asks for task tracking and no task tool is available.

Read the `pstack-opencode` skill for the full mapping. Do not use the upstream `setup-pstack` model sheet on OpenCode. OpenCode V2 does not load files listed in the `instructions` array. Use `setup-pstack-opencode` for the supported agent-profile approach.

Claude Code's `run`, `loop`, SessionStart hooks, and `~/.claude/projects` transcript paths are not OpenCode features. Do not claim those workflows work unchanged. Use a project verification skill or OpenCode tools for app checks. OpenChamber Multi-run and worktree sessions are optional UI workflows, not automatic equivalents to PStack's subagent panels.
