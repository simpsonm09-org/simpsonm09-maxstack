// The checks the smoke run asserts. Each takes what the run recorded (the Pi session, the stub's
// requests, the marker file) and returns { name, ok, detail }. Nothing here starts a process.
import { existsSync } from "node:fs";
import { PLAIN_TEXT } from "./stub-model-server.mjs";

// The prefix the org gate puts on every denial it returns (gate.mjs denyMessage).
export const GATE_DENIAL_PREFIX = "agent-access: denied:";
const CHAT_PATH = "/v1/chat/completions";

const check = (name, ok, detail) => ({ name, ok: ok === true, detail });

// Each <skill> block of the system prompt, as its name and the location Pi gives it.
export function skillsInSystemPrompt(systemText) {
  const blocks = [...systemText.matchAll(/<skill>([\s\S]*?)<\/skill>/g)].map((match) => match[1]);
  return blocks.map((block) => ({
    name: block.match(/<name>([^<]*)<\/name>/)?.[1] ?? "",
    location: (block.match(/<location>([^<]*)<\/location>/)?.[1] ?? "").replaceAll("\\", "/"),
  }));
}

function systemTextOf(request) {
  const system = (request.body?.messages ?? []).find((message) => message.role === "system");
  return typeof system?.content === "string" ? system.content : "";
}

export function checkPiExit(session) {
  if (session.spawnError) return check("pi-started-and-exited-0", false, `spawn failed: ${session.spawnError}`);
  if (session.timedOut) return check("pi-started-and-exited-0", false, "Pi did not exit in time and was stopped");
  return check("pi-started-and-exited-0", session.exitCode === 0, `exit code ${session.exitCode}`);
}

export function checkChatRequest(stub) {
  const count = stub.requests.filter((request) => request.path === CHAT_PATH).length;
  return check("stub-received-chat-request", count >= 1, `${count} chat request(s) reached the stub`);
}

// The assistant text the plain turn produced, from the message events of the session.
export function checkPlainTurn(session) {
  const texts = session.events
    .filter((record) => record.type === "message_end" && record.message?.role === "assistant")
    .flatMap((record) => (record.message.content ?? []).filter((part) => part.type === "text").map((part) => part.text));
  return check("plain-turn-answered", texts.includes(PLAIN_TEXT), `assistant texts: ${texts.length}`);
}

// One layer's skill is in the system prompt of the first chat request, under the layer's folder.
export function checkLayerSkill(stub, skill) {
  const name = `skill-${skill.layer}-in-system-prompt`;
  if (skill.error) return check(name, false, skill.error);
  const first = stub.requests.find((request) => request.path === CHAT_PATH);
  const listed = skillsInSystemPrompt(first ? systemTextOf(first) : "");
  const found = listed.find(
    (entry) => entry.name === skill.name && entry.location.toLowerCase().endsWith(skill.layerPath.toLowerCase()),
  );
  return check(name, Boolean(found), `${skill.name} at ${skill.layerPath}`);
}

// PStack registers /loop from its Pi extension. RPC get_commands reports loaded extension commands.
export function checkPstackExtensionLoaded(session) {
  const response = session.events.find((record) => record.type === "response" && record.id === "smoke-commands" && record.command === "get_commands");
  const commands = response?.data?.commands ?? [];
  const found = commands.some((command) => command.name === "loop" && command.source === "extension");
  return check("pstack-pi-extension-loaded", found, found ? "/loop is registered by an extension" : "get_commands did not report PStack's /loop extension command");
}

function deniedToolEvent(session) {
  return session.events.find(
    (record) => record.type === "tool_execution_end" && record.toolName === "bash" && record.isError === true,
  );
}

function resultText(record) {
  return (record?.result?.content ?? []).map((part) => part.text ?? "").join("");
}

function madeBashCall(session) {
  return session.events.some((record) => record.type === "tool_execution_start" && record.toolName === "bash");
}

export function checkBashCallMade(session) {
  const started = madeBashCall(session);
  return check("bash-call-was-made", started, started ? "Pi made the bash call" : "Pi made no bash call");
}

// The gate answered the launcher call with its own denial text, so the gate extension ran for it.
export function checkGateLoaded(session) {
  const record = deniedToolEvent(session);
  const text = record ? resultText(record) : "";
  const ok = text.startsWith(GATE_DENIAL_PREFIX);
  return check("gate-extension-loaded", ok, ok ? text : `bash result was not a gate denial: ${text.slice(0, 120)}`);
}

// The denial came back to the model as a tool message in the request that followed the call.
export function checkDenialReachedModel(stub) {
  const messages = stub.requests.flatMap((request) => request.body?.messages ?? []);
  const toolText = messages
    .filter((message) => message.role === "tool" && typeof message.content === "string")
    .map((message) => message.content)
    .find((text) => text.startsWith(GATE_DENIAL_PREFIX));
  return check("denial-reached-model", Boolean(toolText), toolText ? toolText : "no gate denial in any tool message");
}

// The denied command would have written the marker. Its absence shows the command did not run, but
// only when Pi made the bash call at all: with no call, nothing was tested and the check fails.
export function checkDeniedNotRun(markerPath, session) {
  if (!madeBashCall(session)) return check("denied-command-did-not-run", false, "Pi made no bash call, so nothing was tested");
  const ran = existsSync(markerPath);
  return check("denied-command-did-not-run", !ran, ran ? "the denied command ran and wrote its marker" : "no marker written");
}

export function checkWorkspaceUnchanged(before, after) {
  const changed = [];
  for (const [path, value] of after) if (before.get(path) !== value) changed.push(path);
  for (const path of before.keys()) if (!after.has(path)) changed.push(path);
  const watched = `${before.size} file(s) in the Pi agent and wrapper folders`;
  return check("workspace-unchanged", changed.length === 0, changed.length === 0 ? `no change to ${watched}` : `changed: ${changed.slice(0, 3).join(", ")}`);
}
