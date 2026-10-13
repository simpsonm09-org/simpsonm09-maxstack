// Installer tests for the runtime and layer selection that the lock records, and for -InitSettings, which seeds
// the settings file from that selection. Helpers come from ./lib/installer-test-kit.mjs.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync, mkdirSync, renameSync, symlinkSync, writeFileSync, cpSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse as parsePath } from 'node:path';
import { ALL_RUNTIMES, EXISTING_SHORT_FOLDER, LOCAL_LAYERS, MISSING_COPILOT, ORG_FOLDER, ORG_SOURCE, RLO, SKILL_PATH, ZWSP, assertOk, buildWorkspace, escapedChar, gitRun, githubEnv, installedSkill, isLink, localCheckout, lockPath, lockText, mustApply, plainOutput, problemRows, python, readJson, runInstaller, runStatus, runWorkspaceDiscovery, selectionOf, setLock, shell, short83Available, snapshotTree, sourceOf, testEnvironment, verifyManifestsScript, verifyWorkspaceScript, withWorkspace, withWorkspaceNeeding, workspaceFiles, writeFile, writeLayerStub, writeLayers, writeWorkspaceSettings } from './lib/installer-test-kit.mjs';

withWorkspace('-InitSettings prints a migrated seed and writes it only with -Apply', (ctx) => {
  const applied = runInstaller(shell, ctx);
  assertOk(applied);
  const beforeLock = readJson(join(ctx.workspace, 'stack.lock.json'));
  const beforeLockText = readFileSync(join(ctx.workspace, 'stack.lock.json'), 'utf8');
  const dryRun = runInstaller(shell, ctx, ['-InitSettings'], { apply: false });
  assertOk(dryRun);
  const expected = {
    version: 1,
    runtimes: Object.fromEntries(beforeLock.selection.runtimes.map((name) => [name, {}])),
    layers: Object.fromEntries(beforeLock.selection.layers.map((name) => [name, {}])),
  };
  assert.match(plainOutput(dryRun), /derived settings file/);
  assert.deepEqual(JSON.parse(dryRun.stdout.slice(dryRun.stdout.indexOf('{'))), expected);
  assert.equal(existsSync(join(ctx.workspace, 'maxstack.settings.json')), false);
  const write = runInstaller(shell, ctx, ['-InitSettings', '-Apply'], { apply: false });
  assertOk(write);
  assert.deepEqual(readJson(join(ctx.workspace, 'maxstack.settings.json')), expected);
  const lockAfter = readJson(join(ctx.workspace, 'stack.lock.json'));
  assert.deepEqual(lockAfter.selection, beforeLock.selection);
  assert.deepEqual(lockAfter.owned, beforeLock.owned);
  assert.equal(readFileSync(join(ctx.workspace, 'stack.lock.json'), 'utf8'), beforeLockText);
  const existing = runInstaller(shell, ctx, ['-InitSettings', '-Apply'], { apply: false });
  assert.notEqual(existing.status, 0, 'seeding overwrote an existing file');
  rmSync(join(ctx.workspace, 'maxstack.settings.json'));
  mkdirSync(join(ctx.workspace, 'maxstack.settings.json'));
  const directory = runInstaller(shell, ctx, ['-InitSettings', '-Apply'], { apply: false });
  assert.notEqual(directory.status, 0, 'seeding accepted a destination directory');
  assert.match(plainOutput(directory), /is a directory/i);
  rmSync(join(ctx.workspace, 'maxstack.settings.json'), { recursive: true });
  const target = join(ctx.base, 'settings-link-target');
  mkdirSync(target);
  symlinkSync(target, join(ctx.workspace, 'maxstack.settings.json'), 'junction');
  const link = runInstaller(shell, ctx, ['-InitSettings', '-Apply'], { apply: false });
  assert.notEqual(link.status, 0, 'seeding accepted a destination link');
  assert.match(plainOutput(link), /symbolic link or junction/i);
  rmSync(join(ctx.workspace, 'maxstack.settings.json'), { recursive: true, force: true });
  const fileTarget = join(ctx.base, 'settings-file-link-target');
  writeFileSync(fileTarget, '{}');
  try {
    symlinkSync(fileTarget, join(ctx.workspace, 'maxstack.settings.json'), 'file');
    const readOnlyLink = runInstaller(shell, ctx, ['-InitSettings'], { apply: false });
    assert.notEqual(readOnlyLink.status, 0, 'a dry seed accepted a destination file link');
    assert.match(plainOutput(readOnlyLink), /symbolic link or junction/i);
  } catch (error) {
    if (error.code !== 'EPERM') throw error;
  }
}, {});

withWorkspace('-InitSettings converts recorded git and in-workspace local overrides', (ctx) => {
  const applied = runInstaller(shell, ctx);
  assertOk(applied);
  const lockPath = join(ctx.workspace, 'stack.lock.json');
  const lock = readJson(lockPath);
  const pstack = lock.layers.find((layer) => layer.name === 'pstack');
  pstack.source = { kind: 'git', url: 'https://github.com/example-org/example-repo.git', ref: 'feature/settings', commit: ctx.fixture.commit, override: true };
  const localPath = join(ctx.workspace, 'seed-checkout');
  cpSync(ctx.fixture.dir, localPath, { recursive: true });
  const org = lock.layers.find((layer) => layer.name === 'simpsonm09-org-ai-plugin');
  org.source = { kind: 'local', url: null, ref: null, commit: ctx.fixture.commit, dirty: false, override: true, path: localPath };
  const personal = lock.layers.find((layer) => layer.name === 'simpsonm09-personal-ai-plugin');
  personal.source = { kind: 'git', url: 'https://git.example.invalid/team/example-layer.git', ref: 'v2', commit: ctx.fixture.commit, override: true };
  writeFileSync(lockPath, JSON.stringify(lock, null, 2));

  const trace = join(ctx.base, 'init-settings-git.trace');
  const seed = runInstaller(shell, ctx, ['-InitSettings'], { apply: false, env: { ...testEnvironment(), GIT_TRACE: trace } });
  assertOk(seed);
  assert.equal(existsSync(trace), false, 'seeding invoked Git to resolve the recorded branch');
  const value = JSON.parse(seed.stdout.slice(seed.stdout.indexOf('{')));
  assert.equal(value.layers.pstack.source, 'example-org/example-repo@feature/settings');
  assert.equal(value.layers['simpsonm09-org-ai-plugin'].source, 'local:seed-checkout');
  assert.equal(value.layers['simpsonm09-personal-ai-plugin'].source, 'https://git.example.invalid/team/example-layer.git@v2');
  assert.equal(existsSync(join(ctx.workspace, 'maxstack.settings.json')), false);

  org.source.path = join(ctx.base, 'outside-seed-checkout');
  mkdirSync(org.source.path);
  writeFileSync(lockPath, JSON.stringify(lock, null, 2));
  const absoluteSeed = runInstaller(shell, ctx, ['-InitSettings'], { apply: false });
  assertOk(absoluteSeed);
  const absoluteValue = JSON.parse(absoluteSeed.stdout.slice(absoluteSeed.stdout.indexOf('{')));
  assert.equal(absoluteValue.layers['simpsonm09-org-ai-plugin'].source, `local:${org.source.path}`);
  assert.match(plainOutput(absoluteSeed), /machine path/i);
}, {});

