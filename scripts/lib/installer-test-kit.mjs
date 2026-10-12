// Shared fixtures and helpers for the installer suite. Each Install-Workspace.*.test.mjs file imports what it uses,
// so each file keeps its own temp roots and runs in its own process. This module holds no test.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, chmodSync, mkdtempSync, rmSync, lstatSync, readlinkSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname, join, delimiter, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const installer = join(repoRoot, 'scripts', 'Install-Workspace.ps1');

// The two local layers. Each declares every runtime, and each needs a manifest whose name
// matches its layer name. pstack is pinned to a git source and needs no local checkout.
export const LOCAL_LAYERS = ['projects/repos/simpsonm09-org-ai-plugin', 'projects/repos/simpsonm09-personal-ai-plugin'];

export const MISSING_COPILOT = 'maxstack-test-no-such-copilot';

export const MISSING_PI = 'maxstack-test-no-such-pi';

// The upstream main commit before the settings slice. The no-settings comparisons run its installer.
export const MAIN_COMMIT = '5f44d9d36cd0196df783ff3697019bb2b3d6c281';

export let layersCounter = 0;

// The installer needs PowerShell 7 (#requires -Version 7.0), so only pwsh is tried. Windows PowerShell 5.1 stops every installer
// run with a version error, so it is never the shell. Without pwsh the tests skip with that reason.
export function findShell() {
  return spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).status === 0 ? 'pwsh' : null;
}

