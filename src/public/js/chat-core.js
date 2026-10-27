/**
 * The dashboard chat's rules, with no page (js/chat.js and js/live.js draw
 * them; test/chat-core.test.js checks them in node).
 *
 * The chat works like claude.ai: every chat has its own address
 * (/chat/<conversationId>), the sidebar is plain grouped rows with no icons,
 * and a reply's tool calls fold into one quiet line so they never hide what
 * was said. So:
 *
 *   groupChats    the sidebar: the chats grouped by where they live (Web,
 *                 Telegram, Discord, WhatsApp, Email), plain rows,
 *                 newest first, a group longer than a few rows folded to "Show
 *                 n more", the search box's words, collapsed groups
 *   chatName      a chat's name as the sidebar and the title show it
 *   timeLabel     the quiet time on a row: now, 5m, 3h, 2d, Oct 3
 *   chatPath, parseChatPath, pageTitle   the chat's own address and title
 *   stepLabel     one line for a tool step: "Reading README.md", never the raw command
 *   turnLine      the line in the answer's place: "Working", "Used 12 tools"...
 *   replyParts    a saved reply's words, its steps and what it said on the way
 *   sender        "[alice]: words" as { who, body }
 *   renderMarkdown   Markdown to HTML, every character escaped first
 *
 * Loaded by index.html as a plain script (window.ChatCore) and by the tests as
 * a module (globalThis.ChatCore).
 */
