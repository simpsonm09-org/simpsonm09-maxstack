import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const install = readFileSync(join(root, 'docs', 'install.md'), 'utf8');
const t3 = readFileSync(join(root, 'docs', 't3-setup.md'), 'utf8');

test('finding F4: the new workspace guide gives prerequisites, layer sources, commands, T3 setup, and ignore paths', () => {
  const section = install.split('## New workspace\n')[1]?.split('\n## ')[0] ?? '';
  for (const expected of ['PowerShell 7', 'Git', 'Node.js and npm', 'network access', 'simpsonm09-org-ai-plugin.git', 'simpsonm09-personal-ai-plugin.git', '-Status -Strict', 't3-setup.md#pi-maxstack']) {
    assert.ok(section.includes(expected), `new workspace guide is missing ${expected}`);
  }
  for (const ignored of ['.agents/', '.maxstack/', '.pi/', '.opencode/agents/', '.opencode/plugins/', 'opencode.jsonc*', 'stack.lock.json*']) {
    assert.ok(section.includes(ignored), `new workspace ignore block is missing ${ignored}`);
  }
  assert.match(section, /\$PiCommand = Join-Path \$Workspace .*node_modules\/\.bin\/pi\.cmd/);
  assert.match(section, /-Runtimes all -PiCommand \$PiCommand -Apply/);
});

test('finding F7: Pi install-time selection and MAXSTACK_PI_BIN runtime behavior are documented', () => {
  assert.match(install, /-PiCommand <path>.*-CopilotCommand <path>/s);
  assert.match(install, /MAXSTACK_PI_BIN` is read by the wrapper at run time; the installer does not read it/);
});

test('finding F8: OpenCode debug verification documents its managed service behavior', () => {
  assert.match(install, /OpenCode 2\.x debug commands start or reuse its managed background service/);
  assert.doesNotMatch(install, /It starts no server/);
  assert.match(t3, /OpenCode 2\.x debug commands start or reuse its managed background service/);
});

test('finding F9/F10: dependency size and all generated runtime folders are documented', () => {
  assert.match(install, /network access.*npm dependencies/s);
  assert.match(install, /about 140 MB under `\.opencode\/plugins\/<layer>\/node_modules`/);
  const section = install.split('```gitignore\n')[1]?.split('\n```')[0] ?? '';
  for (const ignored of ['.agents/', '.claude/cache/', '.claude/plugins/', '.maxstack/', '.opencode/agents/', '.opencode/plugins/', '.pi/', 'opencode.jsonc*', 'stack.lock.json*']) {
    assert.ok(section.includes(ignored), `ignore guidance is missing ${ignored}`);
  }
  assert.match(install, /Add the generated paths to the workspace `.gitignore`; the installer does not edit that file/);
});
