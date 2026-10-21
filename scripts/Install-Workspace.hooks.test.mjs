import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LOCAL_LAYERS, lockPath, mustApply, plainOutput, readJson, removal, runStatus, selectionOf, statusRows, withWorkspace } from './lib/installer-test-kit.mjs';

const ORG = LOCAL_LAYERS[0];
const ORG_NAME = 'simpsonm09-org-ai-plugin';

const CURSOR_DEFINITION = `${JSON.stringify({
  version: 1,
  hooks: {
    beforeShellExecution: [{ command: 'node hooks/cursor.mjs', timeout: 30, failClosed: true }],
  },
}, null, 2)}\n`;

const ANTIGRAVITY_DEFINITION = `${JSON.stringify({
  hooks: {
    PreToolUse: [{ matcher: 'run_command', hooks: [{ type: 'command', command: 'node hooks/antigravity.mjs', timeout: 30 }] }],
  },
}, null, 2)}\n`;

// Both local layer stubs ship demo-skill, and the skill projection refuses a duplicate name across layers.
function renameDuplicate(ctx) {
  const folder = join(ctx.workspace, LOCAL_LAYERS[1], 'skills', 'demo-skill');
  renameSync(folder, join(ctx.workspace, LOCAL_LAYERS[1], 'skills', 'personal-demo'));
  writeFileSync(join(ctx.workspace, LOCAL_LAYERS[1], 'skills', 'personal-demo', 'SKILL.md'), '---\nname: personal-demo\ndescription: fixture\n---\nbody\n');
}

// Gives the org layer the two gate definitions and adapters, and lists hooks among its OpenCode items so the
// installed copy carries them. The definitions use the layer-relative command the org plugin ships.
function addGateHooks(ctx) {
  const root = join(ctx.workspace, ORG);
  const layer = readJson(join(root, 'layer.json'));
  if (!layer.files.includes('hooks')) layer.files.push('hooks');
  writeFileSync(join(root, 'layer.json'), JSON.stringify(layer));
  mkdirSync(join(root, 'hooks'), { recursive: true });
  writeFileSync(join(root, 'hooks', 'cursor-hooks.json'), CURSOR_DEFINITION);
  writeFileSync(join(root, 'hooks', 'cursor.mjs'), 'process.exit(0);\n');
  writeFileSync(join(root, 'hooks', 'antigravity-hooks.json'), ANTIGRAVITY_DEFINITION);
  writeFileSync(join(root, 'hooks', 'antigravity.mjs'), 'process.exit(0);\n');
}

const posixPath = (path) => path.replaceAll('\\', '/');
const hookRecord = (ctx, path) => readJson(lockPath(ctx)).owned.find((item) => item.path === path);

withWorkspace('cursor writes its gate hook with the absolute adapter path, matches in status, and reports a change', (ctx) => {
  renameDuplicate(ctx);
  addGateHooks(ctx);
  mustApply(ctx, ['-Runtimes', 'cursor']);

  const path = join(ctx.workspace, '.cursor', 'hooks.json');
  assert.ok(existsSync(path), 'the cursor hook file was not written');
  const definition = readJson(path);
  assert.equal(definition.version, 1);
  assert.equal(definition.hooks.beforeShellExecution[0].failClosed, true);
  assert.equal(definition.hooks.beforeShellExecution[0].timeout, 30);
  // Cursor alone selects neither OpenCode nor Claude, so the hook runs the adapter from the layer checkout.
  assert.equal(definition.hooks.beforeShellExecution[0].command, `node "${posixPath(join(ctx.workspace, ORG, 'hooks', 'cursor.mjs'))}"`);
  const record = hookRecord(ctx, '.cursor/hooks.json');
  assert.equal(record.runtime, 'cursor');
  assert.deepEqual(record.layers, [ORG_NAME]);

  const clean = runStatus(ctx, ['-Strict']);
  assert.equal(clean.status, 0, plainOutput(clean));
  assert.equal(statusRows(clean).find((row) => row.label === '.cursor/hooks.json')?.state, 'matching');

  writeFileSync(path, `${readFileSync(path, 'utf8')}\n`);
  const changed = runStatus(ctx, ['-Strict']);
  assert.notEqual(changed.status, 0, 'strict status accepted a changed cursor hook');
  assert.equal(statusRows(changed).find((row) => row.label === '.cursor/hooks.json')?.state, 'modified');
}, {});

