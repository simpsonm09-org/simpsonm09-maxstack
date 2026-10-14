#!/usr/bin/env node
// Prove scripts/verify-manifests.py accepts the shipped layers.json and refuses each
// broken shape the installer relies on. Each case copies the manifests into a throwaway
// repository layout, changes one thing, and runs the real script there. No network.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const verifier = join(repoRoot, 'scripts', 'verify-manifests.py');

function findPython() {
  for (const name of ['python', 'python3']) {
    if (spawnSync(name, ['--version'], { windowsHide: true }).status === 0) return name;
  }
  return null;
}

const python = findPython();
const skip = python ? false : 'python is not available';

function shipped(path) {
  return JSON.parse(readFileSync(join(repoRoot, path), 'utf8'));
}

// Copies the manifests and the files the verifier reads into a temporary repository
// layout, applies the change, and runs the verifier there.
// tracked maps a path to content for files the temporary repository commits to its index; it makes the root a git repository.
function runVerifier({ layers = (manifest) => manifest, pinLock = null, omitPinLock = false, extraFiles = {}, lock = null, tracked = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'maxstack-manifests-'));
  try {
    const manifest = layers(shipped('layers.json'));
    writeFileSync(join(root, 'layers.json'), JSON.stringify(manifest));
    if (!omitPinLock) writeFileSync(join(root, 'pstack.lock.json'), JSON.stringify(pinLock ?? shipped('pstack.lock.json')));
    mkdirSync(join(root, 'workspace'));
    copyFileSync(join(repoRoot, 'workspace', 'opencode.jsonc'), join(root, 'workspace', 'opencode.jsonc'));
    copyFileSync(join(repoRoot, 'workspace', 'maxstack.settings.json'), join(root, 'workspace', 'maxstack.settings.json'));
    mkdirSync(join(root, 'schemas'));
    copyFileSync(join(repoRoot, 'schemas', 'maxstack.settings.schema.json'), join(root, 'schemas', 'maxstack.settings.schema.json'));
    copyFileSync(join(repoRoot, 'README.md'), join(root, 'README.md'));
    mkdirSync(join(root, 'docs'));
    copyFileSync(join(repoRoot, 'docs', 'layout.md'), join(root, 'docs', 'layout.md'));
    writeFileSync(join(root, 'docs', 'plugin-publishing.md'), '# plugin publishing\n');
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts', 'Install-Workspace.ps1'), '# installer\n');
    copyFileSync(join(repoRoot, 'scripts', 'Install-Settings.ps1'), join(root, 'scripts', 'Install-Settings.ps1'));
    copyFileSync(verifier, join(root, 'scripts', 'verify-manifests.py'));
    copyFileSync(join(repoRoot, 'scripts', 'verify_settings.py'), join(root, 'scripts', 'verify_settings.py'));
    copyFileSync(join(repoRoot, 'scripts', 'settings_document.py'), join(root, 'scripts', 'settings_document.py'));
    copyFileSync(join(repoRoot, 'scripts', 'verify_ownership.py'), join(root, 'scripts', 'verify_ownership.py'));
    for (const [rel, content] of Object.entries(extraFiles)) {
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), content);
    }
    if (Object.keys(tracked).length > 0) {
      spawnSync('git', ['init', '-q'], { windowsHide: true, cwd: root });
      for (const [rel, content] of Object.entries(tracked)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), content);
        spawnSync('git', ['add', '--', rel], { windowsHide: true, cwd: root });
      }
    }
    const args = [join(root, 'scripts', 'verify-manifests.py')];
    if (lock !== null) {
      writeFileSync(join(root, 'stack.lock.json'), JSON.stringify(lock));
      args.push('--lock', join(root, 'stack.lock.json'));
    }
    return spawnSync(python, args, { windowsHide: true, encoding: 'utf8' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function pstackOf(manifest) {
  return manifest.layers.find((layer) => layer.name === 'pstack');
}

function failureOf(run) {
  return `${run.stdout}\n${run.stderr}`;
}

test('the shipped manifests pass the verifier', { skip }, () => {
  const run = spawnSync(python, [verifier], { windowsHide: true, encoding: 'utf8' });
  assert.equal(run.status, 0, failureOf(run));
  assert.match(run.stdout, /^PASS:/);
});

test('the settings seed is valid and schema keys match the PowerShell validator', { skip }, () => {
  const run = spawnSync(python, [verifier], { windowsHide: true, encoding: 'utf8' });
  assert.equal(run.status, 0, failureOf(run));
  assert.deepEqual(shipped('workspace/maxstack.settings.json'), { version: 1 });
});

test('the manifest verifier rejects settings schema and validator key drift', { skip }, () => {
  const validator = readFileSync(join(repoRoot, 'scripts', 'Install-Settings.ps1'), 'utf8');
  const altered = validator.replace("'claude', 'codex', 'copilot', 'opencode', 'pi'", "'claude', 'codex', 'copilot', 'opencode', 'new-harness'");
  assert.notEqual(altered, validator, 'the fixture replacement found the validator list');
  const run = runVerifier({ extraFiles: { 'scripts/Install-Settings.ps1': altered } });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /schema runtime ids differ/);
});

test('the manifest verifier compares settings enums and structural constraints from the shipped schema', { skip }, () => {
  const schema = shipped('schemas/maxstack.settings.schema.json');
  schema.properties.runtimes.propertyNames.enum = ['claude', 'copilot', 'opencode', 'changed'];
  const run = runVerifier({ extraFiles: { 'schemas/maxstack.settings.schema.json': JSON.stringify(schema) } });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /schema runtime ids differ/);
});

