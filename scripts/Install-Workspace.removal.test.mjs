// Installer tests for -Remove and -Uninstall: the plan and its states, the backups and quarantines a removal
// restores, and the refusals of a lock it cannot use. Helpers come from ./lib/installer-test-kit.mjs.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, lstatSync, symlinkSync, writeFileSync, appendFileSync, rmSync, statSync, renameSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MISSING_COPILOT, NPM, ORG_FOLDER, ORG_FOLDER_FULL, ORG_SOURCE, PSTACK_NPM_FOLDER, SCHEMA1, USER_CONFIG, USER_SETTINGS, assertOk, danglingLinks, independentSha, isLink, layerNamed, lockPath, mustApply, ownedRecord, plainOutput, problemRows, readJson, removal, runInstaller, runStatus, seedSchema1, seedUserFiles, setLock, settingsPath, sha256Upper, shell, skip, snapshotTree, statusRows, stripDiscoveryLine, withFreshWorkspace, withHook, withWorkspace, withoutTimestamp, workspacePath, wrapperText, writeFile, writeLayerStub, writeLayers, writeWorkspaceSettings } from './lib/installer-test-kit.mjs';

test('the discovery line removal takes only the exact first line for this target and origin', () => {
  const workspace = 'workspace-under-test';
  const line = `Workspace: ${workspace} (from -Workspace)`;
  const cases = [
    ['exact first line, LF', `${line}\nSummary: unchanged\n`, 'Summary: unchanged\n'],
    ['exact first line, CRLF', `${line}\r\nSummary: unchanged\r\n`, 'Summary: unchanged\r\n'],
    ['exact line without a terminator', line, line],
    ['wrong target', `Workspace: other-workspace (from -Workspace)\nSummary: unchanged\n`, `Workspace: other-workspace (from -Workspace)\nSummary: unchanged\n`],
    ['wrong origin', `Workspace: ${workspace} (from script layout)\nSummary: unchanged\n`, `Workspace: ${workspace} (from script layout)\nSummary: unchanged\n`],
    ['suffix after the origin', `${line} unexpected\nSummary: unchanged\n`, `${line} unexpected\nSummary: unchanged\n`],
    ['a second copy of the line', `${line}\n${line}\nSummary: unchanged\n`, `${line}\nSummary: unchanged\n`],
    ['the line after another line', `Warning: prior\n${line}\nSummary: unchanged\n`, `Warning: prior\n${line}\nSummary: unchanged\n`],
    ['no discovery line at all', 'Summary: unchanged\n', 'Summary: unchanged\n'],
  ];
  for (const [name, input, expected] of cases) {
    assert.equal(stripDiscoveryLine(input, workspace), expected, name);
  }
});

withWorkspace('-Status -Strict fails for a pending runtime on its own, after -Remove leaves it listed', (ctx) => {
  writeWorkspaceSettings(ctx, { version: 1, runtimes: { claude: {}, pi: {} }, layers: { pstack: {} } });
  mustApply(ctx);
  assertOk(runInstaller(shell, ctx, ['-Remove', '-Runtimes', 'pi']));
  const status = runInstaller(shell, ctx, ['-Status', '-Strict'], { apply: false });
  assert.equal(status.status, 1, plainOutput(status));
  assert.match(plainOutput(status), /Settings: pending runtime 'pi'/);
  assert.doesNotMatch(plainOutput(status), /changed since|Settings: unlisted (runtime|layer)/);
}, {});

withWorkspace('-Status -Strict fails for a pending layer on its own, after -Remove leaves it listed', (ctx) => {
  const personal = 'simpsonm09-personal-ai-plugin';
  writeWorkspaceSettings(ctx, { version: 1, runtimes: { claude: {} }, layers: { pstack: {}, [personal]: {} } });
  mustApply(ctx);
  assertOk(runInstaller(shell, ctx, ['-Remove', '-Layers', personal]));
  const status = runInstaller(shell, ctx, ['-Status', '-Strict'], { apply: false });
  assert.equal(status.status, 1, plainOutput(status));
  assert.match(plainOutput(status), new RegExp(`Settings: pending layer '${personal}'`));
  assert.doesNotMatch(plainOutput(status), /changed since|Settings: unlisted (runtime|layer)/);
}, {});

// Finding 3: a dry -Remove and a dry -Uninstall report an unavailable declared source and skip its layer, with no fallback.
withWorkspace('finding 3: a dry -Remove reports an unavailable declared source and skips its layer, with no fallback', (ctx) => {
  mustApply(ctx);
  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: 'local:nope' } } });
  const skipLine = /Settings: layers\.pstack\.source resolves to no folder at .*nope\. This run skips layer pstack and has no fallback\./;
  const remove = runInstaller(shell, ctx, ['-Remove', '-Layers', 'simpsonm09-personal-ai-plugin'], { apply: false });
  assertOk(remove, plainOutput(remove));
  assert.match(plainOutput(remove), skipLine, `dry -Remove: ${plainOutput(remove)}`);
}, {});

// Item N7: a dry -Uninstall removes what the lock recorded, so it names no skipped layer, and it says that it does not read the file.
withWorkspace('finding 3: a dry -Uninstall names no skipped layer, since it does not use a declared source, and says so', (ctx) => {
  mustApply(ctx);
  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: 'local:nope' } } });
  const uninstall = runInstaller(shell, ctx, ['-Uninstall'], { apply: false });
  assertOk(uninstall, plainOutput(uninstall));
  assert.doesNotMatch(plainOutput(uninstall), /skips layer pstack/, `dry -Uninstall: ${plainOutput(uninstall)}`);
  assert.match(plainOutput(uninstall), /Settings: -Uninstall does not read maxstack\.settings\.json; it removes what the lock recorded\./, plainOutput(uninstall));
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

