// The ordinal guard: finds the PowerShell comparisons in the installer scripts that PowerShell 7 makes culture-aware. A
// zero-width character, a soft hyphen, or a canonically equivalent string compares EQUAL under those operators, so a name
// can pass a check and then miss an ordinal lookup. The helpers in scripts/Install-Ordinal.ps1 are the replacement.
//
// Culture-aware forms, all flagged: the case-sensitive operators (-ceq and friends), the ignore-case operators (-ieq, -icontains,
// -iin, -ilike, -imatch, and their negations), the membership operators (-contains, -in, and their negations) with any operands,
// the plain -eq, -ne, -like, and -notlike with a quoted literal, Sort-Object and Select-Object -Unique, -CaseSensitive, and the
// string methods StartsWith, EndsWith, and IndexOf called with a single argument. A plain -eq or -ne between two variables is not
// flagged: the guard cannot tell a name from a number there, so it is a known limit, reviewed by hand.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// The most exemptions the installer scripts may carry. An exemption is for a number, a boolean, or a value that the boundary
// check has already refused if it held a format character, so a few are expected and a growing list means a comparison went
// unconverted.
export const EXEMPTION_LIMIT = 10;

const CASE_SENSITIVE = /(?<![\w-])-c(?:eq|ne|contains|notcontains|in|notin|like|notlike)\b/i;
// The plain operators are culture-aware too. Only a line with a quoted string is flagged, and not one that compares with
// $null: a comparison with $null, a number, or a boolean is not a name comparison. A comparison of two variables is reviewed
// by hand (see Install-Ordinal.ps1).
const PLAIN = /(?<![\w-])-(?:eq|ne|in|notin|contains|notcontains|like|notlike)\b/i;
const IGNORE_CASE = /(?<![\w-])-i(?:eq|ne|contains|notcontains|in|notin|like|notlike|match|notmatch)\b/i;
const MEMBERSHIP = /(?<![\w-])-(?:contains|notcontains|in|notin)\b/i;
const STRING_METHOD = /\.(StartsWith|EndsWith|IndexOf)\(/gi;
const QUOTED_OPERAND = /-(?:eq|ne|in|notin|contains|notcontains|like|notlike)\s+(?:@\(\s*)?['"]|['"]\s*\)?\s*-(?:eq|ne|in|notin|contains|notcontains|like|notlike)\b/i;
const OBJECT_UNIQUE = /\b(?:Sort-Object|Select-Object|Get-Unique)\b.*(?<![\w-])-Unique\b/i;
const CASE_SENSITIVE_SWITCH = /(?<![\w-])-CaseSensitive\b/i;
const EXEMPTION = /#\s*ordinal-ok:\s*(\S.*?)\s*$/;

const HELPER_FOR_OPERATOR = {
  ceq: 'Test-OrdinalEqual', eq: 'Test-OrdinalEqual',
  cne: '-not Test-OrdinalEqual', ne: '-not Test-OrdinalEqual',
  ccontains: 'Test-OrdinalIn (value first)', contains: 'Test-OrdinalIn (value first)',
  cnotcontains: '-not Test-OrdinalIn (value first)', notcontains: '-not Test-OrdinalIn (value first)',
  cin: 'Test-OrdinalIn', in: 'Test-OrdinalIn',
  cnotin: '-not Test-OrdinalIn', notin: '-not Test-OrdinalIn',
  clike: 'Test-OrdinalEqual, or a [string]::Equals check', like: 'Test-OrdinalEqual, or a [string]::Equals check',
  cnotlike: '-not Test-OrdinalEqual, or a [string]::Equals check', notlike: '-not Test-OrdinalEqual, or a [string]::Equals check',
};

// The code of one line, without a trailing comment. A '#' inside a quoted string does not start a comment.
export function codePart(line) {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote) {
      if (character === quote) quote = null;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (character === '#') {
      return line.slice(0, index);
    }
  }
  return line;
}

function operatorOf(code) {
  const match = CASE_SENSITIVE.exec(code) ?? PLAIN.exec(code);
  return match ? match[0].toLowerCase() : null;
}

// Whether the argument list that opens at openIndex holds exactly one argument. Parentheses, brackets, and quoted text are
// skipped, so a comma inside a nested call or a string does not count. An unclosed list is not judged, so it is not flagged.
export function hasSingleArgument(code, openIndex) {
  let depth = 0;
  let sawComma = false;
  let index = openIndex + 1;
  while (index < code.length) {
    const character = code[index];
    if (character === "'" || character === '"') {
      index = quotedEnd(code, index);
    } else if (OPENERS.includes(character)) {
      depth += 1;
    } else if (CLOSERS.includes(character)) {
      if (depth === 0) return character === ')' && !sawComma;
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      sawComma = true;
    }
    index += 1;
  }
  return false;
}

const OPENERS = '([{';
const CLOSERS = ')]}';

// The index of the quote that closes the quoted run opened at index, or the end of the code when it never closes.
function quotedEnd(code, index) {
  const close = code.indexOf(code[index], index + 1);
  return close === -1 ? code.length : close;
}

// The string method, called with one argument, that the line holds, or null. The ordinal overload takes two arguments.
function singleArgumentMethod(code) {
  for (const match of code.matchAll(STRING_METHOD)) {
    const openIndex = match.index + match[0].length - 1;
    if (hasSingleArgument(code, openIndex)) return match[1];
  }
  return null;
}

// The violation a line carries, or null. A line whose only comparison has an ordinal-ok exemption is still a violation here:
// scanText applies the exemption.
export function lineViolation(line) {
  const code = codePart(line);
  if (code.trim() === '') return null;
  const operator = operatorOf(code);
  const quotedName = QUOTED_OPERAND.test(code);
  if (operator && (CASE_SENSITIVE.test(code) || quotedName)) {
    return { operator, helper: HELPER_FOR_OPERATOR[operator.slice(1)] ?? 'Test-OrdinalEqual' };
  }
  const ignoreCase = IGNORE_CASE.exec(code);
  if (ignoreCase) {
    const helper = /-i(?:in|notin|contains|notcontains)\b/i.test(ignoreCase[0]) ? 'Test-OrdinalIn (value first)' : 'Test-OrdinalEqualIgnoreCase';
    return { operator: ignoreCase[0].toLowerCase(), helper };
  }
  const membership = MEMBERSHIP.exec(code);
  if (membership) return { operator: membership[0].toLowerCase(), helper: 'Test-OrdinalIn (value first)' };
  const method = singleArgumentMethod(code);
  if (method) {
    return { operator: `.${method}(one argument)`, helper: `the ordinal overload, .${method}(<value>, [StringComparison]::Ordinal)` };
  }
  if (OBJECT_UNIQUE.test(code)) return { operator: 'Sort-Object or Select-Object -Unique', helper: 'Get-OrdinalUnique and Get-OrdinalSorted' };
  if (CASE_SENSITIVE_SWITCH.test(code)) return { operator: '-CaseSensitive', helper: 'Get-OrdinalSorted or Test-OrdinalEqual' };
  return null;
}

// Scans one file's text. Returns { violations, exemptions, malformed }: a violation names the line, the operator, and the helper;
// an exemption is an ordinal-ok comment with a reason; a malformed exemption is an ordinal-ok comment on a line with no violation.
export function scanText(text, file) {
  const violations = [];
  const exemptions = [];
  const malformed = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const number = index + 1;
    const comment = EXEMPTION.exec(line);
    const violation = lineViolation(line);
    if (violation) {
      if (comment) {
        exemptions.push({ file, line: number, reason: comment[1] });
      } else {
        violations.push({ file, line: number, ...violation, text: line.trim() });
      }
    } else if (/#\s*ordinal-ok:/.test(line) && codePart(line).trim() !== '') {
      malformed.push({ file, line: number, text: line.trim() });
    }
  });
  return { violations, exemptions, malformed };
}

// The installer scripts the guard covers: scripts/Install-*.ps1.
// Every PowerShell script in scripts/, so a culture-aware comparison in any of them is found.
export function installerScripts(scriptsDir) {
  return readdirSync(scriptsDir).filter((name) => name.endsWith('.ps1')).sort().map((name) => join(scriptsDir, name));
}

// Scans every installer script under scriptsDir.
export function scanInstallers(scriptsDir) {
  const result = { violations: [], exemptions: [], malformed: [], files: [] };
  for (const path of installerScripts(scriptsDir)) {
    const file = path.split(/[\\/]/).pop();
    result.files.push(file);
    const scanned = scanText(readFileSync(path, 'utf8'), file);
    result.violations.push(...scanned.violations);
    result.exemptions.push(...scanned.exemptions);
    result.malformed.push(...scanned.malformed);
  }
  return result;
}

// The one message a violation prints: where it is, what it uses, and the helper to use instead.
export function describeViolation(violation) {
  return `${violation.file}:${violation.line}: ${violation.operator} is culture-aware; use ${violation.helper} from scripts/Install-Ordinal.ps1 (or ` +
    `add "# ordinal-ok: <reason>" only for numbers, booleans, or values the boundary check proved ASCII): ${violation.text}`;
}
