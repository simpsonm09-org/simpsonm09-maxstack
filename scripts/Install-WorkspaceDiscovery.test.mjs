#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const helper = join(repoRoot, 'scripts', 'Install-WorkspaceDiscovery.ps1');
const installer = join(repoRoot, 'scripts', 'Install-Workspace.ps1');
const shell = spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).status === 0 ? 'pwsh' : null;
function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'maxstack-discovery-'));
}

function directory(root, rel) {
  const path = join(root, ...rel.split('/'));
  mkdirSync(path, { recursive: true });
  return path;
}

function marker(root, file = 'stack.lock.json') {
  writeFileSync(join(root, file), '{}');
  return root;
}

function invoke(options = {}) {
  const complete = {
    explicitSpecified: false,
    explicitValue: '',
    cwd: process.cwd(),
    scriptRoot: join(tmpdir(), 'maxstack-no-layout', 'scripts'),
    ...options,
  };
  const encodedOptions = Buffer.from(JSON.stringify(complete), 'utf8').toString('base64');
  const locationSetup = complete.nonFilesystem ? 'Set-Location Env:; ' : '';
  const command = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; ${locationSetup}$o = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedOptions}')) | ConvertFrom-Json -AsHashtable; . '${helper.replaceAll("'", "''")}'; ${complete.prelude ?? ''} try { $r = Resolve-MaxstackWorkspace -ExplicitSpecified:$o.explicitSpecified -ExplicitValue $o.explicitValue -CurrentDirectory $o.cwd -ScriptRoot $o.scriptRoot; [ordered]@{workspace=$r.Workspace; origin=$r.Origin; warning=$r.Warning; note=$(if ($r.PSObject.Properties.Name -contains 'Note') { $r.Note } else { $null })} | ConvertTo-Json -Compress } catch { Write-Error $_; exit 23 }`;
  const env = { ...process.env };
  if (Object.hasOwn(options, 'envWorkspace')) env.MAXSTACK_WORKSPACE = options.envWorkspace;
  else delete env.MAXSTACK_WORKSPACE;
  return spawnSync(shell, ['-NoProfile', '-Command', command], { cwd: options.spawnCwd ?? options.cwd, env, encoding: 'utf8', windowsHide: true });
}

function resolveCase(options, expectedPath, expectedOrigin) {
  const run = invoke(options);
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.workspace.toLowerCase(), resolve(expectedPath).toLowerCase());
  assert.equal(result.origin, expectedOrigin);
  return result;
}

