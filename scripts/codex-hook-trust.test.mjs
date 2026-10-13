#!/usr/bin/env node
// The codex-hook-trust script: the pure override text, the T3 argument tokenizer, picking the hook out of a
// hooks/list answer, and the whole script against a fake codex and against the real one. The fake codex speaks
// just enough JSON-RPC and reports trust only for the key and hash it handed out. The real test runs only when
// `codex` is on PATH, uses an empty temporary CODEX_HOME, and makes no model call. No test reads ~/.codex.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  assertHookPath,
  assertTrusted,
  hookDefinitionOverride,
  launchArguments,
  MARKER_OVERRIDE,
  pickHook,
  stateOverride,
  tokenizeLaunchArgs,
} from './codex-hook-trust.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const scriptPath = join(scriptsDir, 'codex-hook-trust.mjs');
const fakeScript = join(scriptsDir, 'fixtures', 'fake-codex.mjs');

// A codex named by a scratch wrapper: a .cmd on Windows, a shell file elsewhere. The whole test uses only the
// script's own spawn path, so the wrapper is what stands in for the real command.
function writeFakeCodex(base, name = 'codex') {
  const bin = join(base, 'fake-codex-bin');
  mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') {
    const path = join(bin, `${name}.cmd`);
    writeFileSync(path, `@echo off\r\n"${process.execPath}" "${fakeScript}" %*\r\n`);
    return path;
  }
  const path = join(bin, name);
  writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" "${fakeScript}" "$@"\n`);
  chmodSync(path, 0o755);
  return path;
}

// A scratch workspace with the marker file and a one-line stand-in hook, removed by the caller.
function scratchWorkspace() {
  const base = mkdtempSync(join(tmpdir(), 'maxstack-codex-trust-'));
  const workspace = join(base, 'simpsonm09');
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'stack.lock.json'), '{}');
  const hook = join(workspace, '.opencode', 'plugins', 'demo-layer', 'hooks', 'pre-tool-use.mjs');
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, 'process.exit(0);\n');
  return { base, workspace, hook };
}

function runScript(args, env = undefined) {
  return spawnSync(process.execPath, [scriptPath, ...args], { windowsHide: true, encoding: 'utf8', env: { ...process.env, ...env } });
}

function codexAvailable() {
  return spawnSync('codex', ['--version'], { windowsHide: true, shell: process.platform === 'win32' }).status === 0;
}

// -- The pure functions ---------------------------------------------------------------------------------------------

test('the hook definition override uses forward slashes, matcher Bash, and a 30 second timeout', () => {
  const override = hookDefinitionOverride('C:\\a\\pre-tool-use.mjs');
  assert.equal(
    override,
    'hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command="node C:/a/pre-tool-use.mjs codex",timeout=30}]}]',
  );
  assert.ok(!override.includes('\\'), 'no backslash is left in the definition');
});

test('the definition override refuses a path with a space or a single quote', () => {
  assert.throws(() => assertHookPath('C:\\has space\\pre-tool-use.mjs'), /holds a space/);
  assert.throws(() => assertHookPath("C:\\has'quote\\pre-tool-use.mjs"), /holds a single quote/);
  assert.doesNotThrow(() => assertHookPath('C:\\plain\\pre-tool-use.mjs'));
});

test('the tokenizer returns each -c value intact, keeping backslashes inside single quotes', () => {
  const key = 'C:\\<session-flags>\\config.toml:pre_tool_use:0:0';
  const hash = 'sha256:abc123';
  const line = launchArguments('C:\\ws\\.opencode\\plugins\\org\\hooks\\pre-tool-use.mjs', key, hash);
  const tokens = tokenizeLaunchArgs(line);
  assert.deepEqual(tokens, [
    '-c',
    MARKER_OVERRIDE,
    '-c',
    hookDefinitionOverride('C:\\ws\\.opencode\\plugins\\org\\hooks\\pre-tool-use.mjs'),
    '-c',
    stateOverride(key, hash),
  ]);
  assert.ok(tokens[5].includes('C:\\\\<session-flags>\\\\config.toml'), 'the key backslashes were kept doubled');
});

