# Antigravity skills

The opt-in `antigravity` runtime installs selected layer skills in the workspace at `.agents/skills/<skill>/`. The Antigravity app, CLI, and IDE document this path for workspace skills. See [Google's Agent skills reference](https://antigravity.google/docs/skills?tab=ide).

## Select Antigravity

Pass `antigravity` to `-Runtimes`:

```powershell
pwsh -File scripts/Install-Workspace.ps1 -Workspace <workspace> -Runtimes antigravity -Apply
```

You can also add `antigravity` to the `runtimes` map in `maxstack.settings.json`. The default runtime selection does not include it. `-Runtimes all` does.

Antigravity uses the same layer skill sources and workspace folders as Codex. When both runtimes are selected, maxstack copies each skill once and records both consumers. Removing one runtime keeps a skill claimed by the other. Removing the last consumer removes only an unchanged folder that maxstack owns. If someone edits an owned skill, maxstack keeps its recorded hash and reports the edit.

## Scope

This runtime installs skills, and, when a selected layer ships the Antigravity gate hook, an owned `.agents\hooks.json` whose command runs the adapter by absolute path. It does not install Antigravity rules, plugins, model settings, or global files. The live probe 2026-10-21 ran three T3 Antigravity sessions on Windows 11. They loaded user-global skills from `~/.gemini/config/skills`, but no workspace skills, workspace instructions, or gate. The probe write reached GitHub (HTTP 404).

Neither workspace `.agents/hooks.json` nor T3's per-provider config folder `hooks.json` loaded the hook. The workspace was trusted, the session cwd was the workspace, and `run_command` arguments matched the adapter. Fed by hand, the installed adapter denied correctly. Keep Antigravity in `t3.readOnlyInstances` as a read-only helper. A standalone Antigravity app or CLI session in the workspace is untested.
