#!/usr/bin/env node
// Prove Install-Workspace.ps1 installs each layer's runtimes from one layers.json: the
// Claude plugin folders, the OpenCode entry and agents, and the Copilot wrappers. The
// pstack source is a local git fixture standing in for GitHub, and Copilot is a stand-in
// command, so the tests need no network and no Copilot install.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  symlinkSync,
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
const MISSING_PI = 'maxstack-test-no-such-pi';

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
// fragment, a skills folder, a package.json, and a layer.json. A claude runtime needs
// .claude-plugin in its files list. A pi key adds a pi folder and lists it in the files.
function writeLayerStub(root, { claudePlugin = null, manifestName = claudePlugin, withManifest = true, extra = {}, pi = null } = {}) {
  const files = ['index.ts', 'node_modules', 'package.json', 'skills', ...Object.keys(extra)];
  if (claudePlugin) files.push('.claude-plugin');
  if (pi) files.push('pi');
  writeFile(root, 'index.ts', 'export default {};\n');
  writeFile(root, 'layer.json', JSON.stringify({ files }));
  writeFile(root, 'package.json', JSON.stringify({ name: manifestName ?? 'layer', version: '0.1.0', ...(pi ? { pi } : {}) }));
  writeFile(root, 'skills/demo-skill/SKILL.md', '---\nname: demo-skill\ndescription: fixture\n---\nbody\n');
  writeFile(root, 'node_modules/@opencode/plugin/index.js', 'module.exports = {};\n');
  writeFile(root, 'opencode.fragment.jsonc', '{}');
  if (pi) writeFile(root, 'pi/index.ts', 'export default {};\n');
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
  // The pinned repository root is the Pi package: its pi key names paths under plugins/pstack.
  writeFile(dir, 'package.json', JSON.stringify({ name: 'pstack', version: '0.9.79', pi: { skills: ['./plugins/pstack/skills'], extensions: ['./plugins/pstack/pi/index.ts'] } }));
  writeFile(dir, `${plugin}/pi/index.ts`, 'export default {};\n');
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

// A stand-in for the Pi CLI: it echoes the agent folder, the ask switch, and its arguments.
function writeFakePi(base) {
  const path = join(base, 'fake-pi.cmd');
  writeFileSync(path, '@echo off\r\necho AGENT_DIR=%PI_CODING_AGENT_DIR%\r\necho ASK=%AGENT_ACCESS_PI_ASK%\r\necho ARGS=%*\r\n');
  return path;
}

// A stand-in CLI on PATH for the host: a .cmd on Windows, and an executable file with no
// extension elsewhere, which is what Homebrew or npm put on a POSIX PATH.
function writeFakeCli(dir, name) {
  if (process.platform === 'win32') {
    const path = join(dir, `${name}.cmd`);
    writeFileSync(path, '@echo off\r\necho stand-in\r\n');
    return path;
  }
  const path = join(dir, name);
  writeFileSync(path, '#!/bin/sh\necho stand-in\n');
  chmodSync(path, 0o755);
  return path;
}

function buildWorkspace({ withManifests = true } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'maxstack-lock-'));
  const workspace = join(base, 'simpsonm09');
  for (const layerPath of LOCAL_LAYERS) {
    const name = layerPath.split('/').pop();
    writeLayerStub(join(workspace, layerPath), { claudePlugin: name, withManifest: withManifests });
  }
  return { base, workspace, fixture: makeFixture(base), fakeCopilot: writeFakeCopilot(base), fakePi: writeFakePi(base) };
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

// Runs the installer. Copilot and Pi are the stand-ins unless the caller names their command.
function runInstaller(shell, ctx, extra = [], { apply = true, layersFile = writeLayers(ctx) } = {}) {
  const copilot = extra.includes('-CopilotCommand') ? [] : ['-CopilotCommand', ctx.fakeCopilot];
  const pi = extra.includes('-PiCommand') ? [] : ['-PiCommand', ctx.fakePi];
  const args = [
    '-NoProfile', '-NonInteractive', '-File', installer,
    '-Workspace', ctx.workspace,
    ...(layersFile ? ['-LayersFile', layersFile] : []),
    ...copilot,
    ...pi,
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
    for (const runtime of ['claude', 'opencode', 'copilot', 'pi']) {
      assert.equal(typeof record[runtime]?.enabled, 'boolean', `layer ${record.name} has a ${runtime} record`);
    }
  }
  assert.equal(lock.copilot.enabled, true, 'the Copilot wrappers are recorded as written');
  assert.deepEqual(lock.copilot.wrappers, ['.maxstack/bin/copilot.cmd', '.maxstack/bin/copilot.sh']);
  assert.match(lock.copilot.cmdSha256, /^[0-9A-F]{64}$/);
  assert.equal(lock.pi.enabled, true, 'the Pi wrappers are recorded as written');
  assert.deepEqual(lock.pi.wrappers, ['.maxstack/bin/pi.cmd', '.maxstack/bin/pi.sh']);
  assert.equal(lock.pi.agentDir, '.pi/agent');
  assert.match(lock.pi.cmdSha256, /^[0-9A-F]{64}$/);
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
  // config, three Claude children, three OpenCode folders, the two Copilot wrappers, the two
  // Pi wrappers, and the Pi settings.
  assert.equal(drift.length, 12, audit.stdout);
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
  assert.match(before.stdout, /pi\.cmd: missing/);
  // The pinned cache is not synced until apply, so the settings cannot be checked before it.
  assert.match(before.stdout, /\.pi\\agent\\settings\.json: unknown until -Apply/);
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
  // Not an item in the layer's files list. The folder is wholly the installer's, so the apply removes it.
  writeFile(target, 'keep-me.txt', 'a file the layer does not install\n');

  // copilot runs the Claude folder, so the layer loses both runtimes together.
  const layers = writeLayers(ctx, (manifest) => {
    layerNamed(manifest, 'simpsonm09-org-ai-plugin').runtimes = { opencode: {} };
  });
  mustApply(ctx, [], { layersFile: layers });

  assert.equal(lstatSync(child, { throwIfNoEntry: false }), undefined, 'the link is gone');
  assert.ok(!existsSync(join(target, 'keep-me.txt')), 'the apply left a file the layer does not install');
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
  // The pinned cache is not synced in audit, so the Pi settings cannot be checked yet.
  assert.match(run.stdout, /\.pi\\agent\\settings\.json: unknown until -Apply/);
  assert.ok(!existsSync(join(ctx.workspace, '.claude')), 'audit wrote under .claude');
  assert.ok(!existsSync(join(ctx.workspace, '.opencode')), 'audit wrote under .opencode');
  assert.ok(!existsSync(join(ctx.workspace, '.maxstack')), 'audit wrote under .maxstack');
  assert.ok(!existsSync(join(ctx.workspace, '.pi')), 'audit wrote under .pi');
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

withWorkspace('pi.cmd sets the agent folder and the ask switch, runs the Pi CLI with the arguments, and honours MAXSTACK_PI_BIN', (ctx) => {
  mustApply(ctx);
  const wrapper = join(ctx.workspace, '.maxstack', 'bin', 'pi.cmd');
  const text = readFileSync(wrapper, 'utf8');
  assert.match(text, /\r\n/, 'the wrapper has CRLF endings');
  assert.ok(text.includes(`set "PI_CODING_AGENT_DIR=${join(ctx.workspace, '.pi', 'agent')}"`), 'the agent folder is not set');
  assert.ok(text.includes('set "AGENT_ACCESS_PI_ASK=allow"'), 'the ask switch is not set');
  assert.ok(text.includes(`set "PI_BIN=${ctx.fakePi}"`), 'the wrapper does not name the Pi CLI found at install time');

  const run = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${wrapper}" --mode rpc "a b""`], { encoding: 'utf8', windowsVerbatimArguments: true });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.ok(run.stdout.includes(`AGENT_DIR=${join(ctx.workspace, '.pi', 'agent')}`), run.stdout);
  assert.match(run.stdout, /ASK=allow/);
  assert.match(run.stdout, /ARGS=--mode rpc "a b"/);

  const other = join(ctx.base, 'other-pi.cmd');
  writeFileSync(other, '@echo off\r\necho OTHER=%PI_CODING_AGENT_DIR%\r\n');
  const overridden = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${wrapper}" --mode rpc"`], { encoding: 'utf8', windowsVerbatimArguments: true, env: { ...process.env, MAXSTACK_PI_BIN: other } });
  assert.equal(overridden.status, 0, `${overridden.stdout}\n${overridden.stderr}`);
  assert.ok(overridden.stdout.includes(`OTHER=${join(ctx.workspace, '.pi', 'agent')}`), 'MAXSTACK_PI_BIN did not name the CLI that ran');
}, {});

