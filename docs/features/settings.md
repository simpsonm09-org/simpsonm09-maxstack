# Workspace settings

## Workspace discovery

The target workspace follows this precedence, and the first step that applies decides it:

1. `-Workspace <path>`
2. `MAXSTACK_WORKSPACE`
3. The nearest folder from the current directory upward that holds a `maxstack.settings.json` or `stack.lock.json` file
4. The script's own location, when it runs from `<workspace>\projects\repos\<repo>\scripts` or `<workspace>\projects\worktrees\<repo>\scripts`

The installer prints `Workspace: <absolute path> (from <origin>)` as its first line after a successful resolution. The origin is one of `-Workspace`, `MAXSTACK_WORKSPACE`, `cwd marker maxstack.settings.json`, `cwd marker stack.lock.json`, or `script layout`. If none applies, discovery stops and lists the four ways to name a workspace.

- An explicit or environment value that is empty, or that names no existing folder, is an error. It does not fall through to a later step, and it names its origin.
- Discovery never creates a folder. `-Status`, `-Update -Check`, and an apply all stop at a missing target.
- A relative explicit or environment value resolves from the current directory. A trailing separator is ignored.
- A marker counts only when it is a file. A folder with a marker's name is skipped, and the walk goes on to the folder above. Within one folder, `maxstack.settings.json` is checked before `stack.lock.json`.
- A junction or symbolic link keeps the path you gave as the workspace, so the lock and the output name the link, as upstream main does. The folder it names is checked the same way as a plain folder: a folder inside `.git` or a cache, a checkout, or a drive root is refused. A marker that is a symbolic link or a junction is not a marker: the walk ignores it. A hard link is an ordinary file and does mark its folder.
- A folder inside `.git`, inside `.claude\cache`, or inside `projects\repos` or `projects\worktrees` is never a workspace. An explicit or environment target there is refused. The walk and the script layout skip it.
- These paths are refused by their text, before any filesystem lookup: a path with a control character (C0, DEL, or the C1 range), a format character (a zero width space, joiner, or non-joiner, a soft hyphen, a byte order mark, or a bidi control), a bidi override or isolate, a line or paragraph separator, or an unpaired surrogate; a device prefix; a UNC path; and, for a value you supplied, an 8.3 short name such as `PROGRA~1`. Give the long local path instead. Messages show every control, format, and separator character as `\uXXXX`, so raw bytes never reach the terminal, and cut a value longer than 260 characters with `...`.

For example, set the environment for repeated commands:

```powershell
$env:MAXSTACK_WORKSPACE = '.'
pwsh -File scripts/Install-Workspace.ps1 -Status
```

## Settings file

`maxstack.settings.json` is an optional, hand-edited file beside `stack.lock.json`. Start from [`workspace/maxstack.settings.json`](../../workspace/maxstack.settings.json), and use [`schemas/maxstack.settings.schema.json`](../../schemas/maxstack.settings.schema.json) for editor completion.

```json
{
  "version": 1,
  "runtimes": {
    "claude": {},
    "opencode": {}
  },
  "layers": {
    "pstack": {},
    "simpsonm09-org-ai-plugin": {}
  },
  "t3": {
    "defaults": "leave-alone",
    "gatedInstances": ["<instance-id>"],
    "readOnlyInstances": ["<instance-id>"]
  }
}
```

The settings file is an input. The installer does not own it and never removes it. The lock stores its canonical SHA-256 in `settings`; it does not add the file to `owned`.

Every key and every string value in the file is checked for a control, a format character, a line or paragraph separator, or an unpaired surrogate before any other rule. Such a character is refused and shown as an escape. A runtime or layer name, a keyword such as `default`, `windows`, `install`, `apply-defaults`, or `leave-alone`, and a settings key must match its canonical spelling exactly, character for character. A zero width space in `default` is therefore a different word, and it is refused, not read as `default`.

`runtimes` and `layers` are additive: names in the file join the recorded lock selection and command-line flags. A runtime is a harness. An omitted name in a declared dimension remains selected and is reported as `unlisted`; an omitted dimension keeps the recorded selection without an unlisted report. Use `-Remove -Runtimes <name>` or `-Remove -Layers <name>` to remove a selection. A name in the file that is not yet recorded is `pending` and is selected on `-Apply`. An apply reports it as selected by that apply. `-Update` selects nothing from the file, so it reports the name as not selected by `-Update`, and `-Update -Apply` keeps the settings hash the last apply recorded.

On a new workspace, a named settings dimension selects exactly its listed names. A dimension omitted from the file keeps the current behavior: the default names on a new workspace, or the names in the lock. The default runtimes are `claude`, `opencode`, `copilot`, and `pi`. `codex` is opt-in, so it is selected only when the file lists it under `runtimes`, or a command line names it or `all`. `-Update` stays with the recorded selection. A new selection in the file is reported as pending and needs `-Apply`.

`runtimes.<name>.cli` and `t3.cli` accept `detect` or `install`. They are recorded and validated, but CLI installation is not supported in this release.

