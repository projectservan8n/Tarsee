/**
 * Live steps for the dashboard, from the Agent SDK's own messages.
 *
 * While a turn runs, the SDK hands the provider an `assistant` message each
 * time the model writes words or starts a tool (a `tool_use` block), and a
 * `user` message each time a tool finishes (a `tool_result` block carrying the
 * `tool_use_id` it answers). Those are exactly the moments the dashboard wants
 * to show, so each becomes a step on the live timeline (lib/live-bus.js):
 *
 *   { kind: "tool_start", id, name, rawName, summary, input }
 *   { kind: "tool_end",   id, ok, preview }
 *   { kind: "text",       text }
 *
 * Everything shown goes through redactSecrets: a command line or a tool's
 * output can carry a key, and this is drawn on a screen and stored for 14 days.
 * The same helpers label the tools of saved replies (lib/message-tools.js).
 */
import { redactSecrets } from "./redact.js";

const PREVIEW_CHARS = 600;
const INPUT_CHARS = 2000;

function str(v) {
  if (v == null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

/**
 * What a tool was given, for the step when it is opened (the summary is its
 * one line): the command for Bash, else the arguments as JSON. Redacted and
 * capped.
 */
export function toolInputPreview(name, input) {
  if (input == null) return "";
  let text = "";
  if (name === "Bash" && typeof input?.command === "string") text = input.command;
  else if (typeof input === "string") text = input;
  else { try { text = JSON.stringify(input, null, 2); } catch { text = String(input); } }
  text = redactSecrets(text.replace(/\r/g, ""));
  return text.length > INPUT_CHARS ? text.slice(0, INPUT_CHARS) + "…" : text;
}

/** A short human label for what a tool call is doing. */
export function summarizeToolInput(name, input = {}) {
  const n = String(name || "");
  const pick = (...keys) => { for (const k of keys) if (input?.[k]) return str(input[k]); return ""; };
  let s = "";
  if (n === "Bash") s = pick("description") || pick("command");
  else if (n === "Read" || n === "Write" || n === "Edit" || n === "NotebookEdit") s = pick("file_path", "notebook_path");
  else if (n === "Grep") s = pick("pattern") + (input?.path ? ` in ${input.path}` : "");
  else if (n === "Glob") s = pick("pattern");
  else if (n === "WebFetch") s = pick("url");
  else if (n === "WebSearch") s = pick("query");
  else if (n === "Task" || n === "Agent") s = pick("description", "prompt");
  else if (n === "TodoWrite") s = "updating the task list";
  else {
    const first = Object.values(input || {}).find((v) => typeof v === "string" && v.trim());
    s = first ? String(first) : "";
  }
  s = s.replace(/\s+/g, " ").trim();
  // Paths: show the tail, which is the informative part.
  if (/^\//.test(s) && s.length > 80) s = "…" + s.slice(-78);
  return s.length > 140 ? s.slice(0, 139) + "…" : s;
}

/** Friendly tool names: mcp__tarsee__tarsee_send_message → tarsee_send_message. */
export function displayToolName(name) {
  const n = String(name || "tool");
  const m = n.match(/^mcp__[^_]+(?:_[^_]+)*?__(.+)$/);
  return m ? m[1] : n;
}

/** A tool result's content as a short preview: its text, images as [image]. */
export function resultPreview(content) {
  let text = "";
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) text = content.map((c) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : "")).join("\n");
  else text = str(content);
  text = redactSecrets(text.replace(/\r/g, "").trim());
  return text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) + "…" : text;
}

/**
 * The live steps in one SDK message (an `assistant` or `user` message; any
 * other type has none). `seen` remembers tool ids already started, so a
 * message delivered twice does not start the same tool twice.
 *
 * @param {object} message an SDKMessage
 * @param {Set<string>} [seen]
 * @returns {object[]} steps, oldest first
 */
