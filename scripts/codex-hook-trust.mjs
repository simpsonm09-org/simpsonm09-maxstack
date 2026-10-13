#!/usr/bin/env node
// The Codex gate launch line. A layer that ships a Codex PreToolUse hook gets it turned on through the T3
// "Codex (maxstack)" instance Launch arguments. Codex runs a hook only when it trusts it, so the line carries
// two config overrides: the hook definition, and the hooks.state entry that marks it trusted. The key and hash
// in that entry come from Codex itself, read here from `codex app-server` with `hooks/list`. No model is called
// and no account is needed: the run uses an empty temporary CODEX_HOME, so no login and no user config is read.
//
// The pure parts (the override text, the T3 argument tokenizer, and picking the hook out of a hooks/list answer)
// are exported so they are testable without Codex.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// The override that makes the workspace the project root, so Codex sees the workspace skills and AGENTS.md.
export const MARKER_OVERRIDE = 'project_root_markers=["stack.lock.json"]';

// The hook timeout in the definition, in seconds, and the default wait for an app-server answer, in milliseconds.
export const HOOK_TIMEOUT_SECONDS = 30;
export const DEFAULT_WAIT_MS = 30000;

// The JSON-RPC ids this script sends: initialize, then the hooks/list request.
const INITIALIZE_ID = 1;
const HOOKS_LIST_ID = 2;

// A Windows path with forward slashes, so the TOML command string needs no escaping inside the launch token.
export function toForwardSlashes(path) {
  return path.replaceAll('\\', '/');
}

// A space or a single quote in the path cannot be carried by the T3 argument text, so the line is refused there.
export function assertHookPath(hookPath) {
  if (typeof hookPath !== 'string' || hookPath.length === 0) throw new Error('the hook path is empty');
  if (hookPath.includes(' ')) throw new Error('the hook path holds a space, so the launch line cannot be generated');
  if (hookPath.includes("'")) throw new Error('the hook path holds a single quote, so the launch line cannot be generated');
}

// The hook definition override as it appears in the launch line. Double quotes keep the value valid inside the
// single-quoted launch token that T3 splits.
export function hookDefinitionOverride(hookPath) {
  const command = `node ${toForwardSlashes(hookPath)} codex`;
  return `hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command="${command}",timeout=${HOOK_TIMEOUT_SECONDS}}]}]`;
}

// The same definition in TOML literal strings. This form has no double quote, so it survives the Windows command
// shell while the trust probe runs. Codex hashes the parsed definition, not the text, so both forms hash alike.
export function hookDefinitionOverrideForProbe(hookPath) {
  const command = `node ${toForwardSlashes(hookPath)} codex`;
  return `hooks.PreToolUse=[{matcher='Bash',hooks=[{type='command',command='${command}',timeout=${HOOK_TIMEOUT_SECONDS}}]}]`;
}

// The state override as it appears in the launch line: the key is a TOML basic string, so each backslash doubles.
export function stateOverride(key, hash) {
  return `hooks.state={ "${key.replaceAll('\\', '\\\\')}" = { trusted_hash = "${hash}" } }`;
}

// The same state in TOML literal strings, for the probe. The key's backslashes stay single, as literal strings keep them.
export function stateOverrideForProbe(key, hash) {
  return `hooks.state={ '${key}' = { trusted_hash = '${hash}' } }`;
}

// The full Launch arguments text: the marker, the hook definition, and the trusted state, joined by spaces.
export function launchArguments(hookPath, key, hash) {
  return [
    `-c '${MARKER_OVERRIDE}'`,
    `-c '${hookDefinitionOverride(hookPath)}'`,
    `-c '${stateOverride(key, hash)}'`,
  ].join(' ');
}

