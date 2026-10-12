// Installer tests for maxstack.settings.json: its grammar and diagnostics, the settings layer sources, and
// the status and update of a workspace that has a settings file. Helpers come from ./lib/installer-test-kit.mjs.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, cpSync, existsSync, rmSync, readdirSync, openSync, closeSync, readFileSync, mkdirSync, symlinkSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse as parsePath } from 'node:path';
import { EXISTING_SHORT_FOLDER, LOCAL_LAYERS, MISSING_PI, USER_SETTINGS, ZWSP, assertOk, buildWorkspace, clearInstallOutputs, escapedChar, exportMainInstaller, gitRun, githubEnv, installer, layerNamed, layerSourcesFile, localCheckout, lockPath, lockText, mustApply, ownedRecord, plainOutput, problemRows, python, readJson, removal, repoRoot, runInstaller, seedSchema1, servedFeature, setLock, settingsPath, shell, short83Available, snapshotTree, sourceBlockIn, sourceOf, stripDiscoveryLine, testEnvironment, withHook, withMainCommit, withWorkspace, withWorkspaceNeeding, writeFile, writeLayers, writeWorkspaceSettings } from './lib/installer-test-kit.mjs';

withWorkspace('settings select exact names on a new workspace, add names on apply, and report omitted recorded names', (ctx) => {
  const addedLayer = LOCAL_LAYERS[0].split('/').pop();
  writeWorkspaceSettings(ctx, {
    version: 1,
    runtimes: { claude: { cli: 'install' } },
    layers: { pstack: { source: 'default' } },
    t3: { cli: 'install', snapshot: false, defaults: 'apply-defaults' },
  });

  const first = mustApply(ctx);
  const firstLock = readJson(join(ctx.workspace, 'stack.lock.json'));
  assert.deepEqual(firstLock.selection.runtimes, ['claude']);
  assert.deepEqual(firstLock.selection.layers, ['pstack']);
  assert.deepEqual(firstLock.settings, { file: 'maxstack.settings.json', version: 1, sha256: firstLock.settings.sha256 });
  assert.match(firstLock.settings.sha256, /^[A-F0-9]{64}$/);
  assert.ok(!firstLock.owned.some((record) => record.path === 'maxstack.settings.json'));
  assert.match(first.stdout, /Settings:.*maxstack\.settings\.json/);
  assert.match(first.stdout, /CLI installation is unsupported/);
  assert.match(first.stdout, /apply-defaults is reserved and unsupported/);

  writeWorkspaceSettings(ctx, {
    version: 1,
    runtimes: { claude: {}, pi: {} },
    layers: { pstack: {}, [addedLayer]: {} },
  });
  const added = mustApply(ctx);
  const addedLock = readJson(join(ctx.workspace, 'stack.lock.json'));
  assert.deepEqual(addedLock.selection.runtimes, ['claude', 'pi']);
  assert.deepEqual(addedLock.selection.layers, ['pstack', addedLayer].sort());
  assert.match(added.stdout, /runtime 'pi' from maxstack\.settings\.json is selected by this apply/);

  writeWorkspaceSettings(ctx, {
    version: 1,
    runtimes: { claude: {} },
    layers: { pstack: {} },
  });
  const status = runInstaller(shell, ctx, ['-Status', '-Strict'], { apply: false });
  assert.equal(status.status, 1, `${status.stdout}\n${status.stderr}`);
  assert.match(plainOutput(status), /unlisted.*pi|pi.*unlisted/i);
  assert.match(plainOutput(status), new RegExp(`unlisted.*${addedLayer}|${addedLayer}.*unlisted`, 'i'));
  assert.match(plainOutput(status), /changed since the last apply/);
}, {});

// The workspace bytes a comparison checks. Each lock is compared without its generation time.
function workspaceState(ctx) {
  const tree = snapshotTree(ctx.workspace, { skipGit: true });
  for (const path of ['stack.lock.json', 'stack.lock.json.bak']) {
    if (!tree.has(path)) continue;
    const lock = readJson(join(ctx.workspace, path));
    delete lock.generatedAt;
    tree.set(path, `file:${Buffer.from(JSON.stringify(lock)).toString('base64')}`);
  }
  return tree;
}

// Puts the workspace in the state a comparison starts from. The main installer builds every state, so the two installers
// start from the same bytes. A null schema is a workspace with no lock. Otherwise the lock has string layer sources and
// the given ownedSchema, as a lock from an earlier release has.
function prepareComparedState(ctx, mainInstaller, layersFile, schema) {
  clearInstallOutputs(ctx.workspace);
  if (schema === null) return;
  assertOk(runInstaller(shell, ctx, [], { layersFile, installerPath: mainInstaller }));
  const lockPath = join(ctx.workspace, 'stack.lock.json');
  const lock = readJson(lockPath);
  for (const layer of lock.layers) layer.source = `${layer.name}@main`;
  lock.ownedSchema = schema;
  writeFileSync(lockPath, JSON.stringify(lock, null, 2));
}

// The steps a comparison runs, in order. Each records its exit code, its output, and the workspace it leaves.
const COMPARED_STEPS = [
  { label: 'audit', args: [], apply: false },
  { label: '-Status -Strict', args: ['-Status', '-Strict'], apply: false },
  { label: '-Update -Check', args: ['-Update', '-Check'], apply: false },
  { label: 'apply', args: [], apply: true },
];

function runComparedSteps(ctx, installerPath, layersFile) {
  return COMPARED_STEPS.map((step) => {
    const run = runInstaller(shell, ctx, step.args, { apply: step.apply, layersFile, installerPath });
    const stdout = installerPath === installer ? stripDiscoveryLine(run.stdout, ctx.workspace) : run.stdout;
    return { label: step.label, status: run.status, stdout, tree: workspaceState(ctx) };
  });
}

withMainCommit('a no-settings apply matches the upstream main output and workspace tree', (ctx) => {
  const mainInstaller = exportMainInstaller(ctx.base);
  const layersFile = writeLayers(ctx);
  prepareComparedState(ctx, mainInstaller, layersFile, null);
  const baseline = runComparedSteps(ctx, mainInstaller, layersFile);
  assert.equal(baseline.at(-1).status, 0, 'the upstream main apply failed, so the comparison is empty');
  prepareComparedState(ctx, mainInstaller, layersFile, null);
  assert.deepEqual(runComparedSteps(ctx, installer, layersFile), baseline, 'a fresh workspace');
}, {});

withMainCommit('no-settings steps match upstream main for old locks with string sources, ownedSchema 2 and 1', (ctx) => {
  const mainInstaller = exportMainInstaller(ctx.base);
  const layersFile = writeLayers(ctx);
  for (const schema of [2, 1]) {
    prepareComparedState(ctx, mainInstaller, layersFile, schema);
    const baseline = runComparedSteps(ctx, mainInstaller, layersFile);
    assert.equal(baseline.at(-1).status, 0, `upstream main apply failed for ownedSchema ${schema}`);
    prepareComparedState(ctx, mainInstaller, layersFile, schema);
    assert.deepEqual(runComparedSteps(ctx, installer, layersFile), baseline, `ownedSchema ${schema}`);
  }
}, {});

withMainCommit('a no-settings local -Source override matches upstream main in output and tree, for apply and status', (ctx) => {
  const mainInstaller = exportMainInstaller(ctx.base);
  const layersFile = writeLayers(ctx);
  const checkout = join(ctx.workspace, 'source-checkout');
  cpSync(ctx.fixture.dir, checkout, { recursive: true });
  const sourceArgs = ['-Source', `pstack=local:${checkout}`];
  const comparedRuns = (installerPath) => {
    clearInstallOutputs(ctx.workspace);
    return [[sourceArgs, true], [['-Status'], false]].map(([args, apply]) => {
      const run = runInstaller(shell, ctx, args, { apply, layersFile, installerPath });
      const stdout = installerPath === installer ? stripDiscoveryLine(run.stdout, ctx.workspace) : run.stdout;
      return { args, status: run.status, stdout, tree: workspaceState(ctx) };
    });
  };
  const baseline = comparedRuns(mainInstaller);
  assert.equal(baseline[0].status, 0, 'the upstream main apply failed, so the comparison is empty');
  assert.deepEqual(comparedRuns(installer), baseline);
}, {});

withWorkspace('invalid settings are rejected before guarded git starts for settings, flag, or recorded refs', (ctx) => {
  mustApply(ctx);
  const lockPath = join(ctx.workspace, 'stack.lock.json');
  const lock = readJson(lockPath);
  const pstack = lock.layers.find((layer) => layer.name === 'pstack');
  pstack.source = { kind: 'git', url: ctx.fixture.url, ref: 'valid-ref', commit: ctx.fixture.commit, override: true };
  writeFileSync(lockPath, JSON.stringify(lock, null, 2));

  const cases = [
    { name: 'settings ref', settings: { layers: { pstack: { source: 'test-owner/test-repo@valid-ref' } } }, args: [] },
    { name: 'flag ref', settings: {}, args: ['-Source', 'pstack=test-owner/test-repo@valid-ref'] },
    { name: 'recorded ref', settings: {}, args: [] },
  ];
  for (const item of cases) {
    writeWorkspaceSettings(ctx, { version: 1, ...item.settings, t3: { defaults: 'invalid' } });
    const trace = join(ctx.base, `git-${item.name.replaceAll(' ', '-')}.trace`);
    const run = runInstaller(shell, ctx, item.args, {
      apply: false,
      env: { ...testEnvironment(), GIT_TRACE: trace },
    });
    assert.notEqual(run.status, 0, `${item.name}: settings validation unexpectedly passed`);
    assert.match(plainOutput(run), /t3\.defaults must be leave-alone or apply-defaults/);
    assert.equal(existsSync(trace), false, `${item.name}: guarded Git started before settings validation`);
  }
}, {});

