// No browser dialog in the dashboard: every question is our own (src/public/js/dialogs.js, TarseeDialog). The
// browser's boxes are headed with the site's address, cannot be styled, and block the whole tab.
//
// Every .js and .html file under src/public is read as code: comments, the words in strings and template literals, and
// regular expressions are left out, and an HTML file's code is its inline scripts, its on...= handlers and its
// javascript: links. In that code, any window.confirm, window.alert or window.prompt (or the same on self, globalThis,
// top, parent or frames, with a dot, ?. or ["..."]) fails, and so does a bare call of confirm(, alert( or prompt(,
// unless it calls a function of the file's own by that name (declared where the call can see it, say a const confirm
// of a module's own), or it is a method's own definition.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = fileURLToPath(new URL("../src/public/", import.meta.url));
const NAMES = "confirm|alert|prompt";
const GLOBALS = "window|self|globalThis|top|parent|frames";

/**
 * A script's code with what is not code blanked out, every other character where it was (line breaks kept, so a
 * position is still its line): { code } has comments, regular expressions and the words of strings and of template
 * literals (outside their ${...}) blanked; { withStrings } keeps the strings' words (for window["confirm"]).
 */
export function codeOf(src) {
  const code = src.split(""), withStrings = src.split("");
  const n = src.length;
  const blank = (a, b, alsoStrings = true) => {
    for (let k = a; k < b; k++) {
      if (src[k] === "\n") continue;
      code[k] = " ";
      if (alsoStrings) withStrings[k] = " ";
    }
  };
  const BEFORE_A_VALUE = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
  let last = "";        // what code came last: a punctuator, "word" (a keyword a value may follow), or "value"
  const holes = [];     // template literals whose ${...} we are in: the braces opened in each since its ${
  let i = 0;

  /** The words of a template literal from j: to its closing ` (a value) or to a ${ (code again, inside it). */
  const template = (j) => {
    let k = j;
    while (k < n) {
      if (src[k] === "\\") { k += 2; continue; }
      if (src[k] === "`") { blank(j, k, false); last = "value"; return k + 1; }
      if (src[k] === "$" && src[k + 1] === "{") { blank(j, k, false); holes.push(0); last = "("; return k + 2; }
      k++;
    }
    blank(j, n, false);
    return n;
  };

  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === "/" && d === "/") { const e = src.indexOf("\n", i); const end = e < 0 ? n : e; blank(i, end); i = end; continue; }
    if (c === "/" && d === "*") { const e = src.indexOf("*/", i + 2); const end = e < 0 ? n : e + 2; blank(i, end); i = end; continue; }
    if (c === "'" || c === '"') {
      let k = i + 1;
      while (k < n && src[k] !== c && src[k] !== "\n") k += src[k] === "\\" ? 2 : 1;
      blank(i + 1, Math.min(k, n), false);   // (the words stay in withStrings)
      i = k + 1;
      last = "value";
      continue;
    }
    if (c === "`") { i = template(i + 1); continue; }
    if (c === "}" && holes.length && holes[holes.length - 1] === 0) { holes.pop(); i = template(i + 1); continue; }
    if (c === "{") { if (holes.length) holes[holes.length - 1]++; last = "{"; i++; continue; }
    if (c === "}") { if (holes.length) holes[holes.length - 1]--; last = "}"; i++; continue; }
    if (c === "/") {
      const regexHere = last === "" || last === "word" || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(last);
      if (regexHere) {
        let k = i + 1, inClass = false;
        while (k < n && src[k] !== "\n") {
          if (src[k] === "\\") { k += 2; continue; }
          if (src[k] === "[") inClass = true;
          else if (src[k] === "]") inClass = false;
          else if (src[k] === "/" && !inClass) break;
          k++;
        }
        if (k < n && src[k] === "/") {
          k++;
          while (k < n && /[a-z]/i.test(src[k])) k++;
          blank(i, k);
          i = k;
          last = "value";
          continue;
        }
      }
      last = "/";
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let k = i + 1;
      while (k < n && /[\w$]/.test(src[k])) k++;
      last = BEFORE_A_VALUE.has(src.slice(i, k)) ? "word" : "value";
      i = k;
      continue;
    }
    if (/[0-9]/.test(c)) { let k = i + 1; while (k < n && /[\w.]/.test(src[k])) k++; i = k; last = "value"; continue; }
    if (/\s/.test(c)) { i++; continue; }
    last = c === ")" || c === "]" ? "value" : c;
    i++;
  }
  return { code: code.join(""), withStrings: withStrings.join("") };
}

