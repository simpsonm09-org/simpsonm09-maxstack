// A model-free OpenAI-compatible server for the Pi harness smoke check. It serves only what Pi's
// openai-completions mode calls: GET /v1/models and POST /v1/chat/completions (streamed as SSE when
// the request asks for it). It binds to 127.0.0.1 on an ephemeral port and keeps every request in
// memory, so a caller can assert on what Pi sent.
//
// The reply comes from a script keyed on the last message. A tool result gets a fixed final text.
// A user message with the deny trigger gets one bash tool call, whose command the caller supplies.
// Any other user message gets a fixed text. No model runs, and nothing is downloaded.
import { createServer } from "node:http";

export const STUB_HOST = "127.0.0.1";
export const STUB_MODEL_ID = "stub-1";
export const PLAIN_TEXT = "PI_SMOKE_PLAIN_ANSWER";
export const AFTER_TOOL_TEXT = "PI_SMOKE_AFTER_TOOL";
export const DENY_TRIGGER = "PI_SMOKE_DENY";
const NO_BASH_TEXT = "PI_SMOKE_NO_BASH_TOOL";

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part?.type === "text" ? (part.text ?? "") : "")).join("");
}

function lastUserText(messages) {
  const user = [...messages].reverse().find((message) => message.role === "user");
  return textOf(user?.content);
}

// The argument key a bash tool takes its command in: the required "command" key, else the first
// required key, else "command".
function commandKey(tool) {
  const schema = tool.function?.parameters ?? {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  if (required.includes("command")) return "command";
  return required[0] ?? "command";
}

// The reply to one chat request: text, or one tool call. Keyed on the last message, so a tool result
// always gets the final text and the call is made once.
export function decideReply(body, { denyCommand }) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.at(-1)?.role === "tool") return { text: AFTER_TOOL_TEXT };
  if (!lastUserText(messages).includes(DENY_TRIGGER)) return { text: PLAIN_TEXT };
  const bash = (body.tools ?? []).find((tool) => tool.function?.name === "bash");
  if (!bash) return { text: NO_BASH_TEXT };
  return { call: { name: bash.function.name, args: { [commandKey(bash)]: denyCommand } } };
}

function completionJson(reply, model) {
  const message = reply.call
    ? {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_stub_1", type: "function", function: { name: reply.call.name, arguments: JSON.stringify(reply.call.args) } }],
      }
    : { role: "assistant", content: reply.text };
  return {
    id: "chatcmpl-stub-1",
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message, finish_reason: reply.call ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function completionSse(reply, model) {
  const frames = [];
  const chunk = (delta, finishReason = null) => ({
    id: "chatcmpl-stub-1",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  frames.push(chunk({ role: "assistant", content: "" }));
  if (reply.call) {
    const toolCall = { index: 0, id: "call_stub_1", type: "function", function: { name: reply.call.name, arguments: JSON.stringify(reply.call.args) } };
    frames.push(chunk({ tool_calls: [toolCall] }));
    frames.push(chunk({}, "tool_calls"));
  } else {
    frames.push(chunk({ content: reply.text }));
    frames.push(chunk({}, "stop"));
  }
  frames.push({ ...chunk({}), choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  return `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`;
}

function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(value));
}

// Parses a request body, or returns null when it is not JSON. Only the chat route reads one.
function parseBody(raw) {
  try {
    return raw === "" ? {} : JSON.parse(raw);
  } catch {
    return null;
  }
}

function handleChat(res, record, model, denyCommand) {
  if (record.body === null) return sendJson(res, 400, { error: "request body is not JSON" });
  const reply = decideReply(record.body, { denyCommand });
  if (record.body.stream === true) {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    return res.end(completionSse(reply, model));
  }
  return sendJson(res, 200, completionJson(reply, model));
}

// Starts the stub. The caller must call close() on every path, success or failure.
export async function startStubModelServer({ denyCommand = "exit 0", model = STUB_MODEL_ID } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const path = new URL(req.url ?? "/", `http://${STUB_HOST}`).pathname;
      const record = { method: req.method ?? "", path, body: parseBody(raw) };
      requests.push(record);
      if (req.method === "GET" && path === "/v1/models") {
        return sendJson(res, 200, { object: "list", data: [{ id: model, object: "model", created: 0, owned_by: "stub" }] });
      }
      if (req.method === "POST" && path === "/v1/chat/completions") return handleChat(res, record, model, denyCommand);
      return sendJson(res, 404, { error: "not found" });
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, STUB_HOST, resolve);
  });
  const { port } = server.address();
  return {
    baseUrl: `http://${STUB_HOST}:${port}/v1`,
    port,
    model,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
