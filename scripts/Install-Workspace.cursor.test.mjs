import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, symlinkSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ALL_RUNTIMES, LOCAL_LAYERS, lockPath, mustApply, plainOutput, readJson, runInstaller, runStatus, selectionOf, shell, withWorkspace, writeLayerStub, writeWorkspaceSettings } from './lib/installer-test-kit.mjs';

function renameDuplicate(ctx) {
  const folder = join(ctx.workspace, LOCAL_LAYERS[1], 'skills', 'demo-skill');
  renameSync(folder, join(ctx.workspace, LOCAL_LAYERS[1], 'skills', 'personal-demo'));
  writeFileSync(join(ctx.workspace, LOCAL_LAYERS[1], 'skills', 'personal-demo', 'SKILL.md'), '---\nname: personal-demo\ndescription: fixture\n---\nbody\n');
}

withWorkspace('cursor is opt-in, copies selected layer skills byte for byte, and repeats cleanly', (ctx) => {
  mustApply(ctx);
  assert.deepEqual(selectionOf(ctx).runtimes, ALL_RUNTIMES, 'Cursor is absent from default selection');
  assert.equal(existsSync(join(ctx.workspace, '.cursor')), false, 'the default apply writes no Cursor folder');

  const sources = readJson(lockPath(ctx)).layers;
  const org = sources.find((layer) => layer.name === 'simpsonm09-org-ai-plugin');
  const source = org.source.kind === 'local' ? join(ctx.workspace, org.source.path) : join(ctx.workspace, LOCAL_LAYERS[0]);
  const skill = join(source, 'skills', 'demo-skill', 'SKILL.md');
  const expected = readFileSync(skill);
  renameDuplicate(ctx);
  mustApply(ctx, ['-Runtimes', 'cursor']);
  const target = join(ctx.workspace, '.cursor', 'skills', 'demo-skill', 'SKILL.md');
  assert.deepEqual(readFileSync(target), expected, 'the layer file is copied without text conversion');
  for (const name of ['poteto-mode', 'demo-skill', 'personal-demo']) {
    assert.equal(existsSync(join(ctx.workspace, '.cursor', 'skills', name, 'SKILL.md')), true, `${name} was not projected`);
  }
  assert.deepEqual(selectionOf(ctx).runtimes, [...ALL_RUNTIMES, 'cursor'].sort());
  const record = readJson(lockPath(ctx)).owned.find((entry) => entry.path === '.cursor/skills/demo-skill');
  assert.equal(record.runtime, 'cursor');
  assert.deepEqual(record.layers, ['simpsonm09-org-ai-plugin']);

  const before = readFileSync(target);
  mustApply(ctx);
  assert.deepEqual(readFileSync(target), before, 'a repeated apply leaves the copied bytes unchanged');
}, {});

withWorkspace('cursor refuses an unowned skill target without overwriting it', (ctx) => {
  renameDuplicate(ctx);
  const target = join(ctx.workspace, '.cursor', 'skills', 'demo-skill', 'SKILL.md');
  const userBytes = Buffer.from('user skill\r\n');
  mkdirSync(join(ctx.workspace, '.cursor', 'skills', 'demo-skill'), { recursive: true });
  writeFileSync(target, userBytes);
  const result = runInstaller(shell, ctx, ['-Runtimes', 'cursor']);
  assert.notEqual(result.status, 0, 'the installer accepted an unowned target');
  assert.match(plainOutput(result), /already exists and maxstack did not write it/);
  assert.deepEqual(readFileSync(target), userBytes);
  assert.equal(existsSync(lockPath(ctx)), false, 'a refused collision writes no lock');
}, {});

withWorkspace('cursor refuses a linked skills root without writing outside the workspace', (ctx) => {
  renameDuplicate(ctx);
  const outside = join(ctx.base, 'outside-root');
  mkdirSync(outside);
  const marker = join(outside, 'marker.txt');
  writeFileSync(marker, 'outside stays unchanged\n');
  mkdirSync(join(ctx.workspace, '.cursor'));
  const root = join(ctx.workspace, '.cursor', 'skills');
  symlinkSync(outside, root, 'junction');
  try {
    const result = runInstaller(shell, ctx, ['-Runtimes', 'cursor']);
    assert.notEqual(result.status, 0, 'the installer accepted a linked skills root');
    assert.match(plainOutput(result), /linked|reparse|junction|symbolic link/i);
    assert.deepEqual(readFileSync(marker), Buffer.from('outside stays unchanged\n'));
    assert.deepEqual(readdirSync(outside), ['marker.txt']);
    assert.equal(existsSync(lockPath(ctx)), false, 'a refused linked root writes no lock');
  } finally {
    rmSync(root);
  }
}, {});

