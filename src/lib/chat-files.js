/**
 * The files of a chat, kept with its conversation (table chat_files), so the dashboard's chat shows them: after a
 * reload, on every device, on the message they belong to. Ported from TarseeMacOS.
 *
 * What is kept here:
 *   out  every file the agent sends into a chat: send_file to any channel (the dashboard's own chats too), and the
 *        files it attaches to an email (lib/sent-files.js noteSentFile, from lib/tools.js)
 *   in   files people send in that no note in their message names: the dashboard's own uploads (routes/chat.js
 *        /send) and pictures or sounds the channels hand the agent as bytes (src/ai/providers/claude-code.js, where
 *        they are written to disk). Files the bots save with a note in the message ("[Attached file saved: ...]") are
 *        read from that note instead (public/js/file-viewer-core.js splitNotes), so they are never kept twice.
 * Each row points at a copy inside the workspace's uploads folder, the only place the page may open a file from.
 *
 * Where each one shows in the chat (placeFiles):
 *   - a person's file, on the message it came with
 *   - the agent's, on the reply of the turn that sent it ("attached above", as Discord shows it): when the next
 *     message after it is the agent's and it was sent while a turn was at work in that chat
 *   - otherwise as a row of its own, right after the message that was the latest when it came (a file sent there
 *     from another chat, or one whose turn said nothing after it)
 */
import fs from "node:fs";

let _db = null;
let _st = null;

/** The agent's file goes on the next reply only when that reply came within this long of it. */
const ON_REPLY_WITHIN_MS = 2 * 3_600_000;
const MAX_ROWS = 2000;

/** The URL the page opens a kept file at (routes/chat.js GET /file). */
export const fileUrl = (p) => `/api/chat/file?p=${encodeURIComponent(p)}`;

export function initChatFiles(db) {
  _db = db;
  try {
    _st = {
      insert: db.prepare(`INSERT INTO chat_files (conversation_id, direction, message_id, after_message_id, turn_id, name, size, path, caption, via, created_at)
                          VALUES (@conversationId, @direction, @messageId, @afterMessageId, @turnId, @name, @size, @path, @caption, @via, @at)`),
      latest: db.prepare("SELECT id FROM messages WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1"),
      latestUser: db.prepare("SELECT id FROM messages WHERE conversation_id = ? AND role = 'user' ORDER BY rowid DESC LIMIT 1"),
      ofConv: db.prepare(`SELECT * FROM chat_files WHERE conversation_id = ? ORDER BY id DESC LIMIT ${MAX_ROWS}`),
      ofMessage: db.prepare("SELECT COUNT(*) AS n FROM chat_files WHERE message_id = ? AND direction = 'in'"),
      order: db.prepare("SELECT id, role, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC, rowid ASC"),
      forget: db.prepare("DELETE FROM chat_files WHERE conversation_id = ?"),
    };
  } catch (err) {
    // A database without the table (an old test fixture): files are simply not kept.
    console.warn(`[chat-files] not kept: ${err.message}`);
    _st = null;
  }
}

/** For tests: forget the database. */
export function __resetChatFiles() { _db = null; _st = null; }

/** True once the table can be written (initChatFiles found it). */
export const chatFilesReady = () => !!_st;

const clip = (s, n) => String(s ?? "").slice(0, n);

/**
 * Keep files with a conversation. files: [{ name, size, path }] (copies inside the uploads folder).
 *   direction  "out" (the agent sent them) or "in" (someone sent them to the agent)
 *   messageId  the message they came with (a person's files)
 *   turnId     the turn at work in this conversation when the agent sent them
 *   caption    what it said with them; via: where they went or came from (discord, telegram, email, web)
 * Returns the kept rows as the page gets them (fileView), or [] when nothing could be kept. Never throws.
 */
export function recordChatFiles(conversationId, files, { direction = "out", messageId = null, turnId = null, caption = "", via = "", at = Date.now() } = {}) {
  if (!_st || !conversationId || !Array.isArray(files) || !files.length) return [];
  try {
    const afterMessageId = _st.latest.get(conversationId)?.id || null;
    const rows = [];
    for (const f of files) {
      if (!f?.path) continue;
      const row = {
        conversationId, direction: direction === "in" ? "in" : "out", messageId: messageId || null, afterMessageId,
        turnId: turnId || null, name: clip(f.name || "file", 200), size: Number(f.size) || 0, path: String(f.path),
        caption: clip(caption, 500) || null, via: clip(via, 40) || null, at: Number(at) || Date.now(),
      };
      const info = _st.insert.run(row);
      rows.push(fileView({ id: Number(info.lastInsertRowid), conversation_id: conversationId, direction: row.direction, message_id: row.messageId,
        after_message_id: row.afterMessageId, turn_id: row.turnId, name: row.name, size: row.size, path: row.path, caption: row.caption, via: row.via, created_at: row.at }));
    }
    return rows;
  } catch (err) {
    console.warn(`[chat-files] could not keep a file for ${String(conversationId).slice(0, 8)}: ${err.message}`);
    return [];
  }
}

