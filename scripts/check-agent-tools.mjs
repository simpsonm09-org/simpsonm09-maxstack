#!/usr/bin/env node
// Check that the agent tool set in dev-setup-starter covers every service
// owner the org integration registry names.
//
// This is a workspace-local check, not a CI gate. It reads two sibling
// checkouts (dev-setup-starter and simpsonm09-org-ai-plugin) that CI does
// not have, so it runs from the workspace root and only when those exist.
//
//   node scripts/check-agent-tools.mjs
//   node scripts/check-agent-tools.mjs --dev-setup <path> --org-plugin <path>

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Owners that name a built-in or a path that is not an installable tool. Each
// reason is one a reviewer can check against the registry.
const EXEMPT_OWNERS = new Map([
  ['grep', 'the local grep tool is built into the agent, not installed from tools.yaml'],
]);

// Owner names in the registry that differ from the tool id in tools.yaml.
const OWNER_ALIASES = new Map([
  ['postman', 'postman-cli'],
  ['playwright/cli', 'playwright-cli'],
]);

const DEV_SETUP_REL = join('projects', 'repos', 'simpsonm09-dev-setup', 'tools.yaml');
const ORG_PLUGIN_REL = join('projects', 'repos', 'simpsonm09-org-ai-plugin', 'skills', 'service-integrations', 'SKILL.md');

function commandWord(text) {
  let token = text.trim();
  if (token.startsWith('npx ')) token = token.slice(4).trim();
  if (token.startsWith('@')) token = token.slice(1);
  return (token.split(/\s+/)[0] ?? '').toLowerCase();
}

function firstCommandWord(commandCell) {
  const ticked = commandCell.match(/`([^`]+)`/);
  return commandWord(ticked ? ticked[1] : commandCell);
}

// An owner cell that names a tool in backticks uses that token. A prose cell
// such as "the container runtime" falls back to the first command word of the row.
export function normalizeOwner(ownerCell, commandCell = '') {
  const ticked = ownerCell.match(/`([^`]+)`/);
  return ticked ? commandWord(ticked[1]) : firstCommandWord(commandCell);
}

function toolSlices(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const starts = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (/^\s*-\s+id:\s*\S+\s*$/.test(lines[index])) starts.push(index);
  }
  const slices = [];
  for (let position = 0; position < starts.length; position += 1) {
    const end = position + 1 < starts.length ? starts[position + 1] : lines.length;
    slices.push(lines.slice(starts[position], end));
  }
  return slices;
}

function agentConsumers(slice) {
  const consumersAt = slice.findIndex((line) => /^\s*consumers:\s*$/.test(line));
  if (consumersAt === -1) return false;
  const baseIndent = slice[consumersAt].match(/^\s*/)[0].length;
  for (const line of slice.slice(consumersAt + 1)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const indent = line.match(/^\s*/)[0].length;
    if (indent <= baseIndent) break;
    if (trimmed === '- agent') return true;
  }
  return false;
}

// The agent tool set is every tool id whose consumers list names agent.
export function parseAgentToolIds(yamlText) {
  const ids = new Set();
  for (const slice of toolSlices(yamlText)) {
    const id = /^\s*-\s+id:\s*(\S+)\s*$/.exec(slice[0] ?? '');
    if (id && agentConsumers(slice)) ids.add(id[1]);
  }
  return ids;
}

function splitRow(row) {
  const cells = row.split('|').map((cell) => cell.trim());
  if (cells.length > 0 && cells[0] === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

// Owners are the Owner column of the "Pick the owner" table.
export function parseOwners(skillText) {
  const lines = skillText.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Pick the owner\s*$/.test(line.trim()));
  if (start === -1) return [];
  const rows = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line.startsWith('|')) rows.push(line);
    else if (rows.length > 0) break;
  }
  const owners = [];
  for (const [index, row] of rows.entries()) {
    if (index === 0) continue;
    const cells = splitRow(row);
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    owners.push({ owner: cells[1] ?? '', command: cells[2] ?? '' });
  }
  return owners;
}

function classifyOwner(token, agentIds) {
  if (agentIds.has(token)) return { token, status: 'covered', tool: token };
  if (OWNER_ALIASES.has(token) && agentIds.has(OWNER_ALIASES.get(token))) {
    return { token, status: 'covered', tool: OWNER_ALIASES.get(token) };
  }
  if (EXEMPT_OWNERS.has(token)) return { token, status: 'exempt', reason: EXEMPT_OWNERS.get(token) };
  return { token, status: 'uncovered' };
}