test('the manifest verifier reports malformed settings schema shapes without a traceback', { skip }, () => {
  const cases = [
    [(schema) => { schema.properties.runtimes = []; }, /settings schema runtimes must be an object/],
    [(schema) => { schema.properties.runtimes.propertyNames.enum = 'claude'; }, /propertyNames must have an enum list/],
    [(schema) => { schema.properties.runtimes.additionalProperties.properties.cli.enum = 'detect'; }, /SettingsCliModes enum must have an enum list/],
    [(schema) => { schema.properties.layers.additionalProperties = 'object'; }, /settings schema layer entries must be objects/],
    [(schema) => { schema.properties.t3.properties = []; }, /settings schema T3 entries need an object properties field/],
  ];
  for (const [mutate, expected] of cases) {
    const schema = shipped('schemas/maxstack.settings.schema.json');
    mutate(schema);
    const run = runVerifier({ extraFiles: { 'schemas/maxstack.settings.schema.json': JSON.stringify(schema) } });
    assert.equal(run.status, 1, failureOf(run));
    assert.match(failureOf(run), expected);
    assert.doesNotMatch(failureOf(run), /Traceback/);
  }
});

test('the manifest verifier reports invalid UTF-8 settings files without a traceback', { skip }, () => {
  const run = runVerifier({ extraFiles: { 'schemas/maxstack.settings.schema.json': Buffer.from([0xff]) } });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /maxstack\.settings\.schema\.json is not valid UTF-8/);
  assert.doesNotMatch(failureOf(run), /Traceback|UnicodeDecodeError/);
});

test('the settings seed and schema must each hold one strict JSON object, with version an integer 1', { skip }, () => {
  const seedCases = [
    ['null', 'null', /workspace\/maxstack\.settings\.json must hold one JSON object/],
    ['boolean version', '{"version":true}', /needs "version": 1/],
    ['float version', '{"version":1.0}', /needs "version": 1/],
    ['exponent version', '{"version":1e0}', /needs "version": 1/],
    ['escaped duplicate key', '{"version":1,"\\u0076ersion":1}', /duplicate key 'version'/],
    ['deep nesting', `{"version":1,"x":${'['.repeat(40)}0${']'.repeat(40)}}`, /nested deeper than 32/],
    ['NaN', '{"version":NaN}', /not strict JSON/],
  ];
  for (const [label, text, expected] of seedCases) {
    const run = runVerifier({ extraFiles: { 'workspace/maxstack.settings.json': text } });
    assert.equal(run.status, 1, `${label}: ${failureOf(run)}`);
    assert.match(failureOf(run), expected, label);
    assert.doesNotMatch(failureOf(run), /Traceback/, label);
  }
  const bom = runVerifier({ extraFiles: { 'workspace/maxstack.settings.json': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"version":1}')]) } });
  assert.equal(bom.status, 0, failureOf(bom));
  const nullSchema = runVerifier({ extraFiles: { 'schemas/maxstack.settings.schema.json': 'null' } });
  assert.equal(nullSchema.status, 1, failureOf(nullSchema));
  assert.match(failureOf(nullSchema), /maxstack\.settings\.schema\.json must be an object/);
});

test('the shipped pstack layer is one git source with all four runtimes', { skip }, () => {
  const pstack = pstackOf(shipped('layers.json'));
  assert.equal(pstack.kind, 'plugin');
  assert.equal(typeof pstack.source, 'object', 'pstack is pinned to a git source');
  assert.deepEqual(Object.keys(pstack.runtimes).sort(), ['claude', 'copilot', 'opencode', 'pi']);
  assert.equal(pstack.runtimes.opencode.entry, 'opencode/index.ts');
  assert.equal(pstack.runtimes.opencode.agents, 'opencode/agents');
});

test('a copilot runtime without claude is refused', { skip }, () => {
  const run = runVerifier({
    layers: (manifest) => {
      manifest.layers[2].runtimes = { opencode: {}, copilot: {} };
      return manifest;
    },
  });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /declares copilot, which loads the Claude plugin folder, so it also needs claude/);
});

test('a pi runtime without claude is refused', { skip }, () => {
  const run = runVerifier({
    layers: (manifest) => {
      manifest.layers[1].runtimes = { opencode: {}, pi: {} };
      return manifest;
    },
  });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /declares pi, which lists the Claude plugin folder's skills, so it also needs claude/);
});

test('a local layer that declares claude without opencode is refused', { skip }, () => {
  const run = runVerifier({
    layers: (manifest) => {
      manifest.layers[1].runtimes = { claude: {} };
      return manifest;
    },
  });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /declares claude from a local checkout, which links to its OpenCode copy/);
});

test('an unknown runtime name is refused', { skip }, () => {
  const run = runVerifier({
    layers: (manifest) => {
      manifest.layers[1].runtimes.gemini = {};
      return manifest;
    },
  });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /unknown runtime 'gemini'/);
});

test('an OpenCode entry at the folder root, other than index.ts, is refused', { skip }, () => {
  const run = runVerifier({
    layers: (manifest) => {
      pstackOf(manifest).runtimes.opencode.entry = 'plugin.ts';
      return manifest;
    },
  });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /names the root file plugin\.ts/);
});

