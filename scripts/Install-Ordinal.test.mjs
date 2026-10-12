#!/usr/bin/env node
// The ordinal helpers in scripts/Install-Ordinal.ps1, run in PowerShell 7. Each case states a culture input (a zero width
// joiner, a soft hyphen, a canonically equivalent pair) and what the ordinal helper must answer for it.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const helper = resolve(scriptsDir, 'Install-Ordinal.ps1');

function findShell() {
  return spawnSync('pwsh', ['-NoProfile', '-Command', 'exit 0'], { windowsHide: true }).status === 0 ? 'pwsh' : null;
}

const shell = findShell();
const skip = shell ? false : 'pwsh is not available';

// Runs one PowerShell script that dot-sources the helper and prints one OUT|name|value line per check.
function runChecks(body) {
  const dir = mkdtempSync(join(tmpdir(), 'maxstack-ordinal-'));
  try {
    const file = join(dir, 'checks.ps1');
    writeFileSync(file, `$ErrorActionPreference = 'Stop'\n. '${helper.replaceAll("'", "''")}'\n${body}\n`);
    const run = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', file], { windowsHide: true, encoding: 'utf8' });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    return new Map(run.stdout.split(/\r?\n/).filter((line) => line.startsWith('OUT|')).map((line) => line.split('|').slice(1)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('Test-OrdinalEqual sees a zero width joiner, a soft hyphen, and a canonical twin as different text', { skip }, () => {
  const out = runChecks(String.raw`
$zwj = "pi$([char]0x200D)"
$shy = "default$([char]0x00AD)"
$zwsp = "pstack$([char]0x200B)"
$nfc = "$([char]0x00E9)"
$nfd = "e$([char]0x0301)"
"OUT|zwj|$(Test-OrdinalEqual 'pi' $zwj)"
"OUT|shy|$(Test-OrdinalEqual 'default' $shy)"
"OUT|zwsp|$(Test-OrdinalEqual 'pstack' $zwsp)"
"OUT|nfc|$(Test-OrdinalEqual $nfc $nfd)"
"OUT|same|$(Test-OrdinalEqual 'pi' 'pi')"
"OUT|case|$(Test-OrdinalEqual 'PI' 'pi')"
"OUT|number|$(Test-OrdinalEqual 0 '0')"
"OUT|null|$(Test-OrdinalEqual $null '')"
`);
  assert.equal(out.get('zwj'), 'False');
  assert.equal(out.get('shy'), 'False');
  assert.equal(out.get('zwsp'), 'False');
  assert.equal(out.get('nfc'), 'False');
  assert.equal(out.get('same'), 'True');
  assert.equal(out.get('case'), 'False');
  assert.equal(out.get('number'), 'False', 'a number is never a name');
  assert.equal(out.get('null'), 'False', 'a null is never a name');
});

test('Test-OrdinalIn and the ordinal sets keep a zero width name apart from its canonical name', { skip }, () => {
  const out = runChecks(String.raw`
$set = @('claude', 'pi', 'pstack')
$zwj = "pi$([char]0x200D)"
"OUT|in|$(Test-OrdinalIn 'pi' $set)"
"OUT|inZwj|$(Test-OrdinalIn $zwj $set)"
"OUT|notIn|$(Test-OrdinalIn 'PI' $set)"
"OUT|valueNotString|$(Test-OrdinalIn 3 $set)"
"OUT|unique|$((Get-OrdinalUnique @('pi', $zwj, 'pi')).Count)"
"OUT|sorted|$((Get-OrdinalSorted @('b', 'B', 'a')) -join ',')"
"OUT|sortedNames|$((Get-OrdinalSorted @('pi', $zwj)).Count)"
`);
  assert.equal(out.get('in'), 'True');
  assert.equal(out.get('inZwj'), 'False');
  assert.equal(out.get('notIn'), 'False');
  assert.equal(out.get('valueNotString'), 'False');
  assert.equal(out.get('unique'), '2', 'a zero width twin is a second name, not a repeat');
  assert.equal(out.get('sorted'), 'B,a,b', 'the sort is ordinal, so capitals come first');
  assert.equal(out.get('sortedNames'), '2');
});

