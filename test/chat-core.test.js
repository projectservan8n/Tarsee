// The dashboard chat's rules (src/public/js/chat-core.js): the sidebar's groups, the chats' names and times, their
// addresses, the one line for each tool step and for a turn, a saved reply's parts, and the Markdown renderer.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

await import("../src/public/js/chat-core.js");
const C = globalThis.ChatCore;

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const ago = (min) => new Date(NOW - min * 60_000).toISOString().replace("T", " ").slice(0, 19);   // SQLite's UTC form
const ch = (key, title, min, id = key) => ({ key, platform: key.split(":")[0], title, conversationId: id, updatedAt: min == null ? null : ago(min) });

const CHANNELS = [
  ch("discord:1", "#ask-agent", 4),
  ch("telegram:1", "Chat with alice", 300),
  ch("web:default", "Web Chat", 20),
  ch("web:old", "Quarterly notes", 60 * 24 * 13),
  ch("discord:2", "#content", 8),
  ch("whatsapp:15550100", "WhatsApp · Bob", 70),
  ch("email:thread-1", "Email: Invoice for October", 30),
  ch("slack:1", "#ops", 5),
  ch("web:a1b2", "Plan the launch", 2),
];

describe("chat core: the sidebar's groups", () => {
  it("grouped by where they live, in a fixed order, plain names, newest first in each", () => {
    const groups = C.groupChats(CHANNELS, { now: NOW });
    assert.deepEqual(groups.map((g) => g.label), ["Web", "Telegram", "Discord", "WhatsApp", "Email", "Slack"]);
    const web = groups[0];
    assert.deepEqual(web.rows.map((r) => r.name), ["Plan the launch", "Main Session", "Quarterly notes"]);
    assert.deepEqual(groups.find((g) => g.id === "discord").rows.map((r) => r.name), ["#ask-agent", "#content"]);
    assert.equal(groups.find((g) => g.id === "telegram").rows[0].name, "alice");
    assert.equal(groups.find((g) => g.id === "whatsapp").rows[0].name, "Bob", "WhatsApp's own prefix goes");
    assert.equal(groups.find((g) => g.id === "email").rows[0].name, "Invoice for October", "an email thread is its subject");
  });

  it("no emoji or icon in any name", () => {
    for (const g of C.groupChats(CHANNELS, { now: NOW })) for (const r of g.rows) assert.doesNotMatch(r.name, /\p{Extended_Pictographic}/u, r.name);
  });

  it("the quiet time on each row", () => {
    const rows = C.groupChats(CHANNELS, { now: NOW }).flatMap((g) => g.rows);
    const time = (name) => rows.find((r) => r.name === name).time;
    assert.equal(time("#ask-agent"), "4m");
    assert.equal(time("alice"), "5h");
    assert.equal(time("Quarterly notes"), "Oct 12");
  });

  it("the Main Session is there before it has a conversation", () => {
    const groups = C.groupChats([ch("discord:1", "#a", 1)], { now: NOW });
    assert.equal(groups[0].id, "web");
    assert.deepEqual(groups[0].rows.map((r) => [r.name, r.convId]), [["Main Session", null]]);
  });

  it("the open chat is marked, a working one has its dot, an unread one is marked unless it is open", () => {
    const groups = C.groupChats(CHANNELS, { now: NOW, current: "discord:2", working: new Set(["discord:1"]), unread: new Set(["discord:1", "discord:2"]) });
    const d = groups.find((g) => g.id === "discord");
    assert.deepEqual(d.rows.map((r) => [r.name, r.current, r.working, r.unread]), [["#ask-agent", false, true, true], ["#content", true, false, false]]);
    assert.equal(d.working, 1);
    const fresh = C.groupChats(CHANNELS, { now: NOW, current: null, currentKey: "web:default" });
    assert.equal(fresh[0].rows.find((r) => r.name === "Main Session").current, true, "a chat with no conversation yet is found by its key");
  });

  it("a long group shows its first rows and how many more; the open one and a working one always show", () => {
    const many = Array.from({ length: 20 }, (_, i) => ch(`discord:${i}`, `#c${i}`, i + 1));
    const g = C.groupChats(many, { now: NOW, limit: 8, current: "discord:15", working: new Set(["discord:19"]) }).find((x) => x.id === "discord");
    assert.equal(g.total, 20);
    assert.equal(g.rows.length, 10);
    assert.equal(g.more, 10);
    assert.ok(g.rows.some((r) => r.name === "#c15") && g.rows.some((r) => r.name === "#c19"));
    const all = C.groupChats(many, { now: NOW, limit: 8, expanded: new Set(["discord"]) }).find((x) => x.id === "discord");
    assert.equal(all.rows.length, 20);
    assert.equal(all.more, 0);
  });

  it("a collapsed group says so, unless the open chat is in it", () => {
    const groups = C.groupChats(CHANNELS, { now: NOW, collapsed: new Set(["discord", "telegram"]), current: "telegram:1" });
    assert.equal(groups.find((g) => g.id === "discord").collapsed, true);
    assert.equal(groups.find((g) => g.id === "telegram").collapsed, false);
  });

  it("the search box: every word somewhere in the name or the group; nothing folded or collapsed while searching", () => {
    const groups = C.groupChats(CHANNELS, { now: NOW, query: "disc ask", collapsed: new Set(["discord"]) });
    assert.deepEqual(groups.map((g) => g.id), ["discord"]);
    assert.deepEqual(groups[0].rows.map((r) => r.name), ["#ask-agent"]);
    assert.equal(groups[0].collapsed, false);
    assert.deepEqual(C.groupChats(CHANNELS, { now: NOW, query: "zzz" }), []);
    assert.deepEqual(C.groupChats(CHANNELS, { now: NOW, query: "telegram" }).map((g) => g.id), ["telegram"]);
  });

  it("crons and the heartbeat at work show under Background, working, while they run", () => {
    const groups = C.groupChats(CHANNELS, { now: NOW, background: [{ conversationId: "cron:cron_morning", label: "Cron · morning" }] });
    const bg = groups.at(-1);
    assert.equal(bg.id, "background");
    assert.deepEqual(bg.rows.map((r) => [r.name, r.working, r.key]), [["Cron · morning", true, "live:cron:cron_morning"]]);
  });
});