test('a git source with a short commit is refused', { skip }, () => {
  const run = runVerifier({
    layers: (manifest) => {
      pstackOf(manifest).source.commit = 'fd8038';
      return manifest;
    },
  });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /source\.commit must be a 40-character lowercase commit SHA/);
});

test('a layer with both a checkout path and a git source is refused', { skip }, () => {
  const run = runVerifier({
    layers: (manifest) => {
      pstackOf(manifest).path = 'projects/repos/pstack';
      return manifest;
    },
  });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /carries its own path/);
});

test('a pin lock that names another commit than layers.json is refused', { skip }, () => {
  const lock = shipped('pstack.lock.json');
  lock.commit = 'a'.repeat(40);
  const run = runVerifier({ pinLock: lock });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /pstack\.lock\.json: commit does not match layers\.json/);
});

test('a git source with no pin lock is refused', { skip }, () => {
  const run = runVerifier({ omitPinLock: true });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /pstack\.lock\.json is required by the git source/);
});

test('the retired OpenCode port lock is refused while it exists', { skip }, () => {
  const run = runVerifier({ extraFiles: { 'pstack-opencode.lock.json': '{}' } });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /pstack-opencode\.lock\.json is retired/);
});

const git = spawnSync('git', ['--version'], { windowsHide: true }).status === 0;

test('a tracked Python bytecode file is refused, and the message names it', { skip: python ? (git ? false : 'git is not available') : skip }, () => {
  const run = runVerifier({ tracked: { 'scripts/__pycache__/verify_ownership.cpython-312.pyc': 'bytecode\n' } });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /scripts\/__pycache__\/verify_ownership\.cpython-312\.pyc is tracked/);
});

test('a tracked .pyc outside a __pycache__ folder is refused too', { skip: python ? (git ? false : 'git is not available') : skip }, () => {
  const run = runVerifier({ tracked: { 'scripts/stale.pyc': 'bytecode\n' } });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /scripts\/stale\.pyc is tracked/);
});

test('tracked source files pass the bytecode check', { skip: python ? (git ? false : 'git is not available') : skip }, () => {
  const run = runVerifier({ tracked: { 'scripts/helper.py': 'x = 1\n', 'scripts/__pycache_notes.txt': 'kept\n' } });
  assert.equal(run.status, 0, failureOf(run));
});

test('the layer names and the single plugin layer are checked', { skip }, () => {
  const run = runVerifier({
    layers: (manifest) => {
      manifest.layers[1].name = 'pstack';
      return manifest;
    },
  });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /two layers share a name/);
});

// An ownership record in the order the installer writes it: by path, then kind, then key.
const OWNED = [
  { path: '.claude/cache/pstack', kind: 'dir', sha256: 'A'.repeat(64), runtime: null, layers: ['pstack'] },
  { path: '.claude/plugins/pstack', kind: 'dir', sha256: 'B'.repeat(64), runtime: 'claude', layers: ['pstack'] },
  { path: '.claude/plugins/simpsonm09-org-ai-plugin', kind: 'link', target: '.opencode/plugins/simpsonm09-org-ai-plugin', runtime: 'claude', layers: ['simpsonm09-org-ai-plugin'] },
  { path: '.maxstack/bin/pi.cmd', kind: 'file', sha256: 'C'.repeat(64), runtime: 'pi', layers: [] },
  { path: '.pi/agent/settings.json', kind: 'json-entries', key: 'packages', entries: ['../../.claude/cache/pstack'], runtime: 'pi', layers: ['pstack'] },
  { path: '.pi/agent/settings.json', kind: 'json-entries', key: 'skills', entries: ['../../.claude/plugins/pstack/skills'], runtime: 'pi', layers: ['pstack'] },
  { path: 'opencode.jsonc', kind: 'file', sha256: 'D'.repeat(64), runtime: 'opencode', layers: [] },
];

function lockWith(owned, extra = {}) {
  return { ownedSchema: 2, layers: [], owned, ...extra };
}

test('a well-formed ownership record passes --lock', { skip }, () => {
  const run = runVerifier({ lock: lockWith(OWNED) });
  assert.equal(run.status, 0, failureOf(run));
  assert.match(run.stdout, /^PASS:/);
});

test('an ownership record with no schema version, or no owned list, is refused', { skip }, () => {
  const noSchema = runVerifier({ lock: { owned: OWNED, layers: [] } });
  assert.equal(noSchema.status, 1, failureOf(noSchema));
  assert.match(failureOf(noSchema), /ownedSchema must be 2; run Install-Workspace\.ps1 -Apply once/);

  const noOwned = runVerifier({ lock: { ownedSchema: 2, layers: [] } });
  assert.equal(noOwned.status, 1, failureOf(noOwned));
  assert.match(failureOf(noOwned), /has no owned list/);
});

test('an owned path that is not a workspace-relative forward-slash path is refused', { skip }, () => {
  for (const path of ['.maxstack\\bin\\pi.cmd', 'C:/dev/x', '/etc/passwd', '../outside', 'stack.lock.json']) {
    const owned = OWNED.map((record, index) => (index === 0 ? { ...record, path } : record));
    const run = runVerifier({ lock: lockWith(owned) });
    assert.equal(run.status, 1, `${path}: ${failureOf(run)}`);
    assert.match(failureOf(run), /path must be a workspace-relative path with forward slashes/, path);
  }
});