// Copilot is found on the command line only, so a run that names a missing command cannot find it. The wrappers it
// wrote are kept; removal happens only when the runtime or every layer stops naming copilot.
test('a Copilot run that cannot find Copilot keeps the recorded wrappers, and a deselected runtime removes them', { skip }, async (t) => {
  const copilotCmd = (ctx) => join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd');
  const copilotSh = (ctx) => join(ctx.workspace, '.maxstack', 'bin', 'copilot.sh');

  await t.test('(a) the recorded wrappers are kept byte for byte, and the lock keeps their records', () => withFreshWorkspace((ctx) => {
    mustApply(ctx);
    const before = { cmd: wrapperText(ctx, 'copilot.cmd'), sh: wrapperText(ctx, 'copilot.sh') };
    mustApply(ctx, ['-CopilotCommand', MISSING_COPILOT]);
    assert.equal(wrapperText(ctx, 'copilot.cmd'), before.cmd, 'the Copilot wrapper changed');
    assert.equal(wrapperText(ctx, 'copilot.sh'), before.sh, 'the Copilot script changed');
    const lock = readJson(lockPath(ctx));
    assert.ok(ownedRecord(lock, '.maxstack/bin/copilot.cmd', 'file'), 'the lock dropped the Copilot wrapper it recorded');
    assert.ok(ownedRecord(lock, '.maxstack/bin/copilot.sh', 'file'), 'the lock dropped the Copilot script it recorded');
  }));

  await t.test('(b) a re-run with no Copilot changes no wrapper and no lock entry', () => withFreshWorkspace((ctx) => {
    mustApply(ctx);
    mustApply(ctx, ['-CopilotCommand', MISSING_COPILOT]);
    const before = { cmd: wrapperText(ctx, 'copilot.cmd'), sh: wrapperText(ctx, 'copilot.sh'), lock: withoutTimestamp(readJson(lockPath(ctx))) };
    const run = mustApply(ctx, ['-CopilotCommand', MISSING_COPILOT]);
    assert.doesNotMatch(plainOutput(run), /Removed the stale wrapper|Wrote .*copilot/, run.stdout);
    assert.deepEqual({ cmd: wrapperText(ctx, 'copilot.cmd'), sh: wrapperText(ctx, 'copilot.sh'), lock: withoutTimestamp(readJson(lockPath(ctx))) }, before);
  }));

  await t.test('(c) status reports the kept Copilot wrappers as matching', () => withFreshWorkspace((ctx) => {
    mustApply(ctx);
    mustApply(ctx, ['-CopilotCommand', MISSING_COPILOT]);
    const run = runStatus(ctx, ['-CopilotCommand', MISSING_COPILOT]);
    assert.equal(run.status, 0, run.stderr);
    for (const name of ['.maxstack/bin/copilot.cmd', '.maxstack/bin/copilot.sh']) {
      assert.deepEqual(statusRows(run).find((row) => row.label === name), { state: 'matching', label: name }, `${name} is not reported as matching`);
    }
  }));

  await t.test('(d) -Remove -Runtimes copilot removes the recorded wrappers and their records', () => withFreshWorkspace((ctx) => {
    mustApply(ctx);
    assertOk(removal(ctx, ['-Remove', '-Runtimes', 'copilot']));
    assert.ok(!existsSync(copilotCmd(ctx)), 'the Copilot wrapper is still there after its runtime was removed');
    assert.ok(!existsSync(copilotSh(ctx)), 'the Copilot script is still there after its runtime was removed');
    const lock = readJson(lockPath(ctx));
    assert.equal(ownedRecord(lock, '.maxstack/bin/copilot.cmd', 'file'), undefined, 'the lock still owns the removed Copilot wrapper');
    assert.equal(ownedRecord(lock, '.maxstack/bin/copilot.sh', 'file'), undefined, 'the lock still owns the removed Copilot script');
  }));

  await t.test('(d2) -Remove -Runtimes copilot removes them even when the command names a missing Copilot', () => withFreshWorkspace((ctx) => {
    mustApply(ctx);
    assertOk(removal(ctx, ['-Remove', '-Runtimes', 'copilot', '-CopilotCommand', MISSING_COPILOT]));
    assert.ok(!existsSync(copilotCmd(ctx)), 'a missing Copilot kept a wrapper of a runtime that was removed');
    assert.ok(!existsSync(copilotSh(ctx)), 'a missing Copilot kept a script of a runtime that was removed');
  }));

  await t.test('(e) when no layer declares copilot, an apply removes the recorded wrappers', () => withFreshWorkspace((ctx) => {
    mustApply(ctx);
    const layersFile = writeLayers(ctx, (manifest) => {
      for (const layer of manifest.layers) delete layer.runtimes.copilot;
    });
    const run = runInstaller(shell, ctx, [], { layersFile });
    assertOk(run);
    assert.match(plainOutput(run), /Removed the stale wrapper/, run.stdout);
    assert.ok(!existsSync(copilotCmd(ctx)), 'a Copilot wrapper no layer declares is still there');
  }));
});

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