withWorkspace('an omitted settings dimension keeps the recorded selection without an unlisted status', (ctx) => {
  mustApply(ctx);
  const layers = Object.fromEntries(['pstack', 'simpsonm09-org-ai-plugin', 'simpsonm09-personal-ai-plugin'].map((name) => [name, {}]));
  writeWorkspaceSettings(ctx, { version: 1, layers });
  const runtimeOmitted = runInstaller(shell, ctx, ['-Status', '-Strict'], { apply: false });
  assert.equal(runtimeOmitted.status, 0, plainOutput(runtimeOmitted));
  assert.doesNotMatch(plainOutput(runtimeOmitted), /Settings: unlisted runtime/i);
  assert.match(plainOutput(runtimeOmitted), /Selection: runtimes claude, copilot, opencode, pi/);

  writeWorkspaceSettings(ctx, { version: 1, runtimes: Object.fromEntries(['claude', 'copilot', 'opencode', 'pi'].map((name) => [name, {}])) });
  const layerOmitted = runInstaller(shell, ctx, ['-Status', '-Strict'], { apply: false });
  assert.equal(layerOmitted.status, 0, plainOutput(layerOmitted));
  assert.doesNotMatch(plainOutput(layerOmitted), /Settings: unlisted layer/i);
  assert.match(plainOutput(layerOmitted), /Selection: runtimes claude, copilot, opencode, pi; layers pstack, simpsonm09-org-ai-plugin, simpsonm09-personal-ai-plugin/);
}, {});

withWorkspace('settings dependencies are checked after flags join the additive selection', (ctx) => {
  writeWorkspaceSettings(ctx, { version: 1, runtimes: { pi: {} }, layers: { pstack: {} } });
  const supplied = runInstaller(shell, ctx, ['-Runtimes', 'claude'], { apply: true });
  assertOk(supplied);
  assert.deepEqual(readJson(join(ctx.workspace, 'stack.lock.json')).selection.runtimes, ['claude', 'pi']);
  assert.match(plainOutput(supplied), /runtime 'claude' is selected by a flag and is not in maxstack\.settings\.json/);

  const missing = buildWorkspace();
  try {
    writeWorkspaceSettings(missing, { version: 1, runtimes: { pi: {} }, layers: { pstack: {} } });
    const refused = runInstaller(shell, missing, [], { apply: false });
    assert.notEqual(refused.status, 0);
    assert.match(plainOutput(refused), /needs claude/);
  } finally {
    rmSync(missing.base, { recursive: true, force: true });
  }
}, {});

withWorkspace('an explicit settings OS mismatch is allowed in audit and refused before apply', (ctx) => {
  const mismatch = process.platform === 'win32' ? 'linux' : 'windows';
  writeWorkspaceSettings(ctx, { version: 1, os: mismatch, runtimes: { claude: {} }, layers: { pstack: {} } });
  const audit = runInstaller(shell, ctx, [], { apply: false });
  assert.equal(audit.status, 0, plainOutput(audit));
  const before = readdirSync(ctx.workspace, { recursive: true }).sort();
  const apply = runInstaller(shell, ctx);
  assert.notEqual(apply.status, 0, 'apply accepted a settings OS for another host');
  assert.match(plainOutput(apply), /os targets a different machine.*apply writes for the detected OS/i);
  assert.deepEqual(readdirSync(ctx.workspace, { recursive: true }).sort(), before);
}, {});

withWorkspace('a malformed settings file stops apply before changing the workspace', (ctx) => {
  writeFileSync(join(ctx.workspace, 'maxstack.settings.json'), '{"version":1,"version":1}');
  const before = readdirSync(ctx.workspace, { recursive: true }).sort();
  const run = runInstaller(shell, ctx, [], { apply: false });
  assert.notEqual(run.status, 0, 'duplicate JSON keys must be refused');
  assert.match(plainOutput(run), /duplicate/i);
  assert.deepEqual(readdirSync(ctx.workspace, { recursive: true }).sort(), before);
}, {});

withWorkspace('each optional settings key may be omitted, with no strict-mode read of a missing member', (ctx) => {
  // Each variant leaves out one optional key, or a member under one (t3.cli, t3.snapshot, t3.defaults), so every read of
  // an optional member must check it exists first. An audit reads the file on every run.
  const variants = [
    { version: 1 },
    { version: 1, $schema: 'https://json-schema.org/draft/2020-12/schema' },
    { version: 1, os: 'auto' },
    { version: 1, runtimes: { claude: {} } },
    { version: 1, runtimes: { claude: { cli: 'detect' } } },
    { version: 1, layers: { pstack: {} } },
    { version: 1, layers: { pstack: { source: 'default' } } },
    { version: 1, t3: {} },
    { version: 1, t3: { cli: 'install' } },
    { version: 1, t3: { snapshot: false } },
    { version: 1, t3: { defaults: 'leave-alone' } },
    { version: 1, t3: { cli: 'detect', snapshot: true } },
  ];
  for (const value of variants) {
    writeWorkspaceSettings(ctx, value);
    const run = runInstaller(shell, ctx, [], { apply: false });
    assertOk(run);
    assert.doesNotMatch(plainOutput(run), /cannot be found|strict/i, JSON.stringify(value));
  }
}, {});

withWorkspace('settings accept a UTF-8 BOM and reject invalid keys, values, and size limits', (ctx) => {
  const bomPath = join(ctx.workspace, 'maxstack.settings.json');
  writeFileSync(bomPath, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"version":1}') ]));
  const bom = runInstaller(shell, ctx, [], { apply: false });
  assertOk(bom);
  assert.match(bom.stdout, /Settings: maxstack\.settings\.json is present/);

  cpSync(ctx.fixture.dir, join(ctx.workspace, 'sample-layer'), { recursive: true });
  writeWorkspaceSettings(ctx, {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    version: 1,
    os: 'auto',
    runtimes: { claude: { cli: 'detect' } },
    layers: { pstack: { source: 'local:sample-layer' } },
    t3: { cli: 'detect', snapshot: true, defaults: 'leave-alone' },
  });
  assertOk(runInstaller(shell, ctx, [], { apply: false }));

  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: `local:${join(ctx.base, 'sample-layer')}` } } });
  const machinePath = runInstaller(shell, ctx, [], { apply: false });
  assertOk(machinePath);
  assert.match(plainOutput(machinePath), /contains a machine path/);

  const tooLongSource = `local:${'a'.repeat(2043)}`;
  const invalidCases = [
    ['[]', /must hold one JSON object/],
    ['{"version":1,"t3":{"cli":"detect","cli":"install"}}', /duplicate key 'cli'/],
    ['{"version":1,}', /not strict JSON/],
    [{ os: 'auto' }, /needs "version": 1/],
    [{ version: '1' }, /needs "version": 1/],
    [{ version: 1, $schema: 2 }, /\$schema must be a string/],
    [{ version: 1, runtime: {} }, /unknown key 'runtime'/],
    [{ version: 2 }, /needs "version": 1/],
    [{ version: 1, os: 'android' }, /os has an unsupported value/],
    [{ version: 1, runtimes: { gemini: {} } }, /unknown key 'gemini'/],
    [{ version: 1, runtimes: {} }, /runtimes names no runtime/],
    [{ version: 1, runtimes: [] }, /runtimes must be an object/],
    [{ version: 1, runtimes: { pi: {} } }, /needs claude/],
    [{ version: 1, runtimes: { claude: { cli: 'maybe' } } }, /cli must be detect or install/],
    [{ version: 1, layers: {} }, /layers names no layer/],
    [{ version: 1, layers: [] }, /layers must be an object/],
    [{ version: 1, layers: { absent: {} } }, /unknown key 'absent'/],
    [{ version: 1, layers: { pstack: { extra: true } } }, /unknown key 'extra'/],
    [{ version: 1, layers: { pstack: { source: 'local:../outside' } } }, /unsafe local path/],
    [{ version: 1, layers: { pstack: { source: 'file:somewhere' } } }, /not a supported source/],
    [{ version: 1, layers: { pstack: { source: 'sample/repo@bad..ref' } } }, /not a supported source/],
    [{ version: 1, layers: { pstack: { source: tooLongSource } } }, /at most 2048 characters/],
    [{ version: 1, t3: 'nope' }, /t3 must be an object/],
    [{ version: 1, t3: { cli: 'maybe' } }, /t3.cli must be detect or install/],
    [{ version: 1, t3: { snapshot: 'yes' } }, /snapshot must be true or false/],
    [{ version: 1, t3: { defaults: 'maxstack' } }, /defaults must be leave-alone or apply-defaults/],
  ];
  for (const [value, message] of invalidCases) {
    writeFileSync(bomPath, typeof value === 'string' ? value : JSON.stringify(value));
    const before = readdirSync(ctx.workspace, { recursive: true }).sort();
    const run = runInstaller(shell, ctx, [], { apply: false });
    assert.notEqual(run.status, 0, JSON.stringify(value));
    assert.match(plainOutput(run), message, plainOutput(run));
    assert.deepEqual(readdirSync(ctx.workspace, { recursive: true }).sort(), before);
  }

  writeFileSync(bomPath, JSON.stringify({ version: 1, note: 'a'.repeat(65540) }));
  const oversized = runInstaller(shell, ctx, [], { apply: false });
  assert.notEqual(oversized.status, 0);
  assert.match(plainOutput(oversized), /65536 byte limit/);

  writeFileSync(bomPath, Buffer.from([0xef, 0xbb, 0xbf, 0xff]));
  const invalidUtf8 = runInstaller(shell, ctx, [], { apply: false });
  assert.notEqual(invalidUtf8.status, 0);
  assert.match(plainOutput(invalidUtf8), /not valid UTF-8/);

  const deepValue = `${'['.repeat(40)}0${']'.repeat(40)}`;
  writeFileSync(bomPath, `{"version":1,"deep":${deepValue}}`);
  const deep = runInstaller(shell, ctx, [], { apply: false });
  assert.notEqual(deep.status, 0, 'deep JSON exceeded the supported nesting limit');
  assert.doesNotMatch(plainOutput(deep), /RangeError|stack overflow/i);
}, {});