function withRoot(run) {
  const root = makeRoot();
  try {
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('workspace discovery requires PowerShell 7', { skip: !shell }, () => {
  assert.ok(existsSync(helper));
});

test('explicit path wins over environment, cwd marker, and script layout', { skip: !shell }, () => withRoot((root) => {
  const explicit = marker(directory(root, 'explicit'));
  const env = marker(directory(root, 'env'));
  const cwd = marker(directory(root, 'cwd'));
  const layout = marker(directory(root, 'layout'));
  resolveCase({ explicitSpecified: true, explicitValue: explicit, envWorkspace: env, cwd, scriptRoot: join(layout, 'projects/repos/repo/scripts') }, explicit, '-Workspace');
}));

test('environment wins over cwd marker and script layout', { skip: !shell }, () => withRoot((root) => {
  const env = marker(directory(root, 'env'));
  const cwd = marker(directory(root, 'cwd'));
  const layout = marker(directory(root, 'layout'));
  resolveCase({ envWorkspace: env, cwd, scriptRoot: join(layout, 'projects/repos/repo/scripts') }, env, 'MAXSTACK_WORKSPACE');
}));

test('a marker that is a symbolic link is not read, and the walk goes on to the next marker', { skip: !shell }, (t) => withRoot((root) => {
  const outer = directory(root, 'outer');
  marker(outer);
  const nearest = directory(outer, 'child');
  const markerTarget = join(root, 'marker-target.json');
  writeFileSync(markerTarget, '{}');
  try {
    symlinkSync(markerTarget, join(nearest, 'maxstack.settings.json'), 'file');
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('Windows symlink privilege is unavailable in this environment.');
      return;
    }
    throw error;
  }
  const layout = marker(directory(root, 'layout'));
  resolveCase({ cwd: directory(nearest, 'nested'), scriptRoot: join(layout, 'projects/worktrees/repo/scripts') }, outer, 'cwd marker stack.lock.json');
}));

test('script layout resolves exact repos and worktrees segments', { skip: !shell }, () => withRoot((root) => {
  for (const layoutName of ['repos', 'worktrees']) {
    const workspace = directory(root, layoutName);
    const scriptRoot = directory(workspace, `projects/${layoutName}/repo/scripts`);
    const cwd = directory(root, `outside-${layoutName}`);
    const result = resolveCase({ cwd, scriptRoot }, workspace, 'script layout');
    assert.equal(result.warning, false);
  }
}));

test('cwd marker beats script layout; unrelated script paths do not match layout', { skip: !shell }, () => withRoot((root) => {
  const cwdWorkspace = marker(directory(root, 'cwd-workspace'));
  const layoutWorkspace = directory(root, 'layout-workspace');
  const layoutRoot = directory(layoutWorkspace, 'projects/repos/repo/scripts');
  resolveCase({ cwd: directory(cwdWorkspace, 'child'), scriptRoot: layoutRoot }, cwdWorkspace, 'cwd marker stack.lock.json');
  const badScript = directory(root, 'a/b/c/repo/scripts');
  resolveFails({ cwd: directory(root, 'outside'), scriptRoot: badScript }, 'Workspace discovery failed');
}));

test('relative explicit and environment paths resolve against filesystem cwd', { skip: !shell }, () => withRoot((root) => {
  const cwd = directory(root, 'base');
  const explicit = marker(directory(cwd, 'explicit'));
  resolveCase({ explicitSpecified: true, explicitValue: 'explicit', cwd }, explicit, '-Workspace');
  const env = marker(directory(cwd, 'environment'));
  resolveCase({ envWorkspace: 'environment', cwd }, env, 'MAXSTACK_WORKSPACE');
}));

test('explicit path matching is case-insensitive on Windows and keeps the case given', { skip: !shell }, () => withRoot((root) => {
  const target = marker(directory(root, 'CaseSensitiveName'));
  const alternateCase = target.replace('CaseSensitiveName', 'casesensitivename');
  const result = resolveCase({ explicitSpecified: true, explicitValue: alternateCase, cwd: root }, target, '-Workspace');
  assert.ok(result.workspace.endsWith('casesensitivename'));
}));

test('successful installer runs print the resolved workspace before argument validation', { skip: !shell }, () => withRoot((root) => {
  const target = directory(root, 'target');
  const env = { ...process.env };
  delete env.MAXSTACK_WORKSPACE;
  const run = spawnSync(shell, ['-NoProfile', '-File', installer, '-Workspace', target, '-Apply', '-Status'], {
    cwd: root,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.notEqual(run.status, 0);
  assert.equal(run.stdout.split(/\r?\n/)[0], `Workspace: ${target} (from -Workspace)`);
  assert.match(run.stderr, /Choose one/);
  assert.deepEqual(readdirSync(target), []);
}));

test('explicit empty and invalid environment targets fail without falling through', { skip: !shell }, () => withRoot((root) => {
  const cwd = marker(directory(root, 'cwd'));
  const scriptRoot = directory(root, 'layout/projects/repos/repo/scripts');
  const runExplicit = invoke({ explicitSpecified: true, explicitValue: ' ', cwd, scriptRoot });
  assert.equal(runExplicit.status, 23);
  assert.match(runExplicit.stderr, /-Workspace was explicitly supplied but is empty/);
  const runEnv = invoke({ envWorkspace: join(root, 'missing'), cwd, scriptRoot });
  assert.equal(runEnv.status, 23);
  assert.match(runEnv.stderr, /MAXSTACK_WORKSPACE target does not exist/);
  const runEmptyEnv = invoke({ envWorkspace: '', cwd, scriptRoot });
  assert.equal(runEmptyEnv.status, 23);
  assert.match(runEmptyEnv.stderr, /MAXSTACK_WORKSPACE is set but empty/);
}));

test('a non-filesystem current location without a script layout refuses discovery', { skip: !shell }, () => withRoot((root) => {
  resolveFails({ nonFilesystem: true, cwd: root, scriptRoot: join(root, 'no-layout', 'scripts') }, 'Workspace discovery failed');
}));

test('missing explicit target fails instead of using a marker or layout', { skip: !shell }, () => withRoot((root) => {
  const cwd = marker(directory(root, 'cwd'));
  const scriptRoot = directory(root, 'layout/projects/worktrees/repo/scripts');
  const run = invoke({ explicitSpecified: true, explicitValue: join(root, 'typo'), cwd, scriptRoot });
  assert.equal(run.status, 23);
  assert.match(run.stderr, /-Workspace target does not exist/);
}));

test('finding F11: missing workspace reports all four discovery sources', { skip: !shell }, () => withRoot((root) => {
  const cwd = directory(root, 'cwd');
  const scriptRoot = directory(root, 'no/matching/layout/repo/scripts');
  const run = invoke({ cwd, scriptRoot });
  assert.equal(run.status, 23);
  assert.match(run.stderr, /MAXSTACK_WORKSPACE/);
  assert.match(run.stderr, /cwd marker/);
  assert.match(run.stderr, /script layout/);
  assert.match(run.stderr, /-Workspace/);
}));

// A run that the discovery must refuse: exit 23 and the named message on stderr.
function assertRefused(options, pattern, label) {
  const run = invoke(options);
  assert.equal(run.status, 23, `${label}: ${run.stdout}${run.stderr}`);
  assert.match(run.stderr, pattern, label);
  return run;
}

test('a trailing separator on an explicit or environment path names the folder without it', { skip: !shell }, () => withRoot((root) => {
  const target = marker(directory(root, 'trailing'));
  resolveCase({ explicitSpecified: true, explicitValue: `${target}\\`, cwd: root }, target, '-Workspace');
  resolveCase({ envWorkspace: `${target}/`, cwd: root }, target, 'MAXSTACK_WORKSPACE');
}));

test('a device path prefix is refused before any path lookup', { skip: !shell }, () => withRoot((root) => {
  for (const value of ['\\\\?\\C:\\maxstack-missing', '\\\\.\\C:\\maxstack-missing', '//?/C:/maxstack-missing', '\\\\?\\UNC\\server\\share\\ws']) {
    assertRefused({ explicitSpecified: true, explicitValue: value, cwd: root }, /-Workspace path uses a device prefix/, `-Workspace ${value}`);
    assertRefused({ envWorkspace: value, cwd: root }, /MAXSTACK_WORKSPACE path uses a device prefix/, `MAXSTACK_WORKSPACE ${value}`);
  }
}));

test('a UNC path is refused by its text, so no share is looked up', { skip: !shell }, () => withRoot((root) => {
  assertRefused({ explicitSpecified: true, explicitValue: '\\\\maxstack-no-host\\share\\ws', cwd: root }, /-Workspace path is a UNC path/, '-Workspace UNC');
  assertRefused({ envWorkspace: '//maxstack-no-host/share/ws', cwd: root }, /MAXSTACK_WORKSPACE path is a UNC path/, 'MAXSTACK_WORKSPACE UNC');
}));

test('an 8.3 short name is refused in an explicit or environment path', { skip: !shell }, () => withRoot((root) => {
  assertRefused({ explicitSpecified: true, explicitValue: join(root, 'PROGRA~1', 'ws'), cwd: root }, /-Workspace path has an 8\.3 short name \(PROGRA~1\)/, '-Workspace 8.3');
  assertRefused({ envWorkspace: join(root, 'PROGRA~1', 'ws'), cwd: root }, /MAXSTACK_WORKSPACE path has an 8\.3 short name/, 'MAXSTACK_WORKSPACE 8.3');
  const shortCwd = directory(root, 'LONGER~1/child');
  resolveFails({ cwd: shortCwd, scriptRoot: join(root, 'no-layout', 'scripts') }, 'Workspace discovery failed');
}));

test('a C1 control character is refused and shown as an escape, never echoed raw', { skip: !shell }, () => withRoot((root) => {
  const c1 = String.fromCharCode(0x9b);
  const run = assertRefused({ explicitSpecified: true, explicitValue: join(root, `bad${c1}name`), cwd: root }, /-Workspace path contains control characters/, 'C1');
  assert.ok(run.stderr.includes('\\u009B'), run.stderr);
  assert.equal(run.stderr.includes(c1), false, 'the raw C1 byte reached stderr');
}));

test('a directory named like a marker is not a marker, and the walk continues to the real one', { skip: !shell }, () => withRoot((root) => {
  const workspace = marker(directory(root, 'workspace'));
  const child = directory(workspace, 'child');
  mkdirSync(join(child, 'stack.lock.json'));
  resolveCase({ cwd: child }, workspace, 'cwd marker stack.lock.json');
}));

test('two real markers at different depths: the nearest wins, and in one folder the settings file is named first', { skip: !shell }, () => withRoot((root) => {
  const outer = marker(directory(root, 'outer'), 'stack.lock.json');
  const inner = marker(directory(outer, 'inner'), 'maxstack.settings.json');
  resolveCase({ cwd: directory(inner, 'deep/er') }, inner, 'cwd marker maxstack.settings.json');
  const both = directory(root, 'both');
  marker(both, 'stack.lock.json');
  marker(both, 'maxstack.settings.json');
  resolveCase({ cwd: both }, both, 'cwd marker maxstack.settings.json');
}));

test('a marker reached through a junction keeps the path the walk reached, as upstream main does', { skip: !shell }, () => withRoot((root) => {
  const target = marker(directory(root, 'real-target'));
  const link = join(root, 'link');
  symlinkSync(target, link, 'junction');
  resolveCase({ cwd: directory(link, 'child') }, link, 'cwd marker stack.lock.json');
}));

test('an explicit target that is a junction keeps the given path; the resolved folder is only checked', { skip: !shell }, () => withRoot((root) => {
  const target = marker(directory(root, 'real-target'));
  const link = join(root, 'link');
  symlinkSync(target, link, 'junction');
  resolveCase({ explicitSpecified: true, explicitValue: link, cwd: root }, link, '-Workspace');
}));

test('a junction whose target is missing is refused as a missing target', { skip: !shell }, () => withRoot((root) => {
  const link = join(root, 'dangling');
  symlinkSync(join(root, 'no-such-target'), link, 'junction');
  assertRefused({ explicitSpecified: true, explicitValue: link, cwd: root }, /-Workspace target does not exist or is not a directory/, 'dangling junction');
}));

test('a .git folder is never a workspace: an explicit target inside it is refused, and the walk skips it', { skip: !shell }, () => withRoot((root) => {
  const workspace = marker(directory(root, 'workspace'));
  marker(directory(workspace, '.git'));
  assertRefused({ explicitSpecified: true, explicitValue: join(workspace, '.git'), cwd: root }, /-Workspace target is inside a git directory/, 'explicit .git');
  resolveCase({ cwd: directory(workspace, '.git/hooks') }, workspace, 'cwd marker stack.lock.json');
}));

test('a layer cache clone is never a workspace target, and the walk skips it', { skip: !shell }, () => withRoot((root) => {
  const workspace = marker(directory(root, 'workspace'));
  const clone = marker(directory(workspace, '.claude/cache/pstack'));
  assertRefused({ envWorkspace: clone, cwd: root }, /MAXSTACK_WORKSPACE target is inside a git directory, a layer checkout, or a layer cache/, 'env cache clone');
  resolveCase({ cwd: directory(clone, 'plugins/pstack') }, workspace, 'cwd marker stack.lock.json');
}));

test('a checkout under projects\\repos or projects\\worktrees is never a workspace target, and the walk skips it', { skip: !shell }, () => withRoot((root) => {
  const workspace = marker(directory(root, 'workspace'));
  const checkout = marker(directory(workspace, 'projects/repos/layer'));
  assertRefused({ explicitSpecified: true, explicitValue: checkout, cwd: root }, /-Workspace target is inside a git directory, a layer checkout, or a layer cache/, 'explicit checkout');
  resolveCase({ cwd: directory(checkout, 'src') }, workspace, 'cwd marker stack.lock.json');
}));

test('a script layout that lands inside a layer checkout is not a workspace and discovery refuses', { skip: !shell }, () => withRoot((root) => {
  const scriptRoot = directory(root, 'X/projects/repos/A/projects/repos/B/scripts');
  resolveFails({ cwd: directory(root, 'outside'), scriptRoot }, 'Workspace discovery failed');
}));

test('a script root at a drive root is not a layout, and the check does not fail', { skip: !shell }, () => withRoot((root) => {
  const drive = parse(root).root;
  resolveFails({ cwd: directory(root, 'outside'), scriptRoot: join(drive, 'scripts') }, 'Workspace discovery failed');
}));

test('a relative environment path with dot segments resolves from the current directory', { skip: !shell }, () => withRoot((root) => {
  const base = directory(root, 'base');
  const sibling = marker(directory(root, 'sibling'));
  resolveCase({ envWorkspace: '..\\sibling', cwd: base }, sibling, 'MAXSTACK_WORKSPACE');
}));

test('an explicit target that is a file is refused as not a directory', { skip: !shell }, () => withRoot((root) => {
  const file = join(root, 'not-a-folder.json');
  writeFileSync(file, '{}');
  assertRefused({ explicitSpecified: true, explicitValue: file, cwd: root }, /-Workspace target does not exist or is not a directory/, 'file target');
}));

test('a missing target stops -Status, -Update -Check, and an apply, names the origin, and creates nothing', { skip: !shell }, () => withRoot((root) => {
  const target = join(root, 'missing-target');
  const env = { ...process.env };
  delete env.MAXSTACK_WORKSPACE;
  for (const extra of [['-Status'], ['-Update', '-Check'], ['-Apply']]) {
    const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', installer, '-Workspace', target, ...extra], { windowsHide: true, encoding: 'utf8', cwd: root, env });
    assert.notEqual(run.status, 0, `${extra.join(' ')} accepted a missing target`);
    assert.match(`${run.stdout}${run.stderr}`, /-Workspace target does not exist or is not a directory/, extra.join(' '));
    assert.equal(existsSync(target), false, `${extra.join(' ')} created the missing workspace`);
  }
}));

// Runs the installer's read-only audit from a folder, with -Workspace only when given. The first output line names the target.
function runInstallerAudit(root, { cwd, workspaceArgs = [], env = {} }) {
  const childEnv = { ...process.env };
  delete childEnv.MAXSTACK_WORKSPACE;
  Object.assign(childEnv, env);
  return spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', installer, ...workspaceArgs, '-Status'], { windowsHide: true, encoding: 'utf8', cwd: cwd ?? root, env: childEnv });
}

test('the installer uses MAXSTACK_WORKSPACE without -Workspace, names that origin, and never reads the current directory marker', { skip: !shell }, () => withRoot((root) => {
  const fromEnvironment = marker(directory(root, 'environment'));
  const cwd = marker(directory(root, 'cwd'));
  const run = runInstallerAudit(root, { cwd, env: { MAXSTACK_WORKSPACE: fromEnvironment } });
  assert.equal(run.stdout.split(/\r?\n/)[0], `Workspace: ${fromEnvironment} (from MAXSTACK_WORKSPACE)`, run.stdout + run.stderr);
}));

test('the installer prefers -Workspace to MAXSTACK_WORKSPACE and names the explicit origin', { skip: !shell }, () => withRoot((root) => {
  const explicit = marker(directory(root, 'explicit'));
  const fromEnvironment = marker(directory(root, 'environment'));
  const run = runInstallerAudit(root, { cwd: root, workspaceArgs: ['-Workspace', explicit], env: { MAXSTACK_WORKSPACE: fromEnvironment } });
  assert.equal(run.stdout.split(/\r?\n/)[0], `Workspace: ${explicit} (from -Workspace)`, run.stdout + run.stderr);
}));

test('the installer walks from the current directory to a marker when neither flag nor environment names a target', { skip: !shell }, () => withRoot((root) => {
  const workspace = marker(directory(root, 'workspace'));
  const run = runInstallerAudit(root, { cwd: directory(workspace, 'nested') });
  assert.equal(run.stdout.split(/\r?\n/)[0], `Workspace: ${workspace} (from cwd marker stack.lock.json)`, run.stdout + run.stderr);
}));

test('unconfigured discovery refuses instead of selecting an implicit default', { skip: !shell }, () => withRoot((root) => {
  resolveFails({ cwd: directory(root, 'outside'), scriptRoot: join(root, 'no-layout', 'scripts') }, 'Workspace discovery failed');
}));

// A run that must find no workspace: exit 23 and the named message.
function resolveFails(options, message) {
  const run = invoke(options);
  assert.equal(run.status, 23, `${run.stdout}${run.stderr}`);
  assert.match(run.stderr, new RegExp(message));
  return run;
}

// A maxstack checkout as this repository ships it: scripts/Install-Workspace.ps1, layers.json, and a workspace folder
// that carries the seed settings file and the tracked config. Nothing here is a real workspace.
function makeCheckout(parent, name) {
  const clone = directory(parent, name);
  directory(clone, 'scripts');
  writeFileSync(join(clone, 'scripts', 'Install-Workspace.ps1'), '');
  writeFileSync(join(clone, 'layers.json'), '{}');
  directory(clone, 'workspace');
  writeFileSync(join(clone, 'workspace', 'maxstack.settings.json'), '{}');
  writeFileSync(join(clone, 'workspace', 'opencode.jsonc'), '{}');
  return clone;
}

function snapshotFolder(folder) {
  const entries = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const info = statSync(path);
      entries.push(`${path.slice(folder.length)}|${entry.isDirectory() ? 'dir' : info.size}|${info.mtimeMs}`);
      if (entry.isDirectory()) walk(path);
    }
  };
  walk(folder);
  return entries.sort();
}

test('a maxstack checkout is not a workspace: the walk from its workspace folder skips it, and nothing resolves', { skip: !shell }, () => withRoot((root) => {
  const checkout = makeCheckout(root, 'clone');
  resolveFails({ cwd: join(checkout, 'workspace'), scriptRoot: join(checkout, 'scripts') }, 'Workspace discovery failed');
}));

test('a checkout found by the walk from another maxstack clone is skipped too', { skip: !shell }, () => withRoot((root) => {
  const running = makeCheckout(root, 'running');
  const foreign = makeCheckout(root, 'foreign');
  resolveFails({ cwd: join(foreign, 'workspace'), scriptRoot: join(running, 'scripts') }, 'Workspace discovery failed');
}));

test('an explicit or environment target that is a maxstack checkout is refused, and its workspace folder too', { skip: !shell }, () => withRoot((root) => {
  const checkout = makeCheckout(root, 'clone');
  const scriptRoot = join(checkout, 'scripts');
  for (const target of [checkout, join(checkout, 'workspace')]) {
    assertRefused({ explicitSpecified: true, explicitValue: target, cwd: root, scriptRoot }, /-Workspace target is a maxstack checkout, not a workspace/, `-Workspace ${target}`);
    assertRefused({ envWorkspace: target, cwd: root, scriptRoot }, /MAXSTACK_WORKSPACE target is a maxstack checkout, not a workspace/, `MAXSTACK_WORKSPACE ${target}`);
  }
}));

test('a no-flag apply from a checkout workspace folder writes nothing into the clone and fails', { skip: !shell }, () => withRoot((root) => {
  const clone = join(root, 'clone');
  mkdirSync(join(clone, 'scripts'), { recursive: true });
  cpSync(join(repoRoot, 'scripts'), join(clone, 'scripts'), { recursive: true });
  cpSync(join(repoRoot, 'workspace'), join(clone, 'workspace'), { recursive: true });
  const copy = join(clone, 'scripts', 'Install-Workspace.ps1');
  const before = snapshotFolder(clone);
  const env = { ...process.env };
  delete env.MAXSTACK_WORKSPACE;
  // An empty manifest keeps the run offline: the copied layers.json names a remote pstack source that must not be looked up.
  const emptyLayers = join(root, 'empty-layers.json');
  writeFileSync(emptyLayers, '{"layers":[]}');
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', copy, '-Apply', '-LayersFile', emptyLayers], { windowsHide: true, encoding: 'utf8', cwd: join(clone, 'workspace'), env });
  assert.notEqual(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.deepEqual(snapshotFolder(clone), before, 'a run from a checkout changed the checkout');
}));

test('a current directory with an 8.3 segment does not stop the script layout', { skip: !shell }, () => withRoot((root) => {
  const workspace = directory(root, 'ws');
  const scriptRoot = directory(workspace, 'projects/repos/repo/scripts');
  resolveCase({ cwd: directory(root, 'LONGER~1/child'), scriptRoot }, workspace, 'script layout');
}));

test('a walk started in an 8.3-named folder still finds the marker that is there', { skip: !shell }, () => withRoot((root) => {
  const workspace = marker(directory(root, 'LONGER~1/ws'));
  resolveCase({ cwd: directory(workspace, 'child'), scriptRoot: join(root, 'no-layout', 'scripts') }, workspace, 'cwd marker stack.lock.json');
}));

test('a literal folder whose name looks like an 8.3 short name is an accepted explicit target', { skip: !shell }, () => withRoot((root) => {
  for (const name of ['Q~1', 'ABCDEFGH~1']) {
    const target = marker(directory(root, name));
    resolveCase({ explicitSpecified: true, explicitValue: target, cwd: root }, target, '-Workspace');
  }
}));

test('a non-existent name with eight characters before the tilde is not a short name', { skip: !shell }, () => withRoot((root) => {
  const run = invoke({ explicitSpecified: true, explicitValue: join(root, 'ABCDEFGH~1'), cwd: root });
  assert.equal(run.status, 23, run.stdout + run.stderr);
  assert.match(run.stderr, /-Workspace target does not exist or is not a directory/);
  assert.doesNotMatch(run.stderr, /8\.3/);
}));

test('a script layout that names another workspace is noted when a marker wins, once and with both targets', { skip: !shell }, () => withRoot((root) => {
  const layoutWorkspace = marker(directory(root, 'layout-ws'));
  const scriptRoot = directory(layoutWorkspace, 'projects/repos/repo/scripts');
  const markerWorkspace = marker(directory(root, 'marker-ws'));
  const run = invoke({ cwd: directory(markerWorkspace, 'child'), scriptRoot });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.origin, 'cwd marker stack.lock.json');
  assert.equal(result.note, `script layout names ${layoutWorkspace}; using cwd marker stack.lock.json ${markerWorkspace}`);
}));

test('a script layout that names the same workspace as the environment target gives no note', { skip: !shell }, () => withRoot((root) => {
  const layoutWorkspace = marker(directory(root, 'layout-ws'));
  const scriptRoot = directory(layoutWorkspace, 'projects/repos/repo/scripts');
  const run = invoke({ envWorkspace: layoutWorkspace, cwd: root, scriptRoot });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.origin, 'MAXSTACK_WORKSPACE');
  assert.equal(result.note, null);
}));

