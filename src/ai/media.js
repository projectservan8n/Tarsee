/**
 * media.js: what a message's pictures, PDFs and voice notes become for the AI that answers it (design 4.12).
 *
 * The turn layer calls adaptMedia(content, caps, ctx) on the person's message before the engine runs, with caps
 * from provider-registry capsFor() for the model answering:
 *  - Pictures stay pictures for a model that sees (caps.vision), in a kind every engine here opens (PNG, JPEG, GIF,
 *    WebP). Claude Code sends them as image blocks; Codex takes image files, which the Codex engine writes with
 *    writeLocalImages() and removes when the turn ends. A model that can't see gets the picture saved to the
 *    uploads folder and a note with its path.
 *  - PDFs stay PDFs where the model reads them itself (caps.pdf: Claude models on Claude Code). Anywhere else the
 *    PDF is saved to the uploads folder and its text goes into the message (whole pages, up to about 30,000
 *    characters), with the path and "use the tarsee_pdf_read tool for the rest".
 *  - Voice notes: no AI here takes sound as it is, so on every engine they become their transcript, from the local
 *    speech-to-text (voice/stt-handler.js transcribeAudio, which only uses the paid Whisper API when the owner chose
 *    it). One that can't be transcribed is saved, and the note says why.
 * Every picture is also kept with the chat (lib/sent-files.js noteMediaBlocks) when ctx.conversationId is given, so
 * the dashboard shows it on the person's message; a model that can't see is pointed at that same copy.
 *
 * Returns { text, media, content, saved, notes }:
 *   text     the message's words, with each note, transcript or PDF text where the thing it replaced was
 *   media    what the model takes as it is: image and document blocks (base64), in the message's order
 *   content  a Claude Code user message's content: the media blocks then the text, or just the text when no
 *            media is kept
 *   saved    the files this put on disk or pointed at: [{ kind: "image" | "pdf" | "audio", name, size, path }]
 *   notes    the notes added, for the log
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { uploadsDir as defaultUploadsDir, safeFileName, tidyKeptFiles, noteMediaBlocks } from "../lib/sent-files.js";
import { chatFilesFor, latestUserMessageId } from "../lib/chat-files.js";
import { pdfText, fitPages, PDF_INLINE_CHARS } from "../lib/pdf-text.js";

export { PDF_INLINE_CHARS };

/** All the PDF text one message carries inline, however many PDFs it has. */
export const PDF_INLINE_TOTAL_CHARS = 60_000;

/** Picture kinds every engine here opens (Claude and OpenAI models alike). */
const OPENABLE = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const EXT = {
  "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp", "image/heic": ".heic",
  "image/heif": ".heif", "image/bmp": ".bmp", "image/tiff": ".tiff", "image/avif": ".avif",
  "audio/wav": ".wav", "audio/x-wav": ".wav", "audio/wave": ".wav", "audio/mpeg": ".mp3", "audio/mp3": ".mp3",
  "audio/mp4": ".m4a", "audio/m4a": ".m4a", "audio/x-m4a": ".m4a", "audio/aac": ".aac", "audio/ogg": ".ogg",
  "audio/opus": ".opus", "audio/webm": ".webm", "audio/flac": ".flac",
};

const kindOf = (t) => {
  const k = String(t || "").toLowerCase().split(";")[0].trim();
  return k === "image/jpg" ? "image/jpeg" : k;
};
const hasData = (b) => typeof b?.source?.data === "string" && b.source.data.length > 0;
const isPicture = (b) => b?.type === "image" && hasData(b);
const isPdfBlock = (b) => b?.type === "document" && hasData(b) && (!b.source.media_type || kindOf(b.source.media_type) === "application/pdf");
const isAudio = (b) => b?.type === "audio" && hasData(b);
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The file each block was saved to (or found kept as), so adapting the same message again (the turn layer's retry
 * or backup model) points at the same file instead of writing another copy.
 */
const fileOfBlock = new WeakMap();

/**
 * Adapt a message's content for a model. content: a string, or blocks ({ type: "text", text },
 * { type: "image" | "document" | "audio", source: { type: "base64", media_type, data } }). caps: capsFor()'s
 * { vision, pdf, ... } (null: a model nothing is known about, so it sees no pictures and reads no PDFs).
 * ctx (all optional):
 *   label            the model's name for the notes ("DeepSeek Pro"); default "This AI"
 *   conversationId   keep the pictures with this chat (noteMediaBlocks), with messageId and via; a file already
 *                    kept with that message (the dashboard's upload) is pointed at instead of saved again
 *   uploadsDir       where files are saved (default: the workspace's uploads folder)
 *   settingsStore    for speech-to-text's choices (`store`, the turn layer's name for it, works too)
 *   transcribe       (buffer, language, { settingsStore }) => { transcript }; default the local speech-to-text
 *   language         for speech-to-text (default "en")
 *   noteMediaBlocks, chatFilesFor, pdfText   swapped by tests
 *   now              the time in saved files' names (default now)
 */