withWorkspace('antigravity writes its gate hook from the installed OpenCode copy and matches in status', (ctx) => {
  renameDuplicate(ctx);
  addGateHooks(ctx);
  mustApply(ctx, ['-Runtimes', 'opencode,antigravity']);

  const path = join(ctx.workspace, '.agents', 'hooks.json');
  assert.ok(existsSync(path), 'the antigravity hook file was not written');
  const definition = readJson(path);
  assert.equal(definition.hooks.PreToolUse[0].matcher, 'run_command');
  assert.equal(definition.hooks.PreToolUse[0].hooks[0].type, 'command');
  assert.equal(definition.hooks.PreToolUse[0].hooks[0].command, `node "${posixPath(join(ctx.workspace, '.opencode', 'plugins', ORG_NAME, 'hooks', 'antigravity.mjs'))}"`);
  const record = hookRecord(ctx, '.agents/hooks.json');
  assert.equal(record.runtime, 'antigravity');
  assert.deepEqual(record.layers, [ORG_NAME]);

  const clean = runStatus(ctx, ['-Strict']);
  assert.equal(clean.status, 0, plainOutput(clean));
  assert.equal(statusRows(clean).find((row) => row.label === '.agents/hooks.json')?.state, 'matching');
}, {});

withWorkspace('an existing unowned cursor hook file is kept and named for hand installation', (ctx) => {
  renameDuplicate(ctx);
  addGateHooks(ctx);
  mkdirSync(join(ctx.workspace, '.cursor'), { recursive: true });
  writeFileSync(join(ctx.workspace, '.cursor', 'hooks.json'), '{"user": true}\n');
  const run = mustApply(ctx, ['-Runtimes', 'cursor']);
  assert.match(plainOutput(run), /exists and was not written by maxstack; add the Cursor gate hook by hand/);
  assert.equal(readFileSync(join(ctx.workspace, '.cursor', 'hooks.json'), 'utf8'), '{"user": true}\n');
  assert.equal(hookRecord(ctx, '.cursor/hooks.json'), undefined);
}, {});

withWorkspace('removing a runtime and uninstalling remove the gate hooks', (ctx) => {
  renameDuplicate(ctx);
  addGateHooks(ctx);
  mustApply(ctx);
  mustApply(ctx, ['-Runtimes', 'cursor,antigravity']);
  const cursorPath = join(ctx.workspace, '.cursor', 'hooks.json');
  const antigravityPath = join(ctx.workspace, '.agents', 'hooks.json');
  assert.ok(existsSync(cursorPath));
  assert.ok(existsSync(antigravityPath));

  const removedAntigravity = removal(ctx, ['-Remove', '-Runtimes', 'antigravity']);
  assert.equal(removedAntigravity.status, 0, plainOutput(removedAntigravity));
  assert.equal(existsSync(antigravityPath), false, 'removing antigravity left its hook');
  assert.equal(hookRecord(ctx, '.agents/hooks.json'), undefined);
  assert.ok(existsSync(cursorPath), 'removing antigravity removed the cursor hook');

  const removedCursor = removal(ctx, ['-Remove', '-Runtimes', 'cursor']);
  assert.equal(removedCursor.status, 0, plainOutput(removedCursor));
  assert.equal(existsSync(cursorPath), false, 'removing cursor left its hook');
  assert.equal(hookRecord(ctx, '.cursor/hooks.json'), undefined);
  assert.deepEqual(selectionOf(ctx).runtimes, ['claude', 'copilot', 'opencode', 'pi']);

  const uninstalled = removal(ctx, ['-Uninstall']);
  assert.equal(uninstalled.status, 0, plainOutput(uninstalled));
  assert.equal(existsSync(lockPath(ctx)), false);
}, {});