export function writeFile(root, rel, content) {
  const full = join(root, ...rel.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// PowerShell colours and wraps its error view, with a "Line |" gutter, so matching
// a message needs the escape codes, the gutter bars, and the line breaks removed.
export function plainOutput(run) {
  return `${run.stdout}\n${run.stderr}`
    // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte is the ANSI colour code being removed
    .replace(/\x1B\[[0-9;]*m/g, '')
    .replace(/\s*\|\s*/g, ' ')
    .replace(/\s+/g, ' ');
}

// A local layer stub: an index.ts, a node_modules tree so the installer skips npm, a
// fragment, a skills folder, a package.json, and a layer.json. A claude runtime needs
// .claude-plugin in its files list. A pi key adds a pi folder and lists it in the files.
export function writeLayerStub(root, { claudePlugin = null, manifestName = claudePlugin, withManifest = true, extra = {}, pi = null } = {}) {
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
// With npm, the OpenCode package declares a dependency and ships no node_modules, so the installer runs npm in the
// entry's folder. With shipLock, the package also ships a package-lock.json, as a layer may.
export const SHIPPED_LOCK = '{"lockfileVersion": 3, "shipped": true}\n';

export const SHIPPED_SHRINKWRAP = '{"lockfileVersion": 3, "shippedShrinkwrap": true}\n';

export function makeFixture(base, { npm = false, shipLock = false, shipShrinkwrap = false } = {}) {
  const dir = join(base, 'pstack-src');
  const plugin = 'plugins/pstack';
  writeFile(dir, `${plugin}/.claude-plugin/plugin.json`, JSON.stringify({ name: 'pstack', version: '0.9.79' }));
  for (const skillId of ['poteto-mode', 'setup-pstack', 'principle-laziness-protocol']) {
    writeFile(dir, `${plugin}/skills/${skillId}/SKILL.md`, `---\nname: ${skillId}\ndescription: fixture\n---\nfixture body\n`);
  }
  writeFile(dir, `${plugin}/opencode/index.ts`, 'export default {};\n');
  const packageJson = npm ? { name: 'pstack-opencode', private: true, dependencies: { '@opencode/plugin': '2.0.18' } } : { name: 'pstack-opencode', private: true };
  writeFile(dir, `${plugin}/opencode/package.json`, JSON.stringify(packageJson));
  if (shipLock) writeFile(dir, `${plugin}/opencode/package-lock.json`, SHIPPED_LOCK);
  if (shipShrinkwrap) writeFile(dir, `${plugin}/opencode/npm-shrinkwrap.json`, SHIPPED_SHRINKWRAP);
  if (!npm) writeFile(dir, `${plugin}/opencode/node_modules/@opencode/plugin/index.js`, 'module.exports = {};\n');
  writeFile(dir, `${plugin}/opencode/agents/pstack-agent.md`, '---\ndescription: worker\nmodel: opencode-go/deepseek-v4.1-flash\n---\nbody\nmodel: a body line\n');
  writeFile(dir, `${plugin}/opencode/agents/pstack-reviewer.md`, '---\ndescription: reviewer\n---\nreview\n');
  writeFile(dir, `${plugin}/opencode/agents/pstack-comment-sicko.md`, '---\ndescription: comments\n---\ncomments\n');
  // The pinned repository root is the Pi package: its pi key names paths under plugins/pstack.
  writeFile(dir, 'package.json', JSON.stringify({ name: 'pstack', version: '0.9.79', pi: { skills: ['./plugins/pstack/skills'], extensions: ['./plugins/pstack/pi/index.ts'] } }));
  writeFile(dir, `${plugin}/pi/index.ts`, 'export default {};\n');
  writeFile(dir, 'other/notes.txt', 'outside the plugin folder\n');
  const git = (args) => {
    const run = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { windowsHide: true, cwd: dir, encoding: 'utf8' });
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
export function writeFakeCopilot(base) {
  const path = join(base, 'fake-copilot.cmd');
  writeFileSync(path, '@echo off\r\necho ASK=%AGENT_ACCESS_COPILOT_ASK%\r\necho ARGS=%*\r\n');
  return path;
}

// A stand-in for the Pi CLI: it echoes the agent folder, the ask switch, and its arguments.
export function writeFakePi(base) {
  const path = join(base, 'fake-pi.cmd');
  writeFileSync(path, '@echo off\r\necho AGENT_DIR=%PI_CODING_AGENT_DIR%\r\necho ASK=%AGENT_ACCESS_PI_ASK%\r\necho ARGS=%*\r\n');
  return path;
}

// A stand-in for npm on PATH. A real install beside a package.json writes a package-lock.json and a node_modules
// folder into its prefix, and nothing else here. FAKE_NPM_EXTRA names one more file it writes, and FAKE_NPM_REWRITE
// makes it write a different lock, as npm does to a lock the layer ships. A node script runs it, behind a .cmd on
// Windows and a shell file elsewhere.
export const FAKE_NPM_SCRIPT = `import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const prefix = process.argv[process.argv.indexOf('--prefix') + 1];
const shrinkwrap = join(prefix, 'npm-shrinkwrap.json');
// npm writes into a shrinkwrap the layer ships, and otherwise into package-lock.json; FAKE_NPM_SHRINKWRAP makes it generate one.
const lockPath = process.env.FAKE_NPM_SHRINKWRAP || existsSync(shrinkwrap) ? shrinkwrap : join(prefix, 'package-lock.json');
const lock = process.env.FAKE_NPM_REWRITE ? '{"lockfileVersion": 3, "rewritten": true}' : '{"lockfileVersion": 3}';
writeFileSync(lockPath, lock);
const sdk = join(prefix, 'node_modules', '@opencode', 'plugin', 'index.js');
mkdirSync(dirname(sdk), { recursive: true });
writeFileSync(sdk, 'module.exports = {};\\n');
if (process.env.FAKE_NPM_EXTRA) {
  const extra = join(prefix, process.env.FAKE_NPM_EXTRA);
  mkdirSync(dirname(extra), { recursive: true });
  writeFileSync(extra, 'written by npm\\n');
}
// FAKE_NPM_BROKEN_SCOPE leaves a scope folder that is a junction to a folder that is gone, which listing it cannot read.
if (process.env.FAKE_NPM_BROKEN_SCOPE) {
  mkdirSync(join(prefix, 'node_modules'), { recursive: true });
  symlinkSync(join(prefix, 'gone-target'), join(prefix, 'node_modules', '@broken'), 'junction');
}
// FAKE_NPM_SCRIPTED lists installed packages that declare a postinstall script, so the ignore-scripts scan has them.
if (process.env.FAKE_NPM_SCRIPTED) {
  for (const name of JSON.parse(process.env.FAKE_NPM_SCRIPTED)) {
    const dir = join(prefix, 'node_modules', ...name.split('/'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', scripts: { postinstall: 'node build.js' } }));
  }
}
`;

export function writeFakeNpm(base) {
  const bin = join(base, 'fake-npm-bin');
  const script = join(base, 'fake-npm.mjs');
  mkdirSync(bin);
  writeFileSync(script, FAKE_NPM_SCRIPT);
  if (process.platform === 'win32') {
    writeFileSync(join(bin, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  } else {
    const path = join(bin, 'npm');
    writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    chmodSync(path, 0o755);
  }
  return bin;
}

// The environment the installer runs in, with the fake npm first on PATH. The key is found by case, because
// Windows keeps the variable as Path in the environment object.
export function environmentWithNpm(bin) {
  const env = { ...process.env };
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') ?? 'PATH';
  env[key] = `${bin}${delimiter}${env[key] ?? ''}`;
  return env;
}

// The workspace and its fixtures. An npm fixture runs the installer with the fake npm on PATH, and ctx.env holds that
// environment, so a test can set FAKE_NPM_EXTRA or FAKE_NPM_REWRITE on it.
export function buildWorkspace({ withManifests = true, fixture = {} } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'maxstack-lock-'));
  const workspace = join(base, 'simpsonm09');
  for (const layerPath of LOCAL_LAYERS) {
    const name = layerPath.split('/').pop();
    writeLayerStub(join(workspace, layerPath), { claudePlugin: name, withManifest: withManifests });
  }
  const ctx = { base, workspace, fixture: makeFixture(base, fixture), fakeCopilot: writeFakeCopilot(base), fakePi: writeFakePi(base) };
  if (fixture.npm) ctx.env = environmentWithNpm(writeFakeNpm(base));
  return ctx;
}

// The repository layers.json with the pstack source pointed at the fixture, and an
// optional change applied to the manifest before it is written.
export function writeLayers(ctx, mutate = null) {
  const manifest = readJson(join(repoRoot, 'layers.json'));
  const pstack = manifest.layers.find((layer) => layer.name === 'pstack');
  pstack.source = { url: ctx.fixture.url, path: 'plugins/pstack', commit: ctx.fixture.commit, ref: 'test' };
  if (mutate) mutate(manifest);
  layersCounter += 1;
  const path = join(ctx.base, `layers-${layersCounter}.json`);
  writeFileSync(path, JSON.stringify(manifest));
  return path;
}

export function writeWorkspaceSettings(ctx, value) {
  writeFileSync(join(ctx.workspace, 'maxstack.settings.json'), JSON.stringify(value, null, 2));
}

export function layerNamed(manifest, name) {
  return manifest.layers.find((layer) => layer.name === name);
}

// The environment a test run gives the installer. MAXSTACK_TEST_MODE turns on the test seam, which lets the fixtures'
// file remotes be read, so every installer run in these tests sets it. A test of the unset seam builds its own env.
export function testEnvironment(base) {
  return { ...(base ?? process.env), MAXSTACK_TEST_MODE: '1' };
}

// Runs the installer. Copilot and Pi are the stand-ins unless the caller names their command.
export function runInstaller(shell, ctx, extra = [], { apply = true, layersFile = writeLayers(ctx), env = undefined, installerPath = installer } = {}) {
  const copilot = extra.includes('-CopilotCommand') ? [] : ['-CopilotCommand', ctx.fakeCopilot];
  const pi = extra.includes('-PiCommand') ? [] : ['-PiCommand', ctx.fakePi];
  const args = [
    '-NoProfile', '-NonInteractive', '-File', installerPath,
    '-Workspace', ctx.workspace,
    ...(layersFile ? ['-LayersFile', layersFile] : []),
    ...copilot,
    ...pi,
    ...(apply ? ['-Apply'] : []),
    ...extra,
  ];
  return spawnSync(shell, args, { windowsHide: true, encoding: 'utf8', env: testEnvironment(env ?? ctx.env) });
}

export function runWorkspaceDiscovery(ctx, caseValue, { launchCwd = ctx.base, env = undefined } = {}) {
  const helper = join(repoRoot, 'scripts', 'Install-WorkspaceDiscovery.ps1').replaceAll("'", "''");
  const encoded = Buffer.from(JSON.stringify(caseValue)).toString('base64');
  const script = join(ctx.base, 'workspace-discovery.ps1');
  writeFileSync(script, `$ErrorActionPreference = 'Stop'\n$PSStyle.OutputRendering = 'PlainText'\n. '${helper}'\n$caseValue = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')) | ConvertFrom-Json -AsHashtable\ntry {\n  switch ($caseValue.kind) {\n    'explicit' { $result = Resolve-MaxstackWorkspace -ExplicitSpecified -ExplicitValue $caseValue.path }\n    'environment' { $result = Resolve-MaxstackWorkspace -ScriptRoot $caseValue.scriptRoot }\n    'scriptRoot' { $result = Resolve-MaxstackWorkspace -ScriptRoot $caseValue.path }\n    'currentDirectory' { $result = Resolve-MaxstackWorkspace -CurrentDirectory $caseValue.path -ScriptRoot $caseValue.scriptRoot }\n    'marker' { $result = Resolve-MaxstackWorkspace -CurrentDirectory $caseValue.path -ScriptRoot $caseValue.scriptRoot }\n    'legacy' { $result = Resolve-MaxstackWorkspace -ScriptRoot $caseValue.scriptRoot -LegacyWorkspace $caseValue.path }\n    'defaultCurrentDirectory' { $result = Resolve-MaxstackWorkspace -ExplicitSpecified -ExplicitValue $caseValue.path -ScriptRoot $caseValue.scriptRoot }\n  }\n  [Console]::Out.WriteLine("ORIGIN=$($result.Origin);WORKSPACE=$($result.Workspace)")\n} catch { [Console]::Out.WriteLine($_.Exception.Message); exit 2 }\n`);
  const childEnv = testEnvironment(env ?? process.env);
  for (const key of Object.keys(childEnv)) if (key.toUpperCase() === 'MAXSTACK_WORKSPACE') delete childEnv[key];
  if (caseValue.kind === 'environment') childEnv.MAXSTACK_WORKSPACE = caseValue.path;
  return spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', script], { windowsHide: true, encoding: 'utf8', cwd: launchCwd, env: childEnv });
}

// The installer of MAIN_COMMIT, extracted from git archive into a folder under base. Returns its path.
export function exportMainInstaller(base) {
  const archive = spawnSync('git', ['-C', repoRoot, 'archive', '--format=tar', MAIN_COMMIT], { windowsHide: true, maxBuffer: 512 * 1024 * 1024 });
  assert.equal(archive.status, 0, `git archive ${MAIN_COMMIT} failed: ${archive.stderr}`);
  const repo = join(base, 'upstream-main');
  mkdirSync(repo);
  const extracted = spawnSync('tar', ['-x', '-f', '-', '-C', repo], { windowsHide: true, input: archive.stdout });
  assert.equal(extracted.status, 0, `tar could not extract ${MAIN_COMMIT}: ${extracted.stderr}`);
  return join(repo, 'scripts', 'Install-Workspace.ps1');
}

export function clearInstallOutputs(workspace) {
  for (const path of ['.claude', '.opencode', '.maxstack', '.pi', 'opencode.jsonc', 'opencode.jsonc.bak', 'stack.lock.json', 'stack.lock.json.bak', 'stack.lock.json.new']) {
    rmSync(join(workspace, ...path.split('/')), { recursive: true, force: true });
  }
}

// A junction reports as a symbolic link to lstat.
export function isLink(path) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat ? stat.isSymbolicLink() : false;
}

export const shell = findShell();

export const skip = shell ? false : 'pwsh is not available';

export function findPython() {
  for (const name of ['python', 'python3']) {
    if (spawnSync(name, ['--version'], { windowsHide: true }).status === 0) return name;
  }
  return null;
}

export const python = findPython();

export function withWorkspace(name, body, options) {
  test(name, { skip }, () => {
    const ctx = buildWorkspace(options);
    try {
      body(ctx);
    } finally {
      rmSync(ctx.base, { recursive: true, force: true });
    }
  });
}

// A test that needs an external program. Without it the test is reported as skipped, with the program
// named as the reason, so a run on a machine without it cannot pass by doing nothing.
export function withWorkspaceNeeding(label, available, name, body, options) {
  const reason = skip || (available ? false : `${label} is not available`);
  test(name, { skip: reason }, () => {
    const ctx = buildWorkspace(options);
    try {
      body(ctx);
    } finally {
      rmSync(ctx.base, { recursive: true, force: true });
    }
  });
}

export function mustApply(ctx, extra = [], options = {}) {
  const run = runInstaller(shell, ctx, extra, options);
  assert.equal(run.status, 0, `installer exited ${run.status}\n${run.stdout}\n${run.stderr}`);
  return run;
}

// The no-settings comparisons run against upstream main before the settings slice. Its installer is extracted with
// git archive, so the commit must be in this checkout.
export const mainCommitAvailable = spawnSync('git', ['-C', repoRoot, 'cat-file', '-e', `${MAIN_COMMIT}^{commit}`], { windowsHide: true, stdio: 'ignore' }).status === 0;

// A test that compares with MAIN_COMMIT. Without the commit it is skipped locally, with the reason. In CI (CI=true) it
// fails instead, so a shallow checkout cannot pass by comparing nothing.
export function withMainCommit(name, body, options) {
  const reason = skip || (mainCommitAvailable || process.env.CI === 'true' ? false : `commit ${MAIN_COMMIT} is not in this checkout`);
  test(name, { skip: reason }, () => {
    assert.ok(mainCommitAvailable, `commit ${MAIN_COMMIT} is not in this checkout, so the comparison with upstream main cannot run. Fetch that commit and rerun.`);
    const ctx = buildWorkspace(options);
    try {
      body(ctx);
    } finally {
      rmSync(ctx.base, { recursive: true, force: true });
    }
  });
}

// The one line this slice adds to the output: the resolved target and its origin, printed first. A comparison removes
// that exact line from the new installer's output and nothing else. The main installer never prints it, so its output
// is compared as it is.
export function stripDiscoveryLine(output, workspace) {
  const expected = `Workspace: ${workspace} (from -Workspace)`;
  const first = /^([^\r\n]*)(\r?\n)/.exec(output);
  if (first && first[1] === expected) return output.slice(first[0].length);
  return output;
}

// The review findings. Each test names the finding it covers. The characters are written as escapes so this file holds no raw
// format character: ZWSP is U+200B, ZWJ is U+200D, SHY is U+00AD, and RLO is U+202E.
export const ZWSP = '\u200b';

export const ZWJ = '\u200d';

export const RLO = '\u202e';

export const escapedChar = (char) => `\\u${char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`;

export const lockText = (ctx) => readFileSync(lockPath(ctx), 'utf8');

// A checkout the -Source flag can name: a stub layer folder under the temp base, initialised as a git repository.
export function localCheckout(ctx, name, layer = 'simpsonm09-org-ai-plugin') {
  const checkout = join(ctx.base, name);
  writeLayerStub(checkout, { claudePlugin: layer });
  gitRun(checkout, ['init', '-q']);
  gitRun(checkout, ['add', '-A']);
  gitRun(checkout, ['commit', '-q', '-m', 'layer']);
  return checkout;
}

// The workspace-local Pi install: npm puts the bin of a Pi the workspace installed for itself under .maxstack\npm, and the
// installer finds it there before PATH. Each case runs with no Pi on PATH, through -PiCommand naming a missing command.
// A workspace for one test, removed afterwards whatever the outcome.
export function withFreshWorkspace(body) {
  const ctx = buildWorkspace();
  try {
    body(ctx);
  } finally {
    rmSync(ctx.base, { recursive: true, force: true });
  }
}

export const wrapperText = (ctx, name) => readFileSync(join(ctx.workspace, '.maxstack', 'bin', name), 'utf8');

// The lock without its timestamp, so two applies of the same workspace compare equal.
export function withoutTimestamp(lock) {
  const copy = { ...lock };
  delete copy.generatedAt;
  return copy;
}

// The ownership record and -Status. A status run reads the record and the disk, and writes
// nothing, so each test checks the files it could have changed.
export const lockPath = (ctx) => join(ctx.workspace, 'stack.lock.json');

export const settingsPath = (ctx) => join(ctx.workspace, '.pi', 'agent', 'settings.json');

export const verifyWorkspaceScript = join(repoRoot, 'scripts', 'verify-workspace-install.py');

export const verifyManifestsScript = join(repoRoot, 'scripts', 'verify-manifests.py');

export function runStatus(ctx, extra = []) {
  return runInstaller(shell, ctx, ['-Status', ...extra], { apply: false });
}

// The status report: one "<state> <label>" line per path, then a summary line.
export function statusRows(run) {
  return run.stdout
    .split(/\r?\n/)
    .map((line) => /^(matching|drifted|modified|missing|untracked|skipped)\s+(.+)$/.exec(line))
    .filter(Boolean)
    .map(([, state, label]) => ({ state, label: label.trim() }));
}

export function problemRows(run) {
  return statusRows(run).filter((row) => row.state !== 'matching');
}

// The pstack OpenCode entry is opencode/index.ts, so npm installs in opencode/ and writes its lock there. The
// pinned folder ships no lock, so an apply removes the one npm wrote, and the folder then matches its plan.
export const PSTACK_FOLDER = '.opencode/plugins/pstack';

export const PSTACK_NPM_FOLDER = `${PSTACK_FOLDER}/opencode`;

export const NPM = { fixture: { npm: true } };

export function workspacePath(ctx, rel) {
  return join(ctx.workspace, ...rel.split('/'));
}

// Round two: the ownership record is a claim about the disk, so each test below checks one claim
// against a value this file computes itself, never against the installer's own output.
export function sha256Upper(bytes) {
  return createHash('sha256').update(bytes).digest('hex').toUpperCase();
}

export function sortUtf8(lines) {
  return [...lines].sort((a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
}

export function linkTargetText(path) {
  let target = readlinkSync(path);
  for (const prefix of ['\\\\?\\', '\\??\\']) {
    if (target.startsWith(prefix)) target = target.slice(prefix.length);
  }
  return target.replace(/\\+$/, '');
}

// A tree hash computed here. Owned: node_modules and .git are left out at any depth. Legacy: only a
// top-level node_modules, without regard to case, is left out. Links are listed, never followed.
export function independentSha(root, rule) {
  const lines = [];
  collectTreeLines(root, '', rule, lines);
  return sha256Upper(Buffer.from(sortUtf8(lines).map((line) => `${line}\n`).join(''), 'utf8'));
}

// Whether a folder is left out of the hash: by its name alone under the owned rule, and only at the
// top of the tree under the legacy rule.
export function isLeftOut(name, prefix, rule) {
  if (rule === 'owned') return name === 'node_modules' || name === '.git';
  return prefix === '' && name.toLowerCase() === 'node_modules';
}

// The lines of one folder's entries, recursing into the folders that are not left out.
export function collectTreeLines(dir, prefix, rule, lines) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const relative = prefix === '' ? name : `${prefix}/${name}`;
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      lines.push(`${relative}\tlink:${linkTargetText(full)}`);
    } else if (stat.isDirectory()) {
      if (!isLeftOut(name, prefix, rule)) collectTreeLines(full, relative, rule, lines);
    } else {
      lines.push(`${relative}\t${sha256Upper(readFileSync(full))}`);
    }
  }
}

export function ownedRecord(lock, path, kind, key = '') {
  return lock.owned.find((record) => record.path === path && record.kind === kind && (record.key ?? '') === key);
}

export const ORG_FOLDER = '.opencode/plugins/simpsonm09-org-ai-plugin';

export const ORG_SOURCE = 'projects/repos/simpsonm09-org-ai-plugin';

// The runtime and layer selection. The selection is recorded in stack.lock.json, and each test reads
// the lock and the tree the apply wrote.
export const ALL_RUNTIMES = ['claude', 'copilot', 'opencode', 'pi'];

// Every file under the workspace, keyed by its path with forward slashes, with its bytes. The lock is
// left out, because each apply rewrites it, and the git cache is left out, because a sync re-reads it
// rather than writing an output of a runtime.
export function workspaceFiles(workspace) {
  const files = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = relative(workspace, full).replaceAll('\\', '/');
      if (rel === 'stack.lock.json' || rel === '.claude/cache') continue;
      // A junction is listed by its target, because reading it would read the folder it points to.
      if (entry.isSymbolicLink()) files.set(rel, Buffer.from(`link:${readlinkSync(full)}`));
      else if (entry.isDirectory()) walk(full);
      else files.set(rel, readFileSync(full));
    }
  };
  walk(workspace);
  return files;
}

export function selectionOf(ctx) {
  return readJson(lockPath(ctx)).selection;
}

export const USER_CONFIG = '{\n  "username": "user"\n}\n';

export const USER_SETTINGS = '{\n  "defaultProvider": "user-provider",\n  "packages": [\n    "user-package"\n  ]\n}\n';

// The user's own files: a config and a Pi settings file with a user key and a user entry, and a note in a folder
// the installer never writes. An install must leave each of them exactly as it was.
export function seedUserFiles(ctx) {
  writeFile(ctx.workspace, 'opencode.jsonc', USER_CONFIG);
  writeFile(ctx.workspace, '.pi/agent/settings.json', USER_SETTINGS);
  writeFile(ctx.workspace, 'notes/todo.txt', 'mine\n');
}

// Every entry under root, by relative path: a file with its bytes, a folder, or a link with its target. A link is
// listed, never followed. The git metadata of a pinned cache is left out, as the owned hash leaves it out, and the
// lock's generatedAt is left out, because it is the one field that changes on every apply.
export function snapshotTree(root, options = {}) {
  const entries = new Map();
  collectSnapshot(root, '', entries, options);
  return entries;
}

export function collectSnapshot(dir, prefix, entries, options) {
  for (const name of readdirSync(dir).sort()) {
    const rel = prefix === '' ? name : `${prefix}/${name}`;
    if (options.skipLockBackup && rel === 'stack.lock.json.bak') continue;
    const full = join(dir, name);
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) {
      entries.set(rel, `link:${linkTargetText(full)}`);
    } else if (stat.isDirectory()) {
      if (options.skipGit && name === '.git') continue;
      entries.set(rel, 'dir');
      collectSnapshot(full, rel, entries, options);
    } else {
      entries.set(rel, `file:${snapshotBytes(full, rel)}`);
    }
  }
}

