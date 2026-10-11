# Workspace settings

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