// Findings 9 and 10: a malformed lock source or selection is a named error for -Status, and -InitSettings names a missing selection.
withWorkspace('findings 9 and 10: a malformed lock source, selection, or InitSettings selection is a named error, not a raw one', (ctx) => {
  mustApply(ctx);
  const good = readJson(lockPath(ctx));
  const cases = [
    ['a layer source with no kind', (lock) => { lock.layers[0].source = {}; }, ['-Status'], /stack\.lock\.json/],
    ['a selection with no runtimes', (lock) => { delete lock.selection.runtimes; }, ['-Status'], /runtime/],
    ['an InitSettings selection with no runtimes', (lock) => { delete lock.selection.runtimes; }, ['-InitSettings'], /-InitSettings needs a valid recorded runtimes selection/],
  ];
  for (const [label, mutate, args, message] of cases) {
    const lock = structuredClone(good);
    mutate(lock);
    writeFileSync(lockPath(ctx), JSON.stringify(lock));
    const run = runInstaller(shell, ctx, args, { apply: false });
    assert.notEqual(run.status, 0, `${label}: ${plainOutput(run)}`);
    assert.match(plainOutput(run), message, label);
    assert.doesNotMatch(plainOutput(run), /The property '|cannot be found on this object|at <ScriptBlock>/, label);
  }
}, {});

// Finding 11: an InitSettings seed refuses a recorded layer whose lock name holds a zero width space.
withWorkspace('finding 11: -InitSettings refuses a lock layer record named with a zero width space, and prints no seed', (ctx) => {
  const extA = localCheckout(ctx, 'ext-a');
  mustApply(ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${extA}`]);
  const lock = readJson(lockPath(ctx));
  const record = lock.layers.find((layer) => layer.name === 'simpsonm09-org-ai-plugin');
  record.name = `simpsonm09-org-ai-plugin${ZWSP}`;
  writeFileSync(lockPath(ctx), JSON.stringify(lock));
  const run = runInstaller(shell, ctx, ['-InitSettings'], { apply: false });
  assert.notEqual(run.status, 0, plainOutput(run));
  assert.match(plainOutput(run), /holds the character \\u200B/);
  assert.doesNotMatch(plainOutput(run), /"simpsonm09-org-ai-plugin": \{/, 'the seed printed the layer');
}, {});

// Finding 14: a lock key in the wrong case is refused by -InitSettings and by apply, and the lock is unchanged.
withWorkspace('finding 14: a lock key in the wrong case is refused by -InitSettings and by apply, and the lock is unchanged', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  const renamed = Object.fromEntries(Object.entries(lock).map(([key, value]) => [key === 'ownedSchema' ? 'OwnedSchema' : key, value]));
  writeFileSync(lockPath(ctx), JSON.stringify(renamed));
  const before = lockText(ctx);
  const treeBefore = snapshotTree(ctx.workspace);
  const init = runInstaller(shell, ctx, ['-InitSettings'], { apply: false });
  assert.notEqual(init.status, 0, plainOutput(init));
  assert.match(plainOutput(init), /key 'OwnedSchema' must be spelled ownedSchema/);
  const apply = runInstaller(shell, ctx);
  assert.notEqual(apply.status, 0, plainOutput(apply));
  assert.match(plainOutput(apply), /key 'OwnedSchema' must be spelled ownedSchema/);
  assert.equal(lockText(ctx), before, 'a lock in the wrong case was rewritten');
  assert.deepEqual(snapshotTree(ctx.workspace), treeBefore);
}, {});

// Finding 12: -InitSettings checks a recorded local path by its text, so a path through a junction is seeded as written.
withWorkspace('finding 12: -InitSettings checks a recorded local path by its text, with no link resolution', (ctx) => {
  mustApply(ctx);
  const link = join(ctx.workspace, 'linked-ws');
  symlinkSync(ctx.workspace, link, 'junction');
  const lock = readJson(lockPath(ctx));
  const record = lock.layers.find((layer) => layer.name === 'pstack');
  record.source = { kind: 'local', url: null, ref: null, commit: null, dirty: null, override: true, path: link };
  writeFileSync(lockPath(ctx), JSON.stringify(lock));
  const run = runInstaller(shell, ctx, ['-InitSettings'], { apply: false });
  assertOk(run, plainOutput(run));
  assert.match(run.stdout, /"source": "local:linked-ws"/);
}, {});

// Mutant I02: -InitSettings -Apply refuses an existing file by name, with the refusal message and not only the exit status.
withWorkspace('-InitSettings -Apply refuses an existing settings file by its message, and changes nothing', (ctx) => {
  mustApply(ctx);
  writeWorkspaceSettings(ctx, { version: 1 });
  const before = readFileSync(join(ctx.workspace, 'maxstack.settings.json'), 'utf8');
  const run = runInstaller(shell, ctx, ['-InitSettings'], { apply: true });
  assert.notEqual(run.status, 0, plainOutput(run));
  assert.match(plainOutput(run), /-InitSettings refuses to overwrite existing .*maxstack\.settings\.json/);
  assert.equal(readFileSync(join(ctx.workspace, 'maxstack.settings.json'), 'utf8'), before);
}, {});

withWorkspace('-InitSettings refuses a recorded git source with a url that is not https, and one whose repository the seed cannot write', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  const record = lock.layers.find((layer) => layer.name === 'pstack');
  record.source = { kind: 'git', url: 'http://example.invalid/owner/repo.git', ref: 'main', commit: 'a'.repeat(40), dirty: null, override: true, path: null };
  writeFileSync(lockPath(ctx), JSON.stringify(lock));
  const insecure = runInstaller(shell, ctx, ['-InitSettings'], { apply: false });
  assert.notEqual(insecure.status, 0, plainOutput(insecure));
  assert.match(plainOutput(insecure), /cannot migrate the recorded git source for 'pstack' because its URL, ref, or commit is invalid/);
  record.source = { kind: 'git', url: 'https://github.com/owner/repo+x.git', ref: 'main', commit: 'a'.repeat(40), dirty: null, override: true, path: null };
  writeFileSync(lockPath(ctx), JSON.stringify(lock));
  const unwritable = runInstaller(shell, ctx, ['-InitSettings'], { apply: false });
  assert.notEqual(unwritable.status, 0, plainOutput(unwritable));
  assert.match(plainOutput(unwritable), /cannot represent the recorded source of layer 'pstack' as a settings source/);
}, {});

withWorkspace('-InitSettings refuses a recorded local path that is a drive root, by its text', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  const record = lock.layers.find((layer) => layer.name === 'pstack');
  record.source = { kind: 'local', url: null, ref: null, commit: null, dirty: null, override: true, path: parsePath(tmpdir()).root };
  writeFileSync(lockPath(ctx), JSON.stringify(lock));
  const run = runInstaller(shell, ctx, ['-InitSettings'], { apply: false });
  assert.notEqual(run.status, 0, plainOutput(run));
  assert.match(plainOutput(run), /cannot migrate the recorded local source for 'pstack': is a drive or share root/);
}, {});

withWorkspace('a recorded selection that names only runtimes and layers layers.json no longer has falls back to every name', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  lock.selection = { runtimes: ['retired-runtime'], layers: ['retired-layer'] };
  writeFileSync(lockPath(ctx), JSON.stringify(lock));
  const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assertOk(status, plainOutput(status));
  assert.match(plainOutput(status), /Selection: runtimes claude, copilot, opencode, pi; layers pstack, simpsonm09-org-ai-plugin, simpsonm09-personal-ai-plugin/);
  // A plain apply after that lock writes every name, so the retired names are not kept in the selection.
  const apply = runInstaller(shell, ctx, []);
  assertOk(apply, plainOutput(apply));
  assert.deepEqual(readJson(lockPath(ctx)).selection.runtimes, ['claude', 'copilot', 'opencode', 'pi']);
  assert.deepEqual(readJson(lockPath(ctx)).selection.layers, ['pstack', 'simpsonm09-org-ai-plugin', 'simpsonm09-personal-ai-plugin']);
}, {});

withWorkspace('-InitSettings refuses a lock with no ownedSchema, and never overwrites a settings file made by a hard link', (ctx) => {
  mustApply(ctx);
  const lockPath = join(ctx.workspace, 'stack.lock.json');
  const lock = readJson(lockPath);
  delete lock.ownedSchema;
  writeFileSync(lockPath, JSON.stringify(lock));
  const trace = join(ctx.base, 'init-no-schema.trace');
  const noSchema = runInstaller(shell, ctx, ['-InitSettings'], { apply: false, env: { ...githubEnv(ctx), GIT_TRACE: trace } });
  assert.notEqual(noSchema.status, 0);
  assert.match(plainOutput(noSchema), /ownedSchema 1 or 2/);
  assert.equal(existsSync(trace), false, 'a refused seed started Git');
  writeFileSync(lockPath, JSON.stringify({ ...lock, ownedSchema: 2 }));

  const other = join(ctx.base, 'other-settings.json');
  writeFileSync(other, '{"version":1}');
  linkSync(other, join(ctx.workspace, 'maxstack.settings.json'));
  const dry = runInstaller(shell, ctx, ['-InitSettings'], { apply: false });
  assertOk(dry);
  assert.match(plainOutput(dry), /exists, so -Apply would refuse to overwrite it/);
  const write = runInstaller(shell, ctx, ['-InitSettings', '-Apply'], { apply: false });
  assert.notEqual(write.status, 0);
  assert.equal(readFileSync(other, 'utf8'), '{"version":1}', 'the hard-linked file was overwritten');
}, {});

withWorkspace('-InitSettings refuses a stack.lock.json that is a junction, and reads nothing through it', (ctx) => {
  mustApply(ctx);
  const lockPath = join(ctx.workspace, 'stack.lock.json');
  const lockBackup = readFileSync(lockPath, 'utf8');
  rmSync(lockPath);
  const elsewhere = join(ctx.base, 'elsewhere-lock-folder');
  mkdirSync(elsewhere);
  writeFileSync(join(elsewhere, 'stack.lock.json'), lockBackup);
  symlinkSync(elsewhere, lockPath, 'junction');
  const trace = join(ctx.base, 'init-linked-lock.trace');
  const seed = runInstaller(shell, ctx, ['-InitSettings'], { apply: false, env: { ...githubEnv(ctx), GIT_TRACE: trace } });
  assert.notEqual(seed.status, 0);
  assert.match(plainOutput(seed), /stack\.lock\.json: it is a symbolic link or junction/);
  assert.equal(existsSync(join(ctx.workspace, 'maxstack.settings.json')), false);
  assert.equal(existsSync(trace), false, 'a refused seed started Git');
}, {});

withWorkspace('-InitSettings seeds the migration fixture selection exactly: four runtimes and three layers', (ctx) => {
  mustApply(ctx);
  const lock = readJson(join(ctx.workspace, 'stack.lock.json'));
  assert.deepEqual([...lock.selection.runtimes].sort(), ['claude', 'copilot', 'opencode', 'pi']);
  assert.deepEqual([...lock.selection.layers].sort(), ['pstack', 'simpsonm09-org-ai-plugin', 'simpsonm09-personal-ai-plugin']);
  const seed = runInstaller(shell, ctx, ['-InitSettings'], { apply: false });
  assertOk(seed);
  const value = JSON.parse(seed.stdout.slice(seed.stdout.indexOf('{')));
  assert.deepEqual(value, {
    version: 1,
    runtimes: { claude: {}, copilot: {}, opencode: {}, pi: {} },
    layers: { pstack: {}, 'simpsonm09-org-ai-plugin': {}, 'simpsonm09-personal-ai-plugin': {} },
  });
}, {});

withWorkspace('a format character in a recorded path is refused by -Source and by -InitSettings, with the escape shown', (ctx) => {
  mustApply(ctx);
  const folder = join(ctx.workspace, 'seed\u200bcheckout');
  cpSync(ctx.fixture.dir, folder, { recursive: true });
  const flag = runInstaller(shell, ctx, ['-Source', `pstack=local:${folder}`], { apply: false });
  assert.notEqual(flag.status, 0, plainOutput(flag));
  assert.match(plainOutput(flag), /holds the character \\u200B/);
  assert.ok(!plainOutput(flag).includes('\u200b'), 'a format character reached the output raw');
  const lock = readJson(lockPath(ctx));
  const record = lock.layers.find((layer) => layer.name === 'pstack');
  record.source = { kind: 'local', url: null, ref: null, commit: null, dirty: null, override: true, path: folder };
  writeFileSync(lockPath(ctx), JSON.stringify(lock));
  const seed = runInstaller(shell, ctx, ['-InitSettings'], { apply: false });
  assert.notEqual(seed.status, 0, plainOutput(seed));
  assert.match(plainOutput(seed), /stack\.lock\.json.*holds the character \\u200B/);
  assert.ok(!seed.stdout.includes('\u200b'), 'a format character reached the seed raw');
}, {});

withWorkspace('-InitSettings refuses malformed or invalid lock selection data without writes or Git', (ctx) => {
  mustApply(ctx);
  const lockPath = join(ctx.workspace, 'stack.lock.json');
  const original = readFileSync(lockPath, 'utf8');
  const lock = readJson(lockPath);
  const badLocks = [
    ['duplicate key', original.replace('{', '{"ownedSchema":2,')],
    ['unknown runtime', JSON.stringify({ ...lock, selection: { ...lock.selection, runtimes: ['fake-runtime'] } })],
    ['unknown layer', JSON.stringify({ ...lock, selection: { ...lock.selection, layers: ['fake-layer'] } })],
    ['unknown selection field', JSON.stringify({ ...lock, selection: { ...lock.selection, extra: true } })],
    ['wrong selection type', JSON.stringify({ ...lock, selection: { ...lock.selection, runtimes: 'claude' } })],
    ['unsupported numeric owned schema', JSON.stringify({ ...lock, ownedSchema: 3 })],
    ['unsupported string owned schema', JSON.stringify({ ...lock, ownedSchema: '2' })],
    ['malformed layer record type', JSON.stringify({ ...lock, layers: [null, ...lock.layers.slice(1)] })],
    ['duplicate layer record', JSON.stringify({ ...lock, layers: [lock.layers[0], ...lock.layers] })],
    ['unknown layer record', JSON.stringify({ ...lock, layers: [{ ...lock.layers[0], name: 'not-a-layer' }, ...lock.layers.slice(1)] })],
    ['non-string source record', JSON.stringify({ ...lock, layers: [{ ...lock.layers[0], source: 4 }, ...lock.layers.slice(1)] })],
    ['non-object source record', JSON.stringify({ ...lock, layers: [{ ...lock.layers[0], source: true }, ...lock.layers.slice(1)] })],
    ['non-boolean source override', JSON.stringify({ ...lock, layers: [{ ...lock.layers[0], source: { kind: 'git', override: 'true' } }, ...lock.layers.slice(1)] })],
    ['deep JSON', `${'{"x":'.repeat(40)}0${'}'.repeat(40)}`],
    ['oversize JSON', `{"padding":"${'x'.repeat(65540)}"}`],
    ['invalid UTF-8', Buffer.concat([Buffer.from('{"selection":'), Buffer.from([0xc3, 0x28]), Buffer.from('}')])],
  ];
  const trace = join(ctx.base, 'init-invalid-lock-git.trace');
  for (const [name, value] of badLocks) {
    writeFileSync(lockPath, value);
    const run = runInstaller(shell, ctx, ['-InitSettings'], { apply: false, env: { ...testEnvironment(), GIT_TRACE: trace } });
    assert.notEqual(run.status, 0, name);
    assert.equal(existsSync(join(ctx.workspace, 'maxstack.settings.json')), false, name);
    assert.equal(existsSync(trace), false, `${name} invoked Git`);
  }
  writeFileSync(lockPath, original);
}, {});

withWorkspace('-InitSettings reads old locks whose layer sources are legacy strings', (ctx) => {
  const baseline = runInstaller(shell, ctx);
  assertOk(baseline);
  const lockPath = join(ctx.workspace, 'stack.lock.json');
  const lock = readJson(lockPath);
  for (const layer of lock.layers) layer.source = 'legacy-source-string';
  for (const schema of [1, 2]) {
    lock.ownedSchema = schema;
    writeFileSync(lockPath, JSON.stringify(lock));
    const seed = runInstaller(shell, ctx, ['-InitSettings'], { apply: false });
    assertOk(seed);
    const value = JSON.parse(seed.stdout.slice(seed.stdout.indexOf('{')));
    assert.deepEqual(Object.keys(value.layers).sort(), lock.selection.layers.slice().sort());
    assert.ok(Object.values(value.layers).every((layer) => !Object.hasOwn(layer, 'source')));
  }
}, {});

withWorkspace('-InitSettings local source seed reapplies in a fresh workspace with equivalent override records', (ctx) => {
  const pstackOverride = join(ctx.workspace, 'pstack-override');
  const orgOverride = join(ctx.workspace, 'org-override');
  cpSync(ctx.fixture.dir, pstackOverride, { recursive: true });
  cpSync(join(ctx.workspace, LOCAL_LAYERS[0]), orgOverride, { recursive: true });
  const firstApply = runInstaller(shell, ctx, ['-Source', `pstack=local:${pstackOverride},simpsonm09-org-ai-plugin=local:${orgOverride}`]);
  assertOk(firstApply);
  const firstLock = readJson(join(ctx.workspace, 'stack.lock.json'));
  const seedRun = runInstaller(shell, ctx, ['-InitSettings'], { apply: false });
  assertOk(seedRun);
  const seed = JSON.parse(seedRun.stdout.slice(seedRun.stdout.indexOf('{')));
  assert.equal(seed.layers.pstack.source, 'local:pstack-override');
  assert.equal(seed.layers['simpsonm09-org-ai-plugin'].source, 'local:org-override');

  const fresh = buildWorkspace();
  try {
    cpSync(pstackOverride, join(fresh.workspace, 'pstack-override'), { recursive: true });
    cpSync(orgOverride, join(fresh.workspace, 'org-override'), { recursive: true });
    writeWorkspaceSettings(fresh, seed);
    const secondApply = runInstaller(shell, fresh);
    assertOk(secondApply);
    const secondLock = readJson(join(fresh.workspace, 'stack.lock.json'));
    assert.deepEqual(secondLock.selection, firstLock.selection);
    for (const name of ['pstack', 'simpsonm09-org-ai-plugin']) {
      const oldSource = firstLock.layers.find((layer) => layer.name === name).source;
      const newSource = secondLock.layers.find((layer) => layer.name === name).source;
      assert.equal(newSource.kind, oldSource.kind);
      assert.equal(newSource.override, oldSource.override);
      assert.equal(newSource.commit, oldSource.commit);
    }
  } finally { rmSync(fresh.base, { recursive: true, force: true }); }
}, {});

withWorkspace('-InitSettings refuses an absent lock and malformed recorded overrides before writing', (ctx) => {
  const missing = runInstaller(shell, ctx, ['-InitSettings'], { apply: false });
  assert.notEqual(missing.status, 0);
  assert.match(plainOutput(missing), /needs .*stack\.lock\.json/i);
  assert.equal(existsSync(join(ctx.workspace, 'maxstack.settings.json')), false);

  const applied = runInstaller(shell, ctx);
  assertOk(applied);
  const lockPath = join(ctx.workspace, 'stack.lock.json');
  const lock = readJson(lockPath);
  lock.layers.find((layer) => layer.name === 'pstack').source = { kind: 'other', override: true };
  writeFileSync(lockPath, JSON.stringify(lock));
  const trace = join(ctx.base, 'invalid-init-source-git.trace');
  const invalid = runInstaller(shell, ctx, ['-InitSettings'], { apply: false, env: { ...testEnvironment(), GIT_TRACE: trace } });
  assert.notEqual(invalid.status, 0);
  assert.match(plainOutput(invalid), /recorded source.*kind is invalid/i);
  assert.equal(existsSync(trace), false, 'invalid recorded source shape started Git');
  assert.equal(existsSync(join(ctx.workspace, 'maxstack.settings.json')), false);

  const validGitOverride = { kind: 'git', url: 'https://example.invalid/team/layer.git', ref: 'main', commit: ctx.fixture.commit, override: true };
  for (const [field, mutate] of [
    ['url', (source) => { source.url = 'ext::sh -c touch x'; }],
    ['ref', (source) => { source.ref = '--upload-pack=touch x'; }],
    ['commit', (source) => { source.commit = 'not-a-commit'; }],
  ]) {
    const candidate = readJson(lockPath);
    candidate.layers.find((layer) => layer.name === 'pstack').source = structuredClone(validGitOverride);
    mutate(candidate.layers.find((layer) => layer.name === 'pstack').source);
    writeFileSync(lockPath, JSON.stringify(candidate));
    const bad = runInstaller(shell, ctx, ['-InitSettings'], { apply: false, env: { ...testEnvironment(), GIT_TRACE: trace } });
    assert.notEqual(bad.status, 0, field);
    assert.match(plainOutput(bad), /recorded git source.*URL, ref, or commit is invalid/i, field);
    assert.equal(existsSync(trace), false, `${field} validation invoked Git`);
    assert.equal(existsSync(join(ctx.workspace, 'maxstack.settings.json')), false, `${field} validation wrote settings`);
  }
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

const ALL_LAYERS = ['pstack', 'simpsonm09-org-ai-plugin', 'simpsonm09-personal-ai-plugin'];

withWorkspace('a fresh -Runtimes claude,copilot writes only those runtimes, and records the selection', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'claude,copilot']);
  const at = (path) => join(ctx.workspace, ...path.split('/'));
  for (const absent of ['.opencode', 'opencode.jsonc', '.pi', '.maxstack/bin/pi.cmd', '.maxstack/bin/pi.sh']) {
    assert.ok(!existsSync(at(absent)), `${absent} was written, but opencode and pi are not selected`);
  }
  for (const present of ['.maxstack/bin/copilot.cmd', '.maxstack/bin/copilot.sh', '.claude/plugins/pstack/.claude-plugin/plugin.json']) {
    assert.ok(existsSync(at(present)), `${present} is missing`);
  }
  // With no OpenCode copy to link to, each local layer is a copy of the items it names.
  for (const plugin of ['simpsonm09-org-ai-plugin', 'simpsonm09-personal-ai-plugin']) {
    assert.ok(!isLink(at(`.claude/plugins/${plugin}`)), `${plugin} links to a folder that was not written`);
    assert.ok(existsSync(at(`.claude/plugins/${plugin}/.claude-plugin/plugin.json`)), `${plugin} has no manifest`);
    // The copy holds the layer's own bytes for each item it names.
    const source = plugin === 'simpsonm09-org-ai-plugin' ? ORG_SOURCE : 'projects/repos/simpsonm09-personal-ai-plugin';
    for (const item of ['index.ts', 'package.json', 'skills/demo-skill/SKILL.md', '.claude-plugin/plugin.json']) {
      assert.deepEqual(readFileSync(at(`.claude/plugins/${plugin}/${item}`)), readFileSync(at(`${source}/${item}`)), `${plugin}/${item} is not the layer's file`);
    }
  }
  assert.deepEqual(selectionOf(ctx), { runtimes: ['claude', 'copilot'], layers: ALL_LAYERS });
  const lock = readJson(lockPath(ctx));
  assert.equal(lock.pi.enabled, false);
  assert.equal(lock.pi.reason, 'not selected');
}, {});