withWorkspace('settings diagnostics escape C1, bidi, and ALM characters in names and never print a raw one', (ctx) => {
  for (const [char, escaped] of [['\u009b', '\\u009B'], ['‮', '\\u202E'], ['⁦', '\\u2066'], ['؜', '\\u061C']]) {
    writeFileSync(join(ctx.workspace, 'maxstack.settings.json'), JSON.stringify({ version: 1, [`bad${char}FAKE`]: true }));
    const run = runInstaller(shell, ctx, [], { apply: false });
    assert.notEqual(run.status, 0, escaped);
    const text = `${run.stdout}\n${run.stderr}`;
    assert.equal(text.includes(char), false, `${escaped}: a raw control character reached the output`);
    assert.ok(text.includes(escaped), `${escaped} is not shown in its escaped form`);
  }
}, {});

withWorkspace('a settings file held open by another process gives one friendly line, not a .NET exception', (ctx) => {
  const path = join(ctx.workspace, 'maxstack.settings.json');
  writeWorkspaceSettings(ctx, { version: 1, runtimes: { claude: {} }, layers: { pstack: {} } });
  const held = openSync(path, 'r+');
  try {
    const audit = runInstaller(shell, ctx, [], { apply: false });
    assert.notEqual(audit.status, 0);
    assert.match(plainOutput(audit), /maxstack\.settings\.json could not be read/);
    assert.doesNotMatch(plainOutput(audit), /IOException|System\.IO|being used by another process/);
    const status = runInstaller(shell, ctx, ['-Status', '-Strict'], { apply: false });
    assert.equal(status.status, 1);
    const invalid = status.stdout.split(/\r?\n/).filter((line) => line.startsWith('Settings:'));
    assert.equal(invalid.length, 1, invalid.join(' | '));
    assert.match(invalid[0], /^Settings: invalid maxstack\.settings\.json could not be read/);
  } finally {
    closeSync(held);
  }
}, {});

withWorkspace('-Update -Apply keeps the recorded settings hash, since it does not select the names settings add', (ctx) => {
  writeWorkspaceSettings(ctx, { version: 1, runtimes: { claude: {} }, layers: { pstack: {} } });
  mustApply(ctx);
  const recorded = readJson(join(ctx.workspace, 'stack.lock.json')).settings.sha256;
  writeWorkspaceSettings(ctx, { version: 1, runtimes: { claude: {}, pi: {} }, layers: { pstack: {} } });
  const update = runInstaller(shell, ctx, ['-Update', '-Apply'], { apply: false });
  assertOk(update);
  assert.match(plainOutput(update), /runtime 'pi' from maxstack\.settings\.json is not selected by -Update/);
  assert.doesNotMatch(plainOutput(update), /will be selected on -Apply/);
  const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  assert.deepEqual(lock.selection.runtimes, ['claude'], 'the update selected a name from settings');
  assert.equal(lock.settings.sha256, recorded, 'the update recorded a hash for a selection it did not apply');
}, {});

withWorkspace('a pending runtime that -Apply refuses is named as coming from settings, with the reason', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'opencode']);
  writeWorkspaceSettings(ctx, { version: 1, runtimes: { pi: {} }, layers: { pstack: {} } });
  const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assertOk(status);
  assert.match(plainOutput(status), /pending runtime 'pi' from maxstack\.settings\.json.*-Apply refuses it/);
  const refused = runInstaller(shell, ctx, [], { apply: true });
  assert.notEqual(refused.status, 0);
  assert.match(plainOutput(refused), /Runtime 'pi' needs claude.*maxstack\.settings\.json names 'pi'/);
}, {});

withWorkspace('settings keys, runtime and layer names, and enum values match case-sensitively at every level', (ctx) => {
  const variants = [
    { version: 1, Runtimes: { claude: {} } },
    { version: 1, runtimes: { Claude: {} } },
    { version: 1, runtimes: { claude: { CLI: 'detect' } } },
    { version: 1, runtimes: { claude: { cli: 'Detect' } } },
    { version: 1, layers: { PSTACK: {} } },
    { version: 1, layers: { pstack: { Source: 'default' } } },
    { version: 1, t3: { CLI: 'detect' } },
    { version: 1, t3: { defaults: 'Leave-Alone' } },
    { version: 1, os: 'Windows' },
    { version: 1, os: 'AUTO' },
  ];
  for (const value of variants) {
    writeWorkspaceSettings(ctx, value);
    const run = runInstaller(shell, ctx, [], { apply: false });
    assert.notEqual(run.status, 0, JSON.stringify(value));
    assert.match(plainOutput(run), /unknown key|unsupported value|must be detect|must be leave-alone|must be an object|needs "version"/, JSON.stringify(value));
  }
}, {});

withWorkspace('-Status -Strict fails for a changed settings file on its own', (ctx) => {
  writeWorkspaceSettings(ctx, { version: 1, runtimes: { claude: {} }, layers: { pstack: {} } });
  mustApply(ctx);
  writeWorkspaceSettings(ctx, { version: 1, runtimes: { claude: {} }, layers: { pstack: {} }, t3: { snapshot: true } });
  const status = runInstaller(shell, ctx, ['-Status', '-Strict'], { apply: false });
  assert.equal(status.status, 1, plainOutput(status));
  assert.match(plainOutput(status), /Settings: changed since the last apply\./);
  assert.doesNotMatch(plainOutput(status), /Settings: (pending|unlisted) (runtime|layer)/);
}, {});

withWorkspace('-Uninstall leaves the settings file exactly as it was', (ctx) => {
  writeWorkspaceSettings(ctx, { version: 1, runtimes: { claude: {} }, layers: { pstack: {} }, t3: { snapshot: false } });
  mustApply(ctx);
  const path = join(ctx.workspace, 'maxstack.settings.json');
  const before = readFileSync(path);
  assertOk(runInstaller(shell, ctx, ['-Uninstall']));
  assert.ok(readFileSync(path).equals(before), 'the uninstall changed the settings file');
}, {});

withWorkspace('settings path directories and leaf links are refused without following them', (ctx) => {
  const path = join(ctx.workspace, 'maxstack.settings.json');
  mkdirSync(path);
  const directory = runInstaller(shell, ctx, [], { apply: false });
  assert.notEqual(directory.status, 0);
  assert.match(plainOutput(directory), /settings path is a directory/i);
  rmSync(path, { recursive: true, force: true });

  const target = join(ctx.base, 'outside-settings');
  mkdirSync(target);
  writeFileSync(join(target, 'maxstack.settings.json'), '{"version":1,"runtimes":{"claude":{}},"layers":{"pstack":{}}}');
  symlinkSync(target, path, 'junction');
  const link = runInstaller(shell, ctx, [], { apply: false });
  assert.notEqual(link.status, 0);
  assert.match(plainOutput(link), /settings path is a symbolic link or reparse point/i);
  assert.doesNotMatch(plainOutput(link), /outside-settings/);
  assert.equal(readFileSync(join(target, 'maxstack.settings.json'), 'utf8'), '{"version":1,"runtimes":{"claude":{}},"layers":{"pstack":{}}}');
}, {});

