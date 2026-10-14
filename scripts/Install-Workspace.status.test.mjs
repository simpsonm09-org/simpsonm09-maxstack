// Installer tests for -Status and the ownership record: owned paths, their hashes and links, the npm files a layer
// ships, and the verifier view of owned paths. Helpers come from ./lib/installer-test-kit.mjs.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, appendFileSync, readdirSync, rmSync, chmodSync, symlinkSync, lstatSync, mkdirSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse as parsePath } from 'node:path';
import { test } from 'node:test';
import { ALL_RUNTIMES, NPM, ORG_FOLDER, ORG_FOLDER_FULL, ORG_SOURCE, PSTACK_FOLDER, PSTACK_NPM_FOLDER, SHIPPED_LOCK, SHIPPED_SHRINKWRAP, SHORTHAND_URL, ZWJ, ZWSP, assertOk, buildWorkspace, clearInstallOutputs, exportMainInstaller, gitRun, githubEnv, independentSha, installedSkill, localCheckout, lockPath, lockText, moveFeat, mustApply, ownedRecord, plainOutput, problemRows, python, readJson, remoteUrl, removal, repoRoot, resolveShorthand, runInstaller, runStatus, selectionOf, servedFeature, setLock, settingsPath, sha256Upper, shell, skip, snapshotTree, sourceBlockIn, sourceBlockOf, sourceOf, statusRows, testEnvironment, verifyManifestsScript, withMainCommit, withWorkspace, workspaceFiles, workspacePath, writeFile, writeLayerStub, writeLayers, writeWorkspaceSettings } from './lib/installer-test-kit.mjs';

function stringValues(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const item of node) stringValues(item, out);
  else if (node && typeof node === 'object') for (const item of Object.values(node)) stringValues(item, out);
  return out;
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
    assert.equal(typeof record.source, 'object', `layer ${record.name} records its source block`);
    assert.ok(['git', 'local'].includes(record.source.kind), `layer ${record.name} names its source kind`);
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

withWorkspace('a layer source is recorded but not applied, so each one gets a note and no strict failure', (ctx) => {
  writeWorkspaceSettings(ctx, {
    version: 1,
    runtimes: { claude: {} },
    layers: { pstack: { source: 'default' }, 'simpsonm09-personal-ai-plugin': { source: 'local:projects/repos/simpsonm09-personal-ai-plugin' } },
  });
  const applied = mustApply(ctx);
  assert.doesNotMatch(applied.stdout, /layers\.[a-z-]+\.source/, 'an apply does not report a declared source that matches the lock');
  const status = runInstaller(shell, ctx, ['-Status', '-Strict'], { apply: false });
  assert.equal(status.status, 0, plainOutput(status));
  assert.match(status.stdout, /^Settings: layers\.simpsonm09-personal-ai-plugin\.source is declared; a read-only run uses the recorded source, and only an apply uses the declaration\.\r?$/m);
  assert.doesNotMatch(status.stdout, /layers\.pstack\.source is declared/, 'a default source is not reported as declared');
  assert.doesNotMatch(status.stdout, /recorded but not applied/);

  writeWorkspaceSettings(ctx, { version: 1, runtimes: { claude: {} }, layers: { pstack: {} } });
  const withoutSource = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assert.doesNotMatch(withoutSource.stdout, /layers\.[a-z-]+\.source/);
}, {});

withWorkspace('-Status -Strict fails for an unlisted runtime on its own, with the note that names it', (ctx) => {
  writeWorkspaceSettings(ctx, { version: 1, runtimes: { claude: {}, pi: {} }, layers: { pstack: {} } });
  mustApply(ctx);
  writeWorkspaceSettings(ctx, { version: 1, runtimes: { claude: {} }, layers: { pstack: {} } });
  mustApply(ctx);
  const status = runInstaller(shell, ctx, ['-Status', '-Strict'], { apply: false });
  assert.equal(status.status, 1, plainOutput(status));
  assert.match(plainOutput(status), /Settings: unlisted runtime 'pi'; it remains selected\. Remove it with -Remove -Runtimes pi\./);
  assert.doesNotMatch(plainOutput(status), /changed since|Settings: pending (runtime|layer)/);
}, {});

withWorkspace('-Status -Strict fails for an unlisted layer on its own, with the note that names it', (ctx) => {
  const personal = 'simpsonm09-personal-ai-plugin';
  writeWorkspaceSettings(ctx, { version: 1, runtimes: { claude: {} }, layers: { pstack: {}, [personal]: {} } });
  mustApply(ctx);
  writeWorkspaceSettings(ctx, { version: 1, runtimes: { claude: {} }, layers: { pstack: {} } });
  mustApply(ctx);
  const status = runInstaller(shell, ctx, ['-Status', '-Strict'], { apply: false });
  assert.equal(status.status, 1, plainOutput(status));
  assert.match(plainOutput(status), new RegExp(`Settings: unlisted layer '${personal}'; it remains selected\\. Remove it with -Remove -Layers ${personal}\\.`));
  assert.doesNotMatch(plainOutput(status), /changed since|Settings: pending (runtime|layer)/);
}, {});