withWorkspace('a later -Runtimes pi adds pi and leaves the earlier outputs byte-identical', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'claude,copilot']);
  const beforeFiles = workspaceFiles(ctx.workspace);
  const before = readJson(lockPath(ctx));
  mustApply(ctx, ['-Runtimes', 'pi']);
  const afterFiles = workspaceFiles(ctx.workspace);
  const after = readJson(lockPath(ctx));

  for (const [path, bytes] of beforeFiles) {
    assert.ok(afterFiles.get(path)?.equals(bytes), `${path} changed when pi was added`);
  }
  assert.ok(afterFiles.has('.maxstack/bin/pi.cmd') && afterFiles.has('.pi/agent/settings.json'), 'pi was not written');
  assert.deepEqual(after.selection, { runtimes: ['claude', 'copilot', 'pi'], layers: ALL_LAYERS });

  // The ownership record keeps each earlier record as it was, and adds the pi records.
  const sameRecord = (a, b) => a.path === b.path && a.kind === b.kind && (a.key ?? '') === (b.key ?? '');
  for (const record of before.owned) {
    assert.deepEqual(after.owned.find((candidate) => sameRecord(candidate, record)), record, `the owned record of ${record.path} changed`);
  }
  assert.ok(after.owned.length > before.owned.length, 'pi added no owned record');
  assert.ok(after.owned.some((record) => record.path === '.pi/agent/settings.json' && record.key === 'packages'), 'the pi packages list is not owned');

  // The created lists accumulate: an earlier entry stays, and the settings file and folder pi created are added.
  for (const dir of before.createdDirs) assert.ok(after.createdDirs.includes(dir), `${dir} left createdDirs`);
  for (const file of before.createdFiles) assert.ok(after.createdFiles.includes(file), `${file} left createdFiles`);
  assert.ok(after.createdDirs.includes('.pi/agent'), 'the pi agent folder is not in createdDirs');
  assert.ok(after.createdFiles.includes('.pi/agent/settings.json'), 'the pi settings file is not in createdFiles');
}, {});

