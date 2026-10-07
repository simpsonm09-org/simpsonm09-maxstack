#!/usr/bin/env node
// Seed the OpenChamber Claude Code model cache from the plugin's own discovery.
//
// The Claude Code provider is the `@openchamber/opencode-claude` OpenCode plugin
// (pinned in `~/.config/opencode/opencode.json`). It discovers its model list
// from the Claude CLI and caches it at
// `~/.local/share/opencode-claude/models.json`, which it reads at module load.
// When discovery fails it serves a stale fallback list, so OpenChamber shows
// fewer models than the Claude Code CLI.
//
// On Windows the probe spawns the `claude.cmd` npm shim, and Node refuses to
// pass the probe's JSON `--settings` argument to a .cmd file. The probe throws
// and the fallback list is served. Running the same probe against the native
// `claude.exe` avoids the .cmd path, so this script does that and writes the
// resulting list to the cache.
//
//   node scripts/Seed-ClaudeCodeModels.mjs
//
// The cache is machine app state, not repository content. Restart OpenChamber
// after running it: a running server resolves the plugin once per process.

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

function findPluginDist(home) {
  const root = join(home, '.cache', 'opencode', 'npm', '@openchamber');
  if (!existsSync(root)) throw new Error(`plugin cache not found: ${root}`);
  const versions = readdirSync(root).filter((name) => name.startsWith('opencode-claude@'));
  for (const version of versions) {
    const versionDir = join(root, version);
    for (const hash of readdirSync(versionDir)) {
      const dist = join(versionDir, hash, 'node_modules', '@openchamber', 'opencode-claude', 'dist');
      if (existsSync(join(dist, 'query.js'))) return dist;
    }
  }
  throw new Error(`opencode-claude dist not found under ${root}`);
}

// Candidate directories that hold a native `claude` binary. Prepending one to
// PATH makes the plugin's own resolver pick the executable over the .cmd shim.
function nativeClaudeDirs(home) {
  return [
    join(home, 'AppData', 'Roaming', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin'),
    join(home, '.local', 'bin'),
  ];
}

function findNativeClaudeDir(home) {
  for (const dir of nativeClaudeDirs(home)) {
    if (existsSync(join(dir, 'claude.exe')) || existsSync(join(dir, 'claude'))) return dir;
  }
  return null;
}

function cachePath(home) {
  const base = process.env.XDG_DATA_HOME || join(home, '.local', 'share');
  return join(base, 'opencode-claude', 'models.json');
}

export async function seedClaudeCodeModels(home = homedir()) {
  const pluginDist = findPluginDist(home);
  const nativeDir = findNativeClaudeDir(home);
  if (nativeDir) process.env.PATH = `${nativeDir};${process.env.PATH ?? ''}`;

  const { listClaudeSupportedModels } = await import(pathToFileURL(join(pluginDist, 'query.js')).href);
  const { modelsFromSdk } = await import(pathToFileURL(join(pluginDist, 'models.js')).href);

  const rows = await listClaudeSupportedModels(45000);
  if (!rows?.length) throw new Error('the Claude CLI returned no models');

  const models = modelsFromSdk(rows);
  const out = cachePath(home);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(models, null, 2)}\n`);
  return { path: out, models };
}

async function main() {
  const { path, models } = await seedClaudeCodeModels();
  process.stdout.write(`wrote ${models.length} models to ${path}\n`);
  for (const model of models) process.stdout.write(`  ${model.name}  (${model.id})\n`);
  process.stdout.write('restart OpenChamber for the running server to read the cache\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`seed: ${error instanceof Error ? error.message : error}\n`);
    process.exit(1);
  });
}
