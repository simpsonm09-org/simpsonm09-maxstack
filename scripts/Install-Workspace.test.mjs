#!/usr/bin/env node
// Prove Install-Workspace.ps1 installs each layer's runtimes from one layers.json: the
// Claude plugin folders, the OpenCode entry and agents, and the Copilot wrappers. The
// pstack source is a local git fixture standing in for GitHub, and Copilot is a stand-in
// command, so the tests need no network and no Copilot install.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installer = join(repoRoot, 'scripts', 'Install-Workspace.ps1');
// The two local layers. Each declares every runtime, and each needs a manifest whose name
// matches its layer name. pstack is pinned to a git source and needs no local checkout.
const LOCAL_LAYERS = ['projects/repos/simpsonm09-org-ai-plugin', 'projects/repos/simpsonm09-personal-ai-plugin'];
const MISSING_COPILOT = 'maxstack-test-no-such-copilot';

let layersCounter = 0;

function findShell() {
  for (const name of ['pwsh', 'powershell']) {
    if (spawnSync(name, ['-NoProfile', '-Command', 'exit 0']).status === 0) return name;
  }
  return null;
}

// On Windows a bash on PATH can be the WSL launcher, so use the one Git for Windows ships.
function findBash() {
  if (process.platform !== 'win32') return 'bash';
  const gitBash = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'bash.exe');
  return existsSync(gitBash) ? gitBash : null;
}