withWorkspace('-Runtimes opencode -Layers pstack writes one layer, and a later -Layers adds the next', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'opencode', '-Layers', 'pstack']);
  const at = (path) => join(ctx.workspace, ...path.split('/'));
  assert.ok(existsSync(at('.opencode/plugins/pstack/opencode/index.ts')), 'the pstack entry is missing');
  assert.ok(!existsSync(at('.opencode/plugins/simpsonm09-org-ai-plugin')), 'the org layer is not selected');
  assert.ok(!existsSync(at('.opencode/plugins/simpsonm09-personal-ai-plugin')), 'the personal layer is not selected');
  assert.ok(!existsSync(at('.claude/plugins')), 'claude is not selected');
  assert.deepEqual(selectionOf(ctx), { runtimes: ['opencode'], layers: ['pstack'] });

  mustApply(ctx, ['-Layers', 'simpsonm09-org-ai-plugin']);
  assert.ok(existsSync(at('.opencode/plugins/simpsonm09-org-ai-plugin/index.ts')), 'the org layer did not install');
  assert.ok(!existsSync(at('.opencode/plugins/simpsonm09-personal-ai-plugin')), 'the personal layer was added');
  assert.deepEqual(selectionOf(ctx), { runtimes: ['opencode'], layers: ['pstack', 'simpsonm09-org-ai-plugin'] });
}, {});