// The T3 argument splitter: single quotes group, whitespace outside them separates, and a backslash is kept as it is.
export function tokenizeLaunchArgs(text) {
  const tokens = [];
  let current = '';
  let started = false;
  let quoted = false;
  for (const character of text) {
    if (character === "'") {
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(character)) {
      if (started) {
        tokens.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += character;
    started = true;
  }
  if (started) tokens.push(current);
  return tokens;
}

// The hook the answer lists for this definition, or null. The answer is a hooks/list result: data[] holds one entry
// per cwd, and each entry holds the hooks it found.
export function pickHook(answer, hookPath) {
  const entries = answer?.result?.data ?? answer?.data ?? [];
  const expected = `node ${toForwardSlashes(hookPath)} codex`;
  for (const entry of entries) {
    for (const hook of entry?.hooks ?? []) {
      if (hook?.command === expected) return hook;
    }
  }
  return null;
}

// The status Codex reports for a hook it trusts. Anything else means Codex would skip the hook.
export function assertTrusted(hook) {
  const status = hook?.trustStatus;
  if (status !== 'trusted') throw new Error(`codex reports the hook as ${status ?? 'missing'}, not trusted`);
}

// The file a Windows command names: a bare name is looked up on PATH, a path is used as it is.
function resolveCommand(command) {
  if (process.platform !== 'win32') return { file: command, shim: false };
  const shim = /\.(cmd|bat)$/i.test(command);
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) return { file: command, shim };
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  for (const extension of ['.exe', '.cmd', '.bat', '.com', '']) {
    for (const dir of dirs) {
      const candidate = join(dir, command + extension);
      if (existsSync(candidate)) return { file: candidate, shim: /\.(cmd|bat)$/i.test(candidate) };
    }
  }
  return { file: command, shim: false };
}

// One argument of a Windows command line, wrapped so the shell keeps a space, a bracket, or an angle bracket.
function quoteForCommandShell(argument) {
  return `"${argument.replaceAll('"', '\\"')}"`;
}

// Starts the app-server. A Windows .cmd shim cannot be spawned directly, so it runs through the command shell with
// the arguments pre-quoted; every other executable is spawned as it is.
function startAppServer(command, args, options) {
  const { file, shim } = resolveCommand(command);
  if (process.platform === 'win32' && shim) {
    const line = `"${[file, ...args].map(quoteForCommandShell).join(' ')}"`;
    return spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', line], { ...options, windowsHide: true, windowsVerbatimArguments: true });
  }
  return spawn(file, args, { ...options, windowsHide: true });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Ends the app-server by closing its stdin, which makes it exit, then kills it only if it does not stop.
async function stopAppServer(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    child.stdin.end();
  } catch {
    // The child already closed its stdin.
  }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // The child already exited.
      }
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

// Removes a temporary folder, retrying while a just-exited Codex child still holds a handle.
async function removeTempDir(dir) {
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await delay(200);
    }
  }
}

// Reads one JSON-RPC line, or null when the line is not JSON.
function parseMessage(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

// Splits a growing stdout buffer into whole lines, keeping the trailing partial line on the state.
function takeLines(state, chunk, onLine) {
  state.buffer += chunk.toString();
  const lines = state.buffer.split('\n');
  state.buffer = lines.pop() ?? '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) onLine(trimmed);
  }
}

// The two requests the hooks/list answer needs: the initialized notification, then the request.
function writeRequests(child, workspace) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`);
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: HOOKS_LIST_ID, method: 'hooks/list', params: { cwds: [toForwardSlashes(workspace)] } })}\n`,
  );
}

