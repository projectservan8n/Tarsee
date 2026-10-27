/**
 * The files in the dashboard's chat: cards in the messages, and the viewer they open in. Ported from TarseeMacOS.
 *
 * The agent's files (send_file to Telegram, Discord, WhatsApp or the dashboard; the ones it emails) are kept with the
 * chat (src/lib/chat-files.js) and come with its history and on the live feed; so do the files people send in.
 *
 * A card for each: a picture as its thumbnail, a video as its first frame, a sound as the waveform player that plays
 * where it is, a PDF with its first page, anything else with its kind; the name, the kind and the size. A click or
 * a tap (or Enter) opens it in the viewer (file-viewer.js): a picture zooms, a video and a sound play, a PDF shows
 * its pages, text, code, CSV and JSON read as text or a table; anything else shows its name and size. Download is always there. Esc closes it; the
 * arrows go through the message's files.
 *
 * A plain script can't import, so this module puts window.ChatFiles up for chat.js and live.js (index.html loads it
 * as a module, before the page starts). The rules with no page are file-viewer-core.js (test/chat-files.test.js).
 */
import { kindOf, extOf, serverFile, splitNotes, typeLabel } from "./file-viewer-core.js";
import { setupViewer, waveformPlayer, fmtSize, pdfThumb } from "./file-viewer.js";

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};

let viewer = null;
function theViewer() {
  if (!viewer && document.getElementById("viewer")) {
    viewer = setupViewer();
    // While it is open the keys are its own: Esc closes it (and nothing under it), the arrows turn the page, and Tab
    // goes round its own buttons, never to the chat under it.
    window.addEventListener("keydown", (e) => {
      if (!viewer?.isOpen()) return;
      if (e.key === "Tab") {
        const box = document.getElementById("viewer");
        const stops = [...box.querySelectorAll("button, a[href], [tabindex]:not([tabindex='-1']), video, audio")].filter((n) => !n.disabled && !n.hidden && n.offsetParent !== null);
        if (!stops.length) return;
        const at = stops.indexOf(document.activeElement);
        if (e.shiftKey ? at <= 0 : at === stops.length - 1 || at < 0) {
          e.preventDefault();
          stops[e.shiftKey ? stops.length - 1 : 0].focus();
        }
        return;
      }
      viewer.onKey(e);
    }, true);
  }
  return viewer;
}

/** Open files in the viewer, at the i-th. */
export function open(files, i = 0) {
  const v = theViewer();
  if (v && files?.length) v.open(files, i);
}

/** A file kept on the server (a chat_files row, or one of a live event's files), as the cards and the viewer want it. */
export function fromServer(f) {
  return { ...serverFile(f), id: f.id ?? null, caption: String(f.caption || ""), gone: !!f.gone, from: f.from || "" };
}

/** A file still in this browser (picked in the composer, or just sent). */
export function fromLocal(file) {
  return { name: file.name || "file", size: file.size || 0, file, get url() { return (this._url ||= URL.createObjectURL(file)); } };
}

/** An attachment as the composer packs it ({ name, mediaType, data: base64 }), as a file in this browser. */
export function fromPacked(att) {
  try {
    const bin = atob(String(att?.data || ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return fromLocal(new File([bytes], att?.name || "file", { type: att?.mediaType || "application/octet-stream" }));
  } catch { return null; }
}

/** A message's words and the files its notes name ("[Attached file saved: ...]", what the bots add): { text, files }. */
export function split(text) {
  const out = splitNotes(text);
  return { text: out.text, files: out.files.map(fromServer) };
}

/** A video's first frame, fetched once the card is on screen (only its start: the server answers ranges). */
function firstFrame(card, f, face) {
  const v = el("video");
  v.muted = true;
  v.playsInline = true;
  v.preload = "metadata";
  v.setAttribute("aria-hidden", "true");
  v.tabIndex = -1;
  const go = () => { v.src = f.file ? f.url : `${f.url}#t=0.1`; };
  lazily(card, go);
  v.addEventListener("error", () => v.replaceWith(el("span", "chat-file-ext", (extOf(f.name) || "video").slice(0, 4).toUpperCase())), { once: true });
  face.append(v);
}

function lazily(node, fn) {
  if (typeof IntersectionObserver === "undefined") { fn(); return; }
  const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { io.disconnect(); fn(); } }, { rootMargin: "200px" });
  io.observe(node);
}