withWorkspace('uninstall refuses an escaped Claude link and leaves its outside target untouched', (ctx) => {
  mustApply(ctx);
  const outside = join(ctx.base, 'outside-link-target');
  const child = join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-org-ai-plugin');
  writeFile(outside, 'keep.txt', 'outside bytes');
  rmdirSync(child);
  symlinkSync(outside, child, 'junction');

  const run = runInstaller(shell, ctx, ['-Uninstall', '-Strict'], { apply: true });
  assert.notEqual(run.status, 0, plainOutput(run));
  assert.match(plainOutput(run), /link no longer points at its recorded target|modified by hand/);
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'outside bytes', 'uninstall changed the escaped target');
  assert.ok(lstatSync(child, { throwIfNoEntry: false }), 'uninstall removed the escaped link despite refusing its target');
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

withWorkspace('an npm-shrinkwrap.json npm generates, where none was shipped, is removed', (ctx) => {
  ctx.env.FAKE_NPM_SHRINKWRAP = '1';
  mustApply(ctx);
  assert.equal(existsSync(workspacePath(ctx, `${PSTACK_NPM_FOLDER}/npm-shrinkwrap.json`)), false, 'the shrinkwrap npm generated stayed in the folder');
  assert.deepEqual(problemRows(runStatus(ctx)), []);
}, NPM);

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

withWorkspace('a backup the apply writes is recorded with its hash, and it is reported once it exists', (ctx) => {
  mustApply(ctx);
  const config = join(ctx.workspace, 'opencode.jsonc');
  const configBefore = '{ "user": "edit" }\n';
  writeFileSync(config, configBefore);
  const settingsBefore = JSON.stringify({ ...readJson(settingsPath(ctx)), defaultModel: 'user-model' }, null, 2);
  writeFileSync(settingsPath(ctx), settingsBefore);
  assert.deepEqual(problemRows(runStatus(ctx)), [{ state: 'modified', label: 'opencode.jsonc' }], 'a backup the apply has not written was reported');

  mustApply(ctx);
  // The installer created both files, so a hand edit of either is an edited copy, never the original.
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc.bak.1'), 'utf8'), configBefore);
  assert.equal(readFileSync(join(ctx.workspace, '.pi', 'agent', 'settings.json.bak.1'), 'utf8'), settingsBefore);
  const lock = readJson(lockPath(ctx));
  assert.equal(ownedRecord(lock, 'opencode.jsonc.bak.1', 'file').sha256, sha256Upper(Buffer.from(configBefore, 'utf8')));
  assert.equal(ownedRecord(lock, '.pi/agent/settings.json.bak.1', 'file').sha256, sha256Upper(Buffer.from(settingsBefore, 'utf8')));
  assert.deepEqual(problemRows(runStatus(ctx)), []);

  appendFileSync(join(ctx.workspace, 'opencode.jsonc.bak.1'), 'x');
  assert.deepEqual(problemRows(runStatus(ctx)), [{ state: 'modified', label: 'opencode.jsonc.bak.1' }]);
}, {});

withWorkspace('a copied local layer reports a hand edit as differs, a user file as modified, and an apply restores it', (ctx) => {
  mustApply(ctx, ['-Runtimes', 'claude']);
  const copy = join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-org-ai-plugin');
  const label = '.claude/plugins/simpsonm09-org-ai-plugin';
  appendFileSync(join(copy, 'index.ts'), '// hand edit\n');
  const audit = runInstaller(shell, ctx, [], { apply: false });
  assert.match(audit.stdout, /plugins\\simpsonm09-org-ai-plugin: differs/, audit.stdout);
  assert.ok(problemRows(runStatus(ctx)).some((row) => row.state === 'modified' && row.label === label), 'the hand edit was not modified');

  writeFileSync(join(copy, 'notes.txt'), 'a user file\n');
  assert.ok(problemRows(runStatus(ctx)).some((row) => row.state === 'modified' && row.label === label), 'the user file was not modified');

  mustApply(ctx, ['-Runtimes', 'claude']);
  assert.ok(!existsSync(join(copy, 'notes.txt')), 'the apply kept the user file in the owned copy');
  const source = join(ctx.workspace, ...ORG_SOURCE.split('/'));
  for (const item of ['index.ts', 'package.json', 'skills/demo-skill/SKILL.md']) {
    assert.deepEqual(readFileSync(join(copy, ...item.split('/'))), readFileSync(join(source, ...item.split('/'))), `${item} was not restored`);
  }
  assert.deepEqual(problemRows(runStatus(ctx)), [], 'the restored copy still reports a problem');
}, {});

const PERSONAL_FOLDER = '.opencode/plugins/simpsonm09-personal-ai-plugin';

withWorkspace('removing a layer removes its folders and keeps the others, and the result is a fresh install without it', (ctx) => {
  mustApply(ctx);
  assertOk(removal(ctx, ['-Remove', '-Layers', 'simpsonm09-personal-ai-plugin']));
  assert.equal(existsSync(join(ctx.workspace, PERSONAL_FOLDER)), false, 'the layer folder remains');
  assert.equal(existsSync(join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-personal-ai-plugin')), false, 'the Claude link remains');
  assert.ok(isLink(join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-org-ai-plugin')), 'a remaining layer lost its link');
  assert.deepEqual(danglingLinks(ctx.workspace), []);

  const lock = readJson(lockPath(ctx));
  assert.deepEqual(lock.selection.layers, ['pstack', 'simpsonm09-org-ai-plugin']);
  assert.ok(!lock.owned.some((record) => record.layers.includes('simpsonm09-personal-ai-plugin')), 'a record of the removed layer remains');

  const removed = snapshotTree(ctx.workspace, { skipLockBackup: true, skipGit: true });
  assertOk(removal(ctx, ['-Uninstall']));
  mustApply(ctx, ['-Layers', 'pstack,simpsonm09-org-ai-plugin']);
  assert.deepEqual(snapshotTree(ctx.workspace, { skipLockBackup: true, skipGit: true }), removed);
}, {});

withWorkspace('a hand-edited owned file is skipped and reported, the rest is removed, and a retry after the fix finishes', (ctx) => {
  seedUserFiles(ctx);
  const before = snapshotTree(ctx.workspace);
  mustApply(ctx);
  const wrapper = join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd');
  const original = readFileSync(wrapper);
  appendFileSync(wrapper, 'rem hand edit\r\n');

  const first = removal(ctx, ['-Uninstall']);
  assertOk(first);
  assert.match(first.stdout, /^SKIP\s+\.maxstack\/bin\/copilot\.cmd\s+modified by hand/m, first.stdout);
  assert.deepEqual(readJson(lockPath(ctx)).owned.map((record) => record.path), ['.maxstack/bin/copilot.cmd'], 'the lock kept more than the skipped record');
  assert.equal(existsSync(join(ctx.workspace, '.opencode')), false, 'the OpenCode folders were not removed');
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), USER_CONFIG);

  writeFileSync(wrapper, original);
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(existsSync(lockPath(ctx)), false, 'the retry did not finish');
  assert.deepEqual(snapshotTree(ctx.workspace), before);
}, {});

withWorkspace('a file a user adds to an owned folder keeps the folder, and a retry after the user removes it finishes', (ctx) => {
  seedUserFiles(ctx);
  const before = snapshotTree(ctx.workspace);
  mustApply(ctx);
  const note = join(ctx.workspace, ORG_FOLDER, 'mine.txt');
  writeFileSync(note, 'mine\n');

  const first = removal(ctx, ['-Uninstall']);
  assertOk(first);
  assert.match(first.stdout, /^SKIP\s+\.opencode\/plugins\/simpsonm09-org-ai-plugin\s+modified by hand/m, first.stdout);
  assert.equal(readFileSync(note, 'utf8'), 'mine\n', 'the user file was deleted');

  rmSync(note);
  assertOk(removal(ctx, ['-Uninstall']));
  assert.deepEqual(snapshotTree(ctx.workspace), before);
}, {});

withWorkspace('a junction inside an owned folder is removed as a link, and its target outside the workspace is untouched', (ctx) => {
  mustApply(ctx);
  const outside = join(ctx.base, 'outside');
  writeFile(outside, 'keep.txt', 'outside bytes\n');
  symlinkSync(outside, join(ctx.workspace, ORG_FOLDER, 'skills', 'linked'), 'junction');
  // The folder's record names the link, so the installer's own copy of the folder holds it.
  const lock = readJson(lockPath(ctx));
  ownedRecord(lock, ORG_FOLDER, 'dir').sha256 = independentSha(join(ctx.workspace, ...ORG_FOLDER.split('/')), 'owned');
  setLock(ctx, lock);

  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'outside bytes\n', 'the link target was changed');
  assert.equal(existsSync(join(ctx.workspace, ORG_FOLDER)), false, 'the owned folder remains');
}, {});

withWorkspace('a tampered record that names a path outside the workspace is skipped, and nothing outside is touched', (ctx) => {
  mustApply(ctx);
  const relativeFile = join(ctx.base, 'outside-relative.txt');
  const absoluteFile = join(ctx.base, 'outside-absolute.txt');
  writeFileSync(relativeFile, 'keep\n');
  writeFileSync(absoluteFile, 'keep too\n');
  const lock = readJson(lockPath(ctx));
  lock.owned.push({ path: '../outside-relative.txt', kind: 'file', sha256: sha256Upper(Buffer.from('keep\n')), runtime: 'copilot', layers: [] });
  lock.owned.push({ path: absoluteFile.replaceAll('\\', '/'), kind: 'file', sha256: sha256Upper(Buffer.from('keep too\n')), runtime: 'copilot', layers: [] });
  setLock(ctx, lock);

  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.match(run.stdout, /^SKIP\s+\.\.\/outside-relative\.txt\s+outside the workspace: the record does not name a workspace path/m, run.stdout);
  assert.match(run.stdout, /^SKIP\s+.+outside-absolute\.txt\s+outside the workspace: the record does not name a workspace path/m, run.stdout);
  assert.equal(readFileSync(relativeFile, 'utf8'), 'keep\n');
  assert.equal(readFileSync(absoluteFile, 'utf8'), 'keep too\n');
  assert.equal(readJson(lockPath(ctx)).owned.length, 2, 'the lock dropped a skipped record');
}, {});

withWorkspace('a dry run prints the plan with a state for each path, and writes nothing', (ctx) => {
  seedUserFiles(ctx);
  mustApply(ctx);
  const before = snapshotTree(ctx.workspace);

  const remove = removal(ctx, ['-Remove', '-Runtimes', 'pi'], { apply: false });
  assertOk(remove);
  assert.match(remove.stdout, /^DELETE\s+\.maxstack\/bin\/pi\.cmd\s/m, remove.stdout);
  assert.match(remove.stdout, /^RESTORE\s+\.pi\/agent\/settings\.json\s/m, remove.stdout);
  assert.match(remove.stdout, /^Dry run: nothing was removed or written/m);
  assert.deepEqual(snapshotTree(ctx.workspace), before, '-Remove without -Apply wrote');

  const uninstall = removal(ctx, ['-Uninstall'], { apply: false });
  assertOk(uninstall);
  assert.match(uninstall.stdout, /^RESTORE\s+opencode\.jsonc\s/m, uninstall.stdout);
  assert.match(uninstall.stdout, /^DELETE\s+\.claude\/cache\/pstack\s/m, uninstall.stdout);
  assert.deepEqual(snapshotTree(ctx.workspace), before, '-Uninstall without -Apply wrote');
}, {});

withWorkspace('a second uninstall, and a remove of what is not selected, find nothing to remove and change nothing', (ctx) => {
  seedUserFiles(ctx);
  const before = snapshotTree(ctx.workspace);
  mustApply(ctx, ['-Runtimes', 'claude,copilot']);
  const notSelected = removal(ctx, ['-Remove', '-Runtimes', 'pi']);
  assertOk(notSelected);
  assert.match(notSelected.stdout, /runtime 'pi' is not selected, so there is nothing to remove for it/);
  assert.match(notSelected.stdout, /Nothing to remove/);

  assertOk(removal(ctx, ['-Uninstall']));
  assert.deepEqual(snapshotTree(ctx.workspace), before);
  const again = removal(ctx, ['-Uninstall']);
  assertOk(again);
  assert.match(again.stdout, /Nothing to remove/);
  assert.deepEqual(snapshotTree(ctx.workspace), before, 'a second uninstall changed the tree');
}, {});

withWorkspace('-Strict makes a removal that skips anything exit 1, and a clean removal exit 0', (ctx) => {
  mustApply(ctx);
  assert.equal(removal(ctx, ['-Uninstall', '-Strict'], { apply: false }).status, 0, 'a clean dry run failed');
  appendFileSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd'), 'rem hand edit\r\n');
  assert.equal(removal(ctx, ['-Uninstall', '-Strict'], { apply: false }).status, 1, 'a dry run with a skip passed');
  assert.equal(removal(ctx, ['-Uninstall', '-Strict']).status, 1, 'an apply with a skip passed');
  assert.ok(existsSync(lockPath(ctx)), 'the lock was removed with a skip');
}, {});

withWorkspace('-Remove and -Uninstall refuse a lock with no usable record, and write nothing', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  const { owned, ...withoutOwned } = lock;
  // A schema-1 lock with an owned list still uninstalls (item 9), so only -Remove refuses it.
  const both = [['-Uninstall', '-Apply'], ['-Remove', '-Runtimes', 'pi', '-Apply']];
  const removeOnly = [['-Remove', '-Runtimes', 'pi', '-Apply']];
  const cases = [
    ['no lock', null, /There is no usable ownership record/, both],
    ['ownedSchema 1', { ...lock, ownedSchema: 1 }, /its ownedSchema is 1, and -Remove needs version 2/, removeOnly],
    ['no owned list', withoutOwned, /it has no owned list/, both],
  ];
  for (const [label, value, pattern, argsList] of cases) {
    if (value === null) rmSync(lockPath(ctx)); else setLock(ctx, value);
    const before = snapshotTree(ctx.workspace);
    for (const args of argsList) {
      const run = runInstaller(shell, ctx, args, { apply: false });
      assert.equal(run.status, 1, `${label}: ${args.join(' ')}\n${run.stdout}\n${run.stderr}`);
      assert.match(plainOutput(run), pattern, label);
      assert.match(plainOutput(run), /Install-Workspace\.ps1 -Apply once/, label);
      assert.deepEqual(snapshotTree(ctx.workspace), before, `${label}: ${args.join(' ')} wrote`);
    }
  }
}, {});

// Backups and the Pi settings. The original backup is the one restore source; a hand edit made after it goes to a
// numbered copy. The settings are edited as strict JSON, so dates, nulls, depth, and key order survive a write.
const ORIGINAL_CONFIG = '{\n  "original": true\n}\n';

withWorkspace('a hand edit after the first apply goes to a numbered backup, and the original backup is never overwritten', (ctx) => {
  writeFile(ctx.workspace, 'opencode.jsonc', ORIGINAL_CONFIG);
  mustApply(ctx);
  writeFileSync(join(ctx.workspace, 'opencode.jsonc'), '{\n  "hand": "edit"\n}\n');
  mustApply(ctx);
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc.bak'), 'utf8'), ORIGINAL_CONFIG, 'the original backup was overwritten');
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc.bak.1'), 'utf8'), '{\n  "hand": "edit"\n}\n', 'the hand edit was not kept');
  const lock = readJson(lockPath(ctx));
  assert.equal(ownedRecord(lock, 'opencode.jsonc.bak', 'file').role, 'original');
  assert.equal(ownedRecord(lock, 'opencode.jsonc.bak.1', 'file').role, 'edited');
}, {});

withWorkspace('-Remove -Apply keeps a hand-edited Copilot wrapper even when the apply finds no Copilot executable', (ctx) => {
  mustApply(ctx);
  const wrapper = join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd');
  appendFileSync(wrapper, 'rem hand edit\r\n');
  const run = runInstaller(shell, ctx, ['-Remove', '-Runtimes', 'pi', '-Apply', '-CopilotCommand', MISSING_COPILOT], { apply: false });
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  assert.ok(existsSync(wrapper), 'a hand-edited wrapper was deleted without its hash matching the record');
  assert.match(run.stdout, /Kept .*copilot\.cmd: it is not the installer's recorded copy/);
}, {});

// Removal fixes: quarantine, already-gone records, the restore fallback, excluded folders, the swap check, the summary
// line, strays, and offline uninstall from a schema-1 lock.

// Holds a file open without sharing, from another process, until the returned child is killed.
// The ready marker goes to the temp folder, not beside the file: a marker inside an owned folder would change its hash.
function holdExclusive(path) {
  const ready = join(tmpdir(), `maxstack-ready-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const script = `$f = [IO.File]::Open('${path.replaceAll("'", "''")}', 'Open', 'Read', 'Read'); New-Item -ItemType File -Path '${ready.replaceAll("'", "''")}' | Out-Null; Start-Sleep -Seconds 300`;
  const child = spawn(shell, ['-NoProfile', '-Command', script], { windowsHide: true, stdio: 'ignore' });
  const deadline = Date.now() + 60000;
  while (!existsSync(ready)) {
    if (Date.now() > deadline) throw new Error(`the holder did not open ${path}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
  }
  rmSync(ready, { force: true });
  return child;
}

const ORIGINAL_CONFIG_B = '{\n  "original": true\n}\n';

withWorkspace('a folder with a file held open by another process is kept, and a retry after the file is released finishes', (ctx) => {
  seedUserFiles(ctx);
  const before = snapshotTree(ctx.workspace, { skipGit: true });
  mustApply(ctx);
  const held = join(ctx.workspace, ORG_FOLDER, 'skills', 'demo-skill', 'SKILL.md');
  const holder = holdExclusive(held);
  try {
    const first = removal(ctx, ['-Uninstall']);
    assertOk(first);
    assert.match(first.stdout, /^SKIP\s+\.opencode\/plugins\/simpsonm09-org-ai-plugin\s+in use/m, first.stdout);
    assert.ok(existsSync(ORG_FOLDER_FULL(ctx)) || existsSync(`${ORG_FOLDER_FULL(ctx)}.maxstack-removing`), 'the folder in use was lost');
  } finally {
    holder.kill();
  }
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(existsSync(lockPath(ctx)), false, 'the retry did not finish');
  assert.deepEqual(snapshotTree(ctx.workspace, { skipGit: true }), before);
}, {});

withWorkspace('a recorded file the user already deleted is complete, not a skip, and the uninstall removes the lock', (ctx) => {
  mustApply(ctx);
  rmSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.sh'));
  const run = removal(ctx, ['-Uninstall', '-Strict']);
  assertOk(run);
  assert.match(run.stdout, /^GONE\s+\.maxstack\/bin\/copilot\.sh\s/m, run.stdout);
  assert.equal(existsSync(lockPath(ctx)), false, 'the lock was kept for an already-gone record');
}, {});

withWorkspace('a run that stops between a delete and its lock write finishes on the next run', (ctx) => {
  const before = snapshotTree(ctx.workspace);
  mustApply(ctx);
  const target = '.maxstack/bin/copilot.cmd';
  const crashed = withHook(`crash:${target}`, () => removal(ctx, ['-Uninstall']));
  assert.notEqual(crashed.status, 0, `the injected fault did not stop the run\n${crashed.stdout}`);
  assert.equal(readJson(lockPath(ctx)).owned.some((record) => record.path === target), true, 'the lock lost the record before its write');
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(existsSync(lockPath(ctx)), false);
  assert.deepEqual(snapshotTree(ctx.workspace), before);
}, {});

withWorkspace('uninstall restores the original config, never a hand edit, and keeps the numbered copy', (ctx) => {
  writeFile(ctx.workspace, 'opencode.jsonc', ORIGINAL_CONFIG_B);
  mustApply(ctx);
  writeFileSync(join(ctx.workspace, 'opencode.jsonc'), '{\n  "hand": "edit"\n}\n');
  mustApply(ctx);
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), ORIGINAL_CONFIG_B, 'the restore did not use the original');
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc.bak.1'), 'utf8'), '{\n  "hand": "edit"\n}\n', 'the hand edit was not kept');
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc.bak')), false);
}, {});

withWorkspace('a modified original backup is kept and not restored, and the config goes by its own record', (ctx) => {
  writeFile(ctx.workspace, 'opencode.jsonc', ORIGINAL_CONFIG_B);
  mustApply(ctx);
  const edited = '{\n  "edited": "backup"\n}\n';
  writeFileSync(join(ctx.workspace, 'opencode.jsonc.bak'), edited);
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.match(run.stdout, /^KEEP\s+opencode\.jsonc\.bak\s+kept: the original backup changed by hand, so it is not restored/m, run.stdout);
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc.bak'), 'utf8'), edited, 'the modified backup was changed');
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc')), false, 'the config was not removed by its own record');
}, {});

withWorkspace('a file swapped for a folder after the plan is refused, and the folder is not deleted', (ctx) => {
  mustApply(ctx);
  const target = '.maxstack/bin/copilot.cmd';
  const run = withHook(`swap:${target}`, () => removal(ctx, ['-Uninstall']));
  assertOk(run);
  assert.match(run.stdout, /^SKIP\s+\.maxstack\/bin\/copilot\.cmd\s+could not be removed: changed since the plan/m, run.stdout);
  assert.ok(statSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd')).isDirectory(), 'the swapped folder was deleted');
}, {});

withWorkspace('a partial uninstall ends with one line that says how many items were skipped and that the lock is kept', (ctx) => {
  mustApply(ctx);
  appendFileSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd'), 'rem hand edit\r\n');
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  const lines = run.stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  assert.equal(lines[lines.length - 1], '1 items skipped; lock kept; rerun -Uninstall -Apply to retry.', run.stdout);
}, {});

withWorkspace('a restore that cannot replace its file leaves no uninstall copy behind, and a rerun finishes', (ctx) => {
  writeFile(ctx.workspace, '.pi/agent/settings.json', USER_SETTINGS);
  mustApply(ctx);
  const holder = holdExclusive(settingsPath(ctx));
  let first;
  try {
    first = removal(ctx, ['-Uninstall']);
    assertOk(first);
    assert.equal(existsSync(`${settingsPath(ctx)}.uninstall-restore`), false, 'a copy was left behind');
    assert.equal(existsSync(`${settingsPath(ctx)}.uninstall-replaced`), false, 'a copy was left behind');
    assert.match(first.stdout, /^SKIP\s+\.pi\/agent\/settings\.json\s+could not be removed/m, first.stdout);
  } finally {
    holder.kill();
  }
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(readFileSync(settingsPath(ctx), 'utf8'), USER_SETTINGS);
}, {});

withWorkspace('uninstall works from a schema-1 lock that has an owned list, and remove still refuses it', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  lock.ownedSchema = 1;
  delete lock.pi.settingsSha256;
  for (const record of lock.owned) {
    delete record.runtime;
    delete record.layers;
    delete record.role;
  }
  setLock(ctx, lock);
  const refused = removal(ctx, ['-Remove', '-Runtimes', 'pi']);
  assert.notEqual(refused.status, 0, refused.stdout);
  assert.match(plainOutput(refused), /its ownedSchema is 1, and -Remove needs version 2/, refused.stdout);
  assert.equal(existsSync(lockPath(ctx)), true, 'the refused -Remove removed the lock');
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(existsSync(lockPath(ctx)), false, 'the lock remains');
  assert.equal(existsSync(join(ctx.workspace, '.opencode')), false, 'the OpenCode folders remain');
}, {});

withWorkspace('the folders that were there before the install are kept, with their user files, and the round trip holds', (ctx) => {
  writeFile(ctx.workspace, '.claude/user-note.txt', 'mine\n');
  writeFile(ctx.workspace, '.opencode/mine/x.txt', 'mine\n');
  const before = snapshotTree(ctx.workspace);
  mustApply(ctx);
  assertOk(removal(ctx, ['-Uninstall']));
  assert.deepEqual(snapshotTree(ctx.workspace), before);
}, {});

withWorkspace('the user removed a backup: its copy is gone, the config is restored by deleting the installer copy, and the lock is removed', (ctx) => {
  writeFile(ctx.workspace, 'opencode.jsonc', ORIGINAL_CONFIG_B);
  mustApply(ctx);
  rmSync(join(ctx.workspace, 'opencode.jsonc.bak'));
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.match(run.stdout, /^GONE\s+opencode\.jsonc\.bak\s/m, run.stdout);
  assert.equal(existsSync(lockPath(ctx)), false);
}, {});

// Review 2, item 1: a .bak the installer did not write is the user's. The live config is kept in a numbered copy as the
// original, and the user's copy is left untouched and never deleted.
withWorkspace('a user backup beside the live config is kept, and the live config is recoverable byte for byte after apply and uninstall', (ctx) => {
  const live = '{\n  "live": true\n}\n';
  const userBackup = '{\n  "user": "backup"\n}\n';
  writeFile(ctx.workspace, 'opencode.jsonc', live);
  writeFile(ctx.workspace, 'opencode.jsonc.bak', userBackup);
  const run = mustApply(ctx);
  assert.match(run.stdout, /Backed up the previous config to .*opencode\.jsonc\.bak\.1/, run.stdout);
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc.bak.1'), 'utf8'), live, 'the live config was not kept');
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc.bak'), 'utf8'), userBackup, 'the user backup changed on apply');
  const lock = readJson(lockPath(ctx));
  assert.equal(ownedRecord(lock, 'opencode.jsonc.bak.1', 'file').role, 'original', 'the live copy is not the original');
  assert.equal(ownedRecord(lock, 'opencode.jsonc.bak', 'file').role, 'user', 'the user backup is not recorded as the user\'s');
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), live, 'the live config was not restored');
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc.bak'), 'utf8'), userBackup, 'the user backup changed on uninstall');
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc.bak.1')), false, 'the restored copy was left behind');
}, {});

