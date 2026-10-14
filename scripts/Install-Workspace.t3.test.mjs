import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { lockPath, plainOutput, readJson, runInstaller, runStatus, shell, withWorkspace, writeWorkspaceSettings } from './lib/installer-test-kit.mjs';

const ids = ['instance_one', 'instance-two'];
const instancesPath = (ctx) => join(ctx.workspace, '.pstack', 'pstack-t3-instances.json');
const settings = (gatedInstances = ids) => ({ version: 1, t3: { gatedInstances } });
const readOnlySettings = (gatedInstances = [], readOnlyInstances = ids) => ({ version: 1, t3: { gatedInstances, readOnlyInstances } });
const install = (ctx, extra = [], options = {}) => runInstaller(shell, ctx, extra, options);

function addGateHooks(ctx) {
  const hooks = join(ctx.workspace, 'projects', 'repos', 'simpsonm09-org-ai-plugin', 'hooks');
  mkdirSync(join(hooks, 'lib'), { recursive: true });
  writeFileSync(join(hooks, 'pre-tool-use.mjs'), '');
  writeFileSync(join(hooks, 'lib', 'codex.mjs'), '');
}

for (const [label, values] of [
  ['not an array', 'one'],
  ['duplicate ids', ['same', 'same']],
  ['empty id', ['']],
  ['invalid punctuation', ['bad.id']],
  ['non-string id', [1]],
]) {
  withWorkspace(`gated settings refuse ${label}`, (ctx) => {
    writeWorkspaceSettings(ctx, settings(values));
    const run = install(ctx);
    assert.notEqual(run.status, 0, plainOutput(run));
    assert.match(plainOutput(run), /t3\.gatedInstances/);
    assert.equal(existsSync(lockPath(ctx)), false);
    assert.equal(existsSync(join(ctx.workspace, '.pstack')), false);
  });
}

test('the list writes selected layers and a false gate when the gate hook is absent', () => {
  withWorkspace('gated list without gate', (workspace) => {
    writeWorkspaceSettings(workspace, settings());
    const run = install(workspace);
    assert.equal(run.status, 0, plainOutput(run));
    const content = readFileSync(instancesPath(workspace), 'utf8');
    assert.doesNotMatch(content, /\r/);
    assert.ok(content.endsWith('\n'));
    assert.deepEqual(JSON.parse(content), {
      instances: {
        [ids[0]]: { layers: ['pstack', 'simpsonm09-org-ai-plugin', 'simpsonm09-personal-ai-plugin'], gate: false },
        [ids[1]]: { layers: ['pstack', 'simpsonm09-org-ai-plugin', 'simpsonm09-personal-ai-plugin'], gate: false },
      },
    });
    assert.equal(content, `${JSON.stringify(JSON.parse(content), null, 2)}\n`);
  });
});

test('the list marks the gate when the selected layer source has both gate hooks', () => {
  withWorkspace('gated list with gate', (ctx) => {
    addGateHooks(ctx);
    writeWorkspaceSettings(ctx, settings());
    const run = install(ctx);
    assert.equal(run.status, 0, plainOutput(run));
    assert.equal(readJson(instancesPath(ctx)).instances[ids[0]].gate, true);
  });
});

test('the list writes gated entries followed by read-only entries in the fixed shape', () => {
  withWorkspace('gated and read-only list', (ctx) => {
    writeWorkspaceSettings(ctx, readOnlySettings(['gated_one'], ['read_only_one']));
    const applied = install(ctx);
    assert.equal(applied.status, 0, plainOutput(applied));
    assert.deepEqual(readJson(instancesPath(ctx)).instances, {
      gated_one: { layers: ['pstack', 'simpsonm09-org-ai-plugin', 'simpsonm09-personal-ai-plugin'], gate: false },
      read_only_one: { layers: [], gate: false, readOnly: true },
    });
  });
});

test('read-only ids alone write the fixed read-only shape', () => {
  withWorkspace('read-only list only', (ctx) => {
    writeWorkspaceSettings(ctx, readOnlySettings([], ['read_only_one']));
    const applied = install(ctx);
    assert.equal(applied.status, 0, plainOutput(applied));
    assert.deepEqual(readJson(instancesPath(ctx)).instances, {
      read_only_one: { layers: [], gate: false, readOnly: true },
    });
  });
});

test('empty gated and read-only lists remove the generated file', () => {
  withWorkspace('empty T3 lists remove file', (ctx) => {
    writeWorkspaceSettings(ctx, readOnlySettings(['gated_one'], ['read_only_one']));
    assert.equal(install(ctx).status, 0);
    writeWorkspaceSettings(ctx, readOnlySettings([], []));
    const applied = install(ctx);
    assert.equal(applied.status, 0, plainOutput(applied));
    assert.equal(existsSync(instancesPath(ctx)), false);
  });
});

test('a read-only generated list is owned and strict status is clean', () => {
  withWorkspace('read-only list ownership status', (ctx) => {
    writeWorkspaceSettings(ctx, readOnlySettings([], ['read_only_one']));
    const applied = install(ctx);
    assert.equal(applied.status, 0, plainOutput(applied));
    const record = readJson(lockPath(ctx)).owned.find((item) => item.path === '.pstack/pstack-t3-instances.json');
    assert.ok(record);
    const status = runStatus(ctx, ['-Strict']);
    assert.equal(status.status, 0, plainOutput(status));
    assert.match(status.stdout, /matching\s+\.pstack\/pstack-t3-instances\.json/);
  });
});

