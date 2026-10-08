# maxstack working agreements

- Keep secrets, tokens, account state, and session databases out of this repository.
- `maxstack` owns AI composition. `simpsonm09-dev-setup` owns the machine and the human tool set, including `tools.yaml` and the secrets loaders. `docs/relationship.md` names how the repositories and the ordered plugin layers fit together.
- `maxstack` coordinates AI tooling but does not own the plugin. The plugin package lives in the `pstack-opencode-plugin` repository. Edit it there, never the installed copy under `.opencode`.
- PStack is scoped to `D:\dev\simpsonm09` through that workspace's `opencode.jsonc` and `.opencode` directory. Do not install it globally.
- maxstack sets no model. Do not add a `model` or `small_model` key to the workspace config, or a `model:` line to an agent profile. The user picks the model in the harness: the T3 Code model picker, or their own OpenCode or Claude Code settings. `Install-Workspace.ps1` regenerates the workspace config without a model and strips a `model:` line from the frontmatter of each profile it installs.
- Own the workspace MCP servers through the ordered layers in `layers.json`, and document them in `docs/mcp.md`. Shared servers live in `org-ai-plugin`; personal servers live in `personal-ai-plugin`. `Install-Workspace.ps1` merges the layer fragments into `workspace/opencode.jsonc`. Use the V2 `mcp.servers` shape and keep a server off with `disabled: true`; do not use the V1 shape or an `enabled` field.
- Install the workspace bundle with `scripts/Install-Workspace.ps1`. A legacy global PStack install is removed by hand; `docs/install.md` lists the paths to check.
- Regenerate the plugin's vendored skills in the `pstack-opencode-plugin` repository with its `scripts/build.ps1`, and verify with its `scripts/verify-pin.py`. CI runs the same pin check.
- Validate skills and agent profiles in both the WSL OpenCode CLI and a T3 session that uses the OpenCode provider.
- T3 Code hosts the sessions. After installing the workspace bundle, restart the running OpenCode server before verifying because T3 can reuse it across sessions and it does not reliably reload plugins or skills after reinstall. Claude Code reads `.claude\plugins` when a session starts. `scripts/verify-opencode-workspace.ps1` checks what a fresh OpenCode process resolves from the workspace.