/**
 * An HTML page's code, blanked like codeOf except for its scripts: the inline <script>s (not those with a src), its
 * on...= handlers and its javascript: links. HTML comments are not code.
 */
export function htmlCode(html) {
  const out = html.replace(/[^\n]/g, " ").split("");
  const keep = (from, text) => { for (let k = 0; k < text.length; k++) out[from + k] = text[k]; };
  const live = html.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
  for (const m of live.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    if (/\bsrc\s*=/i.test(m[1]) || /\btype\s*=\s*["']?(?!module|text\/javascript|application\/javascript)[^"'\s>]+/i.test(m[1])) continue;
    keep(m.index + m[0].indexOf(">") + 1, m[2]);
  }
  for (const m of live.matchAll(/<[a-z][^>]*>/gi)) {
    for (const a of m[0].matchAll(/\s(on[a-z]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
      const value = a[3] ?? a[4] ?? a[5] ?? "";
      keep(m.index + a.index + a[0].length - value.length - (a[3] != null || a[4] != null ? 1 : 0), value);
    }
    for (const a of m[0].matchAll(/\s(?:href|src|action|formaction)\s*=\s*(["']?)\s*javascript:([^"'>]*)\1/gi)) {
      keep(m.index + a.index + a[0].indexOf("javascript:") + "javascript:".length, a[2]);
    }
  }
  return out.join("");
}

/** The pairs of braces in code: [open, close] for each, by position. */
function blocks(code) {
  const pairs = [], open = [];
  for (let k = 0; k < code.length; k++) {
    if (code[k] === "{") open.push(k);
    else if (code[k] === "}" && open.length) pairs.push([open.pop(), k]);
  }
  return pairs;
}

/** The block a declaration at `at` is seen in: the innermost braces round it, or the whole file. */
function scopeAt(pairs, at, n) {
  let best = [0, n];
  for (const [a, b] of pairs) if (a < at && at < b && b - a < best[1] - best[0]) best = [a, b];
  return best;
}

/** The code just before position at, its trailing white space left off: { char, word } (the last character, the identifier it ends with). */
function before(code, at) {
  let k = at - 1;
  while (k >= 0 && /\s/.test(code[k])) k--;
  let w = k;
  while (w >= 0 && /[\w$]/.test(code[w])) w--;
  return { char: k >= 0 ? code[k] : "", word: code.slice(w + 1, k + 1), wordStart: w + 1 };
}

/** Where code declares a function, class, const, let, var or parameter of its own called confirm, alert or prompt: [{ name, from, to }]. */
function ownNames(code) {
  const pairs = blocks(code), n = code.length, found = [];
  const closeOf = new Map(pairs);
  const add = (name, at) => { const [from, to] = scopeAt(pairs, at, n); found.push({ name, from, to }); };
  for (const m of code.matchAll(new RegExp(`\\b(?:function\\s*\\*?|class|const|let|var)\\s+(${NAMES})(?![\\w$])`, "g"))) add(m[1], m.index + m[0].length - m[1].length);
  // Destructured: const { confirm } = ..., const [alert] = ... (seen in the block round the const).
  for (const m of code.matchAll(/\b(?:const|let|var)\s*([{[])([^}\]]*)[}\]]/g)) {
    for (const b of m[2].matchAll(new RegExp(`(?<![\\w$.])(${NAMES})(?![\\w$]|\\s*:)`, "g"))) add(b[1], m.index);
  }
  // Parameters, seen in the body that follows: function f(confirm) { }, a method's m(alert) { }, catch (prompt) { },
  // (a, confirm) => { }; an arrow without braces, (alert) => ... or prompt => ..., in the block round it.
  const param = new RegExp(`(?<![\\w$.])(${NAMES})(?![\\w$])`, "g");
  for (const m of code.matchAll(/\(([^()]*)\)\s*(=>)?\s*(\{)?/g)) {
    if ((!m[2] && !m[3]) || !param.test(m[1])) continue;
    param.lastIndex = 0;
    const { word } = before(code, m.index);
    if (!m[2] && (!word || /^(if|for|while|switch|with|return|typeof|void|await|yield|in|of|new)$/.test(word))) continue;   // (if (x) {: no parameters)
    for (const b of m[1].matchAll(param)) {
      if (m[3]) { const body = m.index + m[0].length - 1; found.push({ name: b[1], from: body, to: closeOf.get(body) ?? n }); }
      else add(b[1], m.index);
    }
  }
  for (const m of code.matchAll(new RegExp(`(?<![\\w$.])(${NAMES})\\s*=>`, "g"))) add(m[1], m.index);
  return found;
}

/** The browser's dialogs in a script's code: [{ at, what }] (at: a position in it). */
export function nativeDialogs(src, { html = false } = {}) {
  const text = html ? htmlCode(src) : src;
  const { code, withStrings } = codeOf(text);
  const hits = [];
  for (const m of code.matchAll(new RegExp(`\\b(${GLOBALS})\\s*(?:\\?\\.|\\.)\\s*(${NAMES})(?![\\w$])`, "g"))) hits.push({ at: m.index, what: `${m[1]}.${m[2]}` });
  for (const m of withStrings.matchAll(new RegExp(`\\b(${GLOBALS})\\s*(?:\\?\\.)?\\s*\\[\\s*(["'\`])(${NAMES})\\2\\s*\\]`, "g"))) hits.push({ at: m.index, what: `${m[1]}["${m[3]}"]` });
  const calls = [...code.matchAll(new RegExp(`(?<![\\w$#])(${NAMES})\\s*\\(`, "g"))];
  const own = calls.length ? ownNames(code) : [];
  for (const m of calls) {
    const at = m.index, name = m[1];
    const prev = before(code, at);
    if (prev.char === ".") continue;                                      // a method of something (ui.confirm(), this.alert(), TarseeDialog.ask)
    if (prev.char === "*" && before(code, code.lastIndexOf("*", at)).word === "function") continue;   // function* confirm(
    if (/^(function|get|set|static|async)$/.test(prev.word)) continue;   // its own definition
    // A method's definition: confirm(x) { ... } (the call's closing parenthesis, then a brace).
    let k = at + m[0].length, depth = 1;
    while (k < code.length && depth) { if (code[k] === "(") depth++; else if (code[k] === ")") depth--; k++; }
    if (/^\s*\{/.test(code.slice(k))) continue;
    if (own.some((o) => o.name === name && o.from <= at && at <= o.to)) continue;   // the file's own function by that name
    hits.push({ at, what: `${name}(` });
  }
  return hits.sort((a, b) => a.at - b.at);
}

const lineOf = (src, at) => src.slice(0, at).split("\n").length;

function* files(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* files(p);
    else if (/\.(m?js|cjs|html?)$/i.test(name)) yield p;
  }
}

describe("no browser dialogs in src/public: only our own (js/dialogs.js)", () => {
  it("no js or html file calls the browser's confirm, alert or prompt", () => {
    const found = [];
    let seen = 0;
    for (const p of files(PUBLIC)) {
      const src = readFileSync(p, "utf8");
      seen++;
      for (const h of nativeDialogs(src, { html: /\.html?$/i.test(p) })) found.push(`src/public/${relative(PUBLIC, p)}:${lineOf(src, h.at)}: ${h.what}`);
    }
    assert.ok(seen > 15, `looked at ${seen} files`);
    assert.deepEqual(found, [], `Ask with TarseeDialog.ask() or TarseeDialog.askText() (src/public/js/dialogs.js) instead of:\n  ${found.join("\n  ")}`);
  });

  it("our own questions are there to use: js/dialogs.js puts TarseeDialog on the window", () => {
    const src = readFileSync(join(PUBLIC, "js/dialogs.js"), "utf8");
    assert.match(src, /G\.TarseeDialog = Object\.freeze\(\{\s*ask:/);
    assert.deepEqual(nativeDialogs(src), []);
  });
});

describe("the guard itself", () => {
  const hit = (src, opts) => nativeDialogs(src, opts).map((h) => h.what);

  it("catches the browser's dialogs, called or not, in every spelling", () => {
    assert.deepEqual(hit('if (!window.confirm("Regenerate the webhook secret?")) return;'), ["window.confirm"]);
    assert.deepEqual(hit('const name = prompt("File name:");'), ["prompt("]);
    assert.deepEqual(hit("alert(1); window.alert(2);"), ["alert(", "window.alert"]);
    assert.deepEqual(hit("if (!confirm(`Delete skill \"${name}\"?`)) return;"), ["confirm("]);
    assert.deepEqual(hit("globalThis.prompt('a'); self.alert('b'); top.confirm('c'); parent.alert('d');"), ["globalThis.prompt", "self.alert", "top.confirm", "parent.alert"]);
    assert.deepEqual(hit("window?.confirm('x'); window . alert ('y');"), ["window.confirm", "window.alert"]);
    assert.deepEqual(hit("window['confirm']('x'); window[\"prompt\"]('y');"), ['window["confirm"]', 'window["prompt"]']);
    assert.deepEqual(hit("const ask = window.confirm; (0, window.alert)('x');"), ["window.confirm", "window.alert"]);
    assert.deepEqual(hit("x = a / b; if (y) confirm('z'); const re = /q/g;"), ["confirm("], "a division before is not a regular expression");
    assert.deepEqual(hit("const t = `${confirm('in a template hole')}`;"), ["confirm("]);
  });

  it("catches them in a page's inline scripts, handlers and javascript: links", () => {
    assert.deepEqual(hit('<button onclick="return confirm(\'Delete?\')">x</button>', { html: true }), ["confirm("]);
    assert.deepEqual(hit("<script>\n  window.alert('hi');\n</script>", { html: true }), ["window.alert"]);
    assert.deepEqual(hit('<a href="javascript:prompt(1)">x</a>', { html: true }), ["prompt("]);
    assert.deepEqual(hit("<body onload=alert(1)>", { html: true }), ["alert("]);
  });

  it("leaves alone our own functions named confirm, methods, comments, strings and regular expressions", () => {
    // A function of its own, inside a setup, called from its form.
    assert.deepEqual(hit("function setup() {\n  form.addEventListener('submit', (e) => { e.preventDefault(); confirm(); });\n  function confirm() { return 1; }\n}"), []);
    // A const arrow of its own in a method.
    assert.deepEqual(hit("const Live = {\n  async post(item) {\n    const confirm = (id) => id;\n    onDone(() => confirm(item.id));\n  },\n};"), []);
    assert.deepEqual(hit("ui.confirm = make('button'); this.confirm = null; obj.alert(x); rl.prompt(); TarseeDialog.ask({ title: 'confirm()?' });"), []);
    assert.deepEqual(hit("class Board { confirm(what) { return what; } async prompt() {} static alert(x) {} get confirmed() { return 1; } }"), []);
    assert.deepEqual(hit("const o = { confirm(x) { return x; }, alert: () => 1 };"), []);
    assert.deepEqual(hit("// if (!confirm('old way')) return;\n/* window.alert('no') */\nconst s = \"alert('a string')\", t = 'prompt(1)';"), []);
    assert.deepEqual(hit("const u = `the words alert(${1}) and confirm( in a template`;"), []);
    assert.deepEqual(hit("if (/confirm\\(|alert\\(/.test(src)) x(); s.replace(/prompt\\(\"/g, '');"), []);
    assert.deepEqual(hit("const { confirm } = helpers; confirm('ours');"), []);
    assert.deepEqual(hit("function ask(confirm) { return confirm('ours'); }"), []);
    assert.deepEqual(hit("myconfirm('x'); reconfirm('y'); _alert('z'); #prompt;"), []);
    assert.deepEqual(hit("<p>Please confirm (twice) or prompt(nothing)</p>\n<!-- <button onclick=\"alert(1)\"> -->\n<script src=\"/js/x.js\"></script>", { html: true }), []);
  });

  it("our own name only counts where it can be seen: a bare confirm( elsewhere in the file is the browser's", () => {
    assert.deepEqual(hit("function a() { function confirm() {} confirm(); }\nfunction b() { if (!confirm('sure?')) return; }"), ["confirm("]);
    assert.deepEqual(hit("const Live = { post() { const confirm = () => 1; confirm(); }, other() { confirm('x'); } };"), ["confirm("]);
  });
});
