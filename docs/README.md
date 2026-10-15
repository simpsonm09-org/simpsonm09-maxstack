# Documentation

Index for this repository.

## Guides

- [Install and reload](install.md) covers the model rule, the runtime and layer selection, the runtimes, layer sources and their overrides, `-Update`, the ownership record, removing a runtime or layer, and uninstalling.
- [T3 settings snapshot](features/t3-settings.md) documents the explicit source, allowlisted workspace snapshot, and read-only drift report.
- [Workspace settings](features/settings.md) describes workspace discovery and the optional selection file's additive behavior. Discovery is implemented in `scripts/Install-WorkspaceDiscovery.ps1` and tested by `scripts/Install-WorkspaceDiscovery.test.mjs`.
- [Current alignment](features/current-alignment.md) records the verified delivery state and the remaining acceptance work against the end goal.
- [Antigravity skills](features/antigravity.md) documents the opt-in Antigravity runtime and its shared skill ownership.
- [Layout](layout.md) describes every top-level path.
- [Repository relationships](relationship.md) names the repository ownership, the one cross-repo edge, and the workspace definition.
- [MCP servers](mcp.md) defines the workspace MCP servers and their default states.
- [MCP installation guide](mcp-installation-guide-v2.md) is the original source guide, kept for provenance.
- [Plugin publishing](plugin-publishing.md) describes how the installer assembles each runtime of each layer, and the one pstack pin.
- [T3 setup](t3-setup.md) covers running OpenCode, Claude Code, and the Copilot CLI from T3 against the workspace.
- [Master template](master-template.md) records the plan to maintain one master source and convert it for seven runtimes.
- [Neutral layer generator](neutral-layer-generator.md) defines the skill and OpenCode MCP projection, its output, ownership, and installer boundary.
- [Parity matrix](parity-matrix.md) records which AI behaviors are the same, different, or impossible in each of the seven runtimes, with evidence.
- [Setup plan](setup-plan.md) is the historical OpenCode setup plan. T3 Code hosts the sessions now.
- [Decisions](decisions.tsv) is the append-only decision trail.
