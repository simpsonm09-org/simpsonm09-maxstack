#!/usr/bin/env node
// A stand-in for `codex app-server` for the codex-hook-trust tests. It speaks just enough JSON-RPC over stdio:
// it answers initialize, then answers hooks/list with the single hook its config overrides name. The hook's key and
// currentHash are fixed for the definition it was started with, so the script can ask for them and trust them back.
// FAKE_CODEX_MODE changes the answer: `untrusted` refuses trust even with a matching state, and `silent` never
// answers hooks/list so the caller must time out. No model is called and nothing is read from disk.

import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write('fake-codex 0.0.0\n');
  process.exit(0);
}

const configs = [];
for (let index = 0; index < args.length; index++) {
  if (args[index] === '-c') configs.push(args[index + 1]);
}
const definition = configs.find((value) => value.startsWith('hooks.PreToolUse=')) ?? '';
const state = configs.find((value) => value.startsWith('hooks.state=')) ?? '';
const command = /command\s*=\s*["']([^"']+)["']/.exec(definition)?.[1] ?? '';
const currentHash = `sha256:${createHash('sha256').update(definition).digest('hex')}`;
const key = 'C:\\<session-flags>\\config.toml:pre_tool_use:0:0';
const mode = process.env.FAKE_CODEX_MODE ?? 'normal';

// The state override is a TOML table with a literal-string key and trusted_hash. Match it only when both agree.
function statedTrusted() {
  if (mode === 'untrusted') return false;
  const statedKey = /hooks\.state\s*=\s*\{\s*'([^']*)'/.exec(state)?.[1];
  const statedHash = /trusted_hash\s*=\s*'([^']*)'/.exec(state)?.[1];
  return statedKey === key && statedHash === currentHash;
}

const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === 'initialize' && message.id !== undefined) {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { codexHome: '', platformFamily: 'windows', platformOs: 'windows', userAgent: 'fake-codex' } })}\n`);
    return;
  }
  if (message.method === 'hooks/list' && message.id !== undefined) {
    if (mode === 'silent') return;
    const cwd = message.params?.cwds?.[0] ?? '';
    const hook = { key, currentHash, trustStatus: statedTrusted() ? 'trusted' : 'untrusted', eventName: 'preToolUse', handlerType: 'command', command, matcher: 'Bash', timeoutSec: 30, source: 'sessionFlags' };
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { data: [{ cwd, hooks: [hook], warnings: [], errors: [] }] } })}\n`);
  }
});