(function () {
  "use strict";

  // ------------------------------------------------------------ escaping

  function escapeHtml(text) {
    // Quotes too: the output goes into attributes (href, data-*, title).
    return String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /** Only http(s), mailto, same-site paths and #anchors are links. Anything else (javascript:, data:) is not. */
  function safeHref(url) {
    const u = String(url || "").trim().replace(/&amp;/g, "&");
    if (/^(https?:|mailto:)/i.test(u) || /^\/(?!\/)/.test(u) || /^#/.test(u)) return u.replace(/"/g, "%22").replace(/</g, "%3C").replace(/>/g, "%3E");
    return null;
  }

  // ------------------------------------------------------------ the sidebar

  /** The groups, in the sidebar's order. A platform not listed gets a group of its own at the end. */
  const GROUPS = [
    { id: "web", label: "Web", platforms: ["web"] },
    { id: "telegram", label: "Telegram", platforms: ["telegram"] },
    { id: "discord", label: "Discord", platforms: ["discord"] },
    { id: "whatsapp", label: "WhatsApp", platforms: ["whatsapp"] },
    { id: "email", label: "Email", platforms: ["email"] },
  ];
  const BACKGROUND = { id: "background", label: "Background" };
  /** A group shows this many rows, then "Show n more" (the open chat and a working one always show). */
  const GROUP_LIMIT = 8;

  function groupOf(platform) {
    const p = String(platform || "web");
    return GROUPS.find((g) => g.platforms.includes(p)) || { id: p, label: p.charAt(0).toUpperCase() + p.slice(1), platforms: [p] };
  }

  /** "2026-10-12 09:17:33" (UTC, from SQLite), an ISO date or ms: ms (0 when it is none of them). */
  function parseTs(v) {
    if (typeof v === "number") return Number.isFinite(v) ? v : 0;
    const s = String(v || "");
    if (!s) return 0;
    const t = Date.parse(/^\d{4}-\d\d-\d\d \d\d:\d\d(:\d\d)?$/.test(s) ? `${s.replace(" ", "T")}Z` : s);
    return Number.isNaN(t) ? 0 : t;
  }

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /** The quiet time on a row: "now", "5m", "3h", "2d", then the date ("Oct 3", with the year when it is not this one). */
  function timeLabel(at, now = Date.now()) {
    const t = parseTs(at);
    if (!t) return "";
    const mins = Math.floor((now - t) / 60000);
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d`;
    const d = new Date(t), n = new Date(now);
    return d.getFullYear() === n.getFullYear() ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }

  /**
   * A chat's name. The group already says where it lives, so what the channel
   * put in front of a title goes: Telegram's "Chat with alice" is alice under
   * Telegram, WhatsApp's "WhatsApp · Bob" is Bob, and an email thread's
   * "Email: Invoice" is Invoice under Email.
   */
  function chatName(ch) {
    const key = String(ch?.key || "");
    const title = String(ch?.title || "").trim();
    if (key === "web:default") return "Main Session";
    const platform = ch?.platform || key.split(":")[0];
    if (platform === "web" && (!title || title === "Web Chat" || title === key)) return "New chat";
    const bare = title
      .replace(/^(Chat|Email) with /i, "")
      .replace(/^WhatsApp · /i, "")
      .replace(/^Email: /i, "");
    return bare || title || key || "Chat";
  }

  /** The words of a name or a search as they are compared: lower case, no accents, no # or @, the rest spaces. */
  function foldWords(s) {
    return String(s ?? "").normalize("NFD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  }

  /**
   * The sidebar's groups.
   *   channels   GET /api/chat/channels: [{ key, platform, title, conversationId, updatedAt }]
   *   options    { current: the open chat's conversation id, currentKey: its channel key, working: Set of
   *                conversation ids the agent is working in, unread: Set, collapsed: Set of group ids, expanded: Set of
   *                group ids showing every row, query: the search box, background: [{ conversationId, label }]
   *                (crons and the heartbeat at work: they have no chat of their own), now, limit }
   * Returns [{ id, label, rows: [{ key, convId, platform, name, at, time, working, unread, current }], more, total,
   * collapsed, working }]: groups in the fixed order, Web always there (the Main Session), empty ones left out;
   * rows newest first. While searching, every match shows and nothing is folded.
   */
  function groupChats(channels, options = {}) {
    const {
      current = null, currentKey = null, working = new Set(), unread = new Set(), collapsed = new Set(),
      expanded = new Set(), query = "", background = [], now = Date.now(), limit = GROUP_LIMIT,
    } = options;
    const has = (set, v) => !!v && !!set && typeof set.has === "function" && set.has(v);
    const list = Array.isArray(channels) ? channels.filter((c) => c && c.key) : [];
    if (!list.some((c) => c.key === "web:default")) list.unshift({ key: "web:default", platform: "web", title: "Main Session", conversationId: null, updatedAt: null });
    const words = foldWords(query).split(" ").filter(Boolean);
    const groups = new Map();
    for (const c of list) {
      const platform = c.platform || String(c.key).split(":")[0];
      const g = groupOf(platform);
      const name = chatName({ ...c, platform });
      if (words.length) {
        const hay = `${foldWords(name)} ${foldWords(g.label)} ${foldWords(platform)}`;
        if (!words.every((w) => hay.includes(w))) continue;
      }
      const at = parseTs(c.updatedAt);
      const row = {
        key: c.key, convId: c.conversationId || null, platform, name, at, time: timeLabel(at, now),
        working: has(working, c.conversationId), unread: has(unread, c.conversationId) && c.conversationId !== current,
        current: (current && c.conversationId === current) || (!current && currentKey === c.key),
      };
      if (!groups.has(g.id)) groups.set(g.id, { ...g, rows: [] });
      groups.get(g.id).rows.push(row);
    }
    const order = [...GROUPS.map((g) => g.id), ...[...groups.keys()].filter((id) => !GROUPS.some((g) => g.id === id)).sort()];
    const out = [];
    for (const id of order) {
      const g = groups.get(id);
      if (!g) continue;
      g.rows.sort((a, b) => (b.at - a.at) || a.name.localeCompare(b.name));
      const total = g.rows.length;
      let rows = g.rows;
      let more = 0;
      if (!words.length && !has(expanded, id) && total > limit) {
        const keep = new Set(g.rows.slice(0, limit));
        for (const r of g.rows) if (r.current || r.working || r.unread) keep.add(r);
        rows = g.rows.filter((r) => keep.has(r));
        more = total - rows.length;
      }
      out.push({ id, label: g.label, rows, more, total, collapsed: !words.length && has(collapsed, id) && !rows.some((r) => r.current), working: g.rows.filter((r) => r.working).length });
    }
    const bg = (Array.isArray(background) ? background : []).filter((b) => b && b.conversationId);
    if (bg.length && !words.length) {
      out.push({
        id: BACKGROUND.id, label: BACKGROUND.label, more: 0, total: bg.length, collapsed: has(collapsed, BACKGROUND.id), working: bg.length,
        rows: bg.map((b) => ({ key: `live:${b.conversationId}`, convId: b.conversationId, platform: "background", name: String(b.label || b.conversationId), at: parseTs(b.startedAt), time: "", working: true, unread: false, current: b.conversationId === current })),
      });
    }
    return out;
  }

  // ------------------------------------------------------------ addresses

  /** A chat's own address: /chat/<id> (an id of plain characters as it is, anything else encoded). */
  function chatPath(id) {
    if (!id) return "/chat/new";
    const s = String(id);
    return `/chat/${/^[\w:.-]{1,120}$/.test(s) ? s : encodeURIComponent(s)}`;
  }

  /** What an address asks for: { kind: "chat", id } | { kind: "new" } | { kind: "root" } | { kind: "other" }. */
  function parseChatPath(pathname) {
    const p = String(pathname || "/");
    if (p === "/" || p === "/index.html" || p === "") return { kind: "root" };
    const m = /^\/chat(?:\/([^/]*))?\/?$/.exec(p);
    if (!m) return { kind: "other" };
    let id = m[1] || "";
    try { id = decodeURIComponent(id); } catch { return { kind: "other" }; }
    if (!id || id === "new") return { kind: "new" };
    return /^[\w:.-]{1,120}$/.test(id) ? { kind: "chat", id } : { kind: "other" };
  }

  /** The tab's title: "<chat> · Tarsee", or the bot's name alone. */
  function pageTitle(name, botName = "Tarsee") {
    const n = String(name || "").trim();
    const b = String(botName || "Tarsee").trim() || "Tarsee";
    return n && n !== b ? `${n} · ${b}` : b;
  }

  // ------------------------------------------------------------ steps

  const baseName = (p) => String(p || "").replace(/^…/, "").split(/[\\/]/).filter(Boolean).pop() || String(p || "");
  const hostOf = (u) => { try { return new URL(String(u)).host.replace(/^www\./, ""); } catch { return String(u || "").replace(/^https?:\/\//, "").split("/")[0]; } };
  const clip = (s, n = 110) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
  const RAW_COMMAND = /[|;&$<>`\\]|^\s*(cd|ls|cat|grep|rg|sed|awk|curl|wget|git|npm|npx|pnpm|yarn|node|python3?|pip3?|find|echo|printf|head|tail|for|while|if|export|mkdir|rm|cp|mv|chmod|ssh|scp|docker|railway|gh|jq|sqlite3|open|osascript|brew|launchctl|ps|pgrep|kill|sudo|tar|unzip|xargs|wc|sort|diff|make|bash|zsh|sh|env|source)\b/;
  const SUBCOMMANDS = new Set(["git", "npm", "npx", "pnpm", "yarn", "gh", "railway", "docker", "brew", "launchctl", "pip", "pip3"]);

  const SHELL_WORDS = new Set(["for", "while", "until", "if", "then", "do", "else", "elif", "case", "select", "time", "sudo", "nohup", "env", "exec", "command", "builtin", "!", "{", "(", "export", "source", "."]);

  /**
   * The program a raw command line runs: "git status", "curl", "python3". The shell's own words come off first: a
   * cd in front, "for u in a b; do curl $u; done" (curl), sudo, VAR=value.
   */
  const NOISE = new Set(["echo", "printf", "true", "false", "sleep", "cd", "set", ":", "done", "fi", "esac", "wait"]);
  function programOf(cmd) {
    let line = String(cmd || "").trim();
    // A loop or an if: the command is what it does.
    const body = /^(?:for|while|until|if|select)\b[\s\S]*?(?:;|\n|\s)\s*(?:do|then)\s+([\s\S]+)$/.exec(line);
    if (body) line = body[1];
    const progOf = (seg) => {
      const parts = seg.trim().split(/\s+/).filter(Boolean);
      let k = 0;
      while (k < parts.length && (SHELL_WORDS.has(parts[k]) || /^[A-Za-z_][\w]*=/.test(parts[k]))) k++;
      const prog = baseName((parts[k] || "").replace(/^["'(]+|[;"')]+$/g, ""));
      if (SUBCOMMANDS.has(prog) && /^[a-z][\w-]*$/.test(parts[k + 1] || "")) return `${prog} ${parts[k + 1]}`;
      return prog;
    };
    // The first command that does something (not a cd, an echo or a sleep in front of it).
    const progs = line.split(/;|&&|\|\||\||\n/).map(progOf).filter(Boolean);
    return progs.find((p) => !NOISE.has(p.split(" ")[0])) || progs[0] || "a command";
  }

  /**
   * A one-line summary out of what an older step kept: the arguments as JSON (whole, or cut off), or the text as it
   * is. Its description, command, file, query or address, in that order.
   */
  function summaryOf(text) {
    const s = String(text || "").trim();
    if (!s.startsWith("{")) return s;
    const keys = ["description", "file_path", "command", "query", "url", "pattern", "prompt", "message", "task"];
    try {
      const j = JSON.parse(s);
      for (const k of keys) if (typeof j?.[k] === "string" && j[k].trim()) return j[k].trim();
      const first = Object.values(j || {}).find((v) => typeof v === "string" && v.trim());
      return first ? String(first).trim() : "";
    } catch { /* cut off: read the fields by hand */ }
    for (const k of keys) {
      const m = new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(s);
      if (m && m[1].trim()) { try { return JSON.parse(`"${m[1].replace(/\\$/, "")}"`); } catch { return m[1]; } }
    }
    return "";
  }

  /**
   * One line for a tool step, the way a person would say it: "Reading README.md", "Searched the web: burgman seat",
   * Bash's own description when it has one. Never the raw command: a command line with no description becomes the
   * program it runs ("Ran git status"). running: the present ("Reading"), else the past ("Read").
   *   step { name, summary, input }   (summary: the server's one line, lib transcript-tailer summarizeToolInput)
   */
  function stepLabel(step, { running = false } = {}) {
    const raw = String(step?.name || "tool");
    const name = raw.replace(/^mcp__[^_]+(?:_[^_]+)*?__/, "");
    const key = name.toLowerCase().replace(/^tarsee_/, "");   // (Tarsee's own tools: mcp__tarsee__tarsee_send_file)
    const s = summaryOf(step?.summary);
    const say = (now, past, rest = "") => clip(rest ? `${running ? now : past} ${rest}` : (running ? now : past));
    switch (key) {
      case "bash": {
        if (s && !RAW_COMMAND.test(s)) return clip(s);
        const cmd = s || (typeof step?.input === "string" ? step.input : step?.input?.command) || "";
        return cmd ? say("Running", "Ran", programOf(cmd)) : say("Running a command", "Ran a command");
      }
      case "read": return say("Reading", "Read", baseName(s) || "a file");
      case "write": return say("Writing", "Wrote", baseName(s) || "a file");
      case "edit": case "multiedit": case "notebookedit": return say("Editing", "Edited", baseName(s) || "a file");
      case "grep": { const pat = s.replace(/\s+in\s+\S+$/, ""); return pat ? say("Searching for", "Searched for", `"${clip(pat, 60)}"`) : say("Searching the files", "Searched the files"); }
      case "glob": return s ? say("Finding files:", "Found files:", s) : say("Finding files", "Found files");
      case "websearch": case "web_search": return s ? say("Searching the web:", "Searched the web:", s) : say("Searching the web", "Searched the web");
      case "webfetch": case "web_fetch": return s ? say("Reading", "Read", hostOf(s)) : say("Reading a page", "Read a page");
      case "task": case "agent": return s ? say("Working with a helper:", "Asked a helper:", s) : say("Working with a helper", "Asked a helper");
      case "todowrite": return say("Updating the plan", "Updated the plan");
      case "toolsearch": return say("Looking up tools", "Looked up tools");
      case "send_message": return s ? say("Sending a message:", "Sent a message:", s) : say("Sending a message", "Sent a message");
      case "send_file": return s ? say("Sending", "Sent", baseName(s)) : say("Sending a file", "Sent a file");
      default: {
        const words = name.replace(/^tarsee_/, "").replace(/[_-]+/g, " ").trim();
        const label = words ? words.charAt(0).toUpperCase() + words.slice(1) : "Tool";
        return clip(s && !RAW_COMMAND.test(s) ? `${label}: ${s}` : label);
      }
    }
  }

  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  function fmtDur(ms) {
    const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
  }

  /**
   * The line in the answer's place, while it works and after: { title, detail, tone }.
   *   turn { state: "queued" | "running" | "done" | "stopped" | "failed" | "interrupted" | "removed", tools (how many),
   *          failed, ms, last (the step on now, stepLabel's words), error }
   * Queued: "Queued", "after the reply above". Running: "Working", "3 steps · Reading README.md". Done: "Used 12 tools", "16s" (and how many failed). A turn with
   * no tools at all says nothing once it is done (title ""): the answer is all there is.
   */
  function turnLine(turn) {
    const t = turn || {};
    const n = Math.max(0, Number(t.tools) || 0);
    const failed = Math.max(0, Number(t.failed) || 0);
    const dur = t.ms != null ? fmtDur(t.ms) : "";
    switch (t.state) {
      // Waiting behind the turn still running in this chat: no timer, no tokens, nothing "Thinking" (two "Working"
      // lines at once read as a bug).
      case "queued":
        return { title: "Queued", detail: "after the reply above", tone: "muted" };
      case "removed":
        return { title: "Removed from the queue", detail: "", tone: "muted" };
      case "running":
        return { title: "Working", detail: [n ? plural(n, "step") : "", t.last || "Thinking"].filter(Boolean).join(" · "), tone: "running" };
      case "stopped":
        return { title: dur ? `Stopped after ${dur}` : "Stopped", detail: n ? plural(n, "tool") : "", tone: "muted" };
      case "failed":
        return { title: "Failed", detail: clip(t.error || "Something went wrong", 160), tone: "danger" };
      case "interrupted":
        return { title: "Interrupted", detail: "Tarsee restarted during this turn", tone: "danger" };
      default:
        if (!n) return { title: "", detail: "", tone: "muted" };
        return { title: `Used ${plural(n, "tool")}`, detail: [dur, failed ? `${failed} failed` : ""].filter(Boolean).join(" · "), tone: failed ? "warn" : "muted" };
    }
  }

  /**
   * A saved reply's parts: { answer, notes: [what it said on the way], tools: [{ name, summary, input, output, ok,
   * todos }] }. A dashboard reply that used tools is timeline JSON; a channel reply comes slim with
   * `tools` beside its words (routes/chat.js slimMessage).
   */
  function replyParts(content, tools = null) {
    const raw = String(content ?? "");
    if (raw.startsWith('{"__timeline":true')) {
      let data = null;
      try { data = JSON.parse(raw); } catch { data = null; }
      if (data && Array.isArray(data.items)) {
        const texts = data.items.filter((x) => x && x.type === "text" && String(x.text || "").trim()).map((x) => String(x.text).trim());
        const answer = String(data.text || "").trim() || texts[texts.length - 1] || "";
        const said = plainWords(answer);
        const isNote = (t) => { const n = plainWords(t); return !!n && !said.includes(n.slice(0, 200)); };
        const steps = [];
        for (const x of data.items) {
          if (x?.type === "text" && String(x.text || "").trim() && isNote(String(x.text).trim())) steps.push({ type: "note", text: String(x.text).trim() });
          else if (x?.type === "tool") {
            steps.push({
              type: "tool", name: x.name || "tool", summary: x.summary || summaryOf(x.detail) || "", input: x.input || x.detail || "", output: x.output || "",
              ok: !/^(error|failed)$/i.test(String(x.status || "")), todos: Array.isArray(x.todos) ? x.todos : null,
            });
          }
        }
        return { answer, notes: steps.filter((x) => x.type === "note").map((x) => x.text), tools: steps.filter((x) => x.type === "tool"), steps };
      }
    }
    const list = Array.isArray(tools) ? tools.map((x) => ({ type: "tool", name: x?.name || "tool", summary: x?.summary || "", input: "", output: "", ok: true, todos: null })) : [];
    return { answer: raw, notes: [], tools: list, steps: list };
  }

  /** Words as they are compared (is this note the answer itself?): Markdown's marks and the spacing gone. */
  function plainWords(s) {
    return String(s || "").replace(/[*_`#>~]+/g, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
  }

  /** "[alice]: words" (how the channels save a person's message): { who, body }. No label: who is "". */
  function sender(text) {
    const raw = String(text ?? "");
    const m = /^\[([^\]\n]{1,40})\]:\s*/.exec(raw);
    return m ? { who: m[1], body: raw.slice(m[0].length) } : { who: "", body: raw };
  }

  // ------------------------------------------------------------ Markdown

  // inline()'s own placeholders (\u0001n\u0001), apart from the page's block tokens (\u0000n\u0000), which pass through.
  // eslint-disable-next-line no-control-regex -- U+0000/U+0001 are the renderer's own placeholder markers
  const TOKEN = /\u0001(\d+)\u0001/g;

  /**
   * Inline Markdown on text that is not escaped yet: `code`, [links](url), bare links, **bold**, *italic*, _italic_
   * (not inside snake_case), ~~strike~~. Everything is escaped; only our own tags are added.
   */
  function inline(text) {
    const keep = [];
    const put = (html) => `\u0001${keep.push(html) - 1}\u0001`;
    // eslint-disable-next-line no-control-regex -- U+0000/U+0001 are the renderer's own placeholder markers
    let s = String(text ?? "").replace(/\u0001/g, "");
    // Code spans first: nothing inside them is formatted.
    s = s.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_m, _t, code) => put(`<code>${escapeHtml(code.trim() === "" ? code : code.replace(/^ (.*) $/, "$1"))}</code>`));
    // [label](url "title")
    s = s.replace(/\[([^\]\n]+)\]\(\s*<?((?:[^()\s<>]|\([^()\s<>]*\))+)>?(?:\s+"[^"]*")?\s*\)/g, (m, label, url) => {
      const href = safeHref(url);
      return href ? put(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${formatEm(escapeHtml(label))}</a>`) : put(formatEm(escapeHtml(label)));
    });
    // Bare links (a trailing . , ) ; : ! ? is the sentence's, not the link's).
    // eslint-disable-next-line no-control-regex -- U+0000/U+0001 are the renderer's own placeholder markers
    s = s.replace(/\bhttps?:\/\/[^\s<>"'\u0000\u0001]+/g, (url) => {
      let u = url, tail = "";
      while (/[.,;:!?)\]*_]$/.test(u)) {
        if (u.endsWith(")") && (u.match(/\(/g) || []).length >= (u.match(/\)/g) || []).length) break;
        tail = u.slice(-1) + tail;
        u = u.slice(0, -1);
      }
      const href = safeHref(u);
      return (href ? put(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(u)}</a>`) : escapeHtml(u)) + tail;
    });
    s = formatEm(escapeHtml(s));
    // (A placeholder can hold another: code inside a link's words.)
    for (let k = 0; k < 4 && TOKEN.test(s); k++) { TOKEN.lastIndex = 0; s = s.replace(TOKEN, (_m, i) => keep[Number(i)] ?? ""); }
    TOKEN.lastIndex = 0;
    return s;
  }

  /** Bold, italic and strike on escaped text. */
  function formatEm(html) {
    return html
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>")
      .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*]|[^\s*])\*(?!\*)/g, "$1<em>$2</em>")
      .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_]|[^\s_])_(?!\w)/g, "$1<em>$2</em>")
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
  }

  const RE = {
    fence: /^(\s{0,3})(`{3,}|~{3,})\s*([\w+#.-]*)[^\n]*$/,
    heading: /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/,
    hr: /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/,
    quote: /^\s{0,3}>\s?(.*)$/,
    item: /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/,
    tableSep: /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/,
    // eslint-disable-next-line no-control-regex -- U+0000/U+0001 are the renderer's own placeholder markers
    token: /^\s*\u0000\d+\u0000\s*$/,
  };
  const indentOf = (line) => (/^(\s*)/.exec(line)[1] || "").replace(/\t/g, "    ").length;
  const isBlank = (line) => !String(line).trim();

  function cells(row) {
    let r = row.trim();
    if (r.startsWith("|")) r = r.slice(1);
    if (r.endsWith("|") && !r.endsWith("\\|")) r = r.slice(0, -1);
    return r.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
  }

  function startsBlock(line, next) {
    return RE.fence.test(line) || RE.heading.test(line) || RE.hr.test(line) || RE.quote.test(line) || RE.item.test(line)
      || RE.token.test(line) || (line.includes("|") && next != null && RE.tableSep.test(next) && next.includes("-"));
  }

  function codeBlock(lang, code) {
    const label = lang || "code";
    return `<div class="code-block"><div class="code-header"><span>${escapeHtml(label)}</span><button type="button" class="copy-btn">Copy</button></div><pre><code${lang ? ` class="lang-${escapeHtml(lang)}"` : ""}>${escapeHtml(code)}</code></pre></div>`;
  }

  /** Markdown blocks to HTML. */
  function blocks(lines) {
    const out = [];
    let i = 0;
    const n = lines.length;
    while (i < n) {
      const line = lines[i];
      if (isBlank(line)) { i++; continue; }
      // A block someone else draws (a canvas, a thinking block): its token alone on a line.
      if (RE.token.test(line)) { out.push(line.trim()); i++; continue; }
      let m = RE.fence.exec(line);
      if (m) {
        const fence = m[2], lang = m[3] || "";
        const code = [];
        i++;
        while (i < n && !new RegExp(`^\\s{0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`).test(lines[i])) { code.push(lines[i]); i++; }
        i++;   // (the closing fence; a block still being written has none: the rest is its code)
        out.push(codeBlock(lang, code.join("\n")));
        continue;
      }
      if ((m = RE.heading.exec(line))) {
        const level = Math.min(6, m[1].length);
        out.push(`<h${level}>${inline(m[2])}</h${level}>`);
        i++;
        continue;
      }
      if (RE.hr.test(line)) { out.push("<hr>"); i++; continue; }
      if (RE.quote.test(line)) {
        const inner = [];
        while (i < n && (RE.quote.test(lines[i]) || (!isBlank(lines[i]) && inner.length && !startsBlock(lines[i], lines[i + 1])))) {
          const q = RE.quote.exec(lines[i]);
          inner.push(q ? q[1] : lines[i]);
          i++;
        }
        out.push(`<blockquote>${blocks(inner)}</blockquote>`);
        continue;
      }
      if (line.includes("|") && i + 1 < n && RE.tableSep.test(lines[i + 1]) && lines[i + 1].includes("-")) {
        const head = cells(line);
        const align = cells(lines[i + 1]).map((c) => (/^:-+:$/.test(c) ? "center" : /-+:$/.test(c) ? "right" : /^:-+/.test(c) ? "left" : ""));
        i += 2;
        const body = [];
        while (i < n && lines[i].includes("|") && !isBlank(lines[i])) { body.push(cells(lines[i])); i++; }
        const td = (tag, c, k) => `<${tag}${align[k] ? ` style="text-align:${align[k]}"` : ""}>${inline(c)}</${tag}>`;
        out.push(`<div class="md-table-wrap"><table class="md-table"><thead><tr>${head.map((c, k) => td("th", c, k)).join("")}</tr></thead>`
          + `<tbody>${body.map((r) => `<tr>${head.map((_h, k) => td("td", r[k] ?? "", k)).join("")}</tr>`).join("")}</tbody></table></div>`);
        continue;
      }
      if (RE.item.test(line)) {
        const res = list(lines, i);
        out.push(res.html);
        i = res.next;
        continue;
      }
      // A paragraph: its lines kept as lines (a chat message's line breaks are meant).
      const para = [];
      while (i < n && !isBlank(lines[i]) && !(para.length && startsBlock(lines[i], lines[i + 1]))) { para.push(lines[i].trim()); i++; }
      out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    }
    return out.join("");
  }

  /** A list from lines[start]: its items, each with what is indented under it (a nested list, more lines). */
  function list(lines, start) {
    const first = RE.item.exec(lines[start]);
    const base = indentOf(lines[start]);
    const ordered = /\d/.test(first[2]);
    const items = [];
    let i = start;
    while (i < lines.length) {
      const line = lines[i];
      const m = RE.item.exec(line);
      if (m && indentOf(line) === base && /\d/.test(m[2]) === ordered) { items.push({ text: [m[3]], sub: [] }); i++; continue; }
      if (m && indentOf(line) < base) break;
      if (isBlank(line)) {
        // A blank line inside a list: the list goes on if the next line is one of its items or indented under one.
        let j = i + 1;
        while (j < lines.length && isBlank(lines[j])) j++;
        const nm = j < lines.length ? RE.item.exec(lines[j]) : null;
        if (j < lines.length && ((nm && indentOf(lines[j]) === base && /\d/.test(nm[2]) === ordered) || indentOf(lines[j]) > base)) {
          items[items.length - 1].sub.push("");
          i++;
          continue;
        }
        break;
      }
      if (indentOf(line) > base) { items[items.length - 1].sub.push(line); i++; continue; }
      if (m) break;   // (another kind of list at the same depth: a list of its own)
      // A line straight under an item, not indented: more of that item's words.
      if (!startsBlock(line, lines[i + 1]) && !items[items.length - 1].sub.length) { items[items.length - 1].text.push(line.trim()); i++; continue; }
      break;
    }
    const startNum = ordered ? parseInt(first[2], 10) : 1;
    const li = items.map((it) => {
      const sub = it.sub;
      while (sub.length && isBlank(sub[sub.length - 1])) sub.pop();
      const pad = sub.filter((l) => !isBlank(l)).reduce((min, l) => Math.min(min, indentOf(l)), Infinity);
      const inner = sub.length ? blocks(sub.map((l) => (isBlank(l) ? "" : l.replace(/^\s+/, (ws) => " ".repeat(Math.max(0, ws.replace(/\t/g, "    ").length - pad)))))) : "";
      return `<li>${it.text.map(inline).join("<br>")}${inner}</li>`;
    }).join("");
    const html = ordered ? `<ol${startNum !== 1 ? ` start="${startNum}"` : ""}>${li}</ol>` : `<ul>${li}</ul>`;
    return { html, next: i };
  }

  /**
   * Markdown to HTML for a message. Every character is escaped; only tags of our own are made, and links only to
   * safe places (safeHref). A block drawn by the page itself (a canvas, a thinking block) can be passed in as a token,
   * "\u0000<n>\u0000" on a line of its own, and comes out as it went in, for the page to put its block there.
   */
  function renderMarkdown(text) {
    if (text == null || text === "") return "";
    const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    return blocks(lines);
  }

  const api = {
    escapeHtml, safeHref, GROUPS, GROUP_LIMIT, groupOf, parseTs, timeLabel, chatName, foldWords, groupChats,
    chatPath, parseChatPath, pageTitle, stepLabel, programOf, summaryOf, plainWords, turnLine, fmtDur, replyParts, sender, renderMarkdown, inline,
  };
  globalThis.ChatCore = Object.freeze(api);
})();
