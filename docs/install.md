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

## Runtime and layer selection

The workspace installs only the runtimes and layers it selects. `-Runtimes` names runtimes: `claude`, `opencode`, `copilot`, `pi`, or `all`. `-Layers` names layers by their names in `layers.json`, or `all`. Both take comma-separated values, which `pwsh -File` passes as one token:

```powershell
pwsh -File scripts/Install-Workspace.ps1 -Runtimes claude,copilot -Apply
pwsh -File scripts/Install-Workspace.ps1 -Runtimes pi -Apply
pwsh -File scripts/Install-Workspace.ps1 -Layers pstack -Apply
```

The selection is recorded in `stack.lock.json`, with each list sorted:

```json
"selection": {
  "runtimes": ["claude", "copilot"],
  "layers": ["pstack", "simpsonm09-org-ai-plugin", "simpsonm09-personal-ai-plugin"]
}
```

The rules:

- A plain `-Apply`, with no flags, reuses the recorded selection. It does not select a layer or runtime that `layers.json` gained after the selection was recorded.
- A flag adds its names to the recorded selection, and never removes one. Naming a runtime or layer that is already selected prints `Already selected ...` and changes nothing. Removing one is the future `remove` command.
- `all` expands to every runtime or layer that `layers.json` names at the time of the run. The lock then records the expanded names, not the word `all`, so a layer added later is not selected until a flag names it.
- An unnamed dimension keeps its recorded value. A new workspace with no flags selects every runtime and every layer, so a plain `-Apply` installs what it did before. A new workspace with `-Runtimes` selects exactly the runtimes named, and every layer unless `-Layers` names some.
- A layer or runtime that `layers.json` names but the selection leaves out is reported on every apply, audit, and status, with the flag that adds it, for example `-Layers <name>`. `-Status` also lists it as `not selected`. It is not installed until a flag names it.
- A recorded name that `layers.json` no longer names, such as a layer removed from it, is dropped from the selection with a warning. The next apply removes the folders that layer installed, the same way it removes a layer that stopped installing a runtime.
- A lock with no `selection` predates the field. It reads as all, and the next apply writes the field.
- `copilot` and `pi` need `claude`. Their wrapper or settings name the Claude plugin folders, so selecting either without `claude`, by name or in the recorded selection, is an error.
- An unknown name on the command line is an error that lists the valid names, and nothing is written.
- A layer installs only the selected runtimes it declares in `layers.json`. A selected layer that declares none of them is reported and installs nothing.

What each runtime writes:

- `claude`: `.claude\plugins`. A local layer is a junction to its OpenCode copy when `opencode` is selected too. Without `opencode` there is no copy to link to, so the layer's items are copied into the Claude folder instead.
- `opencode`: `opencode.jsonc`, `.opencode\plugins`, and the agent profiles.
- `copilot`: `.maxstack\bin\copilot.cmd` and `copilot.sh`.
- `pi`: `.maxstack\bin\pi.cmd` and `pi.sh`, and `.pi\agent\settings.json`.

The pinned pstack cache under `.claude\cache` is the source every runtime copies from, so each layer that installs anything writes it, whichever runtime it serves. The lock records each runtime a layer does not install as `enabled: false`. For `copilot` and `pi` the reason is `not selected`.

The lock is replaced whole. The installer writes the new text to `stack.lock.json.new` beside it and then replaces the lock, so an interrupted run cannot leave a partial lock. The lock it replaced is kept as `stack.lock.json.bak`.

An empty, `null`, or truncated `stack.lock.json` stops every command before anything is written. The message says how to recover. Restore the lock from `stack.lock.json.bak` if that file reads, or repair it by hand. Deleting the lock is the last resort, and it has a cost: the selection resets to all runtimes and layers, and the `createdDirs` and `createdFiles` record is lost, so a later uninstall could not tell what the installer created. Keep `stack.lock.json.bak` either way.

An unselected runtime's files are left alone. An apply does not write, remove, or report them as drift. `-Status` names any that exist as `not selected`, and `-Strict` does not count them. `-Status` takes no selection flags, because it reports the recorded selection, which it prints first.

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