test('an environment target that differs from the script layout is noted under its origin', { skip: !shell }, () => withRoot((root) => {
  const layoutWorkspace = marker(directory(root, 'layout-ws'));
  const scriptRoot = directory(layoutWorkspace, 'projects/repos/repo/scripts');
  const envWorkspace = marker(directory(root, 'env-ws'));
  const run = invoke({ envWorkspace, cwd: root, scriptRoot });
  const result = JSON.parse(run.stdout.trim());
  assert.equal(result.note, `script layout names ${layoutWorkspace}; using MAXSTACK_WORKSPACE ${envWorkspace}`);
}));

test('a drive root is refused as an explicit or environment target before any lookup', { skip: !shell }, () => withRoot((root) => {
  const driveRoot = parse(root).root;
  assertRefused({ explicitSpecified: true, explicitValue: driveRoot, cwd: root }, /-Workspace target is a drive root, not a workspace/, '-Workspace drive root');
  assertRefused({ envWorkspace: driveRoot, cwd: root }, /MAXSTACK_WORKSPACE target is a drive root, not a workspace/, 'MAXSTACK_WORKSPACE drive root');
}));

function usedDriveLetters() {
  const listing = spawnSync(shell, ['-NoProfile', '-Command', '[IO.DriveInfo]::GetDrives().Name -join ","'], { windowsHide: true, encoding: 'utf8' });
  return new Set(listing.stdout.trim().split(',').map((name) => name[0]));
}

