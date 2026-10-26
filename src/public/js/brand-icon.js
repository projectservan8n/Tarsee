/**
 * Tarsee's icon (Settings → Appearance, "Tarsee's icon"): upload a picture (PNG, JPG, WebP or SVG, 10 MB at most),
 * crop it square in our own modal, and Tarsee's favicon, tab icons and installed-app icons all become it.
 *
 * The page draws the crop at 1024 by 1024 and sends that PNG (the master) and the file itself (the original) to
 * POST /api/settings/brand-icon; the server (src/lib/brand-icon.js) makes every size from the master and serves them
 * at the usual addresses (/favicon.ico, /icon-32.png, /apple-touch-icon.png, ...). Each icon has a version; the page
 * puts it on every icon address it shows (?v=), so a browser that kept the old picture asks again.
 *
 * On the window, from the moment this script runs (before Settings is ever opened):
 *
 *   TarseeBrand.version        the icon's version now (null until it is known)
 *   TarseeBrand.src(path)      an icon address with the version on it: src("/icon-32.png") is "/icon-32.png?v=..."
 *                              (anything that is not an icon address comes back as it was)
 *   "tarsee:icon-changed"      a window event, { detail: { version, initial } }, when the icon changes (initial: true
 *                              when it is only the version learned after the page loaded)
 *
 * The version comes from GET /api/settings/brand-icon, which needs a session: it is asked for when app.js says the
 * page is signed in ("tarsee:signed-in"), and again whenever the section comes into view. Until then the page's icon
 * links carry no version, which is fine: the server sends every icon with Cache-Control: no-cache, so the browser
 * checks it anyway. No browser dialogs (TarseeDialog asks the one question there is, before a reset).
 */
