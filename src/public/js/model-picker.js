/**
 * The composer's model and effort picker, drawn like Claude Code's own and filled from the list Claude Code itself
 * keeps, so new models show up without a code change. The list is the server's (lib/model-catalog.js and
 * lib/model-picker.js); the rules are js/model-picker-core.js; the chat's own pick lives in Chat (js/chat.js).
 *
 *   the newest of each family, numbered 1 to 4 (the chat's one has a check); a number key picks while it is open
 *   Effort, opening Low, Medium, High, Extra and Max, with the Recommended one and Max's warning
 *   More models, opening the older versions, newest first
 *
 * Arrows move, Enter or Space picks, the right arrow opens a list and the left one goes back, Esc closes. On a
 * phone a list opens in the menu's place with a way back. Our own look, no emoji.
 *
 * One picker per button: ModelPicker.create(opts), and window.ModelPicker itself is the dashboard composer's, on
 * Chat. opts:
 *   state()           { picker, pick, defaults } of the chat it is for
 *   setPick(change)   { model } or { effort } picked: shown and saved for the chat
 *   onOpen()          as it opens (a fresher list, the chat's pick again)
 *   afterPick({ keys }) after a pick closed it (keys: with the keyboard, and the focus went back to the button)
 */
(function () {
  "use strict";

  const Core = globalThis.ModelPickerCore;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const ICON = {
    check: '<svg class="mp-check" width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    next: '<svg class="mp-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 3.5L10.5 8 6 12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    back: '<svg class="mp-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3.5L5.5 8 10 12.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  const NARROW = 640;   // below this a list opens in the menu's place

  function create(opts = {}) {
    let btn = null;
    let menu = null;      // the main menu
    let sub = null;       // the open list: { el, kind, row }
    let hoverTimer = null;
    let lastFocusFromKeys = false;

    const state = () => {
      const s = opts.state?.() || {};
      return { picker: s.picker || { main: [], more: [] }, pick: s.pick || {}, defaults: s.defaults || { model: "sonnet", effort: "medium" } };
    };
    const narrow = () => window.innerWidth < NARROW;
    const rows = (el) => [...(el?.querySelectorAll(".mp-item:not([disabled])") || [])];

    /** One model's row. */
    function modelRow(e, i, picked) {
      const key = i != null ? `<kbd class="mp-key" aria-hidden="true">${i + 1}</kbd>` : "";
      const tip = [e.description, e.note?.tip].filter(Boolean).join(". ");
      return `<button type="button" class="mp-item" role="menuitemradio" aria-checked="${picked}" data-pick="model" data-id="${esc(e.id)}"${tip ? ` title="${esc(tip)}"` : ""}>`
        + `<span class="mp-text"><span class="mp-name">${esc(e.name)}</span>${e.note ? `<span class="mp-note is-warning">${esc(e.note.text)}</span>` : ""}</span>`
        + `<span class="mp-end">${picked ? ICON.check : key}</span></button>`;
    }

    function subRow(kind, label, value, { disabled = false } = {}) {
      return `<button type="button" class="mp-item mp-subrow" role="menuitem" aria-haspopup="menu" aria-expanded="false" data-sub="${kind}"${disabled ? " disabled" : ""}>`
        + `<span class="mp-text"><span class="mp-name">${esc(label)}</span></span>`
        + `<span class="mp-end">${value ? `<span class="mp-value">${esc(value)}</span>` : ""}${ICON.next}</span></button>`;
    }

    function mainHtml() {
      const { picker, pick, defaults } = state();
      const current = pick.model || defaults.model;
      const label = Core.buttonLabel(picker, pick, defaults);
      const top = (picker.main || []).map((e, i) => modelRow(e, i, Core.isPicked(picker, e, current))).join("");
      const olderPicked = (picker.more || []).find((e) => Core.isPicked(picker, e, current));
      const hasLevels = !label.entry || (label.entry.efforts || []).length > 0;
      return `<div class="mp-group" role="group" aria-label="Models">${top}</div>`
        + `<div class="mp-divider" role="separator"></div>`
        + subRow("effort", "Effort", hasLevels ? label.effort : "None", { disabled: !hasLevels })
        + ((picker.more || []).length ? `<div class="mp-divider" role="separator"></div>${subRow("more", "More models", olderPicked ? olderPicked.name : "")}` : "");
    }

    function effortHtml() {
      const { picker, pick, defaults } = state();
      const label = Core.buttonLabel(picker, pick, defaults);
      const entry = label.entry;
      const levels = entry?.efforts?.length ? entry.efforts : ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id, name: Core.EFFORT_NAMES[id], recommended: id === defaults.effort }));
      const note = entry?.effortNote || picker.effortNote || "";
      const rowsHtml = levels.map((l) => {
        const on = label.level === l.id;
        const badges = (l.recommended ? '<span class="mp-badge">Recommended</span>' : "")
          + (l.badge ? `<span class="mp-badge${l.badge.tone === "warning" ? " is-warning" : ""}">${l.badge.tone === "warning" ? '<span class="mp-warn" aria-hidden="true"></span>' : ""}${esc(l.badge.text)}</span>` : "");
        return `<button type="button" class="mp-item" role="menuitemradio" aria-checked="${on}" data-pick="effort" data-value="${esc(l.id)}"${l.tip ? ` title="${esc(l.tip)}"` : ""}>`
          + `<span class="mp-text mp-row"><span class="mp-name">${esc(l.name)}</span>${badges}</span><span class="mp-end">${on ? ICON.check : ""}</span></button>`;
      }).join("");
      return (note ? `<p class="mp-head">${esc(note)}</p>` : "") + rowsHtml;
    }

    function moreHtml() {
      const { picker, pick, defaults } = state();
      const current = pick.model || defaults.model;
      return (picker.more || []).map((e) => modelRow(e, null, Core.isPicked(picker, e, current))).join("");
    }

    /* ---------------------------------------------------------------- placing */

    function placeMain() {
      const r = btn.getBoundingClientRect();
      const w = menu.offsetWidth;
      const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
      menu.style.left = `${Math.round(left)}px`;
      menu.style.bottom = `${Math.round(window.innerHeight - r.top + 6)}px`;
      menu.style.maxHeight = `${Math.max(160, Math.round(r.top - 14))}px`;
    }

    function placeSub(el, row) {
      if (narrow()) {
        // In the menu's place: same corner, the menu hidden behind it.
        const m = menu.getBoundingClientRect();
        const w = el.offsetWidth;
        el.style.left = `${Math.round(Math.max(8, Math.min(m.right - w, window.innerWidth - w - 8)))}px`;
        el.style.bottom = menu.style.bottom;
        el.style.maxHeight = menu.style.maxHeight;
        return;
      }
      const m = menu.getBoundingClientRect();
      const rr = row.getBoundingClientRect();
      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const right = m.right + 4;
      const left = right + w <= window.innerWidth - 8 ? right : Math.max(8, m.left - 4 - w);
      // Its bottom level with the row's, as Claude Code's, kept on screen.
      const top = Math.max(8, Math.min(rr.bottom + 4 - h, window.innerHeight - h - 8));
      el.style.left = `${Math.round(left)}px`;
      el.style.top = `${Math.round(top)}px`;
      el.style.maxHeight = `${Math.round(window.innerHeight - 16)}px`;
    }

    /* ---------------------------------------------------------------- open, close, pick */

    function focusRow(el, which = "picked") {
      const all = rows(el);
      const target = (which === "picked" && all.find((b) => b.getAttribute("aria-checked") === "true")) || all[0];
      target?.focus({ preventScroll: true });
    }

    function openSub(kind, { focus = false } = {}) {
      if (sub?.kind === kind) { if (focus) focusRow(sub.el); return; }
      closeSub();
      const row = menu?.querySelector(`[data-sub="${kind}"]`);
      if (!row || row.disabled) return;
      const el = document.createElement("div");
      el.className = `mp-menu mp-submenu mp-${kind}`;
      el.setAttribute("role", "menu");
      el.setAttribute("aria-label", kind === "effort" ? "Effort" : "More models");
      const back = narrow() ? `<button type="button" class="mp-item mp-back" role="menuitem" data-back="1">${ICON.back}<span class="mp-name">${kind === "effort" ? "Effort" : "More models"}</span></button><div class="mp-divider" role="separator"></div>` : "";
      el.innerHTML = back + (kind === "effort" ? effortHtml() : moreHtml());
      document.body.appendChild(el);
      wire(el);
      placeSub(el, row);
      if (narrow()) menu.classList.add("is-behind");
      row.setAttribute("aria-expanded", "true");
      row.classList.add("is-open");
      sub = { el, kind, row };
      if (focus || narrow()) focusRow(el);
    }

    function closeSub({ focusRow: back = false } = {}) {
      if (!sub) return;
      const { el, row } = sub;
      sub = null;
      el.remove();
      menu?.classList.remove("is-behind");
      row.setAttribute("aria-expanded", "false");
      row.classList.remove("is-open");
      if (back) row.focus({ preventScroll: true });
    }

    function open({ sub: kind = null } = {}) {
      if (!btn) return;
      if (menu) close();
      opts.onOpen?.();
      menu = document.createElement("div");
      menu.className = "mp-menu";
      if (opts.id) menu.id = opts.id;
      menu.setAttribute("role", "menu");
      menu.setAttribute("aria-label", "Model");
      menu.innerHTML = mainHtml();
      document.body.appendChild(menu);
      wire(menu);
      placeMain();
      btn.setAttribute("aria-expanded", "true");
      document.addEventListener("pointerdown", away, true);
      document.addEventListener("keydown", onKey, true);
      window.addEventListener("resize", onResize);
      if (kind) openSub(kind, { focus: true });
      else focusRow(menu);
    }

    function close({ focusButton = false } = {}) {
      clearTimeout(hoverTimer);
      closeSub();
      menu?.remove();
      menu = null;
      btn?.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", away, true);
      document.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", onResize);
      if (focusButton) btn?.focus({ preventScroll: true });
    }

    const rowKey = (b) => `${b.dataset.pick || b.dataset.sub || b.dataset.back || ""}:${b.dataset.id || b.dataset.value || ""}`;

    /** Repaint an open menu (the list came back fresher, or the pick changed elsewhere), the focus kept on its row. */
    function refresh() {
      if (!menu) return;
      const kind = sub?.kind;
      const f = document.activeElement?.closest?.(".mp-item");
      const inSub = !!(f && sub?.el.contains(f));
      const had = f && (inSub || menu.contains(f)) ? rowKey(f) : null;
      closeSub();
      menu.innerHTML = mainHtml();   // (its own listeners stay: they are on the menu, not on its rows)
      placeMain();
      if (kind) openSub(kind);
      if (had == null) return;
      const where = inSub && sub ? sub.el : menu;
      const again = rows(where).find((b) => rowKey(b) === had);
      if (again) again.focus({ preventScroll: true }); else focusRow(where);
    }

    function pick(kind, value) {
      if (!opts.setPick) return;
      if (kind === "model") {
        const { picker } = state();
        const entry = [...(picker.main || []), ...(picker.more || [])].find((e) => e.id === value);
        if (!entry) return;
        opts.setPick({ model: Core.pickValue(entry) });
      } else {
        opts.setPick({ effort: value });
      }
      const keys = lastFocusFromKeys;
      close({ focusButton: keys });
      opts.afterPick?.({ keys });
    }

    /* ---------------------------------------------------------------- events */

    function away(e) {
      if (btn.contains(e.target) || menu?.contains(e.target) || sub?.el.contains(e.target)) return;
      close();
    }
    function onResize() { close(); }

    function wire(el) {
      el.addEventListener("click", (e) => {
        const item = e.target.closest(".mp-item");
        if (!item || item.disabled) return;
        lastFocusFromKeys = e.detail === 0;   // Enter or Space on a button clicks it with no pointer
        if (item.dataset.back) { closeSub({ focusRow: true }); return; }
        if (item.dataset.sub) { openSub(item.dataset.sub, { focus: lastFocusFromKeys }); return; }
        if (item.dataset.pick === "model") pick("model", item.dataset.id);
        else if (item.dataset.pick === "effort") pick("effort", item.dataset.value);
      });
      if (el === menu) {
        // On a computer a list opens when the pointer rests on its row, and closes on another row.
        el.addEventListener("pointerover", (e) => {
          if (e.pointerType !== "mouse" || narrow()) return;
          const item = e.target.closest(".mp-item");
          if (!item) return;
          clearTimeout(hoverTimer);
          const kind = item.dataset.sub;
          hoverTimer = setTimeout(() => { if (!menu) return; if (kind && !item.disabled) openSub(kind); else if (!kind) closeSub(); }, kind ? 90 : 220);
        });
      }
    }

    function onKey(e) {
      if (!menu) return;
      const inSub = sub && sub.el.contains(document.activeElement);
      const here = inSub ? sub.el : menu;
      lastFocusFromKeys = true;
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        if (sub) closeSub({ focusRow: true }); else close({ focusButton: true });
        return;
      }
      if (e.key === "Tab") { close(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const { picker } = state();
      const byNumber = Core.numberKey(picker, e.key);
      if (byNumber) { e.preventDefault(); e.stopPropagation(); pick("model", byNumber.id); return; }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        const all = rows(here);
        const i = Core.nextIndex(all.length, all.indexOf(document.activeElement), e.key);
        all[i]?.focus({ preventScroll: true });
        return;
      }
      if (e.key === "ArrowRight" && !inSub) {
        const row = document.activeElement?.closest?.(".mp-subrow");
        if (row && !row.disabled) { e.preventDefault(); openSub(row.dataset.sub, { focus: true }); }
        return;
      }
      if (e.key === "ArrowLeft" && inSub) { e.preventDefault(); closeSub({ focusRow: true }); }
    }

    /** Its button: a click, a tap, Enter or Space (a button's own), or the down arrow opens it. */
    function init(button) {
      btn = button;
      if (!btn) return;
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        lastFocusFromKeys = e.detail === 0;
        if (menu) close(); else open();
      });
      btn.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); lastFocusFromKeys = true; if (!menu) open(); }
      });
    }

    return { init, open, close, refresh, get isOpen() { return !!menu; } };
  }

  // The dashboard composer's picker, on Chat (js/chat.js: a top-level const there, not a property of window).
  const chat = () => (typeof Chat !== "undefined" ? Chat : window.Chat || null);
  const composer = create({
    id: "modelPickerMenu",
    state: () => { const c = chat(); return { picker: c?._picker, pick: c?._pick, defaults: c?._pickDefaults }; },
    setPick: (change) => chat()?.setPick?.(change),
    // A fresher list, and the chat's pick asked again: one made on another device shows here.
    onOpen: () => { const c = chat(); c?.refreshPicker?.(); c?._loadPick?.({ fresh: true }); },
    afterPick: ({ keys }) => { if (!keys && window.matchMedia?.("(pointer: fine)").matches) document.getElementById("messageInput")?.focus(); },
  });
  window.ModelPicker = Object.assign(composer, { create });
})();
