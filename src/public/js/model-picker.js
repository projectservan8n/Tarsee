/**
 * The composer's model and effort picker, drawn like Claude Code's own and filled from the server's list
 * (GET /api/models: lib/model-catalog.js and lib/model-picker.js), so new models show up without a code change. The
 * rules are js/model-picker-core.js; the chat's own pick lives in Chat (js/chat.js).
 *
 * With every AI (design 4.11):
 *   one section per AI that is ready, the default AI first, each model with its context, whether it sees images,
 *   its badges (Plan, Free, an estimated cost tier, Verified) and its note ("Replies appear a message at a time" on
 *   the models Codex runs); the pickable ones on top numbered 1 to 9 (a number key picks while it is open)
 *   a list that opens for each AI's older or other models (Claude's More models, OpenRouter's All models, whose rows
 *   say to verify them in Settings > AI first and can't be picked)
 *   a search box once there are many models, over every AI's models
 *   a warning on top when the chat's AI is no longer ready ("DeepSeek not connected, using default")
 *   Effort, opening only the levels the model has
 * The Claude-only list (no groups) is drawn as before: the newest of each family, Effort, More models.
 *
 * Arrows move, Enter or Space picks, the right arrow opens a list and the left one goes back, Esc closes; a letter
 * starts a search. On a phone a list opens in the menu's place with a way back. Our own look, no emoji.
 *
 * One picker per button: ModelPicker.create(opts), and window.ModelPicker itself is the dashboard composer's, on
 * Chat. opts:
 *   state()           { picker, pick, defaults } of the chat it is for (pick: { provider?, model, effort })
 *   setPick(change)   { model } (a model ref, and its { provider }) or { effort } picked: shown and saved for the chat
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
  const NARROW = 640;        // below this a list opens in the menu's place
  const SEARCH_FROM = 12;    // a search box once the list holds more models than this
  const RESULTS_MAX = 50;

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
    const rows = (el) => [...(el?.querySelectorAll(".mp-item:not([disabled])") || [])].filter((b) => !b.closest("[hidden]"));
    const allEntries = (picker) => Core.groupsOf(picker).flatMap(Core.groupEntries);
    const grouped = (picker) => Array.isArray(picker?.groups);
    const searchBox = () => menu?.querySelector(".mp-search") || null;

    /** The entry the button shows (the chat's model, or the default): its row gets the check. */
    function shownEntry() {
      const { picker, pick, defaults } = state();
      return Core.buttonLabel(picker, pick, defaults).entry;
    }
    const same = (a, b) => !!(a && b && a.id === b.id && (a.provider || null) === (b.provider || null));

    /** One model's row. `where` names its AI (in search results); `alone`: the only AI listed, so no Plan badge. */
    function modelRow(e, i, picked, { where = null, alone = false } = {}) {
      const off = e.selectable === false;
      const key = i != null && i < 9 ? `<kbd class="mp-key" aria-hidden="true">${i + 1}</kbd>` : "";
      const tip = [e.description, e.note?.tip, e.priceHint].filter(Boolean).join(". ");
      const note = Core.noteFor(e);
      // Fable's note (no tone of its own) is a warning; the others are plain.
      const noteClass = e.note && e.note.tone !== "neutral" ? "mp-note is-warning" : "mp-note";
      const detail = [where, Core.detailFor(e)].filter(Boolean).join(" · ");
      const badges = Core.badgesFor(e).filter((b) => !(alone && b.text === "Plan")).map((b) => `<span class="mp-badge${b.tone === "warning" ? " is-warning" : ""}"${b.title ? ` title="${esc(b.title)}"` : ""}>${esc(b.text)}</span>`).join("");
      return `<button type="button" class="mp-item" role="menuitemradio" aria-checked="${picked}" data-pick="model" data-id="${esc(Core.pickValue(e))}"${off ? ' disabled aria-disabled="true"' : ""}${tip ? ` title="${esc(tip)}"` : ""}>`
        + `<span class="mp-text"><span class="mp-text mp-row"><span class="mp-name">${esc(e.name)}</span>${badges}</span>`
        + (detail ? `<span class="mp-note">${esc(detail)}</span>` : "")
        + (note ? `<span class="${noteClass}">${esc(note)}</span>` : "")
        + `</span><span class="mp-end">${picked ? ICON.check : key}</span></button>`;
    }

    function subRow(kind, label, value, { disabled = false } = {}) {
      return `<button type="button" class="mp-item mp-subrow" role="menuitem" aria-haspopup="menu" aria-expanded="false" data-sub="${esc(kind)}"${disabled ? " disabled" : ""}>`
        + `<span class="mp-text"><span class="mp-name">${esc(label)}</span></span>`
        + `<span class="mp-end">${value ? `<span class="mp-value">${esc(value)}</span>` : ""}${ICON.next}</span></button>`;
    }

    const head = (text, cls = "") => `<p class="mp-head${cls}" role="presentation">${text}</p>`;

    function mainHtml() {
      const { picker, pick, defaults } = state();
      const label = Core.buttonLabel(picker, pick, defaults);
      const shown = label.entry;
      const hasLevels = !label.entry || (label.entry.efforts || []).length > 0;
      const effortRow = subRow("effort", "Effort", hasLevels ? label.effort : "None", { disabled: !hasLevels });
      const warning = label.warning ? head(`<span class="mp-note is-warning">${esc(label.warning)}</span>`) : "";

      if (!grouped(picker)) {
        // The Claude-only list, as it has always been drawn.
        const top = (picker.main || []).map((e, i) => modelRow(e, i, same(e, shown))).join("");
        const olderPicked = (picker.more || []).find((e) => same(e, shown));
        return warning + `<div class="mp-group" role="group" aria-label="Models">${top}</div>`
          + `<div class="mp-divider" role="separator"></div>`
          + effortRow
          + ((picker.more || []).length ? `<div class="mp-divider" role="separator"></div>${subRow("more", "More models", olderPicked ? olderPicked.name : "")}` : "");
      }

      const groups = Core.groupsOf(picker);
      const total = allEntries(picker).length;
      const search = groups.some((g) => g.searchable) || total > SEARCH_FROM
        ? `<div class="mp-searchbox" role="presentation" style="padding:4px 4px 6px"><input type="search" class="search-input mp-search" style="width:100%;box-sizing:border-box" placeholder="Search models" aria-label="Search models" autocomplete="off" spellcheck="false"></div>`
          + `<div class="mp-results" role="group" aria-label="Matching models" hidden></div>`
        : "";
      let n = 0;
      const multi = groups.length > 1;
      const body = groups.map((g, gi) => {
        const sections = Core.sectionsOf(g);
        const open = sections.filter((s) => !s.collapsed && (s.entries || []).length);
        let html = `<div class="mp-group" role="group" aria-label="${esc(g.label || "Models")}">`;
        if (multi || (g.provider && g.provider !== "claude")) html += head(`<span class="mp-group-name" style="font-weight:600;color:var(--text-secondary)">${esc(g.label || "")}</span>`);
        if (g.note) html += head(`<span class="mp-note">${esc(g.note)}</span>`);
        for (const s of open) {
          if (s.label && open.length > 1) html += head(`<span style="font-size:var(--text-xs)">${esc(s.label)}</span>`, " mp-subhead");
          for (const e of s.entries) html += modelRow(e, e.selectable === false ? null : n++, same(e, shown), { alone: !multi });
        }
        sections.forEach((s, si) => {
          if (!s.collapsed || !(s.entries || []).length) return;
          const here = s.entries.find((e) => same(e, shown));
          html += subRow(`list:${gi}:${si}`, s.label || "More models", here ? here.name : String(s.entries.length));
        });
        return `${html}</div>`;
      }).join(`<div class="mp-divider" role="separator"></div>`);
      const elsewhere = (picker.unavailable || []).length || allEntries(picker).some((e) => e.selectable === false)
        ? `<div class="mp-divider" role="separator"></div><button type="button" class="mp-item" role="menuitem" data-action="settings"><span class="mp-text"><span class="mp-name">Connect or verify in Settings &gt; AI</span>${(picker.unavailable || []).length ? `<span class="mp-note">Not ready: ${esc(picker.unavailable.map((u) => u.label).join(", "))}</span>` : ""}</span><span class="mp-end">${ICON.next}</span></button>`
        : "";
      return warning + search
        + `<div class="mp-body">${body}<div class="mp-divider" role="separator"></div>${effortRow}${elsewhere}</div>`;
    }

    function resultsHtml(query) {
      const { picker } = state();
      const shown = shownEntry();
      const found = Core.search(picker, query).slice(0, RESULTS_MAX);
      if (!found.length) return head(`No model matches "${esc(query)}"`);
      const alone = Core.groupsOf(picker).length < 2;
      return found.map(({ entry, group }) => modelRow(entry, null, same(entry, shown), { where: alone ? null : group.label, alone })).join("");
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
      return (note ? head(esc(note)) : "") + rowsHtml;
    }

    /** A list that opens: Claude's More models (the Claude-only list), or one AI's collapsed section. */
    function listHtml(kind) {
      const { picker } = state();
      const shown = shownEntry();
      if (kind === "more") return (picker.more || []).map((e) => modelRow(e, null, same(e, shown))).join("");
      const s = sectionFor(kind);
      const alone = Core.groupsOf(picker).length < 2;
      return s ? s.entries.map((e) => modelRow(e, null, same(e, shown), { alone })).join("") : "";
    }

    function sectionFor(kind) {
      const m = /^list:(\d+):(\d+)$/.exec(kind || "");
      if (!m) return null;
      const g = Core.groupsOf(state().picker)[Number(m[1])];
      return g ? Core.sectionsOf(g)[Number(m[2])] || null : null;
    }

    function subLabel(kind) {
      if (kind === "effort") return "Effort";
      if (kind === "more") return "More models";
      const s = sectionFor(kind);
      const g = Core.groupsOf(state().picker)[Number(/^list:(\d+)/.exec(kind)?.[1])];
      return [g?.label, s?.label || "More models"].filter(Boolean).join(": ");
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
      target?.focus({ preventScroll: false });
    }

    function openSub(kind, { focus = false } = {}) {
      if (sub?.kind === kind) { if (focus) focusRow(sub.el); return; }
      closeSub();
      const row = menu?.querySelector(`[data-sub="${CSS.escape(kind)}"]`);
      if (!row || row.disabled) return;
      const el = document.createElement("div");
      const name = subLabel(kind);
      el.className = `mp-menu mp-submenu mp-${kind === "effort" ? "effort" : "list"}`;
      el.setAttribute("role", "menu");
      el.setAttribute("aria-label", name);
      const back = narrow() ? `<button type="button" class="mp-item mp-back" role="menuitem" data-back="1">${ICON.back}<span class="mp-name">${esc(name)}</span></button><div class="mp-divider" role="separator"></div>` : "";
      el.innerHTML = back + (kind === "effort" ? effortHtml() : listHtml(kind));
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

    const rowKey = (b) => `${b.dataset.pick || b.dataset.sub || b.dataset.back || b.dataset.action || ""}:${b.dataset.id || b.dataset.value || ""}`;

    /** Repaint an open menu (the list came back fresher, or the pick changed elsewhere), the focus kept on its row. */
    function refresh() {
      if (!menu) return;
      const kind = sub?.kind;
      const query = searchBox()?.value || "";
      const searching = document.activeElement === searchBox();
      const f = document.activeElement?.closest?.(".mp-item");
      const inSub = !!(f && sub?.el.contains(f));
      const had = f && (inSub || menu.contains(f)) ? rowKey(f) : null;
      closeSub();
      menu.innerHTML = mainHtml();   // (its own listeners stay: they are on the menu, not on its rows)
      if (query && searchBox()) { searchBox().value = query; showResults(query); }
      placeMain();
      if (kind && menu.querySelector(`[data-sub="${CSS.escape(kind)}"]`)) openSub(kind);
      if (searching) { searchBox()?.focus({ preventScroll: true }); return; }
      if (had == null) return;
      const where = inSub && sub ? sub.el : menu;
      const again = rows(where).find((b) => rowKey(b) === had);
      if (again) again.focus({ preventScroll: true }); else focusRow(where);
    }

    /** The search box's words: the matching models in place of the groups, or the groups again. */
    function showResults(query) {
      const results = menu?.querySelector(".mp-results");
      const body = menu?.querySelector(".mp-body");
      if (!results || !body) return;
      const q = String(query || "").trim();
      closeSub();
      // Kept as wide as it opened, so it doesn't jump about while the results change.
      if (!menu.style.minWidth) menu.style.minWidth = `${menu.offsetWidth}px`;
      results.hidden = !q;
      body.hidden = !!q;
      results.innerHTML = q ? resultsHtml(q) : "";
      placeMain();
    }

    function pick(kind, value) {
      if (!opts.setPick) return;
      if (kind === "model") {
        const { picker } = state();
        const entry = allEntries(picker).find((e) => Core.pickValue(e) === value) || allEntries(picker).find((e) => e.id === value);
        if (!entry || entry.selectable === false) return;
        opts.setPick(entry.provider ? { provider: entry.provider, model: Core.pickValue(entry) } : { model: Core.pickValue(entry) });
      } else {
        opts.setPick({ effort: value });
      }
      const keys = lastFocusFromKeys;
      close({ focusButton: keys });
      opts.afterPick?.({ keys });
    }

    /** Settings > AI, where an AI is connected and a model verified. */
    function openSettings() {
      close();
      if (typeof Settings === "undefined") return;
      Promise.resolve(Settings.open()).then(() => Settings.focusAI()).catch(() => {});
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
        if (item.dataset.action === "settings") { openSettings(); return; }
        if (item.dataset.sub) { openSub(item.dataset.sub, { focus: lastFocusFromKeys }); return; }
        if (item.dataset.pick === "model") pick("model", item.dataset.id);
        else if (item.dataset.pick === "effort") pick("effort", item.dataset.value);
      });
      if (el === menu) {
        el.addEventListener("input", (e) => { if (e.target.classList?.contains("mp-search")) showResults(e.target.value); });
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
      const box = searchBox();
      const inSearch = !!box && document.activeElement === box;
      const inSub = sub && sub.el.contains(document.activeElement);
      const here = inSub ? sub.el : menu;
      lastFocusFromKeys = true;
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation();
        if (sub) closeSub({ focusRow: true });
        else if (inSearch && box.value) { box.value = ""; showResults(""); }
        else close({ focusButton: true });
        return;
      }
      if (e.key === "Tab") { close(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (inSearch) {
        if (e.key === "ArrowDown") { e.preventDefault(); rows(menu)[0]?.focus({ preventScroll: false }); }
        else if (e.key === "Enter") {
          e.preventDefault();
          const first = rows(menu.querySelector(".mp-results"))[0];
          if (first?.dataset.pick === "model") pick("model", first.dataset.id);
        }
        return;   // the rest is typing
      }
      const { picker } = state();
      const byNumber = Core.numberKey(picker, e.key);
      if (byNumber && !inSub) { e.preventDefault(); e.stopPropagation(); pick("model", Core.pickValue(byNumber)); return; }
      if (box && !inSub && e.key.length === 1 && /\S/.test(e.key)) { box.focus({ preventScroll: true }); return; }   // a letter starts a search
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
        e.preventDefault();
        const all = rows(here);
        const i = Core.nextIndex(all.length, all.indexOf(document.activeElement), e.key);
        all[i]?.focus({ preventScroll: false });
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
