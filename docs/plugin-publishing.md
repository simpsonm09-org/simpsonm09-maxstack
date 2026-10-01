# Plugin publishing

This repository does not own the plugin. [`simpsonm09-org/pstack-opencode-plugin`](https://github.com/simpsonm09-org/pstack-opencode-plugin) is the source of truth for the plugin package. `maxstack` pins that package and assembles the workspace bundle the OpenCode and OpenChamber runtimes load.

## Inputs

- `layers.json` is the ordered layer manifest. Each layer has a `name`, a `kind` (`plugin` or `config`), a checkout `path` under the workspace, and a `source` URL. A layer with a `pluginTarget` is copied into `.opencode/plugins`.
- `pstack-opencode.lock.json` pins the plugin repository and the exact commit to install.
- `models.json` is the model policy. The installer writes `roles.primary` into the workspace config and the matching role into each agent profile.
- `workspace/opencode.jsonc` is the config base. Layer fragments supply the MCP servers and extra permissions.

## Assembly

`scripts/Install-Workspace.ps1` runs in audit mode by default and changes nothing. With `-Apply` it:

1. Checks that each layer checkout exists and that the plugin layer has an `index.ts`.
2. Warns when the plugin checkout HEAD differs from the pinned commit.
3. Merges every config layer's `opencode.fragment.jsonc` into `D:\dev\simpsonm09\opencode.jsonc` and sets the primary model.
4. Copies each plugin layer's `layer.json` `files` list, or the default item list, into `.opencode/plugins/<pluginTarget>`, then runs `npm install` there.
5. Copies the plugin layer's `agents/*.md` into `.opencode/agents` and injects the model line from `models.json`.
6. Writes `stack.lock.json` at the workspace root.

## The recorded lock

`stack.lock.json` is the install-provenance record. `Install-Workspace.ps1` writes it at the workspace root, not in this repository. It records `generatedAt`, `primaryModel`, the SHA-256 of the written workspace config, and one entry per layer with its `name`, `kind`, `path`, `source`, and installed `commit`.

## Validation

`.github/workflows/ci.yml` runs `scripts/verify-manifests.py` in the `validate` job. The script checks that `layers.json`, `pstack-opencode.lock.json`, `models.json`, and `workspace/opencode.jsonc` agree with each other and with the installer, without cloning the private plugin repository. The plugin repository validates its own generated `skills/` tree in its `verify-pin.yml` workflow.

## Publishing a new bundle

1. Merge the plugin change in `pstack-opencode-plugin` and note the merge commit.
2. Update the `commit` in `pstack-opencode.lock.json`, and the `path` or `source` if the layer moved.
3. Run `pwsh -File scripts/Install-Workspace.ps1 -Apply`.
4. Restart OpenChamber, then run `scripts/verify-live-server.ps1` to confirm the running server loaded the bundle.
