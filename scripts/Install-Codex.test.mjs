#!/usr/bin/env node
// The codex runtime of Install-Workspace.ps1: each selected layer's skills copied into .agents\skills, the ownership
// record, removal, status, the selection rules, and the promise that a workspace which does not select codex is
// unchanged. Every workspace is a scratch folder under the temp folder, and every layer is a local fixture, so no test
// reads the real workspace, reaches a remote, or touches ~/.codex. The shared helpers come from
// scripts/lib/installer-test-kit.mjs; the codex fixtures (skill folders, the layers file for a tree) are local to this file.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import {
  installer,
  lockPath,
  makeFixture,
  plainOutput,
  python,
  readJson,
  repoRoot,
  runInstaller,
  shell,
  skip,
  statusRows,
  writeFakeCopilot,
  writeFakePi,
  writeFile,
  writeLayers,
} from './lib/installer-test-kit.mjs';

// The upstream main commit before the codex runtime. The byte-for-byte comparisons run its installer from git archive.
const BASE_COMMIT = '787b5d9c1f5e38aca8624ff81858a1c04b69fac0';
const ORG = 'simpsonm09-org-ai-plugin';
const PERSONAL = 'simpsonm09-personal-ai-plugin';
const LAYER_PATH = { [ORG]: `projects/repos/${ORG}`, [PERSONAL]: `projects/repos/${PERSONAL}` };
const ALL_LAYERS = ['pstack', ORG, PERSONAL];
// The skills the kit's pstack fixture ships.
const PSTACK_SKILLS = ['poteto-mode', 'setup-pstack', 'principle-laziness-protocol'];
const LAUNCH_LINE = `-c 'project_root_markers=["stack.lock.json"]'`;

// A SKILL.md the generator accepts: a frontmatter name equal to the folder, and a description.
function skillMarkdown(name, { description = 'fixture skill', frontmatterName = name, extra = '' } = {}) {
  const descriptionLine = description === null ? '' : `description: ${description}\n`;
  return `---\nname: ${frontmatterName}\n${descriptionLine}${extra}---\nbody of ${name}\n`;
}

// A local layer checkout. Its skills map a folder name to the SKILL.md text. The Claude manifest names the layer, and the
// node_modules tree stops the installer from running npm.
function writeLocalLayer(workspace, name, skills) {
  const root = join(workspace, LAYER_PATH[name]);
  writeFile(root, 'index.ts', 'export default {};\n');
  writeFile(root, 'layer.json', JSON.stringify({ files: ['index.ts', 'node_modules', 'package.json', 'skills', '.claude-plugin'] }));
  writeFile(root, 'package.json', JSON.stringify({ name, version: '0.1.0' }));
  writeFile(root, 'node_modules/@opencode/plugin/index.js', 'module.exports = {};\n');
  writeFile(root, 'opencode.fragment.jsonc', '{}');
  writeFile(root, '.claude-plugin/plugin.json', JSON.stringify({ name, version: '0.1.0' }));
  for (const [folder, text] of Object.entries(skills)) writeFile(root, `skills/${folder}/SKILL.md`, text);
}

// One scratch context per test: a fixture repository from the kit, the stand-ins, and the layers file for the repository's
// layers.json. Each workspace added to it has the same fixture, so its pinned commit is the same.
function buildContext({ orgSkills = { 'org-demo': skillMarkdown('org-demo') }, personalSkills = { 'personal-demo': skillMarkdown('personal-demo') } } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'maxstack-codex-'));
  const ctx = {
    base,
    fixture: makeFixture(base),
    fakeCopilot: writeFakeCopilot(base),
    fakePi: writeFakePi(base),
    skills: { [ORG]: orgSkills, [PERSONAL]: personalSkills },
  };
  ctx.layersFile = writeLayers(ctx);
  return ctx;
}

// A workspace under the context. Its folder is named simpsonm09 in every workspace, so two can compare by their text.
function addWorkspace(ctx, name, { skills = ctx.skills } = {}) {
  const workspace = join(ctx.base, name, 'simpsonm09');
  mkdirSync(workspace, { recursive: true });
  for (const layer of [ORG, PERSONAL]) writeLocalLayer(workspace, layer, skills[layer]);
  return { ...ctx, workspace };
}

