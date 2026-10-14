import assert from 'node:assert/strict';
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildWorkspace, mustApply, plainOutput, runInstaller, shell, skip } from './lib/installer-test-kit.mjs';

test('a symbolic link retargeted outside the workspace is reported, safely replaced, and never uninstalls its target', { skip }, (t) => {
  const ctx = buildWorkspace();
  const outside = join(tmpdir(), `maxstack-link-escape-${process.pid}-${Date.now()}`);
  const child = join(ctx.workspace, '.claude', 'plugins', 'simpsonm09-org-ai-plugin');
  try {
    mustApply(ctx);
    mkdirSync(outside);
    writeFileSync(join(outside, 'keep.txt'), 'outside bytes');
    rmSync(child, { recursive: true, force: true });
    try {
      symlinkSync(outside, child, 'dir');
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
        t.skip(`Windows symbolic-link privilege unavailable: ${error.message}`);
        return;
      }
      throw error;
    }

    const drift = runInstaller(shell, ctx, ['-Status', '-Strict'], { apply: false });
    assert.notEqual(drift.status, 0, plainOutput(drift));
    assert.match(plainOutput(drift), /\.claude\/plugins\/simpsonm09-org-ai-plugin: differs|\.claude\\plugins\\simpsonm09-org-ai-plugin: differs/);
    assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'outside bytes', 'status changed the escaped target');

    const reapplied = runInstaller(shell, ctx, [], { apply: true });
    assert.equal(reapplied.status, 0, plainOutput(reapplied));
    assert.equal(lstatSync(child).isSymbolicLink(), process.platform !== 'win32', 'apply did not restore the platform link kind');
    assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'outside bytes', 'replacement changed the escaped target');

    const uninstalled = runInstaller(shell, ctx, ['-Uninstall'], { apply: true });
    assert.equal(uninstalled.status, 0, plainOutput(uninstalled));
    assert.equal(existsSync(child), false, 'uninstall left the Claude link behind');
    assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'outside bytes', 'uninstall changed the escaped target');
  } finally {
    rmSync(ctx.base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