The same install also builds `.claude/plugins` at the workspace root: one child folder per Claude plugin. The org and personal folders are junctions to the installed OpenCode copies, and pstack is a copy of its pinned folder in the fork. Without the `opencode` runtime there is no OpenCode copy, so a local folder is a copy of its items instead. Claude Code reads the folder when a session starts, so a new session is enough. A T3 Claude provider instance passes `--plugin-dir <workspace>\.claude\plugins`. See [T3 setup](t3-setup.md).

## Copilot CLI

`Install-Workspace.ps1` writes two wrappers into `.maxstack\bin`: `copilot.cmd` for Windows and `copilot.sh` for POSIX shells. Each runs the Copilot CLI with one `--plugin-dir` for each layer that lists the `copilot` runtime, in layer order, then passes its arguments through. The plugin folders are the `.claude\plugins` folders above; no second copy is made.

The installer finds the Copilot executable with `Get-Command copilot`. It never uses a match inside `.maxstack\bin`. The `.cmd` names that executable by its absolute path, so a later move of Copilot needs an apply. If Copilot is not installed, the installer skips both wrappers with a message and still installs everything else. Install Copilot, then run the installer with `-Apply` again. The wrappers run the Claude plugin folders, so `copilot` needs `claude` selected.

To test the wrapper without an install, pass a different executable: `-CopilotCommand <path>`.

## Pi