describe("chat core: names and times", () => {
  it("names", () => {
    assert.equal(C.chatName({ key: "web:default", title: "Web Chat" }), "Main Session");
    assert.equal(C.chatName({ key: "web:x", platform: "web", title: "Web Chat" }), "New chat");
    assert.equal(C.chatName({ key: "web:x", platform: "web", title: "Plan the launch" }), "Plan the launch");
    assert.equal(C.chatName({ key: "discord:1", platform: "discord", title: "#a-very-long-channel-name-that-goes-on" }), "#a-very-long-channel-name-that-goes-on", "the sidebar cuts it with CSS, not here");
  });
  it("times: now, minutes, hours, days, then the date, with the year when it is another", () => {
    assert.equal(C.timeLabel(NOW - 20_000, NOW), "now");
    assert.equal(C.timeLabel(ago(59), NOW), "59m");
    assert.equal(C.timeLabel(ago(60 * 23), NOW), "23h");
    assert.equal(C.timeLabel(ago(60 * 24 * 6), NOW), "6d");
    assert.equal(C.timeLabel(Date.UTC(2026, 0, 3, 12), NOW), "Jan 3");
    assert.equal(C.timeLabel(Date.UTC(2025, 11, 30, 12), NOW), "Dec 30, 2025");
    assert.equal(C.timeLabel(null, NOW), "");
    assert.equal(C.timeLabel("not a date", NOW), "");
  });
});