export function checkAgentTools({ toolsYaml, skillText }) {
  const agentIds = parseAgentToolIds(toolsYaml);
  const results = [];
  const seen = new Set();
  for (const { owner, command } of parseOwners(skillText)) {
    const token = normalizeOwner(owner, command);
    if (token === '' || seen.has(token)) continue;
    seen.add(token);
    results.push(classifyOwner(token, agentIds));
  }
  return { agentIds, results };
}

function findWorkspaceRoot(start) {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'opencode.jsonc')) || existsSync(join(dir, '.opencode'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function parseArgs(argv) {
  const args = { devSetup: null, orgPlugin: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dev-setup' || arg === '--org-plugin') {
      index += 1;
      const value = argv[index];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      if (arg === '--dev-setup') args.devSetup = value;
      else args.orgPlugin = value;
    } else if (arg.startsWith('--dev-setup=')) {
      args.devSetup = arg.slice('--dev-setup='.length);
    } else if (arg.startsWith('--org-plugin=')) {
      args.orgPlugin = arg.slice('--org-plugin='.length);
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return args;
}

function resolveInput(input, relativeFile) {
  const absolute = resolve(input);
  if (existsSync(absolute) && statSync(absolute).isFile()) return absolute;
  return join(absolute, relativeFile);
}

function resolveInputs(args, workspaceRoot, cwd) {
  const devSetupFile = args.devSetup
    ? resolveInput(args.devSetup, 'tools.yaml')
    : workspaceRoot
      ? join(workspaceRoot, DEV_SETUP_REL)
      : null;
  const orgPluginFile = args.orgPlugin
    ? resolveInput(args.orgPlugin, join('skills', 'service-integrations', 'SKILL.md'))
    : workspaceRoot
      ? join(workspaceRoot, ORG_PLUGIN_REL)
      : null;

  const problems = [];
  if (devSetupFile === null) problems.push(`cannot find the workspace root above ${resolve(cwd)}; pass --dev-setup <path>`);
  else if (!existsSync(devSetupFile)) problems.push(`missing dev-setup tools.yaml at ${devSetupFile}`);
  if (orgPluginFile === null) problems.push(`cannot find the workspace root above ${resolve(cwd)}; pass --org-plugin <path>`);
  else if (!existsSync(orgPluginFile)) problems.push(`missing org integration registry at ${orgPluginFile}`);
  return { devSetupFile, orgPluginFile, problems };
}

function buildReport(devSetupFile, orgPluginFile, agentIds, results) {
  const uncovered = results.filter((result) => result.status === 'uncovered');
  const exempt = results.filter((result) => result.status === 'exempt');
  const aliased = results.filter((result) => result.status === 'covered' && result.tool !== result.token);

  const report = [
    'agent tool parity (workspace-local)',
    `  dev-setup: ${devSetupFile}`,
    `  org plugin: ${orgPluginFile}`,
    `  agent tools: ${agentIds.size}`,
    `  service owners: ${results.length}`,
  ];
  for (const result of aliased) report.push(`  ${result.token} -> ${result.tool}`);
  for (const result of exempt) report.push(`  ${result.token} (exempt: ${result.reason})`);
  if (uncovered.length === 0) {
    report.push(`PASS: the agent tool set covers every service owner (${exempt.length} exempt).`);
  } else {
    for (const result of uncovered) report.push(`FAIL: service owner "${result.token}" is not covered by the agent tool set`);
    report.push(`FAIL: ${uncovered.length} service owner(s) uncovered.`);
  }
  return { ok: uncovered.length === 0, report };
}

export function run(argv = process.argv.slice(2), cwd = process.cwd()) {
  const args = parseArgs(argv);
  const workspaceRoot = findWorkspaceRoot(cwd);
  const { devSetupFile, orgPluginFile, problems } = resolveInputs(args, workspaceRoot, cwd);
  if (problems.length > 0) return { ok: false, problems, report: null };

  const { agentIds, results } = checkAgentTools({
    toolsYaml: readFileSync(devSetupFile, 'utf8'),
    skillText: readFileSync(orgPluginFile, 'utf8'),
  });

  const parseProblems = [];
  if (agentIds.size === 0) parseProblems.push(`no agent tools found in ${devSetupFile}`);
  if (results.length === 0) parseProblems.push(`no service owners found in ${orgPluginFile}`);
  if (parseProblems.length > 0) return { ok: false, problems: parseProblems, report: null };

  const { ok, report } = buildReport(devSetupFile, orgPluginFile, agentIds, results);
  return { ok, problems: [], report };
}

function main() {
  const { ok, problems, report } = run();
  if (report) process.stdout.write(`${report.join('\n')}\n`);
  for (const problem of problems) process.stderr.write(`FAIL: ${problem}\n`);
  process.exit(ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
