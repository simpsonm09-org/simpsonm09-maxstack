# Claude Code model list in OpenChamber

OpenChamber's Claude Code provider is the `@openchamber/opencode-claude` OpenCode
plugin, pinned in `~/.config/opencode/opencode.json`. OpenCode asks that plugin
for its model list. This note records why the list can be shorter than the Claude
Code CLI and how to repair it.

## Why the lists differ

The plugin discovers the list from the Claude CLI and caches it at
`~/.local/share/opencode-claude/models.json`. It reads that cache when the server
starts. When discovery fails it serves a built-in fallback list that goes stale as
Anthropic ships new models.

On Windows, discovery fails. The plugin spawns the `claude.cmd` npm shim with a
JSON `--settings` argument. Node refuses to pass cmd.exe metacharacters to a
`.cmd` file, so the probe throws before it returns a list. The plugin writes this
line to `~/.local/share/opencode-claude/debug.log`:

```
could not read the model list from Claude Code The argument 'args[10]' contains a cmd.exe special character and cannot be safely passed to a .bat/.cmd file. Received "{\"disableClaudeAiConnectors\":true}"
```

The Claude Code CLI is unaffected because it runs the native `claude.exe`, which
has no such restriction.

## Repair

Seed the cache from the plugin's own discovery, run against the native
`claude.exe` so the `.cmd` path is never used.

```powershell
node scripts/Seed-ClaudeCodeModels.mjs
```

Then restart OpenChamber. A running server resolves the plugin once per process,
so the new list appears only after a restart. Re-run the script after a Claude
Code or plugin update.

## Current list

Discovery on 2026-10-07 returned 15 entries: 12 models plus 3 explicit 1M variants
for the families the CLI exposes both ways. The set is account and provider
dependent, because the CLI resolves it from a signed model catalog.

| Name | Model id | Context | Output |
| --- | --- | --- | --- |
| Opus 5.5 | `claude-opus-5-5[1m]` | 1M | 128k |
| Sonnet 5.5 | `claude-sonnet-5-5` | 200k | 64k |
| Sonnet 5.5 (1M) | `claude-sonnet-5-5[1m]` | 1M | 128k |
| Fable 5.1 | `claude-fable-5-1[1m]` | 1M | 128k |
| Haiku 5.5 | `claude-haiku-5-5` | 200k | 64k |
| Haiku 4.5 | `claude-haiku-4-5-20251001` | 200k | 64k |
| Sonnet 5 | `claude-sonnet-5` | 200k | 64k |
| Sonnet 5 (1M) | `claude-sonnet-5[1m]` | 1M | 128k |
| Opus 5 | `claude-opus-5[1m]` | 1M | 128k |
| Fable 5 | `claude-fable-5[1m]` | 1M | 128k |
| Opus 4.8 | `claude-opus-4-8` | 1M | 128k |
| Opus 4.7 | `claude-opus-4-7` | 1M | 128k |
| Opus 4.6 | `claude-opus-4-6[1m]` | 1M | 128k |
| Sonnet 4.6 | `claude-sonnet-4-6` | 200k | 64k |
| Sonnet 4.6 (1M) | `claude-sonnet-4-6[1m]` | 1M | 128k |

## Notes

- The cache is machine app state under `~/.local/share/opencode-claude/`. It is
  not repository content and is never committed.
- `scripts/Seed-ClaudeCodeModels.mjs` is the reproducible lever. It locates the
  plugin and the native binary, runs the plugin's own discovery, and writes the
  cache. It is safe to re-run.
- This is a Windows-only workaround for a bug in
  `@openchamber/opencode-claude@1.3.8`, the latest version at the time of
  writing. The real fix belongs upstream, in the plugin's CLI invocation.