withWorkspace('settings diagnostics escape property names and never print control-bearing values', (ctx) => {
  const key = `bad\u001b[31m\nFAKE-INJECTED`;
  writeFileSync(join(ctx.workspace, 'maxstack.settings.json'), JSON.stringify({ version: 1, [key]: 'private-value' }));
  const run = runInstaller(shell, ctx, [], { apply: false });
  assert.notEqual(run.status, 0);
  assert.match(plainOutput(run), /holds the character \\u001B/, plainOutput(run));
  // PowerShell's error view writes SGR colour codes even when piped, so they are stripped before the raw-escape check.
  const escapeCharacter = String.fromCharCode(27);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape byte is the ANSI colour code being removed
  const text = `${run.stdout}\n${run.stderr}`.replace(/\x1B\[[0-9;]*m/g, '');
  assert.equal(text.includes(escapeCharacter), false, 'a raw escape byte from the key reached the output');
  assert.ok(text.includes('\\u001B'), 'the escape byte is not shown in its escaped form');
  assert.doesNotMatch(text, /^FAKE-INJECTED/m, 'the key printed FAKE-INJECTED as its own line');

  // A name longer than 260 characters is cut with an ellipsis, so the whole key never reaches the output.
  const longKey = 'unknown-key-'.repeat(30);
  writeFileSync(join(ctx.workspace, 'maxstack.settings.json'), JSON.stringify({ version: 1, [longKey]: true }));
  const longName = runInstaller(shell, ctx, [], { apply: false });
  assert.notEqual(longName.status, 0);
  assert.match(plainOutput(longName), /unknown key/, plainOutput(longName));
  assert.doesNotMatch(plainOutput(longName), new RegExp(longKey));

  writeWorkspaceSettings(ctx, { version: 1, os: `bad\nFAKE-ENUM` });
  const enumRun = runInstaller(shell, ctx, [], { apply: false });
  assert.notEqual(enumRun.status, 0);
  // The value is shown on one line with its newline escaped. The raw text must be absent, and the escaped text present.
  const enumText = `${enumRun.stdout}${enumRun.stderr}`;
  assert.ok(enumText.includes('bad\\u000AFAKE-ENUM'), 'the value is not shown in its escaped form');
  assert.ok(!enumText.includes('bad\nFAKE-ENUM'), 'the raw value reached the output');
}, {});

withWorkspace('a status reports invalid settings while still reporting its lock', (ctx) => {
  mustApply(ctx);
  writeFileSync(join(ctx.workspace, 'maxstack.settings.json'), '{"version":1,"version":1}');
  const status = runInstaller(shell, ctx, ['-Status', '-Strict'], { apply: false });
  assert.equal(status.status, 1);
  assert.match(plainOutput(status), /Settings: invalid/);
  assert.match(plainOutput(status), /Selection: runtimes/);
}, {});

withWorkspace('status on an invalid or unreadable settings file prints only the invalid line', (ctx) => {
  const path = join(ctx.workspace, 'maxstack.settings.json');
  const settingsLines = (run) => run.stdout.split(/\r?\n/).filter((line) => line.startsWith('Settings:'));
  const expectInvalidOnly = (run, why) => {
    assert.equal(run.status, 1, `${why}: ${run.stdout}`);
    const lines = settingsLines(run);
    assert.equal(lines.length, 1, `${why}: ${lines.join(' | ')}`);
    assert.match(lines[0], /^Settings: invalid /, why);
  };

  writeFileSync(path, '{"version":1,"version":1}');
  expectInvalidOnly(runInstaller(shell, ctx, ['-Status', '-Strict'], { apply: false }), 'invalid, no lock');

  writeWorkspaceSettings(ctx, { version: 1, runtimes: { claude: {} }, layers: { pstack: {} } });
  mustApply(ctx);
  writeFileSync(path, '{"version":1,"version":1}');
  expectInvalidOnly(runInstaller(shell, ctx, ['-Status', '-Strict'], { apply: false }), 'invalid, with a recorded hash');

  rmSync(path, { force: true });
  mkdirSync(path);
  expectInvalidOnly(runInstaller(shell, ctx, ['-Status', '-Strict'], { apply: false }), 'a directory, with a recorded hash');
  rmSync(path, { recursive: true, force: true });
  const bareDirectory = buildWorkspace();
  try {
    mkdirSync(join(bareDirectory.workspace, 'maxstack.settings.json'));
    expectInvalidOnly(runInstaller(shell, bareDirectory, ['-Status', '-Strict'], { apply: false }), 'a directory, no lock');
  } finally {
    rmSync(bareDirectory.base, { recursive: true, force: true });
  }
}, {});

withWorkspace('status and update check do not write the settings file or workspace', (ctx) => {
  const baseline = runInstaller(shell, ctx, ['-Runtimes', 'claude', '-Layers', 'pstack']);
  assertOk(baseline);
  writeWorkspaceSettings(ctx, { version: 1, runtimes: { claude: {}, pi: {} }, layers: { pstack: {} } });
  const before = snapshotTree(ctx.workspace);
  const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assertOk(status);
  const check = runInstaller(shell, ctx, ['-Update', '-Check'], { apply: false });
  assertOk(check);
  assert.match(plainOutput(check), /pending/);
  assert.deepEqual(snapshotTree(ctx.workspace), before);
}, {});

withWorkspace('a settings migration keeps the old lock selection and owned records', (ctx) => {
  mustApply(ctx);
  const before = readJson(join(ctx.workspace, 'stack.lock.json'));
  writeWorkspaceSettings(ctx, {
    version: 1,
    runtimes: Object.fromEntries(before.selection.runtimes.map((name) => [name, {}])),
    layers: Object.fromEntries(before.selection.layers.map((name) => [name, {}])),
  });
  mustApply(ctx);
  const after = readJson(join(ctx.workspace, 'stack.lock.json'));
  assert.deepEqual(after.selection, before.selection);
  assert.deepEqual(after.owned, before.owned);
  assert.deepEqual(after.createdDirs, before.createdDirs);
  assert.deepEqual(after.createdFiles, before.createdFiles);
  assert.equal(before.settings, undefined);
  assert.match(after.settings.sha256, /^[A-F0-9]{64}$/);
}, {});

withWorkspace('settings hashes ignore whitespace and object key order', (ctx) => {
  writeFileSync(join(ctx.workspace, 'maxstack.settings.json'), '{"version":1,"runtimes":{"claude":{}},"layers":{"pstack":{}}}');
  mustApply(ctx);
  const before = readJson(join(ctx.workspace, 'stack.lock.json')).settings.sha256;
  writeFileSync(join(ctx.workspace, 'maxstack.settings.json'), '{\n  "layers": { "pstack": {} },\n  "runtimes": { "claude": {} },\n  "version": 1\n}\n');
  const status = runInstaller(shell, ctx, ['-Status', '-Strict'], { apply: false });
  assert.equal(status.status, 0, `${status.stdout}\n${status.stderr}`);
  assert.doesNotMatch(plainOutput(status), /changed since the last apply/);
  assert.equal(readJson(join(ctx.workspace, 'stack.lock.json')).settings.sha256, before);
}, {});

withWorkspace('settings layer sources are overridden by flags, retained when omitted, and reset by default', (ctx) => {
  const first = join(ctx.workspace, 'source-one');
  const second = join(ctx.workspace, 'source-two');
  cpSync(ctx.fixture.dir, first, { recursive: true });
  cpSync(ctx.fixture.dir, second, { recursive: true });
  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: 'local:source-one' } } });
  const settingsApply = runInstaller(shell, ctx);
  assertOk(settingsApply);
  let lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  assert.equal(lock.layers.find((layer) => layer.name === 'pstack').source.path, first);
  const matchingStatus = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assertOk(matchingStatus);
  assert.doesNotMatch(plainOutput(matchingStatus), /layers\.pstack\.source differs/);
  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: 'local:source-two' } } });
  const changedStatus = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assertOk(changedStatus);
  assert.match(plainOutput(changedStatus), /layers\.pstack\.source differs from its recorded override/);

  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: {} } });
  const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assertOk(status);
  assert.match(plainOutput(status), /Settings: layers\.pstack has no source in maxstack\.settings\.json; its recorded override is kept\./);
  assert.equal(readJson(join(ctx.workspace, 'stack.lock.json')).layers.find((layer) => layer.name === 'pstack').source.path, first);
  const retained = runInstaller(shell, ctx);
  assertOk(retained);
  assert.equal(readJson(join(ctx.workspace, 'stack.lock.json')).layers.find((layer) => layer.name === 'pstack').source.path, first);

  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: 'local:source-two' } } });
  const settingsWins = runInstaller(shell, ctx);
  assertOk(settingsWins);
  assert.equal(readJson(join(ctx.workspace, 'stack.lock.json')).layers.find((layer) => layer.name === 'pstack').source.path, second);

  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: 'local:source-one' } } });
  const flagWins = runInstaller(shell, ctx, ['-Source', `pstack=local:${second}`]);
  assertOk(flagWins);
  lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  assert.equal(lock.layers.find((layer) => layer.name === 'pstack').source.path, second);

  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: 'default' } } });
  const reset = runInstaller(shell, ctx);
  assertOk(reset);
  lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  assert.equal(lock.layers.find((layer) => layer.name === 'pstack').source.override, false);
}, {});

withWorkspace('read-only modes report and skip a missing local settings source, while apply refuses it', (ctx) => {
  const baseline = runInstaller(shell, ctx);
  assertOk(baseline);
  const lockPath = join(ctx.workspace, 'stack.lock.json');
  const before = readFileSync(lockPath, 'utf8');
  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: 'local:missing-source' } } });

  const audit = runInstaller(shell, ctx, [], { apply: false });
  assertOk(audit);
  assert.match(plainOutput(audit), /pstack: declared source skipped/);
  assert.doesNotMatch(plainOutput(audit), /pstack: override, local/i, 'the skipped layer is listed as an override in use');
  assert.match(plainOutput(audit), /folder missing|no folder/i);
  assert.match(plainOutput(audit), /layers\.pstack\.source resolves to no folder at .*missing-source\. This run skips layer pstack and has no fallback\./);
  const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assertOk(status);
  assert.match(plainOutput(status), /layers\.pstack\.source resolves to no folder at .*missing-source\. This run skips layer pstack and has no fallback\./);
  const update = runInstaller(shell, ctx, ['-Update', '-Check'], { apply: false });
  assertOk(update);
  assert.match(plainOutput(update), /layers\.pstack\.source resolves to no folder at .*missing-source\. This run skips layer pstack/);
  assert.equal(readFileSync(lockPath, 'utf8'), before);

  const treeBefore = snapshotTree(ctx.workspace);
  const apply = runInstaller(shell, ctx);
  assert.notEqual(apply.status, 0);
  assert.match(plainOutput(apply), /maxstack\.settings\.json: layers\.pstack\.source resolves to no folder at .*missing-source\. Fix it there, or repair with: pwsh -File scripts\/Install-Workspace\.ps1 -Source pstack=default -Apply/);
  assert.equal(readFileSync(lockPath, 'utf8'), before);
  assert.deepEqual(snapshotTree(ctx.workspace), treeBefore, 'a refused apply changed the workspace');
}, {});

withWorkspace('read-only modes report and skip an unreadable local settings source, while apply refuses it', (ctx) => {
  const baseline = runInstaller(shell, ctx);
  assertOk(baseline);
  const lockPath = join(ctx.workspace, 'stack.lock.json');
  const lockBefore = readFileSync(lockPath, 'utf8');
  const source = join(ctx.workspace, 'bad-source');
  cpSync(ctx.fixture.dir, source, { recursive: true });
  writeFileSync(join(source, '.git', 'config'), '[core\ninvalid config\n');
  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: 'local:bad-source' } } });

  for (const args of [[], ['-Status'], ['-Update', '-Check']]) {
    const run = runInstaller(shell, ctx, args, { apply: false });
    assertOk(run);
    assert.match(plainOutput(run), /layers\.pstack\.source cannot be read at .*bad-source: .*This run skips layer pstack/i, args.join(' ') || 'audit');
  }

  const apply = runInstaller(shell, ctx);
  assert.notEqual(apply.status, 0);
  assert.match(plainOutput(apply), /maxstack\.settings\.json: layers\.pstack\.source cannot be read at .*bad-source/i);
  assert.equal(readFileSync(lockPath, 'utf8'), lockBefore, 'apply changed the lock before refusing the source');
}, {});

