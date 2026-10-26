/**
 * The tools a saved reply used, with what went in and what came out, for the
 * chat's "Used 12 tools" line when a step is opened (GET
 * /api/chat/conversations/:id/messages/:messageId/tools).
 *
 * Two shapes are on disk:
 *   - the dashboard's replies: timeline JSON,
 *     {"__timeline":true,"items":[{type:"tool",name,detail,input,output}...],"text":...}
 *   - the channels' replies (Telegram, Discord, WhatsApp...): the words with each call
 *     inline as <tool_call>{"name","arguments"}</tool_call>, sometimes followed
 *     by its <tool_response>...</tool_response>.
 * The chat's history comes slim (routes/chat.js slimMessage: names only), so
 * this is asked for only when someone opens the steps, one reply at a time.
 *
 * Everything goes through redactSecrets: a command line or an output can carry
 * a key, and this is shown on a screen.
 */
import { redactSecrets } from "./redact.js";
import { summarizeToolInput, displayToolName } from "./tool-steps.js";

export const IO_CAP = 4000;
export const MAX_TOOLS = 300;

const cap = (s, n = IO_CAP) => {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n)}\n…` : t;
};
const pretty = (v) => {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
};

/** One tool as the chat shows it: { name, summary, input, output, ok }. */
function tool({ name, input, inputText, output, ok = true, summary = "" }) {
  const clean = displayToolName(name || "tool");
  const sum = summary || summarizeToolInput(String(name || ""), input && typeof input === "object" ? input : {}) || "";
  return {
    name: clean,
    summary: redactSecrets(sum),
    input: redactSecrets(cap(inputText != null ? inputText : pretty(input))),
    output: redactSecrets(cap(output)),
    ok: ok !== false,
  };
}

/** The tools in a stored message's content (either shape), oldest first. */
export function messageTools(content) {
  const raw = String(content ?? "");
  if (raw.startsWith('{"__timeline":true')) {
    let data = null;
    try { data = JSON.parse(raw); } catch { return []; }
    return (Array.isArray(data?.items) ? data.items : [])
      .filter((it) => it && it.type === "tool")
      .slice(0, MAX_TOOLS)
      .map((it) => {
        let input = null;
        try { input = typeof it.input === "string" && /^\s*[{[]/.test(it.input) ? JSON.parse(it.input) : null; } catch { input = null; }
        if (Array.isArray(it.todos)) input = { todos: it.todos };
        return tool({ name: it.name, input, inputText: it.input || it.detail || "", output: it.output || "", summary: it.summary || "", ok: !/^(error|failed)$/i.test(String(it.status || "")) });
      });
  }
  const out = [];
  // A call and, if one follows before the next call, its response.
  const re = /<tool_call>([\s\S]*?)<\/tool_call>|<tool_response>([\s\S]*?)<\/tool_response>/g;
  for (let m = re.exec(raw); m && out.length <= MAX_TOOLS; m = re.exec(raw)) {
    if (m[1] != null) {
      let j = null;
      try { j = JSON.parse(m[1]); } catch { j = null; }
      out.push(tool({ name: j?.name || "tool", input: j?.arguments ?? j?.input ?? null, inputText: j ? null : m[1], output: "" }));
    } else if (out.length && !out[out.length - 1]._answered) {
      const last = out[out.length - 1];
      last.output = redactSecrets(cap(m[2].trim()));
      last.ok = !/^\s*(error|failed)\b/i.test(m[2]);
      Object.defineProperty(last, "_answered", { value: true, enumerable: false });
    }
  }
  return out.slice(0, MAX_TOOLS);
}

/**
 * A stored message as the chat's history sends it: the words, and for each
 * tool its name and one line, without inputs or outputs.
 *
 * Two shapes are stored. The dashboard's own replies are timeline JSON
 * ({"__timeline":true,"items":[...],"text":...}); it stays timeline JSON, its
 * notes kept and each tool cut to name, one line, status and todo list. The
 * channels' replies carry each call inline as <tool_call>{...}</tool_call>
 * (and sometimes its <tool_response>); those are taken out and listed in
 * `tools`.
 */
export function slimMessage(m) {
  const content = String(m.content || "");
  if (content.startsWith('{"__timeline":true')) {
    let data = null;
    try { data = JSON.parse(content); } catch { return m; }
    if (!data || !Array.isArray(data.items)) return m;
    const items = data.items.slice(0, 300).map((it) => {
      if (it?.type !== "tool") return it;
      const slim = {
        type: "tool",
        name: displayToolName(it.name || "tool"),
        summary: redactSecrets(String(it.summary || it.detail || "").replace(/\s+/g, " ").slice(0, 140)),
        status: it.status || "done",
      };
      if (Array.isArray(it.todos)) slim.todos = it.todos;
      return slim;
    });
    return { ...m, content: JSON.stringify({ __timeline: true, items, text: data.text || "" }) };
  }
  if (!content.includes("<tool_call>") && !content.includes("<tool_response>")) return m;
  const tools = [];
  for (const match of content.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)) {
    try {
      const j = JSON.parse(match[1]);
      const args = j.arguments || {};
      const hint = summarizeToolInput(String(j.name || ""), args) || args.description || args.file_path || args.command || args.pattern || args.url || args.query || "";
      tools.push({ name: displayToolName(String(j.name || "tool")), summary: redactSecrets(String(hint).replace(/\s+/g, " ").slice(0, 140)) });
    } catch { tools.push({ name: "tool", summary: "" }); }
    if (tools.length >= 200) break;
  }
  const clean = content
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { ...m, content: clean, tools };
}
