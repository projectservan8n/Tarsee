/**
 * The copies of a chat's files, and handing them back to the page to look at. Ported from TarseeMacOS.
 *
 * Kept: whatever the agent sends to a chat (the send_file tool, and the files it emails), as sent-<time>-<name> in
 * the workspace's uploads folder, and every file uploaded in the dashboard's chat, as chat-<time>-<n>-<name>, kept
 * with the chat (lib/chat-files.js) and told to the pages showing it on the live timeline ("files" events). Why a
 * copy: the agent's files can be anywhere on the disk, where the page is not allowed to look. A hard link where the
 * disk allows (no second copy, and it outlives the original being tidied away), a plain copy otherwise. Copies older
 * than 30 days are cleared out as new ones arrive.
 *
 * Shown: GET /api/chat/file?p=<path> only serves files inside that uploads folder (the real path is checked, so
 * links and ".." get nowhere). Uploads come from anyone who can message the agent, so nothing is ever served as a
 * web page: pictures, PDFs, sound and video go out as what they are, everything else as plain text or as a
 * download, and all of it with a policy that stops scripts.
 */
import fs from "node:fs";
import path from "node:path";
import config from "../config/env.js";
import { publish, activeTurnFor } from "./live-bus.js";
import { recordChatFiles, latestUserMessageId, messageHasFiles } from "./chat-files.js";

const KEEP_DAYS = 30;
export const uploadsDir = () => path.join(config.WORKSPACE_DIR, "uploads");

/** A file's name with nothing in it that could reach out of a folder or break a header. */
export function safeFileName(name) {
  const base = String(name || "").split(/[\\/]/).pop().replace(/[^\w.\- ()]+/g, "_").replace(/^\.+/, "").trim();
  return (base || "file").slice(-120);
}

/**
 * Clear out the kept copies over 30 days old. Their age is the time in their name: a kept copy of something the
 * agent sent can be a hard link to a file written long before, so its own date says nothing.
 */
export function tidyKeptFiles(dir = uploadsDir(), now = Date.now()) {
  try {
    for (const name of fs.readdirSync(dir)) {
      const stamp = Number(/^(?:chat|sent)-(\d{13})-/.exec(name)?.[1]);
      if (!Number.isFinite(stamp) || !stamp) continue;
      if (now - stamp > KEEP_DAYS * 86_400_000) fs.rmSync(path.join(dir, name), { force: true });
    }
  } catch { /* cleaning up is best-effort */ }
}

/**
 * Save files the dashboard's chat sent ([{ name, buffer }]) into the uploads folder.
 * Returns [{ name, size, path }].
 */
export function keepUploadedFiles(files, { dir = uploadsDir(), now = Date.now() } = {}) {
  if (!files?.length) return [];
  fs.mkdirSync(dir, { recursive: true });
  tidyKeptFiles(dir, now);
  return files.map((f, i) => {
    const name = safeFileName(f.name);
    const file = path.join(dir, `chat-${now}-${i}-${name}`);
    fs.writeFileSync(file, f.buffer);
    return { name, size: f.buffer.length, path: file };
  });
}

