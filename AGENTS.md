# maxstack working agreements

- Keep secrets, tokens, account state, and session databases out of this repository.
- `maxstack` coordinates AI tooling but does not own the plugin. The plugin package lives in the `pstack-opencode-plugin` repository. Edit it there, never the installed copy under `.opencode`.
- PStack is scoped to `D:\dev\simpsonm09` through that workspace's `opencode.jsonc` and `.opencode` directory. Do not install it globally.
- `models.json` is the single model policy. Apply it with `scripts/Install-Workspace.ps1`; do not hand-edit `model:` lines in the installed agent profiles.
- Own the workspace MCP servers through the ordered layers in `layers.json`, and document them in `docs/mcp.md`. Shared servers live in `org-opencode-plugin`; personal servers live in `personal-opencode-plugin`. `Install-Workspace.ps1` merges the layer fragments into `workspace/opencode.jsonc`. Use the V2 `mcp.servers` shape and keep a server off with `disabled: true`; do not use the V1 shape or an `enabled` field.
- Install the workspace bundle with `scripts/Install-Workspace.ps1`. Remove an earlier global install with `scripts/Remove-GlobalPstack.ps1` or `scripts/remove-global-pstack.sh`. Both preview first.
- `opencode/` is a frozen snapshot of the legacy global content, kept only as the global-removal match target. Do not update it.
- Regenerate the plugin's vendored skills in the `pstack-opencode-plugin` repository with its `scripts/build.ps1`, and verify with its `scripts/verify-pin.py`. CI runs the same pin check.
- Validate skills and agent profiles in both the WSL OpenCode CLI and the Windows OpenChamber runtime.
- After installing the workspace bundle, restart OpenChamber before verifying. Its long-lived server resolves plugins once per process and does not recover until it restarts; `verify-live-server.ps1` checks the running server rather than a fresh process.