test('a generated list is owned and strict status is clean', () => {
  withWorkspace('gated list ownership status', (ctx) => {
    writeWorkspaceSettings(ctx, settings());
    const applied = install(ctx);
    assert.equal(applied.status, 0, plainOutput(applied));
    const record = readJson(lockPath(ctx)).owned.find((item) => item.path === '.pstack/pstack-t3-instances.json');
    assert.ok(record);
    assert.ok(readJson(lockPath(ctx)).createdDirs.includes('.pstack'));
    const status = runStatus(ctx, ['-Strict']);
    assert.equal(status.status, 0, plainOutput(status));
    assert.match(status.stdout, /matching\s+\.pstack\/pstack-t3-instances\.json/);
  });
});

test('changing the configured ids reports the generated list as drifted', () => {
  withWorkspace('gated list drift', (ctx) => {
    writeWorkspaceSettings(ctx, settings(['old_instance']));
    assert.equal(install(ctx).status, 0);
    writeWorkspaceSettings(ctx, settings(['new_instance']));
    const status = runStatus(ctx);
    assert.equal(status.status, 0, plainOutput(status));
    assert.match(status.stdout, /drifted\s+\.pstack\/pstack-t3-instances\.json/);
  });
});

test('an edited generated list is kept and remains recorded as modified', () => {
  withWorkspace('gated list hand edit', (ctx) => {
    writeWorkspaceSettings(ctx, settings());
    const restored = install(ctx);
    assert.equal(restored.status, 0, plainOutput(restored));
    const edited = `${readFileSync(instancesPath(ctx), 'utf8')}\n`;
    writeFileSync(instancesPath(ctx), edited);
    const applied = install(ctx);
    assert.equal(applied.status, 0, plainOutput(applied));
    assert.equal(readFileSync(instancesPath(ctx), 'utf8'), edited);
    assert.match(plainOutput(applied), /changed since the last apply/);
    const status = runStatus(ctx);
    assert.match(status.stdout, /modified\s+\.pstack\/pstack-t3-instances\.json/);
  });
});

test('an existing unowned list is kept without being overwritten', () => {
  withWorkspace('unowned gated list', (ctx) => {
    const original = '{"personal":true}\n';
    const path = instancesPath(ctx);
    mkdirSync(join(ctx.workspace, '.pstack'), { recursive: true });
    writeFileSync(path, original);
    writeWorkspaceSettings(ctx, settings());
    const applied = install(ctx);
    assert.equal(applied.status, 0, plainOutput(applied));
    assert.equal(readFileSync(path, 'utf8'), original);
    assert.match(plainOutput(applied), /Kept \.pstack\/pstack-t3-instances\.json: it exists and was not written by maxstack/);
    assert.equal(readJson(lockPath(ctx)).owned.some((item) => item.path === '.pstack/pstack-t3-instances.json'), false);
  });
});

test('audit reports the gated list and writes nothing', () => {
  withWorkspace('gated list audit', (ctx) => {
    writeWorkspaceSettings(ctx, settings());
    const audit = install(ctx, [], { apply: false });
    assert.equal(audit.status, 0, plainOutput(audit));
    assert.match(audit.stdout, /T3 instance list: would write or keep \.pstack\/pstack-t3-instances\.json \(missing\)/);
    assert.equal(existsSync(instancesPath(ctx)), false);
    assert.equal(existsSync(lockPath(ctx)), false);
  });
});

test('an empty list removes the generated file, and remove and uninstall delete unchanged files', () => {
  withWorkspace('gated list removal', (ctx) => {
    writeWorkspaceSettings(ctx, settings());
    assert.equal(install(ctx).status, 0);
    writeWorkspaceSettings(ctx, settings([]));
    const emptied = install(ctx);
    assert.equal(emptied.status, 0, plainOutput(emptied));
    assert.equal(existsSync(instancesPath(ctx)), false);
    writeWorkspaceSettings(ctx, settings());
    const restored = install(ctx);
    assert.equal(restored.status, 0, plainOutput(restored));
    const removed = install(ctx, ['-Remove', '-Runtimes', 'pi']);
    assert.equal(removed.status, 0, plainOutput(removed));
    assert.equal(existsSync(instancesPath(ctx)), false);
    assert.equal(install(ctx).status, 0);
    const uninstalled = install(ctx, ['-Uninstall']);
    assert.equal(uninstalled.status, 0, plainOutput(uninstalled));
    assert.equal(existsSync(instancesPath(ctx)), false);
  });
});

test('the settings template contains no machine id', () => {
  const path = fileURLToPath(new URL('../workspace/maxstack.settings.json', import.meta.url));
  const template = JSON.parse(readFileSync(path, 'utf8'));
  assert.deepEqual(template.t3.gatedInstances, []);
  assert.deepEqual(template.t3.readOnlyInstances, []);
  assert.doesNotMatch(readFileSync(path, 'utf8'), /instance_one|instance-two/);
});