withWorkspace('a layer source is shaped by owner/repo, https, local, or default, and an empty local path is refused', (ctx) => {
  for (const source of ['https://example.invalid/owner/repo.git@main', 'sample-org/sample-layer@main', 'local:projects/repos/sample', 'default']) {
    writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source } } });
    assertOk(runInstaller(shell, ctx, [], { apply: false }));
  }
  let refusedCount = 0;
  for (const source of [
    'https://example.invalid/owner/repo.git',
    'https://example.invalid/owner/repo.git@bad..ref',
    'https:/example.invalid/owner/repo.git@main',
    'HTTPS://example.invalid/owner/repo.git@main',
    'https://example.invalid/@main',
    'local:',
    'local:   ',
  ]) {
    // A refused source stops in the reader, before any git command, so its own trace file must not exist afterwards.
    const trace = join(ctx.base, `refused-${refusedCount}.trace`);
    refusedCount += 1;
    writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source } } });
    const run = runInstaller(shell, ctx, [], { apply: false, env: { ...testEnvironment(), GIT_TRACE: trace } });
    assert.notEqual(run.status, 0, source);
    const message = source === 'local:' ? /layers\.pstack\.source has an unsafe local path/
      : source === 'local:   ' ? /layers\.pstack\.source has a folder name with a trailing dot or space/
        : /layers\.pstack\.source is not a supported source/;
    assert.match(plainOutput(run), message, source);
    assert.equal(existsSync(trace), false, `${source}: git started before the source was refused`);
  }
}, {});

// Finding 1: a lock edited to a runtime with a zero width joiner is refused by apply and by status, and the lock is unchanged.
withWorkspace('finding 1: a lock edited to a runtime with a zero width joiner is refused, and the lock is unchanged', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  lock.selection.runtimes = ['claude', `pi${ZWJ}`];
  writeFileSync(lockPath(ctx), JSON.stringify(lock));
  const before = lockText(ctx);
  const treeBefore = snapshotTree(ctx.workspace);
  for (const args of [[], ['-Status']]) {
    const run = runInstaller(shell, ctx, args, { apply: args.length === 0 });
    assert.notEqual(run.status, 0, `${args.join(' ') || 'apply'}: ${plainOutput(run)}`);
    assert.match(plainOutput(run), /stack\.lock\.json.*holds the character \\u200D/, args.join(' ') || 'apply');
    assert.doesNotMatch(plainOutput(run), new RegExp(ZWJ));
  }
  assert.equal(lockText(ctx), before, 'a refused lock changed the lock');
  assert.deepEqual(snapshotTree(ctx.workspace), treeBefore, 'a refused lock changed the workspace');
}, {});

