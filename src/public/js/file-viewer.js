/**
 * The chat's files, in our own UI: a sound as a small waveform player that plays where it is (the cards are
 * chat-files.js), and the viewer that opens over the page when a file is clicked or tapped. In the viewer a video plays, a picture zooms (the wheel, a click, a pinch, dragged about), a sound
 * plays on its waveform, a PDF shows its pages (pdf.js, so phones show it too instead of downloading it), text, code,
 * CSV and JSON read as text or a table, and anything else shows its name and size. Download is always there.
 * Esc or the X closes it; the arrows, the buttons or a swipe go to the next and previous file in that chat.
 *
 * Ported from TarseeMacOS. The pure parts: file-viewer-core.js (test/chat-files.test.js).
 */
import { kindOf, textShape, parseCsv, prettyJson, peaksOf, clock, nextSpeed, seekAt, saveUrl, typeLabel } from "./file-viewer-core.js";

const PDFJS = "https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38";
const TEXT_MAX = 300_000;
const DECODE_MAX = 60 * 1024 * 1024;   // a sound bigger than this is not decoded for its waveform: it plays on even bars

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text != null) node.textContent = text;
  return node;
};
const icon = (name, cls = "") => { const i = el("i", `ph ph-${name}${cls ? ` ${cls}` : ""}`); i.setAttribute("aria-hidden", "true"); return i; };
const button = (cls, label, iconName, text) => {
  const b = el("button", cls);
  b.type = "button";
  if (label) b.setAttribute("aria-label", label);
  if (iconName) b.append(icon(iconName));
  if (text) b.append(el("span", null, text));
  return b;
};
export const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${Math.round(n / 1024)} KB` : `${Math.round((n / 1048576) * 10) / 10} MB`);

/** Fetch one of the chat's files the way the rest of the page asks the server (its sign-in, its token). */
async function fetchFile(f, opts = {}) {
  if (f.file) return new Response(opts.headers?.Range ? f.file.slice(0, TEXT_MAX) : f.file);
  const res = typeof API !== "undefined" ? await API.request(f.url, opts) : await fetch(f.url, { ...opts, credentials: "same-origin" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

// ---------------------------------------------------------------- the waveform player

const peakCache = new Map();   // url → Promise<number[]>: each file is decoded once a page
const PEAK_KEY = "of-peaks:";
/** The waveform of a sound (200 bars), from this page's cache, the browser's, or decoded now. */
function peaksFor(f) {
  const key = f.file ? `${f.name}:${f.size}:${f.file.lastModified}` : f.url;
  if (peakCache.has(key)) return peakCache.get(key);
  const job = (async () => {
    try { const kept = JSON.parse(sessionStorage.getItem(PEAK_KEY + key) || "null"); if (Array.isArray(kept) && kept.length) return kept; } catch { /* storage blocked */ }
    if (f.size > DECODE_MAX) return null;
    const bytes = await (await fetchFile(f)).arrayBuffer();
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx();
    try {
      const buf = await new Promise((resolve, reject) => { const p = ctx.decodeAudioData(bytes, resolve, reject); p?.catch?.(reject); });
      const chans = [buf.getChannelData(0)];
      if (buf.numberOfChannels > 1) chans.push(buf.getChannelData(1));
      const peaks = peaksOf(chans, 200).map((v) => Math.round(v * 100) / 100);
      try { sessionStorage.setItem(PEAK_KEY + key, JSON.stringify(peaks)); } catch { /* full, or blocked */ }
      return peaks;
    } finally { ctx.close?.().catch?.(() => {}); }
  })().catch(() => null);
  peakCache.set(key, job);
  return job;
}

/** n bars from a waveform of any length (the loudest of each group). */
const squeeze = (peaks, n) => Array.from({ length: n }, (_, i) => {
  const from = Math.floor((i * peaks.length) / n), to = Math.max(from + 1, Math.floor(((i + 1) * peaks.length) / n));
  return Math.max(...peaks.slice(from, to));
});

/**
 * A sound as a waveform: play and pause, click or drag on the bars to go there, the time and the length, and (full
 * size) a speed button. Space plays or pauses while it has the focus; in a chat the arrows go 5 seconds back or on.
 * compact: the small one in a chat message. Returns { root, audio, stop }.
 */
export function waveformPlayer(f, { compact = false, autoplay = false, onOpen = null } = {}) {
  const root = el("div", `of-wave${compact ? " is-compact" : ""}`);
  root.tabIndex = 0;
  root.setAttribute("role", "group");
  root.setAttribute("aria-label", `${f.name}: a sound. Space plays or pauses.`);
  const audio = el("audio");
  audio.preload = "metadata";
  audio.src = f.url;
  const play = button("of-wave-play", "Play", "play");
  const bars = el("canvas", "of-wave-bars");
  bars.setAttribute("aria-hidden", "true");
  const time = el("span", "of-wave-time", "0:00");
  const speed = compact ? null : button("of-wave-speed", "Speed", null, "1x");
  const top = compact ? el("div", "of-wave-top") : null;
  if (compact) {
    const name = onOpen ? button("of-wave-name", `Open ${f.name}`, null, f.name) : el("span", "of-wave-name", f.name);
    if (onOpen) name.addEventListener("click", onOpen);
    top.append(name, time);
    const mid = el("div", "of-wave-mid");
    mid.append(bars, top);
    root.append(play, mid, audio);
  } else root.append(play, bars, time, speed, audio);

  let peaks = null, raf = 0, dragging = false;
  const accent = () => getComputedStyle(root).getPropertyValue("--accent").trim() || "#c45a35";
  function draw() {
    const w = bars.clientWidth, h = bars.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (bars.width !== Math.round(w * dpr)) { bars.width = Math.round(w * dpr); bars.height = Math.round(h * dpr); }
    const g = bars.getContext("2d");
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const n = Math.max(16, Math.min(compact ? 48 : 160, Math.floor(w / 4)));   // a bar every 4 px or so, whatever the width
    const list = peaks ? squeeze(peaks, n) : new Array(n).fill(0.18);
    const slot = w / n, bw = Math.max(1.5, slot * 0.62);
    const done = audio.duration ? audio.currentTime / audio.duration : 0;
    const lit = accent();
    list.forEach((v, i) => {
      const bh = Math.max(2, v * (h - 2));
      const x = i * slot + (slot - bw) / 2, y = (h - bh) / 2;
      g.fillStyle = (i + 0.5) / n <= done ? lit : peaks ? "rgba(255,255,255,0.38)" : "rgba(255,255,255,0.18)";
      g.beginPath();
      if (g.roundRect) g.roundRect(x, y, bw, bh, bw / 2); else g.rect(x, y, bw, bh);
      g.fill();
    });
  }
  const showTime = () => {
    const len = Number.isFinite(audio.duration) ? audio.duration : 0;
    time.textContent = audio.currentTime > 0 || !audio.paused ? `${clock(audio.currentTime)} / ${clock(len)}` : clock(len);
  };
  const tick = () => { draw(); showTime(); raf = audio.paused ? 0 : requestAnimationFrame(tick); };
  const setIcon = () => {
    play.replaceChildren(icon(audio.paused ? "play" : "pause"));
    play.setAttribute("aria-label", audio.paused ? "Play" : "Pause");
    root.classList.toggle("is-playing", !audio.paused);
  };
  const toggle = () => {
    if (audio.paused) {
      // One sound at a time on the page.
      for (const other of document.querySelectorAll(".of-wave audio")) if (other !== audio && !other.paused) other.pause();
      audio.play().catch(() => {});
    } else audio.pause();
  };
  let loading = null;
  const load = () => (loading ||= peaksFor(f).then((p) => { if (p) peaks = p; root.classList.toggle("is-flat", !p); draw(); }));
  audio.addEventListener("play", () => { setIcon(); load(); if (!raf) raf = requestAnimationFrame(tick); });
  audio.addEventListener("pause", () => { setIcon(); tick(); });
  audio.addEventListener("ended", () => { setIcon(); tick(); });
  audio.addEventListener("loadedmetadata", () => { showTime(); draw(); });
  audio.addEventListener("error", () => { root.classList.add("is-broken"); time.textContent = "Can't play here"; });
  play.addEventListener("click", (e) => { e.stopPropagation(); toggle(); });
  speed?.addEventListener("click", (e) => {
    e.stopPropagation();
    audio.playbackRate = nextSpeed(audio.playbackRate);
    speed.querySelector("span").textContent = `${audio.playbackRate}x`;
  });
  const seek = (e) => {
    const r = bars.getBoundingClientRect();
    const at = seekAt(e.clientX - r.left, r.width);
    if (Number.isFinite(audio.duration)) audio.currentTime = at * audio.duration;
    tick();
  };
  bars.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    dragging = true;
    bars.setPointerCapture?.(e.pointerId);
    load();
    if (!Number.isFinite(audio.duration)) { audio.addEventListener("loadedmetadata", () => seek(e), { once: true }); audio.load(); return; }
    seek(e);
  });
  bars.addEventListener("pointermove", (e) => { if (dragging) seek(e); });
  bars.addEventListener("pointerup", () => { dragging = false; });
  bars.addEventListener("pointercancel", () => { dragging = false; });
  bars.addEventListener("click", (e) => e.stopPropagation());
  root.addEventListener("keydown", (e) => {
    if (e.target !== root && e.target !== bars) return;   // (its buttons have their own Space)
    if (e.key === " " || e.key === "Spacebar") { e.preventDefault(); e.stopPropagation(); toggle(); }
    // (In the viewer the arrows go to the next and previous file; in a chat they go 5 seconds back or on.)
    else if (compact && (e.key === "ArrowLeft" || e.key === "ArrowRight") && Number.isFinite(audio.duration)) {
      e.preventDefault(); e.stopPropagation();
      audio.currentTime = Math.max(0, Math.min(audio.duration, audio.currentTime + (e.key === "ArrowLeft" ? -5 : 5)));
      tick();
    }
  });
  // Drawn when it has a size; the full one decodes now, the small one once it is on screen.
  const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => draw()) : null;
  ro?.observe(bars);
  if (compact && typeof IntersectionObserver !== "undefined") {
    const io = new IntersectionObserver((es) => { if (es.some((x) => x.isIntersecting)) { io.disconnect(); load(); } });
    io.observe(root);
  } else load();
  setIcon();
  if (autoplay) requestAnimationFrame(() => toggle());
  return { root, audio, stop: () => { audio.pause(); cancelAnimationFrame(raf); ro?.disconnect(); } };
}

// ---------------------------------------------------------------- the viewer

/** A picture that zooms: the wheel, a click (or a double tap) to go in and out, a pinch, and dragged about once in. */
function zoomable(f, view) {
  const stage = el("div", "of-viewer-stage");
  const img = el("img");
  img.alt = f.name;
  img.src = f.url;
  img.draggable = false;
  const tools = el("div", "of-viewer-zoom");
  const out = button("of-icon-btn", "Zoom out", "magnifying-glass-minus");
  const pct = button("of-zoom-pct", "Fit to the screen", null, "Fit");
  const inn = button("of-icon-btn", "Zoom in", "magnifying-glass-plus");
  tools.append(out, pct, inn);
  stage.append(img, tools);
  let s = 1, tx = 0, ty = 0;
  const pts = new Map();
  let pinch = null, moved = 0, lastTap = 0;
  const clamp = () => {
    const W = img.clientWidth * s, H = img.clientHeight * s;
    const mx = Math.max(0, (W - stage.clientWidth) / 2), my = Math.max(0, (H - stage.clientHeight) / 2);
    tx = Math.max(-mx, Math.min(mx, tx));
    ty = Math.max(-my, Math.min(my, ty));
  };
  const apply = () => {
    if (s <= 1.001) { s = 1; tx = 0; ty = 0; }
    clamp();
    img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    stage.classList.toggle("is-zoomed", s > 1);
    view.zoomed = s > 1;
    pct.querySelector("span").textContent = s > 1 ? `${Math.round(s * 100)}%` : "Fit";
  };
  const zoomTo = (next, cx, cy) => {
    const r = stage.getBoundingClientRect();
    const bx = r.left + r.width / 2, by = r.top + r.height / 2;
    const px = cx ?? bx, py = cy ?? by;
    const qx = (px - bx - tx) / s, qy = (py - by - ty) / s;
    s = Math.max(1, Math.min(8, next));
    tx = px - bx - s * qx;
    ty = py - by - s * qy;
    apply();
  };
  out.addEventListener("click", (e) => { e.stopPropagation(); zoomTo(s / 1.6); });
  inn.addEventListener("click", (e) => { e.stopPropagation(); zoomTo(s * 1.6); });
  pct.addEventListener("click", (e) => { e.stopPropagation(); zoomTo(1); });
  stage.addEventListener("wheel", (e) => { e.preventDefault(); zoomTo(s * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY); }, { passive: false });
  img.addEventListener("pointerdown", (e) => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    img.setPointerCapture?.(e.pointerId);
    moved = 0;
    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s };
    }
  });
  img.addEventListener("pointermove", (e) => {
    const was = pts.get(e.pointerId);
    if (!was) return;
    const now = { x: e.clientX, y: e.clientY };
    pts.set(e.pointerId, now);
    if (pts.size === 2 && pinch) {
      const [a, b] = [...pts.values()];
      zoomTo(pinch.s * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d), (a.x + b.x) / 2, (a.y + b.y) / 2);
      moved += 10;
    } else if (s > 1) {
      tx += now.x - was.x; ty += now.y - was.y;
      moved += Math.abs(now.x - was.x) + Math.abs(now.y - was.y);
      apply();
    }
  });
  const up = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (moved > 6) { view.dragAt = performance.now(); return; }
    if (e.pointerType === "mouse") { zoomTo(s > 1 ? 1 : 2.5, e.clientX, e.clientY); return; }
    const t = performance.now();
    if (t - lastTap < 320) { zoomTo(s > 1 ? 1 : 2.5, e.clientX, e.clientY); lastTap = 0; } else lastTap = t;
  };
  img.addEventListener("pointerup", up);
  img.addEventListener("pointercancel", up);
  img.addEventListener("click", (e) => e.stopPropagation());
  tools.addEventListener("click", (e) => e.stopPropagation());
  img.addEventListener("error", () => stage.replaceChildren(el("p", "of-viewer-note", "This picture can't be shown here (a HEIC from an iPhone, say). Download it to open it.")));
  return stage;
}

let pdfjs = null;
/** pdf.js, once: on the page itself (its worker module imported here, as the page's rules allow no worker from elsewhere). */
async function loadPdfjs() {
  if (!pdfjs) pdfjs = (async () => {
    const lib = await import(`${PDFJS}/build/pdf.min.mjs`);
    if (!globalThis.pdfjsWorker) globalThis.pdfjsWorker = await import(`${PDFJS}/build/pdf.worker.min.mjs`);
    lib.GlobalWorkerOptions.workerSrc = `${PDFJS}/build/pdf.worker.min.mjs`;
    return lib;
  })().catch((err) => { pdfjs = null; throw err; });
  return pdfjs;
}

/** A PDF's pages, drawn as they come on screen. */
async function pdfPages(f, body, view, say, still, opening = "Opening the PDF...") {
  say(opening);
  const lib = await loadPdfjs();
  const data = new Uint8Array(await (await fetchFile(f)).arrayBuffer());
  const doc = await lib.getDocument({ data, isEvalSupported: false, standardFontDataUrl: `${PDFJS}/standard_fonts/`, cMapUrl: `${PDFJS}/cmaps/`, cMapPacked: true }).promise;
  if (!still()) { doc.destroy(); return; }
  const box = el("div", "of-viewer-pdf");
  body.replaceChildren(box);
  view.info(`${doc.numPages} page${doc.numPages === 1 ? "" : "s"}`);
  view.cleanup = () => doc.destroy();
  const first = await doc.getPage(1);
  const v1 = first.getViewport({ scale: 1 });
  const width = () => Math.min(box.clientWidth - 2, 980);
  const io = new IntersectionObserver((es) => {
    for (const x of es) if (x.isIntersecting && !x.target.dataset.drawn) { x.target.dataset.drawn = "1"; draw(x.target); }
  }, { root: box, rootMargin: "600px 0px" });
  async function draw(canvas) {
    const page = await doc.getPage(Number(canvas.dataset.page));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const vp = page.getViewport({ scale: (width() / page.getViewport({ scale: 1 }).width) * dpr });
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise.catch(() => {});
  }
  for (let p = 1; p <= doc.numPages; p++) {
    const c = el("canvas", "of-viewer-page");
    c.dataset.page = String(p);
    c.setAttribute("aria-label", `Page ${p}`);
    c.style.aspectRatio = `${v1.width} / ${v1.height}`;
    box.append(c);
    io.observe(c);
  }
  const old = view.cleanup;
  view.cleanup = () => { io.disconnect(); old(); };
}

const thumbs = new Map();   // url -> Promise<data URL | null>: each PDF's first page drawn once a page
/**
 * A PDF's first page, small, as a picture's data URL (a file card's thumbnail in the dashboard's chat), or null.
 * Only for a PDF up to maxBytes: a bigger one keeps its plain card rather than be fetched whole for a thumbnail.
 */
export function pdfThumb(f, { width = 112, maxBytes = 8 * 1024 * 1024 } = {}) {
  if (!f?.url || (f.size && f.size > maxBytes)) return Promise.resolve(null);
  if (thumbs.has(f.url)) return thumbs.get(f.url);
  const job = (async () => {
    const lib = await loadPdfjs();
    const data = new Uint8Array(await (await fetchFile(f)).arrayBuffer());
    if (data.length > maxBytes) return null;
    const doc = await lib.getDocument({ data, isEvalSupported: false, standardFontDataUrl: `${PDFJS}/standard_fonts/`, cMapUrl: `${PDFJS}/cmaps/`, cMapPacked: true }).promise;
    try {
      const page = await doc.getPage(1);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const vp = page.getViewport({ scale: (width / page.getViewport({ scale: 1 }).width) * dpr });
      const canvas = el("canvas");
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
      return canvas.toDataURL("image/png");
    } finally { doc.destroy(); }
  })().catch(() => null);
  thumbs.set(f.url, job);
  return job;
}

/** A text file as it reads best: a table, laid-out JSON, prose or code. */
function textView(f, text, cut) {
  const shape = textShape(f.name);
  const more = cut ? el("p", "of-viewer-more", "The rest is in the download.") : null;
  if (shape === "csv" || shape === "tsv") {
    const rows = parseCsv(text, shape === "tsv" ? "\t" : ",", 1000);
    if (rows.length > 1 && rows.some((r) => r.length > 1)) {
      const wrap = el("div", "of-viewer-table");
      const table = el("table");
      const head = el("thead"), tr = el("tr");
      for (const c of rows[0]) tr.append(el("th", null, c));
      head.append(tr);
      const tb = el("tbody");
      for (const r of rows.slice(1)) { const row = el("tr"); for (const c of r) row.append(el("td", null, c)); tb.append(row); }
      table.append(head, tb);
      wrap.append(table);
      if (rows.length >= 1000 || cut) wrap.append(el("p", "of-viewer-more", "The first rows only. The rest is in the download."));
      return wrap;
    }
  }
  const pre = el("pre", shape === "prose" ? "is-prose" : "is-code", shape === "json" && !cut ? prettyJson(text) : text);
  if (!more) return pre;
  const wrap = el("div", "of-viewer-text");
  wrap.append(pre, more);
  return wrap;
}

/**
 * The viewer over the page (index.html's #viewer). Returns { open(files, i), close(), isOpen(), onKey(e) }.
 */
export function setupViewer() {
  const $ = (id) => document.getElementById(id);
  const view = { files: [], i: 0, back: null, zoomed: false, dragAt: 0, cleanup: null, n: 0, info: () => {} };

  async function open(files, i) {
    if (!files?.length) return;
    const box = $("viewer");
    if (box.hidden) view.back = document.activeElement;
    stopShown();
    Object.assign(view, { files, i: Math.max(0, Math.min(files.length - 1, i)), zoomed: false });
    const n = ++view.n;
    const still = () => view.n === n && !box.hidden;
    const f = files[view.i];
    const kind = kindOf(f);
    box.dataset.kind = kind;
    $("viewerName").textContent = f.name;
    const facts = [f.size ? fmtSize(f.size) : "", files.length > 1 ? `${view.i + 1} of ${files.length}` : ""];
    const infoText = (extra) => [...facts, extra].filter(Boolean).join(" · ");
    view.info = (extra) => { if (still()) $("viewerInfo").textContent = infoText(extra); };
    $("viewerInfo").textContent = infoText("");   // (now, not through still(): the box is not shown yet, and the last file's line stayed)
    $("viewerPrev").hidden = $("viewerNext").hidden = files.length < 2;
    $("viewerPrev").disabled = view.i === 0;
    $("viewerNext").disabled = view.i === files.length - 1;
    const save = $("viewerSave");
    save.href = saveUrl(f);
    save.setAttribute("download", f.name);
    const body = $("viewerBody");
    const say = (text, withSave = false) => {
      const card = el("div", "of-viewer-card");
      card.append(el("p", "of-viewer-note", text));
      if (withSave) card.append(saveButton(f));
      body.replaceChildren(card);
    };
    box.hidden = false;
    if (kind === "image") body.replaceChildren(zoomable(f, view));
    else if (kind === "video") {
      const v = el("video");
      v.controls = true;
      v.playsInline = true;
      v.autoplay = true;
      v.preload = "auto";
      v.src = f.url;
      v.addEventListener("error", () => { if (still()) say("This browser can't play this video. Download it to watch it.", true); }, { once: true });
      body.replaceChildren(v);
      v.play?.().catch(() => {});
    } else if (kind === "audio") {
      const p = waveformPlayer(f, { autoplay: true });
      const card = el("div", "of-viewer-sound");
      card.append(icon("waveform", "of-viewer-sound-icon"), el("strong", null, f.name), p.root);
      body.replaceChildren(card);
      view.cleanup = p.stop;
      requestAnimationFrame(() => p.root.focus({ preventScroll: true }));
    } else if (kind === "pdf") {
      try { await pdfPages(f, body, view, say, still); } catch {
        if (!still()) return;
        // pdf.js could not be had (offline from its address, say): the browser's own viewer, framed or in a tab.
        if (f.file) say("This PDF can't be shown here yet. Download it to read it.", true);
        else { const frame = el("iframe"); frame.title = f.name; frame.src = f.url; body.replaceChildren(frame); }
      }
    } else if (kind === "doc") {
      // A Word, PowerPoint or Excel file: the browser can't show it, so its card and Download.
      body.replaceChildren(otherCard(f, "This kind of file opens in its own app. Download it to open it."));
    } else if (kind === "text") {
      say("Loading...");
      try {
        const res = await fetchFile(f, { headers: { Range: `bytes=0-${TEXT_MAX - 1}` } });
        const text = (await res.text()).slice(0, TEXT_MAX);
        if (!still()) return;
        const total = Number(/\/(\d+)$/.exec(res.headers.get("content-range") || "")?.[1]) || f.size || 0;
        if (total && !f.size) facts[0] = fmtSize(total), view.info("");
        body.replaceChildren(textView(f, text, total > TEXT_MAX));
      } catch { if (still()) say("Couldn't load this file. It may have been cleared out.", true); }
    } else body.replaceChildren(otherCard(f, "There is no preview for this kind of file."));
    if (kind !== "audio") $("viewerClose").focus({ preventScroll: true });
  }

  /** A file with nothing to show: its name, kind and size, why, and Download. */
  function otherCard(f, why) {
    const card = el("div", "of-viewer-card is-other");
    card.append(icon("file", "of-viewer-file-icon"), el("strong", null, f.name), el("span", "of-muted", [typeLabel(f), f.size ? fmtSize(f.size) : ""].filter(Boolean).join(" · ")),
      el("p", "of-viewer-note", why), saveButton(f));
    return card;
  }

  function saveButton(f) {
    const a = el("a", "of-btn is-main");
    a.href = saveUrl(f);
    a.setAttribute("download", f.name);
    a.append(icon("download-simple"), el("span", null, "Download"));
    return a;
  }

  function stopShown() {
    try { view.cleanup?.(); } catch { /* already gone */ }
    view.cleanup = null;
    $("viewerBody").replaceChildren();   // stops a video or a sound that was playing
  }

  function close() {
    const box = $("viewer");
    if (box.hidden) return false;
    box.hidden = true;
    view.n++;
    stopShown();
    view.back?.focus?.({ preventScroll: true });
    return true;
  }

  const go = (d) => { const i = view.i + d; if (i >= 0 && i < view.files.length) open(view.files, i); };

  /** The keys while it is open: Esc closes it and nothing else; the arrows turn the page (not inside a player or a video). */
  function onKey(e) {
    if (e.key === "Escape") { e.preventDefault(); e.stopImmediatePropagation(); close(); return; }
    const inMedia = e.target?.closest?.("video, audio, input, textarea");
    if (inMedia) return;
    if (e.key === "ArrowLeft") go(-1);
    else if (e.key === "ArrowRight") go(1);
  }

  $("viewerClose").addEventListener("click", close);
  $("viewerPrev").addEventListener("click", () => go(-1));
  $("viewerNext").addEventListener("click", () => go(1));
  // A finger: swipe the file sideways for the next one, or the one before (not while a picture is zoomed in).
  let swipe = null, swipedAt = 0;
  $("viewerBody").addEventListener("pointerdown", (e) => { swipe = e.pointerType === "mouse" || !e.isPrimary ? null : { id: e.pointerId, x: e.clientX, y: e.clientY }; });
  $("viewerBody").addEventListener("pointerup", (e) => {
    if (!swipe || e.pointerId !== swipe.id) return;
    const dx = e.clientX - swipe.x, dy = e.clientY - swipe.y;
    swipe = null;
    if (view.zoomed || e.target.closest?.(".of-wave, .of-viewer-pdf, .of-viewer-table, pre")) return;
    if (Math.abs(dx) < 50 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    swipedAt = performance.now();
    go(dx < 0 ? 1 : -1);
  });
  $("viewer").addEventListener("click", (e) => {   // a click outside the file
    if (performance.now() - swipedAt < 500 || performance.now() - view.dragAt < 300) return;
    if (e.target === e.currentTarget || e.target.id === "viewerBody" || (e.target.classList?.contains("of-viewer-stage") && !view.zoomed)) close();
  });
  return { open, close, isOpen: () => !$("viewer").hidden, onKey };
}