withWorkspace('settings local sources reject controls and traversal before any Git starts', (ctx) => {
  const trace = join(ctx.base, 'settings-source-git.trace');
  const invalidSources = [
    ['local:../sentinel', /unsafe local path/],
    [`local:bad${String.fromCharCode(127)}path`, /holds the character \\u007F/],
    ['https://host/repo.git@invalid ref', /non-empty source string|supported source/],
    ['local:C:relative', /unsafe local path/],
    ['local:\\rooted', /unsafe local path/],
  ];
  for (const [source, message] of invalidSources) {
    writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source } } });
    const run = runInstaller(shell, ctx, [], { apply: false, env: { ...testEnvironment(), GIT_TRACE: trace } });
    assert.notEqual(run.status, 0, source);
    assert.match(plainOutput(run), message, source);
    assert.equal(existsSync(trace), false, 'Git started before the settings source was refused');
  }
}, {});

withWorkspace('a settings source that links outside the workspace is skipped by a read-only run and refused by apply', (ctx) => {
  mustApply(ctx);
  const outside = join(ctx.base, 'outside-source');
  const link = join(ctx.workspace, 'linked-source');
  mkdirSync(outside);
  symlinkSync(outside, link, 'junction');
  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: 'local:linked-source' } } });
  const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assertOk(status);
  assert.match(plainOutput(status), /layers\.pstack\.source local path resolves outside the workspace through a link, which cannot be a layer source\. This run skips layer pstack/);
  const apply = runInstaller(shell, ctx);
  assert.notEqual(apply.status, 0);
  assert.match(plainOutput(apply), /resolves outside the workspace through a link/);
  assert.equal(existsSync(join(outside, 'plugins', 'pstack')), false);
}, {});

const SHY = '\u00ad';

// Finding 7: default with a soft hyphen or a zero width space is refused by flag and by settings, and the override is kept.
withWorkspace('finding 7: default with a soft hyphen or a zero width space is refused by flag and by settings, and the override is kept', (ctx) => {
  const extA = localCheckout(ctx, 'ext-a');
  mustApply(ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${extA}`]);
  const before = lockText(ctx);
  for (const value of [`default${SHY}`, `default${ZWSP}`]) {
    const flagRun = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=${value}`]);
    assert.notEqual(flagRun.status, 0, `flag ${escapedChar(value.slice(7))}: ${plainOutput(flagRun)}`);
    assert.match(plainOutput(flagRun), /holds the character \\u00AD|holds the character \\u200B/);
    writeWorkspaceSettings(ctx, { version: 1, layers: { 'simpsonm09-org-ai-plugin': { source: value } } });
    const settingsRun = runInstaller(shell, ctx);
    assert.notEqual(settingsRun.status, 0, `settings: ${plainOutput(settingsRun)}`);
    assert.match(plainOutput(settingsRun), /layers\.simpsonm09-org-ai-plugin\.source .*holds the character \\u00AD|layers\.simpsonm09-org-ai-plugin\.source .*holds the character \\u200B/);
    assert.equal(lockText(ctx), before, `${value} dropped the recorded override`);
  }
}, {});

// Finding 4: a root-relative local path with one leading slash is refused by the settings reader, and by -Source.
withWorkspace('finding 4: a root-relative local path with one leading slash is refused by settings and -Source', (ctx) => {
  mustApply(ctx);
  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: 'local:/x/y' } } });
  const settingsRun = runInstaller(shell, ctx, [], { apply: false });
  assert.notEqual(settingsRun.status, 0, plainOutput(settingsRun));
  assert.match(plainOutput(settingsRun), /layers\.pstack\.source has an unsafe local path/);
  writeWorkspaceSettings(ctx, { version: 1 });
  const flagRun = runInstaller(shell, ctx, ['-Source', 'pstack=local:/x/y'], { apply: false });
  assert.notEqual(flagRun.status, 0, plainOutput(flagRun));
  assert.match(plainOutput(flagRun), /needs an absolute path/);
}, {});

// Finding 5: UNC and device-namespace text is refused by its text, in settings and in -Source and -LayerSource.
withWorkspace('finding 5: UNC and device-namespace local paths are refused by their text, in settings and in -Source', (ctx) => {
  mustApply(ctx);
  const forms = ['\\\\server\\share\\x', '//server/share/x', '\\\\?\\C:\\x', '\\\\.\\C:\\x'];
  for (const form of forms) {
    writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: `local:${form}` } } });
    const run = runInstaller(shell, ctx, [], { apply: false });
    assert.notEqual(run.status, 0, `${form}: ${plainOutput(run)}`);
    assert.match(plainOutput(run), /UNC or device path/, form);
    writeWorkspaceSettings(ctx, { version: 1 });
    const flag = runInstaller(shell, ctx, ['-Source', `pstack=local:${form}`], { apply: false });
    assert.notEqual(flag.status, 0, `-Source ${form}: ${plainOutput(flag)}`);
    assert.match(plainOutput(flag), /UNC or device path/, `-Source ${form}`);
    const layerFlag = runInstaller(shell, ctx, ['-LayerSource', `pstack=${form}`], { apply: false });
    assert.notEqual(layerFlag.status, 0, `-LayerSource ${form}: ${plainOutput(layerFlag)}`);
    assert.match(plainOutput(layerFlag), /UNC or device path/, `-LayerSource ${form}`);
  }
}, {});

// Finding 3 contract: a real -Uninstall never reads the settings file, so an unreadable one does not stop it, and a dry
// -Uninstall with an unreadable file still succeeds.
withWorkspace('finding 3: -Uninstall never needs the settings file to succeed, dry or real', (ctx) => {
  mustApply(ctx);
  writeFileSync(join(ctx.workspace, 'maxstack.settings.json'), '{"version": 1,}');
  const dry = runInstaller(shell, ctx, ['-Uninstall'], { apply: false });
  assertOk(dry, plainOutput(dry));
  const real = runInstaller(shell, ctx, ['-Uninstall'], { apply: true });
  assertOk(real, plainOutput(real));
  assert.equal(existsSync(lockPath(ctx)), false, 'the real uninstall kept the lock');
}, {});

// Finding 15: an absolute maxstack checkout is refused as a source, by settings and by -Source.
withWorkspace('finding 15: an absolute maxstack checkout is refused as a source, by settings and by -Source', (ctx) => {
  mustApply(ctx);
  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: `local:${repoRoot}` } } });
  const settingsRun = runInstaller(shell, ctx, [], { apply: false });
  assertOk(settingsRun, plainOutput(settingsRun));
  assert.match(plainOutput(settingsRun), /local path is a maxstack checkout/);
  writeWorkspaceSettings(ctx, { version: 1 });
  const flag = runInstaller(shell, ctx, ['-Source', `pstack=local:${repoRoot}`], { apply: false });
  assert.notEqual(flag.status, 0, plainOutput(flag));
  assert.match(plainOutput(flag), /maxstack checkout/);
}, {});

// Mutant S05: a settings file over the 64 KiB limit is refused, whatever its content, and the message names the limit.
withWorkspace('the settings reader refuses a valid file of 100 KiB, and the message names the 64 KiB limit', (ctx) => {
  const prefix = '{"version":1,"$schema":"';
  const suffix = '"}';
  writeFileSync(join(ctx.workspace, 'maxstack.settings.json'), `${prefix}${'a'.repeat(100 * 1024 - prefix.length - suffix.length)}${suffix}`);
  const run = runInstaller(shell, ctx, [], { apply: false });
  assert.notEqual(run.status, 0, plainOutput(run));
  assert.match(plainOutput(run), /larger than the 65536 byte limit/);
}, {});

// Survivors of the mutation run: each test fails on the mutant its name gives.
withWorkspace('a settings source whose folder cannot be listed is unavailable in a read-only run, and refused by apply', (ctx) => {
  mustApply(ctx);
  const locked = join(ctx.base, 'locked-source');
  mkdirSync(locked);
  writeFileSync(join(locked, 'index.ts'), 'export default {};\n');
  const user = process.env.USERNAME;
  assert.ok(user, 'USERNAME is needed to deny the folder to this user');
  const deny = spawnSync('icacls', [locked, '/deny', `${user}:(RX)`], { windowsHide: true, encoding: 'utf8' });
  assert.equal(deny.status, 0, `icacls could not deny the folder: ${deny.stdout}${deny.stderr}`);
  try {
    writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: `local:${locked}` } } });
    const audit = runInstaller(shell, ctx, [], { apply: false });
    assertOk(audit, plainOutput(audit));
    assert.match(plainOutput(audit), /layers\.pstack\.source cannot be read at .*: the folder could not be listed\. This run skips layer pstack/);
    const apply = runInstaller(shell, ctx);
    assert.notEqual(apply.status, 0, plainOutput(apply));
  } finally {
    spawnSync('icacls', [locked, '/remove:d', user], { windowsHide: true, encoding: 'utf8' });
  }
}, {});

withWorkspace('a settings source at a drive root is unavailable in a read-only run, and refused by apply', (ctx) => {
  mustApply(ctx);
  const root = parsePath(tmpdir()).root;
  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: `local:${root}` } } });
  const audit = runInstaller(shell, ctx, [], { apply: false });
  assertOk(audit, plainOutput(audit));
  assert.match(plainOutput(audit), /layers\.pstack\.source local path is a drive or share root, which cannot be a layer source\. This run skips layer pstack/);
  const apply = runInstaller(shell, ctx);
  assert.notEqual(apply.status, 0, plainOutput(apply));
}, {});

