# OpenCode and OpenChamber PStack setup

Historical plan for the initial workspace setup. Superseded by `repo-standard` and the framework rework plan.

## Completion checks

- PStack ships as the `pstack-opencode` plugin under `maxstack/packages/pstack-opencode` and is published privately at `simpsonm09/pstack-opencode`.
- The workspace bundle is installed at `D:\dev\simpsonm09`: `opencode.jsonc`, `.opencode\plugins\pstack-opencode`, and `.opencode\agents`.
- No global PStack install remains in the Windows or WSL runtime.
- A nested repository session in both runtimes loads `poteto-mode`, reads a skill sibling file, and exposes the routing instruction.
- `simpsonm09-dev-setup` no longer owns OpenCode configuration.
- Each completed change has a verification result in `decisions.tsv`.

## Boundaries

- Keep the upstream commit pinned in `maxstack/pstack.lock.json`.
- Keep provider credentials and app state in their local stores.
- The plugin cannot create agent profiles, so those ship as files under `.opencode\agents`.
- Automatic routing is a plugin instruction, not an enforcement hook.