test('an owned record with a short hash, an unknown kind, or an extra field is refused', { skip }, () => {
  const cases = [
    [{ ...OWNED[0], sha256: 'abc' }, /sha256 must be 64 upper-case hex digits/],
    [{ ...OWNED[0], sha256: 'a'.repeat(64) }, /sha256 must be 64 upper-case hex digits/],
    [{ ...OWNED[0], kind: 'folder' }, /kind must be one of/],
    [{ ...OWNED[0], note: 'extra' }, /must hold exactly/],
    [{ ...OWNED[2], target: '' }, /target must be a workspace-relative path/],
  ];
  for (const [record, pattern] of cases) {
    const owned = OWNED.map((existing, index) => (index === 0 ? record : existing));
    const run = runVerifier({ lock: lockWith(owned) });
    assert.equal(run.status, 1, failureOf(run));
    assert.match(failureOf(run), pattern);
  }
});

test('a json-entries record with an unknown key, or no entries, is refused', { skip }, () => {
  const unknownKey = OWNED.map((record) => (record.key === 'skills' ? { ...record, key: 'extensions' } : record));
  const unknown = runVerifier({ lock: lockWith(unknownKey) });
  assert.equal(unknown.status, 1, failureOf(unknown));
  assert.match(failureOf(unknown), /key must be one of \[/);

  const empty = OWNED.map((record) => (record.key === 'skills' ? { ...record, entries: [] } : record));
  const none = runVerifier({ lock: lockWith(empty) });
  assert.equal(none.status, 1, failureOf(none));
  assert.match(failureOf(none), /entries must be a non-empty list/);
});

test('owned records out of order, or named twice, are refused', { skip }, () => {
  const reversed = runVerifier({ lock: lockWith([...OWNED].reverse()) });
  assert.equal(reversed.status, 1, failureOf(reversed));
  assert.match(failureOf(reversed), /owned is not sorted by path, kind, and key/);

  const twice = runVerifier({ lock: lockWith([OWNED[0], OWNED[0], ...OWNED.slice(1)]) });
  assert.equal(twice.status, 1, failureOf(twice));
  assert.match(failureOf(twice), /names one path, kind, and key twice/);
});

test('the owned list is sorted by UTF-8 bytes, so a fullwidth name comes before an emoji name', { skip }, () => {
  // Code point order and UTF-8 order agree; UTF-16 would put the emoji (a surrogate pair) first.
  const fullwidth = { path: 'Ａ-fullwidth/x', kind: 'dir', sha256: 'A'.repeat(64), runtime: null, layers: [] };
  const emoji = { path: '\u{1F642}-emoji/x', kind: 'dir', sha256: 'B'.repeat(64), runtime: null, layers: [] };
  const sorted = runVerifier({ lock: lockWith([fullwidth, emoji]) });
  assert.equal(sorted.status, 0, failureOf(sorted));
  const reversed = runVerifier({ lock: lockWith([emoji, fullwidth]) });
  assert.equal(reversed.status, 1, failureOf(reversed));
  assert.match(failureOf(reversed), /owned is not sorted by path, kind, and key/);
});

test('a json-entries record may carry createdKey true, and createdKey is refused in any other value', { skip }, () => {
  const created = OWNED.map((record) => (record.key === 'skills' ? { ...record, createdKey: true } : record));
  const passed = runVerifier({ lock: lockWith(created, { createdDirs: ['.claude', '.claude/plugins'], createdFiles: [] }) });
  assert.equal(passed.status, 0, failureOf(passed));

  const falsy = OWNED.map((record) => (record.key === 'skills' ? { ...record, createdKey: false } : record));
  const refused = runVerifier({ lock: lockWith(falsy) });
  assert.equal(refused.status, 1, failureOf(refused));
  assert.match(failureOf(refused), /createdKey, when present, must be true/);
});

test('createdDirs and createdFiles are lists of workspace paths, sorted once each', { skip }, () => {
  const backslash = runVerifier({ lock: lockWith(OWNED, { createdDirs: ['.maxstack\\bin'] }) });
  assert.equal(backslash.status, 1, failureOf(backslash));
  assert.match(failureOf(backslash), /createdDirs must be a list of workspace-relative paths/);

  const twice = runVerifier({ lock: lockWith(OWNED, { createdFiles: ['.pi/agent/settings.json', '.pi/agent/settings.json'] }) });
  assert.equal(twice.status, 1, failureOf(twice));
  assert.match(failureOf(twice), /createdFiles names a path twice/);
});

test('a backup record is an ordinary file record, and it is accepted', { skip }, () => {
  const backup = [...OWNED, { path: 'opencode.jsonc.bak', kind: 'file', sha256: 'E'.repeat(64), runtime: 'opencode', layers: [] }];
  const run = runVerifier({ lock: lockWith(backup) });
  assert.equal(run.status, 0, failureOf(run));
});

test('a record whose runtime does not match its path, or whose layers are unsorted, is refused', { skip }, () => {
  const wrongRuntime = OWNED.map((record) => (record.path === 'opencode.jsonc' ? { ...record, runtime: 'pi' } : record));
  const mismatch = runVerifier({ lock: lockWith(wrongRuntime) });
  assert.equal(mismatch.status, 1, failureOf(mismatch));
  assert.match(failureOf(mismatch), /runtime is pi, but its path belongs to opencode/);

  const unsorted = OWNED.map((record) => (record.path === '.claude/plugins/pstack' ? { ...record, layers: ['pstack', 'org'] } : record));
  const order = runVerifier({ lock: lockWith(unsorted) });
  assert.equal(order.status, 1, failureOf(order));
  assert.match(failureOf(order), /layers must be sorted by UTF-8 bytes, once each/);
});

test('an ownership record at ownedSchema 1 is refused, and the message says to run -Apply once', { skip }, () => {
  const run = runVerifier({ lock: { ...lockWith(OWNED), ownedSchema: 1 } });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /ownedSchema must be 2; run Install-Workspace\.ps1 -Apply once/);
});