// Review 2, item 2: the installer created the config and the Pi settings. A hand edit of either, made after the first
// apply, is an edited copy. It is never the original, so uninstall does not put it back as the file the install replaced.
withWorkspace('a hand edit of files the installer created is kept as an edited copy, and uninstall never restores it as the original', (ctx) => {
  mustApply(ctx);
  const handConfig = '{\n  "hand": "config"\n}\n';
  const handSettings = '{\n  "packages": [\n    "hand-package"\n  ]\n}\n';
  writeFileSync(join(ctx.workspace, 'opencode.jsonc'), handConfig);
  writeFileSync(settingsPath(ctx), handSettings);
  mustApply(ctx);
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc.bak.1'), 'utf8'), handConfig, 'the config edit was not kept as an edited copy');
  assert.equal(readFileSync(`${settingsPath(ctx)}.bak.1`, 'utf8'), handSettings, 'the settings edit was not kept as an edited copy');
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc.bak')), false, 'a hand edit became the original config backup');
  assert.equal(existsSync(`${settingsPath(ctx)}.bak`), false, 'a hand edit became the original settings backup');
  const lock = readJson(lockPath(ctx));
  assert.equal(ownedRecord(lock, 'opencode.jsonc.bak.1', 'file').role, 'edited');
  assert.equal(ownedRecord(lock, '.pi/agent/settings.json.bak.1', 'file').role, 'edited');

  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.doesNotMatch(run.stdout, /^RESTORE\s+opencode\.jsonc\s/m, run.stdout);
  assert.doesNotMatch(run.stdout, /^RESTORE\s+\.pi\/agent\/settings\.json\s/m, run.stdout);
  assert.match(run.stdout, /^KEEP\s+opencode\.jsonc\.bak\.1\s/m, run.stdout);
  assert.match(run.stdout, /^KEEP\s+\.pi\/agent\/settings\.json\.bak\.1\s/m, run.stdout);
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc.bak.1'), 'utf8'), handConfig, 'the kept edit changed');
  // The second apply wrote the installer's text back, so the config is the installer's and is removed; the edit is not put back.
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc')), false, 'the installer-created config was not removed');
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc.bak')), false);
}, {});