// Maps a free drive letter to a folder for the body, and removes the mapping after it. Skips the test when no letter
// is free or subst refuses the mapping.
function withSubstDrive(t, body) {
  const used = usedDriveLetters();
  const letter = ['Y', 'X', 'W', 'V', 'U', 'T', 'S', 'R', 'Q', 'P', 'O', 'N', 'M'].find((name) => !used.has(name));
  if (!letter) {
    t.skip('no free drive letter for subst');
    return;
  }
  withRoot((root) => {
    const mapped = directory(root, 'mapped');
    const map = spawnSync('subst', [`${letter}:`, mapped], { windowsHide: true, encoding: 'utf8' });
    if (map.status !== 0) {
      t.skip(`subst could not map a drive here: ${map.stderr.trim() || map.stdout.trim()}`);
      return;
    }
    try {
      body(root, `${letter}:`);
    } finally {
      spawnSync('subst', [`${letter}:`, '/D'], { windowsHide: true, encoding: 'utf8' });
    }
  });
}

test('a marker in a drive root is skipped by the walk, so a no-flag run does not abort', { skip: !shell }, (t) => withSubstDrive(t, (root, drive) => {
  writeFileSync(`${drive}\stack.lock.json`, '{}');
  directory(drive + '\\', 'child');
  resolveFails({ cwd: `${drive}\child`, scriptRoot: join(root, 'no-layout', 'scripts') }, 'Workspace discovery failed');
}));