// The source block each layer keeps in stack.lock.json. The shape check is shared with the workspace verifier, so these
// cases run the manifest verifier's --lock check on a lock that holds one layer's source.
const COMMIT = 'a'.repeat(40);
const GIT_SOURCE = { kind: 'git', url: 'https://github.com/simpsonm09/pstack-max.git', ref: 'feat', commit: COMMIT, override: true };
const LOCAL_SOURCE = { kind: 'local', url: null, ref: null, commit: COMMIT, dirty: false, override: true, path: 'projects/repos/checkout' };

function lockWithSource(source) {
  return { ownedSchema: 2, owned: [], layers: [{ name: 'pstack', source }] };
}

test('a git or local source block passes the lock shape check, and a legacy source string passes too', { skip }, () => {
  for (const source of [GIT_SOURCE, LOCAL_SOURCE, 'https://github.com/simpsonm09/pstack-max.git']) {
    const run = runVerifier({ lock: lockWithSource(source) });
    assert.equal(run.status, 0, `${JSON.stringify(source)}: ${failureOf(run)}`);
  }
});

test('a malformed source block is refused, with the rule it breaks', { skip }, () => {
  const { ref: _ref, ...withoutRef } = GIT_SOURCE;
  const cases = [
    [{ ...GIT_SOURCE, kind: 'svn' }, /source kind must be one of/],
    [{ ...GIT_SOURCE, commit: 'ABC' }, /commit must be a 40-character lowercase commit SHA/],
    [{ ...GIT_SOURCE, override: 'yes' }, /source override must be true or false/],
    [withoutRef, /must hold exactly/],
    [{ ...GIT_SOURCE, url: 'https://github.com/simpsonm09/pstack-max .git' }, /url must be a source URL with no spaces/],
    [{ ...LOCAL_SOURCE, dirty: null }, /dirty must be true or false where there is a commit/],
    [{ ...LOCAL_SOURCE, commit: null }, /dirty must be null where there is no commit/],
    [{ ...LOCAL_SOURCE, path: '' }, /path must name the checkout folder/],
    [{ ...LOCAL_SOURCE, extra: 1 }, /must hold exactly/],
    [null, /source must be an object, or the legacy string/],
  ];
  for (const [source, reason] of cases) {
    const run = runVerifier({ lock: lockWithSource(source) });
    assert.equal(run.status, 1, `${JSON.stringify(source)} passed`);
    assert.match(failureOf(run), reason, JSON.stringify(source));
  }
});

// The differential test: one PowerShell process runs Read-MaxstackSettings on each input, and one Python process runs the
// document reader on each input. The two must accept and refuse the same inputs. The driver is written to a temporary
// folder and receives the scripts folder, the input folder, and the layer names as arguments.
const SETTINGS_DRIVER = `param([string] $Scripts, [string] $Folder, [string] $LayerList)
Set-StrictMode -Version Latest
. (Join-Path $Scripts 'Install-Ordinal.ps1')
. (Join-Path $Scripts 'Install-WorkspaceDiscovery.ps1')
. (Join-Path $Scripts 'Install-LayerSources.ps1')
. (Join-Path $Scripts 'Install-Settings.ps1')
$layers = @($LayerList -split ',')
foreach ($file in @(Get-ChildItem -LiteralPath $Folder -Filter '*.json' | Sort-Object Name)) {
  try {
    $null = Read-MaxstackSettings -Path $file.FullName -LayerNames $layers
    $verdict = 'ACCEPT'
  } catch {
    $verdict = 'REFUSE'
  }
  Write-Output "DIFF|$($file.BaseName)|$verdict"
}
`;

function findPwsh() {
  return spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).status === 0 ? 'pwsh' : null;
}

const differentialSkip = python && findPwsh() ? false : 'python and pwsh are needed for the reader differential';