test('Assert-BoundaryText refuses a format, control, or separator character with its escape, and accepts a valid pair', { skip }, () => {
  const out = runChecks(String.raw`
function Check($name, $text) { try { Assert-BoundaryText $text 'runtimes key'; "OUT|$name|accepted" } catch { "OUT|$name|$($_.Exception.Message)" } }
Check 'zwj' "pi$([char]0x200D)"
Check 'shy' "default$([char]0x00AD)"
Check 'rlo' "x$([char]0x202E)"
Check 'lineSeparator' "a$([char]0x2028)b"
Check 'bell' "a$([char]0x07)b"
Check 'loneSurrogate' "a$([char]0xD800)b"
Check 'pair' "a$([char]::ConvertFromUtf32(0x1F600))b"
Check 'plain' 'pstack'
`);
  assert.match(out.get('zwj'), /runtimes key 'pi\\u200D' holds the character \\u200D/);
  assert.match(out.get('shy'), /holds the character \\u00AD/);
  assert.match(out.get('rlo'), /holds the character \\u202E/);
  assert.match(out.get('lineSeparator'), /holds the character \\u2028/);
  assert.match(out.get('bell'), /holds the character \\u0007/);
  assert.match(out.get('loneSurrogate'), /holds the character \\uD800/);
  assert.equal(out.get('pair'), 'accepted', 'a valid surrogate pair is a character, not a fault');
  assert.equal(out.get('plain'), 'accepted');
});

test('ConvertTo-SafeName escapes each unsafe character, keeps a pair whole, and cuts a long text at 260 characters', { skip }, () => {
  const out = runChecks(String.raw`
"OUT|escaped|$(ConvertTo-SafeName "a$([char]0x202E)b$([char]0x200D)c")"
"OUT|pair|$((ConvertTo-SafeName ([char]::ConvertFromUtf32(0x1F600))).Length)"
"OUT|cut|$((ConvertTo-SafeName ('x' * 300)).Length)"
"OUT|null|$(ConvertTo-SafeName $null)"
`);
  assert.equal(out.get('escaped'), 'a\\u202Eb\\u200Dc');
  assert.equal(out.get('pair'), '2', 'a surrogate pair is kept whole: two code units, not an escape');
  assert.equal(out.get('cut'), '263', '260 characters and an ellipsis');
  assert.equal(out.get('null'), '');
});

test('ConvertTo-SafeName keeps a 240-character text whole, with no escape and no ellipsis', { skip }, () => {
  const out = runChecks(`"OUT|kept|$((ConvertTo-SafeName ('x' * 240)).Length)"`);
  assert.equal(out.get('kept'), '240');
});

test('Test-SkippedLabel names a layer by a whole path segment, or a file name that starts with it and a dash', { skip }, () => {
  const out = runChecks(String.raw`
$layers = @('pstack')
$cases = @(
  @('plugins', '.claude/plugins/pstack'),
  @('agentFile', '.opencode/agents/pstack-agent.md'),
  @('piEntry', '.pi/agent/settings.json [packages] "../../.claude/cache/pstack"'),
  @('longerWord', '.claude/plugins/xpstack'),
  @('otherLayer', '.claude/plugins/simpsonm09-org-ai-plugin'),
  @('prefixOnly', '.claude/plugins/pstackhelper')
)
foreach ($case in $cases) { "OUT|$($case[0])|$(Test-SkippedLabel -Label $case[1] -Layers $layers)" }
`);
  assert.equal(out.get('plugins'), 'True');
  assert.equal(out.get('agentFile'), 'True');
  assert.equal(out.get('piEntry'), 'True');
  assert.equal(out.get('longerWord'), 'False', 'a name inside a longer word is another layer');
  assert.equal(out.get('otherLayer'), 'False');
  assert.equal(out.get('prefixOnly'), 'False', 'a name followed by letters is another name');
});