/** One card: a button that opens the file. */
function card(files, i) {
  const f = files[i];
  const kind = kindOf(f);
  const item = el("div", `chat-file-item is-${kind}${f.gone ? " is-gone" : ""}`);
  if (f.id != null) item.dataset.fileId = String(f.id);
  if (kind === "audio" && !f.gone) {
    const player = waveformPlayer(f, { compact: true, onOpen: () => open(files, i) });
    item.append(player.root);
  } else {
    const b = el("button", "chat-file");
    b.type = "button";
    b.title = f.name;
    b.setAttribute("aria-label", f.gone ? `${f.name}: no longer on the server` : `Open ${f.name}`);
    if (f.gone) b.disabled = true;
    const face = el("span", "chat-file-thumb");
    face.setAttribute("aria-hidden", "true");
    const ext = el("span", "chat-file-ext", (extOf(f.name) || extOf(f.path) || "file").slice(0, 4).toUpperCase());
    if (kind === "image" && !f.gone) {
      const img = el("img");
      img.loading = "lazy";
      img.decoding = "async";
      img.alt = "";
      img.src = f.url;
      img.addEventListener("error", () => img.replaceWith(ext), { once: true });   // (a HEIC this browser can't draw)
      face.append(img);
    } else if (kind === "video" && !f.gone) {
      firstFrame(b, f, face);
      face.append(el("span", "chat-file-play"));
    } else if (kind === "pdf" && !f.gone && !f.file) {
      face.append(ext);
      lazily(b, () => pdfThumb(f).then((src) => {
        if (!src) return;
        const img = el("img");
        img.alt = "";
        img.src = src;
        ext.replaceWith(img);
        face.classList.add("is-page");
      }));
    } else face.append(ext);
    const words = el("span", "chat-file-text");
    words.append(el("span", "chat-file-name", f.name), el("span", "chat-file-meta", f.gone ? "No longer on the server" : [typeLabel(f), f.size ? fmtSize(f.size) : ""].filter(Boolean).join(" · ")));
    b.append(face, words);
    b.addEventListener("click", () => open(files.filter((x) => !x.gone), Math.max(0, files.filter((x) => !x.gone).indexOf(f))));
    item.append(b);
  }
  if (f.caption) item.append(el("p", "chat-file-caption", f.caption));
  return item;
}

/**
 * The cards for a message's files: a row that wraps. Pictures and videos as tiles of their own, the rest as cards
 * with their name, kind and size.
 */
export function cards(files) {
  const list = (files || []).filter(Boolean);
  const row = el("div", "chat-files");
  row._files = list;
  list.forEach((_f, i) => row.append(card(list, i)));
  return row;
}

/** Cards for more files in a row already drawn (live): those it has not got yet. */
export function addCards(row, files) {
  const have = new Set([...row.querySelectorAll("[data-file-id]")].map((n) => n.dataset.fileId));
  const fresh = (files || []).filter((f) => f && !(f.id != null && have.has(String(f.id))));
  if (!fresh.length) return 0;
  const all = [...(row._files || []), ...fresh];
  row._files = all;
  for (const f of fresh) row.append(card(all, all.indexOf(f)));
  return fresh.length;
}

export function close() { return viewer?.close() || false; }
export function isOpen() { return !!viewer?.isOpen(); }

window.ChatFiles = Object.freeze({ cards, addCards, open, close, isOpen, split, fromServer, fromLocal, fromPacked, kindOf });