// The bytes of each output file, as latin1 text so that one character is one byte. Each temporary base
// folder the test builds is replaced by a placeholder, since the wrappers name absolute paths; no other
// byte changes. The lock and the git cache are left out, as in workspaceFiles.
// The org and personal fixtures both ship demo-skill, which codex refuses (two layers, one skill name). An explicit all selects
// codex, so the all-runtimes comparison renames the personal copy in both workspaces.
function renameDemoSkill(ctx) {
  const skills = join(ctx.workspace, LOCAL_LAYERS[1], 'skills');
  renameSync(join(skills, 'demo-skill'), join(skills, 'personal-demo'));
  writeFileSync(join(skills, 'personal-demo', 'SKILL.md'), '---\nname: personal-demo\ndescription: fixture\n---\nbody\n');
}

// codex copies its skills into .agents, which the other runtimes never write, so it is left out of the comparison.
function withoutCodexFiles(files) {
  return new Map([...files].filter(([path]) => !path.startsWith('.agents/')));
}

function portableFiles(ctx) {
  const bases = [ctx.base, ctx.base.replaceAll('\\', '/'), JSON.stringify(ctx.base).slice(1, -1), `/mnt/${ctx.base[0].toLowerCase()}${ctx.base.slice(2).replaceAll('\\', '/')}`];
  return new Map([...workspaceFiles(ctx.workspace)].map(([path, bytes]) => {
    let text = bytes.toString('latin1');
    for (const base of bases) text = text.replaceAll(base, '<BASE>');
    return [path, text];
  }));
}

withWorkspace('-Runtimes all -Layers all writes what a plain apply writes plus the codex skills, and records every name', (ctx) => {
  renameDemoSkill(ctx);
  mustApply(ctx, ['-Runtimes', 'all', '-Layers', 'all']);
  assert.deepEqual(selectionOf(ctx), { runtimes: [...ALL_RUNTIMES, 'codex'].sort(), layers: ALL_LAYERS });
  const plain = buildWorkspace();
  try {
    renameDemoSkill(plain);
    mustApply(plain);
    const everything = withoutCodexFiles(portableFiles(ctx));
    assert.ok(everything.size > 0);
    assert.deepEqual(everything, portableFiles(plain), 'an output file differs between the explicit all and the plain apply');
  } finally {
    rmSync(plain.base, { recursive: true, force: true });
  }
}, {});

withWorkspace('naming a runtime that is already selected narrows nothing, and says so', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'claude,copilot']);
  const run = mustApply(ctx, ['-Runtimes', 'claude']);
  assert.match(plainOutput(run), /Already selected runtimes: claude\. Flags never narrow the selection; the rest stay selected\./, run.stdout);
  assert.deepEqual(selectionOf(ctx), { runtimes: ['claude', 'copilot'], layers: ALL_LAYERS });
  assert.ok(existsSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd')), 'copilot was removed by a flag that named fewer runtimes');
}, {});

withWorkspace('an unknown runtime or layer name fails, lists the valid names, and writes nothing', (ctx) => {
  const runtime = runInstaller(shell, ctx, ['-Runtimes', 'gemini']);
  assert.notEqual(runtime.status, 0, 'the installer accepted an unknown runtime');
  assert.match(plainOutput(runtime), /-Runtimes names an unknown name 'gemini'\. Valid names: claude, opencode, copilot, pi, codex, or all\./);
  const layer = runInstaller(shell, ctx, ['-Layers', 'nope']);
  assert.notEqual(layer.status, 0, 'the installer accepted an unknown layer');
  assert.match(plainOutput(layer), /-Layers names an unknown name 'nope'\. Valid names: pstack, simpsonm09-org-ai-plugin, simpsonm09-personal-ai-plugin, or all\./);
  assert.ok(!existsSync(lockPath(ctx)), 'a rejected run wrote the lock');
  assert.ok(!existsSync(join(ctx.workspace, '.claude')), 'a rejected run wrote the Claude folder');
}, {});