// cmd's call doubles carets and eats a percent sign before the target sees them, so only a
// .cmd or .bat target may go through call. node.exe stands in for an .exe target here.
withWorkspace('pi.cmd passes arguments to an .exe target unchanged', (ctx) => {
  mustApply(ctx);
  const script = join(ctx.base, 'echo-args.js');
  writeFileSync(script, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
  const wrapper = join(ctx.workspace, '.maxstack', 'bin', 'pi.cmd');
  const run = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${wrapper}" "${script}" "a^b" "100%""`], {
    encoding: 'utf8',
    windowsVerbatimArguments: true,
    env: { ...process.env, MAXSTACK_PI_BIN: process.execPath },
  });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.deepEqual(JSON.parse(run.stdout), ['a^b', '100%'], 'the wrapper changed the arguments');
}, {});

// pi.sh puts the agent folder inside double quotes, so a dollar sign or a backtick in the baked
// path would change what the shell runs. The cmd wrapper keeps both as plain text, so the run
// stops only on the shell side. Windows allows both characters in a folder name.
test('a workspace path that pi.sh cannot quote stops the run before anything is written', { skip }, () => {
  for (const name of ['sim$pson', 'sim`pson']) {
    const ctx = buildWorkspace();
    try {
      const renamed = join(ctx.base, name);
      renameSync(ctx.workspace, renamed);
      ctx.workspace = renamed;
      const run = runInstaller(shell, ctx);
      assert.notEqual(run.status, 0, `the installer accepted the workspace path ${name}`);
      assert.match(plainOutput(run), /the Pi shell wrapper cannot quote/, run.stdout);
      assert.ok(!existsSync(join(ctx.workspace, '.maxstack', 'bin', 'pi.sh')), 'pi.sh was written');
    } finally {
      rmSync(ctx.base, { recursive: true, force: true });
    }
  }
});

withWorkspace('pi.sh runs pi from PATH with the agent folder and the ask switch, and honours MAXSTACK_PI_BIN', (ctx) => {
  const bash = findBash();
  if (!bash) return;
  mustApply(ctx);
  const sh = readFileSync(join(ctx.workspace, '.maxstack', 'bin', 'pi.sh'), 'utf8');
  assert.doesNotMatch(sh, /\r/, 'the script has LF endings');
  assert.match(sh, /^export PI_CODING_AGENT_DIR="[^"]*\/\.pi\/agent"$/m);
  assert.match(sh, /^export AGENT_ACCESS_PI_ASK=allow$/m);
  assert.match(sh, /^exec "\$pi_bin" "\$@"$/m);

  const fakeBin = join(ctx.base, 'pi-fake-bin');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'pi'), '#!/bin/sh\nprintf "AGENT=%s\\n" "$PI_CODING_AGENT_DIR"\nprintf "ASK=%s\\n" "$AGENT_ACCESS_PI_ASK"\nfor arg in "$@"; do printf "ARG=%s\\n" "$arg"; done\n');
  chmodSync(join(fakeBin, 'pi'), 0o755);
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = `${fakeBin}${process.platform === 'win32' ? ';' : ':'}${env[pathKey] ?? ''}`;
  const script = join(ctx.workspace, '.maxstack', 'bin', 'pi.sh').replaceAll('\\', '/');
  const agentDir = join(ctx.workspace, '.pi', 'agent').replaceAll('\\', '/');

  const run = spawnSync(bash, [script, '--mode', 'rpc', 'a b'], { encoding: 'utf8', env });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.ok(run.stdout.includes(`AGENT=${agentDir}`), run.stdout);
  assert.match(run.stdout, /ASK=allow/);
  assert.match(run.stdout, /ARG=--mode\nARG=rpc\nARG=a b/, 'the caller arguments follow, unsplit');

  const overrideBin = join(ctx.base, 'override-pi');
  writeFileSync(overrideBin, '#!/bin/sh\nprintf "OVERRIDE=%s\\n" "$1"\n');
  chmodSync(overrideBin, 0o755);
  const noPi = { ...process.env, [pathKey]: '/nonexistent-maxstack-path', MAXSTACK_PI_BIN: overrideBin.replaceAll('\\', '/') };
  const overridden = spawnSync(bash, [script, 'rpc'], { encoding: 'utf8', env: noPi });
  assert.equal(overridden.status, 0, `${overridden.stdout}\n${overridden.stderr}`);
  assert.match(overridden.stdout, /OVERRIDE=rpc/);
}, {});

withWorkspace('the installer writes no Pi model or provider, and a fresh Pi settings file holds only packages and skills', (ctx) => {
  mustApply(ctx);
  const fresh = readJson(join(ctx.workspace, '.pi', 'agent', 'settings.json'));
  assert.deepEqual(Object.keys(fresh).sort(), ['packages', 'skills'], 'the installer wrote a key it does not own');
  assert.ok(!('defaultModel' in fresh) && !('defaultProvider' in fresh), 'the installer named a model or provider');
}, {});

withWorkspace('the Pi settings list each package and skills folder, and keep the keys and entries the installer does not own', (ctx) => {
  const settingsPath = join(ctx.workspace, '.pi', 'agent', 'settings.json');
  writeFile(ctx.workspace, '.pi/agent/settings.json', JSON.stringify({
    defaultProvider: 'user-provider',
    defaultModel: 'user-model',
    packages: ['../../user/own-package'],
    skills: ['../../user/own-skills'],
  }, null, 2));

  mustApply(ctx);
  const settings = readJson(settingsPath);
  assert.equal(settings.defaultProvider, 'user-provider', 'the installer dropped a key it does not own');
  assert.equal(settings.defaultModel, 'user-model', 'the installer dropped a model the user chose');
  assert.deepEqual(settings.packages, ['../../user/own-package', '../../.claude/cache/pstack'], 'the packages list');
  assert.deepEqual(settings.skills, [
    '../../user/own-skills',
    '../../.claude/plugins/pstack/skills',
    '../../.claude/plugins/simpsonm09-org-ai-plugin/skills',
    '../../.claude/plugins/simpsonm09-personal-ai-plugin/skills',
  ], 'the skills list');
  const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  assert.deepEqual(lock.pi.packages, ['../../.claude/cache/pstack'], 'the lock records only the entries the installer wrote');

  const again = mustApply(ctx);
  assert.match(again.stdout, /Pi settings already match/, 'a second apply rewrote the settings');
  assert.deepEqual(readJson(settingsPath).packages, settings.packages);

  // pstack stops declaring pi. Its entries go, and the user's stay.
  const layers = writeLayers(ctx, (manifest) => {
    delete layerNamed(manifest, 'pstack').runtimes.pi;
  });
  mustApply(ctx, [], { layersFile: layers });
  const dropped = readJson(settingsPath);
  assert.equal(dropped.defaultProvider, 'user-provider');
  assert.deepEqual(dropped.packages, ['../../user/own-package'], 'a layer that dropped pi left its package behind');
  assert.ok(!dropped.skills.includes('../../.claude/plugins/pstack/skills'), 'a layer that dropped pi left its skills behind');
  assert.ok(dropped.skills.includes('../../user/own-skills'), 'the user skills were removed');
}, {});

