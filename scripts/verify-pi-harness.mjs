#!/usr/bin/env node
// Model-free smoke check for the Pi harness. It starts the stub model server, runs the workspace's Pi
// in RPC mode against a scratch agent folder, and asserts the wiring: Pi starts and exits 0, a turn
// reaches the stub, each Pi layer's skill is in the system prompt, the org gate denies a launcher call,
// the denied command does not run, and the denial reaches the model as a tool result.
//
// Usage: node scripts/verify-pi-harness.mjs [--workspace <path>]
// It writes nothing to the workspace: it reads the Pi settings and the wrapper, and its own files live
// in a scratch folder under the system temp directory, which is removed on every path.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  checkBashCallMade,
  checkChatRequest,
  checkDenialReachedModel,
  checkDeniedNotRun,
  checkGateLoaded,
  checkLayerSkill,
  checkPiExit,
  checkPlainTurn,
  checkWorkspaceUnchanged,
} from "./lib/pi-harness-checks.mjs";
import { piArgs, piEnvironment, piLaunch, runRpcSession, writeScratchAgent } from "./lib/pi-harness-session.mjs";
import {
  pickLayerSkills,
  readPiLayerNames,
  readPiSettings,
  readWrapperPiBin,
  resolveWorkspace,
  SetupError,
  snapshotTree,
  watchedFolders,
} from "./lib/pi-harness-workspace.mjs";
import { DENY_TRIGGER, startStubModelServer, STUB_MODEL_ID } from "./lib/stub-model-server.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLAIN_PROMPT = "PI_SMOKE_PLAIN check the wiring";
const DENY_PROMPT = `${DENY_TRIGGER} run the launcher call`;
const RUN_TIMEOUT_MS = 120_000;
const PROMPT_TIMEOUT_MS = 60_000;

const slash = (path) => path.replaceAll("\\", "/");

// The file the denied command would run. It is a stand-in that only writes a marker, so if the gate
// failed to deny, nothing real runs: the real launcher holds credentials and is never used here.
function launcherSource(marker) {
  return `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "ran");\n`;
}

function snapshotWatched(workspace) {
  const all = new Map();
  for (const folder of watchedFolders(workspace)) {
    for (const [path, value] of snapshotTree(folder)) all.set(path, value);
  }
  return all;
}

// How the run starts Pi: the workspace's wrapper binary with the RPC arguments, or a stand-in script
// under node when a test supplies one.
function launchFor({ standin, standinMode, platform, piBin }) {
  const args = piArgs(STUB_MODEL_ID);
  if (standin) {
    return { file: process.execPath, args: [standin, ...args, "--standin-mode", standinMode], windowsVerbatimArguments: false };
  }
  return piLaunch({ piBin, args, platform });
}

async function runChecks({ workspace, settings, skills, launch, parentEnv, scratch, stub, marker }) {
  const agentDir = writeScratchAgent({ scratch, baseUrl: stub.baseUrl, model: stub.model, settings });
  const env = piEnvironment({ scratch, agentDir, parentEnv });
  const cwd = join(scratch, "cwd");
  mkdirSync(cwd, { recursive: true });
  const before = snapshotWatched(workspace);
  const session = await runRpcSession({
    launch,
    env,
    cwd,
    prompts: [PLAIN_PROMPT, DENY_PROMPT],
    timeoutMs: RUN_TIMEOUT_MS,
    promptMs: PROMPT_TIMEOUT_MS,
  });
  const after = snapshotWatched(workspace);
  return [
    checkPiExit(session),
    checkChatRequest(stub),
    checkPlainTurn(session),
    ...skills.map((skill) => checkLayerSkill(stub, skill)),
    checkBashCallMade(session),
    checkGateLoaded(session),
    checkDenialReachedModel(stub),
    checkDeniedNotRun(marker, session),
    checkWorkspaceUnchanged(before, after),
  ];
}

// Runs the smoke check against a workspace. Returns the checks; throws SetupError when the workspace
// cannot be run at all (no Pi settings, no wrapper), which is not a check failure.
export async function runPiHarness({ workspace, parentEnv = process.env, platform = process.platform, standin, standinMode = "gate" }) {
  const layers = readPiLayerNames(repoRoot);
  const settings = readPiSettings(workspace);
  const skills = pickLayerSkills(layers, settings.skills);
  const piBin = standin ? null : readWrapperPiBin({ workspace, env: parentEnv, platform });
  const launch = launchFor({ standin, standinMode, platform, piBin });
  const scratch = mkdtempSync(join(tmpdir(), "maxstack-pi-smoke-"));
  let stub = null;
  try {
    const marker = join(scratch, "launcher-ran.marker");
    const launcher = join(scratch, "with-gh-token.mjs");
    writeFileSync(launcher, launcherSource(marker));
    stub = await startStubModelServer({ denyCommand: `node "${slash(launcher)}" smoke` });
    const checks = await runChecks({ workspace, settings, skills, launch, parentEnv, scratch, stub, marker });
    return { checks, piBin: standin ? "stand-in" : piBin };
  } finally {
    await stub?.close();
    rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
  }
}

const USAGE = "Usage: node scripts/verify-pi-harness.mjs [--workspace <path>]\n";

function parseArgs(argv) {
  const options = { workspace: undefined, help: false };
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    index += 1;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--workspace") {
      if (index >= argv.length) throw new SetupError(`--workspace needs a path\n${USAGE}`);
      options.workspace = argv[index];
      index += 1;
    } else {
      throw new SetupError(`unknown argument ${arg}\n${USAGE}`);
    }
  }
  return options;
}

function report(checks) {
  for (const result of checks) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}: ${result.detail}`);
  const failed = checks.filter((result) => !result.ok).map((result) => result.name);
  if (failed.length === 0) {
    console.log(`pi harness smoke check: PASS (${checks.length} checks)`);
    return 0;
  }
  console.log(`pi harness smoke check: FAIL: ${failed.join(", ")}`);
  return 1;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const found = resolveWorkspace({ explicit: options.workspace, env: process.env, cwd: process.cwd(), repoRoot });
  console.log(`workspace: ${found.path} (from ${found.origin})`);
  const { checks } = await runPiHarness({ workspace: found.path });
  return report(checks);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      const message = error instanceof SetupError ? error.message : error.stack;
      process.stderr.write(`pi harness smoke check could not run: ${message}\n`);
      process.exitCode = 2;
    },
  );
}