export function snapshotBytes(full, rel) {
  const bytes = readFileSync(full);
  if (rel !== 'stack.lock.json') return bytes.toString('base64');
  const lock = JSON.parse(bytes.toString('utf8'));
  delete lock.generatedAt;
  return Buffer.from(JSON.stringify(lock)).toString('base64');
}

// The links under root that no longer resolve.
export function danglingLinks(root) {
  return [...snapshotTree(root).entries()]
    .filter(([rel, value]) => value.startsWith('link:') && !existsSync(join(root, rel)))
    .map(([rel]) => rel);
}

// A removal run: -Apply is added unless apply is false, so a test states the dry run it means.
export function removal(ctx, args, { apply = true } = {}) {
  return runInstaller(shell, ctx, [...args, ...(apply ? ['-Apply'] : [])], { apply: false });
}

export function assertOk(run) {
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
}

export function setLock(ctx, lock) {
  writeFileSync(lockPath(ctx), JSON.stringify(lock));
}

// Runs one removal with a fault in MAXSTACK_TEST_HOOK, and clears it again.
export function withHook(hook, body) {
  process.env.MAXSTACK_TEST_HOOK = hook;
  try {
    return body();
  } finally {
    delete process.env.MAXSTACK_TEST_HOOK;
  }
}

export function ORG_FOLDER_FULL(ctx) {
  return join(ctx.workspace, ...ORG_FOLDER.split('/'));
}