// Review 2, item 3: a run that restored the config and stopped before its lock write must finish on the next run. The
// backup is gone and the config holds its bytes, so the restore is complete, not a hand edit to skip.
withWorkspace('a run that stops after restoring the config and before its lock write finishes on the next run', (ctx) => {
  const original = '{\n  "original": true\n}\n';
  writeFile(ctx.workspace, 'opencode.jsonc', original);
  mustApply(ctx);
  const crashed = withHook('crash:opencode.jsonc', () => removal(ctx, ['-Uninstall']));
  assert.notEqual(crashed.status, 0, `the injected fault did not stop the run\n${crashed.stdout}`);
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), original, 'the restore did not happen before the fault');
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc.bak')), false);
  assert.equal(existsSync(lockPath(ctx)), true, 'the lock was written before the fault');
  const retry = removal(ctx, ['-Uninstall']);
  assertOk(retry);
  assert.doesNotMatch(retry.stdout, /modified by hand/, retry.stdout);
  assert.match(retry.stdout, /^GONE\s+opencode\.jsonc\s+already restored/m, retry.stdout);
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), original, 'the retry changed the restored config');
  assert.equal(existsSync(lockPath(ctx)), false, 'the retry did not remove the lock');
}, {});

withWorkspace('a real schema-1 lock with a pre-existing config restores the original from its role-less backup', (ctx) => {
  seedSchema1(ctx, 'preexisting-config', [['opencode.jsonc', 'opencode.jsonc'], ['opencode.jsonc.bak', 'opencode.jsonc.bak']]);
  const original = readFileSync(join(SCHEMA1, 'preexisting-config', 'opencode.jsonc.bak.fixture'), 'utf8');
  assert.equal(readJson(lockPath(ctx)).ownedSchema, 1);
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.match(run.stdout, /^RESTORE\s+opencode\.jsonc\s/m, run.stdout);
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), original, 'the original was not restored');
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc.bak')), false, 'the restored backup was left behind');
  assert.equal(existsSync(lockPath(ctx)), false, 'the lock remains');
}, {});