function writeFile(root, rel, content) {
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

// A local layer stub: an index.ts, a node_modules tree so the installer skips npm, a
// fragment, and a layer.json. A claude runtime needs .claude-plugin in its files list.
function writeLayerStub(root, { claudePlugin = null, manifestName = claudePlugin, withManifest = true, extra = {} } = {}) {
  const files = ['index.ts', 'node_modules', ...Object.keys(extra)];
  if (claudePlugin) files.push('.claude-plugin');
  writeFile(root, 'index.ts', 'export default {};\n');
  writeFile(root, 'layer.json', JSON.stringify({ files }));
  writeFile(root, 'node_modules/@opencode/plugin/index.js', 'module.exports = {};\n');
  writeFile(root, 'opencode.fragment.jsonc', '{}');
  for (const [rel, content] of Object.entries(extra)) writeFile(root, rel, content);
  if (claudePlugin && withManifest) {
    writeFile(root, '.claude-plugin/plugin.json', JSON.stringify({ name: manifestName, version: '0.1.0' }));
  }
}

// A git repository standing in for simpsonm09/pstack-claude at the fork's layout: the
// plugin folder carries a Claude manifest, the OpenCode entry and its agent profiles, and
// the shared skills tree the entry reads. A file outside the folder must not come along.
function makeFixture(base) {
  const dir = join(base, 'pstack-src');
  const plugin = 'plugins/pstack';
  writeFile(dir, `${plugin}/.claude-plugin/plugin.json`, JSON.stringify({ name: 'pstack', version: '0.9.79' }));
  for (const skillId of ['poteto-mode', 'setup-pstack', 'principle-laziness-protocol']) {
    writeFile(dir, `${plugin}/skills/${skillId}/SKILL.md`, `---\nname: ${skillId}\ndescription: fixture\n---\nfixture body\n`);
  }
  writeFile(dir, `${plugin}/opencode/index.ts`, 'export default {};\n');
  writeFile(dir, `${plugin}/opencode/package.json`, JSON.stringify({ name: 'pstack-opencode', private: true }));
  writeFile(dir, `${plugin}/opencode/node_modules/@opencode/plugin/index.js`, 'module.exports = {};\n');
  writeFile(dir, `${plugin}/opencode/agents/pstack-agent.md`, '---\ndescription: worker\nmodel: opencode-go/deepseek-v4.1-flash\n---\nbody\nmodel: a body line\n');
  writeFile(dir, `${plugin}/opencode/agents/pstack-reviewer.md`, '---\ndescription: reviewer\n---\nreview\n');
  writeFile(dir, `${plugin}/opencode/agents/pstack-comment-sicko.md`, '---\ndescription: comments\n---\ncomments\n');
  writeFile(dir, 'other/notes.txt', 'outside the plugin folder\n');
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

// A stand-in for the Copilot CLI: it echoes the account-independent switch and its arguments.
function writeFakeCopilot(base) {
  const path = join(base, 'fake-copilot.cmd');
  writeFileSync(path, '@echo off\r\necho ASK=%AGENT_ACCESS_COPILOT_ASK%\r\necho ARGS=%*\r\n');
  return path;
}

function buildWorkspace({ withManifests = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'maxstack-lock-'));
  const workspace = join(base, 'simpsonm09');
  for (const layerPath of LOCAL_LAYERS) {
    const name = layerPath.split('/').pop();
    writeLayerStub(join(workspace, layerPath), { claudePlugin: name, withManifest: withManifests });
  }
  return { base, workspace, fixture: makeFixture(base), fakeCopilot: writeFakeCopilot(base) };
}

// The repository layers.json with the pstack source pointed at the fixture, and an
// optional change applied to the manifest before it is written.
function writeLayers(ctx, mutate = null) {
  const manifest = readJson(join(repoRoot, 'layers.json'));
  const pstack = manifest.layers.find((layer) => layer.name === 'pstack');
  pstack.source = { url: ctx.fixture.url, path: 'plugins/pstack', commit: ctx.fixture.commit, ref: 'test' };
  if (mutate) mutate(manifest);
  layersCounter += 1;
  const path = join(ctx.base, `layers-${layersCounter}.json`);
  writeFileSync(path, JSON.stringify(manifest));
  return path;
}

function layerNamed(manifest, name) {
  return manifest.layers.find((layer) => layer.name === name);
}

// Runs the installer. Copilot is the stand-in unless the caller names -CopilotCommand.
function runInstaller(shell, ctx, extra = [], { apply = true, layersFile = writeLayers(ctx) } = {}) {
  const copilot = extra.includes('-CopilotCommand') ? [] : ['-CopilotCommand', ctx.fakeCopilot];
  const args = [
    '-NoProfile', '-NonInteractive', '-File', installer,
    '-Workspace', ctx.workspace,
    ...(layersFile ? ['-LayersFile', layersFile] : []),
    ...copilot,
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

function driftLines(run) {
  return run.stdout.split(/\r?\n/).filter((line) => line.startsWith('Drift:'));
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

function mustApply(ctx, extra = [], options = {}) {
  const run = runInstaller(shell, ctx, extra, options);
  assert.equal(run.status, 0, `installer exited ${run.status}\n${run.stdout}\n${run.stderr}`);
  return run;
}

withWorkspace('the lock records each layer once, with its runtimes and no absolute path', (ctx) => {
  mustApply(ctx);
  const raw = readFileSync(join(ctx.workspace, 'stack.lock.json'), 'utf8');
  const lock = JSON.parse(raw);

  assert.equal(lock.workspace, 'simpsonm09', 'the lock names the workspace');
  assert.ok(!raw.includes(ctx.workspace), 'the lock holds no absolute workspace path');
  assert.ok(!raw.includes(ctx.base), 'the lock holds no temporary path');
  for (const value of stringValues(lock)) {
    assert.doesNotMatch(value, /^[A-Za-z]:[\\/]/, `drive-letter path: ${value}`);
    assert.doesNotMatch(value, /^\//, `absolute path: ${value}`);
  }

  assert.equal(typeof lock.generatedAt, 'string');
  assert.ok(!('primaryModel' in lock), 'the lock records no model');
  assert.match(lock.configSha256, /^[0-9a-fA-F]{64}$/);
  assert.equal(lock.layers.length, 3, 'one record per layer in layers.json');
  assert.deepEqual(lock.layers.map((record) => record.name), ['pstack', 'simpsonm09-org-ai-plugin', 'simpsonm09-personal-ai-plugin']);
  for (const record of lock.layers) {
    assert.equal(typeof record.name, 'string');
    assert.equal(typeof record.kind, 'string');
    assert.equal(typeof record.source, 'string', `layer ${record.name} records its source`);
    for (const runtime of ['claude', 'opencode', 'copilot']) {
      assert.equal(typeof record[runtime]?.enabled, 'boolean', `layer ${record.name} has a ${runtime} record`);
    }
  }
  assert.equal(lock.copilot.enabled, true, 'the Copilot wrappers are recorded as written');
  assert.deepEqual(lock.copilot.wrappers, ['.maxstack/bin/copilot.cmd', '.maxstack/bin/copilot.sh']);
  assert.match(lock.copilot.cmdSha256, /^[0-9A-F]{64}$/);
  assert.ok(!('claudeMarketplaceSha256' in lock), 'the marketplace hash is gone');
  assert.ok(!('claudeSettingsSha256' in lock), 'the settings hash is gone');
}, {});

withWorkspace('apply writes no model, and removes one from the config and the installed profiles', (ctx) => {
  // The pstack agent profile carries a model line, and the workspace holds an older
  // profile and config that name one. Apply must leave no model in either and keep the
  // rest of each file.
  writeFile(ctx.workspace, 'opencode.jsonc', '{\n  "model": "opencode-go/deepseek-v4.1-flash",\n  "small_model": "opencode-go/deepseek-v4.1-flash"\n}\n');
  writeFile(ctx.workspace, '.opencode/agents/pstack-agent.md', '---\nmodel: opencode-go/deepseek-v4.1-flash\n---\nold\n');

  const run = mustApply(ctx);
  assert.doesNotMatch(run.stdout, /Primary model|with model/, 'the installer reports a model');

  const config = readJson(join(ctx.workspace, 'opencode.jsonc'));
  assert.ok(!('model' in config), 'the generated config sets no model');
  assert.ok(!('small_model' in config), 'the generated config sets no small_model');
  assert.equal(config.default_agent, 'build', 'the rest of the base config is kept');

  const profile = readFileSync(join(ctx.workspace, '.opencode', 'agents', 'pstack-agent.md'), 'utf8');
  assert.doesNotMatch(profile.split('\n---\n')[0], /^model:/m, 'the installed profile keeps a model line');
  assert.match(profile, /^model: a body line$/m, 'a body line that starts with model: was stripped');
  assert.match(profile, /^description: worker$/m, 'the installed profile lost its other frontmatter');
}, {});

withWorkspace('audit reports a config that still sets a model as drift', (ctx) => {
  writeFile(ctx.workspace, 'opencode.jsonc', '{\n  "model": "opencode-go/deepseek-v4.1-flash"\n}\n');

  const audit = runInstaller(shell, ctx, [], { apply: false });
  assert.equal(audit.status, 0, audit.stderr);
  assert.match(audit.stdout, /Drift: +.*opencode\.jsonc: differs/, audit.stdout);
  assert.match(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), /"model"/, 'audit rewrote the config');

  mustApply(ctx);
  assert.ok(!('model' in readJson(join(ctx.workspace, 'opencode.jsonc'))), 'apply kept the model');
}, {});

withWorkspace('the Claude runtime is a junction for local layers and a pinned sparse copy for pstack', (ctx) => {
  mustApply(ctx);

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
  assert.ok(existsSync(join(ctx.workspace, '.claude', 'cache', 'pstack', '.git')), 'the git cache is under .claude/cache, named for the layer');

  const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  const byName = Object.fromEntries(lock.layers.map((record) => [record.name, record]));
  assert.equal(byName['simpsonm09-org-ai-plugin'].claude.kind, 'junction');
  assert.equal(byName['simpsonm09-org-ai-plugin'].claude.plugin, 'simpsonm09-org-ai-plugin');
  assert.equal(byName['simpsonm09-org-ai-plugin'].claude.child, '.claude/plugins/simpsonm09-org-ai-plugin');
  assert.equal(byName['simpsonm09-org-ai-plugin'].claude.target, '.opencode/plugins/simpsonm09-org-ai-plugin');
  assert.match(byName['simpsonm09-org-ai-plugin'].claude.treeSha256, /^[0-9A-F]{64}$/);
  assert.equal(byName.pstack.claude.kind, 'git');
  assert.equal(byName.pstack.claude.commit, ctx.fixture.commit, 'the pstack record is the pinned commit');
  assert.equal(byName.pstack.claude.repository, ctx.fixture.url);
  assert.equal(byName.pstack.claude.path, 'plugins/pstack');
  assert.equal(byName.pstack.path, null, 'a git layer has no local checkout path');
  assert.equal(byName.pstack.commit, ctx.fixture.commit);
}, {});

withWorkspace('the pstack OpenCode entry and agents land from the one pstack source', (ctx) => {
  mustApply(ctx);

  const folder = join(ctx.workspace, '.opencode', 'plugins', 'pstack');
  assert.ok(existsSync(join(folder, 'opencode', 'index.ts')), 'the entry is installed');
  assert.ok(existsSync(join(folder, 'skills', 'poteto-mode', 'SKILL.md')), 'the shared skills sit beside the entry folder');
  assert.ok(existsSync(join(folder, 'opencode', 'node_modules', '@opencode', 'plugin', 'index.js')), 'the entry folder keeps its SDK');
  assert.ok(!existsSync(join(folder, 'index.ts')), 'the pstack folder root has no index.ts, so OpenCode does not load it twice');
  assert.ok(!existsSync(join(folder, 'other')), 'the OpenCode copy leaves out files outside the named items');

  for (const agent of ['pstack-agent.md', 'pstack-reviewer.md', 'pstack-comment-sicko.md']) {
    assert.ok(existsSync(join(ctx.workspace, '.opencode', 'agents', agent)), `${agent} is installed`);
  }
  const worker = readFileSync(join(ctx.workspace, '.opencode', 'agents', 'pstack-agent.md'), 'utf8');
  assert.doesNotMatch(worker.split('\n---\n')[0], /^model:/m, 'the installed worker keeps no model line');

  const config = readJson(join(ctx.workspace, 'opencode.jsonc'));
  assert.deepEqual(config.plugin, ['./.opencode/plugins/pstack/opencode'], 'only the nested entry is named in the config');

  const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  const byName = Object.fromEntries(lock.layers.map((record) => [record.name, record]));
  assert.deepEqual(byName.pstack.opencode, {
    enabled: true,
    folder: '.opencode/plugins/pstack',
    entry: 'opencode/index.ts',
    loader: 'config',
    plugin: './.opencode/plugins/pstack/opencode',
    agents: ['pstack-agent.md', 'pstack-comment-sicko.md', 'pstack-reviewer.md'],
  });
  assert.equal(byName['simpsonm09-org-ai-plugin'].opencode.loader, 'discovery', 'a root index.ts loads from its folder');
  assert.equal(byName['simpsonm09-org-ai-plugin'].opencode.plugin, null);
}, {});

withWorkspace('the retired pstack-opencode folder is removed, and the result matches a workspace that never had it', (ctx) => {
  mustApply(ctx);
  const clean = readdirSync(join(ctx.workspace, '.opencode', 'plugins')).sort();
  const cleanConfig = readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8');

  const retired = join(ctx.workspace, '.opencode', 'plugins', 'pstack-opencode');
  writeFile(retired, 'index.ts', 'export default {};\n');
  writeFile(retired, 'node_modules/@opencode/plugin/index.js', 'module.exports = {};\n');
  const run = mustApply(ctx);
  assert.match(run.stdout, /Removed the stale plugin folder .*pstack-opencode/);
  assert.ok(!existsSync(retired), 'the retired folder is still there');
  assert.deepEqual(readdirSync(join(ctx.workspace, '.opencode', 'plugins')).sort(), clean);
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), cleanConfig);

  mustApply(ctx);
  assert.deepEqual(readdirSync(join(ctx.workspace, '.opencode', 'plugins')).sort(), clean, 'a second apply changes nothing');
}, {});

withWorkspace('copilot.cmd names each Claude folder in layer order, sets the switch, and passes arguments on', (ctx) => {
  mustApply(ctx);
  const cmd = readFileSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd'), 'utf8');
  const lines = cmd.split(/\r?\n/);

  const plugins = join(ctx.workspace, '.claude', 'plugins');
  const pluginLines = lines.filter((line) => line.includes('--plugin-dir'));
  assert.equal(pluginLines.length, 1, 'one line runs the executable with every plugin folder');
  const dirs = [...pluginLines[0].matchAll(/--plugin-dir "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(dirs, [join(plugins, 'pstack'), join(plugins, 'simpsonm09-org-ai-plugin'), join(plugins, 'simpsonm09-personal-ai-plugin')], 'folders in layer order');

  const env = lines.indexOf('set "AGENT_ACCESS_COPILOT_ASK=allow"');
  assert.ok(env >= 0, 'the switch is set');
  assert.ok(env < lines.indexOf(pluginLines[0]), 'the switch is set before the executable runs');
  assert.ok(pluginLines[0].includes(`"${ctx.fakeCopilot}"`), 'the wrapper names the absolute executable');
  assert.ok(pluginLines[0].endsWith(' %*'), 'the wrapper passes its arguments on');
  assert.ok(!pluginLines[0].includes('.maxstack'), 'the wrapper does not name a file in its own folder');
}, {});

withWorkspace('copilot.cmd runs the executable with the switch, the plugin folders, and the caller arguments', (ctx) => {
  mustApply(ctx);
  const wrapper = join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd');
  const run = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${wrapper}" --foo "a b""`], { encoding: 'utf8', windowsVerbatimArguments: true });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const plugins = join(ctx.workspace, '.claude', 'plugins');
  const args = run.stdout.split(/\r?\n/).find((line) => line.startsWith('ARGS='));
  assert.equal(
    args,
    `ARGS=--plugin-dir "${join(plugins, 'pstack')}" --plugin-dir "${join(plugins, 'simpsonm09-org-ai-plugin')}" --plugin-dir "${join(plugins, 'simpsonm09-personal-ai-plugin')}" --foo "a b"`,
  );
  assert.match(run.stdout, /ASK=allow/);
}, {});

withWorkspace('copilot.sh runs copilot from PATH with the same folders and arguments', (ctx) => {
  const bash = findBash();
  if (!bash) return;
  mustApply(ctx);
  const sh = readFileSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.sh'), 'utf8');
  assert.match(sh, /^export AGENT_ACCESS_COPILOT_ASK=allow$/m, 'the script sets the switch');
  assert.match(sh, /exec copilot --plugin-dir "[^"]*\/\.claude\/plugins\/pstack" --plugin-dir "[^"]*\/simpsonm09-org-ai-plugin" --plugin-dir "[^"]*\/simpsonm09-personal-ai-plugin" "\$@"$/m);

  const fakeBin = join(ctx.base, 'fake-bin');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'copilot'), '#!/bin/sh\nprintf "ASK=%s\\n" "$AGENT_ACCESS_COPILOT_ASK"\nfor arg in "$@"; do printf "ARG=%s\\n" "$arg"; done\n');
  chmodSync(join(fakeBin, 'copilot'), 0o755);
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = `${fakeBin}${process.platform === 'win32' ? ';' : ':'}${env[pathKey] ?? ''}`;
  const run = spawnSync(bash, [join(ctx.workspace, '.maxstack', 'bin', 'copilot.sh').replaceAll('\\', '/'), '--foo', 'a b'], { encoding: 'utf8', env });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /ASK=allow/);
  assert.match(run.stdout, /ARG=--plugin-dir/);
  assert.match(run.stdout, /ARG=--foo\nARG=a b/, 'the caller arguments follow, unsplit');
}, {});

withWorkspace('copilot is skipped with a message when no executable is found, and an old wrapper goes', (ctx) => {
  mustApply(ctx);
  assert.ok(existsSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd')));

  const run = mustApply(ctx, ['-CopilotCommand', MISSING_COPILOT]);
  assert.match(plainOutput(run), /Copilot CLI not found/, run.stdout);
  assert.ok(!existsSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd')), 'the wrapper is still there');
  assert.ok(!existsSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.sh')), 'the script is still there');

  const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  assert.equal(lock.copilot.enabled, false);
  assert.match(lock.copilot.reason, /no 'maxstack-test-no-such-copilot' application/);
  assert.ok(lock.layers.every((record) => record.opencode.enabled), 'the OpenCode runtimes still install');
}, {});

withWorkspace('copilot never wraps the generated wrapper itself', (ctx) => {
  const bin = join(ctx.workspace, '.maxstack', 'bin');
  writeFile(bin, 'copilot.cmd', '@echo off\r\necho self\r\n');
  const run = mustApply(ctx, ['-CopilotCommand', join(bin, 'copilot.cmd')]);
  assert.match(plainOutput(run), /Copilot CLI not found/);
  assert.ok(!existsSync(join(bin, 'copilot.cmd')), 'the self-referencing wrapper is removed, not wrapped');
}, {});

withWorkspace('a git pin the repository cannot supply stops the run before anything is written', (ctx) => {
  const layers = writeLayers(ctx, (manifest) => {
    layerNamed(manifest, 'pstack').source.commit = 'f'.repeat(40);
  });
  const run = runInstaller(shell, ctx, [], { layersFile: layers });
  assert.notEqual(run.status, 0, 'the installer accepted an unreachable pin');
  assert.match(plainOutput(run), /Could not fetch the pinned commit f{40}/);
  assert.ok(!existsSync(join(ctx.workspace, 'opencode.jsonc')), 'the config was written before the pin check');
  assert.ok(!existsSync(join(ctx.workspace, '.claude', 'plugins', 'pstack')), 'a pstack folder was written');
  assert.ok(!existsSync(join(ctx.workspace, '.opencode', 'plugins', 'pstack')), 'an OpenCode folder was written');
}, {});

withWorkspace('an offline re-apply reuses the cached commit', (ctx) => {
  mustApply(ctx);
  const moved = `${ctx.fixture.dir}-moved`;
  renameSync(ctx.fixture.dir, moved);
  try {
    const run = runInstaller(shell, ctx);
    assert.equal(run.status, 0, `offline re-apply failed\n${run.stdout}\n${run.stderr}`);
    const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
    const pstack = lock.layers.find((record) => record.name === 'pstack');
    assert.equal(pstack.claude.commit, ctx.fixture.commit);
  } finally {
    renameSync(moved, ctx.fixture.dir);
  }
}, {});

withWorkspace('the cache follows the layer url, even when it was cloned from another remote', (ctx) => {
  mustApply(ctx);
  const cache = join(ctx.workspace, '.claude', 'cache', 'pstack');
  const drifted = spawnSync('git', ['-C', cache, 'remote', 'set-url', 'origin', 'file:///nonexistent/other-remote'], { encoding: 'utf8' });
  assert.equal(drifted.status, 0, drifted.stderr);

  mustApply(ctx);
  const origin = spawnSync('git', ['-C', cache, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).stdout.trim();
  assert.equal(origin, ctx.fixture.url, 'the cache origin was not reset to the layer url');
}, {});

withWorkspace('a second apply is idempotent: the same links, tree hashes, and wrappers', (ctx) => {
  mustApply(ctx);
  const first = readJson(join(ctx.workspace, 'stack.lock.json'));
  mustApply(ctx);
  const second = readJson(join(ctx.workspace, 'stack.lock.json'));
  const trees = (lock) => lock.layers.map((record) => [record.name, record.claude.treeSha256 ?? null, record.opencode.agents]);
  assert.deepEqual(trees(second), trees(first));
  assert.equal(second.copilot.cmdSha256, first.copilot.cmdSha256);
  assert.ok(isLink(join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-org-ai-plugin')));

  const audit = runInstaller(shell, ctx, [], { apply: false });
  assert.equal(audit.status, 0, audit.stderr);
  const drift = driftLines(audit);
  // config, three Claude children, three OpenCode folders, and the two Copilot wrappers.
  assert.equal(drift.length, 9, audit.stdout);
  for (const line of drift) assert.match(line, /: matches$/, line);
}, {});

withWorkspace('audit reports drift in every runtime and writes nothing', (ctx) => {
  const before = runInstaller(shell, ctx, [], { apply: false });
  assert.equal(before.status, 0, before.stderr);
  for (const child of ['simpsonm09-org-ai-plugin', 'simpsonm09-personal-ai-plugin', 'pstack']) {
    assert.match(before.stdout, new RegExp(`plugins\\\\${child}: missing`), `missing drift for ${child}`);
  }
  assert.match(before.stdout, /plugins\\pstack: missing/);
  assert.match(before.stdout, /copilot\.cmd: missing/);
  assert.ok(!existsSync(join(ctx.workspace, '.claude')), 'audit created the Claude folder');
  assert.ok(!existsSync(join(ctx.workspace, '.maxstack')), 'audit created the Copilot folder');
  assert.ok(!existsSync(join(ctx.workspace, 'stack.lock.json')), 'audit wrote the lock');

  mustApply(ctx);
  const skill = join(ctx.workspace, '.claude', 'plugins', 'pstack', 'skills', 'poteto-mode', 'SKILL.md');
  appendFileSync(skill, 'hand edit\n');

  const drifted = runInstaller(shell, ctx, [], { apply: false });
  assert.match(drifted.stdout, /plugins\\pstack: differs/);
  assert.match(readFileSync(skill, 'utf8'), /hand edit/, 'audit changed the drifted file');

  mustApply(ctx);
  assert.doesNotMatch(readFileSync(skill, 'utf8'), /hand edit/, 'apply restored the copied folder');
}, {});

withWorkspace('a claude runtime without a manifest fails with a clear error', (ctx) => {
  const run = runInstaller(shell, ctx);
  assert.notEqual(run.status, 0, 'the installer accepted a claude runtime with no manifest');
  assert.match(plainOutput(run), /claude runtime but no \.claude-plugin/);
}, { withManifests: false });

withWorkspace('a claude plugin name that differs from the layer name fails', (ctx) => {
  writeFile(join(ctx.workspace, 'projects/repos/simpsonm09-org-ai-plugin'), '.claude-plugin/plugin.json', JSON.stringify({ name: 'renamed' }));
  const run = runInstaller(shell, ctx);
  assert.notEqual(run.status, 0);
  assert.match(plainOutput(run), /is the Claude plugin 'simpsonm09-org-ai-plugin' but its \.claude-plugin\\plugin\.json names 'renamed'/);
}, {});

withWorkspace('copilot without claude is rejected, because the wrapper loads the Claude folder', (ctx) => {
  const layers = writeLayers(ctx, (manifest) => {
    layerNamed(manifest, 'simpsonm09-personal-ai-plugin').runtimes = { opencode: {}, copilot: {} };
  });
  const run = runInstaller(shell, ctx, [], { layersFile: layers });
  assert.notEqual(run.status, 0, 'the installer accepted copilot without claude');
  assert.match(plainOutput(run), /declares copilot, which loads the Claude plugin folder, so it also needs claude/);
}, {});

withWorkspace('removing the claude runtime removes only its link and keeps the installed copy', (ctx) => {
  mustApply(ctx);
  const child = join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-org-ai-plugin');
  const target = join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-org-ai-plugin');
  assert.ok(isLink(child));
  // Not an item in the layer's files list, so no apply copies over it.
  writeFile(target, 'keep-me.txt', 'the installed copy must survive\n');

  // copilot runs the Claude folder, so the layer loses both runtimes together.
  const layers = writeLayers(ctx, (manifest) => {
    layerNamed(manifest, 'simpsonm09-org-ai-plugin').runtimes = { opencode: {} };
  });
  mustApply(ctx, [], { layersFile: layers });

  assert.equal(lstatSync(child, { throwIfNoEntry: false }), undefined, 'the link is gone');
  assert.ok(existsSync(join(target, 'keep-me.txt')), 'the target lost a file');
  assert.ok(existsSync(join(target, 'index.ts')), 'the target lost its entrypoint');
  assert.ok(isLink(join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-personal-ai-plugin')), 'the personal link was disturbed');

  const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  assert.equal(lock.layers.find((record) => record.name === 'simpsonm09-org-ai-plugin').claude.enabled, false);
}, {});

withWorkspace('LayerSource overrides a local checkout, and refuses a git layer', (ctx) => {
  const alternate = join(ctx.base, 'alternate-org');
  writeLayerStub(alternate, { claudePlugin: 'simpsonm09-org-ai-plugin', extra: { 'from-override.txt': 'override\n' } });
  mustApply(ctx, ['-LayerSource', `simpsonm09-org-ai-plugin=${alternate}`]);
  assert.ok(existsSync(join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-org-ai-plugin', 'from-override.txt')));

  const refused = runInstaller(shell, ctx, ['-LayerSource', `pstack=${alternate}`]);
  assert.notEqual(refused.status, 0, 'LayerSource accepted a git layer');
  assert.match(plainOutput(refused), /LayerSource applies to a local checkout, and pstack is pinned/);
}, {});

withWorkspace('the installer has no live-server check and no skip switch', (ctx) => {
  // The installer has no live-server check; T3 can reuse a long-lived server.
  assert.doesNotMatch(readFileSync(installer, 'utf8'), /openchamber|SkipLiveServerCheck/i);
  const run = runInstaller(shell, ctx, ['-SkipLiveServerCheck'], { apply: false });
  assert.notEqual(run.status, 0, 'the installer accepted the removed -SkipLiveServerCheck switch');
  assert.match(plainOutput(run), /SkipLiveServerCheck/);
}, {});

withWorkspace('audit with the real layers.json needs no network and writes no runtime files', (ctx) => {
  // The real manifest points pstack at GitHub; audit must not fetch it.
  const args = [
    '-LayerSource',
    `simpsonm09-org-ai-plugin=${join(ctx.workspace, 'projects/repos/simpsonm09-org-ai-plugin')},` +
      `simpsonm09-personal-ai-plugin=${join(ctx.workspace, 'projects/repos/simpsonm09-personal-ai-plugin')}`,
  ];
  const run = runInstaller(shell, ctx, args, { apply: false, layersFile: null });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /plugins\\pstack: missing/);
  assert.ok(!existsSync(join(ctx.workspace, '.claude')), 'audit wrote under .claude');
  assert.ok(!existsSync(join(ctx.workspace, '.opencode')), 'audit wrote under .opencode');
  assert.ok(!existsSync(join(ctx.workspace, '.maxstack')), 'audit wrote under .maxstack');
}, {});

// A layer that stops declaring its runtimes leaves its installed folder behind. The first
// apply records that folder, so the next apply removes it.
function withoutPersonalRuntimes(ctx) {
  return writeLayers(ctx, (manifest) => {
    layerNamed(manifest, 'simpsonm09-personal-ai-plugin').runtimes = {};
  });
}

withWorkspace('a stale plugin folder the previous lock recorded is removed on apply', (ctx) => {
  mustApply(ctx);
  const stale = join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-personal-ai-plugin');
  assert.ok(existsSync(join(stale, 'index.ts')), 'the first apply made the folder');

  const run = mustApply(ctx, [], { layersFile: withoutPersonalRuntimes(ctx) });
  assert.match(run.stdout, /Removed the stale plugin folder .*simpsonm09-personal-ai-plugin/);
  assert.ok(!existsSync(stale), 'the stale folder is still there');
  assert.ok(existsSync(join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-org-ai-plugin', 'index.ts')), 'the current folder is missing');
  assert.equal(lstatSync(join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-personal-ai-plugin'), { throwIfNoEntry: false }), undefined, 'the personal link was not removed');
  assert.deepEqual(readJson(join(ctx.workspace, 'opencode.jsonc')).plugin, ['./.opencode/plugins/pstack/opencode'], 'the config still names pstack');
}, {});

withWorkspace('a stale plugin folder the previous lock never recorded is reported and kept', (ctx) => {
  mustApply(ctx);
  const handMade = join(ctx.workspace, '.opencode', 'plugins', 'hand-made');
  writeFile(handMade, 'notes.txt', 'not the installer\n');

  const audit = runInstaller(shell, ctx, [], { apply: false });
  assert.equal(audit.status, 0, audit.stderr);
  assert.match(audit.stdout, /Drift: +.*plugins\\hand-made: stale/, audit.stdout);

  const run = mustApply(ctx);
  assert.match(run.stdout, /Drift: +.*plugins\\hand-made: stale, kept/);
  assert.equal(readFileSync(join(handMade, 'notes.txt'), 'utf8'), 'not the installer\n', 'the unrecorded folder changed');
}, {});

withWorkspace('audit reports a stale recorded plugin folder and removes nothing', (ctx) => {
  mustApply(ctx);
  const stale = join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-personal-ai-plugin');
  const lockPath = join(ctx.workspace, 'stack.lock.json');
  const configPath = join(ctx.workspace, 'opencode.jsonc');
  const lockBefore = readFileSync(lockPath, 'utf8');
  const configBefore = readFileSync(configPath, 'utf8');

  const audit = runInstaller(shell, ctx, [], { apply: false, layersFile: withoutPersonalRuntimes(ctx) });
  assert.equal(audit.status, 0, audit.stderr);
  assert.match(audit.stdout, /plugins\\simpsonm09-personal-ai-plugin: stale/, audit.stdout);
  assert.doesNotMatch(audit.stdout, /Removed the stale plugin folder/);
  assert.ok(existsSync(join(stale, 'index.ts')), 'audit removed the stale folder');
  assert.equal(readFileSync(lockPath, 'utf8'), lockBefore, 'audit rewrote the lock');
  assert.equal(readFileSync(configPath, 'utf8'), configBefore, 'audit rewrote the config');
}, {});

function findPython() {
  for (const name of ['python', 'python3']) {
    if (spawnSync(name, ['--version']).status === 0) return name;
  }
  return null;
}

const python = findPython();

withWorkspace('the workspace verifier passes after an apply and flags a hand-edited Copilot wrapper', (ctx) => {
  if (!python) return;
  mustApply(ctx);
  const home = join(ctx.base, 'home');
  mkdirSync(home);
  const verify = () => spawnSync(python, [join(repoRoot, 'scripts', 'verify-workspace-install.py'), '--workspace', ctx.workspace, '--home', home], { encoding: 'utf8' });

  const passed = verify();
  assert.equal(passed.status, 0, `${passed.stdout}\n${passed.stderr}`);
  assert.match(passed.stdout, /PASS: workspace bundle present/);

  const cmd = join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd');
  appendFileSync(cmd, 'rem hand edit\r\n');
  const edited = verify();
  assert.notEqual(edited.status, 0, 'the verifier accepted an edited wrapper');
  assert.match(plainOutput(edited), /copilot\.cmd differs from the text recorded in stack\.lock\.json/);
}, {});