test('the tokenizer strips the grouping quotes and splits on whitespace', () => {
  assert.deepEqual(tokenizeLaunchArgs("-c 'a b' -c 'c'"), ['-c', 'a b', '-c', 'c']);
  assert.deepEqual(tokenizeLaunchArgs(''), []);
});

test('pickHook finds the hook whose command names the definition, and null otherwise', () => {
  const hook = { key: 'k', currentHash: 'sha256:x', trustStatus: 'untrusted', command: 'node C:/ws/pre-tool-use.mjs codex' };
  const answer = { result: { data: [{ cwd: 'C:/ws', hooks: [hook], warnings: [], errors: [] }] } };
  assert.equal(pickHook(answer, 'C:\\ws\\pre-tool-use.mjs'), hook);
  assert.equal(pickHook(answer, 'C:\\other\\pre-tool-use.mjs'), null);
  assert.equal(pickHook({ result: { data: [] } }, 'C:\\ws\\pre-tool-use.mjs'), null);
});

test('assertTrusted accepts trusted and refuses anything else', () => {
  assert.doesNotThrow(() => assertTrusted({ trustStatus: 'trusted' }));
  assert.throws(() => assertTrusted({ trustStatus: 'untrusted' }), /not trusted/);
  assert.throws(() => assertTrusted(null), /not trusted/);
});

// -- The whole script against a fake codex ---------------------------------------------------------------------------

test('the script prints the launch line and trusted status for a matching fake codex', () => {
  const ctx = scratchWorkspace();
  try {
    const codex = writeFakeCodex(ctx.base);
    const run = runScript(['--workspace', ctx.workspace, '--hook', ctx.hook, '--codex', codex]);
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.trustStatus, 'trusted');
    assert.ok(result.key.includes('pre_tool_use'), 'the key came from the fake');
    assert.match(result.hash, /^sha256:/);
    assert.equal(result.launchArguments, launchArguments(ctx.hook, result.key, result.hash));
    const tokens = tokenizeLaunchArgs(result.launchArguments);
    assert.deepEqual(tokens, ['-c', MARKER_OVERRIDE, '-c', hookDefinitionOverride(ctx.hook), '-c', stateOverride(result.key, result.hash)]);
  } finally {
    rmSync(ctx.base, { recursive: true, force: true });
  }
});

test('the script fails when the fake codex refuses trust', () => {
  const ctx = scratchWorkspace();
  try {
    const codex = writeFakeCodex(ctx.base);
    const run = runScript(['--workspace', ctx.workspace, '--hook', ctx.hook, '--codex', codex], { FAKE_CODEX_MODE: 'untrusted' });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /not trusted/);
  } finally {
    rmSync(ctx.base, { recursive: true, force: true });
  }
});

test('the script fails when codex never answers, after the shortened wait', () => {
  const ctx = scratchWorkspace();
  try {
    const codex = writeFakeCodex(ctx.base);
    const run = runScript(['--workspace', ctx.workspace, '--hook', ctx.hook, '--codex', codex, '--timeout-ms', '1500'], { FAKE_CODEX_MODE: 'silent' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /did not answer within 1500 ms/);
  } finally {
    rmSync(ctx.base, { recursive: true, force: true });
  }
});

test('the script fails when the codex command is missing', () => {
  const ctx = scratchWorkspace();
  try {
    const run = runScript(['--workspace', ctx.workspace, '--hook', ctx.hook, '--codex', 'maxstack-test-no-such-codex']);
    assert.equal(run.status, 1);
    assert.match(run.stderr, /was not found/);
  } finally {
    rmSync(ctx.base, { recursive: true, force: true });
  }
});

// -- The whole script against the real codex -------------------------------------------------------------------------

test('the script trusts the real codex without a login or a model call', { skip: codexAvailable() ? false : 'codex is not on PATH' }, () => {
  const ctx = scratchWorkspace();
  try {
    const run = runScript(['--workspace', ctx.workspace, '--hook', ctx.hook, '--timeout-ms', '60000']);
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.trustStatus, 'trusted');
    assert.match(result.key, /pre_tool_use:\d+:\d+$/);
    assert.match(result.hash, /^sha256:/);
    assert.ok(result.launchArguments.includes('project_root_markers=["stack.lock.json"]'));
  } finally {
    rmSync(ctx.base, { recursive: true, force: true });
  }
});