describe("chat core: a chat's own address", () => {
  it("/chat/<id> both ways", () => {
    for (const id of ["0e6b4e21-2bd3-4b94-81cb-9740dee92ac8", "cron:cron_morning", "heartbeat"]) {
      assert.equal(C.chatPath(id), `/chat/${id}`);
      assert.deepEqual(C.parseChatPath(C.chatPath(id)), { kind: "chat", id });
    }
    assert.equal(C.chatPath(null), "/chat/new");
    assert.deepEqual(C.parseChatPath("/chat/new"), { kind: "new" });
    assert.deepEqual(C.parseChatPath("/chat"), { kind: "new" });
    assert.deepEqual(C.parseChatPath("/"), { kind: "root" });
    assert.deepEqual(C.parseChatPath("/index.html"), { kind: "root" });
    assert.deepEqual(C.parseChatPath("/chat/cron%3Ajob"), { kind: "chat", id: "cron:job" });
    assert.deepEqual(C.parseChatPath("/chat/a/b"), { kind: "other" });
    assert.deepEqual(C.parseChatPath("/chat/%E0%A4%A"), { kind: "other" }, "a broken escape");
    assert.deepEqual(C.parseChatPath("/chat/<script>"), { kind: "other" });
  });
  it("the tab's title", () => {
    assert.equal(C.pageTitle("#ask-agent", "Tarsee"), "#ask-agent · Tarsee");
    assert.equal(C.pageTitle("", "Tarsee"), "Tarsee");
    assert.equal(C.pageTitle("Tarsee", "Tarsee"), "Tarsee");
  });
});

describe("chat core: one line for each step", () => {
  const L = (name, summary, running = false) => C.stepLabel({ name, summary }, { running });
  it("Bash: its own description, never the raw command", () => {
    assert.equal(L("Bash", "Check Railway account workspaces and helper script"), "Check Railway account workspaces and helper script");
    assert.equal(L("Bash", 'cd "/Users/x/repo"; git status -sb | head -3'), "Ran git status");
    assert.equal(L("Bash", 'for u in https://a https://b; do echo "== $u"; curl -sS $u; done', true), "Running curl");
    assert.equal(L("Bash", "curl -sS https://e.com | jq ."), "Ran curl");
    assert.equal(L("Bash", "sudo FOO=1 launchctl kickstart -k gui/501/x"), "Ran launchctl kickstart");
    assert.equal(L("Bash", "cd /x && sleep 2 && npm test"), "Ran npm test");
    assert.equal(L("Bash", ""), "Ran a command");
  });
  it("an older step that kept its arguments as JSON (whole or cut off): their description, not the JSON", () => {
    assert.equal(L("Agent", '{"description":"Build cookie consent + policy, both sites","subagent_type":"gene'), "Asked a helper: Build cookie consent + policy, both sites");
    assert.equal(L("Read", '{"file_path":"/a/b/README.md"}'), "Read README.md");
    assert.equal(C.summaryOf("plain words"), "plain words");
    assert.equal(C.summaryOf('{"x":1}'), "");
  });
  it("the others, present while running and past after", () => {
    assert.equal(L("Read", "…/workspace/repos/tarsee-template/README.md", true), "Reading README.md");
    assert.equal(L("Read", "/a/b/c.js"), "Read c.js");
    assert.equal(L("Edit", "/a/style.css"), "Edited style.css");
    assert.equal(L("Write", "/a/new.md", true), "Writing new.md");
    assert.equal(L("Grep", "cookie in src/pages"), 'Searched for "cookie"');
    assert.equal(L("WebSearch", "burgman seat 44K10"), "Searched the web: burgman seat 44K10");
    assert.equal(L("web_search", "Tarsee Railway template", true), "Searching the web: Tarsee Railway template");
    assert.equal(L("WebFetch", "https://www.shopee.ph/burgman-seat"), "Read shopee.ph");
    assert.equal(L("Agent", "Build cookie consent + policy, both sites"), "Asked a helper: Build cookie consent + policy, both sites");
    assert.equal(L("TodoWrite", "updating the task list", true), "Updating the plan");
    assert.equal(L("mcp__tarsee__send_message", "photos"), "Sent a message: photos");
    assert.equal(L("tarsee_canvas_create", "cookie banner diagram"), "Canvas create: cookie banner diagram");
    assert.equal(L("ToolSearch", ""), "Looked up tools");
  });
  it("short: a long description is cut", () => {
    assert.ok(L("Bash", "Explain ".repeat(40)).length <= 110);
  });
});