(function () {
  "use strict";
  if (window.TarseeBrand) return;

  const ICON_PATHS = ["/favicon.ico", "/icon-16.png", "/icon-32.png", "/apple-touch-icon.png", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"];
  const VERSIONED = new Set([...ICON_PATHS, "/manifest.json"]);
  const TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", svg: "image/svg+xml" };
  const MIMES = new Set([...Object.values(TYPES), "image/jpg", "image/pjpeg"]);   // (what some systems call a JPEG)
  const MAX_BYTES = 10 * 1024 * 1024;
  const MASTER_SIZE = 1024;     // what the server makes every size from
  const SVG_SIZE = 2048;        // an SVG is drawn this big (its longer side) before it is cropped
  const PREVIEW_SOURCE = 1024;  // the previews are drawn from a copy no bigger than this, so dragging stays smooth
  const STATUS_URL = "/api/settings/brand-icon";

  let version = null;           // the icon's version, once the server has said
  let status = null;            // the last { custom, version, updatedAt } from the server

  // ---------------------------------------------------------------- the version on the page

  /** An address's path when it is on this site, else null. */
  function pathOf(src) {
    try {
      const u = new URL(src, location.href);
      return u.origin === location.origin ? u.pathname : null;
    } catch { return null; }
  }

  function src(address) {
    const s = address == null ? "" : String(address);
    const bare = s.split(/[?#]/)[0];
    const p = pathOf(bare);
    if (!p || !VERSIONED.has(p)) return s;
    return version ? `${bare}?v=${encodeURIComponent(version)}` : bare;
  }

  /** Every icon the page shows (its favicon links, the manifest, the pictures of the icon) at the version now. */
  function refreshPage() {
    for (const link of document.querySelectorAll('link[rel~="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]')) {
      const href = link.getAttribute("href") || "";
      const p = pathOf(href);
      if (!p || !VERSIONED.has(p)) continue;
      const want = src(href);
      if (href === want) continue;
      if (/(^|\s)icon(\s|$)/.test(link.rel)) {
        // Some browsers look at a favicon again only when its link is a new element.
        const fresh = link.cloneNode(false);
        fresh.setAttribute("href", want);
        link.replaceWith(fresh);
      } else {
        link.setAttribute("href", want);
      }
    }
    for (const img of document.querySelectorAll("img[src]")) {
      const s = img.getAttribute("src");
      const p = pathOf(s);
      if (p && ICON_PATHS.includes(p)) { const want = src(s); if (s !== want) img.setAttribute("src", want); }
    }
  }

  let channel = null;
  try { channel = new BroadcastChannel("tarsee-brand-icon"); } catch { /* an old browser: other tabs find out on their next load */ }

  /** A version for the icon: the page is brought up to it, and whoever listens is told. */
  function setVersion(v, { initial = false, fromOtherTab = false } = {}) {
    if (!v || v === version) return;
    version = v;
    refreshPage();
    try { window.dispatchEvent(new CustomEvent("tarsee:icon-changed", { detail: { version: v, initial } })); } catch { /* nobody listening */ }
    if (!initial && !fromOtherTab && channel) { try { channel.postMessage({ version: v }); } catch { /* closed */ } }
  }
  if (channel) channel.addEventListener("message", (e) => { if (e.data && typeof e.data.version === "string") { setVersion(e.data.version, { fromOtherTab: true }); loadStatus(true); } });

  // ---------------------------------------------------------------- the server's word on it

  let asking = null, lastAsked = 0;

  /**
   * GET the icon's state. A plain fetch rather than API.json: API reloads the page on a 401, and a lapsed session
   * here should leave the page as it is.
   */
  function loadStatus(force) {
    if (asking) return asking;
    if (!force && Date.now() - lastAsked < 5000) return Promise.resolve(status);
    lastAsked = Date.now();
    asking = fetch(STATUS_URL, { credentials: "same-origin", cache: "no-store", headers: { Accept: "application/json" } })
      .then(async (res) => {
        if (!res.ok) return status;
        const s = await res.json();
        applyStatus(s, { initial: true });
        return s;
      })
      .catch(() => status)
      .finally(() => { asking = null; });
    return asking;
  }

  function applyStatus(s, { initial = false } = {}) {
    if (!s || typeof s.version !== "string") return;
    status = s;
    setVersion(s.version, { initial });
    showSection();
  }

  // app.js fires this once the session is good (on load with a live session, or after the password or PIN).
  window.addEventListener("tarsee:signed-in", () => loadStatus(true));

  // ---------------------------------------------------------------- the Settings section

  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  function say(text, isError) {
    const box = $("brandIconStatus");
    if (!box) return;
    box.textContent = text || "";
    box.classList.toggle("is-error", !!isError);
  }

  // (App is a top-level const in app.js, so it is a global but not a property of window.)
  const toast = (text) => { if (typeof App !== "undefined" && App.showToast) App.showToast(text, "success"); };

  function when(iso) {
    try { return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }); } catch { return ""; }
  }

  function showSection() {
    const img = $("brandIconCurrent");
    if (img) img.setAttribute("src", src("/icon-192.png"));
    const reset = $("brandIconResetBtn");
    if (reset && !reset.getAttribute("aria-busy")) reset.disabled = !(status && status.custom);
    const box = $("brandIconStatus");
    if (status && box && !box.classList.contains("is-error")) {
      say(status.custom ? `Using your own icon${status.updatedAt ? `, saved ${when(status.updatedAt)}` : ""}.` : "Using Tarsee's default icon.");
    }
  }

  function wireSection() {
    const section = $("brandIconSection");
    if (!section) return;
    const upload = $("brandIconUploadBtn"), file = $("brandIconFile"), reset = $("brandIconResetBtn");
    upload?.addEventListener("click", () => { if (file) { file.value = ""; file.click(); } });
    file?.addEventListener("change", () => { const f = file.files && file.files[0]; if (f) openFile(f); });
    reset?.addEventListener("click", onReset);
    // Fresh each time the section comes into view (the Appearance tab opened).
    if ("IntersectionObserver" in window) {
      new IntersectionObserver((seen) => { if (seen.some((e) => e.isIntersecting)) loadStatus(false); }).observe(section);
    }
    showSection();
  }

  async function onReset() {
    const reset = $("brandIconResetBtn");
    const yes = window.TarseeDialog
      ? await TarseeDialog.ask({
        title: "Go back to the default icon?",
        text: "Your uploaded icon is removed, and Tarsee's own icon comes back on the browser tab, the installed app and in chat.",
        yes: "Reset",
        no: "Cancel",
        danger: true,
        back: reset,
      })
      : false;
    if (!yes) return;
    if (reset) { reset.disabled = true; reset.setAttribute("aria-busy", "true"); }
    say("Going back to the default icon...");
    try {
      const s = await API.json(STATUS_URL, { method: "DELETE" });
      if (reset) reset.removeAttribute("aria-busy");
      applyStatus(s);
      say("Back to Tarsee's default icon.");
      toast("Tarsee's default icon is back.");
    } catch (err) {
      if (reset) { reset.removeAttribute("aria-busy"); reset.disabled = false; }
      say(`The icon could not be reset: ${err.message || err}`, true);
    }
  }

  // ---------------------------------------------------------------- opening the picture

  const extOf = (name) => { const m = /\.([a-z0-9]+)$/i.exec(name || ""); return m ? m[1].toLowerCase() : ""; };

  async function openFile(f) {
    const ext = extOf(f.name);
    if (!TYPES[ext] || (f.type && !MIMES.has(f.type))) return say("That file is not a PNG, JPG, WebP or SVG picture.", true);
    if (!f.size) return say("That file is empty.", true);
    if (f.size > MAX_BYTES) return say("That file is too big: 10 MB at most.", true);
    say("Opening the picture...");
    let picture;
    try {
      picture = await loadPicture(f, ext === "svg" || f.type === "image/svg+xml");
    } catch (err) {
      return say(err.message || "That picture could not be opened.", true);
    }
    say("");
    openCropper(f, ext, picture);
  }

  /** An SVG with a size to draw it at: its longer side SVG_SIZE (it keeps its shape), or a square when it says nothing. */
  async function sizedSvg(file) {
    const doc = new DOMParser().parseFromString(await file.text(), "image/svg+xml");
    const svg = doc.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== "svg" || doc.getElementsByTagName("parsererror").length) throw new Error("That SVG file could not be read.");
    const px = (v) => { const m = /^\s*([\d.]+)\s*(px)?\s*$/i.exec(v || ""); return m ? parseFloat(m[1]) : 0; };
    let w = px(svg.getAttribute("width")), h = px(svg.getAttribute("height"));
    const box = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    const hasBox = box.length === 4 && box.every(Number.isFinite) && box[2] > 0 && box[3] > 0;
    if (!(w > 0 && h > 0) && hasBox) { w = box[2]; h = box[3]; }
    if (w > 0 && h > 0) {
      if (!hasBox) svg.setAttribute("viewBox", `0 0 ${w} ${h}`);   // (so it scales up with its new size)
      const k = SVG_SIZE / Math.max(w, h);
      svg.setAttribute("width", String(Math.round(w * k)));
      svg.setAttribute("height", String(Math.round(h * k)));
    } else {
      // No size and no viewBox: nothing says how big it is meant to be, so a square of our own.
      svg.setAttribute("width", String(MASTER_SIZE));
      svg.setAttribute("height", String(MASTER_SIZE));
    }
    return new Blob([new XMLSerializer().serializeToString(doc)], { type: "image/svg+xml" });
  }

  /** The file as an <img>, ready: { img, url, width, height }. */
  async function loadPicture(file, isSvg) {
    const blob = isSvg ? await sizedSvg(file) : file;
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.decoding = "async";
    try {
      await new Promise((resolve, reject) => {
        img.addEventListener("load", resolve, { once: true });
        img.addEventListener("error", () => reject(new Error("That picture could not be opened: the file may be damaged.")), { once: true });
        img.src = url;
      });
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
    const width = img.naturalWidth, height = img.naturalHeight;
    if (!width || !height) { URL.revokeObjectURL(url); throw new Error("That picture has no size to crop."); }
    return { img, url, width, height };
  }

  // ---------------------------------------------------------------- drawing

  function canvasOf(w, h) {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  }
  function smooth(ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    return ctx;
  }

  /**
   * Part of a picture drawn into ctx at dw by dh, halving it in steps on the way down: in one big jump some browsers
   * skip most of the pixels and the result looks grainy. No step is over 4096 pixels across (an iPhone draws nothing
   * on a canvas much bigger than that).
   */
  function drawInto(ctx, source, sx, sy, sw, sh, dw, dh) {
    let from = source, x = sx, y = sy, w = sw, h = sh;
    while (w > dw * 2 && h > dh * 2) {
      const f = Math.min(0.5, 4096 / Math.max(w, h));
      const nw = Math.max(dw, Math.round(w * f)), nh = Math.max(dh, Math.round(h * f));
      const step = canvasOf(nw, nh);
      smooth(step.getContext("2d")).drawImage(from, x, y, w, h, 0, 0, nw, nh);
      from = step; x = 0; y = 0; w = nw; h = nh;
    }
    smooth(ctx).drawImage(from, x, y, w, h, 0, 0, dw, dh);
  }

  const blobOf = (canvas) => new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("The icon could not be made from this picture."))), "image/png");
    } catch {
      reject(new Error("The browser will not let this picture be read back: try a PNG or JPG."));
    }
  });

  const base64Of = (blob) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.addEventListener("load", () => resolve(String(r.result).replace(/^data:[^,]*,/, "")));
    r.addEventListener("error", () => reject(new Error("The file could not be read.")));
    r.readAsDataURL(blob);
  });

  // ---------------------------------------------------------------- the cropper

  function openCropper(file, ext, picture) {
    const { img, width: W, height: H } = picture;
    const maxSide = Math.min(W, H);
    let crop = { x: (W - maxSide) / 2, y: (H - maxSide) / 2, s: maxSide };
    let scale = 1, drag = null, saving = false, closed = false, drawQueued = false, ro = null, roomWas = 0;

    // A smaller copy for the previews (redrawn on every move of the square).
    let previewSource = img, pk = 1;
    if (Math.max(W, H) > PREVIEW_SOURCE) {
      pk = PREVIEW_SOURCE / Math.max(W, H);
      previewSource = canvasOf(W * pk, H * pk);
      drawInto(previewSource.getContext("2d"), img, 0, 0, W, H, previewSource.width, previewSource.height);
      pk = previewSource.width / W;
    }

    // The modal: a <dialog> in the top layer, so nothing behind it can be pressed or focused.
    const dlg = el("dialog", "bi-dialog");
    dlg.setAttribute("aria-labelledby", "biTitle");
    dlg.setAttribute("aria-describedby", "biHelp");
    const panel = el("div", "bi-panel");
    const title = el("h2", "bi-title", "Crop Tarsee's icon");
    title.id = "biTitle";
    const help = el("p", "bi-help", "Drag the square to move it, or its corners to make it bigger or smaller. With the keyboard: the arrow keys move it (hold Shift to go faster), and plus and minus resize it.");
    help.id = "biHelp";

    const body = el("div", "bi-body");
    const left = el("div", "bi-stage-wrap");
    const stage = el("div", "bi-stage");
    const shown = el("img", "bi-image");
    shown.alt = "";
    shown.draggable = false;
    shown.src = picture.url;
    const frame = el("div", "bi-frame");
    frame.tabIndex = 0;
    frame.setAttribute("role", "group");
    frame.setAttribute("aria-label", "The square to keep");
    frame.setAttribute("aria-describedby", "biHelp");
    for (const corner of ["nw", "ne", "sw", "se"]) {
      const h = el("span", "bi-handle");
      h.dataset.corner = corner;
      h.setAttribute("aria-hidden", "true");
      frame.append(h);
    }
    // The dim outside the square is a hole's shadow in a layer of its own, cut off at the picture's edge; the square
    // and its corners sit over it uncut, so a corner at the edge is still whole to grab.
    const shade = el("div", "bi-shade");
    const hole = el("div", "bi-hole");
    shade.setAttribute("aria-hidden", "true");
    shade.append(hole);
    stage.append(shown, shade, frame);
    const sizeRow = el("label", "bi-size-row");
    const sizeWord = el("span", "bi-size-label", "Size");
    const size = el("input", "bi-size");
    size.type = "range";
    size.step = "any";
    sizeRow.append(sizeWord, size);
    left.append(stage, sizeRow);

    const previews = el("div", "bi-previews");
    const big = canvasOf(180, 180), small = canvasOf(32, 32);
    big.className = "bi-prev bi-prev-180";
    small.className = "bi-prev bi-prev-32";
    big.setAttribute("aria-hidden", "true");
    small.setAttribute("aria-hidden", "true");
    const fig = (canvas, words) => { const f = el("figure", "bi-preview"); f.append(canvas, el("figcaption", null, words)); return f; };
    previews.append(fig(big, "180 px, home screen"), fig(small, "32 px, browser tab"));
    body.append(left, previews);

    const error = el("p", "bi-error");
    error.setAttribute("role", "alert");
    error.hidden = true;
    const actions = el("div", "bi-actions");
    const cancel = el("button", "btn btn-ghost bi-cancel", "Cancel");
    const save = el("button", "btn btn-primary bi-save", "Save icon");
    cancel.type = save.type = "button";
    actions.append(cancel, save);
    panel.append(title, help, body, error, actions);
    dlg.append(panel);

    // -- the square, in the picture's own pixels
    const minSize = () => Math.min(maxSide, Math.max(16, 24 / scale));   // (24 screen pixels: its corners still apart)
    function keepInside() {
      crop.s = Math.min(maxSide, Math.max(minSize(), crop.s));
      crop.x = Math.min(W - crop.s, Math.max(0, crop.x));
      crop.y = Math.min(H - crop.s, Math.max(0, crop.y));
    }
    function resizeAround(s) {
      const cx = crop.x + crop.s / 2, cy = crop.y + crop.s / 2;
      crop.s = Math.min(maxSide, Math.max(minSize(), s));
      crop.x = cx - crop.s / 2;
      crop.y = cy - crop.s / 2;
      keepInside();
    }

    function layout() {
      roomWas = left.clientWidth;
      const room = Math.max(120, (left.clientWidth || 320) - 28);   // (room for the corners, which stick out up to 14px)
      const tall = Math.max(160, Math.min(window.innerHeight * 0.55, 440));
      scale = Math.min(room / W, tall / H);
      stage.style.width = `${Math.round(W * scale)}px`;
      stage.style.height = `${Math.round(H * scale)}px`;
      size.min = String(minSize());
      size.max = String(maxSide);
      keepInside();
      render();
    }

    function render() {
      for (const box of [hole, frame]) {
        box.style.left = `${crop.x * scale}px`;
        box.style.top = `${crop.y * scale}px`;
        box.style.width = box.style.height = `${crop.s * scale}px`;
      }
      size.value = String(crop.s);
      size.setAttribute("aria-valuetext", `${Math.round(crop.s)} of ${Math.round(maxSide)} pixels across`);
      if (!drawQueued) { drawQueued = true; requestAnimationFrame(drawPreviews); }
    }

    function drawPreviews() {
      drawQueued = false;
      if (closed) return;
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      for (const [canvas, css] of [[big, 180], [small, 32]]) {
        const px = Math.round(css * dpr);
        if (canvas.width !== px) { canvas.width = px; canvas.height = px; }
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, px, px);
        drawInto(ctx, previewSource, crop.x * pk, crop.y * pk, crop.s * pk, crop.s * pk, px, px);
      }
    }

    // -- the pointer (a mouse, a finger, a pen)
    const at = (e) => {
      const r = stage.getBoundingClientRect();
      return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
    };
    stage.addEventListener("pointerdown", (e) => {
      if (saving || (e.pointerType === "mouse" && e.button !== 0)) return;
      e.preventDefault();
      const p = at(e);
      const handle = e.target.closest && e.target.closest(".bi-handle");
      if (handle) {
        const c = handle.dataset.corner;
        const dx = c.includes("e") ? 1 : -1, dy = c.includes("s") ? 1 : -1;
        drag = { id: e.pointerId, kind: "size", dx, dy, ax: dx > 0 ? crop.x : crop.x + crop.s, ay: dy > 0 ? crop.y : crop.y + crop.s };
      } else {
        if (!(e.target.closest && e.target.closest(".bi-frame"))) {
          // Outside the square: it jumps there, and follows.
          crop.x = p.x - crop.s / 2;
          crop.y = p.y - crop.s / 2;
          keepInside();
          render();
        }
        drag = { id: e.pointerId, kind: "move", ox: p.x - crop.x, oy: p.y - crop.y };
      }
      try { stage.setPointerCapture(e.pointerId); } catch { /* the pointer is already gone */ }
      frame.focus({ preventScroll: true });
    });
    stage.addEventListener("pointermove", (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      e.preventDefault();
      const p = at(e);
      if (drag.kind === "move") {
        crop.x = p.x - drag.ox;
        crop.y = p.y - drag.oy;
      } else {
        const { dx, dy, ax, ay } = drag;
        const room = Math.min(dx > 0 ? W - ax : ax, dy > 0 ? H - ay : ay);
        const s = Math.min(room, Math.max(minSize(), Math.max(dx * (p.x - ax), dy * (p.y - ay))));
        crop.s = s;
        crop.x = dx > 0 ? ax : ax - s;
        crop.y = dy > 0 ? ay : ay - s;
      }
      keepInside();
      render();
    });
    const letGo = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
    stage.addEventListener("pointerup", letGo);
    stage.addEventListener("pointercancel", letGo);
    stage.addEventListener("lostpointercapture", letGo);

    // -- the keyboard
    frame.addEventListener("keydown", (e) => {
      if (saving) return;
      const step = (e.shiftKey ? 10 : 1) / scale;   // (one screen pixel, or ten)
      switch (e.key) {
        case "ArrowLeft": crop.x -= step; break;
        case "ArrowRight": crop.x += step; break;
        case "ArrowUp": crop.y -= step; break;
        case "ArrowDown": crop.y += step; break;
        case "+": case "=": resizeAround(crop.s + 2 * step); break;
        case "-": case "_": resizeAround(crop.s - 2 * step); break;
        default: return;
      }
      e.preventDefault();
      keepInside();
      render();
    });
    size.addEventListener("input", () => { resizeAround(Number(size.value)); render(); });

    // Tab and Shift+Tab go round the modal's own controls.
    dlg.addEventListener("keydown", (e) => {
      if (e.key !== "Tab") return;
      const list = [frame, size, cancel, save].filter((n) => !n.disabled);
      const i = list.indexOf(document.activeElement);
      const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i < 0 || i === list.length - 1 ? 0 : i + 1);
      e.preventDefault();
      list[next].focus();
    });

    // -- out
    function close() {
      if (closed) return;
      closed = true;
      ro?.disconnect();
      window.removeEventListener("resize", layout);
      try { if (dlg.open) dlg.close(); } catch { /* not open */ }
      dlg.remove();
      URL.revokeObjectURL(picture.url);
      $("brandIconUploadBtn")?.focus({ preventScroll: true });
    }
    // Esc (the dialog's cancel) and Cancel close it, unless it is saving.
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); if (!saving) close(); });
    dlg.addEventListener("close", () => { if (!closed && !saving) close(); });
    cancel.addEventListener("click", () => { if (!saving) close(); });

    function showError(text) {
      error.textContent = text || "";
      error.hidden = !text;
    }

    save.addEventListener("click", async () => {
      if (saving) return;
      saving = true;
      showError("");
      save.disabled = cancel.disabled = size.disabled = true;
      save.setAttribute("aria-busy", "true");
      save.textContent = "Saving...";
      try {
        const canvas = canvasOf(MASTER_SIZE, MASTER_SIZE);
        drawInto(canvas.getContext("2d"), img, crop.x, crop.y, crop.s, crop.s, MASTER_SIZE, MASTER_SIZE);
        const master = await base64Of(await blobOf(canvas));
        const data = await base64Of(file);
        const s = await API.json(STATUS_URL, {
          method: "POST",
          body: { master, original: { name: file.name, type: file.type || TYPES[ext], data } },
        });
        saving = false;
        close();
        applyStatus(s);
        say(`Saved. Tarsee's icon is your picture now${s.updatedAt ? ` (${when(s.updatedAt)})` : ""}.`);
        toast("Tarsee's new icon is saved.");
      } catch (err) {
        saving = false;
        const words = `The icon could not be saved: ${err.message || err}`;
        if (!dlg.open) { close(); say(words, true); return; }   // (the browser closed it meanwhile: the words go under the section)
        save.disabled = cancel.disabled = size.disabled = false;
        save.removeAttribute("aria-busy");
        save.textContent = "Save icon";
        showError(words);
      }
    });

    document.body.append(dlg);
    try { dlg.showModal(); } catch { dlg.setAttribute("open", ""); }
    // Laid out again when its room changes width (a turned phone, the panel narrower) or the window changes size.
    ro = "ResizeObserver" in window ? new ResizeObserver(() => { if (left.clientWidth !== roomWas) layout(); }) : null;
    ro?.observe(left);
    window.addEventListener("resize", layout);
    layout();
    frame.focus({ preventScroll: true });
  }

  // ---------------------------------------------------------------- start

  window.TarseeBrand = Object.freeze({
    get version() { return version; },
    src,
    paths: Object.freeze([...ICON_PATHS]),
  });

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wireSection, { once: true });
  else wireSection();
})();
