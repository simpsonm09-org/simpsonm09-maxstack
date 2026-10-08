# Layout

- `AGENTS.md` sets working rules for changes to this repository.
- `layers.json` is the ordered layer manifest: the plugin layer and the org and personal config layers, each with its repo and checkout path. A layer may also declare a `pluginTarget` when it registers skills through an OpenCode plugin, and an optional `claude` block when it also registers skills with Claude Code.
- `.github/workflows/ci.yml` calls the shared `repo-standard` checks and runs the manifest validation. `mise.toml` pins the linters.
- `justfile` is the local task runner; its recipes mirror the CI checks.
- `pstack-opencode.lock.json` pins the plugin repository and the commit to install.
- `pstack-claude.lock.json` pins the Claude Code copy of the pstack plugin: the upstream repository, the plugin path, the release tag, the commit, and the upstream commit the OpenCode port pins. `scripts/verify-manifests.py --online` checks the tag and the port's pin against GitHub.
- `workspace/opencode.jsonc` is the workspace config base: default agent, permissions, and the MCP startup timeout. It sets no model. Layer fragments supply the MCP servers.
- `docs/mcp.md` defines the workspace MCP servers and their default states. `docs/mcp-installation-guide-v2.md` is the original source guide.
- `docs/plugin-publishing.md` describes how the installer assembles the plugin bundle and records it in `stack.lock.json`, and how CI validates it.
- `docs/t3-setup.md` is the T3 setup: OpenCode needs nothing extra, and Claude Code needs a provider instance whose launch arguments pass `--plugin-dir` to the generated `.claude\plugins` folder.
- `docs/relationship.md` names how `maxstack`, the three plugin layers, and `simpsonm09-dev-setup` fit together, and defines the workspace by behavior.
- `scripts/Install-Workspace.ps1` merges the layer fragments, copies every layer that has a `pluginTarget` into `.opencode/plugins`, installs its dependencies, installs the agent profiles with any model line removed, writes the workspace config, builds the Claude plugin folder `.claude/plugins` from the `claude` blocks (links for local layers, pinned copies for git layers), and records the layers in `stack.lock.json`.
- `scripts/check-agent-tools.mjs` checks that the agent tool set in `simpsonm09-dev-setup` covers the service owners the org integration registry names. It is workspace-local and reads the sibling checkouts, so CI does not run it.
- `scripts/Invoke-OpenCode.ps1` is the bounded OpenCode call the verifiers share: a time limit, a process-tree kill, and a message that names the command.
- `scripts/verify-*` verify the installed workspace bundle. `scripts/verify-opencode-workspace.ps1` checks what a fresh OpenCode process resolves from the workspace, with no server. `scripts/verify-workspace-skill.ps1` runs a bounded OpenCode session that loads a skill. `scripts/verify-workspace-install.py` also checks the generated Claude files against `stack.lock.json`.
- `docs/decisions.tsv` is the append-only decision trail. `docs/setup-plan.md` is the historical setup plan.
