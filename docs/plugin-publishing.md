# Plugin publishing

This repository does not own the plugin. [`simpsonm09-org/pstack-opencode-plugin`](https://github.com/simpsonm09-org/pstack-opencode-plugin) is the source of truth for the plugin package. `maxstack` pins that package and assembles the workspace bundle that the OpenCode runtimes load (the T3 OpenCode provider and the OpenCode CLI) and the Claude Code plugin folder that T3's Claude provider loads.

## Inputs

- `layers.json` is the ordered layer manifest. Each layer has a `name`, a `kind` (`plugin` or `config`), a checkout `path` under the workspace, and a `source` URL. A layer with a `pluginTarget` is copied into `.opencode/plugins`.
- A layer may carry a `claude` block. `{ "plugin": "<name>" }` makes a local Claude plugin: the layer's `.claude-plugin/plugin.json` must exist, its `name` must match, and its `files` list must include `.claude-plugin`. The installer links `.claude/plugins/<name>` to the installed copy. `{ "plugin": "<name>", "git": { "url", "path", "commit", "tag" } }` makes a pinned Claude plugin: the installer copies the `path` folder of the repository at exactly `commit` into `.claude/plugins/<name>`.
- `pstack-opencode.lock.json` pins the plugin repository and the exact commit to install.
- `pstack-claude.lock.json` pins the pstack Claude plugin: the repository, the `path`, the `tag` it belongs to, the commit, and the upstream commit the OpenCode port pins.
- `models.json` is the model policy. The installer writes `roles.primary` into the workspace config and the matching role into each agent profile.
- `workspace/opencode.jsonc` is the config base. Layer fragments supply the MCP servers and extra permissions.

## Assembly

`scripts/Install-Workspace.ps1` runs in audit mode by default and changes nothing. With `-Apply` it:

1. Checks that each layer checkout exists and that the plugin layer has an `index.ts`. It checks each `claude` block against the layer's manifest, and for a `git` block it fetches the pinned commit into `.claude/cache` and checks it out. A pin the repository cannot supply stops the run here, before anything is written.
2. Warns when the plugin checkout HEAD differs from the pinned commit.
3. Merges every config layer's `opencode.fragment.jsonc` into `D:\dev\simpsonm09\opencode.jsonc` and sets the primary model.
4. Copies each plugin layer's `layer.json` `files` list, or the default item list, into `.opencode/plugins/<pluginTarget>`, then runs `npm install` there. A layer without a `claude` block gets no `.claude-plugin` directory, and any left from an earlier apply is removed. A folder under `.opencode/plugins` that no current `pluginTarget` names is stale: it is removed only if the previous `stack.lock.json` recorded it as a layer's `pluginTarget`, and otherwise it is reported and kept.
5. Copies the plugin layer's `agents/*.md` into `.opencode/agents` and injects the model line from `models.json`.
6. Builds `.claude/plugins/`. A local layer becomes a junction to its installed copy, so both harnesses share it. A `git` layer becomes a copy of the pinned folder. Each child is checked for the manifest name it must carry. A child that no longer has a claude block is removed: a junction is removed as a link, and its target is never touched.
7. Writes `stack.lock.json` at the workspace root.

Audit mode computes the config and each child, and reports each as `missing`, `differs`, `matches`, or `stale`. A child differs when it is missing, is not the expected link or copy, has a tree hash other than the one the last apply recorded, or its git pin has moved. Audit writes nothing and makes no network call.

## The recorded lock

`stack.lock.json` is the install-provenance record. `Install-Workspace.ps1` writes it at the workspace root, not in this repository. It records `generatedAt`, `primaryModel`, the SHA-256 of the written workspace config, and one entry per layer with its `name`, `kind`, `path`, `pluginTarget` (null for a layer with no plugin copy), `source`, and installed `commit`. The `pluginTarget` is what the next apply uses to recognise a stale `.opencode/plugins` folder. A lock written before this field existed records no targets, so no stale folder is removed until the next apply writes them. Each layer also has a `claude` record:

- a local plugin: `enabled`, `plugin`, `kind: "junction"`, `child` (`.claude/plugins/<name>`), `target` (`.opencode/plugins/<pluginTarget>`), and `treeSha256`;
- a git plugin: `enabled`, `plugin`, `kind: "git"`, `child`, `repository`, `path`, `commit`, and `treeSha256`;
- a layer with no Claude plugin: `enabled: false`.

`treeSha256` is a hash over each file's relative path and SHA-256, leaving out a top-level `node_modules`. The lock holds only workspace-relative paths, so it holds no absolute path. The junction's target is an absolute path inside the filesystem, but the installer creates it on each apply and the lock does not record it.

## Generated files and git

The generated files live at the workspace root, which is not a git repository, so no repository in this set tracks them. The root `.gitignore` covers the installer output, and `.opencode/plugins/` already holds the local plugin copies. The Claude folder needs two more entries there, `.claude/plugins/` and `.claude/cache/`. See [T3 setup](t3-setup.md#generated-files-and-git).

## Validation

`.github/workflows/ci.yml` runs `scripts/verify-manifests.py` in the `validate` job. The script checks that `layers.json`, `pstack-opencode.lock.json`, `pstack-claude.lock.json`, `models.json`, and `workspace/opencode.jsonc` agree with each other and with the installer, without cloning the private plugin repository. The plugin repository validates its own generated `skills/` tree in its `verify-pin.yml` workflow.

The Claude pin is checked offline. The `pstack-claude.lock.json` repository, path, tag, and commit must match the `git` block in `layers.json`, and its `commit` must equal its `opencodeUpstream`, which is the upstream commit the OpenCode port pins. `python scripts/verify-manifests.py --online` also runs `git ls-remote` to confirm the tag still resolves to that commit, and `gh api` to read the port's `pstack.lock.json` at the commit `pstack-opencode.lock.json` names. Run it from a machine with `gh` signed in. CI does not run `--online`.

`python scripts/verify-workspace-install.py` checks an installed workspace: each recorded child exists, is the expected link or copy, carries the manifest name the lock records, and matches its `treeSha256`. It also reports any child the lock does not record, and any leftover marketplace or settings file from an earlier design.

## Publishing a new bundle

1. Merge the plugin change in `pstack-opencode-plugin` and note the merge commit.
2. Update the `commit` in `pstack-opencode.lock.json`, and the `path` or `source` if the layer moved.
3. When the pstack release moves, update the `git` block in `layers.json` and `pstack-claude.lock.json` (`tag`, `commit`, `opencodeUpstream`), then run `python scripts/verify-manifests.py --online`.
4. Run `pwsh -File scripts/Install-Workspace.ps1 -Apply`.
5. Start a new T3 session. The OpenCode provider starts a fresh `opencode serve` for it, and Claude Code reads `.claude/plugins` when it starts. Then run `pwsh -File scripts/verify-opencode-workspace.ps1` and `python scripts/verify-workspace-install.py`.

Merge the manifest changes in the org and personal repositories before a `claude` block that names their plugin lands here. Until a layer's `.claude-plugin/plugin.json` is on the checkout the installer reads, both audit and `-Apply` stop with a clear error. The `claude` checks run before any file is written, so a failure leaves the workspace unchanged, including for the OpenCode layers.
