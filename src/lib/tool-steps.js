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