withWorkspace('cursor refuses a linked cursor ancestor without writing outside the workspace', (ctx) => {
  renameDuplicate(ctx);
  const outside = join(ctx.base, 'outside-ancestor');
  mkdirSync(outside);
  const marker = join(outside, 'marker.txt');
  writeFileSync(marker, 'outside stays unchanged\n');
  const ancestor = join(ctx.workspace, '.cursor');
  symlinkSync(outside, ancestor, 'junction');
  try {
    const result = runInstaller(shell, ctx, ['-Runtimes', 'cursor']);
    assert.notEqual(result.status, 0, 'the installer accepted a linked cursor ancestor');
    assert.match(plainOutput(result), /linked|reparse|junction|symbolic link/i);
    assert.deepEqual(readFileSync(marker), Buffer.from('outside stays unchanged\n'));
    assert.deepEqual(readdirSync(outside), ['marker.txt']);
    assert.equal(existsSync(lockPath(ctx)), false, 'a refused linked ancestor writes no lock');
  } finally {
    rmSync(ancestor);
  }
}, {});

withWorkspace('cursor refuses a linked skill target and preserves its outside contents', (ctx) => {
  renameDuplicate(ctx);
  const outside = join(ctx.base, 'outside-skill');
  mkdirSync(outside);
  const marker = join(outside, 'SKILL.md');
  writeFileSync(marker, 'user skill\n');
  const target = join(ctx.workspace, '.cursor', 'skills', 'demo-skill');
  mkdirSync(join(ctx.workspace, '.cursor', 'skills'), { recursive: true });
  symlinkSync(outside, target, 'junction');
  try {
    const result = runInstaller(shell, ctx, ['-Runtimes', 'cursor']);
    assert.notEqual(result.status, 0, 'the installer accepted a linked skill target');
    assert.match(plainOutput(result), /already exists|linked|reparse|junction|symbolic link/i);
    assert.equal(readFileSync(marker, 'utf8'), 'user skill\n');
    assert.deepEqual(readdirSync(outside), ['SKILL.md']);
    assert.equal(existsSync(lockPath(ctx)), false, 'a refused linked target writes no lock');
  } finally {
    rmSync(target);
  }
}, {});

withWorkspace('cursor refuses an unowned skill file and preserves its bytes', (ctx) => {
  renameDuplicate(ctx);
  const target = join(ctx.workspace, '.cursor', 'skills', 'demo-skill');
  mkdirSync(join(ctx.workspace, '.cursor', 'skills'), { recursive: true });
  const userBytes = Buffer.from('user-owned file\r\n');
  writeFileSync(target, userBytes);
  const result = runInstaller(shell, ctx, ['-Runtimes', 'cursor']);
  assert.notEqual(result.status, 0, 'the installer accepted an unowned file at a skill target');
  assert.match(plainOutput(result), /already exists|unowned|collision/i);
  assert.deepEqual(readFileSync(target), userBytes);
  assert.equal(existsSync(lockPath(ctx)), false, 'a refused file collision writes no lock');
}, {});

withWorkspace('cursor refuses a file at the skills root and preserves its bytes', (ctx) => {
  renameDuplicate(ctx);
  mkdirSync(join(ctx.workspace, '.cursor'));
  const root = join(ctx.workspace, '.cursor', 'skills');
  const userBytes = Buffer.from('user-owned root file\r\n');
  writeFileSync(root, userBytes);
  const result = runInstaller(shell, ctx, ['-Runtimes', 'cursor']);
  assert.notEqual(result.status, 0, 'the installer accepted a file at the skills root');
  assert.match(plainOutput(result), /not a directory/);
  assert.deepEqual(readFileSync(root), userBytes);
  assert.equal(existsSync(lockPath(ctx)), false, 'a refused root file writes no lock');
}, {});