// Pi accepts package entries as objects, which the user may write with filters. Distinct
// objects are distinct entries: none is collapsed, and their order holds.
withWorkspace('the user object entries in the Pi packages survive a merge, in order, and repeat on a second apply', (ctx) => {
  const alpha = { source: '../../user/alpha', filters: ['a'] };
  const beta = { source: '../../user/beta' };
  const settingsPath = join(ctx.workspace, '.pi', 'agent', 'settings.json');
  writeFile(ctx.workspace, '.pi/agent/settings.json', JSON.stringify({ packages: [alpha, '../../user/own', beta] }));

  mustApply(ctx);
  assert.deepEqual(readJson(settingsPath).packages, [alpha, '../../user/own', beta, '../../.claude/cache/pstack']);
  mustApply(ctx);
  assert.deepEqual(readJson(settingsPath).packages, [alpha, '../../user/own', beta, '../../.claude/cache/pstack'], 'a second apply changed the user entries');
}, {});

withWorkspace('an entry the user already lists is not written twice', (ctx) => {
  const settingsPath = join(ctx.workspace, '.pi', 'agent', 'settings.json');
  writeFile(ctx.workspace, '.pi/agent/settings.json', JSON.stringify({ packages: ['../../.claude/cache/pstack'] }));
  mustApply(ctx);
  assert.deepEqual(readJson(settingsPath).packages, ['../../.claude/cache/pstack']);
}, {});