// The layers file of an installer tree other than this one: its layers.json, with the pstack pin pointed at the fixture.
function writeTreeLayers(ctx, treeRoot, fileName) {
  const manifest = readJson(join(treeRoot, 'layers.json'));
  const pstack = manifest.layers.find((layer) => layer.name === 'pstack');
  pstack.source = { url: ctx.fixture.url, path: 'plugins/pstack', commit: ctx.fixture.commit, ref: 'test' };
  const path = join(ctx.base, fileName);
  writeFileSync(path, JSON.stringify(manifest));
  return path;
}

// The installer of BASE_COMMIT, extracted from git archive, with its own layers.json.
function exportBaseTree(ctx) {
  const archive = spawnSync('git', ['-C', repoRoot, 'archive', '--format=tar', BASE_COMMIT], { windowsHide: true, maxBuffer: 512 * 1024 * 1024 });
  assert.equal(archive.status, 0, `git archive ${BASE_COMMIT} failed: ${archive.stderr}`);
  const tree = join(ctx.base, 'upstream-base');
  mkdirSync(tree);
  const extracted = spawnSync('tar', ['-x', '-f', '-', '-C', tree], { windowsHide: true, input: archive.stdout });
  assert.equal(extracted.status, 0, `tar could not extract ${BASE_COMMIT}: ${extracted.stderr}`);
  return { installer: join(tree, 'scripts', 'Install-Workspace.ps1'), layersFile: writeTreeLayers(ctx, tree, 'layers-base.json') };
}

function mustRun(ctx, extra = [], options = {}) {
  const run = runInstaller(shell, ctx, extra, options);
  assert.equal(run.status, 0, `installer exited ${run.status}\n${run.stdout}\n${run.stderr}`);
  return run;
}

function readLock(ctx) {
  return readJson(lockPath(ctx));
}

// The lock without its generation time, with the workspace path replaced, so two workspaces compare equal.
function normalizedLock(ctx) {
  const lock = readLock(ctx);
  delete lock.generatedAt;
  return JSON.stringify(lock, null, 2).split(ctx.workspace).join('<WORKSPACE>');
}

// Every output of a workspace, as relative path to a hash of its text with the workspace path replaced. A junction is
// recorded by its target text and never followed. The layer checkouts, the git metadata, and the lock files are not outputs.
function snapshot(root, workspace, prefix = '', out = new Map()) {
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.name === '.git' || (prefix === '' && (entry.name === 'projects' || entry.name.startsWith('stack.lock.json')))) continue;
    const full = join(root, relative);
    const info = lstatSync(full);
    if (info.isSymbolicLink()) {
      out.set(relative, `link:${readlinkSync(full).split(workspace).join('<WORKSPACE>')}`);
    } else if (info.isDirectory()) {
      out.set(`${relative}/`, 'dir');
      snapshot(root, workspace, relative, out);
    } else {
      out.set(relative, createHash('sha256').update(readFileSync(full, 'utf8').split(workspace).join('<WORKSPACE>')).digest('hex'));
    }
  }
  return out;
}

