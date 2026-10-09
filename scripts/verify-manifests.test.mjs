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
    if (spawnSync(name, ['--version']).status === 0) return name;
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
function runVerifier({ layers = (manifest) => manifest, pinLock = null, omitPinLock = false, extraFiles = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'maxstack-manifests-'));
  try {
    const manifest = layers(shipped('layers.json'));
    writeFileSync(join(root, 'layers.json'), JSON.stringify(manifest));
    if (!omitPinLock) writeFileSync(join(root, 'pstack.lock.json'), JSON.stringify(pinLock ?? shipped('pstack.lock.json')));
    mkdirSync(join(root, 'workspace'));
    copyFileSync(join(repoRoot, 'workspace', 'opencode.jsonc'), join(root, 'workspace', 'opencode.jsonc'));
    copyFileSync(join(repoRoot, 'README.md'), join(root, 'README.md'));
    mkdirSync(join(root, 'docs'));
    copyFileSync(join(repoRoot, 'docs', 'layout.md'), join(root, 'docs', 'layout.md'));
    writeFileSync(join(root, 'docs', 'plugin-publishing.md'), '# plugin publishing\n');
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts', 'Install-Workspace.ps1'), '# installer\n');
    copyFileSync(verifier, join(root, 'scripts', 'verify-manifests.py'));
    for (const [rel, content] of Object.entries(extraFiles)) writeFileSync(join(root, rel), content);
    return spawnSync(python, [join(root, 'scripts', 'verify-manifests.py')], { encoding: 'utf8' });
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
  const run = spawnSync(python, [verifier], { encoding: 'utf8' });
  assert.equal(run.status, 0, failureOf(run));
  assert.match(run.stdout, /^PASS:/);
});

test('the shipped pstack layer is one git source with all three runtimes', { skip }, () => {
  const pstack = pstackOf(shipped('layers.json'));
  assert.equal(pstack.kind, 'plugin');
  assert.equal(typeof pstack.source, 'object', 'pstack is pinned to a git source');
  assert.deepEqual(Object.keys(pstack.runtimes).sort(), ['claude', 'copilot', 'opencode']);
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
      manifest.layers[1].runtimes.codex = {};
      return manifest;
    },
  });
  assert.equal(run.status, 1, failureOf(run));
  assert.match(failureOf(run), /unknown runtime 'codex'/);
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
