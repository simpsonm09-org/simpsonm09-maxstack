import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { MISSING_COPILOT, buildWorkspace, lockPath, readJson, removal, repoRoot, runInstaller, runStatus, shell, skip, snapshotTree, statusRows, writeLayers } from './lib/installer-test-kit.mjs';

const posix = process.platform !== 'win32';
const bash = posix ? 'bash' : join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'usr', 'bin', 'bash.exe');

// The wrappers each platform writes: executable LF shell scripts on POSIX, and the .cmd
// pair on Windows.
function assertPlatformWrappers(ctx, wrapper, piWrapper) {
  if (posix) {
    assert.equal(existsSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd')), false);
    assert.equal(existsSync(join(ctx.workspace, '.maxstack', 'bin', 'pi.cmd')), false);
    const text = readFileSync(wrapper, 'utf8');
    assert.doesNotMatch(text, /\r|\uFEFF/);
    assert.notEqual(statSync(wrapper).mode & 0o111, 0);
    const invocation = spawnSync(bash, [wrapper, '--fixture', 'two words'], { windowsHide: true, cwd: repoRoot, encoding: 'utf8', env: { ...process.env, PATH: `${ctx.base}:${process.env.PATH ?? ''}` } });
    assert.equal(invocation.status, 0, `${invocation.stdout}\n${invocation.stderr}`);
    assert.match(invocation.stdout, /ARG=--plugin-dir[\s\S]*\.claude\/plugins\/pstack[\s\S]*\.claude\/plugins\/simpsonm09-org-ai-plugin[\s\S]*ARG=--fixture\nARG=two words/);
    const piText = readFileSync(piWrapper, 'utf8');
    assert.doesNotMatch(piText, /\r|\uFEFF/);
    assert.notEqual(statSync(piWrapper).mode & 0o111, 0);
    const piInvocation = spawnSync(bash, [piWrapper, '--fixture', 'two words'], { windowsHide: true, cwd: repoRoot, encoding: 'utf8', env: { ...process.env, PATH: `${ctx.base}:${process.env.PATH ?? ''}` } });
    assert.equal(piInvocation.status, 0, `${piInvocation.stdout}\n${piInvocation.stderr}`);
    assert.match(piInvocation.stdout, /AGENT_DIR=.*\.pi\/agent[\s\S]*ARG=--fixture\nARG=two words/);
  } else {
    const cmdText = readFileSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.cmd'), 'utf8');
    const shText = readFileSync(join(ctx.workspace, '.maxstack', 'bin', 'copilot.sh'), 'utf8');
    assert.match(cmdText, /\r\nset "AGENT_ACCESS_COPILOT_ASK=allow"\r\n/);
    assert.match(cmdText, /--plugin-dir .*pstack.*--plugin-dir .*simpsonm09-org-ai-plugin/);
    assert.match(shText, /See copilot\.cmd\./);
    assert.ok(!cmdText.startsWith('\uFEFF') && !shText.startsWith('\uFEFF'));
  }
}

test('Claude and Copilot lifecycle uses the platform wrappers and leaves no owned files', { skip }, () => {
  const ctx = buildWorkspace();
  try {
    const copilot = join(ctx.base, posix ? 'copilot' : 'copilot.cmd');
    const pi = posix ? join(ctx.base, 'pi') : ctx.fakePi;
    writeFileSync(copilot, posix ? '#!/bin/sh\nprintf "ASK=%s\\n" "$AGENT_ACCESS_COPILOT_ASK"\nfor arg in "$@"; do printf "ARG=%s\\n" "$arg"; done\n' : '@echo off\r\necho ASK=%AGENT_ACCESS_COPILOT_ASK%\r\necho ARGS=%*\r\n');
    if (posix) chmodSync(copilot, 0o755);
    if (posix) {
      writeFileSync(pi, '#!/bin/sh\nprintf "AGENT_DIR=%s\\n" "$PI_CODING_AGENT_DIR"\nprintf "ASK=%s\\n" "$AGENT_ACCESS_PI_ASK"\nfor arg in "$@"; do printf "ARG=%s\\n" "$arg"; done\n');
      chmodSync(pi, 0o755);
    }
    const layers = writeLayers(ctx, (manifest) => {
      const pstack = manifest.layers.find((layer) => layer.name === 'pstack');
      Object.assign(pstack.runtimes, { codex: {}, cursor: {}, antigravity: {} });
    });
    const runtimes = 'claude,copilot,opencode,pi,codex,cursor,antigravity';
    const extra = ['-CopilotCommand', copilot, '-PiCommand', pi, '-Runtimes', runtimes, '-Layers', 'pstack,simpsonm09-org-ai-plugin'];
    const apply = runInstaller(shell, ctx, extra, { layersFile: layers });
    assert.equal(apply.status, 0, `${apply.stdout}\n${apply.stderr}`);
    const lock = readJson(lockPath(ctx));
    assert.deepEqual(lock.copilot.wrappers, posix ? ['.maxstack/bin/copilot.sh'] : ['.maxstack/bin/copilot.cmd', '.maxstack/bin/copilot.sh']);
    assert.deepEqual(lock.pi.wrappers, posix ? ['.maxstack/bin/pi.sh'] : ['.maxstack/bin/pi.cmd', '.maxstack/bin/pi.sh']);
    assert.ok(lock.owned.every((record) => !record.path.includes('\\')), 'lock paths use forward slashes');
    const wrapper = join(ctx.workspace, '.maxstack', 'bin', posix ? 'copilot.sh' : 'copilot.cmd');
    const piWrapper = join(ctx.workspace, '.maxstack', 'bin', posix ? 'pi.sh' : 'pi.cmd');
    assert.ok(existsSync(wrapper));
    assert.ok(existsSync(piWrapper));
    assert.ok(existsSync(join(ctx.workspace, '.opencode', 'plugins', 'pstack', 'opencode', 'index.ts')));
    assert.ok(existsSync(join(ctx.workspace, '.agents', 'skills', 'demo-skill', 'SKILL.md')));
    assert.ok(existsSync(join(ctx.workspace, '.cursor', 'skills', 'demo-skill', 'SKILL.md')));
    assertPlatformWrappers(ctx, wrapper, piWrapper);

    const clean = runStatus(ctx, ['-Strict', '-CopilotCommand', copilot, '-PiCommand', pi]);
    assert.equal(clean.status, 0, clean.stderr);
    assert.ok(statusRows(clean).every((row) => ['matching', 'not selected'].includes(row.state)), `${clean.stdout}\n${clean.stderr}`);
    const before = readFileSync(lockPath(ctx));
    const again = runInstaller(shell, ctx, extra, { layersFile: layers });
    assert.equal(again.status, 0, `${again.stdout}\n${again.stderr}`);
    const firstLock = JSON.parse(before);
    const secondLock = readJson(lockPath(ctx));
    delete firstLock.generatedAt;
    delete secondLock.generatedAt;
    assert.deepEqual(secondLock, firstLock);

    const removed = removal(ctx, ['-Remove', '-Runtimes', 'copilot']);
    assert.equal(removed.status, 0, `${removed.stdout}\n${removed.stderr}`);
    assert.equal(existsSync(join(ctx.workspace, '.maxstack', 'bin', posix ? 'copilot.sh' : 'copilot.cmd')), false);
    assert.ok(existsSync(piWrapper));
    assert.ok(existsSync(join(ctx.workspace, '.opencode', 'plugins', 'pstack', 'opencode', 'index.ts')));
    assert.ok(existsSync(join(ctx.workspace, '.agents', 'skills', 'demo-skill', 'SKILL.md')));
    assert.ok(existsSync(join(ctx.workspace, '.cursor', 'skills', 'demo-skill', 'SKILL.md')));
    assert.equal(runStatus(ctx).status, 0);

    const ownedPaths = readJson(lockPath(ctx)).owned.map((record) => record.path);
    const uninstalled = removal(ctx, ['-Uninstall']);
    assert.equal(uninstalled.status, 0, `${uninstalled.stdout}\n${uninstalled.stderr}`);
    for (const path of ownedPaths) assert.equal(existsSync(join(ctx.workspace, ...path.split('/'))), false, `${path} remains owned`);
    assert.equal(existsSync(lockPath(ctx)), false);
  } finally {
    // The kit's workspace is under the OS temp directory and is removed by the test kit's documented helper.
    rmSync(ctx.base, { recursive: true, force: true });
  }
});

test('POSIX missing Copilot CLI keeps recorded wrapper arrays and reports a changed shell wrapper', { skip: process.platform === 'win32' ? 'POSIX wrapper behavior' : skip }, () => {
  const ctx = buildWorkspace();
  try {
    const copilot = join(ctx.base, 'copilot');
    writeFileSync(copilot, '#!/bin/sh\nexit 0\n');
    chmodSync(copilot, 0o755);
    const layers = writeLayers(ctx);
    const args = ['-CopilotCommand', copilot, '-Runtimes', 'claude,copilot', '-Layers', 'pstack,simpsonm09-org-ai-plugin'];
    const installed = runInstaller(shell, ctx, args, { layersFile: layers });
    assert.equal(installed.status, 0, `${installed.stdout}\n${installed.stderr}`);
    assert.deepEqual(readJson(lockPath(ctx)).copilot.wrappers, ['.maxstack/bin/copilot.sh']);

    const missing = runInstaller(shell, ctx, ['-CopilotCommand', MISSING_COPILOT, '-Runtimes', 'claude,copilot', '-Layers', 'pstack,simpsonm09-org-ai-plugin'], { layersFile: layers });
    assert.equal(missing.status, 0, `${missing.stdout}\n${missing.stderr}`);
    assert.match(`${missing.stdout}\n${missing.stderr}`, /Kept .*copilot\.sh because Copilot was not found/);
    assert.deepEqual(readJson(lockPath(ctx)).copilot.wrappers, ['.maxstack/bin/copilot.sh']);

    const wrapper = join(ctx.workspace, '.maxstack', 'bin', 'copilot.sh');
    writeFileSync(wrapper, '#!/bin/sh\n# edited by user\n');
    const changed = runInstaller(shell, ctx, ['-CopilotCommand', MISSING_COPILOT, '-Runtimes', 'claude,copilot', '-Layers', 'pstack,simpsonm09-org-ai-plugin'], { layersFile: layers });
    assert.equal(changed.status, 0, `${changed.stdout}\n${changed.stderr}`);
    assert.match(`${changed.stdout}\n${changed.stderr}`, /Kept .*copilot\.sh: it is not the installer's recorded copy/);
    assert.ok(existsSync(wrapper), 'the changed shell wrapper was removed');
  } finally {
    rmSync(ctx.base, { recursive: true, force: true });
  }
});