export function stepsFromSdkMessage(message, seen = new Set()) {
  const m = message?.message;
  if (!m || !Array.isArray(m.content)) return [];
  const steps = [];
  if (message.type === "assistant") {
    for (const b of m.content) {
      if (b?.type === "tool_use" && b.id && !seen.has(b.id)) {
        seen.add(b.id);
        steps.push({
          kind: "tool_start",
          id: b.id,
          name: displayToolName(b.name),
          rawName: b.name,
          summary: redactSecrets(summarizeToolInput(b.name, b.input)),
          input: toolInputPreview(b.name, b.input),
        });
      } else if (b?.type === "text" && b.text?.trim()) {
        steps.push({ kind: "text", text: b.text.trim() });
      }
    }
  } else if (message.type === "user") {
    for (const b of m.content) {
      if (b?.type === "tool_result" && b.tool_use_id) {
        steps.push({ kind: "tool_end", id: b.tool_use_id, ok: !b.is_error, preview: resultPreview(b.content) });
      }
    }
  }
  return steps;
}

/**
 * The tool results in an SDK `user` message, in the shape callers of the
 * provider already expect: { id, ok, result } with the result's full text.
 */
export function toolResultsFromSdkMessage(message) {
  if (message?.type !== "user") return [];
  const content = message.message?.content;
  if (!Array.isArray(content)) return [];
  const out = [];
  for (const b of content) {
    if (b?.type !== "tool_result" || !b.tool_use_id) continue;
    let text = "";
    if (typeof b.content === "string") text = b.content;
    else if (Array.isArray(b.content)) text = b.content.map((c) => (c?.type === "text" ? c.text : c?.type === "image" ? "[image]" : "")).join("\n");
    else if (b.content != null) text = str(b.content);
    out.push({ id: b.tool_use_id, ok: !b.is_error, result: text });
  }
  return out;
}

/** What the SDK's error words mean, for a retry's line. */
const RETRY_WHY = {
  authentication_failed: "sign-in failed",
  oauth_org_not_allowed: "organization not allowed",
  billing_error: "billing problem",
  rate_limit: "rate limited",
  invalid_request: "invalid request",
  server_error: "server error",
  max_output_tokens: "output limit",
};
const THINKING_CHARS = 4000;
const CALL_MAX_MS = 20 * 60_000;

/** A speed in tokens a second, or null when the time is too short to say. */
function tps(out, ms) {
  return ms >= 500 ? Math.round((out / (ms / 1000)) * 10) / 10 : null;
}

/**
 * The other live steps of a turn, read from the SDK's stream as it comes
 * (includePartialMessages): the answer to "what is it doing" while the line
 * only says "Thinking".
 *
 *   { kind: "thinking", text }  a summary of what the model thought, when its
 *                               thinking block ends (only a turn that asked
 *                               for summaries gets any text; see
 *                               providers/claude-code.js)
 *   { kind: "status", text }    why it is waiting: an API error it will retry,
 *                               or compacting the conversation
 *   { kind: "usage", total, input, cacheRead, cacheWrite, output, calls,
 *     outTps, nowTps }          the turn's tokens so far, subagents included,
 *                               at each model call's start and end; outTps is
 *                               output over generation time, nowTps the same
 *                               for the latest three calls
 *
 * A subagent's thinking stays out of the list (its work shows as its one Task
 * step), but its tokens count.
 */
