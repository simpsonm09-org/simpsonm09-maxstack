# Install and reload

## Model

maxstack sets no model. The workspace `opencode.jsonc` has no `model` or `small_model` key, and the installed agent profiles have no `model:` line, so each agent runs the model the session uses. You pick that model in the harness: the T3 Code model picker for a thread or project, or your own OpenCode, Claude Code, or Copilot settings. The PStack Claude plugin's per-role models are set with its own `/setup-pstack` command.

## Hosts

T3 Code hosts the agent sessions. It runs four providers against the same workspace:

- The OpenCode provider can reuse an already-running `opencode serve` across sessions. OpenCode reads the workspace `opencode.jsonc` and `.opencode` directory from the session directory upward.
- The Claude provider runs Claude Code with `--plugin-dir` pointing at `<workspace>\.claude\plugins`. See [T3 setup](t3-setup.md).
- The Copilot provider runs `<workspace>\.maxstack\bin\copilot.cmd`, which starts the Copilot CLI with the same plugin folders. See [T3 setup](t3-setup.md#copilot).
- The Pi provider runs `<workspace>\.maxstack\bin\pi.cmd`, which starts Pi with the agent folder `<workspace>\.pi\agent`. See [T3 setup](t3-setup.md#pi-maxstack).

Ubuntu WSL can also run the OpenCode CLI. It reads the same workspace files under `D:\dev\simpsonm09`, which WSL sees at `/mnt/d/dev/simpsonm09`.

## Install and reload

PStack is not checked out in the workspace. The installer fetches the `plugins/pstack` folder of the fork at the commit in `pstack.lock.json`, into `.claude\cache\pstack`, and checks that commit out. A cache already at the commit is reused without a network call. The org and personal layers are read from their checkouts under `projects\repos`.

```powershell
pwsh -File scripts/Install-Workspace.ps1 -Apply
```

After an install, restart the running OpenCode server, then start a new session in T3. T3 can reuse a long-lived server across sessions, and that server does not reliably reload plugins or skills after reinstall. Claude Code reads its `.claude\plugins` folder when a session starts. Copilot reads its plugin folders when it starts.

Check the installed workspace:

```powershell
pwsh -File scripts/verify-opencode-workspace.ps1
python scripts/verify-workspace-install.py
```

`verify-opencode-workspace.ps1` runs `opencode debug config` and `opencode debug agents` from the workspace. It checks that OpenCode reads the workspace config and `.opencode` directory, and that the three PStack agents resolve with no model. It starts no server and makes no model call. Each OpenCode call has a 60-second limit; a call that runs past it fails the check and names the command. Plugin loading needs a model call, so `scripts/verify-workspace-skill.ps1 -Model <provider/model>` runs a bounded OpenCode session that loads a skill. It has a 180-second limit, and it needs a model because the workspace names none. `scripts/verify-workspace-skill.sh` takes the model as its second argument and the limit as its third.

`verify-workspace-install.py` checks each runtime the lock records: the Claude folders, the OpenCode folders and their entries, the agent profiles, the `plugin` entries in `opencode.jsonc`, and the Copilot wrappers against their recorded hashes.

## Claude Code

The same install also builds `.claude/plugins` at the workspace root: one child folder per Claude plugin. The org and personal folders are junctions to the installed OpenCode copies, and pstack is a copy of its pinned folder in the fork. Claude Code reads the folder when a session starts, so a new session is enough. A T3 Claude provider instance passes `--plugin-dir <workspace>\.claude\plugins`. See [T3 setup](t3-setup.md).

## Copilot CLI

`Install-Workspace.ps1` writes two wrappers into `.maxstack\bin`: `copilot.cmd` for Windows and `copilot.sh` for POSIX shells. Each runs the Copilot CLI with one `--plugin-dir` for each layer that lists the `copilot` runtime, in layer order, then passes its arguments through. The plugin folders are the `.claude\plugins` folders above; no second copy is made.

The installer finds the Copilot executable with `Get-Command copilot`. It never uses a match inside `.maxstack\bin`. The `.cmd` names that executable by its absolute path, so a later move of Copilot needs an apply. If Copilot is not installed, the installer skips both wrappers with a message and still installs everything else. Install Copilot, then run the installer with `-Apply` again.

To test the wrapper without an install, pass a different executable: `-CopilotCommand <path>`.

## Pi

`Install-Workspace.ps1` writes `.maxstack\bin\pi.cmd` and `pi.sh`, and `.pi\agent\settings.json`. The wrappers set `PI_CODING_AGENT_DIR` to `.pi\agent`. `pi.cmd` runs the `pi` the installer found on `PATH`, so rerun the installer after moving Pi. `pi.sh` runs whichever `pi` is on `PATH` at run time. `MAXSTACK_PI_BIN` names another Pi for both. The wrappers bake absolute paths: the agent folder into both, and the Pi CLI into `pi.cmd`. After the workspace or Pi moves, rerun `Install-Workspace.ps1` to regenerate them. The settings hold a `packages` list and a `skills` list. The installer owns only those two keys and the entries it wrote last time: a `defaultProvider` or `defaultModel` the user sets stays, and the installer writes no model or provider. A layer is a Pi package only when its `package.json` has a `pi` key. See [T3 setup](t3-setup.md#pi-maxstack).

## Audit and apply

Audit mode is the default. It prints one `Drift:` line for each thing the installer would change, and writes nothing:

```powershell
pwsh -File scripts/Install-Workspace.ps1
```

`-Apply` makes the changes. Each runtime is written in this order: the config, the OpenCode folders and agent profiles, the Claude folders, then the Copilot wrappers. A git source is fetched before anything is written, so a commit the fork cannot supply stops the run with the workspace unchanged.

A layer that stops naming a runtime leaves its folder behind. `-Apply` removes an OpenCode folder that no layer names only when the previous `stack.lock.json` recorded it, so the installer made it. It also removes the folder of the retired `pstack-opencode` port on every apply. Any other unnamed folder is reported as stale and kept. The same cleanup applies to `.claude\plugins`: `-Apply` removes a child that no layer declares, and audit reports it as stale.

## Ownership and status

`-Apply` writes an ownership record into `stack.lock.json`: the `owned` list, with `ownedSchema: 1`. It names each path the apply wrote, sorted by path, kind, and key:

- `opencode.jsonc`, `.maxstack\bin\copilot.*`, `.maxstack\bin\pi.*`, and each agent profile in `.opencode\agents`: a `file` with its SHA-256.
- `.claude\plugins\<layer>`: a `link` with its `target` for a local layer, or a `dir` for a pinned copy.
- `.claude\cache\<layer>`: a `dir` for each pinned layer.
- `.opencode\plugins\<layer>`: a `dir`.
- `.pi\agent\settings.json`: one `json-entries` record for `packages` and one for `skills`. Each holds only the entries the installer added. The keys and entries the user wrote are not recorded.

A `dir` hash covers each file's relative path and SHA-256. It leaves out `node_modules`, `package-lock.json`, and `.git` at any depth, because npm and git write those beside the installed files. The record holds no absolute path and does not list the lock itself. Re-applying with nothing to change leaves the lock the same except `generatedAt`.

```json
"owned": [
  { "path": ".maxstack/bin/copilot.cmd", "kind": "file", "sha256": "…" },
  { "path": ".pi/agent/settings.json", "kind": "json-entries", "key": "packages", "entries": ["../../.claude/cache/pstack"] }
]
```

`-Status` compares the record with the disk and with what an apply would write. It writes nothing. It prints one line per path, then a summary:

```powershell
pwsh -File scripts/Install-Workspace.ps1 -Status
pwsh -File scripts/Install-Workspace.ps1 -Status -Strict
```

| State | Meaning |
| --- | --- |
| `matching` | It matches the record, and an apply would leave it as it is. |
| `drifted` | It matches the record, but an apply would write something else, such as a layer whose source changed. |
| `modified` | It differs from the recorded hash, target, or entry, usually because of a hand edit. |
| `missing` | The record names it and the disk does not hold it. A Pi entry shows alone when it is missing from its list. |
| `untracked` | A file in `.maxstack\bin` that no record names. |

`-Strict` exits 1 when any path is not `matching`. A workspace whose lock has no `owned` list prints `no ownership record; run -Apply once to create it`, and exits 0, or 1 with `-Strict`.

Limits of the record:

- For a pinned layer, status reads only the local cache. When the cache is not at the pinned commit, each path that layer owns reports as `drifted` until an apply syncs it.
- The `.bak` copies of the config and Pi settings are not recorded.
- A folder's hash covers every file in it, so a file the user adds to an owned folder shows as `modified` until the next apply records it.
- Apply does not remove the agent profiles of a layer that stopped installing them, nor the cache of a removed pinned layer, as before. Those files drop out of the record at the next apply.

## A legacy global install

The workspace bundle is the only PStack install. If an older global install is ever found, remove it by hand, on Windows under `%USERPROFILE%` and on WSL under `$HOME`. `scripts/verify-workspace-install.py` reports what remains. It checks these paths:

- `.agents/skills` holds no PStack skill (`poteto-mode` or a `principle-*` folder). Other tools, such as the Cursor CLI, install their own skills there, and those are left alone.
- `.config/opencode/AGENTS.md` is absent.
- `.config/opencode/agents/pstack-*.md` are absent.

An old `.config/opencode/opencode.jsonc` may still hold the `model` and `default_agent` lines from that install. Delete the ones it wrote. A model you chose yourself stays.