export async function adaptMedia(content, caps, ctx = {}) {
  const out = { text: "", media: [], content: "", saved: [], notes: [] };
  if (!Array.isArray(content)) {
    out.text = typeof content === "string" ? content : "";
    out.content = out.text;
    return out;
  }
  const label = typeof ctx.label === "string" && ctx.label.trim() ? ctx.label.trim() : "This AI";
  const vision = !!caps?.vision;
  const nativePdf = !!caps?.pdf;
  const now = Number.isFinite(ctx.now) ? ctx.now : Date.now();
  const dir = ctx.uploadsDir || defaultUploadsDir();
  let seq = 0;
  let tidied = false;
  const save = (kind, name, buffer) => {
    fs.mkdirSync(dir, { recursive: true });
    if (!tidied) { tidyKeptFiles(dir, now); tidied = true; }
    const safe = safeFileName(name);
    const n = seq++;
    let file = path.join(dir, `chat-${now}-${n}-${safe}`);
    for (let k = 1; fs.existsSync(file); k++) file = path.join(dir, `chat-${now + k}-${n}-${safe}`);
    fs.writeFileSync(file, buffer);
    const row = { kind, name: safe, size: buffer.length, path: file };
    out.saved.push(row);
    return row;
  };
  const use = (kind, r) => {
    const row = { kind, name: r.name || path.basename(r.path), size: r.size || 0, path: r.path };
    out.saved.push(row);
    return row;
  };
  let copies = null;
  /** The file for a block: the one it was saved to before, the one kept with the chat, or a new one. Throws when it can't be saved. */
  const fileFor = (block, kind, name, bytes, kept = null) => {
    const before = fileOfBlock.get(block);
    let row;
    if (before && fs.existsSync(before.path)) row = use(kind, before);
    else if (kept?.path && fs.existsSync(kept.path)) row = use(kind, kept);
    else {
      copies ??= keptCopies(ctx);
      const copy = findCopy(copies, bytes);
      row = copy ? use(kind, copy) : save(kind, name, bytes);
    }
    fileOfBlock.set(block, row);
    return row;
  };
  const settingsStore = ctx.settingsStore || ctx.store || null;

  const pictures = content.filter(isPicture);
  const keptWithChat = keepWithChat(pictures, ctx);
  let pdfBudget = PDF_INLINE_TOTAL_CHARS;
  const parts = [];
  const note = (t) => { parts.push(t); out.notes.push(t); };

  let pic = 0;
  for (const block of content) {
    if (block?.type === "text") {
      if (typeof block.text === "string" && block.text) parts.push(block.text);
      continue;
    }

    if (isPicture(block)) {
      const type = kindOf(block.source.media_type || "image/png");
      const kept = keptWithChat[pic];
      pic++;
      if (vision && OPENABLE.has(type)) {
        out.media.push({ type: "image", source: { type: "base64", media_type: type, data: block.source.data } });
        continue;
      }
      let where;
      try {
        const name = `image${pictures.length > 1 ? `-${pic}` : ""}${EXT[type] || ".png"}`;
        where = fileFor(block, "image", name, Buffer.from(block.source.data, "base64"), kept).path;
      } catch (err) {
        where = null;
        console.warn(`[media] a picture could not be saved: ${err.message}`);
      }
      const saved = where ? `so it was saved to ${where} instead` : "and it could not be saved";
      note(vision
        ? `[Image attached (${type}): ${label} can't open this kind of image, ${saved}.]`
        : `[Image attached: ${label} can't see images, ${saved}. If the person asks about it, say you can't see pictures with this model; you can still work with the file.]`);
      continue;
    }

    if (isPdfBlock(block)) {
      if (nativePdf) {
        out.media.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: block.source.data } });
        continue;
      }
      const bytes = Buffer.from(block.source.data, "base64");
      const given = [block.name, block.title, block.source.name].find((v) => typeof v === "string" && v.trim());
      const name = given ? (/\.pdf$/i.test(given) ? given : `${given}.pdf`) : "document.pdf";
      let where = null;
      try { where = fileFor(block, "pdf", name, bytes).path; } catch (err) { console.warn(`[media] a PDF could not be saved: ${err.message}`); }
      const at = where ? `saved to ${where}` : "it could not be saved";
      let r;
      try { r = await (ctx.pdfText || pdfText)(bytes); } catch (err) { r = { pages: [], error: err.message }; }
      const pages = Array.isArray(r?.pages) ? r.pages : [];
      const total = pages.length;
      const cant = `${label} can't read PDF files directly`;
      if (!total) {
        note(`[PDF attached, ${at}. ${cant}, and this one could not be read (${r?.error || "no pages were found in it"}).]`);
      } else if (!pages.some((p) => p.trim())) {
        note(`[PDF attached, ${at} (${plural(total, "page")}). ${cant}, and no text could be taken out of this one: it may be scanned pages (pictures of text). Work with the file at that path.]`);
      } else if (pdfBudget < 2_000) {
        note(`[PDF attached, ${at} (${plural(total, "page")}). ${cant}; read it with the tarsee_pdf_read tool and that path.]`);
      } else {
        const fit = fitPages(pages, { first: 1, maxChars: Math.min(PDF_INLINE_CHARS, pdfBudget) });
        pdfBudget -= fit.text.length;
        const whole = fit.last === total && !fit.partial;
        const next = fit.partial ? fit.last : fit.last + 1;
        const head = whole
          ? `[PDF attached, ${at} (${plural(total, "page")}). ${cant}, so here is its text:]`
          : `[PDF attached, ${at} (${total} pages). ${cant}, so here is the text of pages 1-${fit.last} of ${total}${fit.partial ? " (cut short)" : ""}. For the rest, use the tarsee_pdf_read tool with that path and pages "${next}-${total}".]`;
        note(`${head}\n<pdf-text>\n${fit.text}\n</pdf-text>`);
      }
      continue;
    }

    if (isAudio(block)) {
      const bytes = Buffer.from(block.source.data, "base64");
      try {
        const transcribe = ctx.transcribe || (await import("../voice/stt-handler.js")).transcribeAudio;
        const r = await transcribe(bytes, ctx.language || "en", { settingsStore });
        const said = String(r?.transcript ?? "").trim();
        note(said ? `[Voice note transcript] ${said}` : "[Voice note: nothing could be made out in it.]");
      } catch (err) {
        let where = null;
        try { where = fileFor(block, "audio", `voice-note${EXT[kindOf(block.source.media_type)] || ".audio"}`, bytes).path; } catch { /* the note says so */ }
        const why = String(err?.message || "speech-to-text failed").trim().replace(/\.$/, "");
        note(`[Voice note: it couldn't be transcribed (${why}).${where ? ` It was saved to ${where}.` : ""}]`);
      }
      continue;
    }
    // Anything else (a block kind no engine takes) is left out of the turn.
  }

  out.text = parts.join("\n\n");
  out.content = out.media.length ? [...out.media, ...(out.text ? [{ type: "text", text: out.text }] : [])] : out.text;
  return out;
}

