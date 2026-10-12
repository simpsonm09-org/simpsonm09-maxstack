// Tests the Pi smoke check without a model and without a Pi install: the stub server's shapes and
// shutdown, the workspace and session helpers, and the verifier run against the stand-in CLI in
// scripts/fixtures. The real Pi run is a local check, not part of this file.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkDeniedNotRun,
  GATE_DENIAL_PREFIX,
  skillsInSystemPrompt,
} from "./lib/pi-harness-checks.mjs";
import { piEnvironment, piLaunch } from "./lib/pi-harness-session.mjs";
import {
  pickLayerSkills,
  readPiSettings,
  readWrapperPiBin,
  resolveWorkspace,
  SetupError,
  snapshotTree,
} from "./lib/pi-harness-workspace.mjs";
import { decideReply, PLAIN_TEXT, startStubModelServer } from "./lib/stub-model-server.mjs";
import { runPiHarness } from "./verify-pi-harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const standin = join(here, "fixtures", "pi-standin.mjs");
const verifier = join(here, "verify-pi-harness.mjs");
const LAYERS = {
  pstack: "poteto-mode",
  "simpsonm09-org-ai-plugin": "repo-standard",
  "simpsonm09-personal-ai-plugin": "dev-tools",
};

const temps = [];
function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

// A workspace with each Pi layer's skill installed and listed in its Pi settings. omitLayer leaves
// that layer's skills folder out of the settings, so its check must fail.
function makeWorkspace({ omitLayer } = {}) {
  const root = tempDir("pi-smoke-ws-");
  const skillDirs = [];
  for (const [layer, skill] of Object.entries(LAYERS)) {
    const dir = join(root, ".claude", "plugins", layer, "skills", skill);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${skill}\ndescription: Fixture skill for ${layer}.\n---\n\nBody.\n`);
    if (layer !== omitLayer) skillDirs.push(`../../.claude/plugins/${layer}/skills`);
  }
  mkdirSync(join(root, ".pi", "agent"), { recursive: true });
  writeFileSync(join(root, ".pi", "agent", "settings.json"), JSON.stringify({ packages: [], skills: skillDirs }, null, 2));
  return root;
}

async function postChat(baseUrl, body) {
  return fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("the stub binds to loopback on an ephemeral port and lists its model", async () => {
  const stub = await startStubModelServer();
  try {
    assert.match(stub.baseUrl, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    assert.notEqual(stub.port, 0);
    const models = await (await fetch(`${stub.baseUrl}/models`)).json();
    assert.equal(models.object, "list");
    assert.equal(models.data[0].id, stub.model);
    assert.equal(stub.requests[0].path, "/v1/models");
  } finally {
    await stub.close();
  }
});

test("the stub answers a plain chat request as JSON when streaming is off", async () => {
  const stub = await startStubModelServer();
  try {
    const reply = await postChat(stub.baseUrl, { messages: [{ role: "user", content: "hello" }] });
    const body = await reply.json();
    assert.equal(body.choices[0].message.content, PLAIN_TEXT);
    assert.equal(body.choices[0].finish_reason, "stop");
    assert.equal(stub.requests.at(-1).path, "/v1/chat/completions");
  } finally {
    await stub.close();
  }
});

test("the stub streams a reply as server-sent events ending in DONE", async () => {
  const stub = await startStubModelServer();
  try {
    const reply = await postChat(stub.baseUrl, { stream: true, messages: [{ role: "user", content: "hello" }] });
    assert.match(reply.headers.get("content-type"), /text\/event-stream/);
    const text = await reply.text();
    assert.ok(text.includes(`"content":"${PLAIN_TEXT}"`));
    assert.ok(text.endsWith("data: [DONE]\n\n"));
  } finally {
    await stub.close();
  }
});

test("the stub asks for the denied command once, then answers after the tool result", () => {
  const denyCommand = 'node "launcher.mjs" smoke';
  const first = decideReply({ messages: [{ role: "user", content: "PI_SMOKE_DENY go" }], tools: [{ function: { name: "bash", parameters: { required: ["command"] } } }] }, { denyCommand });
  assert.deepEqual(first.call, { name: "bash", args: { command: denyCommand } });
  const second = decideReply({ messages: [{ role: "user", content: "PI_SMOKE_DENY go" }, { role: "tool", content: "x" }] }, { denyCommand });
  assert.equal(second.text, "PI_SMOKE_AFTER_TOOL");
});

test("the stub refuses a denied-command request when Pi advertises no bash tool", () => {
  const reply = decideReply({ messages: [{ role: "user", content: "PI_SMOKE_DENY go" }], tools: [] }, { denyCommand: "x" });
  assert.equal(reply.text, "PI_SMOKE_NO_BASH_TOOL");
});

test("the stub returns 404 for another path and 400 for a body that is not JSON", async () => {
  const stub = await startStubModelServer();
  try {
    assert.equal((await fetch(`${stub.baseUrl}/other`)).status, 404);
    const bad = await fetch(`${stub.baseUrl}/chat/completions`, { method: "POST", body: "{not json" });
    assert.equal(bad.status, 400);
  } finally {
    await stub.close();
  }
});

test("close() stops the stub, so a later request is refused", async () => {
  const stub = await startStubModelServer();
  await stub.close();
  await assert.rejects(fetch(`${stub.baseUrl}/models`));
});

test("the skill list in a system prompt yields each name and its location", () => {
  const prompt = "<available_skills>\n  <skill>\n    <name>dev-tools</name>\n    <location>C:\\fixture\\plugins\\pers\\skills\\dev-tools\\SKILL.md</location>\n  </skill>\n</available_skills>";
  assert.deepEqual(skillsInSystemPrompt(prompt), [{ name: "dev-tools", location: "C:/fixture/plugins/pers/skills/dev-tools/SKILL.md" }]);
});

test("the denied-command check fails when Pi made no bash call, so nothing was tested", () => {
  const check = checkDeniedNotRun(join(tempDir("pi-marker-"), "absent.marker"), { events: [] });
  assert.equal(check.ok, false);
  assert.match(check.detail, /no bash call/);
});

test("the workspace is the explicit path, then MAXSTACK_WORKSPACE, then a marker, then the layout", () => {
  const marked = tempDir("pi-marked-");
  writeFileSync(join(marked, "stack.lock.json"), "{}");
  const inner = join(marked, "a", "b");
  mkdirSync(inner, { recursive: true });
  const explicit = resolveWorkspace({ explicit: "explicit-ws", env: { MAXSTACK_WORKSPACE: "env-ws" }, cwd: inner, repoRoot });
  assert.equal(explicit.origin, "--workspace");
  const fromEnv = resolveWorkspace({ env: { MAXSTACK_WORKSPACE: "env-ws" }, cwd: inner, repoRoot });
  assert.equal(fromEnv.origin, "MAXSTACK_WORKSPACE");
  const fromMarker = resolveWorkspace({ env: {}, cwd: inner, repoRoot });
  assert.equal(fromMarker.path, marked);
  const lonely = tempDir("pi-lonely-");
  assert.throws(() => resolveWorkspace({ env: {}, cwd: lonely, repoRoot: lonely }), SetupError);
});

test("a skill is picked per layer from its settings folder, and a missing layer is named", () => {
  const ws = makeWorkspace({ omitLayer: "simpsonm09-personal-ai-plugin" });
  const settings = readPiSettings(ws);
  const picked = pickLayerSkills(Object.keys(LAYERS), settings.skills);
  assert.equal(picked[0].name, "poteto-mode");
  assert.equal(picked[0].layerPath, "plugins/pstack/skills/poteto-mode/SKILL.md");
  assert.match(picked[2].error, /no skills folder for simpsonm09-personal-ai-plugin/);
});

test("the Pi binary is read from the wrapper, and MAXSTACK_PI_BIN wins as the wrapper does", () => {
  const ws = tempDir("pi-wrapper-");
  mkdirSync(join(ws, ".maxstack", "bin"), { recursive: true });
  writeFileSync(
    join(ws, ".maxstack", "bin", "pi.cmd"),
    'set "PI_CODING_AGENT_DIR=X"\r\nset "PI_BIN=C:\\pi\\pi.cmd"\r\nif defined MAXSTACK_PI_BIN set "PI_BIN=%MAXSTACK_PI_BIN%"\r\n',
  );
  assert.equal(readWrapperPiBin({ workspace: ws, env: {}, platform: "win32" }), "C:\\pi\\pi.cmd");
  assert.equal(readWrapperPiBin({ workspace: ws, env: { MAXSTACK_PI_BIN: "E:\\other.cmd" }, platform: "win32" }), "E:\\other.cmd");
  assert.throws(() => readWrapperPiBin({ workspace: tempDir("pi-nowrap-"), env: {}, platform: "win32" }), /wrapper .* is missing/);
});

test("the snapshot skips the auth file and links, so no credential is stat-ed", () => {
  const root = tempDir("pi-snap-");
  writeFileSync(join(root, "auth.json"), "{}");
  writeFileSync(join(root, "models.json"), "{}");
  const names = [...snapshotTree(root).keys()].map((path) => path.split("/").pop());
  assert.deepEqual(names, ["models.json"]);
});

test("the Pi environment keeps only what Pi needs and points the agent at the scratch folder", () => {
  const scratch = tempDir("pi-env-");
  const env = piEnvironment({
    scratch,
    agentDir: join(scratch, "agent"),
    parentEnv: { PATH: "/bin", SystemRoot: "C:\\Windows", OPENAI_API_KEY: "must-not-pass", GH_TOKEN: "nope" },
  });
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.PATH, "/bin");
  assert.equal(env.AGENT_ACCESS_PI_ASK, "allow");
  assert.equal(env.PI_CODING_AGENT_DIR, join(scratch, "agent"));
  assert.equal(env.USERPROFILE, join(scratch, "home"));
});

test("a Windows .cmd shim runs through cmd.exe, and an argument that needs quoting is refused", () => {
  const launch = piLaunch({ piBin: "C:/pi/pi.cmd", args: ["--mode", "rpc"], platform: "win32" });
  assert.equal(launch.file, "cmd.exe");
  assert.deepEqual(launch.args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(launch.windowsVerbatimArguments, true);
  assert.deepEqual(piLaunch({ piBin: "/usr/bin/pi", args: ["--mode"], platform: "linux" }), {
    file: "/usr/bin/pi",
    args: ["--mode"],
    windowsVerbatimArguments: false,
  });
  assert.throws(() => piLaunch({ piBin: "pi", args: ["two words"], platform: "linux" }), /needs quoting/);
});

test("the verifier passes every check when the wiring is right", async () => {
  const { checks } = await runPiHarness({ workspace: makeWorkspace(), standin, standinMode: "gate" });
  const failed = checks.filter((check) => !check.ok).map((check) => `${check.name}: ${check.detail}`);
  assert.deepEqual(failed, []);
  assert.ok(checks.some((check) => check.name === "gate-extension-loaded" && check.detail.startsWith(GATE_DENIAL_PREFIX)));
});

test("the verifier fails closed when the stand-in runs the denied command", async () => {
  const { checks } = await runPiHarness({ workspace: makeWorkspace(), standin, standinMode: "no-gate" });
  const byName = Object.fromEntries(checks.map((check) => [check.name, check.ok]));
  assert.equal(byName["denied-command-did-not-run"], false);
  assert.equal(byName["gate-extension-loaded"], false);
  assert.equal(byName["denial-reached-model"], false);
});

test("the verifier fails when Pi does not start", async () => {
  const { checks } = await runPiHarness({ workspace: makeWorkspace(), standin, standinMode: "fail-start" });
  assert.equal(checks.find((check) => check.name === "pi-started-and-exited-0").ok, false);
  assert.equal(checks.find((check) => check.name === "stub-received-chat-request").ok, false);
});

test("the verifier names the layer whose skill is missing from the settings", async () => {
  const { checks } = await runPiHarness({
    workspace: makeWorkspace({ omitLayer: "simpsonm09-personal-ai-plugin" }),
    standin,
    standinMode: "gate",
  });
  const failed = checks.filter((check) => !check.ok).map((check) => check.name);
  assert.deepEqual(failed, ["skill-simpsonm09-personal-ai-plugin-in-system-prompt"]);
});

test("a workspace with no Pi settings is a setup error, not a check failure", async () => {
  await assert.rejects(runPiHarness({ workspace: tempDir("pi-empty-"), standin, standinMode: "gate" }), SetupError);
});

test("the command line exits 2 with the reason when the workspace cannot be run", () => {
  const result = spawnSync(process.execPath, [verifier, "--workspace", tempDir("pi-cli-empty-")], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Pi settings is missing/);
});