`Install-Workspace.ps1` writes `.maxstack\bin\pi.cmd` and `pi.sh`, and `.pi\agent\settings.json`. The wrappers set `PI_CODING_AGENT_DIR` to `.pi\agent`. `pi.cmd` runs the `pi` the installer found on `PATH`, so rerun the installer after moving Pi. `pi.sh` runs whichever `pi` is on `PATH` at run time. `MAXSTACK_PI_BIN` names another Pi for both. The wrappers bake absolute paths: the agent folder into both, and the Pi CLI into `pi.cmd`. After the workspace or Pi moves, rerun `Install-Workspace.ps1` to regenerate them. The settings hold a `packages` list and a `skills` list. The installer owns only those two keys and the entries it wrote last time: a `defaultProvider` or `defaultModel` the user sets stays, and the installer writes no model or provider. A layer is a Pi package only when its `package.json` has a `pi` key. Pi lists the Claude plugin folders, so `pi` needs `claude` selected. See [T3 setup](t3-setup.md#pi-maxstack).

## Audit and apply

Audit mode is the default. It prints one `Drift:` line for each thing the installer would change, and writes nothing:

```powershell
pwsh -File scripts/Install-Workspace.ps1
```

`-Apply` makes the changes. Each runtime is written in this order: the config, the OpenCode folders and agent profiles, the Claude folders, then the Copilot wrappers. A git source is fetched before anything is written, so a commit the fork cannot supply stops the run with the workspace unchanged.

A layer that stops naming a runtime leaves its folder behind. `-Apply` removes an OpenCode folder that no layer names only when the previous `stack.lock.json` recorded it, so the installer made it. It also removes the folder of the retired `pstack-opencode` port on every apply. Any other unnamed folder is reported as stale and kept. The same cleanup applies to `.claude\plugins`: `-Apply` removes a child that no layer declares, and audit reports it as stale.

## Ownership and status

`-Apply` writes an ownership record into `stack.lock.json`: the `owned` list, with `ownedSchema: 2`. It names each path the apply wrote, sorted by path, kind, and key. Each record also names the `runtime` it belongs to, or `null` for the claude cache, and the `layers` it was installed for, sorted, so a later removal can pick the records it deletes:

- `opencode.jsonc`, `.maxstack\bin\copilot.*`, `.maxstack\bin\pi.*`, and each agent profile in `.opencode\agents`: a `file` with its SHA-256.
- `.claude\plugins\<layer>`: a `link` with its `target` for a local layer with `opencode` selected, or a `dir` for a pinned copy or a local copy of its items.
- `.claude\cache\<layer>`: a `dir` for each pinned layer.
- `.opencode\plugins\<layer>`: a `dir`.
- `.pi\agent\settings.json`: one `json-entries` record for `packages` and one for `skills`. Each holds only the entries the installer added, and none when it added none. An entry the user already listed is the user's, so it is not recorded, and a second copy the user wrote beside an installer entry stays the user's.
- `opencode.jsonc.bak` and `.pi\agent\settings.json.bak`: a `file` record each, once an apply has written the backup. An apply takes a backup when the file exists, differs from the new text, and holds something other than the installer's last write. So the file the install first replaced is kept, and a hand edit of an installer file is kept too. A later apply that replaces only the installer's own text keeps the backup as it is.

A `json-entries` record for a key the installer created in a settings file that already existed carries `createdKey: true`. The top-level `createdDirs` lists each directory an apply created, and `createdFiles` each file it created: `opencode.jsonc` and `.pi\agent\settings.json` when the apply created them, and not when they already existed. Both are sorted, and both lists name only what was not there before the first apply. The `pi` section records `settingsSha256`, the SHA-256 the last apply wrote to the Pi settings, so a backup can be put back only while the file still holds it.

A `dir` record is the hash of what the installer wrote. An owned folder is wholly the installer's: each apply removes whatever the layer does not install, printing each removal, and replaces each item with a fresh copy. The hash covers each file's relative path and SHA-256, and each link by its target, and it leaves out `node_modules` and `.git` at any depth. The record holds no absolute path and does not list the lock itself. Re-applying with nothing to change leaves the lock the same except `generatedAt`.

```json
"ownedSchema": 2,
"owned": [
  { "path": ".maxstack/bin/copilot.cmd", "kind": "file", "sha256": "…", "runtime": "copilot", "layers": [] },
  { "path": ".claude/cache/pstack", "kind": "dir", "sha256": "…", "runtime": null, "layers": ["pstack"] },
  { "path": ".pi/agent/settings.json", "kind": "json-entries", "key": "packages", "entries": ["../../.claude/cache/pstack"], "runtime": "pi", "layers": ["pstack"] }
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
| `not selected` | A file of a runtime the selection leaves out, or a layer or runtime that `layers.json` names and the selection leaves out, shown with the flag that adds it. Apply leaves files alone, and `-Strict` does not count these. |

`-Status` prints the selection first, then judges only the selected runtimes. The summary counts `not selected` paths after the other states.

`-Strict` exits 1 when any path is not `matching` or `not selected`. A workspace whose lock has no `owned` list prints `no ownership record; run -Apply once to create it`, and exits 0, or 1 with `-Strict`.

Limits of the record:

- Owned folders must not hold user files. `.opencode\plugins\<layer>`, `.claude\plugins\<layer>`, and `.claude\cache\<layer>` belong to the installer: an apply removes any file a user adds to them, and status reports such a file as `modified` until then. Keep your own files elsewhere.
- For a pinned layer, status reads only the local cache. Each path or entry that depends on a pinned commit the cache is not at reports as `drifted`, once, until an apply syncs the cache. An apply also removes untracked files from the cache.
- A backup the next apply would write is not reported until it exists.
- Apply does not remove the agent profiles of a layer that stopped installing them, nor the cache of a removed pinned layer. Those files drop out of the record at the next apply.
- A lock from before the record has no `owned` list, so status reports no record until one apply. That apply takes the entries its `pi` section lists as the installer's, and the claude `treeSha256` values keep the legacy rule, so they do not report `differs` after the upgrade.
- A lock at `ownedSchema: 1` names no runtime or layer for its records, so one `-Apply` writes version 2 before a later removal can use them.

## A legacy global install

The workspace bundle is the only PStack install. If an older global install is ever found, remove it by hand, on Windows under `%USERPROFILE%` and on WSL under `$HOME`. `scripts/verify-workspace-install.py` reports what remains. It checks these paths:

- `.agents/skills` holds no PStack skill (`poteto-mode` or a `principle-*` folder). Other tools, such as the Cursor CLI, install their own skills there, and those are left alone.
- `.config/opencode/AGENTS.md` is absent.
- `.config/opencode/agents/pstack-*.md` are absent.

An old `.config/opencode/opencode.jsonc` may still hold the `model` and `default_agent` lines from that install. Delete the ones it wrote. A model you chose yourself stays.