// One app-server run: initialize, then hooks/list for the workspace, and the answer. Always stops the child it started.
async function queryHooks({ command, workspace, configs, waitMs, home }) {
  const args = ['app-server', ...configs.flatMap((config) => ['-c', config])];
  const child = startAppServer(command, args, {
    cwd: workspace,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, CODEX_HOME: home },
  });
  const state = { buffer: '' };
  let failure = null;
  let answer = null;
  await new Promise((resolve) => {
    let done = false;
    let timer;
    const settle = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(settle, waitMs);
    child.stdout.on('data', (chunk) => {
      takeLines(state, chunk, (line) => {
        const message = parseMessage(line);
        if (message?.id === HOOKS_LIST_ID) {
          answer = message;
          settle();
        } else if (message?.id === INITIALIZE_ID) {
          writeRequests(child, workspace);
        }
      });
    });
    child.on('error', (error) => {
      failure = error;
      settle();
    });
    child.on('exit', settle);
    try {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: INITIALIZE_ID, method: 'initialize', params: { clientInfo: { name: 'maxstack-codex-hook-trust', version: '1.0.0' } } })}\n`,
      );
    } catch (error) {
      failure = error;
      settle();
    }
  });
  await stopAppServer(child);
  return { answer, failure };
}

// The reason a spawn failed, as one line.
function describeFailure(error, command) {
  if (error?.code === 'ENOENT') return `the codex command was not found: ${command}`;
  return error?.message ?? String(error);
}

// Reads the hook's key and hash, then confirms Codex reports the hook trusted with a matching state override.
async function generateLaunchLine({ workspace, hook, command, waitMs }) {
  const home = mkdtempSync(join(tmpdir(), 'maxstack-codex-home-'));
  try {
    const probeHook = hookDefinitionOverrideForProbe(hook);
    const first = await queryHooks({ command, workspace, configs: [MARKER_OVERRIDE, probeHook], waitMs, home });
    if (first.failure) throw new Error(describeFailure(first.failure, command));
    if (!first.answer) throw new Error(`codex did not answer within ${waitMs} ms`);
    if (first.answer.error) throw new Error(`codex returned an error: ${first.answer.error.message}`);
    const listed = pickHook(first.answer, hook);
    if (!listed) throw new Error('codex listed no hook for this definition');
    if (!listed.key) throw new Error('codex listed the hook without a key');
    if (!listed.currentHash) throw new Error('codex listed the hook without a hash');

    const probeState = stateOverrideForProbe(listed.key, listed.currentHash);
    const second = await queryHooks({ command, workspace, configs: [MARKER_OVERRIDE, probeHook, probeState], waitMs, home });
    if (second.failure) throw new Error(describeFailure(second.failure, command));
    if (!second.answer) throw new Error(`codex did not answer within ${waitMs} ms`);
    if (second.answer.error) throw new Error(`codex returned an error: ${second.answer.error.message}`);
    assertTrusted(pickHook(second.answer, hook));

    return { launchArguments: launchArguments(hook, listed.key, listed.currentHash), key: listed.key, hash: listed.currentHash, trustStatus: 'trusted' };
  } finally {
    await removeTempDir(home);
  }
}

export function parseArgs(argv) {
  const options = { workspace: null, hook: null, command: 'codex', waitMs: DEFAULT_WAIT_MS };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--workspace') options.workspace = argv[++index];
    else if (argument === '--hook') options.hook = argv[++index];
    else if (argument === '--codex') options.command = argv[++index];
    else if (argument === '--timeout-ms') options.waitMs = Number(argv[++index]);
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (!options.workspace) throw new Error('--workspace is required');
  if (!options.hook) throw new Error('--hook is required');
  if (!Number.isFinite(options.waitMs) || options.waitMs <= 0) throw new Error('--timeout-ms must be a positive number');
  return options;
}

async function main(argv) {
  const options = parseArgs(argv);
  assertHookPath(options.hook);
  if (!existsSync(options.workspace)) throw new Error(`the workspace folder does not exist: ${options.workspace}`);
  if (!existsSync(options.hook)) throw new Error(`the hook file does not exist: ${options.hook}`);
  const result = await generateLaunchLine(options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return 0;
}

// Runs only when this file is the entry point, so the tests can import the pure functions.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`${(error?.message ?? String(error)).replaceAll('\n', ' ')}\n`);
      process.exitCode = 1;
    },
  );
}