/** The latest message a person sent in a conversation (the one the bytes being written now came with), or null. */
export function latestUserMessageId(conversationId) {
  if (!_st || !conversationId) return null;
  try { return _st.latestUser.get(conversationId)?.id || null; } catch { return null; }
}

/** True when a message already has files of its own on record (the dashboard's upload kept them first). */
export function messageHasFiles(messageId) {
  if (!_st || !messageId) return false;
  try { return (_st.ofMessage.get(messageId)?.n || 0) > 0; } catch { return false; }
}

/** A row as the page gets it: where to open it, and whether it is still there (copies are tidied after 30 days). */
export function fileView(r) {
  return {
    id: r.id, name: r.name, size: r.size || 0, path: r.path,
    url: fileUrl(r.path),
    from: r.direction === "in" ? "in" : "agent",
    caption: r.caption || "", via: r.via || "",
    at: r.created_at,
    messageId: r.message_id || null, afterMessageId: r.after_message_id || null, turnId: r.turn_id || null,
    gone: !fs.existsSync(r.path),
  };
}

/** A conversation's files, oldest first (the newest 2000). */
export function chatFilesFor(conversationId) {
  if (!_st || !conversationId) return [];
  try { return _st.ofConv.all(conversationId).reverse().map(fileView); } catch { return []; }
}

/**
 * A page of a conversation's messages (oldest first, as the history API sends them) with its files in their places:
 * placed among all of the conversation's messages (their ids and who said them only), so a file whose message is
 * just over the page's edge still goes on the reply that is on it. Each message of the page gets files and
 * filesAfter as placeFiles gives them; files placed on messages of older pages are left for those pages. Returns
 * { leadFiles } (only on a page that starts at the beginning).
 */
export function placeFilesOnPage(conversationId, page, { complete = true } = {}) {
  const files = chatFilesFor(conversationId);
  if (!files.length || !_st) return { leadFiles: [] };
  let order;
  try { order = _st.order.all(conversationId); } catch { return { leadFiles: [] }; }
  const placed = placeFiles(order, files, { complete: true });
  const byId = new Map(placed.messages.map((m) => [m.id, m]));
  for (const m of page || []) {
    const p = byId.get(m.id);
    if (p?.files) m.files = p.files;
    if (p?.filesAfter) m.filesAfter = p.filesAfter;
  }
  return { leadFiles: complete ? placed.leadFiles : [] };
}

/** The conversation is deleted or cleared: its rows go too (the copies are tidied with the rest of the uploads folder). */
export function forgetChatFiles(conversationId) {
  if (!_st || !conversationId) return 0;
  try { return _st.forget.run(conversationId).changes; } catch { return 0; }
}

/** "2026-10-27 01:56:34" (SQLite's UTC, to the second), an ISO date or ms → ms (0 for none). */
export function msOf(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v || "");
  if (!s) return 0;
  const t = Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(s) ? `${s.replace(" ", "T")}Z` : s);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * Put each file in its place among a page of messages (oldest first: { id, role, created_at }). Files: fileView rows,
 * oldest first. complete: the page starts at the conversation's first message (all of it, or a first page).
 * Adds to the messages, in place: files (shown in that message: a person's own, or the agent's on its reply) and
 * filesAfter (a row of their own just after it). Returns { messages, leadFiles } (leadFiles: before every message,
 * kept when nothing had been said yet; only on a complete page). A file whose place is on an older page is left
 * for that page.
 */
export function placeFiles(messages, files, { complete = true } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const index = new Map(list.map((m, i) => [m.id, i]));
  const firstAt = list.length ? msOf(list[0].created_at) : Infinity;
  const leadFiles = [];
  const put = (m, key, f) => { (m[key] ||= []).push(f); };
  // Messages are kept to the second: a file of the same second as a message came after it.
  const lastBefore = (at) => {
    let i = -1;
    for (let k = 0; k < list.length; k++) if (msOf(list[k].created_at) <= at) i = k;
    return i;
  };
  for (const f of Array.isArray(files) ? files : []) {
    if (f.messageId && index.has(f.messageId)) { put(list[index.get(f.messageId)], "files", f); continue; }
    let i;
    if (f.afterMessageId && index.has(f.afterMessageId)) i = index.get(f.afterMessageId);
    else if (!f.afterMessageId && !f.messageId) i = -1;   // nothing had been said in the chat yet
    else {
      // Its message is on an older page, or was deleted: by its time.
      if (f.at < firstAt - 999) { if (complete) leadFiles.push(f); continue; }
      i = lastBefore(f.at);
    }
    if (i < 0 && !complete) continue;
    const next = list[i + 1];
    if (f.from === "agent" && f.turnId && next?.role === "assistant" && msOf(next.created_at) - f.at < ON_REPLY_WITHIN_MS) put(next, "files", f);
    else if (i >= 0) put(list[i], "filesAfter", f);
    else leadFiles.push(f);
  }
  return { messages: list, leadFiles };
}
