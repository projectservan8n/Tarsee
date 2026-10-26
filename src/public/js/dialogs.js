/**
 * Tarsee's own questions, in place of the browser's: a yes or no (for confirm()) and a line of text (for prompt()).
 * The browser's boxes are headed with the site's address, cannot be styled, and block the whole tab;
 * test/no-native-dialogs.test.js keeps them out of src/public.
 *
 * A plain script (no imports), loaded by index.html before the dashboard's own code, so its key listener is the first
 * one the window has. On the window:
 *
 *   await TarseeDialog.ask({ title, text, yes, no, danger })                   true for yes, false for no
 *   await TarseeDialog.askText({ title, label, value, placeholder, yes, no })  what was typed, or null for no
 *
 *   title    the question, as its heading (it names the dialog)
 *   text     more words under it; a blank line (\n\n) starts another paragraph
 *   yes, no  the two buttons' words (OK and Cancel when left out)
 *   danger   the yes button in the page's red: deleting, signing out, ending something
 *   label    the text box's label; value, the words it starts with (selected); placeholder, its hint; type "url"
 *   back     where the focus goes after if what had it is gone (an element, or a function that finds one)
 *
 * It looks like the dashboard's own modal (style.css: .delete-modal, its buttons and its text box); css/dialogs.css
 * places it and makes every button 40px tall at least (44px under a finger). It is a modal <dialog> in the top layer,
 * over everything else on the page: nothing behind it can be pressed or focused.
 *
 * Its keys: Enter answers yes (on the no button, no), Esc answers no, and so does a press on the dimmed page outside
 * it; Tab and Shift+Tab go round its own controls. Enter held down from what opened it, and a press in its first
 * moments (the second click of a double click on what opened it), answer nothing. While it is up no key reaches
 * anything behind it (keydown and keypress stop here; keyup goes on, so a key held as it opened is let go), and the
 * window hears "tarsee:dialog" ({ open }) as it opens and as it closes. The focus goes into it (the yes button, or
 * the text box with its words selected), stays there, and goes back to where it was after.
 *
 * One at a time: a question waits until the one before it has been answered. The same question asked again while it
 * is up or waiting (a double click on what opened it) is answered no at once, so it is never asked twice over.
 *
 * The parts that need no page are TarseeDialog.core, tested in test/dialogs.test.js.
 */