withWorkspace('settings resolution refuses a traversal and reads an external recorded path without touching it', (ctx) => {
  const layerSources = join(repoRoot, 'scripts', 'Install-LayerSources.ps1').replaceAll("'", "''");
  const settings = join(repoRoot, 'scripts', 'Install-Settings.ps1').replaceAll("'", "''");
  const discovery = join(repoRoot, 'scripts', 'Install-WorkspaceDiscovery.ps1').replaceAll("'", "''");
  const ordinal = join(repoRoot, 'scripts', 'Install-Ordinal.ps1').replaceAll("'", "''");
  const ws = ctx.workspace.replaceAll("'", "''");
  const external = join(ctx.base, 'external-checkout');
  const script = `$ErrorActionPreference = 'Stop'; . '${ordinal}'; . '${discovery}'; . '${layerSources}'; . '${settings}';$Workspace = '${ws}'; ` +
    `$traversal = Get-SettingsLocalSource -Name pstack -Path '../outside' -Absolute $false -WorkspaceRoot '${ws}' -RepoRoot 'C:\\nowhere-maxstack'; ` +
    `"TRAVERSAL=$($traversal.reason)"; "UNREADABLE=$(Test-SettingsLocalReadable -Path '${ws}\\missing-for-probe')"; ` +
    `"EXTERNAL=$(ConvertTo-InitSettingsSpec -Name pstack -Source ([pscustomobject]@{ kind = 'local'; path = '${external.replaceAll("'", "''")}' }) -WorkspaceRoot '${ws}')"`;
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', env: testEnvironment() });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /TRAVERSAL=local path resolves outside the workspace through a link/);
  assert.match(run.stdout, /UNREADABLE=False/);
  assert.ok(run.stdout.includes(`EXTERNAL=local:${external}`), run.stdout);
  assert.equal(existsSync(external), false, 'the resolver created the external folder');
}, {});

withWorkspace('settings and -Source share one source grammar, and -Source still needs an absolute local path', (ctx) => {
  const layerSources = join(repoRoot, 'scripts', 'Install-LayerSources.ps1').replaceAll("'", "''");
  const settings = join(repoRoot, 'scripts', 'Install-Settings.ps1').replaceAll("'", "''");
  const discovery = join(repoRoot, 'scripts', 'Install-WorkspaceDiscovery.ps1').replaceAll("'", "''");
  const ordinal = join(repoRoot, 'scripts', 'Install-Ordinal.ps1').replaceAll("'", "''");
  const ws = ctx.workspace.replaceAll("'", "''");
  const script = `$ErrorActionPreference = 'Stop'; . '${ordinal}'; . '${discovery}'; . '${layerSources}'; . '${settings}';$Workspace = '${ws}'; ` +
    `function Invoke-GitGuarded { param($Arguments, $Dir, $AllFilterScopes) [pscustomobject]@{ code = 0; unreadable = $null; stdout = @() } }; ` +
    `$pairs = @(@('feat(ready)', 'pstack/repo@feat(ready)'), @('url&segment', 'https://host/url&segment.git@main')); ` +
    `foreach ($pair in $pairs) { try { Assert-SettingsSource pstack $pair[1]; $settingsOk = $true } catch { $settingsOk = $false }; try { $null = Read-SourceSpec pstack $pair[1]; $sharedOk = $true } catch { $sharedOk = $false }; "PAIR=$($pair[0]);SETTINGS=$settingsOk;SHARED=$sharedOk" }; ` +
    `try { $null = Read-SourceSpec pstack 'local:relative/checkout'; 'RELATIVE=accepted' } catch { "RELATIVE=$($_.Exception.Message)" }; ` +
    `$local = Get-SettingsLayerSource -Name pstack -Spec 'local:file&name' -WorkspaceRoot '${ws}' -RepoRoot 'C:\\nowhere-maxstack'; "LOCAL=$($local.kind)"`;
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', env: testEnvironment() });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /PAIR=feat\(ready\);SETTINGS=True;SHARED=True/);
  assert.match(run.stdout, /PAIR=url&segment;SETTINGS=True;SHARED=True/);
  assert.match(run.stdout, /RELATIVE=-Source pstack=local:relative\/checkout needs an absolute path/);
  assert.match(run.stdout, /LOCAL=unavailable/);
}, {});

withWorkspace('settings relative local sources reject protected output paths before reading them', (ctx) => {
  mustApply(ctx);
  for (const source of ['local:.maxstack', 'local:.claude', 'local:.opencode', 'local:.pi']) {
    writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source } } });
    const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
    assertOk(status, plainOutput(status));
    assert.match(plainOutput(status), /layers\.pstack\.source local path is inside \.[a-z]+, which the installer writes, so it cannot be a layer source\. This run skips layer pstack/, source);
    const before = snapshotTree(ctx.workspace);
    const apply = runInstaller(shell, ctx);
    assert.notEqual(apply.status, 0, source);
    assert.match(plainOutput(apply), /local path is inside (?:\.maxstack|\.claude|\.opencode|\.pi), which the installer writes/i, source);
    assert.deepEqual(snapshotTree(ctx.workspace), before, `${source} changed the workspace`);
  }
}, {});

withWorkspace('a settings relative source may not name the workspace, a maxstack checkout, or a link into a protected output', (ctx) => {
  mustApply(ctx);
  const checkout = join(ctx.workspace, 'tools', 'fake-checkout');
  mkdirSync(join(checkout, 'scripts'), { recursive: true });
  writeFileSync(join(checkout, 'layers.json'), '{"layers":[]}');
  writeFileSync(join(checkout, 'scripts', 'Install-Workspace.ps1'), '# fake checkout\n');
  mkdirSync(join(ctx.workspace, '.claude', 'plugins'), { recursive: true });
  symlinkSync(join(ctx.workspace, '.claude', 'plugins'), join(ctx.workspace, 'linked-claude'), 'junction');
  const cases = [
    ['local:.', /local path is the workspace itself/],
    ['local:tools/fake-checkout', /local path is a maxstack checkout/],
    ['local:linked-claude', /local path is inside \.claude, which the installer writes/],
  ];
  for (const [source, message] of cases) {
    writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source } } });
    const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
    assertOk(status, plainOutput(status));
    assert.match(plainOutput(status), message, source);
    const apply = runInstaller(shell, ctx);
    assert.notEqual(apply.status, 0, source);
    assert.match(plainOutput(apply), message, source);
  }
}, {});

withWorkspace('a settings source that is a junction in the workspace is recorded by the name the user wrote', (ctx) => {
  mustApply(ctx);
  const real = join(ctx.workspace, 'real-checkout');
  cpSync(ctx.fixture.dir, real, { recursive: true });
  symlinkSync(real, join(ctx.workspace, 'linked-checkout'), 'junction');
  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: 'local:linked-checkout' } } });
  const applied = mustApply(ctx);
  const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  const pstack = lock.layers.find((layer) => layer.name === 'pstack');
  assert.equal(pstack.source.path, join(ctx.workspace, 'linked-checkout'));
  assert.doesNotMatch(plainOutput(applied), /real-checkout/);
}, {});

withWorkspace('a settings path with a format character is shown as an escape, and a long one is cut at 260 characters', (ctx) => {
  mustApply(ctx);
  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: 'local:zero\u200bwidth-missing' } } });
  const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assertOk(status);
  const text = plainOutput(status);
  assert.ok(text.includes('zero\\u200Bwidth-missing'), text);
  assert.ok(!text.includes('\u200b'), 'a format character reached the output raw');
  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: `local:${'a'.repeat(300)}` } } });
  const long = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assertOk(long);
  assert.match(plainOutput(long), /layers\.pstack\.source resolves to no folder at .*\.\.\./);
  assert.ok(!plainOutput(long).includes('a'.repeat(261)), 'a long value was not cut');
}, {});

withWorkspace('a settings git ref that cannot be read is unavailable in an audit and refused by apply, with no fallback', (ctx) => {
  mustApply(ctx);
  const lockPath = join(ctx.workspace, 'stack.lock.json');
  const lockBefore = readFileSync(lockPath, 'utf8');
  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: 'sample/nope@main' } } });
  const env = githubEnv(ctx);
  const audit = runInstaller(shell, ctx, [], { apply: false, env });
  // A read-only audit reads no git ref, so it cannot find one unreadable: it names the declaration and uses the recorded source.
  assertOk(audit, plainOutput(audit));
  assert.doesNotMatch(plainOutput(audit), /could not be read/);
  const status = runInstaller(shell, ctx, ['-Status'], { apply: false, env });
  assertOk(status, plainOutput(status));
  assert.match(plainOutput(status), /layers\.pstack\.source is declared; a read-only run uses the recorded source/);
  const apply = runInstaller(shell, ctx, [], { env });
  assert.notEqual(apply.status, 0);
  assert.match(plainOutput(apply), /maxstack\.settings\.json: layers\.pstack\.source cannot be used: its git ref could not be read/);
  assert.equal(readFileSync(lockPath, 'utf8'), lockBefore);
}, {});

withWorkspace('settings source drift compares Git refs and URL paths with ordinal case', (ctx) => {
  mustApply(ctx);
  const lockPath = join(ctx.workspace, 'stack.lock.json');
  const lock = readJson(lockPath);
  lock.layers.find((layer) => layer.name === 'pstack').source = {
    kind: 'git', url: 'https://host/Repo.git', ref: 'feat/Ready', commit: ctx.fixture.commit, override: true,
  };
  writeFileSync(lockPath, JSON.stringify(lock));
  for (const [source, differs] of [
    ['https://host/Repo.git@feat/Ready', false],
    ['https://host/repo.git@feat/Ready', true],
    ['https://host/Repo.git@feat/ready', true],
  ]) {
    writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source } } });
    const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
    assertOk(status, plainOutput(status));
    assert.equal(/layers\.pstack\.source differs from its recorded override/.test(plainOutput(status)), differs, source);
  }
}, {});