withWorkspace('cursor refuses an owned skill target replaced by a link and preserves its outside contents', (ctx) => {
  renameDuplicate(ctx);
  mustApply(ctx, ['-Runtimes', 'cursor']);
  const outside = join(ctx.base, 'outside-owned-skill');
  mkdirSync(outside);
  const marker = join(outside, 'SKILL.md');
  writeFileSync(marker, 'outside stays unchanged\n');
  const target = join(ctx.workspace, '.cursor', 'skills', 'demo-skill');
  rmSync(target, { recursive: true, force: true });
  symlinkSync(outside, target, 'junction');
  try {
    const result = runInstaller(shell, ctx, ['-Runtimes', 'cursor']);
    assert.notEqual(result.status, 0, 'the installer accepted an owned skill link');
    assert.match(plainOutput(result), /link or reparse point/);
    assert.equal(readFileSync(marker, 'utf8'), 'outside stays unchanged\n');
    assert.deepEqual(readdirSync(outside), ['SKILL.md']);
  } finally {
    rmSync(target);
  }
}, {});

withWorkspace('cursor refuses traversal in a recorded owned skill path before removal', (ctx) => {
  renameDuplicate(ctx);
  mustApply(ctx, ['-Runtimes', 'cursor']);
  const outside = join(ctx.workspace, 'outside-marker.txt');
  writeFileSync(outside, 'outside stays unchanged\n');
  const lock = readJson(lockPath(ctx));
  const owned = lock.owned.find((record) => record.runtime === 'cursor');
  owned.path = '.cursor/skills/../../outside-marker.txt';
  writeFileSync(lockPath(ctx), JSON.stringify(lock, null, 2));
  const result = runInstaller(shell, ctx, ['-Runtimes', 'cursor']);
  assert.notEqual(result.status, 0, 'the installer accepted traversal in a recorded skill path');
  assert.match(plainOutput(result), /safe path segment/);
  assert.equal(readFileSync(outside, 'utf8'), 'outside stays unchanged\n');
}, {});

withWorkspace('cursor detects pinned-layer skill collisions before creating its cache or outputs', (ctx) => {
  renameDuplicate(ctx);
  const target = join(ctx.workspace, '.cursor', 'skills', 'poteto-mode');
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, 'SKILL.md'), 'user-owned skill\n');
  const result = runInstaller(shell, ctx, ['-Runtimes', 'cursor']);
  assert.notEqual(result.status, 0, 'the installer accepted an unowned pinned-layer skill target');
  assert.match(plainOutput(result), /already exists and maxstack did not write it/);
  assert.equal(existsSync(join(ctx.workspace, '.claude', 'cache', 'pstack')), false, 'preflight created the pinned cache');
  assert.equal(existsSync(lockPath(ctx)), false, 'preflight wrote a lock');
  assert.deepEqual(readFileSync(join(target, 'SKILL.md'), 'utf8'), 'user-owned skill\n');
}, {});

withWorkspace('cursor strict status reports an unowned skill folder', (ctx) => {
  renameDuplicate(ctx);
  mustApply(ctx, ['-Runtimes', 'cursor']);
  const userFolder = join(ctx.workspace, '.cursor', 'skills', 'user-skill');
  mkdirSync(userFolder, { recursive: true });
  writeFileSync(join(userFolder, 'SKILL.md'), 'user skill\n');
  const status = runStatus(ctx, ['-Strict']);
  assert.notEqual(status.status, 0, 'strict status accepted an unowned Cursor skill');
  assert.match(plainOutput(status), /untracked\s+\.cursor\/skills\/user-skill/);
}, {});

withWorkspace('cursor can be selected by maxstack.settings.json', (ctx) => {
  renameDuplicate(ctx);
  writeWorkspaceSettings(ctx, { version: 1, runtimes: { cursor: {} } });
  mustApply(ctx);
  assert.deepEqual(selectionOf(ctx).runtimes, ['cursor']);
  assert.equal(existsSync(join(ctx.workspace, '.cursor', 'skills', 'demo-skill', 'SKILL.md')), true);
}, {});

