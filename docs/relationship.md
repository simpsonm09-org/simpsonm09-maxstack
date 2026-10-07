# Repository relationships

This document names how the pieces fit together. It covers the repositories that own AI composition, the ordered plugin layers, the one cross-repo edge, and what the workspace is.

## Ownership

`maxstack` owns AI composition. It holds the workspace config fragment, the model policy, the ordered layer manifest, the installer, and the pin on the plugin package. It composes the AI layer and does not own any layer it installs.

`simpsonm09-dev-setup` owns the machine and the human tool set. It holds the tools a person installs on a host, the `tools.yaml` manifest, and the secrets loaders. It does not own AI composition.

The three plugin layers own the skills, the agents, and the MCP servers. Order matters, and each later layer builds on the one before it.

| Repository | Layer | Owns |
| --- | --- | --- |
| `pstack-opencode-plugin` | base | The plugin package: the PStack skills, the agent profiles, and the adapter that registers them. |
| `simpsonm09-org-opencode-plugin` | general and portable | MCP servers and skills that apply to any person or machine. |
| `simpsonm09-personal-opencode-plugin` | person and machine | MCP servers and skills that name one person and one machine. |
| `simpsonm09-maxstack` | none | AI composition: the config fragment, the model policy, the layer manifest, the installer, and the plugin pin. |
| `simpsonm09-dev-setup` | none | The machine and the human tool set: tool installs, `tools.yaml`, and the secrets loaders. |

`layers.json` lists the three plugin layers in order. `maxstack` reads that order, copies each layer that carries a `pluginTarget` into `.opencode/plugins`, merges the config fragments, and installs the agent profiles. A later layer wins where two layers set the same value.

## The cross-repo edge

`scripts/Install-Workspace.ps1` reads `layers.json` in `maxstack`. The machine tool list, `tools.yaml`, lives in `simpsonm09-dev-setup`. The two manifests never read each other. They meet at the workspace, where `maxstack` writes the AI config and `simpsonm09-dev-setup` installs the tools a person runs there. A change to the layer order belongs in `maxstack`; a change to the machine tool set belongs in `simpsonm09-dev-setup`.

## The workspace

The workspace is the tree rooted at the directory that owns the generated `opencode.jsonc` and the `.opencode/plugins` directory. It is defined by behavior, not by a stored path.

Every repository beneath that root inherits the model, the agents, and the skills, because OpenCode merges the config of each ancestor directory. A session in any repository under the root sees the same model policy and the same skills as a session at the root.

The `.envrc` at the same root is the secret-loading boundary. The loaders read it when a shell enters the tree.

Do not store an absolute root. The same workspace is `D:\dev\simpsonm09` on Windows and `/mnt/d/dev/simpsonm09` in WSL, so a stored path is wrong in the other runtime. Record what each tool needs relative to the workspace, or read it from an environment variable.