withWorkspace('no settings keeps only the documented Settings none line with a recorded local override', (ctx) => {
  const checkout = join(ctx.workspace, 'source-checkout');
  cpSync(ctx.fixture.dir, checkout, { recursive: true });
  mustApply(ctx, ['-Source', `pstack=local:${checkout}`]);
  const applied = runInstaller(shell, ctx);
  assertOk(applied, plainOutput(applied));
  assert.deepEqual(plainOutput(applied).split(/\r?\n/).filter((line) => line.startsWith('Settings:')), []);
}, {});

withWorkspace('remove ignores an invalid settings file and keeps the locked selection rules', (ctx) => {
  mustApply(ctx);
  writeWorkspaceSettings(ctx, { version: 1, runtimes: { claude: {} }, layers: { pstack: {} } });
  mustApply(ctx);
  const recordedSettings = readJson(join(ctx.workspace, 'stack.lock.json')).settings;
  writeFileSync(join(ctx.workspace, 'maxstack.settings.json'), '{ invalid');
  const run = runInstaller(shell, ctx, ['-Remove', '-Runtimes', 'pi'], { apply: true });
  assertOk(run);
  assert.doesNotMatch(plainOutput(run), /Settings:/);
  assert.deepEqual(readJson(join(ctx.workspace, 'stack.lock.json')).selection.runtimes, ['claude', 'copilot', 'opencode']);
  assert.deepEqual(readJson(join(ctx.workspace, 'stack.lock.json')).settings, recordedSettings);
}, {});

withWorkspace('remove warns about each removed name that the settings file still lists, and never blocks a removal', (ctx) => {
  const settingsPath = join(ctx.workspace, 'maxstack.settings.json');
  writeWorkspaceSettings(ctx, { version: 1, runtimes: { claude: {}, pi: {} }, layers: { pstack: {}, 'simpsonm09-personal-ai-plugin': {} } });
  mustApply(ctx);
  const settingsBytes = readFileSync(settingsPath);

  const dryRun = runInstaller(shell, ctx, ['-Remove', '-Runtimes', 'pi'], { apply: false });
  assertOk(dryRun);
  assert.match(plainOutput(dryRun), /Settings: runtime 'pi' is still listed in maxstack\.settings\.json; the next -Apply will select it again\. Remove it from the settings file to keep it removed\./);

  const removed = runInstaller(shell, ctx, ['-Remove', '-Runtimes', 'pi'], { apply: true });
  assertOk(removed);
  assert.match(plainOutput(removed), /Settings: runtime 'pi' is still listed in maxstack\.settings\.json/);
  assert.deepEqual(readJson(join(ctx.workspace, 'stack.lock.json')).selection.runtimes, ['claude']);
  assert.ok(readFileSync(settingsPath).equals(settingsBytes), 'the removal wrote the settings file');
  const status = runInstaller(shell, ctx, ['-Status', '-Strict'], { apply: false });
  assert.equal(status.status, 1, 'the listed name that is not selected should fail -Status -Strict as pending');
  assert.match(plainOutput(status), /pending runtime 'pi'/);

  const layerRemoved = runInstaller(shell, ctx, ['-Remove', '-Layers', 'simpsonm09-personal-ai-plugin'], { apply: true });
  assertOk(layerRemoved);
  assert.match(plainOutput(layerRemoved), /Settings: layer 'simpsonm09-personal-ai-plugin' is still listed in maxstack\.settings\.json/);

  // A settings file that cannot be read is not a reason to refuse a removal: the removal goes ahead, with no warning.
  mustApply(ctx, ['-Runtimes', 'pi']);
  writeFileSync(settingsPath, '{ invalid');
  const unreadable = runInstaller(shell, ctx, ['-Remove', '-Runtimes', 'pi'], { apply: true });
  assertOk(unreadable);
  assert.doesNotMatch(plainOutput(unreadable), /still listed/);
  assert.deepEqual(readJson(join(ctx.workspace, 'stack.lock.json')).selection.runtimes, ['claude']);
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

withWorkspace('a pi runtime without claude is rejected, because the Pi settings list the Claude folder skills', (ctx) => {
  const layers = writeLayers(ctx, (manifest) => {
    layerNamed(manifest, 'simpsonm09-personal-ai-plugin').runtimes = { opencode: {}, pi: {} };
  });
  const run = runInstaller(shell, ctx, [], { layersFile: layers });
  assert.notEqual(run.status, 0, 'the installer accepted pi without claude');
  assert.match(plainOutput(run), /declares pi, which lists the Claude plugin folder's skills, so it also needs claude/);
}, {});

withWorkspace('pi with no executable found warns, keeps the recorded wrappers, and its settings still list the layers', (ctx) => {
  mustApply(ctx);
  assert.ok(existsSync(join(ctx.workspace, '.maxstack', 'bin', 'pi.cmd')));

  const run = mustApply(ctx, ['-PiCommand', MISSING_PI]);
  assert.match(plainOutput(run), /Pi CLI not found/, run.stdout);
  assert.match(plainOutput(run), /Kept .*pi\.cmd.*because Pi was not found/, run.stdout);
  assert.ok(existsSync(join(ctx.workspace, '.maxstack', 'bin', 'pi.cmd')), 'the recorded Pi wrapper was removed for a Pi that was only missing on this run');
  assert.ok(existsSync(join(ctx.workspace, '.maxstack', 'bin', 'pi.sh')), 'the recorded Pi script was removed for a Pi that was only missing on this run');
  assert.ok(existsSync(join(ctx.workspace, '.pi', 'agent', 'settings.json')), 'the settings were not written without the CLI');

  const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  assert.equal(lock.pi.enabled, true, 'the lock dropped the wrappers it still holds');
  assert.ok(ownedRecord(lock, '.maxstack/bin/pi.cmd', 'file'), 'the lock no longer owns the kept Pi wrapper');
  assert.ok(lock.layers.every((record) => record.opencode.enabled), 'the OpenCode runtimes still install');
}, {});

withWorkspaceNeeding('python', python, 'the workspace verifier checks the Pi wrappers and the Pi settings', (ctx) => {
  mustApply(ctx);
  const home = join(ctx.base, 'home');
  mkdirSync(home);
  const verify = () => spawnSync(python, [join(repoRoot, 'scripts', 'verify-workspace-install.py'), '--workspace', ctx.workspace, '--home', home], { windowsHide: true, encoding: 'utf8' });
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

withWorkspace('a settings file the apply created is listed in createdFiles, with no created key', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  assert.deepEqual(lock.createdFiles, ['.pi/agent/settings.json', 'opencode.jsonc']);
  assert.equal(ownedRecord(lock, '.pi/agent/settings.json', 'json-entries', 'packages').createdKey, undefined);
}, {});

withWorkspace('a key the user adds to the Pi settings after the install survives, and only the installer entries go', (ctx) => {
  mustApply(ctx);
  writeFileSync(settingsPath(ctx), JSON.stringify({ ...readJson(settingsPath(ctx)), defaultModel: 'user-model' }, null, 2));
  assertOk(removal(ctx, ['-Uninstall']));
  assert.deepEqual(readJson(settingsPath(ctx)), { defaultModel: 'user-model' });
}, {});

withWorkspace('a hand edit of the Pi settings after the first apply leaves the original settings backup as it was', (ctx) => {
  writeFile(ctx.workspace, '.pi/agent/settings.json', USER_SETTINGS);
  mustApply(ctx);
  writeFileSync(settingsPath(ctx), JSON.stringify({ defaultModel: 'hand-edit' }, null, 2));
  mustApply(ctx);
  assert.equal(readFileSync(`${settingsPath(ctx)}.bak`, 'utf8'), USER_SETTINGS, 'the original settings backup was overwritten');
}, {});

withWorkspace('the first schema-2 apply over a schema-1 lock keeps an existing settings backup untouched', (ctx) => {
  writeFile(ctx.workspace, '.pi/agent/settings.json', USER_SETTINGS);
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  lock.ownedSchema = 1;
  delete lock.pi.settingsSha256;
  setLock(ctx, lock);
  writeFileSync(settingsPath(ctx), JSON.stringify({ defaultModel: 'hand-edit' }, null, 2));
  mustApply(ctx);
  assert.equal(readFileSync(`${settingsPath(ctx)}.bak`, 'utf8'), USER_SETTINGS, 'an existing backup was overwritten where the last write is unknown');
}, {});

withWorkspace('the Pi settings keep dates with offsets, nulls in lists, deep nesting, and key order exactly', (ctx) => {
  let deep = { leaf: 'x' };
  for (let level = 0; level < 40; level += 1) deep = { level: deep };
  const user = `{\n  "zeta": "2024-01-02T03:04:05+02:00",\n  "packages": [null, "user-package"],\n  "nested": ${JSON.stringify(deep)},\n  "alpha": 1.50\n}\n`;
  writeFile(ctx.workspace, '.pi/agent/settings.json', user);
  mustApply(ctx);
  const text = readFileSync(settingsPath(ctx), 'utf8');
  const parsed = JSON.parse(text);
  assert.equal(parsed.zeta, '2024-01-02T03:04:05+02:00', 'a date string changed');
  assert.deepEqual(parsed.packages.slice(0, 2), [null, 'user-package'], 'a null list item was dropped');
  assert.deepEqual(parsed.nested, deep, 'a deep value was truncated');
  assert.deepEqual(Object.keys(parsed), ['zeta', 'packages', 'nested', 'alpha', 'skills'], 'the key order changed');
  assert.match(text, /"alpha": 1\.50/, 'a number changed its text');
}, {});

withWorkspace('a Pi settings file with comments or trailing commas is refused by the apply, and is not rewritten', (ctx) => {
  const commented = '{\n  // the user\'s note\n  "defaultProvider": "user-provider",\n}\n';
  writeFile(ctx.workspace, '.pi/agent/settings.json', commented);
  const run = runInstaller(shell, ctx, [], { apply: true });
  assert.notEqual(run.status, 0, `the apply accepted a settings file that is not strict JSON\n${run.stdout}`);
  assert.match(plainOutput(run), /not strict JSON/);
  assert.equal(readFileSync(settingsPath(ctx), 'utf8'), commented, 'the settings file was rewritten');
}, {});

withWorkspace('a Pi settings file with a backup and a user-added key keeps the key, loses the installer entries, and keeps the backup', (ctx) => {
  writeFile(ctx.workspace, '.pi/agent/settings.json', USER_SETTINGS);
  mustApply(ctx);
  writeFileSync(settingsPath(ctx), JSON.stringify({ ...readJson(settingsPath(ctx)), defaultModel: 'user-model' }, null, 2));
  assertOk(removal(ctx, ['-Uninstall']));
  const settings = readJson(settingsPath(ctx));
  assert.equal(settings.defaultModel, 'user-model', 'the user key was lost');
  assert.deepEqual(settings.packages, ['user-package'], 'an installer entry stayed');
  assert.equal(readFileSync(`${settingsPath(ctx)}.bak`, 'utf8'), USER_SETTINGS, 'the backup was lost');
}, {});

// A plain .bak with no role is the file the install first replaced (review 2, item 4), so it is restored while the
// settings still hold the installer's text. The user's entries come back with it.
withWorkspace('a settings backup with no role is the file the install replaced, and it is restored while the settings hold the installer text', (ctx) => {
  writeFile(ctx.workspace, '.pi/agent/settings.json', USER_SETTINGS);
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  delete ownedRecord(lock, '.pi/agent/settings.json.bak', 'file').role;
  setLock(ctx, lock);
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(readFileSync(settingsPath(ctx), 'utf8'), USER_SETTINGS, 'the file the install replaced was not restored');
  assert.equal(existsSync(`${settingsPath(ctx)}.bak`), false, 'the restored backup was left behind');
}, {});

withWorkspace('a real schema-1 lock from a fresh install deletes the config and settings the installer created', (ctx) => {
  seedSchema1(ctx, 'fresh', [['opencode.jsonc', 'opencode.jsonc'], ['.pi/agent/settings.json', 'settings.json']]);
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.match(run.stdout, /^DELETE\s+opencode\.jsonc\s/m, run.stdout);
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc')), false, 'the installer-created config was kept');
  assert.equal(existsSync(join(ctx.workspace, '.pi', 'agent', 'settings.json')), false, 'the installer-created settings were kept');
  assert.equal(existsSync(lockPath(ctx)), false, 'the lock remains');
}, {});

// Review 2, item 7: a copy whose bytes an earlier backup already holds is not written again.
withWorkspace('a Pi settings rewrite that repeats an earlier version writes no new numbered backup', (ctx) => {
  mustApply(ctx);
  const edit = JSON.stringify({ ...readJson(settingsPath(ctx)), defaultModel: 'pi-rewrite' }, null, 2);
  writeFileSync(settingsPath(ctx), edit);
  mustApply(ctx);
  assert.equal(readFileSync(`${settingsPath(ctx)}.bak.1`, 'utf8'), edit);
  writeFileSync(settingsPath(ctx), edit);
  const run = mustApply(ctx);
  assert.equal(existsSync(`${settingsPath(ctx)}.bak.2`), false, 'an identical copy was written again');
  assert.match(run.stdout, /already kept in .*settings\.json\.bak\.1, so no new copy was made/, run.stdout);
  const uninstall = removal(ctx, ['-Uninstall']);
  assertOk(uninstall);
  assert.match(uninstall.stdout, /Kept on disk, not restored or deleted: .*\.pi\/agent\/settings\.json\.bak\.1/, uninstall.stdout);
  assert.equal(readFileSync(`${settingsPath(ctx)}.bak.1`, 'utf8'), edit, 'the kept copy changed');
}, {});

// Review 2, item 8: a settings file that is not strict JSON keeps its backup as a skip, with the record, and says so.
withWorkspace('a Pi settings file that is not strict JSON keeps its backup and its record, and the message says the backup stays', (ctx) => {
  writeFile(ctx.workspace, '.pi/agent/settings.json', USER_SETTINGS);
  mustApply(ctx);
  writeFileSync(settingsPath(ctx), '{\n  // a comment\n  "packages": []\n}\n');
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.match(run.stdout, /^SKIP\s+\.pi\/agent\/settings\.json\.bak\s+kept: the settings file could not be edited, so its original stays in place/m, run.stdout);
  assert.doesNotMatch(run.stdout, /only the installer entries were removed/, run.stdout);
  assert.equal(existsSync(lockPath(ctx)), true, 'the lock was removed');
  assert.ok(ownedRecord(readJson(lockPath(ctx)), '.pi/agent/settings.json.bak', 'file'), 'the backup record was dropped');
  assert.equal(readFileSync(`${settingsPath(ctx)}.bak`, 'utf8'), USER_SETTINGS, 'the backup changed');
}, {});

withWorkspace('a plain apply after a Pi settings restore that stopped keeps the user settings as the original, and uninstall restores them byte for byte', (ctx) => {
  writeFile(ctx.workspace, '.pi/agent/settings.json', USER_SETTINGS);
  mustApply(ctx);
  const crashed = withHook('crash:.pi/agent/settings.json', () => removal(ctx, ['-Uninstall']));
  assert.notEqual(crashed.status, 0, `the injected fault did not stop the run\n${crashed.stdout}`);
  assert.equal(readFileSync(settingsPath(ctx), 'utf8'), USER_SETTINGS, 'the restore did not happen before the fault');
  mustApply(ctx);
  assert.equal(readFileSync(`${settingsPath(ctx)}.bak`, 'utf8'), USER_SETTINGS, 'the user settings were not kept as the original');
  assert.equal(existsSync(`${settingsPath(ctx)}.bak.1`), false, 'the user settings were filed as an edited copy');
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(readFileSync(settingsPath(ctx), 'utf8'), USER_SETTINGS, 'the user settings were not restored byte for byte');
}, {});

// Review 3, item 2: an upgrade apply over a real schema-1 lock records the config the way uninstall infers it.
withWorkspace('an upgrade apply over a real schema-1 fresh lock records the config as created, and uninstall removes it and the settings', (ctx) => {
  seedSchema1(ctx, 'fresh', [['opencode.jsonc', 'opencode.jsonc'], ['.pi/agent/settings.json', 'settings.json']]);
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  assert.equal(lock.ownedSchema, 2);
  assert.ok(lock.createdFiles.includes('opencode.jsonc'), `createdFiles ${JSON.stringify(lock.createdFiles)}`);
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.doesNotMatch(run.stdout, /it existed before the install/, run.stdout);
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc')), false, 'the installer-created config was kept');
  assert.equal(existsSync(settingsPath(ctx)), false, 'the installer-created settings were kept');
  assert.equal(existsSync(lockPath(ctx)), false, 'the lock remains');
}, {});

withWorkspace('a valid settings source replaces a malformed recorded source before apply', (ctx) => {
  servedFeature(ctx);
  mustApply(ctx, ['-Source', 'pstack=simpsonm09/pstack-claude@feat'], { env: githubEnv(ctx) });
  const lock = readJson(lockPath(ctx));
  sourceBlockIn(lock, 'pstack').url = 'ext::sh -c touch x';
  setLock(ctx, lock);
  const source = join(ctx.workspace, 'settings-source');
  cpSync(ctx.fixture.dir, source, { recursive: true });
  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: 'local:settings-source' } } });
  const apply = runInstaller(shell, ctx);
  assertOk(apply, plainOutput(apply));
  assert.equal(sourceOf(ctx, 'pstack').source.kind, 'local');
  assert.equal(sourceOf(ctx, 'pstack').source.path, source);
}, {});