// A folder whose link target cannot be read makes the walk's resolution throw. The seam replaces the resolver after the
// helper loads, so the walk meets the failure a real junction or drive root can cause.
test('a walk candidate whose folder cannot be resolved is skipped, and the run does not abort', { skip: !shell }, () => withRoot((root) => {
  const workspace = marker(directory(root, 'ws'));
  resolveFails({ cwd: directory(workspace, 'child'), scriptRoot: join(root, 'no-layout', 'scripts'), prelude: "function Get-MaxstackFinalDirectory { param([string] $Path) if ($Path -like '*\ws') { throw 'simulated link failure' }; return [IO.Path]::TrimEndingDirectorySeparator((Get-Item -LiteralPath $Path -Force).FullName) }" }, 'Workspace discovery failed');
}));

test('the installer prints the resolved line first and the layout note once, as a warning', { skip: !shell }, () => withRoot((root) => {
  const layoutWorkspace = marker(directory(root, 'layout-ws'));
  const copyRepo = join(layoutWorkspace, 'projects', 'repos', 'repo');
  mkdirSync(join(copyRepo, 'scripts'), { recursive: true });
  cpSync(join(repoRoot, 'scripts'), join(copyRepo, 'scripts'), { recursive: true });
  const emptyLayers = join(root, 'empty-layers.json');
  writeFileSync(emptyLayers, '{"layers":[]}');
  const markerWorkspace = marker(directory(root, 'marker-ws'));
  const env = { ...process.env };
  delete env.MAXSTACK_WORKSPACE;
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', join(copyRepo, 'scripts', 'Install-Workspace.ps1'), '-LayersFile', emptyLayers, '-Status'], { windowsHide: true, encoding: 'utf8', cwd: directory(markerWorkspace, 'child'), env });
  const lines = run.stdout.split(/\r?\n/);
  assert.equal(lines[0], `Workspace: ${markerWorkspace} (from cwd marker stack.lock.json)`, run.stdout + run.stderr);
  const output = `${run.stdout}${run.stderr}`;
  assert.equal(output.split(`script layout names ${layoutWorkspace}; using cwd marker stack.lock.json ${markerWorkspace}`).length - 1, 1, output);
}));