export function createStreamWatcher({ now = () => Date.now() } = {}) {
  const calls = new Map();     // message id -> { input, cacheRead, cacheWrite, output, startedAt, endedAt }
  const current = new Map();   // parent tool id ("" for the turn itself) -> the message id being streamed
  const thinking = new Map();  // `${parent}|${index}` -> the summary so far

  function usageSoFar() {
    const s = { calls: 0, input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    let genMs = 0;
    let genOut = 0;
    const timed = [];
    for (const c of calls.values()) {
      s.calls += 1; s.input += c.input; s.cacheRead += c.cacheRead; s.cacheWrite += c.cacheWrite; s.output += c.output;
      const g = c.endedAt && c.startedAt ? c.endedAt - c.startedAt : 0;
      // (a believable generation time only: not under a millisecond per 1.5 tokens, not over 20 minutes)
      if (g > 0 && g <= CALL_MAX_MS && c.output <= g * 1.5) { genMs += g; genOut += c.output; timed.push({ g, out: c.output, at: c.endedAt }); }
    }
    timed.sort((a, b) => a.at - b.at);
    const last = timed.slice(-3);
    return {
      kind: "usage",
      ...s,
      total: s.input + s.cacheRead + s.cacheWrite + s.output,
      outTps: tps(genOut, genMs),
      nowTps: tps(last.reduce((a, c) => a + c.out, 0), last.reduce((a, c) => a + c.g, 0)),
    };
  }

  function take(call, u) {
    if (!u) return;
    if (u.input_tokens != null) call.input = Number(u.input_tokens) || 0;
    if (u.cache_read_input_tokens != null) call.cacheRead = Number(u.cache_read_input_tokens) || 0;
    if (u.cache_creation_input_tokens != null) call.cacheWrite = Number(u.cache_creation_input_tokens) || 0;
    if (u.output_tokens != null) call.output = Number(u.output_tokens) || 0;
  }

  function retryText(m) {
    const secs = Math.max(1, Math.round((Number(m.retry_delay_ms) || 0) / 1000));
    const when = `Trying again in ${secs}s (attempt ${m.attempt || 1} of ${m.max_retries || "?"}).`;
    if (m.error_status == null) return `Could not reach Claude's API. ${when}`;
    const why = RETRY_WHY[m.error];
    return `Claude's API answered ${m.error_status}${why ? ` (${why})` : ""}. ${when}`;
  }

  /** The steps in one SDK message: [] for most. */
  function onMessage(message) {
    if (!message) return [];
    if (message.type === "system") {
      if (message.subtype === "api_retry") return [{ kind: "status", text: retryText(message) }];
      if (message.subtype === "status") {
        if (message.status === "compacting") return [{ kind: "status", text: "Compacting the conversation to make room." }];
        if (message.compact_result === "failed") return [{ kind: "status", text: `Compacting failed${message.compact_error ? `: ${redactSecrets(String(message.compact_error)).slice(0, 200)}` : "."}` }];
      }
      return [];
    }
    if (message.type !== "stream_event" || !message.event) return [];
    const e = message.event;
    const parent = message.parent_tool_use_id || "";
    switch (e.type) {
      case "message_start": {
        const id = e.message?.id || `call-${calls.size + 1}`;
        const call = calls.get(id) || { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, startedAt: now(), endedAt: 0 };
        take(call, e.message?.usage);
        calls.set(id, call);
        current.set(parent, id);
        return [usageSoFar()];
      }
      case "message_delta": {
        const call = calls.get(current.get(parent));
        if (!call || !e.usage) return [];
        take(call, e.usage);
        call.endedAt = now();
        return [usageSoFar()];
      }
      case "content_block_start":
        if (!parent && e.content_block?.type === "thinking") thinking.set(`${parent}|${e.index}`, "");
        return [];
      case "content_block_delta":
        if (e.delta?.type === "thinking_delta" && thinking.has(`${parent}|${e.index}`)) {
          const key = `${parent}|${e.index}`;
          const sofar = thinking.get(key);
          if (sofar.length < THINKING_CHARS) thinking.set(key, sofar + String(e.delta.thinking || ""));
        }
        return [];
      case "content_block_stop": {
        const key = `${parent}|${e.index}`;
        if (!thinking.has(key)) return [];
        const text = thinking.get(key).trim();
        thinking.delete(key);
        // (No text: the model thought without a summary, which is all a turn that did not ask for one gets.)
        return text ? [{ kind: "thinking", text: redactSecrets(text.slice(0, THINKING_CHARS)) }] : [];
      }
      default:
        return [];
    }
  }

  return { onMessage, usageSoFar };
}
