// Tarsee's own questions (src/public/js/dialogs.js), in place of the browser's confirm() and prompt(): the parts that
// need no page (TarseeDialog.core), and how the dashboard loads it. What it looks like and does on a page is checked in
// a browser.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

await import("../src/public/js/dialogs.js");
const D = globalThis.TarseeDialog;
const { SETTLE_MS, paragraphs, questionOf, sameKey, noOf, keyAction, tabTo, settled, outsideAnswers, focusBack, lineUp } = D.core;
const read = (p) => readFileSync(new URL(`../src/public/${p}`, import.meta.url), "utf8");

describe("dialogs: the helper on the window", () => {
  it("is there once, with a yes or no question and a text question", () => {
    assert.equal(typeof D.ask, "function");
    assert.equal(typeof D.askText, "function");
    assert.equal(D.isOpen(), false);
    assert.ok(Object.isFrozen(D), "nothing on the page can swap it");
  });

  it("with no page to ask on, the answer is no (false, or null for text): nothing is done unasked", async () => {
    assert.equal(await D.ask({ title: "Delete it?" }), false);
    assert.equal(await D.askText({ title: "New file", label: "File name" }), null);
  });
});

describe("dialogs: the words of a question", () => {
  it("a blank line starts a new paragraph; a single line break is a space", () => {
    assert.deepEqual(paragraphs("Clear this conversation?\n\nIts messages are deleted.\nThis can't be undone."), ["Clear this conversation?", "Its messages are deleted. This can't be undone."]);
    assert.deepEqual(paragraphs("a\n  \nb\n\n\n c "), ["a", "b", "c"]);
    assert.deepEqual(paragraphs(""), []);
    assert.deepEqual(paragraphs(undefined), []);
  });

  it("a yes or no: OK and Cancel when the buttons are not named; the title is the text's first paragraph when there is none", () => {
    const q = questionOf("yesno", { text: "Clear this conversation?\n\nIts messages are deleted." });
    assert.equal(q.kind, "yesno");
    assert.equal(q.title, "Clear this conversation?");
    assert.deepEqual(q.paragraphs, ["Its messages are deleted."]);
    assert.equal(q.yes, "OK");
    assert.equal(q.no, "Cancel");
    assert.equal(q.danger, false);
    const named = questionOf("yesno", { title: " Sign out of Tarsee on this device? ", yes: "Sign out", no: "Cancel", danger: 1 });
    assert.equal(named.title, "Sign out of Tarsee on this device?");
    assert.equal(named.yes, "Sign out");
    assert.equal(named.danger, true);
    assert.equal(questionOf("yesno", "Just words?").title, "Just words?", "a bare string is the title");
    assert.equal(questionOf("yesno", {}).title, "Are you sure?");
  });

  it("a text question: its label is the title when it has none, its starting words are kept as they are", () => {
    const q = questionOf("text", { title: "New file", label: "File name", value: "  notes.md ", placeholder: "notes.md" });
    assert.equal(q.kind, "text");
    assert.equal(q.label, "File name");
    assert.equal(q.value, "  notes.md ", "not trimmed: what the page gave");
    assert.equal(q.placeholder, "notes.md");
    assert.equal(q.type, "text");
    assert.equal(questionOf("text", { label: "File name" }).title, "File name");
    assert.equal(questionOf("text", { title: "Rename chat" }).label, "Rename chat");
    assert.equal(questionOf("text", { type: "url" }).type, "url");
    assert.equal(questionOf("text", { type: "password" }).type, "text", "only text or url");
  });

  it("no is false for a yes or no and null for text (as the browser's confirm and prompt gave)", () => {
    assert.equal(noOf("yesno"), false);
    assert.equal(noOf("text"), null);
  });

  it("the same question is the same key; another title or kind is another", () => {
    const a = questionOf("yesno", { title: "Delete skill \"x\"?", yes: "Delete" });
    assert.equal(sameKey(a), sameKey(questionOf("yesno", { title: "Delete skill \"x\"?" })));
    assert.notEqual(sameKey(a), sameKey(questionOf("yesno", { title: "Delete skill \"y\"?" })));
    assert.notEqual(sameKey(questionOf("text", { title: "T" })), sameKey(questionOf("yesno", { title: "T" })));
  });
});