withWorkspace('a real schema-1 lock whose config changed since the install keeps the config and names the original in its backup', (ctx) => {
  seedSchema1(ctx, 'preexisting-config', [['opencode.jsonc', 'opencode.jsonc'], ['opencode.jsonc.bak', 'opencode.jsonc.bak']]);
  const changed = '{\n  "changed": true\n}\n';
  writeFile(ctx.workspace, 'opencode.jsonc', changed);
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), changed, 'the changed config was deleted or overwritten');
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc.bak')), true, 'the original backup was deleted');
  assert.match(run.stdout, /^KEEP\s+opencode\.jsonc\s+kept: it changed since the install, so the original is not restored; the original is in opencode\.jsonc\.bak/m, run.stdout);
  assert.match(run.stdout, /Kept on disk, not restored or deleted: .*opencode\.jsonc\.bak/, run.stdout);
  assert.doesNotMatch(run.stdout, /every recorded path was removed/, 'the summary claims a removal that did not happen');
}, {});

// Review 2, item 5: a quarantine folder that is not the one this lock journaled is the user's. It is named, and kept.
withWorkspace('a folder with the quarantine name beside a recorded folder is the user\'s, and a removal does not delete it', (ctx) => {
  mustApply(ctx);
  rmSync(ORG_FOLDER_FULL(ctx), { recursive: true, force: true });
  writeFile(ctx.workspace, `${ORG_FOLDER}.maxstack-removing/user.txt`, 'mine\n');
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.match(run.stdout, /^SKIP\s+\.opencode\/plugins\/simpsonm09-org-ai-plugin\s+in the way: a folder named simpsonm09-org-ai-plugin\.maxstack-removing exists/m, run.stdout);
  assert.equal(readFileSync(join(ctx.workspace, `${ORG_FOLDER}.maxstack-removing`, 'user.txt'), 'utf8'), 'mine\n', 'the user folder was deleted');
  assert.equal(existsSync(lockPath(ctx)), true, 'the lock was removed beside a skipped folder');
}, {});

