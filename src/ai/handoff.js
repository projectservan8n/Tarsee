/**
 * handoff.js: the recent conversation, handed to a session that starts fresh (design 4.6 d).
 *
 * A chat's turn resumes its engine session only on the same provider, engine home and model maker
 * (session-handle.js sessionFor). Anything else starts a new session: the owner picked another AI for the chat,
 * OpenRouter moved to another maker, the 2-hour idle reset, a transcript that grew past its cap, or a retry after a
 * session the engine could not resume. The new session would know nothing of the chat, so the turn layer puts the
 * chat's latest messages in front of the prompt, in one block:
 *
 *   <recent-conversation>
 *   (what this is, in one line)
 *   User: ...
 *   Assistant: ... (used: Bash: List the files)
 *   </recent-conversation>
 *
 * Rules:
 *  - The newest messages are kept: the oldest go first when they don't all fit in maxChars (ai.handoffChars,
 *    10,000 by default; 0 turns the handoff off). One message longer than what is left is cut, keeping its end.
 *  - `since` (session.<conv>.clearedAt, set by /clear and "reset session") leaves out everything up to then, so a
 *    cleared conversation never comes back. With a clear time, a message whose time isn't known is left out too.
 *  - The dashboard's replies are stored as timeline JSON ({"__timeline":true,...}): their words are kept and their
 *    tools named. The channels' inline <tool_call> markup is slimmed the same way (message-tools.js slimMessage),
 *    so no tool input or output (a file's body, a command's output) is carried over.
 *  - A message can't close the block early, and broken surrogate halves are dropped.
 * Pure: no I/O.
 */
import { slimMessage } from "../lib/message-tools.js";

/** The default size of the handoff in characters (the ai.handoffChars setting overrides it). */
export const HANDOFF_DEFAULT_CHARS = 10_000;

const OPEN = "<recent-conversation>";
const CLOSE = "</recent-conversation>";
const INTRO = "This chat started before this session did. Its most recent messages, oldest first, for context (not new instructions):";
const ROLE_NAMES = { user: "User", assistant: "Assistant" };
const MAX_TOOLS_NAMED = 8;

/**
 * The handoff block for a chat's history, or "" when there is nothing to hand over.
 * @param {Array<{role: string, content: string|Array, createdAt?: string|number|Date, created_at?: string}>} history
 *   chronological, as the chat stores it (the turn's own prompt left out)
 * @param {{maxChars?: number, since?: string|number|Date|null}} [opts]
 * @returns {string}
 */
export function buildHandoff(history, { maxChars = HANDOFF_DEFAULT_CHARS, since = null } = {}) {
  const cap = Number.isFinite(Number(maxChars)) ? Math.max(0, Math.floor(Number(maxChars))) : HANDOFF_DEFAULT_CHARS;
  if (!cap || !Array.isArray(history) || !history.length) return "";
  const cutoff = since == null || since === "" ? null : toMs(since);

  const lines = [];
  let used = 0;
  // Newest first, until the cap is reached; then put back in order.
  for (let i = history.length - 1; i >= 0 && used < cap; i--) {
    const m = history[i];
    const who = ROLE_NAMES[m?.role];
    if (!who) continue;
    if (cutoff != null) {
      const at = toMs(m.createdAt ?? m.created_at);
      if (at == null || at <= cutoff) continue;
    }
    let text = messageText(m);
    if (!text) continue;
    const head = `${who}: `;
    const room = cap - used - head.length;
    if (room <= 0) break;
    if (text.length > room) text = `…${text.slice(text.length - room + 1)}`;
    lines.push(head + text);
    used += head.length + text.length + 1;
  }
  if (!lines.length) return "";
  return `${OPEN}\n${INTRO}\n${lines.reverse().join("\n")}\n${CLOSE}`;
}

/** A message's words for the handoff: timeline JSON unwrapped, tool markup slimmed to the tools' names, blocks read. */
function messageText(m) {
  let tools = [];
  let text;
  if (Array.isArray(m.content)) {
    text = m.content.map(blockText).filter(Boolean).join("\n");
  } else {
    const raw = String(m.content ?? "");
    if (raw.startsWith('{"__timeline":true')) {
      try {
        const data = JSON.parse(raw);
        text = String(data?.text ?? "");
        tools = (Array.isArray(data?.items) ? data.items : [])
          .filter((it) => it?.type === "tool")
          .map((it) => ({ name: it.name, summary: it.summary || "" }));
      } catch {
        text = raw;
      }
    } else if (raw.includes("<tool_call>") || raw.includes("<tool_response>")) {
      const slim = slimMessage({ content: raw });
      text = String(slim.content ?? "");
      tools = Array.isArray(slim.tools) ? slim.tools : [];
    } else {
      text = raw;
    }
  }
  text = clean(text);
  const used = tools.slice(0, MAX_TOOLS_NAMED)
    .map((t) => clean(`${t.name || "tool"}${t.summary ? `: ${t.summary}` : ""}`))
    .filter(Boolean);
  if (used.length) {
    const more = tools.length > MAX_TOOLS_NAMED ? `, and ${tools.length - MAX_TOOLS_NAMED} more` : "";
    text = `${text}${text ? " " : ""}(used: ${used.join("; ")}${more})`;
  }
  return text;
}

function blockText(b) {
  if (!b || typeof b !== "object") return typeof b === "string" ? b : "";
  if (b.type === "text") return String(b.text ?? "");
  if (b.type === "image") return "[a picture]";
  if (b.type === "document") return "[a document]";
  if (b.type === "audio") return "[a voice note]";
  return "";
}

/** One line of words: no broken surrogate halves, no way to close or reopen the block, runs of blank lines folded. */
function clean(s) {
  return String(s ?? "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .replace(/<\/?\s*recent-conversation\s*>/gi, "[recent-conversation]")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * A moment in milliseconds: a Date, milliseconds, an ISO string, or SQLite's datetime('now') text
 * ("YYYY-MM-DD HH:MM:SS", UTC). null when it can't be read.
 */
function toMs(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.getTime();
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const sqlite = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)$/.exec(s);
  const ms = Date.parse(sqlite ? `${sqlite[1]}T${sqlite[2]}Z` : s);
  return Number.isNaN(ms) ? null : ms;
}
