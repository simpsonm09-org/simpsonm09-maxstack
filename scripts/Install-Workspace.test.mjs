#!/usr/bin/env node
// Prove Install-Workspace.ps1 records a workspace name in stack.lock.json and
// keeps an absolute path out of it. Runs the real script against a throwaway
// workspace built from layer stubs, so it needs no network and no plugin.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const installer = join(repoRoot, 'scripts', 'Install-Workspace.ps1');
const LAYERS = [
  'projects/repos/pstack-opencode-plugin',
  'projects/repos/simpsonm09-org-opencode-plugin',
  'projects/repos/simpsonm09-personal-opencode-plugin',
];

function findShell() {
  for (const name of ['pwsh', 'powershell']) {
    if (spawnSync(name, ['-NoProfile', '-Command', 'exit 0']).status === 0) return name;
  }
  return null;
}

function writeLayerFile(workspace, rel, content) {
  const full = join(workspace, ...rel.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function stringValues(node, out = []) {
  if (typeof node === 'string') out.push(node);
  else if (Array.isArray(node)) for (const item of node) stringValues(item, out);
  else if (node && typeof node === 'object') for (const item of Object.values(node)) stringValues(item, out);
  return out;
}

function buildWorkspace() {
  const base = mkdtempSync(join(tmpdir(), 'maxstack-lock-'));
  const workspace = join(base, 'simpsonm09');
  for (const layerPath of LAYERS) {
    // Every layer in layers.json carries a pluginTarget, so the installer
    // needs an index.ts in each and a copied node_modules to skip npm install.
    writeLayerFile(workspace, `${layerPath}/index.ts`, 'export default {};\n');
    writeLayerFile(workspace, `${layerPath}/layer.json`, JSON.stringify({ files: ['index.ts', 'node_modules'] }));
    writeLayerFile(workspace, `${layerPath}/node_modules/@opencode/plugin/index.js`, 'module.exports = {};\n');
    writeLayerFile(workspace, `${layerPath}/opencode.fragment.jsonc`, '{}');
  }
  return { base, workspace };
}

const shell = findShell();

test('the lock records a workspace name and no absolute path', { skip: shell ? false : 'pwsh is not available' }, () => {
  const { base, workspace } = buildWorkspace();
  try {
    const run = spawnSync(
      shell,
      ['-NoProfile', '-NonInteractive', '-File', installer, '-Workspace', workspace, '-Apply'],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 0, `installer exited ${run.status}\n${run.stdout}\n${run.stderr}`);

    const raw = readFileSync(join(workspace, 'stack.lock.json'), 'utf8');
    const lock = JSON.parse(raw);

    assert.equal(lock.workspace, 'simpsonm09', 'the lock names the workspace');
    assert.doesNotMatch(lock.workspace, /[\\/]/, 'the workspace name holds no separator');
    assert.ok(!raw.includes(workspace), 'the lock holds no absolute workspace path');
    for (const value of stringValues(lock)) {
      assert.doesNotMatch(value, /^[A-Za-z]:[\\/]/, `drive-letter path: ${value}`);
      assert.doesNotMatch(value, /^\//, `absolute path: ${value}`);
    }

    // The change keeps every pre-existing lock field.
    assert.equal(typeof lock.generatedAt, 'string');
    assert.equal(typeof lock.primaryModel, 'string');
    assert.match(lock.configSha256, /^[0-9a-fA-F]{64}$/);
    assert.equal(lock.layers.length, LAYERS.length);
    for (const record of lock.layers) {
      for (const key of ['name', 'kind', 'path', 'source']) {
        assert.equal(typeof record[key], 'string', `layer field ${key} is a string`);
      }
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