describe("chat core: the line in the answer's place", () => {
  it("while he works, after, and when it went wrong", () => {
    assert.deepEqual(C.turnLine({ state: "running", tools: 3, last: "Reading README.md" }), { title: "Working", detail: "3 steps · Reading README.md", tone: "running" });
    assert.deepEqual(C.turnLine({ state: "running", tools: 0 }), { title: "Working", detail: "Thinking", tone: "running" });
    assert.deepEqual(C.turnLine({ state: "done", tools: 12, ms: 16_000 }), { title: "Used 12 tools", detail: "16s", tone: "muted" });
    assert.deepEqual(C.turnLine({ state: "done", tools: 1, failed: 1, ms: 61_000 }), { title: "Used 1 tool", detail: "1m 01s · 1 failed", tone: "warn" });
    assert.equal(C.turnLine({ state: "done", tools: 0 }).title, "", "no tools: no line, the answer says it all");
    assert.equal(C.turnLine({ state: "stopped", tools: 2, ms: 9000 }).title, "Stopped after 9s");
    assert.equal(C.turnLine({ state: "failed", error: "The model refused" }).detail, "The model refused");
    assert.equal(C.turnLine({ state: "interrupted" }).detail, "Tarsee restarted during this turn");
  });
});

describe("chat core: a saved reply's parts", () => {
  it("timeline JSON: the answer, what he said on the way, the tools with a one-line summary", () => {
    const content = JSON.stringify({ __timeline: true, text: "Both sites set cookies.", items: [
      { type: "text", text: "I'll look at both sites first." },
      { type: "tool", name: "Bash", summary: "Check the headers", detail: "curl -sS -D - https://a", input: "curl -sS -D - https://a", output: "HTTP/2 200", status: "done" },
      { type: "tool", name: "Read", detail: "/x/Privacy.jsx", input: "/x/Privacy.jsx", output: "", status: "running" },
      { type: "text", text: "Both sites set cookies." },
    ] });
    const p = C.replyParts(content);
    assert.equal(p.answer, "Both sites set cookies.");
    assert.deepEqual(p.notes, ["I'll look at both sites first."]);
    assert.equal(p.tools.length, 2);
    assert.deepEqual([p.tools[0].summary, p.tools[0].output], ["Check the headers", "HTTP/2 200"]);
    assert.equal(p.tools[1].summary, "/x/Privacy.jsx", "an old step with no summary: its detail");
    assert.deepEqual(p.steps.map((s) => s.type), ["note", "tool", "tool"], "in the order they happened, the answer itself left out");
  });
  it("a note that is the answer with its bold marks is still the answer", () => {
    const p = C.replyParts(JSON.stringify({ __timeline: true, text: "It says **March 2025**.\n\nMore.", items: [{ type: "tool", name: "Bash", detail: "ls" }, { type: "text", text: "It says March 2025." }] }));
    assert.deepEqual(p.notes, []);
  });
  it("the engine's shape (the final words first, then the tools): the answer is still the words", () => {
    const p = C.replyParts(JSON.stringify({ __timeline: true, text: "Done.", items: [{ type: "text", text: "Done." }, { type: "tool", name: "Bash", detail: "ls" }] }));
    assert.equal(p.answer, "Done.");
    assert.deepEqual(p.notes, []);
    assert.equal(p.tools.length, 1);
  });
  it("a channel reply: its words, with the slim list of tools beside it", () => {
    const p = C.replyParts("You need the seat.", [{ name: "Bash", summary: "List downloads" }, { name: "Read", summary: "/a/seat.jpg" }]);
    assert.equal(p.answer, "You need the seat.");
    assert.deepEqual(p.tools.map((t) => t.name), ["Bash", "Read"]);
  });
  it("who said it: [name]: words", () => {
    assert.deepEqual(C.sender("[alice]: yeah do an audit"), { who: "alice", body: "yeah do an audit" });
    assert.deepEqual(C.sender("just words"), { who: "", body: "just words" });
  });
});

