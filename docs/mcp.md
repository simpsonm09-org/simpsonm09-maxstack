# MCP servers

`maxstack` composes the OpenCode configuration for the `D:\dev\simpsonm09` workspace from ordered layers. `scripts/Install-Workspace.ps1 -Apply` merges the layer fragments over [`workspace/opencode.jsonc`](../workspace/opencode.jsonc) and writes the result to `D:\dev\simpsonm09\opencode.jsonc`. It applies only inside that workspace. The layers and their pinned commits are recorded in `stack.lock.json` in the workspace root.

Precedence is personal over org over the base. The org layer and the personal layer each contribute no MCP server by default, so the composed default set is empty.

This is the OpenCode V2 shape. V2 config uses `mcp.servers`, keeps a configured server off with `disabled: true`, and has no `enabled` field.

## Default servers

The workspace is CLI-first. No MCP server is installed by default. Every service is reached through a CLI owner: `gh` for GitHub, `gh search code` and the local `grep` tool for code search, `postman` for the Postman cloud and `newman` for local and CI collection runs, `npx ctx7` for library docs, `@playwright/cli` for browser automation, the `chrome-devtools` CLI for performance and debugging, `acli` for Jira, `kubectl` and `helm` for Kubernetes, the Jenkins CLI for Jenkins, `infisical` for the workspace secret source, `mise` for pinned tool versions, `trivy` for scanning, and `just` for repository tasks. The `service-integrations` skill in `simpsonm09-org-opencode-plugin` is the general registry. It defers accounts, boards, workspaces, clusters, and personal services such as Discord, email, notifications, and texting to the personal layer.

`mcp.timeout.startup` stays at 120 seconds for the case where a server is added later, because a local server's first run downloads its npm package before the MCP handshake.

## Verify a server

```powershell
pwsh -File scripts/Test-McpServers.ps1
```

It reports each server's prerequisite, not the live session:

- `ok` means a remote endpoint answered a JSON-RPC initialize without auth, or an `npx` package resolves on npm.
- `auth` means the endpoint is reachable but needs a sign-in.
- `bad-url` means the URL is not an MCP endpoint.
- `missing-package` means the npm package does not exist.
- `needs-docker` means the command needs a Docker daemon.

The live connection state is in OpenChamber, on the MCP settings page, and in the OpenCode log (`mcp connected` / `mcp connect failed`).

## Auth and sign-in

- The `github`, `postman`, and `context7` MCP servers were removed in favor of their CLIs. Authenticate the CLI once per runtime.
- GitHub uses `gh`. Run `gh auth status`, then `gh auth login`.
- Postman uses `postman`. Install with `npm install -g postman-cli`, then `postman login --with-api-key $env:POSTMAN_API_KEY`. The key lives in Infisical as `POSTMAN_API_KEY`; load it with `simpsonm09-dev-setup/scripts/Import-Secrets.ps1 -Apply` on Windows, or the workspace `.envrc` in WSL. See [`../../simpsonm09-dev-setup/docs/secrets.md`](../../simpsonm09-dev-setup/docs/secrets.md).
- Library docs use `npx ctx7`. Anonymous works; `npx ctx7 login` raises the rate limit.
- If a server is added later and reports `needs_auth`, sign in from OpenChamber on the Settings -> MCP page with the Authorize action.

## Notes and removals

- `grep_app`, `playwright`, and `chrome-devtools` were the last servers and are now removed. Code search moved to `gh search code` plus the local `grep` tool; Playwright and Chrome DevTools moved to their CLIs. The composed default set is empty.
- `context7`, `github`, `postman`, and `sequential-thinking` were removed in favor of CLI tools. `npx ctx7`, `gh`, and `postman` cover their jobs with far fewer tools in context. `sequential-thinking` added no capability for a reasoning model.
- `fetch` was removed. `@modelcontextprotocol/server-fetch` does not exist on npm, and OpenCode already has a built-in `webfetch` tool, so the server was redundant.
- `sqlite` was removed. It ran `docker run mcp/sqlite`, and Docker is not on the Windows PATH on this workstation; the WSL Docker daemon is not group-enabled, so it would need an interactive `sudo`.

## Turn one on per project

Create `opencode.json` at the root of the nested repository that needs a disabled server. OpenCode discovers the workspace config as an ancestor and merges this on top.

```jsonc
{
  "mcp": {
    "servers": {
      "playwright": {
        "type": "local",
        "command": ["npx", "-y", "@playwright/mcp@latest"]
      }
    }
  }
}
```

Remote secrets use `{env:NAME}`. Never write a secret into the config.

## Layer plugin entries

A config layer can also register skills through an OpenCode plugin. `simpsonm09-org-opencode-plugin` and `simpsonm09-personal-opencode-plugin` each carry an `index.ts`, a `package.json`, and a `skills/` directory. `Install-Workspace.ps1` copies them into `.opencode/plugins/simpsonm09-org-opencode` and `.opencode/plugins/simpsonm09-personal-opencode`, and OpenCode loads them next to `pstack-opencode`.

| Plugin | Skill | Purpose |
| --- | --- | --- |
| `simpsonm09-org-opencode` | `service-integrations` | The general integration registry: which CLI owns each external-service job. It defers personal specifics to the personal layer. |
| `simpsonm09-org-opencode` | `repo-tasks` | Run, build, test, or verify a repository through its justfile. |
| `simpsonm09-org-opencode` | `repo-standard` | The gates, the definition of done, and the branch and pull request flow. |
| `simpsonm09-org-opencode` | `local-services` | The container stack on the machine: Docker, Portainer, Infisical, and DbGate. |
| `simpsonm09-personal-opencode` | `integrations-personal` | The personal concretes the registry defers to, and the `himalaya`, `ntfy`, and `smsgate` services. |
| `simpsonm09-personal-opencode` | `dev-tools` | Where each personal tool's settings live and how to apply them. |
| `simpsonm09-personal-opencode` | `discord` | Discord through the `discli` CLI. |

Add a skill by creating `skills/<id>/SKILL.md` in the layer repository, then rerun `Install-Workspace.ps1 -Apply` and restart OpenChamber.