function snapshotOf(ctx) {
  return Object.fromEntries([...snapshot(ctx.workspace, ctx.workspace)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function lstatSafe(path) {
  try {
    return lstatSync(path);
  } catch {
    return null;
  }
}

function hasRow(run, state, path) {
  return statusRows(run).some((row) => row.state === state && row.label === path);
}

function skillPath(name) {
  return `.agents/skills/${name}`;
}

function ownedSkillRecords(lock) {
  return lock.owned.filter((record) => record.kind === 'dir' && record.path.startsWith('.agents/skills/'));
}

function withContext(name, body, options) {
  test(name, { skip }, () => {
    const ctx = buildContext(options);
    try {
      body(ctx);
    } finally {
      rmSync(ctx.base, { recursive: true, force: true });
    }
  });
}

// -- The installed skills and the ownership record ------------------------------------------------------------------

withContext('codex copies each selected layer skill into .agents/skills and records each folder as owned by codex', (shared) => {
  const ctx = addWorkspace(shared, 'skills');
  const run = mustRun(ctx, ['-Runtimes', 'codex']);

  const lock = readLock(ctx);
  assert.deepEqual(lock.selection.runtimes, ['codex'], 'only codex is selected');
  assert.deepEqual(lock.selection.layers, [...ALL_LAYERS].sort(), 'every layer is selected by default');

  const expected = [...PSTACK_SKILLS, 'org-demo', 'personal-demo'].sort();
  assert.deepEqual(readdirSync(join(ctx.workspace, '.agents', 'skills')).sort(), expected, 'one folder per skill, named by the skill');

  const orgSource = readFileSync(join(ctx.workspace, LAYER_PATH[ORG], 'skills', 'org-demo', 'SKILL.md'), 'utf8');
  const personalSource = readFileSync(join(ctx.workspace, LAYER_PATH[PERSONAL], 'skills', 'personal-demo', 'SKILL.md'), 'utf8');
  assert.equal(readFileSync(join(ctx.workspace, '.agents', 'skills', 'org-demo', 'SKILL.md'), 'utf8'), orgSource, 'org-demo is a byte copy');
  assert.equal(readFileSync(join(ctx.workspace, '.agents', 'skills', 'personal-demo', 'SKILL.md'), 'utf8'), personalSource, 'personal-demo is a byte copy');
  assert.match(readFileSync(join(ctx.workspace, '.agents', 'skills', 'poteto-mode', 'SKILL.md'), 'utf8'), /name: poteto-mode/, 'the pstack skill came from the pinned pstack source');

  const records = ownedSkillRecords(lock);
  assert.deepEqual(records.map((record) => record.path).sort(), expected.map(skillPath).sort(), 'every skill folder is owned');
  for (const record of records) {
    assert.equal(record.runtime, 'codex', `${record.path} belongs to codex`);
    assert.match(record.sha256, /^[0-9A-F]{64}$/, `${record.path} records its tree hash`);
  }
  const layersOf = Object.fromEntries(records.map((record) => [record.path, record.layers]));
  assert.deepEqual(layersOf[skillPath('org-demo')], [ORG]);
  assert.deepEqual(layersOf[skillPath('personal-demo')], [PERSONAL]);
  assert.deepEqual(layersOf[skillPath('poteto-mode')], ['pstack']);

  assert.ok(lock.createdDirs.includes('.agents'), '.agents is recorded as created by the installer');
  assert.ok(lock.createdDirs.includes('.agents/skills'), '.agents/skills is recorded as created by the installer');

  for (const path of ['opencode.jsonc', '.opencode', '.claude/plugins', '.pi', '.maxstack']) {
    assert.equal(lstatSafe(join(ctx.workspace, path)), null, `${path} is not written when only codex is selected`);
  }
  assert.ok(plainOutput(run).includes(LAUNCH_LINE), 'the launch arguments for the T3 instance are printed');
});

// The generator refuses a name two layers share, for the runtimes that find a skill by its bare name. Codex does too.
withContext('two layers that name the same skill refuse the apply before anything is written', (shared) => {
  const ctx = addWorkspace(shared, 'dup', { skills: { [ORG]: { 'shared-skill': skillMarkdown('shared-skill') }, [PERSONAL]: { 'shared-skill': skillMarkdown('shared-skill') } } });
  const run = runInstaller(shell, ctx, ['-Runtimes', 'codex']);
  assert.notEqual(run.status, 0, plainOutput(run));
  assert.match(plainOutput(run), /duplicate skill shared-skill across layers/);
  assert.equal(lstatSafe(join(ctx.workspace, '.agents')), null, 'no .agents folder is written');
  assert.equal(lstatSafe(lockPath(ctx)), null, 'no lock is written');
});

withContext('two skill names that differ only by case are refused, as the generator refuses them', (shared) => {
  const ctx = addWorkspace(shared, 'case', { skills: { [ORG]: { 'Shared-Skill': skillMarkdown('Shared-Skill') }, [PERSONAL]: { 'shared-skill': skillMarkdown('shared-skill') } } });
  const run = runInstaller(shell, ctx, ['-Runtimes', 'codex']);
  assert.notEqual(run.status, 0, plainOutput(run));
  assert.match(plainOutput(run), /duplicate skill/);
  assert.equal(lstatSafe(join(ctx.workspace, '.agents')), null);
});

// Each bad skill is refused with the generator's message. Each case has its own workspace.
for (const [label, folder, text, pattern] of [
  ['a skill without a description', 'no-description', skillMarkdown('no-description', { description: null }), /frontmatter description is missing or empty/],
  ['a skill whose frontmatter name is not its folder name', 'named-wrong', skillMarkdown('named-wrong', { frontmatterName: 'other-name' }), /frontmatter name .* must equal the folder name/],
  ['a skill that sets a model', 'has-model', skillMarkdown('has-model', { extra: 'model: some-model\n' }), /frontmatter model is not allowed/],
  ['a skill folder name with a dot', 'bad.name', skillMarkdown('bad.name'), /skill folder names must be letters, digits, and hyphens/],
]) {
  withContext(`codex refuses ${label}, as the generator does`, (shared) => {
    const ctx = addWorkspace(shared, 'bad', { skills: { [ORG]: { [folder]: text }, [PERSONAL]: { 'personal-demo': skillMarkdown('personal-demo') } } });
    const run = runInstaller(shell, ctx, ['-Runtimes', 'codex']);
    assert.notEqual(run.status, 0, plainOutput(run));
    assert.match(plainOutput(run), pattern);
    assert.equal(lstatSafe(join(ctx.workspace, '.agents')), null, 'nothing is written');
  });
}

withContext('a skill that holds a junction is refused, as the generator refuses a link under a skill', (shared) => {
  const ctx = addWorkspace(shared, 'link');
  const target = join(shared.base, 'link-target');
  mkdirSync(target);
  writeFileSync(join(target, 'note.txt'), 'outside\n');
  symlinkSync(target, join(ctx.workspace, LAYER_PATH[ORG], 'skills', 'org-demo', 'linked'), 'junction');
  const run = runInstaller(shell, ctx, ['-Runtimes', 'codex']);
  assert.notEqual(run.status, 0, plainOutput(run));
  assert.match(plainOutput(run), /symbolic link or junction/);
  assert.equal(lstatSafe(join(ctx.workspace, '.agents')), null);
});

// -- Folders maxstack did not write ---------------------------------------------------------------------------------

withContext('an unowned folder under .agents/skills survives apply, -Remove, and -Uninstall', (shared) => {
  const ctx = addWorkspace(shared, 'keep');
  writeFile(ctx.workspace, '.agents/skills/my-own-skill/SKILL.md', skillMarkdown('my-own-skill'));
  writeFile(ctx.workspace, '.agents/skills/my-own-skill/notes.txt', 'mine\n');
  const own = readFileSync(join(ctx.workspace, '.agents', 'skills', 'my-own-skill', 'SKILL.md'), 'utf8');

  mustRun(ctx, ['-Runtimes', 'opencode,codex']);
  assert.equal(readFileSync(join(ctx.workspace, '.agents', 'skills', 'my-own-skill', 'SKILL.md'), 'utf8'), own, 'apply leaves it alone');
  assert.ok(!readLock(ctx).owned.some((record) => record.path === skillPath('my-own-skill')), 'the lock does not claim it');

  mustRun(ctx, ['-Remove', '-Runtimes', 'codex']);
  assert.equal(readFileSync(join(ctx.workspace, '.agents', 'skills', 'my-own-skill', 'notes.txt'), 'utf8'), 'mine\n', '-Remove leaves it alone');
  assert.equal(lstatSafe(join(ctx.workspace, '.agents', 'skills', 'org-demo')), null, '-Remove deleted the codex skill it wrote');

  mustRun(ctx, ['-Runtimes', 'codex']);
  mustRun(ctx, ['-Uninstall']);
  assert.equal(readFileSync(join(ctx.workspace, '.agents', 'skills', 'my-own-skill', 'SKILL.md'), 'utf8'), own, '-Uninstall leaves it alone');
  assert.equal(lstatSafe(join(ctx.workspace, '.agents', 'skills', 'org-demo')), null, '-Uninstall deleted the codex skills');
  assert.ok(lstatSafe(join(ctx.workspace, '.agents', 'skills')), '.agents/skills stays: it holds the user folder');
  assert.equal(lstatSafe(lockPath(ctx)), null, 'the lock files are removed');
});

withContext('a user folder that holds a skill name is refused, and nothing in it changes', (shared) => {
  const ctx = addWorkspace(shared, 'clash');
  writeFile(ctx.workspace, '.agents/skills/org-demo/MINE.md', 'my own copy\n');
  const run = runInstaller(shell, ctx, ['-Runtimes', 'codex']);
  assert.notEqual(run.status, 0, plainOutput(run));
  assert.match(plainOutput(run), /\.agents\/skills\/org-demo already exists and maxstack did not write it/);
  assert.equal(readFileSync(join(ctx.workspace, '.agents', 'skills', 'org-demo', 'MINE.md'), 'utf8'), 'my own copy\n');
  assert.equal(lstatSafe(lockPath(ctx)), null, 'no lock is written');
});

// -- Re-apply, removal, and status ----------------------------------------------------------------------------------

withContext('a second codex apply changes nothing and keeps the same lock', (shared) => {
  const ctx = addWorkspace(shared, 'idem');
  mustRun(ctx, ['-Runtimes', 'codex']);
  const firstLock = normalizedLock(ctx);
  const firstTree = snapshotOf(ctx);
  mustRun(ctx, []);
  assert.equal(normalizedLock(ctx), firstLock, 'the lock is the same');
  assert.deepEqual(snapshotOf(ctx), firstTree, 'the files are the same');
});

withContext('status reports codex skills matching, modified after a hand edit, and drifted when the layer skill changes', (shared) => {
  const ctx = addWorkspace(shared, 'status');
  mustRun(ctx, ['-Runtimes', 'codex']);
  const installed = join(ctx.workspace, '.agents', 'skills', 'org-demo', 'SKILL.md');
  const original = readFileSync(installed, 'utf8');

  const matching = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assert.equal(matching.status, 0, plainOutput(matching));
  assert.ok(hasRow(matching, 'matching', skillPath('org-demo')), plainOutput(matching));
  assert.match(plainOutput(matching), /AGENTS\.md/, 'status names the workspace AGENTS.md');

  writeFileSync(installed, '---\nname: org-demo\ndescription: edited by hand\n---\n');
  const edited = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assert.ok(hasRow(edited, 'modified', skillPath('org-demo')), plainOutput(edited));
  const refused = runInstaller(shell, ctx, ['-Runtimes', 'codex']);
  assert.notEqual(refused.status, 0, plainOutput(refused));
  assert.match(plainOutput(refused), /changed since the last apply/, 'an apply does not overwrite a folder that changed');

  writeFileSync(installed, original);
  assert.ok(hasRow(runInstaller(shell, ctx, ['-Status'], { apply: false }), 'matching', skillPath('org-demo')));

  writeFileSync(join(ctx.workspace, LAYER_PATH[ORG], 'skills', 'org-demo', 'SKILL.md'), skillMarkdown('org-demo', { description: 'changed in the layer' }));
  const drifted = runInstaller(shell, ctx, ['-Status'], { apply: false });
  assert.ok(hasRow(drifted, 'drifted', skillPath('org-demo')), plainOutput(drifted));
});

withContext('-Remove -Runtimes codex removes what codex wrote and leaves the other runtimes as they were', (shared) => {
  const ctx = addWorkspace(shared, 'remove');
  mustRun(ctx, ['-Runtimes', 'opencode,codex']);
  const before = snapshotOf(ctx);

  const dry = runInstaller(shell, ctx, ['-Remove', '-Runtimes', 'codex'], { apply: false });
  assert.equal(dry.status, 0, plainOutput(dry));
  assert.ok(lstatSafe(join(ctx.workspace, '.agents', 'skills', 'org-demo')), 'a dry run removes nothing');

  mustRun(ctx, ['-Remove', '-Runtimes', 'codex']);
  assert.equal(lstatSafe(join(ctx.workspace, '.agents')), null, 'the .agents folders the installer created are gone');
  const lock = readLock(ctx);
  assert.deepEqual(lock.selection.runtimes, ['opencode']);
  assert.equal(ownedSkillRecords(lock).length, 0, 'no codex record is left');
  const after = snapshotOf(ctx);
  for (const [path, value] of Object.entries(before)) {
    if (path.startsWith('.agents')) continue;
    assert.equal(after[path], value, `${path} is unchanged`);
  }
});

withContext('-Remove -Layers removes that layer codex skills and leaves the others', (shared) => {
  const ctx = addWorkspace(shared, 'remove-layer');
  mustRun(ctx, ['-Runtimes', 'codex']);
  mustRun(ctx, ['-Remove', '-Layers', PERSONAL]);
  assert.equal(lstatSafe(join(ctx.workspace, '.agents', 'skills', 'personal-demo')), null, 'the removed layer skill is gone');
  assert.ok(lstatSafe(join(ctx.workspace, '.agents', 'skills', 'org-demo')), 'the other layer skill stays');
  const lock = readLock(ctx);
  assert.deepEqual(lock.selection.layers, ['pstack', ORG]);
  assert.ok(!ownedSkillRecords(lock).some((record) => record.path === skillPath('personal-demo')), 'its record is gone');
  assert.ok(ownedSkillRecords(lock).some((record) => record.path === skillPath('org-demo')), 'the other record stays');
});

withContext('-Remove -Layers keeps a codex skill the user changed, names it, and keeps its record', (shared) => {
  const ctx = addWorkspace(shared, 'remove-changed');
  mustRun(ctx, ['-Runtimes', 'codex']);
  writeFileSync(join(ctx.workspace, '.agents', 'skills', 'personal-demo', 'SKILL.md'), skillMarkdown('personal-demo', { description: 'changed' }));
  const run = mustRun(ctx, ['-Remove', '-Layers', PERSONAL]);
  assert.match(plainOutput(run), /SKIP\s+\.agents\/skills\/personal-demo/, plainOutput(run));
  assert.ok(lstatSafe(join(ctx.workspace, '.agents', 'skills', 'personal-demo', 'SKILL.md')), 'the changed folder is kept');
  assert.ok(ownedSkillRecords(readLock(ctx)).some((record) => record.path === skillPath('personal-demo')), 'the lock still owns it');
});

withContext('-Update -Check reports the codex skills without writing', (shared) => {
  const ctx = addWorkspace(shared, 'update');
  mustRun(ctx, ['-Runtimes', 'codex']);
  const before = snapshotOf(ctx);
  const run = runInstaller(shell, ctx, ['-Update', '-Check'], { apply: false });
  assert.equal(run.status, 0, plainOutput(run));
  assert.deepEqual(snapshotOf(ctx), before, 'nothing is written');
});

withContext('-Uninstall removes codex records and the folders the installer created', (shared) => {
  const ctx = addWorkspace(shared, 'uninstall');
  mustRun(ctx, ['-Runtimes', 'codex']);
  mustRun(ctx, ['-Uninstall']);
  assert.equal(lstatSafe(join(ctx.workspace, '.agents')), null);
  assert.equal(lstatSafe(lockPath(ctx)), null);
});

// -- Selection -------------------------------------------------------------------------------------------------------

withContext('codex is selected by the settings file runtimes map', (shared) => {
  const ctx = addWorkspace(shared, 'settings');
  writeFileSync(join(ctx.workspace, 'maxstack.settings.json'), JSON.stringify({ version: 1, runtimes: { codex: {} } }));
  mustRun(ctx);
  const lock = readLock(ctx);
  assert.deepEqual(lock.selection.runtimes, ['codex']);
  assert.ok(ownedSkillRecords(lock).length > 0);
});

withContext('-Runtimes all selects codex with the other runtimes', (shared) => {
  const ctx = addWorkspace(shared, 'all');
  mustRun(ctx, ['-Runtimes', 'all']);
  assert.deepEqual(readLock(ctx).selection.runtimes, ['claude', 'codex', 'copilot', 'opencode', 'pi']);
});

withContext('a new workspace with no flags does not select codex, and its status says nothing about codex', (shared) => {
  const ctx = addWorkspace(shared, 'default');
  mustRun(ctx);
  assert.deepEqual(readLock(ctx).selection.runtimes, ['claude', 'copilot', 'opencode', 'pi']);
  assert.equal(lstatSafe(join(ctx.workspace, '.agents')), null, 'no codex output');
  assert.doesNotMatch(plainOutput(runInstaller(shell, ctx, ['-Status'], { apply: false })), /AGENTS\.md/);
});

for (const [label, value] of [
  ['a zero-width space inside the name', 'codex​'],
  ['a Greek omicron for the o', 'cοdex'],
  ['a trailing soft hyphen', 'codex­'],
]) {
  withContext(`-Runtimes refuses ${label}`, (shared) => {
    const ctx = addWorkspace(shared, 'lookalike');
    const run = runInstaller(shell, ctx, ['-Runtimes', value]);
    assert.notEqual(run.status, 0, plainOutput(run));
    assert.equal(lstatSafe(lockPath(ctx)), null, 'nothing is written');
    assert.equal(lstatSafe(join(ctx.workspace, '.agents')), null, 'no codex output');
  });
}

withContext('-Runtimes folds ASCII letter case, so CODEX selects codex', (shared) => {
  const ctx = addWorkspace(shared, 'fold');
  mustRun(ctx, ['-Runtimes', 'CODEX']);
  assert.deepEqual(readLock(ctx).selection.runtimes, ['codex']);
});

withContext('the settings file refuses a runtime name with a zero-width space', (shared) => {
  const ctx = addWorkspace(shared, 'settings-lookalike');
  writeFileSync(join(ctx.workspace, 'maxstack.settings.json'), JSON.stringify({ version: 1, runtimes: { 'codex​': {} } }));
  const run = runInstaller(shell, ctx, []);
  assert.notEqual(run.status, 0, plainOutput(run));
  assert.equal(lstatSafe(lockPath(ctx)), null);
});

// -- Byte for byte: a workspace that does not select codex is unchanged ---------------------------------------------

// The installer of BASE_COMMIT and the installer here write into one workspace path, so their wrapper hashes, which
// hold the path, compare equal. Each capture starts from an empty workspace: every folder but the layer checkouts goes.
function resetWorkspace(workspace) {
  for (const entry of readdirSync(workspace)) {
    if (entry !== 'projects') rmSync(join(workspace, entry), { recursive: true, force: true });
  }
}

function lockText(ctx) {
  const lock = readLock(ctx);
  delete lock.generatedAt;
  return JSON.stringify(lock, null, 2);
}

// What one installer leaves from an empty workspace: its apply output, its status output, its lock, and its files. With
// legacy, the base installer first writes the lock, and the selection field is then removed, as a lock from before it.
function captureApply(ctx, { installerPath, layersFile }, { legacy = null } = {}) {
  resetWorkspace(ctx.workspace);
  if (legacy) {
    mustRun(ctx, [], { installerPath: legacy.installer, layersFile: legacy.layersFile });
    const lock = readLock(ctx);
    delete lock.selection;
    writeFileSync(lockPath(ctx), JSON.stringify(lock));
  }
  const apply = mustRun(ctx, [], { installerPath, layersFile });
  const status = runInstaller(shell, ctx, ['-Status'], { apply: false, installerPath, layersFile });
  return { apply: plainOutput(apply), status: plainOutput(status), lock: lockText(ctx), files: snapshotOf(ctx) };
}

withContext('a new workspace with no codex selection writes the same output, lock, and files as before', (shared) => {
  const base = exportBaseTree(shared);
  const ctx = addWorkspace(shared, 'fresh');
  const before = captureApply(ctx, { installerPath: base.installer, layersFile: base.layersFile });
  const now = captureApply(ctx, { installerPath: installer, layersFile: shared.layersFile });
  assert.equal(now.apply, before.apply, 'the apply output is the same');
  assert.equal(now.status, before.status, 'the status output is the same');
  assert.equal(now.lock, before.lock, 'the lock is the same');
  assert.deepEqual(now.files, before.files, 'the files are the same');
  assert.deepEqual(JSON.parse(now.lock).selection.runtimes, ['claude', 'copilot', 'opencode', 'pi']);
});

withContext('an old lock with no selection field is applied the same as before, and codex is not added', (shared) => {
  const base = exportBaseTree(shared);
  const ctx = addWorkspace(shared, 'legacy');
  const before = captureApply(ctx, { installerPath: base.installer, layersFile: base.layersFile }, { legacy: base });
  const now = captureApply(ctx, { installerPath: installer, layersFile: shared.layersFile }, { legacy: base });
  assert.equal(now.apply, before.apply, 'the apply output is the same');
  assert.equal(now.status, before.status, 'the status output is the same');
  assert.equal(now.lock, before.lock, 'the lock is the same');
  assert.deepEqual(now.files, before.files, 'the files are the same');
  assert.deepEqual(JSON.parse(now.lock).selection.runtimes, ['claude', 'copilot', 'opencode', 'pi'], 'the selection the lock gets is the four runtimes');
  assert.equal(lstatSafe(join(ctx.workspace, '.agents')), null, 'codex is not added to an existing install');
});

// -- The Python verifier accepts a codex workspace --------------------------------------------------------------------

withContext('verify-workspace-install.py passes a codex workspace', (shared) => {
  assert.ok(python, 'python is needed for the verifier');
  const ctx = addWorkspace(shared, 'verify');
  mustRun(ctx, ['-Runtimes', 'codex']);
  const home = join(shared.base, 'empty-home');
  mkdirSync(home);
  const verify = spawnSync(python, [join(repoRoot, 'scripts', 'verify-workspace-install.py'), '--workspace', ctx.workspace, '--home', home], { windowsHide: true, encoding: 'utf8' });
  assert.equal(verify.status, 0, `${verify.stdout}\n${verify.stderr}`);
});