withWorkspaceNeeding('python', python, 'a lock with no selection reads as all, and the next apply writes the selection', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  delete lock.selection;
  writeFileSync(lockPath(ctx), JSON.stringify(lock));

  const status = runStatus(ctx);
  assert.match(status.stdout, /^Selection: runtimes claude, copilot, opencode, pi; layers pstack, simpsonm09-org-ai-plugin, simpsonm09-personal-ai-plugin \(the lock predates the selection, so all\)\r?$/m, status.stdout);
  const home = join(ctx.base, 'home');
  mkdirSync(home);
  const verify = spawnSync(python, [verifyWorkspaceScript, '--workspace', ctx.workspace, '--home', home], { windowsHide: true, encoding: 'utf8' });
  assert.equal(verify.status, 0, `${verify.stdout}\n${verify.stderr}`);
  mustApply(ctx);
  assert.deepEqual(selectionOf(ctx), { runtimes: ALL_RUNTIMES, layers: ALL_LAYERS });
}, {});

withWorkspace('status prints the selection first, names an unselected file, and judges only the selected runtimes', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'claude,copilot']);
  writeFile(ctx.workspace, '.maxstack/bin/pi.cmd', '@echo off\r\n');
  const run = runStatus(ctx);
  assert.equal(run.status, 0, run.stdout);
  // Warnings also print to stdout, and the discovery line names the resolved target, so the first line that is neither must be the selection.
  const [first] = run.stdout.split(/\r?\n/).filter((line) => !line.includes('WARNING:') && !line.startsWith(`Workspace: ${ctx.workspace} (from -Workspace)`));
  assert.equal(first, 'Selection: runtimes claude, copilot; layers pstack, simpsonm09-org-ai-plugin, simpsonm09-personal-ai-plugin', 'the selection is not the first line');
  assert.match(run.stdout, /^not selected +\.maxstack\/bin\/pi\.cmd\r?$/m, run.stdout);
  assert.doesNotMatch(run.stdout, /^(matching|drifted|modified|missing|untracked) .*opencode/m, 'status judged an OpenCode path');
  // The file, plus the two runtimes layers.json names that this selection leaves out.
  assert.match(run.stdout, /Summary: \d+ matching, 0 drifted, 0 modified, 0 missing, 0 untracked, 3 not selected/);
  assert.equal(runStatus(ctx, ['-Strict']).status, 0, 'a file of an unselected runtime failed -Strict');
  const refused = runStatus(ctx, ['-Runtimes', 'claude']);
  assert.notEqual(refused.status, 0, '-Status accepted a selection flag');
  assert.match(plainOutput(refused), /-Status reports the recorded selection and takes no -Runtimes or -Layers/);
}, {});

withWorkspaceNeeding('python', python, 'the verifiers fail on an unknown, a malformed, or a pi-without-claude selection', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'claude,copilot']);
  const home = join(ctx.base, 'home');
  mkdirSync(home);
  const verifyWorkspace = () => spawnSync(python, [verifyWorkspaceScript, '--workspace', ctx.workspace, '--home', home], { windowsHide: true, encoding: 'utf8' });
  const verifyLock = () => spawnSync(python, [verifyManifestsScript, '--lock', lockPath(ctx)], { windowsHide: true, encoding: 'utf8' });
  const cases = [
    [(lock) => { lock.selection.runtimes = ['claude', 'gemini']; }, /names unknown \['gemini'\]/],
    [(lock) => { lock.selection.runtimes = ['copilot']; }, /selects copilot without claude/],
    [(lock) => { lock.selection = 'claude'; }, /must hold exactly a runtimes list and a layers list/],
  ];
  for (const [mutate, message] of cases) {
    const lock = readJson(lockPath(ctx));
    mutate(lock);
    writeFileSync(lockPath(ctx), JSON.stringify(lock));
    for (const run of [verifyWorkspace(), verifyLock()]) {
      assert.notEqual(run.status, 0, `a verifier accepted: ${message}`);
      assert.match(plainOutput(run), message);
    }
  }
}, {});

withWorkspace('a runtime that is not selected is never looked up, so its CLI is not warned about', (ctx) => {
  const run = mustApply(ctx, ['-Runtimes', 'claude', '-CopilotCommand', MISSING_COPILOT]);
  assert.doesNotMatch(plainOutput(run), /Copilot CLI not found|Pi CLI not found/);
  const lock = readJson(lockPath(ctx));
  assert.equal(lock.copilot.reason, 'not selected');
  assert.equal(lock.pi.reason, 'not selected');
}, {});

withWorkspace('comma-separated -Runtimes and -Layers values bind under pwsh -File, one token each', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'claude,opencode', '-Layers', 'pstack,simpsonm09-org-ai-plugin']);
  assert.deepEqual(selectionOf(ctx), { runtimes: ['claude', 'opencode'], layers: ['pstack', 'simpsonm09-org-ai-plugin'] });
  assert.ok(existsSync(join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-org-ai-plugin', 'index.ts')), 'the named org layer is missing');
}, {});

withWorkspace('a later -Runtimes opencode replaces the claude copies with links to the OpenCode copies', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'claude']);
  const child = join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-org-ai-plugin');
  assert.ok(!isLink(child), 'the claude copy is a link before opencode is selected');
  mustApply(ctx, ['-Runtimes', 'opencode']);
  assert.ok(isLink(child), 'the copy was not replaced by a link');
  assert.ok(existsSync(join(child, '.claude-plugin', 'plugin.json')), 'the link does not reach the manifest');
  assert.equal(readJson(lockPath(ctx)).layers.find((layer) => layer.name === 'simpsonm09-org-ai-plugin').claude.kind, 'junction');
}, {});

// The review fixes. A recorded name that layers.json no longer names is dropped with a warning, a new layer
// or runtime is named until a flag adds it, an unreadable lock is refused with the cost of deleting it, the
// lock is replaced whole, and the verifiers refuse a block that is enabled for an unselected runtime.
const LAYER_PERSONAL = 'simpsonm09-personal-ai-plugin';

withWorkspace('a layer removed from layers.json is dropped from the selection with a warning, and every command still runs', (ctx) => {
  mustApply(ctx);
  const personalFolder = join(ctx.workspace, '.opencode', 'plugins', LAYER_PERSONAL);
  const personalLink = join(ctx.workspace, '.claude', 'plugins', LAYER_PERSONAL);
  assert.ok(existsSync(personalFolder), 'the first apply did not install the personal layer');
  const withoutPersonal = writeLayers(ctx, (manifest) => {
    manifest.layers = manifest.layers.filter((layer) => layer.name !== LAYER_PERSONAL);
  });
  const warning = new RegExp(`names the layer '${LAYER_PERSONAL}', which is no longer in layers\\.json\\. It is dropped from the selection`);

  const audit = runInstaller(shell, ctx, [], { apply: false, layersFile: withoutPersonal });
  assert.equal(audit.status, 0, `audit failed:\n${audit.stdout}\n${audit.stderr}`);
  assert.match(plainOutput(audit), warning);

  const status = runInstaller(shell, ctx, ['-Status'], { apply: false, layersFile: withoutPersonal });
  assert.equal(status.status, 0, `status failed:\n${status.stdout}\n${status.stderr}`);
  assert.match(plainOutput(status), warning);
  assert.ok(existsSync(personalFolder), 'a status run changed the workspace');

  const applied = mustApply(ctx, [], { layersFile: withoutPersonal });
  assert.match(plainOutput(applied), warning);
  assert.ok(!existsSync(personalFolder), 'the removed layer kept its OpenCode folder');
  assert.ok(!existsSync(personalLink), 'the removed layer kept its Claude folder');
  assert.deepEqual(selectionOf(ctx), { runtimes: ALL_RUNTIMES, layers: ['pstack', 'simpsonm09-org-ai-plugin'] });

  const after = runInstaller(shell, ctx, ['-Status'], { apply: false, layersFile: withoutPersonal });
  assert.equal(after.status, 0, after.stdout);
  assert.doesNotMatch(plainOutput(after), /no longer in layers\.json/, 'the warning outlived the removal');
}, {});