// The settings inputs, as [name, bytes]. Each becomes one file in the input folder.
function settingsDifferentialInputs() {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const padded = (size) => {
    const prefix = '{"version":1,"$schema":"';
    const suffix = '"}';
    return `${prefix}${'a'.repeat(size - prefix.length - suffix.length)}${suffix}`;
  };
  return [
    ['minimal', '{"version":1}'],
    ['bom', Buffer.concat([bom, Buffer.from('{"version":1}')])],
    ['double-bom', Buffer.concat([bom, bom, Buffer.from('{"version":1}')])],
    ['null', 'null'],
    ['version-true', '{"version":true}'],
    ['version-float', '{"version":1.0}'],
    ['version-exponent', '{"version":1e0}'],
    ['version-big-int', '{"version":100000000000000000000000000000000}'],
    ['duplicate-key', '{"version":1,"version":1}'],
    ['escaped-duplicate-key', '{"version":1,"\\u0076ersion":1}'],
    ['nbsp-before-object', '\u00a0{"version":1}'],
    ['vertical-tab', '\u000b{"version":1}'],
    ['form-feed', '\u000c{"version":1}'],
    ['lone-surrogate-escape', '{"version":1,"layers":{"pstack":{"source":"local:\\ud800"}}}'],
    ['lone-surrogate-bytes', Buffer.concat([Buffer.from('{"version":1,"layers":{"pstack":{"source":"local:'), Buffer.from([0xed, 0xa0, 0x80]), Buffer.from('"}}}')])],
    ['proto-key', '{"version":1,"__proto__":{}}'],
    ['constructor-key', '{"version":1,"constructor":{}}'],
    ['nan', '{"version":NaN}'],
    ['infinity', '{"version":Infinity}'],
    ['case-variant-version', '{"Version":1}'],
    ['case-variant-runtimes', '{"version":1,"Runtimes":{"claude":{}}}'],
    ['case-variant-cli', '{"version":1,"runtimes":{"claude":{"CLI":"detect"}}}'],
    ['unknown-key', '{"version":1,"extra":true}'],
    ['empty-runtimes', '{"version":1,"runtimes":{}}'],
    ['all-as-runtime', '{"version":1,"runtimes":{"all":{}}}'],
    ['os-all', '{"version":1,"os":"all"}'],
    ['cli-boolean', '{"version":1,"runtimes":{"claude":{"cli":true}}}'],
    ['t3-defaults-boolean', '{"version":1,"t3":{"defaults":true}}'],
    ['os-boolean', '{"version":1,"os":true}'],
    ['snapshot-integer', '{"version":1,"t3":{"snapshot":1}}'],
    ['deep-array-100000', `{"version":1,"x":${'['.repeat(100000)}${']'.repeat(100000)}}`],
    ['deep-object-100000', `{"version":1,"x":${'{"a":'.repeat(100000)}0${'}'.repeat(100000)}}`],
    ['deep-40', `{"version":1,"x":${'['.repeat(40)}0${']'.repeat(40)}}`],
    ['size-65536', padded(65536)],
    ['size-65537', padded(65537)],
    ['empty-local-path', '{"version":1,"layers":{"pstack":{"source":"local:"}}}'],
    ['date-like-schema', '{"version":1,"$schema":"2020-12-01T00:00:00Z"}'],
    ['date-like-source', '{"version":1,"layers":{"pstack":{"source":"2020-12-01"}}}'],
    ['https-source', '{"version":1,"layers":{"pstack":{"source":"https://example.invalid/owner/repo.git@main"}}}'],
    ['owner-source', '{"version":1,"layers":{"pstack":{"source":"sample-org/sample-layer@main"}}}'],
    ['control-in-source', '{"version":1,"layers":{"pstack":{"source":"sample/repo@main\\u0007"}}}'],
    ['del-source', '{"version":1,"layers":{"pstack":{"source":"sample/repo@main\u007f"}}}'],
    ['c1-source', '{"version":1,"layers":{"pstack":{"source":"sample/repo@main\u0085"}}}'],
    ['nbsp-source', '{"version":1,"layers":{"pstack":{"source":"sample/repo@main\u00a0"}}}'],
    ['bidi-source', '{"version":1,"layers":{"pstack":{"source":"sample/repo@main\u202e"}}}'],
    ['accented-source', '{"version":1,"layers":{"pstack":{"source":"sample/repo@main\u00e9"}}}'],
    ['dotdot-ref', '{"version":1,"layers":{"pstack":{"source":"sample/repo@bad..ref"}}}'],
    ['default-source', '{"version":1,"layers":{"pstack":{"source":"default"}}}'],
    ['unknown-layer', '{"version":1,"layers":{"absent":{}}}'],
    ['trailing-comma', '{"version":1,}'],
    ['line-comment', '// note\n{"version":1}'],
    ['empty-file', ''],
    ['invalid-utf8', Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x3a, 0x31, 0x7d])],
    ['full-valid', '{"$schema":"https://json-schema.org/draft/2020-12/schema","version":1,"os":"auto","runtimes":{"claude":{"cli":"detect"}},"layers":{"pstack":{"source":"default"}},"t3":{"cli":"detect","snapshot":true,"defaults":"leave-alone"}}'],
    ['pi-alone', '{"version":1,"runtimes":{"pi":{}}}'],
    // The nine culture inputs of the review: a format character in a key or a value that PowerShell's culture rules equated
    // with the plain name. Both readers refuse each one.
    ['culture-default-zero-width', '{"version":1,"layers":{"pstack":{"source":"default​"}}}'],
    ['culture-default-soft-hyphen', '{"version":1,"layers":{"pstack":{"source":"default­"}}}'],
    ['culture-os-zero-width', '{"version":1,"os":"windows​"}'],
    ['culture-cli-zero-width', '{"version":1,"runtimes":{"claude":{"cli":"install​"}}}'],
    ['culture-t3-defaults-soft-hyphen', '{"version":1,"t3":{"defaults":"apply-defaults­"}}'],
    ['culture-top-level-runtimes', '{"version":1,"runtimes​":{"claude":{}}}'],
    ['culture-top-level-layers', '{"version":1,"layers​":{"pstack":{}}}'],
    ['culture-layer-key-zero-width', '{"version":1,"layers":{"pstack​":{}}}'],
    ['culture-runtime-key-zwj', '{"version":1,"runtimes":{"pi‍":{}}}'],
    ['culture-t3-key-soft-hyphen', '{"version":1,"t3":{"cli­":"detect"}}'],
    ...sourceGrammarInputs(),
  ];
}