// The display of a string built from UTF-16 code units, through the helper's escape function. A lone surrogate cannot pass
// through the UTF-8 channel of the other tests, so the units are built inside the child shell.
function displayOf(codeUnits) {
  const ordinal = join(dirname(helper), 'Install-Ordinal.ps1');
  const command = `[Console]::OutputEncoding = [Text.Encoding]::UTF8; . '${ordinal.replaceAll("'", "''")}'; . '${helper.replaceAll("'", "''")}'; $s = -join ([char[]]@(${codeUnits.join(',')})); ConvertTo-SafeName $s`;
  const run = spawnSync(shell, ['-NoProfile', '-Command', command], { windowsHide: true, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.replace(/\r?\n$/, '');
}

test('the display escapes a lone surrogate, a format character, and a line separator, and keeps plain text', { skip: !shell }, () => {
  assert.equal(displayOf([0xd800, 0x41, 0x200b, 0x2028, 0x200d, 0x42]), '\\uD800A\\u200B\\u2028\\u200DB');
});

test('a bidi override, an isolate, or a line separator in a user-supplied path is refused, with the escape shown', { skip: !shell }, () => withRoot((root) => {
  for (const code of [0x202e, 0x2066, 0x2028, 0x2029]) {
    const hex = code.toString(16).toUpperCase().padStart(4, '0');
    assertRefused({ explicitSpecified: true, explicitValue: join(root, `bad${String.fromCharCode(code)}name`), cwd: root }, /-Workspace path contains a character that reorders or splits a line/, `U+${hex}`);
    const run = invoke({ explicitSpecified: true, explicitValue: join(root, `bad${String.fromCharCode(code)}name`), cwd: root });
    assert.ok(run.stderr.includes('\\u' + hex), `U+${hex} not escaped: ${run.stderr}`);
  }
}));

test('a zero width joiner in a user-supplied path is refused by its text, and shown as an escape in the error', { skip: !shell }, () => withRoot((root) => {
  const missing = join(root, `miss${String.fromCharCode(0x200d)}ing`);
  assertRefused({ explicitSpecified: true, explicitValue: missing, cwd: root }, /-Workspace path contains a format character/, 'U+200D');
  const run = invoke({ explicitSpecified: true, explicitValue: missing, cwd: root });
  assert.ok(run.stderr.includes('\\u200D'), run.stderr);
  assert.equal(run.stderr.includes(String.fromCharCode(0x200d)), false, 'the raw joiner reached stderr');
}));

test('the installer refuses a zero width space in its -Workspace value, and shows it as an escape', { skip: !shell }, () => withRoot((root) => {
  const withSpace = join(root, `a${String.fromCharCode(0x200b)}b`);
  mkdirSync(withSpace);
  const run = runInstallerAudit(root, { cwd: root, workspaceArgs: ['-Workspace', withSpace] });
  assert.notEqual(run.status, 0, run.stdout + run.stderr);
  assert.ok(run.stderr.includes('\\u200B'), run.stderr);
  assert.equal(run.stdout.includes(String.fromCharCode(0x200b)) || run.stderr.includes(String.fromCharCode(0x200b)), false, 'the raw space reached the output');
}));

test('a display longer than 260 characters is cut and marked with an ellipsis', { skip: !shell }, () => withRoot((root) => {
  const long = join(root, 'a'.repeat(300));
  const run = invoke({ explicitSpecified: true, explicitValue: long, cwd: root });
  assert.equal(run.status, 23, run.stderr);
  assert.ok(run.stderr.includes('...'), run.stderr);
  assert.equal(run.stderr.includes('a'.repeat(300)), false, 'the whole value was echoed');
}));

// A drive-relative value (C:ws) and a root-relative value (\ws) have no base of their own: resolved against the process
// location they would name a folder the user did not give. They are refused, and nothing is looked up.
test('a drive-relative or root-relative user value is refused, and never resolved against the process location', { skip: !shell }, () => withRoot((root) => {
  const drive = parse(root).root.slice(0, 2);
  const driveRelative = `${drive}maxstack-missing-ws`;
  const rootRelative = '\\maxstack-missing-ws';
  assertRefused({ explicitSpecified: true, explicitValue: driveRelative, cwd: root }, /-Workspace path is drive-relative/, '-Workspace drive-relative');
  assertRefused({ explicitSpecified: true, explicitValue: rootRelative, cwd: root }, /-Workspace path is root-relative/, '-Workspace root-relative');
  assertRefused({ envWorkspace: driveRelative, cwd: root }, /MAXSTACK_WORKSPACE path is drive-relative/, 'MAXSTACK_WORKSPACE drive-relative');
}));

// The repo root is excluded as a folder and everything under it. A sibling whose name only starts with the same letters is not under it.
test('a folder whose name only starts with the repo root name is not under the repo root', { skip: !shell }, () => withRoot((root) => {
  const checkout = makeCheckout(root, 'clone');
  const sibling = marker(directory(root, 'clone-ws'));
  resolveCase({ explicitSpecified: true, explicitValue: sibling, cwd: root, scriptRoot: join(checkout, 'scripts') }, sibling, '-Workspace');
}));

// The resolved line is host output, like every other line the installer prints. A captured run therefore returns nothing,
// as upstream main does.
test('a captured installer run returns nothing: the resolved line is written to the host, not the success stream', { skip: !shell }, () => withRoot((root) => {
  const target = directory(root, 'captured');
  writeFileSync(join(target, 'maxstack.settings.json'), '{"version":1}');
  const command = `$x = & '${installer.replaceAll("'", "''")}' -Workspace '${target.replaceAll("'", "''")}' -Status; 'COUNT=' + @($x).Count`;
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, encoding: 'utf8', cwd: root, env: { ...process.env, MAXSTACK_WORKSPACE: '' } });
  assert.match(run.stdout, /^COUNT=0\r?$/m, run.stdout + run.stderr);
}));