withWorkspace('a runtime removed from the recorded selection is named, dropped with a warning, and the apply runs', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  lock.selection.runtimes = ['claude', 'retired-runtime'];
  writeFileSync(lockPath(ctx), JSON.stringify(lock));
  const run = mustApply(ctx);
  assert.match(plainOutput(run), /names the runtime 'retired-runtime', which is no longer in layers\.json\. It is dropped from the selection/);
  assert.deepEqual(selectionOf(ctx).runtimes, ['claude']);
}, {});

withWorkspace('a layer added to layers.json later is not installed by a plain apply, and every command names it until a flag adds it', (ctx) => {
  const withoutPersonal = writeLayers(ctx, (manifest) => {
    manifest.layers = manifest.layers.filter((layer) => layer.name !== LAYER_PERSONAL);
  });
  mustApply(ctx, [], { layersFile: withoutPersonal });
  const personalFolder = join(ctx.workspace, '.opencode', 'plugins', LAYER_PERSONAL);
  assert.ok(!existsSync(personalFolder));
  assert.deepEqual(selectionOf(ctx).layers, ['pstack', 'simpsonm09-org-ai-plugin']);

  const applied = mustApply(ctx);
  const note = `layer '${LAYER_PERSONAL}' is in layers.json but not selected, so this run does not install it. Add it with -Layers ${LAYER_PERSONAL}.`;
  assert.match(plainOutput(applied), new RegExp(note.replaceAll('.', '\\.')));
  assert.ok(!existsSync(personalFolder), 'a plain apply installed a layer the selection leaves out');

  const audit = runInstaller(shell, ctx, [], { apply: false });
  assert.match(plainOutput(audit), new RegExp(note.replaceAll('.', '\\.')));

  const status = runStatus(ctx);
  assert.equal(status.status, 0, status.stdout);
  assert.match(status.stdout, new RegExp(`^not selected +layer ${LAYER_PERSONAL} \\(add with -Layers ${LAYER_PERSONAL}\\)\\r?$`, 'm'));
  assert.equal(runStatus(ctx, ['-Strict']).status, 0, 'a layer the selection leaves out failed -Strict');

  const flagged = mustApply(ctx, ['-Layers', LAYER_PERSONAL]);
  assert.ok(existsSync(personalFolder), 'the named layer was not installed');
  assert.deepEqual(selectionOf(ctx).layers, ['pstack', 'simpsonm09-org-ai-plugin', LAYER_PERSONAL]);
  assert.doesNotMatch(plainOutput(flagged), /is in layers\.json but not selected/);
}, {});

withWorkspace('a runtime that layers.json names but the selection leaves out is named on every run', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'claude,copilot']);
  const run = mustApply(ctx);
  assert.match(plainOutput(run), /runtime 'opencode' is in layers\.json but not selected, so this run does not install it\. Add it with -Runtimes opencode\./);
  const status = runStatus(ctx);
  assert.match(status.stdout, /^not selected +runtime pi \(add with -Runtimes pi\)\r?$/m, status.stdout);
  assert.equal(runStatus(ctx, ['-Strict']).status, 0, 'a runtime the selection leaves out failed -Strict');
}, {});

withWorkspaceNeeding('python', python, 'the verifiers reject an enabled pi or copilot block for a runtime the selection leaves out', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'claude']);
  const home = join(ctx.base, 'home');
  mkdirSync(home);
  const verifyWorkspace = () => spawnSync(python, [verifyWorkspaceScript, '--workspace', ctx.workspace, '--home', home], { windowsHide: true, encoding: 'utf8' });
  const verifyLock = () => spawnSync(python, [verifyManifestsScript, '--lock', lockPath(ctx)], { windowsHide: true, encoding: 'utf8' });
  const clean = verifyWorkspace();
  assert.equal(clean.status, 0, `${clean.stdout}\n${clean.stderr}`);
  assert.equal(verifyLock().status, 0);

  const lock = readJson(lockPath(ctx));
  for (const runtime of ['pi', 'copilot']) {
    const edited = { ...lock, [runtime]: { ...lock[runtime], enabled: true } };
    writeFileSync(lockPath(ctx), JSON.stringify(edited));
    for (const run of [verifyWorkspace(), verifyLock()]) {
      assert.notEqual(run.status, 0, `a verifier accepted an enabled ${runtime} block`);
      assert.match(plainOutput(run), new RegExp(`records ${runtime} enabled, which the selection does not select`));
    }
  }
}, {});

withWorkspace('a claude-only apply over an all-runtime tree leaves every other runtime file byte-identical', (ctx) => {
  mustApply(ctx);
  const isOther = (path) => /^(\.opencode\/|opencode\.jsonc$|\.pi\/|\.maxstack\/)/.test(path);
  const before = workspaceFiles(ctx.workspace);
  const beforeOther = [...before.keys()].filter(isOther);
  assert.ok(beforeOther.length > 10, 'the all-runtime tree has too few other files to prove anything');
  // The lock now selects claude only, as a remove would leave it. Apply must not touch the other runtimes.
  const lock = readJson(lockPath(ctx));
  lock.selection.runtimes = ['claude'];
  writeFileSync(lockPath(ctx), JSON.stringify(lock));
  mustApply(ctx);
  const after = workspaceFiles(ctx.workspace);
  for (const path of beforeOther) {
    assert.ok(after.get(path)?.equals(before.get(path)), `${path} changed under an unselected runtime`);
  }
  assert.deepEqual([...after.keys()].filter(isOther), beforeOther, 'a file under an unselected runtime was added or removed');
  assert.deepEqual(readJson(lockPath(ctx)).selection.runtimes, ['claude']);
}, {});

withWorkspace('the removal switches refuse each other, -Status, and a missing selection before anything runs', (ctx) => {
  mustApply(ctx);
  const before = snapshotTree(ctx.workspace);
  const cases = [
    [['-Remove', '-Uninstall'], /Choose one/],
    [['-Uninstall', '-Status'], /Choose -Status, -Remove, or -Uninstall/],
    [['-Uninstall', '-Runtimes', 'pi'], /takes no -Runtimes or -Layers/],
    [['-Remove'], /names what to remove/],
    [['-Strict'], /applies to -Apply, -Status, -Remove, -Uninstall, and -Update/],
  ];
  for (const [args, pattern] of cases) {
    const run = runInstaller(shell, ctx, args, { apply: false });
    assert.notEqual(run.status, 0, args.join(' '));
    assert.match(plainOutput(run), pattern, args.join(' '));
  }
  assert.deepEqual(snapshotTree(ctx.workspace), before);
}, {});