describe("chat core: Markdown", () => {
  const md = C.renderMarkdown;
  it("paragraphs keep their line breaks; a blank line is a new paragraph", () => {
    assert.equal(md("one\ntwo\n\nthree"), "<p>one<br>two</p><p>three</p>");
  });
  it("bold, italic, strike and code; snake_case is not italic; nothing is formatted inside code", () => {
    assert.equal(md("**b** *i* _u_ ~~s~~ `**x**` my_var_name *a*"), "<p><strong>b</strong> <em>i</em> <em>u</em> <del>s</del> <code>**x**</code> my_var_name <em>a</em></p>");
  });
  it("headings, a rule, a quote", () => {
    assert.equal(md("## Plan\n---\n> We use one cookie\n> to keep you in"), "<h2>Plan</h2><hr><blockquote><p>We use one cookie<br>to keep you in</p></blockquote>");
  });
  it("lists: bullets, numbers from where they start, nested, and an item's words over two lines", () => {
    assert.equal(md("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
    assert.equal(md("3. c\n4. d"), '<ol start="3"><li>c</li><li>d</li></ol>');
    assert.equal(md("- a\n  - a1\n  - a2\n- b"), "<ul><li>a<ul><li>a1</li><li>a2</li></ul></li><li>b</li></ul>");
    assert.equal(md("1. **Cost check.** What they must set,\nwhat breaks"), "<ol><li><strong>Cost check.</strong> What they must set,<br>what breaks</li></ol>");
    assert.equal(md("Here:\n- a\n- b"), "<p>Here:</p><ul><li>a</li><li>b</li></ul>", "a list right under a line of words");
  });
  it("a table, with its columns' alignment", () => {
    const html = md("| Site | Before | After |\n|---|---:|:-:|\n| academy | 4 | 1 |");
    assert.match(html, /^<div class="md-table-wrap"><table class="md-table"><thead><tr><th>Site<\/th><th style="text-align:right">Before<\/th><th style="text-align:center">After<\/th><\/tr><\/thead><tbody><tr><td>academy<\/td>/);
  });
  it("a code block: escaped, its language, a Copy button; one still being written takes the rest", () => {
    assert.equal(md("```js\nif (a < b) alert(1)\n```"), '<div class="code-block"><div class="code-header"><span>js</span><button type="button" class="copy-btn">Copy</button></div><pre><code class="lang-js">if (a &lt; b) alert(1)</code></pre></div>');
    assert.match(md("```\nstill coming"), /<code>still coming<\/code>/);
  });
  it("links: only safe ones; bare links too, without the sentence's full stop", () => {
    assert.equal(md("[Shopee listing](https://shopee.ph/x?a=1&b=2)"), '<p><a href="https://shopee.ph/x?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">Shopee listing</a></p>');
    assert.equal(md("[bad](javascript:alert(1))"), "<p>bad</p>");
    const broke = md('[x](https://e.com/" onmouseover="alert(1))');
    assert.doesNotMatch(broke, /onmouseover="/, "a quote never closes the href");
    for (const m of broke.matchAll(/href="([^"]*)"/g)) assert.doesNotMatch(m[1], /["<>]/);
    assert.equal(md("See https://example.com/canvas."), '<p>See <a href="https://example.com/canvas" target="_blank" rel="noopener noreferrer">https://example.com/canvas</a>.</p>');
    assert.equal(md("[`code` here](/chat/x)"), '<p><a href="/chat/x" target="_blank" rel="noopener noreferrer"><code>code</code> here</a></p>');
  });
  it("HTML in a message is only text", () => {
    const html = md('<img src=x onerror="alert(1)"> <script>alert(1)</script>');
    assert.doesNotMatch(html, /<img|<script/);
    assert.match(html, /&lt;img src=x onerror=&quot;alert\(1\)&quot;&gt;/);
  });
  it("a page's own block token passes through on its line", () => {
    assert.equal(md("Here it is:\n\u00003\u0000\nNice?"), "<p>Here it is:</p>\u00003\u0000<p>Nice?</p>");
  });
  it("nothing: nothing", () => {
    assert.equal(md(""), "");
    assert.equal(md(null), "");
  });
});