// Kills the mutants that drop projects\worktrees from the internal pair, resolve a relative value against the process
// location instead of the current directory, and skip the final-folder text check.
test('a checkout in a projects worktrees folder is refused as an explicit target and skipped by the walk, like a projects repos folder', { skip: !shell }, () => withRoot((root) => {
  const workspace = marker(directory(root, 'workspace'));
  const worktree = marker(directory(workspace, 'projects/worktrees/layer'));
  assertRefused({ explicitSpecified: true, explicitValue: worktree, cwd: root }, /-Workspace target is inside a git directory, a layer checkout, or a layer cache/, 'explicit worktree');
  resolveCase({ cwd: directory(worktree, 'src') }, workspace, 'cwd marker stack.lock.json');
}));

test('a relative explicit value resolves against the given current directory, not the process location', { skip: !shell }, () => withRoot((root) => {
  const base = directory(root, 'base');
  const elsewhere = directory(root, 'elsewhere');
  const target = marker(directory(base, 'rel-ws'));
  resolveCase({ explicitSpecified: true, explicitValue: 'rel-ws', cwd: base, spawnCwd: elsewhere }, target, '-Workspace');
}));

test('a junction whose target folder has a bidi override in its name is refused, though the link name is plain', { skip: !shell }, () => withRoot((root) => {
  const bidiName = `real${String.fromCharCode(0x202e)}target`;
  const target = marker(directory(root, bidiName));
  const link = join(root, 'plain-link');
  symlinkSync(target, link, 'junction');
  const run = invoke({ explicitSpecified: true, explicitValue: link, cwd: root });
  assert.equal(run.status, 23, run.stdout + run.stderr);
  assert.match(run.stderr, /-Workspace path contains a character that reorders or splits a line/);
}));