withWorkspace('the guard passes its filter settings to git in the child process, and leaves the installer environment as it was', (ctx) => {
  const tree = join(ctx.base, 'tree');
  mkdirSync(tree);
  gitRun(tree, ['init', '-q']);
  gitRun(tree, ['config', 'filter.a=b.clean', 'touch x']);
  const script = `$ErrorActionPreference = 'Stop'; . '${layerSourcesFile}'; $tree = '${tree.replace(/\\/g, '/')}'; $run = Invoke-GitGuarded -Dir $tree -Arguments @('-C', $tree, 'status', '--porcelain'); "CODE=$($run.code)"; "LEFT=[$env:GIT_CONFIG_COUNT]"`;
  const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, encoding: 'utf8', env: testEnvironment() });
  assertOk(run);
  assert.match(run.stdout, /CODE=0/, run.stdout);
  assert.match(run.stdout, /LEFT=\[\]/, 'the guard left its settings in the installer environment');
}, {});

// N5: an existing folder reached by its real 8.3 short name is refused by a settings source and by -Source, before normalisation.
withWorkspaceNeeding('8.3 short names', short83Available, 'item N5: an existing folder reached by its 8.3 short name is refused by settings and by -Source', (ctx) => {
  mustApply(ctx);
  const short = EXISTING_SHORT_FOLDER;
  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: `local:${short}` } } });
  const audit = runInstaller(shell, ctx, [], { apply: false });
  assertOk(audit, plainOutput(audit));
  assert.match(plainOutput(audit), /layers\.pstack\.source local path has an 8\.3 short name.*This run skips layer pstack and has no fallback\./, plainOutput(audit));
  const apply = runInstaller(shell, ctx);
  assert.notEqual(apply.status, 0, plainOutput(apply));
  assert.match(plainOutput(apply), /layers\.pstack\.source local path has an 8\.3 short name/, plainOutput(apply));
  writeWorkspaceSettings(ctx, { version: 1 });
  const flag = runInstaller(shell, ctx, ['-Source', `pstack=local:${short}`], { apply: false });
  assert.notEqual(flag.status, 0, plainOutput(flag));
  assert.match(plainOutput(flag), /-Source pstack=local:C:\\PROGRA~1 has an 8\.3 short name/, plainOutput(flag));
}, {});