// Finding 6: a -Source name with a zero width space is refused, and the recorded override it would have replaced is kept.
withWorkspace('finding 6: a -Source name with a zero width space is refused, and the recorded override is kept', (ctx) => {
  const extA = localCheckout(ctx, 'ext-a');
  const extB = localCheckout(ctx, 'ext-b');
  mustApply(ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${extA}`]);
  const before = lockText(ctx);
  for (const flag of ['-Source', '-LayerSource']) {
    const value = flag === '-Source' ? `simpsonm09-org-ai-plugin${ZWSP}=local:${extB}` : `simpsonm09-org-ai-plugin${ZWSP}=${extB}`;
    const run = runInstaller(shell, ctx, [flag, value]);
    assert.notEqual(run.status, 0, `${flag}: ${plainOutput(run)}`);
    assert.match(plainOutput(run), /-(?:Layer)?Source name 'simpsonm09-org-ai-plugin\\u200B' holds the character \\u200B/, flag);
    assert.equal(lockText(ctx), before, `${flag} changed the lock`);
  }
}, {});

// Finding 16: a read-only status with an unavailable declared source marks that layer's files skipped, not drifted.
withWorkspace("finding 16: -Status marks a skipped layer's files skipped, not drifted, and -Strict does not fail on them", (ctx) => {
  mustApply(ctx);
  writeWorkspaceSettings(ctx, { version: 1, runtimes: { claude: {}, opencode: {}, copilot: {}, pi: {} }, layers: { pstack: { source: 'local:nope' }, 'simpsonm09-org-ai-plugin': {}, 'simpsonm09-personal-ai-plugin': {} } });
  const status = runInstaller(shell, ctx, ['-Status', '-Strict'], { apply: false });
  assert.equal(status.status, 0, plainOutput(status));
  const rows = statusRows(status).filter((row) => /pstack/.test(row.label));
  assert.ok(rows.some((row) => row.state === 'skipped'), `no skipped row for pstack: ${plainOutput(status)}`);
  assert.deepEqual(rows.filter((row) => row.state === 'drifted'), [], 'a skipped layer is reported as drifted');
}, {});

withWorkspace('-Status reports a declared git source without resolving its ref', (ctx) => {
  mustApply(ctx);
  writeWorkspaceSettings(ctx, { version: 1, layers: { pstack: { source: 'sample/nope@main' } } });
  const status = runInstaller(shell, ctx, ['-Status'], { apply: false, env: githubEnv(ctx) });
  assertOk(status, plainOutput(status));
  assert.match(plainOutput(status), /layers\.pstack\.source is declared; a read-only run uses the recorded source, and only an apply uses the declaration\./);
  assert.doesNotMatch(plainOutput(status), /could not be read/);
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

withWorkspace('apply records an owned entry for every path it wrote, and the record validates', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  assert.equal(lock.ownedSchema, 2, 'the record has no schema version');
  const owned = lock.owned;
  for (const record of owned) {
    assert.ok('runtime' in record && 'layers' in record, `${record.path} names no runtime and layers`);
  }
  assert.deepEqual(owned.find((record) => record.path === '.opencode/plugins/simpsonm09-org-ai-plugin').layers, ['simpsonm09-org-ai-plugin']);
  assert.equal(owned.find((record) => record.path === '.maxstack/bin/pi.cmd').runtime, 'pi');
  assert.equal(owned.find((record) => record.path === '.claude/cache/pstack').runtime, null, 'the claude cache belongs to no runtime');
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

  const check = spawnSync(python, [verifyManifestsScript, '--lock', lockPath(ctx)], { windowsHide: true, encoding: 'utf8' });
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

withWorkspace('finding audit/status: an OpenCode folder tracks source drift in audit and status, then matches after apply', (ctx) => {
  mustApply(ctx);
  writeFile(ctx.workspace, 'projects/repos/simpsonm09-org-ai-plugin/skills/new-skill/SKILL.md', '---\nname: new-skill\ndescription: fixture\n---\nbody\n');
  const audit = runInstaller(shell, ctx, [], { apply: false });
  const status = runStatus(ctx);
  assert.match(audit.stdout, /\.opencode[\\/]+plugins[\\/]+simpsonm09-org-ai-plugin: drifted/, audit.stdout);
  assert.match(status.stdout, /drifted\s+\.opencode\/plugins\/simpsonm09-org-ai-plugin/, status.stdout);
  mustApply(ctx);
  const matchingAudit = runInstaller(shell, ctx, [], { apply: false });
  const matchingStatus = runStatus(ctx);
  assert.match(matchingAudit.stdout, /\.opencode[\\/]+plugins[\\/]+simpsonm09-org-ai-plugin: matching/, matchingAudit.stdout);
  assert.match(matchingStatus.stdout, /matching\s+\.opencode\/plugins\/simpsonm09-org-ai-plugin/, matchingStatus.stdout);
}, {});

withWorkspace('finding new workspace audit: local sources can be audited before the first lock exists', (ctx) => {
  const source = `pstack=local:${ctx.fixture.dir}`;
  const audit = runInstaller(shell, ctx, ['-Source', source], { apply: false });
  assert.equal(audit.status, 0, plainOutput(audit));
  assert.match(audit.stdout, /\.opencode[\\/]+plugins[\\/]+pstack: missing/, audit.stdout);
  assert.equal(existsSync(lockPath(ctx)), false, 'a read-only first audit created a lock');
}, {});

test('finding F3: OpenCode permissions are generated for each workspace and remain owned by the lock', { skip }, () => {
  const first = buildWorkspace();
  const second = buildWorkspace();
  try {
    for (const ctx of [first, second]) {
      mustApply(ctx);
      const configPath = join(ctx.workspace, 'opencode.jsonc');
      const configText = readFileSync(configPath, 'utf8');
      const config = JSON.parse(configText);
      const expectedWindows = `${ctx.workspace.replaceAll('\\', '/')}/.opencode/*`;
      const expectedWsl = `/mnt/${ctx.workspace[0].toLowerCase()}${ctx.workspace.slice(2).replaceAll('\\', '/')}/.opencode/*`;
      const resources = config.permissions.map((permission) => permission.resource);
      assert.ok(resources.includes(expectedWindows), `missing Windows permission for ${ctx.workspace}: ${resources}`);
      assert.ok(resources.includes(expectedWsl), `missing WSL permission for ${ctx.workspace}: ${resources}`);
      assert.ok(!resources.some((resource) => resource.includes(first.workspace === ctx.workspace ? second.workspace.replaceAll('\\', '/') : first.workspace.replaceAll('\\', '/'))));
      assert.equal(readJson(lockPath(ctx)).configSha256, sha256Upper(Buffer.from(configText)));
      const status = runStatus(ctx);
      assert.ok(statusRows(status).some((row) => row.label === 'opencode.jsonc' && row.state === 'matching'), status.stdout);
    }
  } finally {
    rmSync(first.base, { recursive: true, force: true });
    rmSync(second.base, { recursive: true, force: true });
  }
});

withWorkspace('a file in .maxstack/bin that the record does not name is untracked', (ctx) => {
  mustApply(ctx);
  writeFile(ctx.workspace, '.maxstack/bin/notes.txt', 'not the installer\n');
  const run = runStatus(ctx);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(problemRows(run), [{ state: 'untracked', label: '.maxstack/bin/notes.txt' }], run.stdout);
  assert.equal(runStatus(ctx, ['-Strict']).status, 1, '-Strict accepted an untracked file');
}, {});

withWorkspace('an npm install beside a pstack package.json applies, leaves no lock file, and records the folder', (ctx) => {
  mustApply(ctx);
  assert.ok(existsSync(workspacePath(ctx, `${PSTACK_NPM_FOLDER}/node_modules/@opencode/plugin/index.js`)), 'npm did not install the dependency');
  assert.equal(existsSync(workspacePath(ctx, `${PSTACK_NPM_FOLDER}/package-lock.json`)), false, 'the lock npm wrote stayed in the folder');
  assert.ok(ownedRecord(readJson(lockPath(ctx)), PSTACK_FOLDER, 'dir'), 'the pstack folder has no ownership record');
}, NPM);

withWorkspace('after an npm install every owned path matches, and a file added to the pstack folder by hand is modified', (ctx) => {
  mustApply(ctx);
  const run = runStatus(ctx);
  assert.deepEqual(problemRows(run), [], run.stdout);
  assert.deepEqual(statusRows(run).find((row) => row.label === PSTACK_FOLDER), { state: 'matching', label: PSTACK_FOLDER });
  writeFile(ctx.workspace, `${PSTACK_FOLDER}/hand-added.md`, 'added by hand\n');
  assert.deepEqual(problemRows(runStatus(ctx)), [{ state: 'modified', label: PSTACK_FOLDER }]);
}, NPM);

withWorkspace('an npm install that writes a file beyond its lock and node_modules fails the apply, and writes no record', (ctx) => {
  ctx.env.FAKE_NPM_EXTRA = `${PSTACK_NPM_FOLDER}/extra.txt`;
  const run = runInstaller(shell, ctx);
  assert.notEqual(run.status, 0, run.stdout);
  assert.match(plainOutput(run), /\.opencode\/plugins\/pstack holds different content from what the install wrote/);
  assert.equal(existsSync(lockPath(ctx)), false, 'a record was written from a folder that differs from the plan');
}, NPM);

withWorkspace('a package-lock.json the layer ships is put back as shipped when npm rewrites it', (ctx) => {
  ctx.env.FAKE_NPM_REWRITE = '1';
  mustApply(ctx);
  assert.equal(readFileSync(workspacePath(ctx, `${PSTACK_NPM_FOLDER}/package-lock.json`), 'utf8'), SHIPPED_LOCK, 'the folder does not hold the lock the layer ships');
  assert.deepEqual(problemRows(runStatus(ctx)), []);
}, { fixture: { npm: true, shipLock: true } });

withWorkspace('a read-only package-lock.json the layer ships survives a second apply when npm is skipped', (ctx) => {
  mustApply(ctx);
  const cachedLock = workspacePath(ctx, '.claude/cache/pstack/plugins/pstack/opencode/package-lock.json');
  const installedLock = workspacePath(ctx, `${PSTACK_NPM_FOLDER}/package-lock.json`);
  chmodSync(cachedLock, 0o444);
  try {
    mustApply(ctx);
    assert.deepEqual(problemRows(runStatus(ctx)), []);
    assert.equal(readFileSync(installedLock, 'utf8'), SHIPPED_LOCK, 'the second apply changed the shipped lock');
  } finally {
    chmodSync(cachedLock, 0o666);
    if (existsSync(installedLock)) chmodSync(installedLock, 0o666);
  }
}, { fixture: { shipLock: true } });

withWorkspace('an npm-shrinkwrap.json the layer ships is put back as shipped when npm rewrites it', (ctx) => {
  ctx.env.FAKE_NPM_REWRITE = '1';
  mustApply(ctx);
  assert.equal(readFileSync(workspacePath(ctx, `${PSTACK_NPM_FOLDER}/npm-shrinkwrap.json`), 'utf8'), SHIPPED_SHRINKWRAP, 'the folder does not hold the shrinkwrap the layer ships');
  assert.equal(existsSync(workspacePath(ctx, `${PSTACK_NPM_FOLDER}/package-lock.json`)), false, 'npm wrote a package-lock.json beside the shipped shrinkwrap');
  assert.deepEqual(problemRows(runStatus(ctx)), []);
}, { fixture: { npm: true, shipShrinkwrap: true } });

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
  const check = spawnSync(python, [verifyManifestsScript, '--lock', lockPath(ctx)], { windowsHide: true, encoding: 'utf8' });
  assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
}, {});

withWorkspace('status reports a link matching its recorded target as drifted when the planned target changes', (ctx) => {
  mustApply(ctx);
  const linkPath = '.claude/plugins/simpsonm09-org-ai-plugin';
  const child = join(ctx.workspace, ...linkPath.split('/'));
  const alternate = join(ctx.workspace, '.opencode', 'plugins', 'status-target');
  mkdirSync(alternate);
  rmdirSync(child);
  symlinkSync(alternate, child, 'junction');
  const lock = readJson(lockPath(ctx));
  lock.owned.find((record) => record.path === linkPath).target = '.opencode/plugins/status-target';
  setLock(ctx, lock);

  const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assert.equal(status.status, 0, plainOutput(status));
  assert.ok(statusRows(status).some((row) => row.state === 'drifted' && row.label === linkPath), plainOutput(status));
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

withWorkspace('node_modules and .git folders nested in an owned folder are not part of its hash', (ctx) => {
  mustApply(ctx);
  writeFile(ctx.workspace, `${ORG_FOLDER}/skills/demo/node_modules/pkg/index.js`, 'module.exports = {};\n');
  writeFile(ctx.workspace, `${ORG_FOLDER}/skills/demo/.git/HEAD`, 'ref: refs/heads/main\n');
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
  assert.deepEqual(lock.createdFiles, ['opencode.jsonc'], 'a settings file that was there first is listed as created, and the config the install created is');
  assert.equal(ownedRecord(lock, '.pi/agent/settings.json', 'json-entries', 'packages').createdKey, true, 'a key the user file lacked is not marked as created');
  assert.equal(readJson(settingsPath(ctx)).defaultProvider, 'user-provider');
}, {});

withWorkspace('an empty, null, or truncated lock is refused with what to do and what it costs, and nothing is written', (ctx) => {
  mustApply(ctx);
  const good = readFileSync(lockPath(ctx), 'utf8');
  const filesBefore = workspaceFiles(ctx.workspace);
  for (const [label, text] of [['empty', ''], ['null', 'null'], ['truncated', good.slice(0, 120)]]) {
    writeFileSync(lockPath(ctx), text);
    const run = runInstaller(shell, ctx);
    assert.notEqual(run.status, 0, `${label}: apply accepted the lock`);
    const message = plainOutput(run);
    assert.match(message, /is empty, null, or truncated, so its selection and created-paths record cannot be read/, `${label}: ${message}`);
    assert.match(message, /Restore it from .*stack\.lock\.json\.bak/, label);
    assert.match(message, /Deleting .*stack\.lock\.json instead resets the selection to all runtimes and layers and loses the createdDirs and createdFiles record/, label);
    assert.match(message, /Keep .*stack\.lock\.json\.bak either way/, label);
    assert.doesNotMatch(message, /StrictMode|PropertyNotFound|cannot be found on this object/, `${label}: a PowerShell error leaked`);
    assert.equal(readFileSync(lockPath(ctx), 'utf8'), text, `${label}: the lock was changed`);
    assert.deepEqual(workspaceFiles(ctx.workspace), filesBefore, `${label}: an apply wrote before it read the lock`);
    const status = runStatus(ctx);
    assert.notEqual(status.status, 0, `${label}: status accepted the lock`);
    assert.match(plainOutput(status), /is empty, null, or truncated/, label);
  }
}, {});

withWorkspace('the lock is replaced whole: a failed write leaves the previous lock as it was, and the replaced lock is kept', (ctx) => {
  mustApply(ctx);
  const before = readFileSync(lockPath(ctx));
  // A folder where the temporary file goes makes the write fail before the lock is replaced.
  mkdirSync(join(ctx.workspace, 'stack.lock.json.new'));
  const failed = runInstaller(shell, ctx, ['-Runtimes', 'claude']);
  assert.notEqual(failed.status, 0, 'the installer ignored a failed write');
  assert.ok(before.equals(readFileSync(lockPath(ctx))), 'a failed write changed the lock');
  rmSync(join(ctx.workspace, 'stack.lock.json.new'), { recursive: true });

  mustApply(ctx, ['-Runtimes', 'claude']);
  assert.ok(!existsSync(join(ctx.workspace, 'stack.lock.json.new')), 'the temporary file was left behind');
  assert.ok(existsSync(`${lockPath(ctx)}.bak`), 'the replaced lock was not kept');
  assert.ok(before.equals(readFileSync(`${lockPath(ctx)}.bak`)), 'the kept copy is not the lock the apply replaced');
  assert.deepEqual(selectionOf(ctx).runtimes, ALL_RUNTIMES);
}, {});

withWorkspace('a truncated temporary file from an interrupted write never stands in for the lock', (ctx) => {
  mustApply(ctx);
  const lock = readFileSync(lockPath(ctx));
  writeFile(ctx.workspace, 'stack.lock.json.new', '{"generatedAt": "2026-');
  const status = runStatus(ctx);
  assert.equal(status.status, 0, status.stdout);
  assert.ok(lock.equals(readFileSync(lockPath(ctx))), 'the lock changed');
  mustApply(ctx);
  assert.ok(!existsSync(join(ctx.workspace, 'stack.lock.json.new')), 'the apply left the temporary file');
  assert.equal(readJson(lockPath(ctx)).selection.layers.length, 3);
}, {});

withWorkspace('a record whose path passes through a junction is skipped, and the folder it reaches is untouched', (ctx) => {
  mustApply(ctx);
  const outside = join(ctx.base, 'outside-folder');
  writeFile(outside, 'keep.txt', 'outside\n');
  symlinkSync(outside, join(ctx.workspace, 'escape'), 'junction');
  const lock = readJson(lockPath(ctx));
  lock.owned.push({ path: 'escape/keep.txt', kind: 'file', sha256: sha256Upper(Buffer.from('outside\n')), runtime: 'copilot', layers: [] });
  setLock(ctx, lock);

  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.match(run.stdout, /^SKIP\s+escape\/keep\.txt\s+outside the workspace: a folder on its path is a junction/m, run.stdout);
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'outside\n');
  assert.deepEqual(readJson(lockPath(ctx)).owned.map((record) => record.path), ['escape/keep.txt']);
}, {});

withWorkspace('a node_modules folder inside an owned folder is counted in the plan, and a junction under it that leads outside refuses the folder', (ctx) => {
  mustApply(ctx);
  writeFile(ctx.workspace, `${ORG_FOLDER}/node_modules/extra/index.js`, 'module.exports = 1;\n');
  const plan = removal(ctx, ['-Uninstall'], { apply: false });
  assertOk(plan);
  assert.match(plan.stdout, /^DELETE\s+\.opencode\/plugins\/simpsonm09-org-ai-plugin\s+.*node_modules \(\d+ files, \d+ bytes\)/m, plan.stdout);

  const outside = join(ctx.base, 'outside-modules');
  writeFile(outside, 'keep.txt', 'outside\n');
  symlinkSync(outside, join(ORG_FOLDER_FULL(ctx), 'node_modules', 'linked'), 'junction');
  const refused = removal(ctx, ['-Uninstall']);
  assertOk(refused);
  assert.match(refused.stdout, /^SKIP\s+\.opencode\/plugins\/simpsonm09-org-ai-plugin\s+refused: a junction under/m, refused.stdout);
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'outside\n', 'the junction target was changed');
  assert.ok(existsSync(ORG_FOLDER_FULL(ctx)), 'the refused folder was deleted');
}, {});

withWorkspace('a record whose sha256 is null is skipped, and the file is kept', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  ownedRecord(lock, '.maxstack/bin/copilot.sh', 'file').sha256 = null;
  setLock(ctx, lock);
  const run = removal(ctx, ['-Uninstall']);
  assertOk(run);
  assert.match(run.stdout, /^SKIP\s+\.maxstack\/bin\/copilot\.sh\s+modified by hand/m, run.stdout);
  assert.ok(existsSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.sh')));
}, {});

withWorkspace('-Source owner/repo@branch installs the branch commit, and the lock records it as an override', (ctx) => {
  const { featCommit } = servedFeature(ctx);
  mustApply(ctx, ['-Source', 'pstack=simpsonm09/pstack-max@feat'], { env: githubEnv(ctx) });
  assert.match(readFileSync(installedSkill(ctx), 'utf8'), /feat body/, 'the branch content was not installed');

  const pstack = sourceOf(ctx, 'pstack');
  assert.deepEqual(pstack.source, { kind: 'git', url: remoteUrl(ctx, 'simpsonm09', 'pstack-max'), ref: 'feat', commit: featCommit, override: true });
  assert.equal(pstack.commit, featCommit, 'the layer commit is the resolved branch commit');
  assert.equal(sourceOf(ctx, 'simpsonm09-org-ai-plugin').source.override, false, 'a layer no flag names is not an override');
}, {});

withWorkspace('a recorded override persists across a plain apply, and -Source name=default drops it', (ctx) => {
  const { featCommit } = servedFeature(ctx);
  mustApply(ctx, ['-Source', 'pstack=simpsonm09/pstack-max@feat'], { env: githubEnv(ctx) });
  mustApply(ctx, [], { env: githubEnv(ctx) });
  assert.equal(sourceOf(ctx, 'pstack').source.override, true, 'the plain apply dropped the override');
  assert.equal(sourceOf(ctx, 'pstack').commit, featCommit, 'the plain apply moved the recorded commit');
  assert.match(readFileSync(installedSkill(ctx), 'utf8'), /feat body/);

  mustApply(ctx, ['-Source', 'pstack=default'], { env: githubEnv(ctx) });
  assert.equal(sourceOf(ctx, 'pstack').source.override, false, '-Source name=default kept the override');
  assert.equal(sourceOf(ctx, 'pstack').commit, ctx.fixture.commit, 'the default pin is installed again');
  assert.match(readFileSync(installedSkill(ctx), 'utf8'), /fixture body/);
}, {});

withWorkspace('a local source installs the working tree as it is, and the lock records HEAD and the dirty flag', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  gitRun(checkout, ['init', '-q']);
  gitRun(checkout, ['add', '-A']);
  gitRun(checkout, ['commit', '-q', '-m', 'layer']);
  const head = gitRun(checkout, ['rev-parse', 'HEAD']);
  writeFile(checkout, 'index.ts', 'export default { edited: true };\n');

  mustApply(ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`]);
  assert.match(readFileSync(join(ctx.workspace, '.opencode', 'plugins', 'simpsonm09-org-ai-plugin', 'index.ts'), 'utf8'), /edited: true/);
  const org = sourceOf(ctx, 'simpsonm09-org-ai-plugin');
  assert.deepEqual(org.source, { kind: 'local', url: null, ref: null, commit: head, dirty: true, override: true, path: checkout });
  assert.equal(org.commit, head);
}, {});

withWorkspace('-Status prints the layer-source block above the state rows, with each override and each local source', (ctx) => {
  const { featCommit } = servedFeature(ctx);
  mustApply(ctx, ['-Source', 'pstack=simpsonm09/pstack-max@feat'], { env: githubEnv(ctx) });
  const status = runInstaller(shell, ctx, ['-Status'], { apply: false, env: githubEnv(ctx) });
  assertOk(status);

  const block = sourceBlockOf(status.stdout);
  assert.ok(block, `no source block:\n${status.stdout}`);
  assert.ok(block.firstState > block.header, 'the block is below a state row');
  const text = block.lines.join('\n');
  assert.match(text, new RegExp(`pstack: override, git \\S+ ref feat at ${featCommit}`), text);
  assert.match(text, /simpsonm09-org-ai-plugin: local, default /, text);
  assert.doesNotMatch(text, /pstack: .*local/, 'a pinned git layer is listed as local');
}, {});

withWorkspace('a default workspace lists its local layers in the block and no git pin', (ctx) => {
  mustApply(ctx);
  const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assertOk(status);
  const block = sourceBlockOf(status.stdout);
  assert.ok(block, status.stdout);
  const text = block.lines.join('\n');
  assert.match(text, /simpsonm09-org-ai-plugin: local, default/);
  assert.match(text, /simpsonm09-personal-ai-plugin: local, default/);
  assert.doesNotMatch(text, /pstack/, 'the pinned pstack layer is listed');
}, {});

withWorkspace('-Update -Check writes nothing, not even the cache, and reports the move and the drift', (ctx) => {
  const { bare, featCommit } = servedFeature(ctx);
  mustApply(ctx, ['-Source', 'pstack=simpsonm09/pstack-max@feat'], { env: githubEnv(ctx) });
  const featTwo = moveFeat(ctx, bare);
  const before = snapshotTree(ctx.workspace);
  const lockBefore = readFileSync(lockPath(ctx));

  const check = runInstaller(shell, ctx, ['-Update', '-Check'], { apply: false, env: githubEnv(ctx) });
  assertOk(check);
  assert.match(check.stdout, new RegExp(`feat ${featCommit} -> ${featTwo}`), check.stdout);
  assert.match(check.stdout, /needs fetch/, check.stdout);
  assert.deepEqual(snapshotTree(ctx.workspace), before, '-Update -Check changed the tree or the cache');
  assert.deepEqual(readFileSync(lockPath(ctx)), lockBefore, '-Update -Check changed the lock');

  const strict = runInstaller(shell, ctx, ['-Update', '-Check', '-Strict'], { apply: false, env: githubEnv(ctx) });
  assert.equal(strict.status, 1, `-Strict did not exit 1 when a source would move:\n${strict.stdout}`);
  assert.deepEqual(snapshotTree(ctx.workspace), before, 'the strict check changed the tree or the cache');
}, {});

withWorkspace('a lock from before the source block lists its local layers as defaults, and names no dirty state it never recorded', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  const LEGACY_COMMIT = 'b'.repeat(40);
  for (const layer of lock.layers) {
    layer.source = layer.source.url;
  }
  lock.layers.find((layer) => layer.name === 'simpsonm09-org-ai-plugin').commit = LEGACY_COMMIT;
  setLock(ctx, lock);

  const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assertOk(status);
  const text = sourceBlockOf(status.stdout).lines.join('\n');
  assert.match(text, new RegExp(`simpsonm09-org-ai-plugin: local, default \\S+ \\(HEAD ${LEGACY_COMMIT}, dirty state not recorded\\)`), text);
  assert.doesNotMatch(text, /pstack/, 'the pinned pstack layer is listed');
}, {});

withWorkspace('a local override the lock holds with a relative path is ignored by -Status, and a plain apply refuses it', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  mustApply(ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`]);
  const lock = readJson(lockPath(ctx));
  sourceBlockIn(lock, 'simpsonm09-org-ai-plugin').path = 'relative/checkout';
  setLock(ctx, lock);
  const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assertOk(status);
  assert.match(plainOutput(status), /layer 'simpsonm09-org-ai-plugin' has an invalid path/, plainOutput(status));
  const apply = runInstaller(shell, ctx, []);
  assert.notEqual(apply.status, 0, 'an apply wrote a layer whose recorded path is relative');
  assert.match(plainOutput(apply), /-Source simpsonm09-org-ai-plugin=default -Apply/, plainOutput(apply));
}, {});

// Finding 8: npm runs with --ignore-scripts, and a layer that declares install scripts or a binding.gyp is named when it runs.
// The stub org layer's node_modules is taken away, so npm runs for it, and its layer.json names the files the copy keeps.
function orgNeedingNpm(ctx, { packageJson, files, extra = {} }) {
  const org = join(ctx.workspace, ORG_SOURCE);
  rmSync(join(org, 'node_modules'), { recursive: true, force: true });
  writeFile(org, 'layer.json', JSON.stringify({ files }));
  writeFile(org, 'package.json', JSON.stringify(packageJson));
  for (const [rel, content] of Object.entries(extra)) writeFile(org, rel, content);
}

const ORG_FILES = ['index.ts', 'package.json', 'skills', '.claude-plugin'];

withWorkspace('an apply that runs npm names a layer that declares an install script, since its scripts do not run', (ctx) => {
  orgNeedingNpm(ctx, { packageJson: { name: 'simpsonm09-org-ai-plugin', version: '0.1.0', scripts: { postinstall: 'node build.js' } }, files: ORG_FILES });
  const run = mustApply(ctx);
  assert.match(plainOutput(run), /npm ran with --ignore-scripts for layer 'simpsonm09-org-ai-plugin': its scripts\.postinstall did not run/, plainOutput(run));
  assert.doesNotMatch(plainOutput(run), /ignore-scripts for layer 'pstack'/, 'a layer with no install script is named');
}, NPM);

withWorkspace('an apply that runs npm names a layer that ships a binding.gyp, since its native build does not run', (ctx) => {
  orgNeedingNpm(ctx, { packageJson: { name: 'simpsonm09-org-ai-plugin', version: '0.1.0' }, files: [...ORG_FILES, 'binding.gyp'], extra: { 'binding.gyp': '{}\n' } });
  const run = mustApply(ctx);
  assert.match(plainOutput(run), /npm ran with --ignore-scripts for layer 'simpsonm09-org-ai-plugin': its binding\.gyp did not run/, plainOutput(run));
}, NPM);

withWorkspace('an apply that runs npm on a layer with no install script or binding.gyp prints no ignore-scripts warning', (ctx) => {
  orgNeedingNpm(ctx, { packageJson: { name: 'simpsonm09-org-ai-plugin', version: '0.1.0' }, files: ORG_FILES });
  const run = mustApply(ctx);
  assert.doesNotMatch(plainOutput(run), /npm ran with --ignore-scripts/, plainOutput(run));
}, NPM);

withWorkspace('a drive root or a share root is refused as a local source, with the reason', (ctx) => {
  const driveRoot = parsePath(tmpdir()).root;
  const drive = runInstaller(shell, ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${driveRoot}`], { apply: false });
  assert.notEqual(drive.status, 0, 'a drive root was accepted as a layer source');
  assert.match(plainOutput(drive), /is a drive or share root, which cannot be a layer source/, drive.stdout);

  const share = runInstaller(shell, ctx, ['-Source', 'simpsonm09-org-ai-plugin=local://server/share'], { apply: false });
  assert.notEqual(share.status, 0, 'a share root was accepted as a layer source');
  assert.match(plainOutput(share), /UNC or device path/, share.stdout);
}, {});

// Round 2, G: a junction under the temp folder that leads outside it does not turn on the test root.
test('a junction under the temp folder that leads outside it does not turn on the test root', { skip }, () => {
  const junction = join(tmpdir(), `maxstack-jct-${process.pid}`);
  symlinkSync(repoRoot, junction, 'junction');
  try {
    const run = resolveShorthand({ ...process.env, MAXSTACK_TEST_MODE: '1', MAXSTACK_TEST_GITHUB_ROOT: junction });
    assertOk(run);
    assert.equal(run.stdout.trim(), SHORTHAND_URL, run.stdout);
  } finally {
    rmdirSync(junction);
  }
}, {});

// Round 2, I: after npm runs, the installed dependencies that declare install scripts are counted and named, up to ten.
withWorkspace('an apply that runs npm counts the installed packages that declare install scripts, and names up to ten', (ctx) => {
  const names = Array.from({ length: 12 }, (_, index) => `dep-${String(index).padStart(2, '0')}`);
  names.push('@acme/native');
  const run = mustApply(ctx, [], { env: { ...ctx.env, FAKE_NPM_SCRIPTED: JSON.stringify(names) } });
  assert.match(plainOutput(run), /npm ran with --ignore-scripts for layer 'pstack': 13 installed packages declare install scripts or a native build, which did not run: @acme\/native, dep-00.*and 3 more/, plainOutput(run));
}, NPM);

// Finding 5: the scan of the packages npm installed is a warning only. A folder it cannot read must not stop an apply after the
// plugin folder is replaced and before the lock is written.
withWorkspace('an apply whose npm scan cannot read a scoped folder still writes its lock, with no ignore-scripts warning', (ctx) => {
  orgNeedingNpm(ctx, { packageJson: { name: 'simpsonm09-org-ai-plugin', version: '0.1.0' }, files: ORG_FILES });
  const run = mustApply(ctx, [], { env: { ...ctx.env, FAKE_NPM_BROKEN_SCOPE: '1' } });
  assert.doesNotMatch(plainOutput(run), /ignore-scripts/, plainOutput(run));
  assert.ok(existsSync(lockPath(ctx)), 'the apply stopped before the lock was written');
}, NPM);

// Finding 6: a long-path prefix is dropped only from a drive path. \\?\UNC\server\share names a share, and stays one.
withWorkspace('a long-path UNC share is refused as a share root, not read as a folder under the current directory', (ctx) => {
  const run = runInstaller(shell, ctx, ['-Source', 'simpsonm09-org-ai-plugin=local:\\\\?\\UNC\\server\\share'], { apply: false });
  assert.notEqual(run.status, 0, 'a long-path UNC share was accepted as a layer source');
  // A device prefix is refused by its text, before any path is read, so the UNC share is not reached.
  assert.match(plainOutput(run), /UNC or device path/, run.stdout);
}, {});

// Finding 9: a recorded fault already ends in a period, so the warning and the refusal join it with a space, not a second period.
withWorkspace('a recorded override with a relative path is warned and refused with one period after the reason', (ctx) => {
  const checkout = join(ctx.base, 'org-checkout');
  writeLayerStub(checkout, { claudePlugin: 'simpsonm09-org-ai-plugin' });
  mustApply(ctx, ['-Source', `simpsonm09-org-ai-plugin=local:${checkout}`]);
  const lock = readJson(lockPath(ctx));
  sourceBlockIn(lock, 'simpsonm09-org-ai-plugin').path = 'relative/checkout';
  setLock(ctx, lock);

  const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assertOk(status);
  assert.match(plainOutput(status), /has an invalid path: needs an absolute path\. This run ignores/, plainOutput(status));
  assert.doesNotMatch(plainOutput(status), /absolute path\.\./, plainOutput(status));

  const apply = runInstaller(shell, ctx, []);
  assert.notEqual(apply.status, 0, 'an apply wrote a layer whose recorded path is relative');
  assert.match(plainOutput(apply), /has an invalid path: needs an absolute path\. Repair it with/, plainOutput(apply));
  assert.doesNotMatch(plainOutput(apply), /absolute path\.\./, plainOutput(apply));
}, {});

// A workspace reached through a junction keeps the path the user gave: upstream main writes under that path and records its
// leaf name in the lock, so the resolved folder is used only for the checks.
withMainCommit('a workspace reached through a junction keeps the given path in the lock and the output, as upstream main does', (ctx) => {
  const mainInstaller = exportMainInstaller(ctx.base);
  const layersFile = writeLayers(ctx);
  const linkParent = join(ctx.base, 'junction-parent');
  const linkPath = join(linkParent, 'linkname');
  mkdirSync(linkParent);
  symlinkSync(ctx.workspace, linkPath, 'junction');
  const linkCtx = { ...ctx, workspace: linkPath };

  clearInstallOutputs(ctx.workspace);
  const mainRun = runInstaller(shell, linkCtx, [], { layersFile, installerPath: mainInstaller });
  assert.equal(mainRun.status, 0, `${mainRun.stdout}${mainRun.stderr}`);
  const mainLock = readJson(join(ctx.workspace, 'stack.lock.json'));

  clearInstallOutputs(ctx.workspace);
  const newRun = runInstaller(shell, linkCtx, [], { layersFile });
  assert.equal(newRun.status, 0, `${newRun.stdout}${newRun.stderr}`);
  assert.equal(newRun.stdout.split(/\r?\n/)[0], `Workspace: ${linkPath} (from -Workspace)`, 'the resolved line must keep the given path');
  const newLock = readJson(join(ctx.workspace, 'stack.lock.json'));
  assert.equal(newLock.workspace, 'linkname', 'the lock must record the leaf name the user gave');
  assert.equal(newLock.workspace, mainLock.workspace, 'upstream main records the same workspace name');
}, {});

// N3: a junction whose target folder differs from the workspace by a zero width space is outside the workspace, so its target
// is not touched by a removal.
withWorkspace('item N3: a junction in an excluded folder, to a sibling named like the workspace with a zero width space, is outside the workspace, so its owned folder is refused', (ctx) => {
  mustApply(ctx);
  const sibling = join(ctx.base, `simpsonm09${ZWSP}`);
  mkdirSync(sibling);
  writeFileSync(join(sibling, 'keep.txt'), 'outside\n');
  const modules = join(ctx.workspace, '.opencode', 'plugins', 'pstack', 'node_modules');
  mkdirSync(modules, { recursive: true });
  symlinkSync(sibling, join(modules, 'escape-link'), 'junction');
  const plan = runInstaller(shell, ctx, ['-Uninstall'], { apply: false });
  assertOk(plan, plainOutput(plan));
  assert.doesNotMatch(plainOutput(plan), /DELETE \.opencode\/plugins\/pstack /, 'the plan deletes an owned folder that holds a link to outside the workspace');
  assert.match(plainOutput(plan), /SKIP \.opencode\/plugins\/pstack /, plainOutput(plan));
  const uninstall = runInstaller(shell, ctx, ['-Uninstall'], { apply: true });
  assert.ok(existsSync(join(sibling, 'keep.txt')), 'a removal reached the sibling folder through the junction');
}, {});

// N9: a nested lock key in the wrong case is refused, as the top-level key is.
withWorkspace('item N9: a nested lock key in the wrong case is refused, as a top-level key is', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  const record = lock.layers.find((layer) => layer.name === 'pstack');
  assert.ok(Object.prototype.hasOwnProperty.call(record, 'claude'), 'the layer record has no claude key to rename');
  record.Claude = record.claude;
  delete record.claude;
  writeFileSync(lockPath(ctx), JSON.stringify(lock));
  const before = readFileSync(lockPath(ctx), 'utf8');
  const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assert.notEqual(status.status, 0, plainOutput(status));
  assert.match(plainOutput(status), /stack\.lock\.json\.layers\[\] key 'Claude' must be spelled claude/, plainOutput(status));
  assert.equal(readFileSync(lockPath(ctx), 'utf8'), before, 'a refused lock was rewritten');
}, {});

// N8: a lock override that is the string "true" is not a boolean, so it is not an override.
withWorkspace('item N8: a lock override that is the string "true", not a boolean, is not read as an override', (ctx) => {
  mustApply(ctx);
  const lock = readJson(lockPath(ctx));
  const record = lock.layers.find((layer) => layer.name === 'pstack');
  record.source = { kind: 'git', url: 'https://github.com/simpsonm09/pstack-max.git', ref: 'main', commit: 'a'.repeat(40), dirty: null, override: 'true' };
  writeFileSync(lockPath(ctx), JSON.stringify(lock));
  const status = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assert.doesNotMatch(plainOutput(status), /pstack: override, git/, plainOutput(status));
}, {});
