#!/usr/bin/env node
// Prove Install-Workspace.ps1 keeps an absolute path out of stack.lock.json, and
// builds the Claude plugin folder: junctions for the local layers and a pinned,
// sparse copy of the pstack plugin from a git repository. Runs the real script
// against a throwaway workspace, with a local git fixture standing in for GitHub,
// so it needs no network and no plugin.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installer = join(repoRoot, 'scripts', 'Install-Workspace.ps1');
const LAYERS = [
  'projects/repos/pstack-opencode-plugin',
  'projects/repos/simpsonm09-org-ai-plugin',
  'projects/repos/simpsonm09-personal-ai-plugin',
];
// The two local layers declare a claude block, so each needs a manifest whose
// name matches. pstack declares a git pin and needs no local manifest.
const LOCAL_CLAUDE_PLUGINS = {
  'projects/repos/simpsonm09-org-ai-plugin': 'simpsonm09-org-ai-plugin',
  'projects/repos/simpsonm09-personal-ai-plugin': 'simpsonm09-personal-ai-plugin',
};

let layersCounter = 0;

function findShell() {
  for (const name of ['pwsh', 'powershell']) {
    if (spawnSync(name, ['-NoProfile', '-Command', 'exit 0']).status === 0) return name;
  }
  return null;
}