describe("dialogs: its keys", () => {
  const key = (k, more = {}) => ({ key: k, ...more });
  const later = { sinceOpen: SETTLE_MS + 1 };

  it("Enter answers yes, or no on the no button; Esc answers no", () => {
    assert.equal(keyAction(key("Enter"), later), "yes");
    assert.equal(keyAction(key("Enter"), { ...later, onNo: true }), "no");
    assert.equal(keyAction(key("Escape"), later), "no");
    assert.equal(keyAction(key("Esc"), later), "no");
    assert.equal(keyAction(key("Escape"), { sinceOpen: 0 }), "no", "Esc may answer at once");
  });

  it("Enter held down from what opened it, or in its first moments, answers nothing", () => {
    assert.equal(keyAction(key("Enter", { repeat: true }), later), "wait");
    assert.equal(keyAction(key("Enter"), { sinceOpen: SETTLE_MS - 1 }), "wait");
    assert.equal(keyAction(key("Enter"), { sinceOpen: SETTLE_MS }), "yes");
  });

  it("Tab goes round its own controls; the rest is the focused control's (typing, Space on a button, an IME)", () => {
    assert.equal(keyAction(key("Tab"), later), "round");
    assert.equal(keyAction(key("Tab", { shiftKey: true }), later), "round");
    for (const k of ["a", "w", " ", "ArrowLeft", "Backspace", "?"]) assert.equal(keyAction(key(k), later), "own", k);
    assert.equal(keyAction(key("Enter", { isComposing: true }), later), "own", "an IME picking a word");
    assert.equal(keyAction(key("Process", { keyCode: 229 }), later), "own");
    assert.equal(keyAction(key("Escape", { isComposing: true }), later), "own", "Esc leaves the IME, not the question");
  });

  it("Tab and Shift+Tab: round from the last control to the first and back", () => {
    assert.equal(tabTo(0, 2, false), 1);
    assert.equal(tabTo(1, 2, false), 0);
    assert.equal(tabTo(0, 2, true), 1);
    assert.equal(tabTo(1, 3, true), 0);
    assert.equal(tabTo(0, 3, true), 2);
    assert.equal(tabTo(-1, 3, false), 0, "from outside its controls: the first");
    assert.equal(tabTo(-1, 3, true), 2, "or the last, backwards");
    assert.equal(tabTo(5, 3, false), 0);
    assert.equal(tabTo(0, 0, false), -1, "nothing to go to");
  });
});

describe("dialogs: presses", () => {
  it("its buttons count once it has settled (the second click of a double click does not)", () => {
    assert.equal(settled(0), false);
    assert.equal(settled(SETTLE_MS - 1), false);
    assert.equal(settled(SETTLE_MS), true);
    assert.ok(SETTLE_MS >= 300 && SETTLE_MS <= 600, "long enough for a double click, short beside reading a question");
  });

  it("a press outside the panel answers no only when it went down and came up there, once settled", () => {
    const t = SETTLE_MS + 50;
    assert.equal(outsideAnswers({ downOutside: true, upOutside: true, sinceOpen: t }), true);
    assert.equal(outsideAnswers({ downOutside: false, upOutside: true, sinceOpen: t }), false, "a drag out of the text box");
    assert.equal(outsideAnswers({ downOutside: true, upOutside: false, sinceOpen: t }), false);
    assert.equal(outsideAnswers({ downOutside: true, upOutside: true, sinceOpen: 120 }), false, "the second click of a double click");
  });
});

describe("dialogs: where the focus goes after", () => {
  const node = (id, connected = true) => ({ id, isConnected: connected, focus() {} });

  it("back to what had it; if that is gone, to the one with its id now; else to `back`", () => {
    const had = node("signOutBtn");
    assert.equal(focusBack(had, null, () => null), had);
    const again = node("signOutBtn");
    assert.equal(focusBack(node("signOutBtn", false), null, (id) => (id === "signOutBtn" ? again : null)), again);
    const close = node("settingsClose");
    assert.equal(focusBack(node("", false), () => close, () => null), close);
    assert.equal(focusBack(node("", false), close, () => null), close);
    assert.equal(focusBack(null, null, () => null), null, "nothing had it: nowhere");
    assert.equal(focusBack(node("", false), () => { throw new Error("gone"); }, () => null), null);
  });
});

