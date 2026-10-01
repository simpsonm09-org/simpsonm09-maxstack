---
name: setup-pstack-opencode
description: Configure PStack subagent profiles for OpenCode without using Claude model sheets or unsupported instructions settings
---

# Set up PStack agent profiles for OpenCode

OpenCode selects subagents by agent ID. A profile can set its own model, or inherit the current session model. OpenCode does not load PStack's model sheet from the `instructions` array and does not accept Claude's per-call `model` or `subagent_type` fields.

## Current profiles

- `pstack-agent` is the default PStack worker and inherits the current session model.
- `pstack-reviewer` is read-only and inherits the current session model.
- `pstack-comment-sicko` is the read-only comment reviewer and inherits the current session model.

The profiles are defined in `maxstack/opencode/agents/` and installed under `~/.config/opencode/agents/` for each runtime. Do not edit an installed copy. Edit the source profile and rerun the runtime installer.

## Add a model override

1. Use `/models` in the target project and choose a model that the provider makes available there.
2. Confirm the exact `provider/model` ID and any supported `#variant`.
3. Add that value to the chosen profile's `model` frontmatter. Omit `model` when the profile should inherit the current session model.
4. Run a fresh PStack subagent session and inspect its reported model before relying on the override.

This setup does not generate per-role profiles or promise multi-model diversity. OpenChamber Multi-run can compare models in separate sessions, but the parent must still perform PStack's judging and synthesis steps.