// A quarantine the lock journaled, whose files changed after the journal, is kept and named. An unchanged one is resumed.
withWorkspace('a journaled quarantine whose files changed since the journal is kept and named', (ctx) => {
  mustApply(ctx);
  const quarantine = `${ORG_FOLDER_FULL(ctx)}.maxstack-removing`;
  renameSync(ORG_FOLDER_FULL(ctx), quarantine);
  writeFileSync(join(quarantine, 'skills', 'demo-skill', 'SKILL.md'), 'changed by the user\n');
  const lock = readJson(lockPath(ctx));
  ownedRecord(lock, ORG_FOLDER, 'dir').quarantine = 'simpsonm09-org-ai-plugin.maxstack-removing';
  setLock(ctx, lock);
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.match(run.stdout, /^SKIP\s+\.opencode\/plugins\/simpsonm09-org-ai-plugin\s+in the way/m, run.stdout);
  assert.equal(readFileSync(join(quarantine, 'skills', 'demo-skill', 'SKILL.md'), 'utf8'), 'changed by the user\n', 'the changed folder was deleted');
}, {});

withWorkspace('a journaled quarantine whose files are unchanged is resumed and deleted by the uninstall', (ctx) => {
  mustApply(ctx);
  const quarantine = `${ORG_FOLDER_FULL(ctx)}.maxstack-removing`;
  renameSync(ORG_FOLDER_FULL(ctx), quarantine);
  const lock = readJson(lockPath(ctx));
  ownedRecord(lock, ORG_FOLDER, 'dir').quarantine = 'simpsonm09-org-ai-plugin.maxstack-removing';
  setLock(ctx, lock);
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.match(run.stdout, /^DELETE\s+\.opencode\/plugins\/simpsonm09-org-ai-plugin\s+resumes the removal/m, run.stdout);
  assert.equal(existsSync(quarantine), false, 'the quarantine was not deleted');
  assert.equal(existsSync(lockPath(ctx)), false, 'the lock remains');
}, {});

// Review 2, item 6: a leftover copy whose bytes the lock records is deleted; any other leftover is named and kept, and
// the lock stays for it.
withWorkspace('a leftover copy the lock knows is deleted, and an unknown one is named, kept, and keeps the lock', (ctx) => {
  mustApply(ctx);
  const known = join(ctx.workspace, 'opencode.jsonc.maxstack-tmp');
  writeFileSync(known, readFileSync(join(ctx.workspace, 'opencode.jsonc')));
  const unknown = join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd.uninstall-restore');
  writeFileSync(unknown, 'unknown\n');
  const plan = removal(ctx, ['-Uninstall'], { apply: false });
  assertOk(plan);
  assert.match(plan.stdout, /^DELETE\s+opencode\.jsonc\.maxstack-tmp\s/m, plan.stdout);
  assert.match(plan.stdout, /^SKIP\s+\.maxstack\/bin\/copilot\.cmd\.uninstall-restore\s+a leftover copy/m, plan.stdout);
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.equal(existsSync(known), false, 'the known copy was kept');
  assert.equal(readFileSync(unknown, 'utf8'), 'unknown\n', 'the unknown copy was changed or deleted');
  assert.match(run.stdout, /items skipped; lock kept; rerun -Uninstall -Apply to retry/, run.stdout);
  assert.equal(existsSync(lockPath(ctx)), true, 'the lock was removed beside an unknown copy');
}, {});

withWorkspace('an apply deletes a leftover copy the lock knows and names the rest', (ctx) => {
  mustApply(ctx);
  const known = join(ctx.workspace, 'opencode.jsonc.maxstack-old');
  writeFileSync(known, readFileSync(join(ctx.workspace, 'opencode.jsonc')));
  const unknown = join(ctx.workspace, '.maxstack', 'bin', 'pi.sh.uninstall-replaced');
  writeFileSync(unknown, 'unknown\n');
  const run = mustApply(ctx);
  assert.equal(existsSync(known), false, 'the apply kept a copy the lock knows');
  assert.match(run.stdout, /^SKIP\s+\.maxstack\/bin\/pi\.sh\.uninstall-replaced\s+a leftover copy of \.maxstack\/bin\/pi\.sh whose bytes the lock does not record/m, run.stdout);
  assert.equal(readFileSync(unknown, 'utf8'), 'unknown\n', 'the apply changed an unknown copy');
}, {});

