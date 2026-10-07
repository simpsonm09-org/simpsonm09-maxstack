# Repository relationships

This document names how the pieces fit together. It covers the repositories that own AI composition, the ordered plugin layers, the one cross-repo edge, the Agent Vault, and what the workspace is.

## Ownership

`maxstack` owns AI composition. It holds the workspace config fragment, the model policy, the ordered layer manifest, the installer, and the pin on the plugin package. It composes the AI layer and does not own any layer it installs.

`dev-setup-starter` owns the machine and the human tool set. It holds the tools a person installs on a host, the `tools.yaml` manifest, the secrets loaders, and the Agent Vault wrappers. It does not own AI composition.

The three plugin layers own the skills, the agents, and the MCP servers. Order matters, and each later layer builds on the one before it.

| Repository | Layer | Owns |
| --- | --- | --- |
| `pstack-opencode-plugin` | base | The plugin package: the PStack skills, the agent profiles, and the adapter that registers them. |
| `simpsonm09-org-opencode-plugin` | general and portable | MCP servers and skills that apply to any person or machine. |
| `simpsonm09-personal-opencode-plugin` | person and machine | MCP servers and skills that name one person and one machine. |
| `simpsonm09-maxstack` | none | AI composition: the config fragment, the model policy, the layer manifest, the installer, and the plugin pin. |
| `dev-setup-starter` | none | The machine and the human tool set: tool installs, `tools.yaml`, the secrets loaders, and the Agent Vault wrappers. |

`layers.json` lists the three plugin layers in order. `maxstack` reads that order, copies each layer that carries a `pluginTarget` into `.opencode/plugins`, merges the config fragments, and installs the agent profiles. A later layer wins where two layers set the same value.

## The cross-repo edge

`scripts/Install-Workspace.ps1` reads `layers.json` in `maxstack`. The machine tool list, `tools.yaml`, lives in `dev-setup-starter`. The two manifests never read each other. They meet at the workspace, where `maxstack` writes the AI config and `dev-setup-starter` installs the tools a person runs there. A change to the layer order belongs in `maxstack`; a change to the machine tool set belongs in `dev-setup-starter`.

## The agent tool check

The org integration registry in `simpsonm09-org-opencode-plugin` names one CLI owner per service. `dev-setup-starter` owns the agent tool set: the ids in `tools.yaml` whose `consumers` list names `agent`. `just check-agent-tools` reads both sibling checkouts from the workspace root and fails when an owner has no matching agent tool. It normalizes an owner to a command token, maps the few names that differ from the tool id, and exempts the owners that are built in or not installable as a tool, each with a stated reason.

The check is workspace-local, not a CI gate. CI checks out `maxstack` alone, so the two sibling repositories are absent there. Run it from the workspace root, or point it at a checkout with `--dev-setup <path>` and `--org-plugin <path>`.

## The Agent Vault

The human and the agent reach a brokered service through a wrapper, never by putting a token in the environment. `dev-setup-starter` owns the wrappers and the vault setup, and the vault is part of the AI stack an agent runs on.

`with-secrets <tool>` is the human loader path. It loads the secrets a person needs on demand, into that one command only.

`with-vault --role human <tool>` and `with-vault --role agent <tool>` are the vault path. A self-hosted Infisical Agent Vault brokers the service credential, and the proxy attaches it to the request, so the tool never holds the token. `--role` is required, so a run is never silently misattributed.

Discord and Postman are reached through the wrappers. The vault holds no other service credential today, so the other CLI owners in [MCP servers](mcp.md) still authenticate once per runtime with their own tooling.

## The workspace

The workspace is the tree rooted at the directory that owns the generated `opencode.jsonc` and the `.opencode/plugins` directory. It is defined by behavior, not by a stored path.

Every repository beneath that root inherits the model, the agents, and the skills, because OpenCode merges the config of each ancestor directory. A session in any repository under the root sees the same model policy and the same skills as a session at the root.

The `.envrc` at the same root is the secret-loading boundary. The loaders read it when a shell enters the tree.

Do not store an absolute root. The same workspace is `D:\dev\simpsonm09` on Windows and `/mnt/d/dev/simpsonm09` in WSL, so a stored path is wrong in the other runtime. Record what each tool needs relative to the workspace, or read it from an environment variable.
