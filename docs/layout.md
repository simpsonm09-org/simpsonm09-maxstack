# Layout

- `AGENTS.md` sets working rules for changes to this repository.
- `models.json` is the model policy: a default plus per-role overrides. `Install-Workspace.ps1` applies it.
- `layers.json` is the ordered layer manifest: the plugin layer and the org and personal config layers, each with its repo and checkout path. A layer may also declare a `pluginTarget` when it registers skills through an OpenCode plugin.
- `.github/workflows/ci.yml` calls the shared `repo-standard` checks and runs the manifest validation. `mise.toml` pins the linters.
- `justfile` is the local task runner; its recipes mirror the CI checks.
- `pstack-opencode.lock.json` pins the plugin repository and the commit to install.
- `workspace/opencode.jsonc` is the workspace config base: model, default agent, permissions, and the MCP startup timeout. Layer fragments supply the MCP servers.
- `docs/mcp.md` defines the workspace MCP servers and their default states. `docs/mcp-installation-guide-v2.md` is the original source guide.
- `docs/plugin-publishing.md` describes how the installer assembles the plugin bundle and records it in `stack.lock.json`, and how CI validates it.
- `docs/relationship.md` names how `maxstack`, the three plugin layers, and `simpsonm09-dev-setup` fit together, and defines the workspace by behavior.
- `scripts/Install-Workspace.ps1` merges the layer fragments, copies every layer that has a `pluginTarget` into `.opencode/plugins`, installs its dependencies, installs the agent profiles with models from `models.json`, writes the workspace config, and records the layers in `stack.lock.json`.
- `scripts/Remove-GlobalPstack.ps1` and `scripts/remove-global-pstack.sh` remove the previous global installs on Windows and WSL.
- `scripts/verify-*` verify the installed workspace bundle in each runtime, including the live OpenChamber server.
- `docs/decisions.tsv` is the append-only decision trail. `docs/setup-plan.md` is the historical setup plan.
- `opencode/` is a frozen snapshot of the legacy global content, retained only as the global-removal match target.