/** Keep something the agent sent so the page can show it: { name, size, path }. A file already in the uploads folder is used as it is. */
export function keepSentFile(absPath, { dir = uploadsDir(), now = Date.now() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const real = fs.realpathSync(absPath);
  const size = fs.statSync(real).size;
  if (real.startsWith(fs.realpathSync(dir) + path.sep)) return { name: shownName(real), size, path: real };
  tidyKeptFiles(dir, now);
  const name = safeFileName(path.basename(real));
  let file = path.join(dir, `sent-${now}-${name}`);
  for (let n = 1; fs.existsSync(file); n++) file = path.join(dir, `sent-${now + n}-${name}`);   // two in the same millisecond
  try { fs.linkSync(real, file); } catch { fs.copyFileSync(real, file); }
  return { name, size, path: file };
}

/** A file's name as the bots and the chat keep it on disk, without the time and number they put in front. */
export const shownName = (p) => path.basename(String(p || "")).replace(/^(chat|sent|discord|telegram|whatsapp|email)-\d+-(\d+-)?/, "") || "file";

/**
 * The agent sent a file to a chat: keep a copy, keep it with that chat's conversation (lib/chat-files.js), and tell
 * the pages showing that chat on the live timeline. When a turn is at work in that chat (the one sending it, as a
 * rule) the file is that turn's: it shows on the turn's reply, and the event carries the turn's id. Best-effort on
 * purpose: it runs after the file has gone, and nothing here may turn a good send into an error. Returns
 * { conversationId, file, event }, or null when it could not be kept.
 */
export function noteSentFile({ absPath, caption = "", conversationId = null, via = "" }) {
  try {
    if (!conversationId || !absPath) return null;
    const kept = keepSentFile(absPath);
    const turnId = activeTurnFor(conversationId)?.turnId || null;
    const text = String(caption || "").slice(0, 500);
    const [row] = recordChatFiles(conversationId, [kept], { direction: "out", turnId, caption: text, via });
    const file = row ? { id: row.id, name: row.name, size: row.size, path: row.path } : kept;
    const event = publish(conversationId, "files", { from: "agent", caption: text, files: [file] }, { turnId });
    return { conversationId, file, event };
  } catch (err) {
    console.warn(`[chat-files] a file the agent sent could not be kept for the dashboard: ${err.message}`);
    return null;
  }
}

/**
 * Files someone sent in with a message, kept as copies in the uploads folder ([{ name, size, path }]): kept with the
 * conversation on that message, and told to the pages showing it ("files" with from "in" and the message's id).
 * Returns the kept rows. Best-effort, as noteSentFile.
 */
export function noteReceivedFiles({ conversationId, messageId = null, files = [], via = "" }) {
  try {
    if (!conversationId || !files.length) return [];
    const rows = recordChatFiles(conversationId, files, { direction: "in", messageId, via });
    if (rows.length) publish(conversationId, "files", { from: "in", messageId, files: rows.map((r) => ({ id: r.id, name: r.name, size: r.size, path: r.path })) });
    return rows;
  } catch (err) {
    console.warn(`[chat-files] files sent in could not be kept with the chat: ${err.message}`);
    return [];
  }
}

const PICTURE_EXT = { "image/png": ".png", "image/jpeg": ".jpg", "image/jpg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/heic": ".heic" };

/**
 * [providers/claude-code.js] The pictures a message handed the agent as bytes (a photo sent on Telegram, Discord or
 * WhatsApp): a copy each in the uploads folder, kept with the person's message they came with (messageId: the
 * message the turn answers, which the channel saved; else the latest one in the conversation), since no note in that
 * message names them. PDFs always come with a note, so they are left to
 * it. Skipped when that message has files on record already (the dashboard's own upload kept them first).
 * blocks: the turn's media blocks ({ type: "image", source: { media_type, data } }). Returns the kept rows.
 */
export function noteMediaBlocks(conversationId, blocks, { messageId: given = null, via = "", dir = uploadsDir(), now = Date.now() } = {}) {
  try {
    const pictures = (blocks || []).filter((b) => b?.type === "image" && typeof b.source?.data === "string" && b.source.data);
    if (!conversationId || !pictures.length) return [];
    const messageId = given || latestUserMessageId(conversationId);
    if (!messageId || messageHasFiles(messageId)) return [];
    fs.mkdirSync(dir, { recursive: true });
    tidyKeptFiles(dir, now);
    const files = pictures.map((b, i) => {
      const name = `image${pictures.length > 1 ? `-${i + 1}` : ""}${PICTURE_EXT[String(b.source.media_type || "").toLowerCase()] || ".png"}`;
      const file = path.join(dir, `chat-${now}-${i}-${name}`);
      const buffer = Buffer.from(b.source.data, "base64");
      fs.writeFileSync(file, buffer);
      return { name, size: buffer.length, path: file };
    });
    return noteReceivedFiles({ conversationId, messageId, files, via });
  } catch { return []; }
}

/** The real path of a file the page may look at, or null: it must exist and sit inside the uploads folder. */
export function viewablePath(p, { dir = uploadsDir() } = {}) {
  if (typeof p !== "string" || !p || p.includes("\0")) return null;
  try {
    const root = fs.realpathSync(dir);
    const real = fs.realpathSync(path.resolve(p));
    if (!real.startsWith(root + path.sep) || !fs.statSync(real).isFile()) return null;
    return real;
  } catch { return null; }
}

// Kinds a browser can show without running anything. SVG and HTML are not here on purpose.
const INLINE = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".heic": "image/heic", ".bmp": "image/bmp", ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".ogv": "video/ogg", ".mkv": "video/x-matroska", ".3gp": "video/3gpp",
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg", ".opus": "audio/ogg", ".flac": "audio/flac",
};
const TEXT = new Set([".txt", ".md", ".csv", ".tsv", ".json", ".jsonl", ".log", ".yml", ".yaml", ".xml", ".html", ".htm", ".svg", ".css", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".sh", ".sql", ".ini", ".toml", ".env", ".srt", ".vtt", ".rb", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".php",
  ".markdown", ".zsh", ".conf", ".kt", ".swift", ".lua", ".diff", ".patch", ".tex"]);

/** How a file is sent to the browser: { type, download } (download: offered to save, not shown). */
export function viewKind(file) {
  const ext = path.extname(file).toLowerCase();
  if (INLINE[ext]) return { type: INLINE[ext], download: false };
  if (TEXT.has(ext)) return { type: "text/plain; charset=utf-8", download: false };   // web pages and scripts too: shown as text, never run
  return { type: "application/octet-stream", download: true };
}

/** A file's name for its Content-Disposition: what the bots and the chat put in front taken off, nothing that could break the header. */
export const dispositionName = (file) => shownName(file).replace(/[^\w.\- ()]/g, "_") || "file";

/**
 * Send a file to look at in the page (inline, as what it is) or, with save, to keep (attachment). Range requests are
 * answered (a video seeks, a sound's waveform and a text's start are fetched without the rest). Nothing in it may run:
 * every kind but a PDF goes out under a sandbox policy (a PDF needs the browser's own viewer, which a sandbox blocks;
 * the viewer draws PDFs itself with pdf.js from the bytes).
 */
export function sendViewable(res, file, { save = false, cache = "private, max-age=3600" } = {}) {
  const { type, download } = viewKind(file);
  res.setHeader("Content-Type", type);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", `${download || save ? "attachment" : "inline"}; filename="${dispositionName(file)}"`);
  res.setHeader("Cache-Control", cache);
  if (type !== "application/pdf") res.setHeader("Content-Security-Policy", "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; media-src 'self'");
  res.sendFile(file, { dotfiles: "allow", cacheControl: false, acceptRanges: true }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
}
