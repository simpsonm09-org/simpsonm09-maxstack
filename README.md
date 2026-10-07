# maxstack

Personal AI tooling for OpenCode. It coordinates the workspace config, the model policy, and the installer, and it pins the PStack plugin.

The original lives in `simpsonm09-org/simpsonm09-maxstack`; work happens on the personal fork. See [`repo-standard`](https://github.com/simpsonm09-org/simpsonm09-repo-standard).

## What it does

`maxstack` owns AI composition for the `D:\dev\simpsonm09` workspace. It holds the workspace config fragment, the model policy, and the installer, and it pins the PStack plugin package. `dev-setup-starter` owns the machine and the human tool set. See [`docs/relationship.md`](docs/relationship.md).

PStack itself is an OpenCode plugin in [`simpsonm09-org/pstack-opencode-plugin`](https://github.com/simpsonm09-org/pstack-opencode-plugin). `maxstack` installs that package into `D:\dev\simpsonm09\.opencode\plugins` and applies the model policy to the installed agent profiles. Nothing is global.

## Guardrails

- Never commit API keys, OAuth tokens, OpenCode auth storage, session databases, or local app state.
- Keep PStack scoped to `D:\dev\simpsonm09`. Do not install it globally.
- Edit the plugin in the `pstack-opencode-plugin` repository, never the installed copy.
- Test changes in a disposable project before relying on them.

## Quick start

```powershell
pwsh -File scripts/Install-Workspace.ps1 -Apply
```

Restart OpenChamber after an install, then verify the running server. See [`docs/install.md`](docs/install.md).

## Commands

| Command | Does |
| --- | --- |
| `just lint` | Runs the linters over changed files. |
| `just lint-full` | Runs the linters over every tracked file. |
| `just aislop` | Runs the AI-slop gate. |
| `just security` | Scans the filesystem with Trivy. |
| `just validate` | Validates the workspace manifests the installer consumes. |
| `just check` | Runs lint and validate. |

## Documentation

Read [`docs/README.md`](docs/README.md) for the layout, the model policy, the MCP servers, and the installer.

## License

MIT. See [`LICENSE`](LICENSE).

## Related repositories

- [`pstack-opencode-plugin`](https://github.com/simpsonm09-org/pstack-opencode-plugin) owns the plugin package.
- [`org-opencode-plugin`](https://github.com/simpsonm09-org/simpsonm09-org-opencode-plugin) owns the shared MCP servers and skills.
- [`personal-opencode-plugin`](https://github.com/simpsonm09-org/simpsonm09-personal-opencode-plugin) owns the personal MCP servers and skills.
- [`dev-setup-starter`](https://github.com/simpsonm09-org/simpsonm09-dev-setup) owns the machine and app setup.
- [`repo-standard`](https://github.com/simpsonm09-org/simpsonm09-repo-standard) owns the shared CI, linting, security, and governance.
- [`repo-template`](https://github.com/simpsonm09-org/simpsonm09-repo-template) is the generated-repo starting point.