// The source grammar, one input per case: each is a settings file whose only content is one layers.pstack.source value. The
// PowerShell reader and the Python reader must agree on every one. A value is written with JSON.stringify, so a backslash, a
// control character, or a format character is encoded exactly as the reader will see it.
function sourceGrammarInputs() {
  const cases = [
    ['local-absolute-drive', 'local:C:\\x\\y'],
    ['local-absolute-dotdot', 'local:C:\\x\\..\\y'],
    ['local-absolute-slash', 'local:/x/y'],
    ['local-unc', 'local:\\\\server\\share\\x'],
    ['local-device-prefix', 'local:\\\\?\\C:\\x'],
    ['local-relative', 'local:projects/repos/checkout'],
    ['local-relative-dotdot', 'local:../outside'],
    ['local-relative-dotdot-middle', 'local:a/../b'],
    ['local-relative-dotdot-inside-name', 'local:a..b'],
    ['local-drive-relative', 'local:C:checkout'],
    ['local-root-relative', 'local:\\checkout'],
    ['local-dot', 'local:.'],
    ['local-blank', 'local:   '],
    ['local-ideographic-space', 'local:\u3000'],
    ['local-zero-width-space', 'local:\u200b'],
    ['local-tab-inside', 'local:a\tb'],
    ['local-lrm-inside', 'local:a\u200eb'],
    ['local-alm-inside', 'local:a\u061cb'],
    ['local-isolate-inside', 'local:a\u2066b'],
    ['local-line-separator', 'local:a\u2028b'],
    ['local-soft-hyphen', 'local:a\u00adb'],
    ['local-surrogate-pair', 'local:a\ud83d\ude00'],
    ['local-upper-prefix', 'LOCAL:checkout'],
    ['default-with-space', 'default '],
    ['default-capital', 'Default'],
    ['git-owner-repo-git-suffix', 'sample/repo.git@main'],
    ['git-owner-repo-dot-git', 'sample/.git@main'],
    ['git-https-query', 'https://host/a?b@main'],
    ['git-https-fragment', 'https://host/a#b@main'],
    ['git-https-userinfo', 'https://user@host/repo@main'],
    ['git-http-scheme', 'http://host/repo@main'],
    ['git-ssh-scheme', 'ssh://git@host/repo@main'],
    ['git-folder-with-ref', 'C:\\x@main'],
    ['git-no-ref', 'sample/repo'],
    ['git-empty-ref', 'sample/repo@'],
    ['git-ref-lock-suffix', 'sample/repo@feat.lock'],
    ['git-ref-trailing-dot', 'sample/repo@feat.'],
    ['git-ref-leading-dash', 'sample/repo@-feat'],
    ['git-ref-brace', 'sample/repo@a@{b'],
    ['git-ref-double-slash', 'sample/repo@a//b'],
    ['git-ref-star', 'sample/repo@a*'],
    ['git-ref-tilde', 'sample/repo@a~1'],
    ['git-location-dotdot', 'https://host/a/../b@main'],
    ['git-sha-ref', 'sample/repo@0123456789abcdef0123456789abcdef01234567'],
    ['local-unc-forward', 'local://server/share/x'],
    ['local-device-dot', 'local:\\\\.\\C:\\x'],
    ['local-device-drive-form', 'local:\\\\?\\C:\\x'],
    ['local-trailing-dot', 'local:tools/checkout.'],
    ['local-trailing-space', 'local:tools/checkout '],
    ['default-zero-width', 'default\u200b'],
    ['default-soft-hyphen', 'default\u00ad'],
    ['default-zero-width-joiner', 'default\u200d'],
    ['git-zero-width-ref', 'sample/repo@feat\u200bx'],
    ['git-zero-width-location', 'sample/re\u200bpo@main'],
    ['git-soft-hyphen-location', 'sample/re\u00adpo@main'],
  ];
  return cases.map(([name, value]) => [name, JSON.stringify({ version: 1, layers: { pstack: { source: value } } })]);
}