// Review 2, item 4: real schema-1 locks. scripts/fixtures/schema1 holds the stack.lock.json, the config, and the Pi
// settings that the pre-branch installer (28872d2) wrote in two workspaces, with the machine path replaced by a placeholder
// and every recorded hash recomputed for the normalised bytes. Each file carries a .fixture suffix, so the linters skip it
// and its bytes are read exactly as they were written.
export const SCHEMA1 = join(repoRoot, 'scripts', 'fixtures', 'schema1');

export function seedSchema1(ctx, name, files) {
  for (const [rel, fixtureFile] of files) writeFile(ctx.workspace, rel, readFileSync(join(SCHEMA1, name, `${fixtureFile}.fixture`)));
  writeFile(ctx.workspace, 'stack.lock.json', readFileSync(join(SCHEMA1, name, 'stack.lock.json.fixture')));
}

// ---- Layer sources: -Source, the -LayerSource alias, and the recorded override -----------------------------------
// A git command in a folder. A failing command fails the test, so a fixture that did not build is never a result.
export function gitRun(dir, args) {
  const run = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { windowsHide: true, cwd: dir, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')} failed: ${run.stderr}`);
  return run.stdout.trim();
}

// The test stand-in for github.com. MAXSTACK_TEST_GITHUB_ROOT names the folder, and owner/repo resolves to
// <root>/<owner>/<repo>.git. GIT_TERMINAL_PROMPT stops git from waiting for a credential.
export function githubEnv(ctx) {
  return { ...process.env, MAXSTACK_TEST_GITHUB_ROOT: join(ctx.base, 'github'), GIT_TERMINAL_PROMPT: '0' };
}

export function remoteUrl(ctx, owner, repo) {
  return join(ctx.base, 'github', owner, `${repo}.git`).replace(/\\/g, '/');
}

// Serves a copy of a repository as <owner>/<repo>.git under the test GitHub root, and returns the bare path.
export function serveRepo(ctx, owner, repo, sourceDir) {
  const bare = join(ctx.base, 'github', owner, `${repo}.git`);
  mkdirSync(dirname(bare), { recursive: true });
  gitRun(ctx.base, ['clone', '--bare', '--quiet', sourceDir, bare]);
  gitRun(bare, ['config', 'uploadpack.allowFilter', 'true']);
  gitRun(bare, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  return bare;
}

// Commits one file on a branch of a served repository, starting from the branch or from the default branch, and
// pushes it there. Returns the new commit.
export function commitToBranch(ctx, bare, branch, relPath, content) {
  const work = join(ctx.base, 'work');
  if (!existsSync(work)) gitRun(ctx.base, ['clone', '--quiet', bare, work]);
  gitRun(work, ['fetch', '--quiet', 'origin']);
  const hasBranch = spawnSync('git', ['-C', bare, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { windowsHide: true }).status === 0;
  gitRun(work, ['checkout', '-q', '-B', branch, hasBranch ? `origin/${branch}` : 'origin/HEAD']);
  writeFile(work, relPath, content);
  gitRun(work, ['add', '-A']);
  gitRun(work, ['commit', '-q', '-m', `change on ${branch}`]);
  gitRun(work, ['push', '-q', 'origin', branch]);
  return gitRun(work, ['rev-parse', 'HEAD']);
}

export const SKILL_PATH = 'plugins/pstack/skills/poteto-mode/SKILL.md';

export const SKILL_FEAT = '---\nname: poteto-mode\ndescription: fixture\n---\nfeat body\n';

export const installedSkill = (ctx) => join(ctx.workspace, '.opencode', 'plugins', 'pstack', 'skills', 'poteto-mode', 'SKILL.md');

// pstack served as simpsonm09/pstack-claude, with a feat branch that changes its skill.
export function servedFeature(ctx) {
  const bare = serveRepo(ctx, 'simpsonm09', 'pstack-claude', ctx.fixture.dir);
  const featCommit = commitToBranch(ctx, bare, 'feat', SKILL_PATH, SKILL_FEAT);
  return { bare, featCommit };
}

export function sourceOf(ctx, name) {
  const record = readJson(lockPath(ctx)).layers.find((layer) => layer.name === name);
  assert.ok(record, `the lock has no record for ${name}`);
  return record;
}

// The layer-source block: -Status and an audit name every override, every local source, and no pin that holds.
export const STATE_ROW = /^(matching|drifted|modified|missing|untracked|not selected)\s/;

// The lines between the block's header and the first state row, or none when the block is absent.
export function sourceBlockOf(stdout) {
  const lines = stdout.split(/\r?\n/);
  const header = lines.indexOf('Layer sources not at their committed pin:');
  if (header < 0) return null;
  const firstState = lines.findIndex((line, index) => index > header && STATE_ROW.test(line));
  return { header, lines: lines.slice(header + 1, firstState < 0 ? undefined : firstState), firstState };
}

// -Update: a branch or tag override moves to its current commit, a commit pin and a default pin do not, and a local
// source is re-read. A check writes nothing. A failed resolve leaves the install as it was.
export const SKILL_FEAT_TWO = '---\nname: poteto-mode\ndescription: fixture\n---\nfeat body two\n';

// Moves the feat branch on the served repository to a new commit, which the workspace has not fetched.
export function moveFeat(ctx, bare) {
  return commitToBranch(ctx, bare, 'feat', SKILL_PATH, SKILL_FEAT_TWO);
}

// Finding 5: the owner/repo shorthand reads a local folder only in a test run, and only for a folder under the temp folder.
// These call the resolver in a child that dot-sources the module, so nothing here reaches the network.
export const layerSourcesFile = join(repoRoot, 'scripts', 'Install-LayerSources.ps1');

export const SHORTHAND_URL = 'https://github.com/simpsonm09/pstack-claude.git';

export function resolveShorthand(env) {
  const script = `. '${layerSourcesFile}'; Get-GitHubRemoteUrl -Owner 'simpsonm09' -Repo 'pstack-claude'`;
  return spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', env });
}

export function sourceBlockIn(lock, name) {
  return lock.layers.find((layer) => layer.name === name).source;
}

// Review items N1 to N10 of c2d0d54. Each test names the item it covers, and each fails before its fix.
// The 8.3 name of an existing folder, as the filesystem reports it, or null when the folder cannot be read.
export const shortPathOf = (path) => {
  const script = `(New-Object -ComObject Scripting.FileSystemObject).GetFolder('${path.replaceAll("'", "''")}').ShortPath`;
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8' });
  return run.status === 0 ? run.stdout.trim() : null;
};

// Whether this volume generates 8.3 names for a new folder. A volume with generation off skips the 8.3 tests with that reason.
export const EXISTING_LONG_FOLDER = process.env.ProgramFiles ?? 'C:\\Program Files';

export const EXISTING_SHORT_FOLDER = shortPathOf(EXISTING_LONG_FOLDER);

export const short83Available = Boolean(EXISTING_SHORT_FOLDER) && EXISTING_SHORT_FOLDER !== EXISTING_LONG_FOLDER && /~\d/.test(EXISTING_SHORT_FOLDER.split(/[\\/]/).pop());