function writeLayerFile(root, rel, content) {
  const full = join(root, ...rel.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function stringValues(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const item of node) stringValues(item, out);
  else if (node && typeof node === 'object') for (const item of Object.values(node)) stringValues(item, out);
  return out;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// PowerShell colours and wraps its error view, with a "Line |" gutter, so matching
// a message needs the escape codes, the gutter bars, and the line breaks removed.
function plainOutput(run) {
  return `${run.stdout}\n${run.stderr}`
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte is the ANSI colour code being removed
    .replace(/\x1B\[[0-9;]*m/g, '')
    .replace(/\s*\|\s*/g, ' ')
    .replace(/\s+/g, ' ');
}

// A layer stub: an index.ts, a node_modules tree so the installer skips npm, a
// fragment, and a layer.json. A layer that declares a local Claude plugin lists
// .claude-plugin in its files; withManifest decides whether the manifest exists.
function writeLayerStub(root, { claudePlugin = null, manifestName = claudePlugin, withManifest = true, extra = {} } = {}) {
  const files = ['index.ts', 'node_modules', ...Object.keys(extra)];
  if (claudePlugin) files.push('.claude-plugin');
  writeLayerFile(root, 'index.ts', 'export default {};\n');
  writeLayerFile(root, 'layer.json', JSON.stringify({ files }));
  writeLayerFile(root, 'node_modules/@opencode/plugin/index.js', 'module.exports = {};\n');
  writeLayerFile(root, 'opencode.fragment.jsonc', '{}');
  for (const [rel, content] of Object.entries(extra)) writeLayerFile(root, rel, content);
  if (claudePlugin && withManifest) {
    writeLayerFile(root, '.claude-plugin/plugin.json', JSON.stringify({ name: manifestName, version: '0.1.0' }));
  }
}

// A git repository standing in for michael-denyer/pstack-claude: a plugins/pstack
// folder with a manifest and a skill, and a file outside it that the sparse clone
// must not bring in.
function makeFixture(base) {
  const dir = join(base, 'pstack-src');
  writeLayerFile(dir, 'plugins/pstack/.claude-plugin/plugin.json', JSON.stringify({ name: 'pstack', version: '0.9.73' }));
  writeLayerFile(dir, 'plugins/pstack/skills/poteto-mode/SKILL.md', '---\nname: poteto-mode\ndescription: fixture\n---\nfixture body\n');
  writeLayerFile(dir, 'other/notes.txt', 'outside the plugin folder\n');
  const git = (args) => {
    const run = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(run.status, 0, `git ${args.join(' ')} failed: ${run.stderr}`);
    return run.stdout.trim();
  };
  git(['init', '-q']);
  git(['config', 'uploadpack.allowFilter', 'true']);
  git(['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'pin']);
  return { dir, commit: git(['rev-parse', 'HEAD']), url: `file:///${dir.replaceAll('\\', '/')}` };
}

function buildWorkspace({ withManifests = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'maxstack-lock-'));
  const workspace = join(base, 'simpsonm09');
  for (const layerPath of LAYERS) {
    writeLayerStub(join(workspace, layerPath), {
      claudePlugin: LOCAL_CLAUDE_PLUGINS[layerPath] ?? null,
      withManifest: withManifests,
    });
  }
  return { base, workspace, fixture: makeFixture(base) };
}

// The repository layers.json with the pstack git pin pointed at the fixture, and
// an optional change applied to the manifest before it is written.
function writeLayers(ctx, mutate = null) {
  const manifest = readJson(join(repoRoot, 'layers.json'));
  const pstack = manifest.layers.find((layer) => layer.name === 'pstack-opencode-plugin');
  pstack.claude.git = { url: ctx.fixture.url, path: 'plugins/pstack', tag: 'v0.9.73', commit: ctx.fixture.commit };
  if (mutate) mutate(manifest);
  layersCounter += 1;
  const path = join(ctx.base, `layers-${layersCounter}.json`);
  writeFileSync(path, JSON.stringify(manifest));
  return path;
}

function runInstaller(shell, ctx, extra = [], { apply = true, layersFile = writeLayers(ctx) } = {}) {
  const args = [
    '-NoProfile', '-NonInteractive', '-File', installer,
    '-Workspace', ctx.workspace,
    ...(layersFile ? ['-LayersFile', layersFile] : []),
    ...(apply ? ['-Apply'] : []),
    ...extra,
  ];
  return spawnSync(shell, args, { encoding: 'utf8' });
}

// A junction reports as a symbolic link to lstat.
function isLink(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat ? stat.isSymbolicLink() : false;
}

const shell = findShell();
const skip = shell ? false : 'pwsh is not available';

function withWorkspace(name, body, options) {
  test(name, { skip }, () => {
    const ctx = buildWorkspace(options);
    try {
      body(ctx);
    } finally {
      rmSync(ctx.base, { recursive: true, force: true });
    }
  });
}

withWorkspace('the lock records a workspace name and no absolute path', (ctx) => {
  const run = runInstaller(shell, ctx);
  assert.equal(run.status, 0, `installer exited ${run.status}\n${run.stdout}\n${run.stderr}`);

  const raw = readFileSync(join(ctx.workspace, 'stack.lock.json'), 'utf8');
  const lock = JSON.parse(raw);

  assert.equal(lock.workspace, 'simpsonm09', 'the lock names the workspace');
  assert.doesNotMatch(lock.workspace, /[\\/]/, 'the workspace name holds no separator');
  assert.ok(!raw.includes(ctx.workspace), 'the lock holds no absolute workspace path');
  for (const value of stringValues(lock)) {
    assert.doesNotMatch(value, /^[A-Za-z]:[\\/]/, `drive-letter path: ${value}`);
    assert.doesNotMatch(value, /^\//, `absolute path: ${value}`);
  }

  assert.equal(typeof lock.generatedAt, 'string');
  assert.equal(typeof lock.primaryModel, 'string');
  assert.match(lock.configSha256, /^[0-9a-fA-F]{64}$/);
  assert.equal(lock.layers.length, LAYERS.length);
  for (const record of lock.layers) {
    for (const key of ['name', 'kind', 'path', 'source']) {
      assert.equal(typeof record[key], 'string', `layer field ${key} is a string`);
    }
    assert.equal(typeof record.claude?.enabled, 'boolean', `layer ${record.name} has a claude record`);
  }
  assert.ok(!('claudeMarketplaceSha256' in lock), 'the marketplace hash is gone');
  assert.ok(!('claudeSettingsSha256' in lock), 'the settings hash is gone');
}, {});

withWorkspace('local layers are junctions and pstack is a pinned sparse copy', (ctx) => {
  const run = runInstaller(shell, ctx);
  assert.equal(run.status, 0, `installer exited ${run.status}\n${run.stdout}\n${run.stderr}`);

  const plugins = join(ctx.workspace, '.claude', 'plugins');
  for (const [plugin, target] of [
    ['simpsonm09-org-ai-plugin', '.opencode/plugins/simpsonm09-org-ai-plugin'],
    ['simpsonm09-personal-ai-plugin', '.opencode/plugins/simpsonm09-personal-ai-plugin'],
  ]) {
    const child = join(plugins, plugin);
    assert.ok(isLink(child), `${plugin} is a link`);
    assert.equal(realpathSync(child).toLowerCase(), realpathSync(join(ctx.workspace, ...target.split('/'))).toLowerCase());
    assert.ok(existsSync(join(child, '.claude-plugin', 'plugin.json')), `${plugin} exposes its manifest`);
  }

  const pstackChild = join(plugins, 'pstack');
  assert.ok(!isLink(pstackChild), 'pstack is a real folder, not a link');
  assert.ok(existsSync(join(pstackChild, '.claude-plugin', 'plugin.json')));
  assert.ok(existsSync(join(pstackChild, 'skills', 'poteto-mode', 'SKILL.md')));
  assert.ok(!existsSync(join(pstackChild, 'other')), 'the sparse copy leaves out files outside plugins/pstack');
  assert.ok(existsSync(join(ctx.workspace, '.claude', 'cache', 'pstack-src', '.git')), 'the git cache is under .claude/cache');

  assert.ok(!existsSync(join(ctx.workspace, '.claude-plugin', 'marketplace.json')), 'no marketplace is generated');
  assert.ok(!existsSync(join(ctx.workspace, '.claude', 'workspace-settings.json')), 'no settings file is generated');

  const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  const byName = Object.fromEntries(lock.layers.map((record) => [record.name, record]));
  assert.equal(byName['simpsonm09-org-ai-plugin'].claude.kind, 'junction');
  assert.equal(byName['simpsonm09-org-ai-plugin'].claude.plugin, 'simpsonm09-org-ai-plugin');
  assert.equal(byName['simpsonm09-org-ai-plugin'].claude.child, '.claude/plugins/simpsonm09-org-ai-plugin');
  assert.equal(byName['simpsonm09-org-ai-plugin'].claude.target, '.opencode/plugins/simpsonm09-org-ai-plugin');
  assert.match(byName['simpsonm09-org-ai-plugin'].claude.treeSha256, /^[0-9A-F]{64}$/);
  assert.equal(byName['pstack-opencode-plugin'].claude.kind, 'git');
  assert.equal(byName['pstack-opencode-plugin'].claude.commit, ctx.fixture.commit, 'the pstack record is the pinned commit');
  assert.equal(byName['pstack-opencode-plugin'].claude.repository, ctx.fixture.url);
  assert.equal(byName['pstack-opencode-plugin'].claude.path, 'plugins/pstack');
}, {});

withWorkspace('a git pin the repository cannot supply stops the run before anything is written', (ctx) => {
  const layers = writeLayers(ctx, (manifest) => {
    manifest.layers[0].claude.git.commit = 'f'.repeat(40);
  });
  const run = runInstaller(shell, ctx, [], { layersFile: layers });
  assert.notEqual(run.status, 0, 'the installer accepted an unreachable pin');
  assert.match(plainOutput(run), /Could not fetch the pinned commit f{40}/);
  assert.ok(!existsSync(join(ctx.workspace, 'opencode.jsonc')), 'the config was written before the pin check');
  assert.ok(!existsSync(join(ctx.workspace, '.claude', 'plugins', 'pstack')), 'a pstack folder was written');
}, {});

withWorkspace('an offline re-apply reuses the cached commit', (ctx) => {
  assert.equal(runInstaller(shell, ctx).status, 0);
  const moved = `${ctx.fixture.dir}-moved`;
  renameSync(ctx.fixture.dir, moved);
  try {
    const run = runInstaller(shell, ctx);
    assert.equal(run.status, 0, `offline re-apply failed\n${run.stdout}\n${run.stderr}`);
    const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
    const pstack = lock.layers.find((record) => record.name === 'pstack-opencode-plugin');
    assert.equal(pstack.claude.commit, ctx.fixture.commit);
  } finally {
    renameSync(moved, ctx.fixture.dir);
  }
}, {});

withWorkspace('a second apply is idempotent: the same links and tree hashes', (ctx) => {
  assert.equal(runInstaller(shell, ctx).status, 0);
  const first = readJson(join(ctx.workspace, 'stack.lock.json'));
  assert.equal(runInstaller(shell, ctx).status, 0);
  const second = readJson(join(ctx.workspace, 'stack.lock.json'));
  const trees = (lock) => lock.layers.map((record) => [record.name, record.claude.treeSha256 ?? null]);
  assert.deepEqual(trees(second), trees(first));
  assert.ok(isLink(join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-org-ai-plugin')));

  const audit = runInstaller(shell, ctx, [], { apply: false });
  assert.equal(audit.status, 0, audit.stderr);
  const drift = audit.stdout.split(/\r?\n/).filter((line) => line.startsWith('Drift:'));
  assert.equal(drift.length, 4, audit.stdout);
  for (const line of drift) assert.match(line, /: matches$/, line);
}, {});

withWorkspace('audit reports Claude drift and writes nothing', (ctx) => {
  const before = runInstaller(shell, ctx, [], { apply: false });
  assert.equal(before.status, 0, before.stderr);
  for (const child of ['simpsonm09-org-ai-plugin', 'simpsonm09-personal-ai-plugin', 'pstack']) {
    assert.match(before.stdout, new RegExp(`plugins\\\\${child}: missing`), `missing drift for ${child}`);
  }
  assert.ok(!existsSync(join(ctx.workspace, '.claude', 'plugins')), 'audit created the plugin folder');

  assert.equal(runInstaller(shell, ctx).status, 0);
  const skill = join(ctx.workspace, '.claude', 'plugins', 'pstack', 'skills', 'poteto-mode', 'SKILL.md');
  appendFileSync(skill, 'hand edit\n');

  const drifted = runInstaller(shell, ctx, [], { apply: false });
  assert.match(drifted.stdout, /plugins\\pstack: differs/);
  assert.match(readFileSync(skill, 'utf8'), /hand edit/, 'audit changed the drifted file');

  assert.equal(runInstaller(shell, ctx).status, 0);
  assert.doesNotMatch(readFileSync(skill, 'utf8'), /hand edit/, 'apply restored the copied folder');
}, {});

withWorkspace('a claude block without a manifest fails with a clear error', (ctx) => {
  const run = runInstaller(shell, ctx);
  assert.notEqual(run.status, 0, 'the installer accepted a claude block with no manifest');
  assert.match(plainOutput(run), /claude block but no \.claude-plugin/);
}, { withManifests: false });

withWorkspace('a claude plugin name that differs from the manifest fails', (ctx) => {
  writeLayerFile(join(ctx.workspace, 'projects/repos/simpsonm09-org-ai-plugin'), '.claude-plugin/plugin.json', JSON.stringify({ name: 'renamed' }));
  const run = runInstaller(shell, ctx);
  assert.notEqual(run.status, 0);
  assert.match(plainOutput(run), /claude\.plugin is 'simpsonm09-org-ai-plugin' but its \.claude-plugin\\plugin\.json names 'renamed'/);
}, {});

withWorkspace('removing a claude block removes only its link and keeps the installed copy', (ctx) => {
  assert.equal(runInstaller(shell, ctx).status, 0);
  const child = join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-org-ai-plugin');
  const target = join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-org-ai-plugin');
  assert.ok(isLink(child));
  // Not an item in the layer's files list, so no apply copies over it.
  writeFileSync(join(target, 'keep-me.txt'), 'the installed copy must survive\n');

  const layers = writeLayers(ctx, (manifest) => {
    for (const layer of manifest.layers) {
      if (layer.name === 'simpsonm09-org-ai-plugin') delete layer.claude;
    }
  });
  const run = runInstaller(shell, ctx, [], { layersFile: layers });
  assert.equal(run.status, 0, `installer exited ${run.status}\n${run.stdout}\n${run.stderr}`);

  assert.equal(lstatSync(child, { throwIfNoEntry: false }), undefined, 'the link is gone');
  assert.ok(existsSync(join(target, 'keep-me.txt')), 'the target lost a file');
  assert.ok(existsSync(join(target, 'index.ts')), 'the target lost its entrypoint');
  assert.ok(isLink(join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-personal-ai-plugin')), 'the personal link was disturbed');

  const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  assert.equal(lock.layers.find((record) => record.name === 'simpsonm09-org-ai-plugin').claude.enabled, false);
}, {});

withWorkspace('LayerSource overrides a layer checkout', (ctx) => {
  const alternate = join(ctx.base, 'alternate-org');
  writeLayerStub(alternate, { claudePlugin: 'simpsonm09-org-ai-plugin', extra: { 'from-override.txt': 'override\n' } });
  const run = runInstaller(shell, ctx, ['-LayerSource', `simpsonm09-org-ai-plugin=${alternate}`]);
  assert.equal(run.status, 0, `installer exited ${run.status}\n${run.stdout}\n${run.stderr}`);
  assert.ok(existsSync(join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-org-ai-plugin', 'from-override.txt')));
}, {});

withWorkspace('the installer has no OpenChamber live-server check and no skip switch', (ctx) => {
  // T3 starts OpenCode per session, so there is no long-lived server to check.
  assert.doesNotMatch(readFileSync(installer, 'utf8'), /openchamber|SkipLiveServerCheck/i);
  const run = runInstaller(shell, ctx, ['-SkipLiveServerCheck'], { apply: false });
  assert.notEqual(run.status, 0, 'the installer accepted the removed -SkipLiveServerCheck switch');
  assert.match(plainOutput(run), /SkipLiveServerCheck/);
}, {});

withWorkspace('audit with the real layers.json needs no network and writes no Claude files', (ctx) => {
  // The real manifest points pstack at GitHub; audit must not fetch it.
  const args = [
    '-LayerSource',
    `pstack-opencode-plugin=${join(ctx.workspace, 'projects/repos/pstack-opencode-plugin')},` +
      `simpsonm09-org-ai-plugin=${join(ctx.workspace, 'projects/repos/simpsonm09-org-ai-plugin')},` +
      `simpsonm09-personal-ai-plugin=${join(ctx.workspace, 'projects/repos/simpsonm09-personal-ai-plugin')}`,
  ];
  const run = runInstaller(shell, ctx, args, { apply: false, layersFile: null });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /plugins\\pstack: missing/);
  assert.ok(!existsSync(join(ctx.workspace, '.claude', 'cache')), 'audit touched the git cache');
  assert.ok(!existsSync(join(ctx.workspace, '.claude')), 'audit wrote under .claude');
}, {});