`t3.gatedInstances` and `t3.readOnlyInstances` are optional arrays of unique, non-empty ids. Each id may contain only ASCII letters, digits, hyphens, and underscores. An id cannot appear in both lists. Read-only instances provide cheap helpers for reviews, research, and explanation on harnesses without our layers or gate. pstack refuses them for roles whose helpers can write files, commit, push, or open pull requests. The lists are per-machine configuration and have no defaults. On apply, either non-empty list writes `.pstack/pstack-t3-instances.json`. When both lists are empty or omitted, apply removes a previously generated, unchanged file.

`layers.<name>.source` takes the `-Source` grammar: `owner/repo@ref`, an `https://` URL with `@ref`, `local:<path>`, or `default`. A source may not hold a control character, a format character, a line or paragraph separator, an unpaired surrogate, or a non-breaking space. A relative `local:` path resolves from the workspace folder only. It may not climb with `..`, be drive-relative or root-relative (a leading slash is root-relative, so `local:/x` is refused), resolve through a junction or symbolic link to a folder outside the workspace, or name the workspace, a maxstack checkout, or a folder the installer writes (`.claude`, `.opencode`, `.pi`, `.maxstack`). An absolute `local:` path is a drive-letter path such as `local:C:\x`. It follows the `-Source` rules and prints a machine-path warning.

The text of a local path is refused before any folder is read: a UNC path (`\\server\share`, or `//server/share`), a device path (`\\?\` or `\\.\`, in any form), and a folder name that ends in a dot or a space. Windows drops a trailing dot or space when it normalises a path, so the folder used would not be the one the path names. An 8.3 short name (`SIMPSO~1`) is refused the way `-Workspace` refuses one. A maxstack checkout is refused whether the path is absolute or relative.

A layer's source comes from the first of these that applies: a `-Source` or `-LayerSource` flag, the `source` declared here, the override the lock recorded, and the `layers.json` default. An omitted `source` keeps the recorded override. `default` drops it, and the layer returns to its `layers.json` source. Only an apply uses the declaration. An audit, `-Status`, and `-Update -Check` report a declaration and use the recorded source, and they contact no remote for it. `-Update -Apply` is an apply, so it uses the declaration.

A declaration that cannot be used is unavailable. That covers a missing or unreadable folder, a link that leaves the workspace, a protected folder, an 8.3 short name, and a path refused by the rules above that needs the folder (a missing folder is found only by looking). A git ref is read only by an apply, so a read-only run cannot find a ref that cannot be read: the audit, `-Status`, and `-Update -Check` name the declaration and use the recorded source, and an apply that cannot read the ref refuses before any write. A read-only run (an audit, `-Status`, `-Update -Check`, or a dry `-Remove`) prints `Settings: layers.<name>.source <reason> This run skips layer <name> and has no fallback.` and skips the layer. A real apply stops before any write and names the repair command. The files of a skipped layer are reported as `skipped` by `-Status`, not as `drifted`, and a skipped layer does not fail `-Status -Strict`, since the skip line already reports it.

`-InitSettings` prints a seed file made from the lock's selection and recorded source overrides, and `-InitSettings -Apply` creates `maxstack.settings.json` only when it is absent. It reads the lock alone, runs no git, resolves no source, and checks each recorded local path by its text only: no folder is looked at and no link is followed. It refuses an existing file, folder, or link, and it needs a lock with `ownedSchema` 1 or 2. On a first workspace without a lock, copy `workspace/maxstack.settings.json` into the workspace or run `-Apply` first. A lock key that differs from a known key only by case, such as `OwnedSchema`, is refused by every mode that reads the lock.

`os` accepts `auto`, `windows`, `macos`, or `linux`. A mismatch is allowed during audit and dry run. Apply refuses a mismatch before source resolution or writes. `t3.snapshot` accepts a boolean. `t3.defaults` accepts `leave-alone` or `apply-defaults`. The snapshot and T3 defaults actions are not implemented yet. `apply-defaults` is reported as unsupported, and T3 settings are left alone. T3 settings remain user-owned.

The installer accepts strict UTF-8 JSON, including a UTF-8 BOM, with a 64 KiB and 32-level nesting limit, and reads ISO-looking strings as strings, which needs PowerShell 7.5 or later. `scripts/verify_settings.py` applies the same rules, and a test compares the two readers on each case. Comments, trailing commas, duplicate keys, unknown keys, invalid types, and unsupported values fail validation before a write or git command. A directory or a symbolic link at the settings path is refused without reading its target. A file another process holds open is reported as unreadable, not as a .NET error. `-Status` reports a settings error on its own line and still reports the lock. An absent file prints nothing, unless the lock recorded its hash; then it prints `Settings: missing since the last apply.`

The removal modes read the file as follows. A real `-Remove` reads it only to warn about each removed runtime or layer that it still lists, since the next apply selects that name again, and a file it cannot read does not stop the removal. A dry `-Remove` reads it the same tolerant way and reports an unavailable declared source with the skip line above, with no fallback. `-Uninstall`, dry or real, never reads this file: it removes what the lock recorded, so an unreadable or invalid file never stops it, and a dry run says so with `Settings: -Uninstall does not read maxstack.settings.json; it removes what the lock recorded.`

See [Install and reload](../install.md#runtime-and-layer-selection) for the commands and selection overview.