describe("dialogs: one at a time", () => {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  /** A question shown by hand: its answer is given with answer(v). */
  const asked = () => {
    const shows = [];
    const show = (name) => () => new Promise((resolve) => shows.push({ name, answer: resolve }));
    return { shows, show };
  };

  it("a second question waits until the first is answered, then shows", async () => {
    const run = lineUp();
    const { shows, show } = asked();
    const a = run("a", show("a"), false);
    const b = run("b", show("b"), false);
    await tick();
    assert.deepEqual(shows.map((s) => s.name), ["a"], "only the first is up");
    shows[0].answer(true);
    assert.equal(await a, true);
    await tick();
    assert.deepEqual(shows.map((s) => s.name), ["a", "b"]);
    shows[1].answer(false);
    assert.equal(await b, false);
  });

  it("the same question asked again while it is up (a double click) is answered no at once, and asked once", async () => {
    const run = lineUp();
    const { shows, show } = asked();
    const first = run("end", show("end"), false);
    assert.equal(await run("end", show("end again"), false), false, "the double: no, at once");
    const other = run("other", show("other"), null);   // (another question is not a double: it waits its turn)
    await tick();
    assert.deepEqual(shows.map((s) => s.name), ["end"]);
    shows[0].answer(true);
    assert.equal(await first, true, "the first one's own answer");
    await tick();
    assert.deepEqual(shows.map((s) => s.name), ["end", "other"]);
    shows[1].answer("typed");
    assert.equal(await other, "typed");
  });

  it("once answered, the same question can be asked again", async () => {
    const run = lineUp();
    const { shows, show } = asked();
    const one = run("q", show("1"), false);
    await tick();
    shows[0].answer(false);
    assert.equal(await one, false);
    const two = run("q", show("2"), false);
    await tick();
    assert.equal(shows.length, 2);
    shows[1].answer(true);
    assert.equal(await two, true);
  });

  it("a question that fails to show does not hold up the next one", async () => {
    const run = lineUp();
    const broken = run("x", () => Promise.reject(new Error("no page")), false);
    await assert.rejects(broken);
    assert.equal(await run("y", () => Promise.resolve("ok"), false), "ok");
    assert.equal(await run("x", () => Promise.resolve("again"), false), "again", "and it can be asked again");
  });
});

describe("dialogs: the dashboard loads it first", () => {
  const order = (html, a, b) => html.indexOf(a) >= 0 && html.indexOf(b) >= 0 && html.indexOf(a) < html.indexOf(b);

  it("the dashboard: before its own scripts, with its stylesheet", () => {
    const html = read("index.html");
    assert.match(html, /<script src="\/js\/dialogs\.js"><\/script>/);
    for (const s of ["/js/api.js", "/js/chat.js", "/js/settings.js", "/js/files.js", "/js/app.js"]) assert.ok(order(html, "/js/dialogs.js", s), `before ${s}`);
    assert.ok(order(html, "/css/style.css", "/css/dialogs.css"), "its stylesheet after the modal's own (style.css)");
  });

  it("the service worker keeps both with the dashboard's other files", () => {
    const sw = read("sw.js");
    assert.ok(sw.includes('"/js/dialogs.js"') && sw.includes('"/css/dialogs.css"'));
  });

  it("every button is 40px tall at least (44px under a finger)", () => {
    const css = read("css/dialogs.css");
    assert.match(read("css/tokens.css"), /--space-10:\s*40px/);
    assert.match(css, /\.td-dash \.td-actions \.btn \{[^}]*min-height: var\(--space-10\)/);
    assert.match(css, /@media \(pointer: coarse\) \{\s*\.td-dash \.td-actions \.btn \{ min-height: 44px; \}/);
  });
});
