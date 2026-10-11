# Workspace settings

## Workspace discovery

The target workspace follows this precedence, and the first step that applies decides it:

1. `-Workspace <path>`
2. `MAXSTACK_WORKSPACE`
3. The nearest folder from the current directory upward that holds a `maxstack.settings.json` or `stack.lock.json` file
4. The script's own location, when it runs from `<workspace>\projects\repos\<repo>\scripts` or `<workspace>\projects\worktrees\<repo>\scripts`
5. The previous fixed default, when that folder exists

The installer prints `Workspace: <absolute path> (from <origin>)` as its first line after a successful resolution. The origin is one of `-Workspace`, `MAXSTACK_WORKSPACE`, `cwd marker maxstack.settings.json`, `cwd marker stack.lock.json`, `script layout`, or `legacy default`. Use it to confirm the target. The legacy fallback also prints a warning, and it will be removed after one release.

- An explicit or environment value that is empty, or that names no existing folder, is an error. It does not fall through to a later step, and it names its origin.
- Discovery never creates a folder. `-Status`, `-Update -Check`, and an apply all stop at a missing target.
- A relative explicit or environment value resolves from the current directory. A trailing separator is ignored.
- A marker counts only when it is a file. A folder with a marker's name is skipped, and the walk goes on to the folder above. Within one folder, `maxstack.settings.json` is checked before `stack.lock.json`.
- A junction or symbolic link keeps the path you gave as the workspace, so the lock and the output name the link, as upstream main does. The folder it names is checked the same way as a plain folder: a folder inside `.git` or a cache, a checkout, or a drive root is refused. A marker that is a symbolic link or a junction is not a marker: the walk ignores it. A hard link is an ordinary file and does mark its folder.
- A folder inside `.git`, inside `.claude\cache`, or inside `projects\repos` or `projects\worktrees` is never a workspace. An explicit or environment target there is refused. The walk and the script layout skip it.
- These paths are refused by their text, before any filesystem lookup: a path with a control character (C0, DEL, or the C1 range), a bidi override or isolate, a line or paragraph separator, or an unpaired surrogate; a device prefix; a UNC path; and, for a value you supplied, an 8.3 short name such as `PROGRA~1`. Give the long local path instead. Messages show every control, format, and separator character as `\uXXXX`, so raw bytes never reach the terminal, and cut a value longer than 260 characters with `...`. A zero width joiner in a folder name is accepted.

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
    "defaults": "leave-alone"
  }
}
```

The settings file is an input. The installer does not own it and never removes it. The lock stores its canonical SHA-256 in `settings`; it does not add the file to `owned`.

`runtimes` and `layers` are additive: names in the file join the recorded lock selection and command-line flags. A runtime is a harness. An omitted name in a declared dimension remains selected and is reported as `unlisted`; an omitted dimension keeps the recorded selection without an unlisted report. Use `-Remove -Runtimes <name>` or `-Remove -Layers <name>` to remove a selection. A name in the file that is not yet recorded is `pending` and is selected on `-Apply`. An apply reports it as selected by that apply. `-Update` selects nothing from the file, so it reports the name as not selected by `-Update`, and `-Update -Apply` keeps the settings hash the last apply recorded.

On a new workspace, a named settings dimension selects exactly its listed names. A dimension omitted from the file keeps the current behavior: all names on a new workspace, or the names in the lock. `-Update` stays with the recorded selection. A new selection in the file is reported as pending and needs `-Apply`.

`runtimes.<name>.cli` and `t3.cli` accept `detect` or `install`. They are recorded and validated, but CLI installation is not supported in this release. Layer `source` is validated and reserved for the source-selection slice; it has no effect yet, and each one prints `layers.<name>.source is recorded but not applied in this release.` A source may not hold a control character, DEL, a C1 control, NBSP, or a bidi control.

`os` accepts `auto`, `windows`, `macos`, or `linux`. A mismatch is allowed during audit and dry run. Apply refuses a mismatch before source resolution or writes. `t3.snapshot` accepts a boolean. `t3.defaults` accepts `leave-alone` or `apply-defaults`. The snapshot and T3 defaults actions are not implemented yet. `apply-defaults` is reported as unsupported, and T3 settings are left alone. T3 settings remain user-owned.

The installer accepts strict UTF-8 JSON, including a UTF-8 BOM, with a 64 KiB and 32-level nesting limit, and reads ISO-looking strings as strings, which needs PowerShell 7.5 or later. `scripts/verify_settings.py` applies the same rules, and a test compares the two readers on each case. Comments, trailing commas, duplicate keys, unknown keys, invalid types, and unsupported values fail validation before a write or git command. A directory or a symbolic link at the settings path is refused without reading its target. A file another process holds open is reported as unreadable, not as a .NET error. `-Status` reports a settings error on its own line and still reports the lock. An absent file prints nothing, unless the lock recorded its hash; then it prints `Settings: missing since the last apply.`

`-Remove` reads the file only to warn about each removed runtime or layer that it still lists, since the next apply selects that name again. A file it cannot read does not stop the removal. `-Uninstall` does not read this file.

See [Install and reload](../install.md#runtime-and-layer-selection) for the commands and selection overview.
