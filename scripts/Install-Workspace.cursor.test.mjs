import assert from 'node:assert/strict';
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
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