withWorkspace('pstack installs from a local checkout, comma-separated with another layer, and a folder that is not git records no commit', (ctx) => {
  const pstackCheckout = join(ctx.base, 'pstack-checkout');
  cpSync(ctx.fixture.dir, pstackCheckout, { recursive: true });
  const head = gitRun(pstackCheckout, ['rev-parse', 'HEAD']);
  writeFile(pstackCheckout, SKILL_PATH, '---\nname: poteto-mode\ndescription: fixture\n---\nlocal edit\n');
  const orgCheckout = join(ctx.base, 'org-plain');
  writeLayerStub(orgCheckout, { claudePlugin: 'simpsonm09-org-ai-plugin' });

  mustApply(ctx, ['-Source', `pstack=local:${pstackCheckout},simpsonm09-org-ai-plugin=local:${orgCheckout}`]);
  assert.match(readFileSync(installedSkill(ctx), 'utf8'), /local edit/, 'pstack was not installed from its checkout');
  assert.ok(existsSync(join(ctx.workspace, '.claude', 'plugins', 'pstack', '.claude-plugin', 'plugin.json')), 'the Claude copy lacks the manifest');
  assert.equal(existsSync(join(ctx.workspace, '.claude', 'plugins', 'pstack', '.git')), false, 'the Claude copy carries .git');
  assert.deepEqual(sourceOf(ctx, 'pstack').source, { kind: 'local', url: null, ref: null, commit: head, dirty: true, override: true, path: pstackCheckout });
  assert.equal(existsSync(join(ctx.workspace, '.claude', 'cache', 'pstack')), false, 'a local source keeps no git cache');

  const org = sourceOf(ctx, 'simpsonm09-org-ai-plugin');
  assert.equal(org.commit, null, 'a folder that is not a git checkout records no commit');
  assert.equal(org.source.dirty, null, 'a folder that is not a git checkout records no dirty flag');
}, {});

withWorkspace('-Update needs a lock with a selection, and refuses the flags it does not take', (ctx) => {
  const none = runInstaller(shell, ctx, ['-Update'], { apply: false });
  assert.notEqual(none.status, 0, '-Update ran without a lock');
  assert.match(plainOutput(none), /needs a stack\.lock\.json with a selection/, none.stdout);

  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  delete lock.selection;
  setLock(ctx, lock);
  const legacy = runInstaller(shell, ctx, ['-Update'], { apply: false });
  assert.notEqual(legacy.status, 0, '-Update ran on a lock with no selection');
  assert.match(plainOutput(legacy), /predates the selection/, legacy.stdout);

  mustApply(ctx);
  for (const [args, reason] of [
    [['-Update', '-Remove', '-Layers', 'pstack'], /-Update re-resolves the recorded sources/],
    [['-Update', '-Uninstall'], /-Update re-resolves the recorded sources/],
    [['-Update', '-Status'], /-Update re-resolves the recorded sources/],
    [['-Update', '-Source', 'pstack=simpsonm09/pstack-claude@feat'], /Set a source with -Source and an apply/],
    [['-Update', '-Layers', 'pstack'], /applies the recorded selection/],
    [['-Check'], /-Check applies to -Update/],
    [['-Update', '-Check', '-Apply'], /-Check writes nothing/],
    [['-Update', '-Apply', '-Strict'], /reports and writes nothing/],
  ]) {
    const run = runInstaller(shell, ctx, args, { apply: false, env: githubEnv(ctx) });
    assert.notEqual(run.status, 0, `${args.join(' ')} was accepted`);
    assert.match(plainOutput(run), reason, `${args.join(' ')}: ${run.stdout}\n${run.stderr}`);
  }
}, {});

withWorkspace('a marker under a temporary directory junction selects its workspace without reading the marker', (ctx) => {
  const target = join(ctx.base, 'marker-target');
  const linked = join(ctx.base, 'marker-link');
  const cwd = join(linked, 'nested');
  mkdirSync(target);
  writeFileSync(join(target, 'stack.lock.json'), '');
  symlinkSync(target, linked, 'junction');
  mkdirSync(cwd);

  const run = runWorkspaceDiscovery(ctx, { kind: 'marker', path: cwd, scriptRoot: join(ctx.base, 'unrecognized') });
  assert.equal(run.status, 0, `${run.stdout}${run.stderr}`);
  assert.match(run.stdout, /ORIGIN=cwd marker stack\.lock\.json;/);
}, {});

// N1: -LayerSource refuses a path that holds a format or bidi character, as -Source refuses one, and records nothing.
withWorkspace('item N1: a -LayerSource path with a format or bidi character is refused as -Source refuses it, and nothing is recorded', (ctx) => {
  for (const char of [ZWSP, RLO]) {
    const folder = join(ctx.base, `layer${char}folder`);
    mkdirSync(folder);
    const run = runInstaller(shell, ctx, ['-LayerSource', `pstack=${folder}`]);
    assert.notEqual(run.status, 0, plainOutput(run));
    assert.match(plainOutput(run), /-LayerSource pstack=.* holds the character /, plainOutput(run));
    assert.ok(!plainOutput(run).includes(char), `${escapedChar(char)} reached the output raw`);
    assert.equal(existsSync(lockPath(ctx)), false, 'a refused -LayerSource wrote a lock');
  }
}, {});

// N4: flag names refuse a format character, and match case-insensitively for ASCII letters only, so a ligature that spells a name is unknown.
withWorkspace('item N4: -Runtimes and -Layers refuse a format character in a name, and a ligature that spells a layer is unknown', (ctx) => {
  mustApply(ctx);
  const cases = [
    ['-Runtimes', `pi${ZWSP}`, /-Runtimes name 'pi\\u200B' holds the character \\u200B/],
    ['-Layers', `pstack${ZWSP}`, /-Layers name 'pstack\\u200B' holds the character \\u200B/],
    ['-Layers', 'p\uFB06ack', /-Layers names an unknown name/],
  ];
  for (const [flag, value, message] of cases) {
    const run = runInstaller(shell, ctx, [flag, value], { apply: false });
    assert.notEqual(run.status, 0, `${flag} ${JSON.stringify(value)}: ${plainOutput(run)}`);
    assert.match(plainOutput(run), message, flag);
  }
  assertOk(runInstaller(shell, ctx, ['-Layers', 'PSTACK'], { apply: false }), 'an ASCII case variant is still accepted');
}, {});

// N10: -InitSettings refuses a recorded 8.3 path, so it never writes a seed that apply then refuses. A long path round-trips.
withWorkspaceNeeding('8.3 short names', short83Available, 'item N10: -InitSettings refuses a recorded 8.3 path, and a long recorded path round-trips through apply', (ctx) => {
  mustApply(ctx);
  // The pstack fixture repository, under the temp base: a long folder name that the layer's plugins/pstack path is read from.
  const long = ctx.fixture.dir;
  const short = EXISTING_SHORT_FOLDER;
  const lock = readJson(lockPath(ctx));
  const record = lock.layers.find((layer) => layer.name === 'pstack');
  record.source = { kind: 'local', url: null, ref: null, commit: null, dirty: null, override: true, path: short };
  writeFileSync(lockPath(ctx), JSON.stringify(lock));
  const refused = runInstaller(shell, ctx, ['-InitSettings'], { apply: false });
  assert.notEqual(refused.status, 0, plainOutput(refused));
  assert.match(plainOutput(refused), /cannot migrate the recorded local source for 'pstack': .*8\.3 short name/, plainOutput(refused));
  record.source.path = long;
  writeFileSync(lockPath(ctx), JSON.stringify(lock));
  const seed = runInstaller(shell, ctx, ['-InitSettings', '-Apply'], { apply: false });
  assertOk(seed, plainOutput(seed));
  const applied = runInstaller(shell, ctx, [], { apply: true });
  assertOk(applied, plainOutput(applied));
}, {});
