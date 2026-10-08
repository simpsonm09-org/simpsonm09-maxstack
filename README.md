# maxstack

Personal AI tooling for OpenCode and Claude Code, run from T3 Code. It coordinates the workspace config and the installer, and it pins the PStack plugin. maxstack sets no model: you pick the model in the harness.

The original lives in `simpsonm09-org/simpsonm09-maxstack`; work happens on the personal fork. See [`repo-standard`](https://github.com/simpsonm09-org/simpsonm09-repo-standard).

## What it does

`maxstack` owns AI composition for the `D:\dev\simpsonm09` workspace. It holds the workspace config fragment and the installer, and it pins the PStack plugin package. `simpsonm09-dev-setup` owns the machine and the human tool set, including a self-hosted Infisical Agent Vault that brokers service credentials for the agent. A wrapper is the entry point: `with-secrets <tool>` for the human loader path, and `with-vault --role human <tool>` or `with-vault --role agent <tool>` for the vault path. See [`docs/relationship.md`](docs/relationship.md).

PStack itself is an OpenCode plugin in [`simpsonm09-org/pstack-opencode-plugin`](https://github.com/simpsonm09-org/pstack-opencode-plugin). `maxstack` installs that package into `D:\dev\simpsonm09\.opencode\plugins` and strips any model line from the installed agent profiles. Nothing is global.

The same installed plugin directories also serve Claude Code. The installer builds `.claude\plugins`, one folder per Claude plugin: the local plugins are junctions to the installed OpenCode copies, and pstack is a copy of its pinned upstream folder. A T3 Claude provider instance passes `--plugin-dir` for that folder. OpenCode needs nothing extra. See [`docs/t3-setup.md`](docs/t3-setup.md).

## Guardrails

- Never commit API keys, OAuth tokens, OpenCode auth storage, session databases, or local app state.
- Keep PStack scoped to `D:\dev\simpsonm09`. Do not install it globally.
- Edit the plugin in the `pstack-opencode-plugin` repository, never the installed copy.
- Test changes in a disposable project before relying on them.

## Quick start

```powershell
pwsh -File scripts/Install-Workspace.ps1 -Apply
```

Start a new T3 session after an install. T3 starts OpenCode per session, and Claude Code reads the plugin folder at session start. See [`docs/install.md`](docs/install.md).

## Commands

| Command | Does |
| --- | --- |
| `just lint` | Runs the linters over changed files. |
| `just lint-full` | Runs the linters over every tracked file. |
| `just aislop` | Runs the AI-slop gate. |
| `just security` | Scans the filesystem with Trivy. |
| `just validate` | Validates the workspace manifests the installer consumes. |
| `just validate-online` | Also checks the Claude pin against GitHub. Needs `gh` and network. |
| `just check` | Runs lint and validate. |

## Documentation

Read [`docs/README.md`](docs/README.md) for the layout, the model rule, the MCP servers, and the installer.

## License

MIT. See [`LICENSE`](LICENSE).

## Related repositories

- [`pstack-opencode-plugin`](https://github.com/simpsonm09-org/pstack-opencode-plugin) owns the plugin package.
- [`org-ai-plugin`](https://github.com/simpsonm09-org/simpsonm09-org-ai-plugin) owns the shared MCP servers and skills.
- [`personal-ai-plugin`](https://github.com/simpsonm09-org/simpsonm09-personal-ai-plugin) owns the personal MCP servers and skills.
- [`simpsonm09-dev-setup`](https://github.com/simpsonm09-org/simpsonm09-dev-setup) owns the machine and app setup.
- [`repo-standard`](https://github.com/simpsonm09-org/simpsonm09-repo-standard) owns the shared CI, linting, security, and governance.
- [`repo-template`](https://github.com/simpsonm09-org/simpsonm09-repo-template) is the generated-repo starting point.