// A stack.lock.json that is a junction or a symbolic link: the destructive modes refuse to act through it, and the target is
// left as it was. An empty layers manifest keeps the run offline.
test('-Remove and -Uninstall refuse a linked stack.lock.json and leave its target untouched', { skip: !shell }, () => withRoot((root) => {
  const workspace = directory(root, 'ws');
  const target = directory(root, 'lock-target');
  writeFileSync(join(target, 'precious.txt'), 'keep');
  symlinkSync(target, join(workspace, 'stack.lock.json'), 'junction');
  const emptyLayers = join(root, 'empty-layers.json');
  writeFileSync(emptyLayers, '{"layers":[]}');
  for (const extra of [['-Uninstall', '-Apply'], ['-Remove', '-Runtimes', 'claude', '-Apply']]) {
    const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', installer, '-Workspace', workspace, '-LayersFile', emptyLayers, ...extra], { windowsHide: true, encoding: 'utf8', cwd: root, env: { ...process.env, MAXSTACK_WORKSPACE: '' } });
    assert.notEqual(run.status, 0, `${extra.join(' ')} acted through a linked lock: ${run.stdout}${run.stderr}`);
    assert.match(`${run.stdout}${run.stderr}`, /stack\.lock\.json is a symbolic link or junction, so -Remove and -Uninstall refuse/, extra.join(' '));
    assert.equal(readFileSync(join(target, 'precious.txt'), 'utf8'), 'keep', `${extra.join(' ')} changed the link target`);
  }
}));

// A marker that is a hard link is an ordinary file: it names the folder it sits in, as a copy would. Only a reparse point
// (a symbolic link or a junction) is refused as a marker.
test('a marker that is a hard link is an ordinary file and identifies its folder', { skip: !shell }, () => withRoot((root) => {
  const workspace = directory(root, 'workspace');
  const source = join(root, 'source.json');
  writeFileSync(source, '{}');
  linkSync(source, join(workspace, 'stack.lock.json'));
  resolveCase({ cwd: directory(workspace, 'child'), scriptRoot: join(root, 'no-layout', 'scripts') }, workspace, 'cwd marker stack.lock.json');
}));

// A file symbolic link needs the symbolic-link privilege. Where it is missing the test is skipped with that reason.
test('a marker that is a file symbolic link is not a marker, and the walk goes on', { skip: !shell }, (t) => withRoot((root) => {
  const workspace = directory(root, 'workspace');
  const source = join(root, 'source.json');
  writeFileSync(source, '{}');
  try {
    symlinkSync(source, join(workspace, 'stack.lock.json'), 'file');
  } catch (error) {
    if (error.code === 'EPERM') {
      t.skip('the symbolic-link privilege is unavailable in this environment');
      return;
    }
    throw error;
  }
  resolveFails({ cwd: directory(workspace, 'child'), scriptRoot: join(root, 'no-layout', 'scripts') }, 'Workspace discovery failed');
}));

// A script layout that is itself a maxstack checkout is not a workspace, so discovery refuses.
test('a script layout that is a maxstack checkout is not a workspace, and discovery refuses', { skip: !shell }, () => withRoot((root) => {
  const checkout = makeCheckout(root, 'checkout');
  const scriptRoot = directory(checkout, 'projects/repos/r/scripts');
  resolveFails({ cwd: directory(root, 'outside'), scriptRoot }, 'Workspace discovery failed');
}));

// With no explicit or discovered target, the installer refuses before touching any folder.
// The copied installer names an existing folder as its default, and an empty layers manifest keeps the run offline.
test('finding F11: the installer refuses when no workspace source names a target', { skip: !shell }, () => withRoot((root) => {
  const copyScripts = join(directory(root, 'copy'), 'scripts');
  mkdirSync(copyScripts, { recursive: true });
  cpSync(join(repoRoot, 'scripts'), copyScripts, { recursive: true });
  const copy = join(copyScripts, 'Install-Workspace.ps1');
  const emptyLayers = join(root, 'empty-layers.json');
  writeFileSync(emptyLayers, '{"layers":[]}');
  const env = { ...process.env };
  delete env.MAXSTACK_WORKSPACE;
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', copy, '-LayersFile', emptyLayers, '-Status'], { windowsHide: true, encoding: 'utf8', cwd: directory(root, 'outside'), env });
  assert.notEqual(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.match(`${run.stdout}${run.stderr}`, /Workspace discovery failed.*-Workspace.*MAXSTACK_WORKSPACE.*cwd marker.*script layout/is);
}));

// The walk ignores a marker that is a link. Here the link predicate is replaced after the helper loads, because a file symbolic
// link cannot be created in this environment; the predicate itself is exercised by the reparse-point tests.
test('the walk ignores a marker that is a link, whatever its kind', { skip: !shell }, () => withRoot((root) => {
  const workspace = marker(directory(root, 'ws'));
  resolveFails({ cwd: directory(workspace, 'child'), scriptRoot: join(root, 'no-layout', 'scripts'), prelude: 'function Test-MaxstackLinkedPath { param([string] $Path) return $Path -like \'*stack.lock.json\' }' }, 'Workspace discovery failed');
}));