// The verdict of each input from each reader: ACCEPT or REFUSE. Python exits 0 for accept and 1 for refuse.
function runSettingsDifferential(inputs) {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-differential-'));
  try {
    const folder = join(dir, 'inputs');
    mkdirSync(folder);
    for (const [name, bytes] of inputs) writeFileSync(join(folder, `${name}.json`), bytes);
    const driver = join(dir, 'driver.ps1');
    writeFileSync(driver, SETTINGS_DRIVER);
    const layerList = shipped('layers.json').layers.map((layer) => layer.name).join(',');
    const ps = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', driver, '-Scripts', join(repoRoot, 'scripts'), '-Folder', folder, '-LayerList', layerList], { windowsHide: true, encoding: 'utf8' });
    assert.equal(ps.status, 0, `the PowerShell driver failed: ${ps.stderr}`);
    const powershell = new Map(ps.stdout.split(/\r?\n/).filter((line) => line.startsWith('DIFF|')).map((line) => line.split('|').slice(1)));
    const reader = new Map();
    for (const [name] of inputs) {
      const run = spawnSync(python, [join(repoRoot, 'scripts', 'verify_settings.py'), '--document', join(folder, `${name}.json`)], { windowsHide: true, encoding: 'utf8' });
      assert.ok(run.status === 0 || (run.status === 1 && run.stderr === ''), `the Python reader crashed on ${name}: ${run.stderr}`);
      reader.set(name, run.status === 0 ? 'ACCEPT' : 'REFUSE');
    }
    return { powershell, reader };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the Python reader and the PowerShell reader accept and refuse the same settings files', { skip: differentialSkip }, () => {
  const inputs = settingsDifferentialInputs();
  const { powershell, reader } = runSettingsDifferential(inputs);
  const disagreements = inputs
    .filter(([name]) => powershell.get(name) !== reader.get(name))
    .map(([name]) => `${name}: PowerShell ${powershell.get(name)}, Python ${reader.get(name)}`);
  assert.deepEqual(disagreements, [], 'the two readers disagree');
  const verdicts = new Set(powershell.values());
  assert.ok(verdicts.has('ACCEPT') && verdicts.has('REFUSE'), 'the differential needs both accepted and refused inputs');
});

// The inputs the review found accepted, or accepted by one reader only. Each is refused by both readers, not merely agreed on.
const MUST_REFUSE = [
  'local-absolute-slash', 'local-unc', 'local-unc-forward', 'local-device-prefix', 'local-device-dot', 'local-device-drive-form',
  'local-trailing-dot', 'local-trailing-space', 'default-zero-width', 'default-soft-hyphen', 'default-zero-width-joiner',
  'git-zero-width-ref', 'git-zero-width-location', 'git-soft-hyphen-location',
  'culture-default-zero-width', 'culture-default-soft-hyphen', 'culture-os-zero-width', 'culture-cli-zero-width',
  'culture-t3-defaults-soft-hyphen', 'culture-top-level-runtimes', 'culture-top-level-layers', 'culture-layer-key-zero-width',
  'culture-runtime-key-zwj', 'culture-t3-key-soft-hyphen',
];

test('the readers refuse each culture and root-relative input the review found, in both readers', { skip: differentialSkip }, () => {
  const inputs = settingsDifferentialInputs();
  const { powershell, reader } = runSettingsDifferential(inputs);
  const notRefused = MUST_REFUSE.filter((name) => powershell.get(name) !== 'REFUSE' || reader.get(name) !== 'REFUSE')
    .map((name) => `${name}: PowerShell ${powershell.get(name)}, Python ${reader.get(name)}`);
  assert.deepEqual(notRefused, [], 'a reader accepts an input it must refuse');
});

// The decision log is read as lines, so a carriage return inside a field or a line with other than six tab-separated fields
// changes what every reader sees. The verifier refuses both.
test('the decision log has exactly six tab-separated fields per line and no carriage return', { skip }, () => {
  const header = ['ts', 'phase', 'decision', 'why', 'evidence', 'result'].join('\t');
  const row = ['2026-10-11T05:47:28-04:00', 'phase', 'a decision', 'a reason', 'evidence', 'verified'].join('\t');
  const good = `${header}\n${row}\n`;
  let run = runVerifier({ extraFiles: { 'docs/decisions.tsv': good } });
  assert.equal(run.status, 0, failureOf(run));

  const carriage = `${header}\n${row.replace('a decision', `a deci${String.fromCharCode(13)}sion`)}\n`;
  run = runVerifier({ extraFiles: { 'docs/decisions.tsv': carriage } });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /decisions\.tsv.*carriage return/);

  const short = `${header}\na\tb\tc\td\te\n`;
  run = runVerifier({ extraFiles: { 'docs/decisions.tsv': short } });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /decisions\.tsv line 2 has 5 tab-separated fields; each line has six/);
});

// A device prefix and a UNC path are written with their full leading backslashes in the docs. A single backslash is a different,
// relative path, so the example would not say what the installer refuses. The form \\?\UNC\server\share is correct, so a bare
// \server\share counts only where it starts a token, not after the UNC separator.
test('the docs write device prefixes and UNC paths with their two leading backslashes', () => {
  const singleBackslashPrefix = /(?:^|[^\\])\\(?:\?\\|\.\\)/m;
  const singleBackslashShare = /(?:^|[\s`(])\\server\\share/m;
  for (const doc of ['docs/features/settings.md', 'docs/install.md']) {
    const text = readFileSync(join(repoRoot, doc), 'utf8');
    assert.doesNotMatch(text, singleBackslashPrefix, `${doc} writes a device prefix with one leading backslash`);
    assert.doesNotMatch(text, singleBackslashShare, `${doc} writes a UNC share with one leading backslash`);
  }
});

// Finding 18: the settings doc states the os and t3 rules once. A repeated paragraph is a second copy that drifts.
test('the settings doc states the os and t3 rules once', { skip }, () => {
  const text = readFileSync(join(repoRoot, 'docs', 'features', 'settings.md'), 'utf8');
  assert.equal(text.split('`os` accepts').length - 1, 1, 'the os and t3 paragraph appears more than once in docs/features/settings.md');
});