// Review 2, item 5: a plain apply does not delete a quarantine folder, and it names one an interrupted removal left.
withWorkspace('a plain apply names a quarantine folder beside a recorded folder, and leaves it in place', (ctx) => {
  mustApply(ctx);
  const quarantine = `${ORG_FOLDER_FULL(ctx)}.maxstack-removing`;
  writeFile(ctx.workspace, `${ORG_FOLDER}.maxstack-removing/left.txt`, 'left\n');
  const run = mustApply(ctx);
  assert.match(run.stdout, /^SKIP\s+\.opencode\/plugins\/simpsonm09-org-ai-plugin\.maxstack-removing\s+a folder with the removal quarantine name/m, run.stdout);
  assert.equal(readFileSync(join(quarantine, 'left.txt'), 'utf8'), 'left\n', 'the apply changed the quarantine folder');
}, {});

// Review 3, item 1: a restore that stopped before its lock write, then a plain apply. The live file is the original again,
// so the apply writes it back as the original, and uninstall restores it byte for byte.
withWorkspace('a plain apply after a config restore that stopped keeps the user config as the original, and uninstall restores it byte for byte', (ctx) => {
  const user = '{\n  "user": "config"\n}\n';
  writeFile(ctx.workspace, 'opencode.jsonc', user);
  mustApply(ctx);
  const crashed = withHook('crash:opencode.jsonc', () => removal(ctx, ['-Uninstall']));
  assert.notEqual(crashed.status, 0, `the injected fault did not stop the run\n${crashed.stdout}`);
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), user, 'the restore did not happen before the fault');
  mustApply(ctx);
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc.bak'), 'utf8'), user, 'the user config was not kept as the original');
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc.bak.1')), false, 'the user config was filed as an edited copy');
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), user, 'the user config was not restored byte for byte');
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc.bak')), false, 'the restored original was left behind');
}, {});

withWorkspace('an upgrade apply over a real schema-1 lock with a pre-existing config keeps the original, and uninstall restores it', (ctx) => {
  seedSchema1(ctx, 'preexisting-config', [['opencode.jsonc', 'opencode.jsonc'], ['opencode.jsonc.bak', 'opencode.jsonc.bak']]);
  const original = readFileSync(join(SCHEMA1, 'preexisting-config', 'opencode.jsonc.bak.fixture'), 'utf8');
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  assert.equal(ownedRecord(lock, 'opencode.jsonc.bak', 'file').role, 'original');
  assert.equal(lock.createdFiles.includes('opencode.jsonc'), false, 'a pre-existing config was recorded as created');
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(readFileSync(join(ctx.workspace, 'opencode.jsonc'), 'utf8'), original, 'the original was not restored');
  assert.equal(existsSync(join(ctx.workspace, 'opencode.jsonc.bak')), false, 'the restored original was left behind');
}, {});

// Review 3, item 3: a plain apply after a removal that journaled a quarantine.
withWorkspace('a plain apply finishes a journaled quarantine it left, prints it once, and writes the folder again', (ctx) => {
  mustApply(ctx);
  const quarantine = `${ORG_FOLDER_FULL(ctx)}.maxstack-removing`;
  renameSync(ORG_FOLDER_FULL(ctx), quarantine);
  const lock = readJson(lockPath(ctx));
  ownedRecord(lock, ORG_FOLDER, 'dir').quarantine = 'simpsonm09-org-ai-plugin.maxstack-removing';
  setLock(ctx, lock);
  const run = mustApply(ctx);
  assert.equal(existsSync(quarantine), false, 'the journaled quarantine was kept');
  assert.equal(existsSync(ORG_FOLDER_FULL(ctx)), true, 'the folder was not written again');
  assert.equal(run.stdout.split(/\r?\n/).filter((line) => line.includes('maxstack-removing')).length, 1, run.stdout);
  assert.doesNotMatch(run.stdout, /Rerun -Uninstall/, run.stdout);
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(existsSync(lockPath(ctx)), false, 'the lock remains');
}, {});

withWorkspace('a plain apply keeps a journaled quarantine whose files changed, names it once, and keeps the journal', (ctx) => {
  mustApply(ctx);
  const quarantine = `${ORG_FOLDER_FULL(ctx)}.maxstack-removing`;
  renameSync(ORG_FOLDER_FULL(ctx), quarantine);
  writeFileSync(join(quarantine, 'skills', 'demo-skill', 'SKILL.md'), 'changed by the user\n');
  const lock = readJson(lockPath(ctx));
  ownedRecord(lock, ORG_FOLDER, 'dir').quarantine = 'simpsonm09-org-ai-plugin.maxstack-removing';
  setLock(ctx, lock);
  const run = mustApply(ctx);
  const lines = run.stdout.split(/\r?\n/).filter((line) => line.includes('maxstack-removing'));
  assert.equal(lines.length, 1, run.stdout);
  assert.match(lines[0], /^SKIP\s+\.opencode\/plugins\/simpsonm09-org-ai-plugin\s+kept: simpsonm09-org-ai-plugin\.maxstack-removing holds files that changed since its removal began/, lines[0]);
  assert.equal(readFileSync(join(quarantine, 'skills', 'demo-skill', 'SKILL.md'), 'utf8'), 'changed by the user\n', 'the changed folder was deleted');
  const kept = readJson(lockPath(ctx));
  assert.equal(ownedRecord(kept, ORG_FOLDER, 'dir').quarantine, 'simpsonm09-org-ai-plugin.maxstack-removing', 'the journal was dropped');
  assert.doesNotMatch(run.stdout, /Rerun -Uninstall/, run.stdout);
}, {});

withWorkspace('an overridden layer is removed by -Uninstall like any other', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  mustApply(ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`]);
  assertOk(removal(ctx, ['-Uninstall']));
  assert.equal(existsSync(lockPath(ctx)), false, 'the lock remains');
  assert.equal(existsSync(join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-org-ai-plugin')), false, 'the overridden folder remains');
}, {});

// N7: -Uninstall does not read the settings file, so a dry run names no skipped layer and says the declaration is not used.
withWorkspace('item N7: a dry -Uninstall names no skipped layer, since it does not use the declared sources and says so', (ctx) => {
  mustApply(ctx);
  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: 'local:nope' } } });
  const dry = runInstaller(shell, ctx, ['-Uninstall'], { apply: false });
  assertOk(dry, plainOutput(dry));
  assert.doesNotMatch(plainOutput(dry), /skips layer pstack/, 'the dry run names a skipped layer its plan removes anyway');
  assert.match(plainOutput(dry), /Settings: -Uninstall does not read maxstack\.settings\.json; it removes what the lock recorded\./, plainOutput(dry));
}, {});
