// Runs Pi in RPC mode, the mode T3 uses, against a scratch agent folder and the stub server. The
// scratch folder holds the stub's provider, the workspace's Pi layers, and a home folder, so the
// real login, the real sessions, and the real models file are never read or written.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The Pi arguments: RPC mode as T3 starts it, with no session file written. The stub is selected by
// flag, so no default model is set anywhere.
export function piArgs(model) {
  return ["--mode", "rpc", "--no-session", "--provider", "stub", "--model", model];
}

// Environment names Pi needs to start. Nothing else from the parent environment is passed.
const INHERITED = ["SystemRoot", "PATH", "PATHEXT", "ComSpec", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL"];
const STOP_WAIT_MS = 15_000;
const POLL_MS = 50;

// The scratch agent folder: a models file with one provider at the stub, and settings that list the
// workspace's packages and skills by absolute path. No auth file is written.
export function writeScratchAgent({ scratch, baseUrl, model, settings }) {
  const agentDir = join(scratch, "agent");
  mkdirSync(agentDir, { recursive: true });
  const provider = {
    baseUrl,
    api: "openai-completions",
    apiKey: "stub",
    models: [{ id: model, name: "Smoke check stub", reasoning: false, input: ["text"], contextWindow: 8192, maxTokens: 1024 }],
  };
  writeFileSync(join(agentDir, "models.json"), `${JSON.stringify({ providers: { stub: provider } }, null, 2)}\n`);
  writeFileSync(
    join(agentDir, "settings.json"),
    `${JSON.stringify({ packages: settings.packages, skills: settings.skills }, null, 2)}\n`,
  );
  return agentDir;
}

// The environment for Pi. It is the wrapper's variables, with HOME and USERPROFILE moved into the
// scratch folder so the user's ~/.pi and ~/.agents are not read. AGENT_ACCESS_PI_ASK is set as the
// wrapper sets it, so an ask does not wait for a person.
export function piEnvironment({ scratch, agentDir, parentEnv }) {
  const home = join(scratch, "home");
  mkdirSync(home, { recursive: true });
  const env = {};
  for (const name of INHERITED) if (parentEnv[name] !== undefined) env[name] = parentEnv[name];
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    PI_CODING_AGENT_DIR: agentDir,
    AGENT_ACCESS_PI_ASK: "allow",
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
  };
}

// How to start the Pi binary. A .cmd shim on Windows runs through cmd.exe, as the wrapper does with
// call. The arguments carry no quote or shell character, so the command line needs no escaping.
export function piLaunch({ piBin, args, platform }) {
  const unsafe = args.find((arg) => /["&|<>^%\s]/.test(arg));
  if (unsafe !== undefined) throw new Error(`Pi argument ${JSON.stringify(unsafe)} needs quoting this launch does not do`);
  if (platform === "win32" && /\.(cmd|bat)$/i.test(piBin)) {
    return { file: "cmd.exe", args: ["/d", "/s", "/c", `"${piBin}" ${args.join(" ")}`], windowsVerbatimArguments: true };
  }
  return { file: piBin, args, windowsVerbatimArguments: false };
}

// Stops the process tree of a process this run started. taskkill /T reaches the Pi node process under
// the cmd.exe shim; elsewhere the child itself is signalled.
function stopTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
  } else {
    child.kill("SIGKILL");
  }
}

function waitFor(predicate, ms) {
  return new Promise((resolveWait) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (predicate() || Date.now() - started >= ms) {
        clearInterval(timer);
        resolveWait(predicate());
      }
    }, POLL_MS);
  });
}

// Splits stdout on LF only, as the RPC framing requires, and keeps every parsed record.
function recordsFromChunks(session) {
  let buffer = "";
  return (chunk) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
      if (line.trim() === "") continue;
      try {
        const record = JSON.parse(line);
        session.events.push(record);
      } catch {
        session.unparsed.push(line.slice(0, 200));
      }
    }
  };
}

// Sends each prompt after the previous run settles, then closes stdin and waits for the exit. A
// prompt the RPC rejects ends the session early, and the rejection is recorded.
export async function runRpcSession({ launch, env, cwd, prompts, timeoutMs, promptMs }) {
  const session = { events: [], unparsed: [], stderr: "", exitCode: null, timedOut: false, spawnError: null };
  const child = spawn(launch.file, launch.args, {
    cwd,
    env,
    windowsHide: true,
    windowsVerbatimArguments: launch.windowsVerbatimArguments,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise((resolveExit) => {
    child.once("error", (error) => {
      session.spawnError = error.message;
      resolveExit();
    });
    child.once("exit", (code) => {
      session.exitCode = code;
      resolveExit();
    });
  });
  child.stdout.setEncoding("utf8").on("data", recordsFromChunks(session));
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    session.stderr += chunk;
  });
  const settled = () => session.events.filter((record) => record.type === "agent_settled").length;
  const rejected = () => session.events.some((record) => record.type === "response" && record.success === false);
  const deadline = Date.now() + timeoutMs;
  for (let index = 0; index < prompts.length; index += 1) {
    if (child.exitCode !== null || rejected()) break;
    child.stdin.write(`${JSON.stringify({ id: `smoke-${index + 1}`, type: "prompt", message: prompts[index] })}\n`);
    const remaining = Math.max(0, Math.min(promptMs, deadline - Date.now()));
    await waitFor(() => settled() > index || rejected() || child.exitCode !== null, remaining);
  }
  child.stdin.end();
  const left = Math.max(0, deadline - Date.now());
  await waitFor(() => child.exitCode !== null || session.spawnError !== null, Math.min(STOP_WAIT_MS, left));
  if (child.exitCode === null && session.spawnError === null) {
    session.timedOut = true;
    stopTree(child);
  }
  await exited;
  return session;
}