(function () {
  "use strict";
  const G = typeof globalThis !== "undefined" ? globalThis : window;
  if (G.TarseeDialog) return;   // (loaded twice: the first one stays, with its listeners)

  const SETTLE_MS = 400;        // a press this soon after it opens is the end of whatever opened it, not an answer
  const now = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

  // ---------------------------------------------------------------- the parts that need no page

  const words = (v) => (v == null ? "" : String(v));
  const trimmed = (v) => words(v).trim();

  /** A question's text as paragraphs: a blank line starts a new one; a single line break is a space. */
  function paragraphs(text) {
    return words(text).split(/\n[ \t]*\n/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
  }

  /**
   * A question as it is shown, from what a page asked (kind "yesno" or "text"): whatever is left out filled in. No
   * title: the text's first paragraph is it (a yes or no), or the label (a text question).
   */
  function questionOf(kind, o) {
    const ask = o && typeof o === "object" ? o : { title: o };
    const text = kind === "text";
    const paras = paragraphs(ask.text);
    let title = trimmed(ask.title);
    if (!title) title = text ? trimmed(ask.label) || "Type it in" : paras.shift() || "Are you sure?";
    return {
      kind: text ? "text" : "yesno",
      title,
      paragraphs: paras,
      label: text ? trimmed(ask.label) || title : "",
      value: text ? words(ask.value) : "",
      placeholder: text ? words(ask.placeholder) : "",
      type: text && ask.type === "url" ? "url" : "text",
      yes: trimmed(ask.yes) || "OK",
      no: trimmed(ask.no) || "Cancel",
      danger: !!ask.danger,
      back: ask.back || null,
    };
  }

  /** What makes two questions the same one (asked again by a double click on what opened it). */
  function sameKey(q) {
    return JSON.stringify([q.kind, q.title, q.paragraphs, q.label]);
  }

  /** What a no is, for a kind of question: false, or null for a text question. */
  const noOf = (kind) => (kind === "text" ? null : false);

  /**
   * What a key press does while a question is up (every one is the question's alone: nothing behind it hears it):
   *   "yes", "no"  it answers: Enter yes (on the no button, no), Esc no
   *   "round"      Tab or Shift+Tab: to the next of its own controls, round from the last to the first
   *   "wait"       Enter held down from what opened it, or in its first moments: it answers nothing
   *   "own"        the focused control's own (a letter in the text box, Space on a button, an IME's keys)
   * onNo: the no button has the focus. sinceOpen: milliseconds since it opened.
   */
  function keyAction(e, { onNo = false, sinceOpen = Infinity } = {}) {
    const key = e && e.key;
    if (e && (e.isComposing || e.keyCode === 229)) return "own";   // (an IME picking a word: its keys are its own)
    if (key === "Escape" || key === "Esc") return "no";
    if (key === "Tab") return "round";
    if (key === "Enter") {
      if (e.repeat || sinceOpen < SETTLE_MS) return "wait";
      return onNo ? "no" : "yes";
    }
    return "own";
  }

  /** Tab from the control at i of n (-1: from none of them): the next one, round from the last to the first; back: Shift+Tab. */
  function tabTo(i, n, back) {
    if (!(n > 0)) return -1;
    if (!(i >= 0 && i < n)) return back ? n - 1 : 0;
    return (i + (back ? n - 1 : 1)) % n;
  }

  /** Has it been up long enough for a press to be an answer (not the second click of a double click on what opened it)? */
  const settled = (sinceOpen) => sinceOpen >= SETTLE_MS;

  /** Does a press on the dimmed page outside it answer no? One that went down there and came up there, once it has settled. */
  function outsideAnswers({ downOutside, upOutside, sinceOpen }) {
    return !!downOutside && !!upOutside && settled(sinceOpen);
  }

  /** Where the focus goes after: what had it, if it is still on the page; else the one with its id now; else back. */
  function focusBack(had, back, byId) {
    if (had && had.isConnected) return had;
    if (had && had.id && byId) { const again = byId(had.id); if (again) return again; }
    if (typeof back === "function") { try { return back() || null; } catch { return null; } }
    return back && typeof back.focus === "function" ? back : null;
  }

  /**
   * One at a time. run(key, show) shows a question once the one before it has been answered, and gives its answer.
   * The question with the same key while it is up or waiting gets `dupe` at once instead (it is not asked twice).
   */
  function lineUp() {
    let last = Promise.resolve();
    const waiting = new Set();
    return function run(key, show, dupe) {
      if (waiting.has(key)) return Promise.resolve(dupe);
      waiting.add(key);
      const turn = last.then(() => show()).finally(() => waiting.delete(key));
      last = turn.catch(() => {});
      return turn;
    };
  }

  const core = { SETTLE_MS, paragraphs, questionOf, sameKey, noOf, keyAction, tabTo, settled, outsideAnswers, focusBack, lineUp };

  // ---------------------------------------------------------------- the page

  const page = typeof window !== "undefined" && typeof document !== "undefined";

  let seq = 0;
  let up = null;   // the question that is up: { q, dlg, panel, yes, no, input, openedAt, answer(v), controls(), last }
  const line = lineUp();

  const make = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  };

  /** The dialog for a question: { dlg, panel, yes, no, input }. */
  function build(q) {
    const id = `tdialog${++seq}`;
    const dlg = make("dialog", `td-dialog td-dash${q.danger ? " is-danger" : ""}`);
    dlg.setAttribute("role", q.kind === "text" ? "dialog" : "alertdialog");
    dlg.setAttribute("aria-modal", "true");
    dlg.setAttribute("aria-labelledby", `${id}-title`);
    const title = make("h2", "delete-modal-header td-title", q.title);
    title.id = `${id}-title`;
    const paras = q.paragraphs.map((words, i) => {
      const p = make("p", "delete-modal-text td-text", words);
      p.id = `${id}-text${i}`;
      return p;
    });
    if (paras.length) dlg.setAttribute("aria-describedby", paras.map((p) => p.id).join(" "));
    let input = null, field = null;
    if (q.kind === "text") {
      field = make("div", "td-field");
      const label = make("label", "td-label", q.label);
      label.htmlFor = `${id}-input`;
      input = make("input", "delete-modal-input td-input");
      input.id = `${id}-input`;
      input.type = q.type;
      input.value = q.value;
      if (q.placeholder) input.placeholder = q.placeholder;
      input.autocomplete = "off";
      input.spellcheck = false;
      input.setAttribute("autocapitalize", "none");
      input.setAttribute("autocorrect", "off");
      input.setAttribute("enterkeyhint", "done");
      field.append(label, input);
    }
    const yes = make("button", `btn td-yes ${q.danger ? "delete-modal-confirm" : "btn-primary"}`, q.yes);
    const no = make("button", "btn delete-modal-cancel td-no", q.no);
    yes.type = no.type = "button";
    // The question, the words, the box, then Cancel and the thing to do on the right.
    const actions = make("div", "delete-modal-actions td-actions");
    actions.append(no, yes);
    const panel = make("div", "delete-modal td-panel");
    panel.append(title, ...paras, ...(field ? [field] : []), actions);
    dlg.append(panel);
    return { dlg, panel, yes, no, input };
  }

  const tell = (open) => { try { window.dispatchEvent(new CustomEvent("tarsee:dialog", { detail: { open } })); } catch { /* an old browser: nobody listening */ } };
  const shown = (el) => !el.disabled && !el.hidden && el.getClientRects().length > 0;

  /** Show one question and wait for its answer. */
  function show(q) {
    return new Promise((resolve) => {
      const parts = build(q);
      const { dlg, yes, no, input } = parts;
      const had = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
      let done = false, downOutside = false;
      const self = {
        q, ...parts, openedAt: now(), last: null,
        controls: () => [...dlg.querySelectorAll("input, button")].filter(shown),
        answer(yesOrNo) {
          if (done) return;
          done = true;
          const value = q.kind === "text" ? (yesOrNo ? input.value : null) : !!yesOrNo;
          up = null;
          try { if (dlg.open) dlg.close(); } catch { /* not open after all */ }
          dlg.remove();
          const to = focusBack(had, q.back, (i) => document.getElementById(i));
          if (to) { try { to.focus({ preventScroll: true }); } catch { /* it cannot take the focus */ } }
          tell(false);
          resolve(value);
        },
      };
      yes.addEventListener("click", () => { if (settled(now() - self.openedAt)) self.answer(true); });
      no.addEventListener("click", () => { if (settled(now() - self.openedAt)) self.answer(false); });
      // A press on the dimmed page outside the panel: no (once it went down and came up there).
      dlg.addEventListener("pointerdown", (e) => { downOutside = e.target === dlg; });
      dlg.addEventListener("click", (e) => {
        const answers = outsideAnswers({ downOutside, upOutside: e.target === dlg, sinceOpen: now() - self.openedAt });
        downOutside = false;
        if (answers) self.answer(false);
      });
      // The browser's own way out of a modal dialog (Esc where the key never reached us, a phone's back gesture): no.
      dlg.addEventListener("cancel", (e) => { e.preventDefault(); self.answer(false); });
      dlg.addEventListener("close", () => self.answer(false));
      up = self;
      try {
        document.body.append(dlg);
        try { dlg.showModal(); } catch { dlg.setAttribute("open", ""); }   // (no modal dialogs in this browser: still drawn over the page, css/dialogs.css)
        tell(true);
        const first = input || yes;
        first.focus({ preventScroll: true });
        if (input) input.select();
        self.last = first;
      } catch (err) {
        console.warn("[dialog] could not show it:", err);
        self.answer(false);   // (no: and the page has its keys back)
      }
    });
  }

  function request(kind, o) {
    const q = questionOf(kind, o);
    if (!page || !document.body) return Promise.resolve(noOf(q.kind));   // (no page to ask on)
    // (Should showing it ever fail, the answer is no: what asked is never left waiting, and nothing is done unasked.)
    return line(sameKey(q), () => show(q), noOf(q.kind)).catch((err) => { console.warn("[dialog] could not ask:", err); return noOf(q.kind); });
  }

  if (page) {
    // Every key press while a question is up is its own (capture, on the window, before any of the page's listeners:
    // this script runs first). Keyups go on: a key held as it opened must be heard let go.
    window.addEventListener("keydown", (e) => {
      const c = up;
      if (!c) return;
      e.stopImmediatePropagation();
      const inside = c.dlg.contains(e.target);
      const act = keyAction(e, { onNo: document.activeElement === c.no, sinceOpen: now() - c.openedAt });
      // (The focus is not in it after all, say on the page after a press on its words: nothing behind it acts on the key,
      // though the browser's own shortcuts, held with Cmd, Ctrl or Alt, still work.)
      if (act === "own") { if (!inside && !e.metaKey && !e.ctrlKey && !e.altKey) e.preventDefault(); return; }
      e.preventDefault();
      if (act === "yes") c.answer(true);
      else if (act === "no") c.answer(false);
      else if (act === "round") {
        const list = c.controls();
        const next = list[tabTo(list.indexOf(document.activeElement), list.length, e.shiftKey)];
        if (next) next.focus({ preventScroll: true });
      }
    }, true);
    window.addEventListener("keypress", (e) => { if (up) e.stopImmediatePropagation(); }, true);
    // The focus stays in it: whatever moves it out (a page's own code, redrawing something behind) gives it back.
    document.addEventListener("focusin", (e) => {
      const c = up;
      if (!c) return;
      if (c.dlg.contains(e.target)) { c.last = e.target; return; }
      const to = c.last && c.dlg.contains(c.last) ? c.last : c.input || c.yes;
      to.focus({ preventScroll: true });
    }, true);
  }

  G.TarseeDialog = Object.freeze({
    ask: (o) => request("yesno", o),
    askText: (o) => request("text", o),
    isOpen: () => !!up,
    core: Object.freeze(core),
  });
})();