withWorkspace('a local layer is a Pi package only when its package.json names a pi key', (ctx) => {
  writeLayerStub(join(ctx.workspace, 'projects/repos/simpsonm09-org-ai-plugin'), {
    claudePlugin: 'simpsonm09-org-ai-plugin',
    pi: { extensions: ['./pi/index.ts'] },
  });
  mustApply(ctx);
  const settings = readJson(join(ctx.workspace, '.pi', 'agent', 'settings.json'));
  assert.ok(settings.packages.includes('../../.claude/plugins/simpsonm09-org-ai-plugin'), 'the org layer is not a package');
  assert.ok(!settings.packages.includes('../../.claude/plugins/simpsonm09-personal-ai-plugin'), 'a layer without a pi key is a package');
  assert.ok(existsSync(join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-org-ai-plugin', 'pi', 'index.ts')), 'the pi folder is not installed');

  const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  const byName = Object.fromEntries(lock.layers.map((record) => [record.name, record]));
  assert.deepEqual(byName['simpsonm09-org-ai-plugin'].pi, {
    enabled: true,
    package: '.claude/plugins/simpsonm09-org-ai-plugin',
    skills: '.claude/plugins/simpsonm09-org-ai-plugin/skills',
  });
  assert.deepEqual(byName['simpsonm09-personal-ai-plugin'].pi, {
    enabled: true,
    package: null,
    skills: '.claude/plugins/simpsonm09-personal-ai-plugin/skills',
  });
}, {});

withWorkspace('a pi key needs package.json in the installed copy, and the run stops without it', (ctx) => {
  const org = join(ctx.workspace, 'projects/repos/simpsonm09-org-ai-plugin');
  writeLayerStub(org, { claudePlugin: 'simpsonm09-org-ai-plugin', pi: { extensions: ['./pi/index.ts'] } });
  // The source keeps the package.json that names the pi key, but the files list leaves it out,
  // so the installed copy has the pi folder and no package.json for Pi to read.
  const layerPath = join(org, 'layer.json');
  const layer = readJson(layerPath);
  writeFile(org, 'layer.json', JSON.stringify({ ...layer, files: layer.files.filter((file) => file !== 'package.json') }));

  const run = runInstaller(shell, ctx);
  assert.notEqual(run.status, 0, 'the installer accepted a pi key whose installed copy has no package.json');
  assert.match(plainOutput(run), /has a pi key in its package\.json, but its installed copy at .* has no package\.json/);
}, {});

withWorkspace('a pi key that names a file the installed copy lacks is refused', (ctx) => {
  writeLayerStub(join(ctx.workspace, 'projects/repos/simpsonm09-org-ai-plugin'), {
    claudePlugin: 'simpsonm09-org-ai-plugin',
    pi: { extensions: ['./pi/missing.ts'] },
  });
  const run = runInstaller(shell, ctx);
  assert.notEqual(run.status, 0, 'the installer accepted a pi key that names a missing file');
  assert.match(plainOutput(run), /names the extensions entry \.\/pi\/missing\.ts in its package\.json pi key, but .* does not carry it/);
}, {});

withWorkspace('a pi runtime without claude is rejected, because the Pi settings list the Claude folder skills', (ctx) => {
  const layers = writeLayers(ctx, (manifest) => {
    layerNamed(manifest, 'simpsonm09-personal-ai-plugin').runtimes = { opencode: {}, pi: {} };
  });
  const run = runInstaller(shell, ctx, [], { layersFile: layers });
  assert.notEqual(run.status, 0, 'the installer accepted pi without claude');
  assert.match(plainOutput(run), /declares pi, which lists the Claude plugin folder's skills, so it also needs claude/);
}, {});

withWorkspace('pi is skipped with a message when no executable is found, and its settings still list the layers', (ctx) => {
  mustApply(ctx);
  assert.ok(existsSync(join(ctx.workspace, '.maxstack', 'bin', 'pi.cmd')));

  const run = mustApply(ctx, ['-PiCommand', MISSING_PI]);
  assert.match(plainOutput(run), /Pi CLI not found/, run.stdout);
  assert.ok(!existsSync(join(ctx.workspace, '.maxstack', 'bin', 'pi.cmd')), 'the Pi wrapper is still there');
  assert.ok(!existsSync(join(ctx.workspace, '.maxstack', 'bin', 'pi.sh')), 'the Pi script is still there');
  assert.ok(existsSync(join(ctx.workspace, '.pi', 'agent', 'settings.json')), 'the settings were not written without the CLI');

  const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  assert.equal(lock.pi.enabled, false);
  assert.match(lock.pi.reason, /no 'maxstack-test-no-such-pi' application/);
  assert.ok(lock.layers.every((record) => record.opencode.enabled), 'the OpenCode runtimes still install');
}, {});

withWorkspace('the verifier fails when a configured CLI is on PATH but its wrapper was never generated', (ctx) => {
  if (!python) return;
  mustApply(ctx, ['-PiCommand', MISSING_PI]);
  const home = join(ctx.base, 'home');
  mkdirSync(home);
  const cliDir = join(ctx.base, 'cli-on-path');
  mkdirSync(cliDir);
  const fakePi = writeFakeCli(cliDir, 'pi');
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  env[pathKey] = `${cliDir}${process.platform === 'win32' ? ';' : ':'}${env[pathKey] ?? ''}`;
  assert.ok(fakePi.startsWith(cliDir));

  const run = spawnSync(python, [join(repoRoot, 'scripts', 'verify-workspace-install.py'), '--workspace', ctx.workspace, '--home', home], { encoding: 'utf8', env });
  assert.notEqual(run.status, 0, 'the verifier passed with the Pi CLI on PATH and no Pi wrapper');
  assert.match(plainOutput(run), /the pi CLI is on PATH.*rerun Install-Workspace\.ps1 -Apply/);
}, {});

// T3 spawns binaryPath directly, so the .sh wrappers need the executable bit off Windows.
// Windows has no mode bits to check, so only those assertions are skipped there.
test('the shell wrappers are executable off Windows, and the verifier checks the bit', { skip }, async (t) => {
  const posix = process.platform !== 'win32';
  const ctx = buildWorkspace();
  try {
    const extra = posix
      ? ['-PiCommand', writeFakeCli(ctx.base, 'stand-in-pi'), '-CopilotCommand', writeFakeCli(ctx.base, 'stand-in-copilot')]
      : [];
    mustApply(ctx, extra);
    const bin = join(ctx.workspace, '.maxstack', 'bin');
    const home = join(ctx.base, 'home');
    mkdirSync(home);
    const verify = () => spawnSync(python, [join(repoRoot, 'scripts', 'verify-workspace-install.py'), '--workspace', ctx.workspace, '--home', home], { encoding: 'utf8' });

    await t.test('pi.sh and copilot.sh have the executable bit', { skip: posix ? false : 'the executable bit is POSIX-only' }, () => {
      for (const name of ['pi.sh', 'copilot.sh']) {
        assert.notEqual(statSync(join(bin, name)).mode & 0o111, 0, `${name} is not executable`);
      }
    });

    await t.test('the verifier fails when the bit is missing, and passes once it is back', { skip: !python || !posix ? 'needs POSIX and python' : false }, () => {
      chmodSync(join(bin, 'pi.sh'), 0o644);
      const missing = verify();
      assert.notEqual(missing.status, 0, 'the verifier accepted a Pi script that is not executable');
      assert.match(plainOutput(missing), /pi\.sh is not executable/);
      chmodSync(join(bin, 'pi.sh'), 0o755);
      assert.equal(verify().status, 0);
    });
  } finally {
    rmSync(ctx.base, { recursive: true, force: true });
  }
});

// The wrapper target filter, called with each platform as a parameter, so the macOS cases run
// on Windows too. The harness takes the function's text from the installer's own parse tree.
const WRAPPER_TARGET_CASES = [
  ['/opt/homebrew/bin/pi', false, true],
  ['/usr/local/bin/copilot', false, true],
  ['/opt/homebrew/bin/pi.ps1', false, false],
  ['/opt/homebrew/bin/pi.cmd', false, false],
  ['C:\\tools\\pi.exe', true, true],
  ['C:\\tools\\pi.cmd', true, true],
  ['C:\\tools\\pi.bat', true, true],
  ['C:\\tools\\pi.ps1', true, false],
  ['/opt/homebrew/bin/pi', true, false],
];

function wrapperTargetHarness(cases) {
  const rows = cases
    .map(([path, windows]) => `  [pscustomobject]@{ path = '${path.replaceAll("'", "''")}'; windows = ${windows ? '$true' : '$false'} }`)
    .join(',\n');
  return `param([string] $Installer)
$tokens = $null
$errors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($Installer, [ref] $tokens, [ref] $errors)
$definition = $ast.FindAll({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-WrapperTarget' }, $true) | Select-Object -First 1
if (-not $definition) { throw 'Test-WrapperTarget is not defined in the installer' }
Invoke-Expression $definition.Extent.Text
$cases = @(
${rows}
)
$results = foreach ($case in $cases) {
  [pscustomobject]@{ path = $case.path; windows = $case.windows; accepted = [bool] (Test-WrapperTarget -Path $case.path -Windows $case.windows) }
}
ConvertTo-Json -InputObject @($results) -Depth 3 -Compress
`;
}

test('a wrapper takes an extensionless CLI off Windows, and refuses PowerShell and cmd shims on each platform', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-target-'));
  try {
    const harness = join(dir, 'harness.ps1');
    writeFileSync(harness, wrapperTargetHarness(WRAPPER_TARGET_CASES));
    const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', harness, installer], { encoding: 'utf8' });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const results = JSON.parse(run.stdout);
    for (const [path, windows, accepted] of WRAPPER_TARGET_CASES) {
      const row = results.find((result) => result.path === path && result.windows === windows);
      assert.equal(row?.accepted, accepted, `${path} on ${windows ? 'Windows' : 'macOS or Linux'}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

// The hash check passes here, because the lock is updated to the edited script. What remains
// is the folder the script names, which the verifier must compare to the workspace's.
withWorkspace('the verifier compares the agent folder in pi.sh with the workspace, not just its presence', (ctx) => {
  if (!python) return;
  mustApply(ctx);
  const home = join(ctx.base, 'home');
  mkdirSync(home);
  const verify = () => spawnSync(python, [join(repoRoot, 'scripts', 'verify-workspace-install.py'), '--workspace', ctx.workspace, '--home', home], { encoding: 'utf8' });
  const shPath = join(ctx.workspace, '.maxstack', 'bin', 'pi.sh');
  const lockPath = join(ctx.workspace, 'stack.lock.json');

  const text = readFileSync(shPath, 'utf8');
  const tampered = text.replace(/^export PI_CODING_AGENT_DIR=".*"$/m, 'export PI_CODING_AGENT_DIR="/tmp/elsewhere/.pi/agent"');
  assert.notEqual(tampered, text, 'the test did not change the agent folder line');
  writeFileSync(shPath, tampered);
  const lock = readJson(lockPath);
  lock.pi.shSha256 = createHash('sha256').update(tampered).digest('hex').toUpperCase();
  writeFileSync(lockPath, JSON.stringify(lock));

  const wrong = verify();
  assert.notEqual(wrong.status, 0, 'the verifier accepted a pi.sh that names another agent folder');
  assert.match(plainOutput(wrong), /pi\.sh does not set PI_CODING_AGENT_DIR to /);

  mustApply(ctx);
  assert.equal(verify().status, 0);
}, {});

withWorkspace('the workspace verifier checks the Pi wrappers and the Pi settings', (ctx) => {
  if (!python) return;
  mustApply(ctx);
  const home = join(ctx.base, 'home');
  mkdirSync(home);
  const verify = () => spawnSync(python, [join(repoRoot, 'scripts', 'verify-workspace-install.py'), '--workspace', ctx.workspace, '--home', home], { encoding: 'utf8' });
  const settingsPath = join(ctx.workspace, '.pi', 'agent', 'settings.json');

  const passed = verify();
  assert.equal(passed.status, 0, `${passed.stdout}\n${passed.stderr}`);

  appendFileSync(join(ctx.workspace, '.maxstack', 'bin', 'pi.sh'), '# hand edit\n');
  const edited = verify();
  assert.notEqual(edited.status, 0, 'the verifier accepted an edited Pi script');
  assert.match(plainOutput(edited), /pi\.sh differs from the text recorded in stack\.lock\.json/);

  mustApply(ctx);
  const settings = readJson(settingsPath);
  writeFile(ctx.workspace, '.pi/agent/settings.json', JSON.stringify({ ...settings, packages: [] }));
  const unlisted = verify();
  assert.notEqual(unlisted.status, 0, 'the verifier accepted settings without a recorded package');
  assert.match(plainOutput(unlisted), /does not list the Pi packages entry \.\.\/\.\.\/\.claude\/cache\/pstack/);

  mustApply(ctx);
  const restored = verify();
  assert.equal(restored.status, 0, `${restored.stdout}\n${restored.stderr}`);
}, {});

// The ownership record and -Status. A status run reads the record and the disk, and writes
// nothing, so each test checks the files it could have changed.
const lockPath = (ctx) => join(ctx.workspace, 'stack.lock.json');
const settingsPath = (ctx) => join(ctx.workspace, '.pi', 'agent', 'settings.json');
const verifyWorkspaceScript = join(repoRoot, 'scripts', 'verify-workspace-install.py');
const verifyManifestsScript = join(repoRoot, 'scripts', 'verify-manifests.py');

function runStatus(ctx, extra = []) {
  return runInstaller(shell, ctx, ['-Status', ...extra], { apply: false });
}

// The status report: one "<state> <label>" line per path, then a summary line.
function statusRows(run) {
  return run.stdout
    .split(/\r?\n/)
    .map((line) => /^(matching|drifted|modified|missing|untracked)\s+(.+)$/.exec(line))
    .filter(Boolean)
    .map(([, state, label]) => ({ state, label: label.trim() }));
}

function problemRows(run) {
  return statusRows(run).filter((row) => row.state !== 'matching');
}

withWorkspace('apply records an owned entry for every path it wrote, and the record validates', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  assert.equal(lock.ownedSchema, 1, 'the record has no schema version');
  const owned = lock.owned;
  const find = (path, kind, key) => owned.find((record) => record.path === path && record.kind === kind && (key === undefined || record.key === key));

  assert.match(find('opencode.jsonc', 'file').sha256, /^[0-9A-F]{64}$/);
  for (const plugin of ['simpsonm09-org-ai-plugin', 'simpsonm09-personal-ai-plugin']) {
    assert.equal(find(`.claude/plugins/${plugin}`, 'link').target, `.opencode/plugins/${plugin}`, `the link of ${plugin}`);
  }
  assert.match(find('.claude/plugins/pstack', 'dir').sha256, /^[0-9A-F]{64}$/);
  assert.match(find('.claude/cache/pstack', 'dir').sha256, /^[0-9A-F]{64}$/);
  for (const plugin of ['pstack', 'simpsonm09-org-ai-plugin', 'simpsonm09-personal-ai-plugin']) {
    assert.match(find(`.opencode/plugins/${plugin}`, 'dir').sha256, /^[0-9A-F]{64}$/, `the OpenCode folder of ${plugin}`);
  }
  for (const agent of ['pstack-agent.md', 'pstack-reviewer.md', 'pstack-comment-sicko.md']) {
    assert.match(find(`.opencode/agents/${agent}`, 'file').sha256, /^[0-9A-F]{64}$/, `the profile ${agent}`);
  }
  for (const wrapper of ['copilot.cmd', 'copilot.sh', 'pi.cmd', 'pi.sh']) {
    assert.match(find(`.maxstack/bin/${wrapper}`, 'file').sha256, /^[0-9A-F]{64}$/, `the wrapper ${wrapper}`);
  }
  assert.deepEqual(find('.pi/agent/settings.json', 'json-entries', 'packages').entries, ['../../.claude/cache/pstack']);
  assert.equal(find('.pi/agent/settings.json', 'json-entries', 'skills').entries.length, 3, 'one skills entry per layer folder');

  assert.ok(!owned.some((record) => record.path === 'stack.lock.json'), 'the lock records itself');
  assert.equal(owned.length, 17, 'one record per path the install wrote; the two Pi lists hold one record each');
  for (const name of readdirSync(join(ctx.workspace, '.maxstack', 'bin'))) {
    assert.ok(find(`.maxstack/bin/${name}`, 'file'), `${name} is written but not recorded`);
  }
  for (const name of readdirSync(join(ctx.workspace, '.opencode', 'agents'))) {
    assert.ok(find(`.opencode/agents/${name}`, 'file'), `${name} is written but not recorded`);
  }

  const check = spawnSync(python, [verifyManifestsScript, '--lock', lockPath(ctx)], { encoding: 'utf8' });
  assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
}, {});

withWorkspace('a second apply with nothing to change leaves the lock byte-identical except generatedAt', (ctx) => {
  mustApply(ctx);
  const first = readFileSync(lockPath(ctx), 'utf8');
  mustApply(ctx);
  const second = readFileSync(lockPath(ctx), 'utf8');
  const withoutTime = (text) => text.replace(/"generatedAt":\s*"[^"]*"/, '"generatedAt": ""');
  assert.ok(readJson(lockPath(ctx)).owned.length > 0, 'the record is empty');
  assert.equal(withoutTime(second), withoutTime(first));
}, {});

withWorkspace('status reports every owned path as matching after an apply, and writes nothing', (ctx) => {
  mustApply(ctx);
  const lockBefore = readFileSync(lockPath(ctx), 'utf8');
  const settingsBefore = readFileSync(settingsPath(ctx), 'utf8');

  const run = runStatus(ctx);
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.equal(statusRows(run).length, 19, run.stdout);
  assert.deepEqual([...new Set(statusRows(run).map((row) => row.state))], ['matching'], run.stdout);
  assert.match(run.stdout, /Summary: 19 matching, 0 drifted, 0 modified, 0 missing, 0 untracked/);
  assert.equal(runStatus(ctx, ['-Strict']).status, 0, '-Strict failed on a matching workspace');

  assert.equal(readFileSync(lockPath(ctx), 'utf8'), lockBefore, 'status rewrote the lock');
  assert.equal(readFileSync(settingsPath(ctx), 'utf8'), settingsBefore, 'status rewrote the Pi settings');
}, {});

withWorkspace('status reports a hand-edited file as modified, and -Strict fails on it', (ctx) => {
  mustApply(ctx);
  appendFileSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd'), 'rem hand edit\r\n');
  const run = runStatus(ctx);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(problemRows(run), [{ state: 'modified', label: '.maxstack/bin/copilot.cmd' }], run.stdout);
  assert.equal(runStatus(ctx, ['-Strict']).status, 1, '-Strict accepted a modified file');
}, {});

withWorkspace('status reports a deleted file as missing', (ctx) => {
  mustApply(ctx);
  rmSync(join(ctx.workspace, '.opencode', 'agents', 'pstack-reviewer.md'));
  const run = runStatus(ctx);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(problemRows(run), [{ state: 'missing', label: '.opencode/agents/pstack-reviewer.md' }], run.stdout);
}, {});

withWorkspace('status reports a removed Pi entry alone, and never reports a key the installer does not own', (ctx) => {
  mustApply(ctx);
  const settings = readJson(settingsPath(ctx));
  writeFile(ctx.workspace, '.pi/agent/settings.json', JSON.stringify({
    ...settings,
    defaultModel: 'user-model',
    packages: settings.packages.filter((entry) => entry !== '../../.claude/cache/pstack'),
  }, null, 2));
  const before = readFileSync(settingsPath(ctx), 'utf8');

  const run = runStatus(ctx);
  assert.equal(run.status, 0, run.stderr);
  const problems = problemRows(run);
  assert.equal(problems.length, 1, run.stdout);
  assert.equal(problems[0].state, 'missing');
  assert.match(problems[0].label, /^\.pi\/agent\/settings\.json \[packages\] "\.\.\/\.\.\/\.claude\/cache\/pstack"$/, run.stdout);
  assert.doesNotMatch(run.stdout, /defaultModel|user-model/, 'status reported a key the installer does not own');
  assert.equal(readFileSync(settingsPath(ctx), 'utf8'), before, 'status rewrote the Pi settings');
}, {});

withWorkspace('a layer source that changed since the apply is drifted, not modified', (ctx) => {
  mustApply(ctx);
  writeFile(ctx.workspace, 'projects/repos/simpsonm09-org-ai-plugin/skills/new-skill/SKILL.md', '---\nname: new-skill\ndescription: fixture\n---\nbody\n');
  const run = runStatus(ctx);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(problemRows(run), [{ state: 'drifted', label: '.opencode/plugins/simpsonm09-org-ai-plugin' }], run.stdout);

  mustApply(ctx);
  assert.deepEqual(problemRows(runStatus(ctx)), [], 'an apply did not bring the record back to matching');
}, {});

withWorkspace('a file in .maxstack/bin that the record does not name is untracked', (ctx) => {
  mustApply(ctx);
  writeFile(ctx.workspace, '.maxstack/bin/notes.txt', 'not the installer\n');
  const run = runStatus(ctx);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(problemRows(run), [{ state: 'untracked', label: '.maxstack/bin/notes.txt' }], run.stdout);
  assert.equal(runStatus(ctx, ['-Strict']).status, 1, '-Strict accepted an untracked file');
}, {});

withWorkspace('a file a user adds to an owned folder is modified, and the next apply removes it', (ctx) => {
  mustApply(ctx);
  const folder = '.opencode/plugins/simpsonm09-org-ai-plugin';
  writeFile(ctx.workspace, `${folder}/notes.txt`, 'mine\n');
  const run = runStatus(ctx);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(problemRows(run), [{ state: 'modified', label: folder }], run.stdout);

  const applied = mustApply(ctx);
  assert.match(applied.stdout, /Removed .*notes\.txt: the layer does not install it/, applied.stdout);
  assert.ok(!existsSync(join(ctx.workspace, ...folder.split('/'), 'notes.txt')), 'the apply kept the user file');
  assert.deepEqual(problemRows(runStatus(ctx)), [], 'the apply did not bring the folder back to matching');
}, {});

withWorkspace('the package-lock.json that npm writes beside an installed package.json is removed, and reported until then', (ctx) => {
  mustApply(ctx);
  const folder = '.opencode/plugins/simpsonm09-org-ai-plugin';
  writeFile(ctx.workspace, `${folder}/package-lock.json`, '{}\n');
  assert.deepEqual(problemRows(runStatus(ctx)), [{ state: 'modified', label: folder }]);
  const applied = mustApply(ctx);
  assert.match(applied.stdout, /Removed .*package-lock\.json/, applied.stdout);
  assert.ok(!existsSync(join(ctx.workspace, ...folder.split('/'), 'package-lock.json')));
}, {});

withWorkspace('a lock without an owned list gets the clear message, and -Strict fails on it', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  delete lock.owned;
  delete lock.ownedSchema;
  writeFileSync(lockPath(ctx), JSON.stringify(lock));

  const run = runStatus(ctx);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /no ownership record; run -Apply once to create it/, run.stdout);
  assert.equal(runStatus(ctx, ['-Strict']).status, 1, '-Strict accepted a workspace with no record');

  mustApply(ctx);
  assert.ok(readJson(lockPath(ctx)).owned.length > 0, 'apply did not create the record');
}, {});

withWorkspace('a workspace with no lock has no ownership record, and status writes no lock', (ctx) => {
  const run = runStatus(ctx);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /no ownership record; run -Apply once to create it/, run.stdout);
  assert.ok(!existsSync(lockPath(ctx)), 'status wrote a lock');
}, {});

withWorkspace('-Status and -Apply together are refused', (ctx) => {
  const run = runInstaller(shell, ctx, ['-Status']);
  assert.notEqual(run.status, 0, 'the installer accepted -Status with -Apply');
  assert.match(plainOutput(run), /Choose one/);
}, {});

withWorkspace('the workspace verifier checks each owned path against the disk and refuses a malformed record', (ctx) => {
  if (!python) return;
  mustApply(ctx);
  const home = join(ctx.base, 'home');
  mkdirSync(home);
  const verify = () => spawnSync(python, [verifyWorkspaceScript, '--workspace', ctx.workspace, '--home', home], { encoding: 'utf8' });
  assert.equal(verify().status, 0, 'the verifier refused a fresh apply');

  const lock = readJson(lockPath(ctx));
  lock.owned.find((record) => record.path === '.opencode/agents/pstack-reviewer.md').sha256 = 'F'.repeat(64);
  writeFileSync(lockPath(ctx), JSON.stringify(lock));
  const drifted = verify();
  assert.notEqual(drifted.status, 0, 'the verifier accepted a file that differs from its owned hash');
  assert.match(plainOutput(drifted), /owned file .*pstack-reviewer\.md differs/);

  mustApply(ctx);
  const malformed = readJson(lockPath(ctx));
  malformed.owned[0].path = 'opencode\\jsonc';
  writeFileSync(lockPath(ctx), JSON.stringify(malformed));
  const badPath = verify();
  assert.notEqual(badPath.status, 0, 'the verifier accepted a backslash path');
  assert.match(plainOutput(badPath), /path must be a workspace-relative path with forward slashes/);

  mustApply(ctx);
  const unowned = readJson(lockPath(ctx));
  delete unowned.owned;
  writeFileSync(lockPath(ctx), JSON.stringify(unowned));
  assert.match(plainOutput(verify()), /has no owned list; rerun Install-Workspace\.ps1 -Apply/);
}, {});

// Round two: the ownership record is a claim about the disk, so each test below checks one claim
// against a value this file computes itself, never against the installer's own output.
function sha256Upper(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

function sortUtf8(lines) {
  return [...lines].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
}

function linkTargetText(path) {
  let target = readlinkSync(path);
  for (const prefix of ['\\\\?\\', '\\??\\']) {
    if (target.startsWith(prefix)) target = target.slice(prefix.length);
  }
  return target.replace(/\\+$/, '');
}

// A tree hash computed here. Owned: node_modules and .git are left out at any depth. Legacy: only a
// top-level node_modules, without regard to case, is left out. Links are listed, never followed.
function independentSha(root, rule) {
  const lines = [];
  const walk = (dir, prefix) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      const relative = prefix === '' ? name : `${prefix}/${name}`;
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) {
        lines.push(`${relative}\tlink:${linkTargetText(full)}`);
      } else if (stat.isDirectory()) {
        const skipped = rule === 'owned' ? name === 'node_modules' || name === '.git' : prefix === '' && name.toLowerCase() === 'node_modules';
        if (!skipped) walk(full, relative);
      } else {
        lines.push(`${relative}\t${sha256Upper(readFileSync(full))}`);
      }
    }
  };
  walk(root, '');
  return sha256Upper(Buffer.from(sortUtf8(lines).map((line) => `${line}\n`).join(''), 'utf8'));
}

function ownedRecord(lock, path, kind, key = '') {
  return lock.owned.find((record) => record.path === path && record.kind === kind && (record.key ?? '') === key);
}

const ORG_FOLDER = '.opencode/plugins/simpsonm09-org-ai-plugin';
const ORG_SOURCE = 'projects/repos/simpsonm09-org-ai-plugin';

withWorkspace('the recorded hashes match an independent recomputation, and each link names its target', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  const at = (path) => join(ctx.workspace, ...path.split('/'));

  assert.equal(ownedRecord(lock, 'opencode.jsonc', 'file').sha256, sha256Upper(readFileSync(at('opencode.jsonc'))));
  for (const folder of ['.opencode/plugins/pstack', ORG_FOLDER, '.opencode/plugins/simpsonm09-personal-ai-plugin', '.claude/plugins/pstack', '.claude/cache/pstack']) {
    assert.equal(ownedRecord(lock, folder, 'dir').sha256, independentSha(at(folder), 'owned'), `the tree hash of ${folder}`);
  }
  for (const wrapper of ['copilot.cmd', 'copilot.sh', 'pi.cmd', 'pi.sh']) {
    assert.equal(ownedRecord(lock, `.maxstack/bin/${wrapper}`, 'file').sha256, sha256Upper(readFileSync(at(`.maxstack/bin/${wrapper}`))), wrapper);
  }
  assert.equal(ownedRecord(lock, '.opencode/agents/pstack-agent.md', 'file').sha256, sha256Upper(readFileSync(at('.opencode/agents/pstack-agent.md'))));
  assert.equal(ownedRecord(lock, '.claude/plugins/simpsonm09-org-ai-plugin', 'link').target, ORG_FOLDER);
  assert.deepEqual(ownedRecord(lock, '.pi/agent/settings.json', 'json-entries', 'packages').entries, ['../../.claude/cache/pstack']);
  const check = spawnSync(python, [verifyManifestsScript, '--lock', lockPath(ctx)], { encoding: 'utf8' });
  assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
}, {});

withWorkspace('names sort by code point, and the tree hash keeps case, emoji, and fullwidth names exact', (ctx) => {
  // Node_Modules is an item, not npm's folder, so it is hashed. An emoji name sorts after a fullwidth
  // one by code point, and before it by UTF-16, so a sort in the wrong order changes the hash.
  const org = join(ctx.workspace, ...ORG_SOURCE.split('/'));
  writeFile(org, 'Node_Modules/@opencode/plugin/index.js', 'module.exports = {};\n');
  writeFile(org, 'Package-Lock.json', '{"lockfileVersion": 3}\n');
  writeFile(org, '\u{1F642}-emoji/a.txt', 'emoji\n');
  writeFile(org, 'Ａ-fullwidth/b.txt', 'fullwidth\n');
  writeFile(org, 'layer.json', JSON.stringify({
    files: ['index.ts', 'Node_Modules', 'Package-Lock.json', '\u{1F642}-emoji', 'Ａ-fullwidth', 'package.json', 'skills', '.claude-plugin'],
  }));
  mustApply(ctx);
  const folder = join(ctx.workspace, ...ORG_FOLDER.split('/'));
  assert.ok(existsSync(join(folder, 'Node_Modules', '@opencode', 'plugin', 'index.js')));
  assert.ok(existsSync(join(folder, 'Package-Lock.json')), 'the item named Package-Lock.json was not kept');
  assert.ok(existsSync(join(folder, '\u{1F642}-emoji', 'a.txt')));
  assert.ok(existsSync(join(folder, 'Ａ-fullwidth', 'b.txt')));
  const lock = readJson(lockPath(ctx));
  assert.equal(ownedRecord(lock, ORG_FOLDER, 'dir').sha256, independentSha(folder, 'owned'));
  assert.deepEqual(problemRows(runStatus(ctx)), []);
}, {});

withWorkspace('a junction inside an owned folder is hashed as a link, never followed, and the apply removes it and keeps its target', (ctx) => {
  mustApply(ctx);
  const folder = join(ctx.workspace, ...ORG_FOLDER.split('/'));
  const outside = join(ctx.base, 'outside');
  writeFile(ctx.base, 'outside/keep.txt', 'outside the workspace\n');
  symlinkSync(outside, join(folder, 'outside-link'), 'junction');

  const run = runStatus(ctx);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(problemRows(run), [{ state: 'modified', label: ORG_FOLDER }], run.stdout);

  const applied = mustApply(ctx);
  assert.match(applied.stdout, /Removed .*outside-link/, applied.stdout);
  assert.ok(existsSync(join(outside, 'keep.txt')), 'the apply deleted the junction target');
  assert.equal(lstatSync(join(folder, 'outside-link'), { throwIfNoEntry: false }), undefined, 'the junction is still there');
  assert.deepEqual(problemRows(runStatus(ctx)), []);
}, {});

withWorkspace('a junction that loops back into its own folder neither hangs the status nor survives the apply', (ctx) => {
  mustApply(ctx);
  const folder = join(ctx.workspace, ...ORG_FOLDER.split('/'));
  symlinkSync(folder, join(folder, 'loop'), 'junction');
  const run = runStatus(ctx);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(problemRows(run), [{ state: 'modified', label: ORG_FOLDER }], run.stdout);
  mustApply(ctx);
  assert.equal(lstatSync(join(folder, 'loop'), { throwIfNoEntry: false }), undefined, 'the loop is still there');
  assert.deepEqual(problemRows(runStatus(ctx)), []);
}, {});

withWorkspace('a link retargeted by hand is modified, and a file changed in a pinned claude copy is modified', (ctx) => {
  mustApply(ctx);
  const child = join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-org-ai-plugin');
  rmdirSync(child);
  const other = join(ctx.base, 'other-target');
  mkdirSync(other);
  symlinkSync(other, child, 'junction');
  appendFileSync(join(ctx.workspace, '.claude', 'plugins', 'pstack', 'skills', 'poteto-mode', 'SKILL.md'), 'edit\n');

  assert.deepEqual(problemRows(runStatus(ctx)), [
    { state: 'modified', label: '.claude/plugins/pstack' },
    { state: 'modified', label: '.claude/plugins/simpsonm09-org-ai-plugin' },
  ]);
  mustApply(ctx);
  assert.equal(realpathSync(child).toLowerCase(), realpathSync(join(ctx.workspace, ...ORG_FOLDER.split('/'))).toLowerCase());
  assert.deepEqual(problemRows(runStatus(ctx)), []);
}, {});

withWorkspace('node_modules and .git folders nested in an owned folder are not part of its hash', (ctx) => {
  mustApply(ctx);
  writeFile(ctx.workspace, `${ORG_FOLDER}/skills/demo/node_modules/pkg/index.js`, 'module.exports = {};\n');
  writeFile(ctx.workspace, `${ORG_FOLDER}/skills/demo/.git/HEAD`, 'ref: refs/heads/main\n');
  assert.deepEqual(problemRows(runStatus(ctx)), []);
}, {});

withWorkspace('an unsynced pinned cache reports only the entries it cannot know, each once', (ctx) => {
  mustApply(ctx);
  // The pin moves to a commit the cache has not fetched: pstack's folders and entries are unknown.
  writeFileSync(join(ctx.fixture.dir, 'bump.txt'), 'bump\n');
  const commit = (args) => {
    const run = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', '-C', ctx.fixture.dir, ...args], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout.trim();
  };
  commit(['add', '-A']);
  commit(['commit', '-q', '-m', 'bump']);
  const moved = commit(['rev-parse', 'HEAD']);
  const layers = writeLayers(ctx, (manifest) => {
    layerNamed(manifest, 'pstack').source.commit = moved;
  });

  const run = runInstaller(shell, ctx, ['-Status'], { apply: false, layersFile: layers });
  assert.equal(run.status, 0, run.stderr);
  const problems = problemRows(run);
  assert.ok(problems.length > 0, run.stdout);
  assert.ok(problems.every((row) => row.state === 'drifted'), run.stdout);
  assert.ok(problems.every((row) => row.label.includes('pstack')), `a local layer is reported: ${run.stdout}`);
  const labels = problems.map((row) => row.label);
  assert.equal(new Set(labels).size, labels.length, `a path is reported twice: ${run.stdout}`);
  const localSkills = problems.filter((row) => /simpsonm09-(org|personal)-ai-plugin\/skills/.test(row.label));
  assert.deepEqual(localSkills, [], `a local layer's entry was reported: ${run.stdout}`);
}, {});

withWorkspace('a lock from before the ownership record reads quietly, and the claude hashes keep the legacy rule', (ctx) => {
  // A nested node_modules is part of the legacy hash, because that rule leaves out only the top level.
  writeFile(ctx.workspace, `${ORG_SOURCE}/skills/legacy/node_modules/pkg/index.js`, 'module.exports = {};\n');
  mustApply(ctx);
  const current = readJson(lockPath(ctx));
  const orgLayer = current.layers.find((record) => record.name === 'simpsonm09-org-ai-plugin');
  assert.equal(orgLayer.claude.treeSha256, independentSha(join(ctx.workspace, ...ORG_FOLDER.split('/')), 'legacy'));

  const legacy = { ...current };
  for (const field of ['owned', 'ownedSchema', 'createdDirs', 'createdFiles']) delete legacy[field];
  writeFileSync(lockPath(ctx), JSON.stringify(legacy));

  const audit = runInstaller(shell, ctx, [], { apply: false });
  assert.equal(audit.status, 0, audit.stderr);
  const drift = driftLines(audit);
  assert.equal(drift.length, 12, audit.stdout);
  for (const line of drift) assert.match(line, /: matches$/, line);
  assert.match(runStatus(ctx).stdout, /no ownership record; run -Apply once to create it/);

  mustApply(ctx);
  assert.equal(readJson(lockPath(ctx)).ownedSchema, 1);
  assert.deepEqual(problemRows(runStatus(ctx)), []);
}, {});

withWorkspace('a Pi entry the user already lists is the user\'s: the record does not hold it, and a second apply keeps it so', (ctx) => {
  writeFile(ctx.workspace, '.pi/agent/settings.json', JSON.stringify({
    packages: ['../../.claude/cache/pstack'],
    skills: ['../../.claude/plugins/pstack/skills', '../../.claude/plugins/simpsonm09-org-ai-plugin/skills', '../../.claude/plugins/simpsonm09-personal-ai-plugin/skills'],
  }));
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  assert.equal(lock.owned.filter((record) => record.kind === 'json-entries').length, 0, 'the installer claimed entries the user already had');
  assert.deepEqual(readJson(settingsPath(ctx)).packages, ['../../.claude/cache/pstack']);
  mustApply(ctx);
  assert.deepEqual(readJson(settingsPath(ctx)).packages, ['../../.claude/cache/pstack'], 'a second apply added a copy');
  assert.deepEqual(problemRows(runStatus(ctx)), []);
}, {});

withWorkspace('a copy the user wrote beside an installer entry stays the user\'s, and the record holds one copy', (ctx) => {
  mustApply(ctx);
  writeFile(ctx.workspace, '.pi/agent/settings.json', JSON.stringify({
    ...readJson(settingsPath(ctx)),
    packages: ['../../.claude/cache/pstack', '../../.claude/cache/pstack'],
  }));
  mustApply(ctx);
  assert.deepEqual(readJson(settingsPath(ctx)).packages, ['../../.claude/cache/pstack', '../../.claude/cache/pstack']);
  const record = ownedRecord(readJson(lockPath(ctx)), '.pi/agent/settings.json', 'json-entries', 'packages');
  assert.deepEqual(record.entries, ['../../.claude/cache/pstack'], 'the record holds more than the installer copy');
  assert.deepEqual(problemRows(runStatus(ctx)), []);
}, {});

withWorkspace('an apply over a legacy lock keeps one copy of an entry that lock lists under pi, and records it', (ctx) => {
  mustApply(ctx);
  // The legacy lock lists the entry under pi, and the settings hold one copy; the stand-in rule owns it.
  const current = readJson(lockPath(ctx));
  const legacy = { ...current };
  for (const field of ['owned', 'ownedSchema', 'createdDirs', 'createdFiles']) delete legacy[field];
  writeFileSync(lockPath(ctx), JSON.stringify(legacy));
  mustApply(ctx);
  assert.deepEqual(readJson(settingsPath(ctx)).packages, ['../../.claude/cache/pstack'], 'the legacy apply duplicated the entry');
  assert.deepEqual(ownedRecord(readJson(lockPath(ctx)), '.pi/agent/settings.json', 'json-entries', 'packages').entries, ['../../.claude/cache/pstack']);
}, {});

withWorkspace('a layer that declares no Pi entries records none, and the apply still writes the settings file', (ctx) => {
  const layers = writeLayers(ctx, (manifest) => {
    delete layerNamed(manifest, 'pstack').runtimes.pi;
  });
  for (const name of ['simpsonm09-org-ai-plugin', 'simpsonm09-personal-ai-plugin']) {
    const root = join(ctx.workspace, 'projects', 'repos', name);
    const layer = readJson(join(root, 'layer.json'));
    writeFile(root, 'layer.json', JSON.stringify({ ...layer, files: layer.files.filter((file) => file !== 'skills') }));
    rmSync(join(root, 'skills'), { recursive: true, force: true });
  }
  mustApply(ctx, [], { layersFile: layers });
  assert.equal(readJson(lockPath(ctx)).owned.filter((record) => record.kind === 'json-entries').length, 0);
  assert.deepEqual(readJson(settingsPath(ctx)).packages, []);
  const status = runInstaller(shell, ctx, ['-Status'], { apply: false, layersFile: layers });
  assert.equal(status.status, 0, status.stderr);
  assert.deepEqual(problemRows(status), [], 'an empty Pi list was reported');
}, {});

withWorkspace('the record names the directories and files the installer created, and not the ones that were there first', (ctx) => {
  writeFile(ctx.workspace, '.maxstack/notes.txt', 'mine\n');
  writeFile(ctx.workspace, '.pi/agent/settings.json', JSON.stringify({ defaultProvider: 'user-provider' }));
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  assert.ok(!lock.createdDirs.includes('.maxstack'), 'the folder that was there first is listed as created');
  assert.ok(!lock.createdDirs.includes('.pi'), 'the folder that was there first is listed as created');
  for (const dir of ['.claude', '.claude/plugins', '.claude/cache', '.claude/cache/pstack', '.claude/plugins/pstack', '.opencode/plugins', '.opencode/agents', '.maxstack/bin']) {
    assert.ok(lock.createdDirs.includes(dir), `${dir} was created by the install but is not listed`);
  }
  assert.deepEqual(lock.createdFiles, [], 'a settings file that was there first is listed as created');
  assert.equal(ownedRecord(lock, '.pi/agent/settings.json', 'json-entries', 'packages').createdKey, true, 'a key the user file lacked is not marked as created');
  assert.equal(readJson(settingsPath(ctx)).defaultProvider, 'user-provider');
}, {});

withWorkspace('a settings file the apply created is listed in createdFiles, with no created key', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  assert.deepEqual(lock.createdFiles, ['.pi/agent/settings.json']);
  assert.equal(ownedRecord(lock, '.pi/agent/settings.json', 'json-entries', 'packages').createdKey, undefined);
}, {});

withWorkspace('a backup the apply writes is recorded with its hash, and it is reported once it exists', (ctx) => {
  mustApply(ctx);
  const config = join(ctx.workspace, 'opencode.jsonc');
  const configBefore = '{ "user": "edit" }\n';
  writeFileSync(config, configBefore);
  const settingsBefore = JSON.stringify({ ...readJson(settingsPath(ctx)), defaultModel: 'user-model' }, null, 2);
  writeFileSync(settingsPath(ctx), settingsBefore);
  assert.deepEqual(problemRows(runStatus(ctx)), [{ state: 'modified', label: 'opencode.jsonc' }], 'a backup the apply has not written was reported');

  mustApply(ctx);
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc.bak'), 'utf8'), configBefore);
  assert.equal(readFileSync(join(ctx.workspace, '.pi', 'agent', 'settings.json.bak'), 'utf8'), settingsBefore);
  const lock = readJson(lockPath(ctx));
  assert.equal(ownedRecord(lock, 'opencode.jsonc.bak', 'file').sha256, sha256Upper(Buffer.from(configBefore, 'utf8')));
  assert.equal(ownedRecord(lock, '.pi/agent/settings.json.bak', 'file').sha256, sha256Upper(Buffer.from(settingsBefore, 'utf8')));
  assert.deepEqual(problemRows(runStatus(ctx)), []);

  appendFileSync(join(ctx.workspace, 'opencode.jsonc.bak'), 'x');
  assert.deepEqual(problemRows(runStatus(ctx)), [{ state: 'modified', label: 'opencode.jsonc.bak' }]);
}, {});

withWorkspace('a layer that stops naming a folder leaves no copy of it in the owned folder', (ctx) => {
  // docs is not a Pi skills folder, so the layer can stop naming it without tripping the Pi check.
  const root = join(ctx.workspace, 'projects', 'repos', 'simpsonm09-org-ai-plugin');
  writeFile(root, 'docs/readme.md', 'docs\n');
  const withDocs = readJson(join(root, 'layer.json'));
  writeFile(root, 'layer.json', JSON.stringify({ ...withDocs, files: [...withDocs.files, 'docs'] }));
  mustApply(ctx);
  assert.ok(existsSync(join(ctx.workspace, ...ORG_FOLDER.split('/'), 'docs', 'readme.md')));

  writeFile(root, 'layer.json', JSON.stringify(withDocs));
  const run = mustApply(ctx);
  assert.match(run.stdout, /Removed .*docs: the layer does not install it/, run.stdout);
  assert.ok(!existsSync(join(ctx.workspace, ...ORG_FOLDER.split('/'), 'docs')));
  assert.deepEqual(problemRows(runStatus(ctx)), []);
}, {});