/** Keep the message's pictures with its chat (once: noteMediaBlocks skips a message that has files already). [{ path, name, size } | undefined] per picture. */
function keepWithChat(pictures, ctx) {
  if (!pictures.length || !ctx.conversationId) return [];
  try {
    const keep = ctx.noteMediaBlocks || noteMediaBlocks;
    const blocks = pictures.map((b) => ({ type: "image", source: { type: "base64", media_type: kindOf(b.source.media_type || "image/png"), data: b.source.data } }));
    const rows = keep(ctx.conversationId, blocks, { messageId: ctx.messageId || null, via: ctx.via || "" });
    return Array.isArray(rows) && rows.length === pictures.length ? rows : [];
  } catch {
    return [];
  }
}

/** The files kept with the person's message (the dashboard's uploads, pictures already noted): [{ path, size, name }]. */
function keptCopies(ctx) {
  if (!ctx.conversationId) return [];
  try {
    const rows = (ctx.chatFilesFor || chatFilesFor)(ctx.conversationId);
    const messageId = ctx.messageId || (ctx.chatFilesFor ? null : latestUserMessageId(ctx.conversationId));
    return (Array.isArray(rows) ? rows : []).filter((r) => r?.path && r.from === "in" && (!messageId || r.messageId === messageId));
  } catch {
    return [];
  }
}

/** A kept file with exactly these bytes, or null. */
function findCopy(copies, bytes) {
  for (const r of copies) {
    try {
      if (r.size && r.size !== bytes.length) continue;
      if (fs.statSync(r.path).size === bytes.length && fs.readFileSync(r.path).equals(bytes)) return r;
    } catch { /* gone: the next one */ }
  }
  return null;
}

/**
 * Codex takes pictures as files: write each image block in `media` to a new private folder (under `dir`, default
 * the system's temp folder). Returns { inputs: [{ type: "local_image", path }], dir, cleanup() }; cleanup()
 * removes the folder, and the turn calls it when it ends.
 */
export function writeLocalImages(media, { dir = os.tmpdir() } = {}) {
  const pictures = (Array.isArray(media) ? media : []).filter(isPicture);
  if (!pictures.length) return { inputs: [], dir: null, cleanup() {} };
  fs.mkdirSync(dir, { recursive: true });
  const folder = fs.mkdtempSync(path.join(dir, "tarsee-images-"));
  try {
    const inputs = pictures.map((b, i) => {
      const file = path.join(folder, `image-${i + 1}${EXT[kindOf(b.source.media_type)] || ".png"}`);
      fs.writeFileSync(file, Buffer.from(b.source.data, "base64"), { mode: 0o600 });
      return { type: "local_image", path: file };
    });
    return { inputs, dir: folder, cleanup() { try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* gone already */ } } };
  } catch (err) {
    try { fs.rmSync(folder, { recursive: true, force: true }); } catch { /* best effort */ }
    throw err;
  }
}