withWorkspace('cursor projects the layer selected by a local source override', (ctx) => {
  renameDuplicate(ctx);
  const alternate = join(ctx.base, 'alternate-org');
  writeLayerStub(alternate, {
    claudePlugin: 'simpsonm09-org-ai-plugin',
    extra: { 'skills/override-skill/SKILL.md': '---\nname: override-skill\ndescription: fixture\n---\noverride\n' },
  });
  mustApply(ctx, ['-Runtimes', 'cursor', '-Source', `simpsonm09-org-ai-plugin=local:${alternate}`]);
  const target = join(ctx.workspace, '.cursor', 'skills', 'override-skill', 'SKILL.md');
  assert.equal(readFileSync(target, 'utf8'), '---\nname: override-skill\ndescription: fixture\n---\noverride\n');
  assert.deepEqual(readJson(lockPath(ctx)).owned.find((record) => record.path === '.cursor/skills/override-skill').layers, ['simpsonm09-org-ai-plugin']);
}, {});

withWorkspace('cursor refuses case-insensitive duplicate skill identities before writing its target', (ctx) => {
  const result = runInstaller(shell, ctx, ['-Runtimes', 'cursor']);
  assert.notEqual(result.status, 0, 'the installer accepted duplicate skill IDs across layers');
  assert.match(plainOutput(result), /duplicate skill demo-skill across layers/);
  assert.equal(existsSync(join(ctx.workspace, '.cursor')), false, 'the duplicate refusal wrote a Cursor target');
  assert.equal(existsSync(lockPath(ctx)), false, 'the duplicate refusal wrote a lock');
}, {});

withWorkspace('cursor status detects edited skills and removal keeps the edited owned folder', (ctx) => {
  renameDuplicate(ctx);
  mustApply(ctx);
  mustApply(ctx, ['-Runtimes', 'cursor']);
  const folder = join(ctx.workspace, '.cursor', 'skills', 'demo-skill');
  const skill = join(folder, 'SKILL.md');
  const priorHash = readJson(lockPath(ctx)).owned.find((record) => record.path === '.cursor/skills/demo-skill').sha256;
  writeFileSync(skill, `${readFileSync(skill, 'utf8')}\nmanual edit\n`);
  const status = runStatus(ctx, ['-Strict']);
  assert.notEqual(status.status, 0, 'strict status accepted an edited skill');
  assert.match(plainOutput(status), /modified\s+\.cursor\/skills\/demo-skill/);

  const reapplied = runInstaller(shell, ctx);
  assert.equal(reapplied.status, 0, plainOutput(reapplied));
  assert.match(plainOutput(reapplied), /Kept .*\.cursor\/skills\/demo-skill/);
  assert.equal(readJson(lockPath(ctx)).owned.find((record) => record.path === '.cursor/skills/demo-skill').sha256, priorHash,
    'the edited folder retains its prior ownership hash');

  const removed = runInstaller(shell, ctx, ['-Remove', '-Runtimes', 'cursor']);
  assert.match(plainOutput(removed), /SKIP\s+\.cursor\/skills\/demo-skill/);
  const apply = runInstaller(shell, ctx, ['-Remove', '-Runtimes', 'cursor']);
  assert.equal(apply.status, 0, plainOutput(apply));
  assert.equal(existsSync(folder), true, 'removal deleted the edited folder');
  assert.deepEqual(selectionOf(ctx).runtimes, ALL_RUNTIMES);
}, {});

withWorkspace('cursor uninstall removes owned skill folders and the lock', (ctx) => {
  renameDuplicate(ctx);
  mustApply(ctx, ['-Runtimes', 'cursor']);
  const folder = join(ctx.workspace, '.cursor', 'skills');
  assert.equal(existsSync(folder), true);
  const dry = runInstaller(shell, ctx, ['-Uninstall'], { apply: false });
  assert.equal(dry.status, 0, plainOutput(dry));
  assert.match(plainOutput(dry), /DELETE\s+\.cursor\/skills\//);
  const removed = runInstaller(shell, ctx, ['-Uninstall']);
  assert.equal(removed.status, 0, plainOutput(removed));
  assert.equal(existsSync(folder), false, 'uninstall left owned Cursor skills');
  assert.equal(existsSync(lockPath(ctx)), false, 'uninstall left the lock');
}, {});
