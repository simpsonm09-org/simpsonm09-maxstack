#!/usr/bin/env node
// The ordinal guard. PowerShell 7's case-sensitive and plain comparison operators, Sort-Object -Unique, and Select-Object
// -Unique are culture-aware, so a zero-width or soft-hyphen name compares equal to its plain text. Every installer script
// must use the ordinal helpers in scripts/Install-Ordinal.ps1 instead. The scanner is scripts/lib/ordinal-guard.mjs.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { describeViolation, EXEMPTION_LIMIT, lineViolation, scanInstallers, scanText } from './lib/ordinal-guard.mjs';

const scriptsDir = dirname(fileURLToPath(import.meta.url));

test('the ordinal guard scans every PowerShell script in scripts/, including the ordinal helpers', () => {
  const { files } = scanInstallers(scriptsDir);
  const onDisk = readdirSync(scriptsDir).filter((name) => name.endsWith('.ps1')).sort();
  assert.deepEqual([...files].sort(), onDisk, 'the scan does not cover every script/*.ps1');
  for (const name of ['Install-Workspace.ps1', 'Install-Settings.ps1', 'Install-LayerSources.ps1', 'Install-WorkspaceDiscovery.ps1', 'Install-Cursor.ps1', 'Install-Ordinal.ps1']) {
    assert.ok(files.includes(name), `${name} is not scanned`);
  }
});

test('no installer script uses a culture-aware comparison, and each names the helper to use', () => {
  const { violations } = scanInstallers(scriptsDir);
  assert.deepEqual(violations.map(describeViolation), [], 'a culture-aware comparison is in an installer script');
});

test('each ordinal-ok exemption carries a reason, and the installer scripts keep them few', () => {
  const { exemptions, malformed } = scanInstallers(scriptsDir);
  assert.deepEqual(malformed.map((item) => `${item.file}:${item.line}: ordinal-ok on a line with no culture-aware comparison`), []);
  for (const exemption of exemptions) {
    assert.ok(exemption.reason.trim().length >= 8, `${exemption.file}:${exemption.line} gives no reason`);
  }
  assert.ok(exemptions.length <= EXEMPTION_LIMIT, `${exemptions.length} ordinal-ok exemptions; the limit is ${EXEMPTION_LIMIT}`);
});

test('the guard flags every culture-aware form, and passes the ordinal and non-string forms', () => {
  const flagged = [
    ["if ($a -ceq 'x') {}", '-ceq'],
    ['$a -cne $b', '-cne'],
    ['$names -ccontains $name', '-ccontains'],
    ['$name -cnotcontains $other', '-cnotcontains'],
    ['$name -cin $names', '-cin'],
    ['$name -cnotin $names', '-cnotin'],
    ["$name -clike 'pi*'", '-clike'],
    ["$name -cnotlike 'pi*'", '-cnotlike'],
    ["$kind -eq 'git'", '-eq'],
    ["$name -in @('pi', 'claude')", '-in'],
    ["$runtimes -notcontains 'pi'", '-notcontains'],
    ['@($list | Sort-Object -Unique)', 'sort-object'],
    ['@($list | Select-Object -Unique)', 'select-object'],
    ['$list | Sort-Object -CaseSensitive', '-casesensitive'],
  ];
  for (const [line, operator] of flagged) {
    const violation = lineViolation(line);
    assert.ok(violation, `not flagged: ${line}`);
    assert.ok(violation.operator.toLowerCase().includes(operator.toLowerCase()), `operator of ${line} is ${violation.operator}`);
  }
  const passed = [
    '$name -cmatch "^pi$"',
    '$code -eq 0',
    '$flag -eq $true',
    '$value -eq $null',
    '$value -ne $null',
    '# $name -ceq "pi"',
    '  # plain comment with -ceq',
    '$keyword = "a#b" + $name',
    '',
  ];
  for (const line of passed) {
    assert.equal(lineViolation(line), null, `flagged but should pass: ${line}`);
  }
});

test('an ordinal-ok comment exempts its line, and one without a reason is malformed', () => {
  const exempt = scanText("$code -ceq 1 # ordinal-ok: a process exit code is a number\n", 'x.ps1');
  assert.equal(exempt.violations.length, 0);
  assert.equal(exempt.exemptions.length, 1);
  const empty = scanText("$code -ceq 1 # ordinal-ok:\n", 'x.ps1');
  assert.equal(empty.violations.length, 1, 'an exemption with no reason still leaves the comparison flagged');
  const stray = scanText("$x = 1 # ordinal-ok: nothing to exempt\n", 'x.ps1');
  assert.equal(stray.malformed.length, 1);
});

test('a violation message names the file and line, the operator, and the helper to use', () => {
  const { violations } = scanText("$a = 1\n$names -cnotcontains $name\n", 'Install-Settings.ps1');
  assert.equal(violations.length, 1);
  const message = describeViolation(violations[0]);
  assert.match(message, /^Install-Settings\.ps1:2: -cnotcontains is culture-aware; use -not Test-OrdinalIn \(value first\) from scripts\/Install-Ordinal\.ps1/);
});

test('the guard flags the ignore-case operators with any operands, since they compare culture-aware', () => {
  for (const line of ['if ($a -ieq $b) {}', '$x = $a -ine $b', '$n -icontains $name', '$n -inotcontains $name', '$v -iin $list', '$v -inotin $list', '$v -ilike $pattern', '$v -imatch $pattern']) {
    assert.ok(lineViolation(line), `not flagged: ${line}`);
  }
});

test('the guard flags the membership operators with any operands, not only literals', () => {
  for (const line of ['$names -contains $name', '$name -in $names', '$names -notcontains $name', '$name -notin $names']) {
    assert.ok(lineViolation(line), `not flagged: ${line}`);
  }
});

test('the guard flags StartsWith, EndsWith, and IndexOf with one argument, and passes the ordinal overloads', () => {
  for (const line of ["$s.StartsWith('pi')", '$s.EndsWith($suffix)', '$s.IndexOf($needle)', "$s.IndexOf('x')", '$s.StartsWith(("a" + $b))']) {
    assert.ok(lineViolation(line), `not flagged: ${line}`);
  }
  for (const line of ["$s.StartsWith('pi', [StringComparison]::Ordinal)", '$s.EndsWith($suffix, [StringComparison]::OrdinalIgnoreCase)', '$s.IndexOf($needle, [StringComparison]::Ordinal)', '$s.Contains($needle)', '$s.Replace($a, $b)']) {
    assert.equal(lineViolation(line), null, `flagged but should pass: ${line}`);
  }
});

test('plain -eq and -ne between two variables are not flagged, a known limit of the guard', () => {
  for (const line of ['if ($a -eq $b) {}', '$x = $a -ne $b', '$f -eq $g.Name']) {
    assert.equal(lineViolation(line), null, `flagged: ${line}`);
  }
});
