/**
 * Usage: the tokens the agent used, at /usage, and the line under each reply.
 *
 * The page (the main column, like a chat): today, the last 5 hours and the last
 * 7 days; speed and the cache's share; each day or hour in a small chart; tokens
 * by model, channel and chat; the heaviest jobs; and every job, each opening to
 * its numbers and its turns, to be renamed, merged with the job before it or
 * split again (in Tarsee's own dialogs, js/dialogs.js).
 *
 * In a chat: a quiet line under each reply ("12.4k tokens · 38 tk/s · 41s")
 * that opens to the turn's numbers, and the chat's running total at the top of
 * its menu.
 *
 * Opened from the sidebar's Usage button, by the /usage address (js/chat.js
 * route sends it here, so a reload and Back/Forward work), and from a chat's
 * menu (only that chat's jobs).
 *
 * Numbers from /api/analytics/usage* (routes/analytics.js, lib/token-usage.js);
 * the rules with no page are js/usage-core.js.
 */
const Usage = {
  isOpen: false,
  _days: 7,
  _kind: "all",          // all | chats | background
  _filter: null,         // a conversation id: only its jobs
  _chart: "days",        // days | hours
  _shown: 40,
  _overview: null,
  _jobs: null,
  _chats: new Map(),     // conversation id -> { at, data }
  _openJobs: new Set(),

  init() {
    this.page = document.getElementById("usagePage");
    this.btn = document.getElementById("usageBtn");
    if (!this.page) return;
    this.btn?.addEventListener("click", () => this.open({ conversationId: null }));
    this.page.addEventListener("click", (e) => this._onClick(e));
    document.getElementById("chatArea")?.addEventListener("click", (e) => {
      const b = e.target.closest(".msg-usage");
      if (b) this._toggleBreakdown(b);
    });
    let t = 0;
    window.addEventListener("resize", () => { clearTimeout(t); t = setTimeout(() => { if (this.isOpen && this._overview) this._paintChart(); }, 150); });
  },

  /** The agent's name, as the rest of the dashboard calls it. */
  _bot() {
    return (typeof Chat !== "undefined" && Chat.botName) || "Tarsee";
  },

  // ------------------------------------------------------------------ opening and closing

  /** Show the page. conversationId: only that chat's jobs (null: every chat). push: false when the address is already /usage. */
  open({ push = true, conversationId } = {}) {
    if (typeof Settings !== "undefined" && Settings.isOpen) Settings.close();
    if (conversationId !== undefined) this._filter = conversationId || null;
    this.isOpen = true;
    for (const id of ["welcomeScreen", "chatArea", "inputArea"]) {
      const el = document.getElementById(id);
      if (el) el.style.display = "none";
    }
    this.page.hidden = false;
    this.page.scrollTop = 0;
    document.getElementById("topbarTitle").textContent = "Usage";
    const where = document.getElementById("topbarWhere");
    if (where) where.textContent = "";
    const menu = document.getElementById("chatMenuBtn");
    if (menu) menu.disabled = true;   // (a chat's menu has nothing to do with this page)
    this.btn?.classList.add("settings-active");
    if (typeof Chat !== "undefined") {
      Chat._paintTitle?.();
      Chat._closeDrawer?.();
      if (location.pathname !== "/usage") {
        if (push) history.pushState({ usage: true }, "", "/usage");
        else history.replaceState({ usage: true }, "", "/usage");
      }
    }
    if (!this._overview) this.page.innerHTML = '<div class="usage-wrap"><p class="usage-loading">Adding up the tokens…</p></div>';
    this.load();
  },

  /**
   * Hide the page (the caller shows what comes next). address: also put the open chat's address back
   * in the address bar, for a caller that has no address of its own (Settings).
   */
  close({ address = false } = {}) {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.page.hidden = true;
    this.btn?.classList.remove("settings-active");
    const menu = document.getElementById("chatMenuBtn");
    if (menu) menu.disabled = false;
    clearTimeout(this._poll);
    if (address && typeof Chat !== "undefined" && location.pathname === "/usage") {
      const id = Chat.currentConversationId;
      history.replaceState(null, "", id && typeof ChatCore !== "undefined" ? ChatCore.chatPath(id) : "/");
    }
  },

  async load() {
    clearTimeout(this._poll);
    const q = new URLSearchParams({ days: String(this._days) });
    if (this._filter) q.set("conversation", this._filter);
    try {
      const [overview, jobs] = await Promise.all([API.json("/api/analytics/usage"), API.json(`/api/analytics/usage/jobs?${q}`)]);
      if (!this.isOpen) return;
      UsageCore.setTimeZone(overview?.timeZone);
      this._overview = overview;
      this._jobs = jobs;
      this.render();
      // The first read of the transcripts is still going: look again soon. Otherwise once a minute.
      const busy = overview?.progress?.firstPass || overview?.progress?.reading;
      this._poll = setTimeout(() => this.isOpen && this.load(), busy ? 4000 : 60_000);
    } catch (err) {
      if (!this.isOpen) return;
      this.page.innerHTML = `<div class="usage-wrap"><p class="usage-loading">Couldn't load the usage: ${escapeHtml(err.message || "no answer")}. <button type="button" class="usage-link" data-act="reload">Try again</button></p></div>`;
    }
  },

  // ------------------------------------------------------------------ names

  /** A chat's name as the sidebar shows it. */
  chatName(convId, fallback = null) {
    if (!convId) return fallback || "Not in a chat";
    const ch = typeof Chat !== "undefined" ? (Chat.channels || []).find((c) => c.conversationId === convId) : null;
    if (ch && typeof ChatCore !== "undefined") return ChatCore.chatName(ch);
    if (/^(cron:|heartbeat$|boot$)/.test(String(convId)) && typeof Live !== "undefined" && Live.labelFor) return Live.labelFor(convId);
    return fallback || "A chat";
  },

  // ------------------------------------------------------------------ drawing the page

  render() {
    const U = UsageCore;
    const o = this._overview || {};
    const now = o.at || Date.now();
    const card = (label, f, sub) => `<div class="usage-card"><div class="usage-card-label">${label}</div>`
      + `<div class="usage-card-value">${U.tokens(f?.total)}<span> tokens</span></div>`
      + `<div class="usage-card-sub">${sub}</div></div>`;
    const plain = (f) => (f?.total ? `${U.pct(f.cacheShare)} cache reads · ${U.tokens(f.output)} out${f.outTps != null ? ` · ${U.tps(f.outTps)}` : ""}` : "Nothing yet");
    const jobs = o.jobsThisWeek || 0;
    const jobsCard = `<div class="usage-card"><div class="usage-card-label">Jobs, last 7 days</div>`
      + `<div class="usage-card-value">${jobs.toLocaleString("en-US")}<span> job${jobs === 1 ? "" : "s"}</span></div>`
      + `<div class="usage-card-sub">${jobs && o.week?.total ? `about ${U.tokens(o.week.total / jobs)} tokens each` : "Nothing yet"}</div></div>`;
    const p = o.progress || {};
    const reading = p.firstPass ? `<p class="usage-note">Reading Claude Code's session transcripts for the first time${p.bytesLeft ? `, ${Math.max(1, Math.round(p.bytesLeft / 1048576))} MB to go` : ""}. The numbers fill in as it goes.</p>` : "";
    const speed = o.speed || {};
    const stat = (label, value, sub) => `<div class="usage-stat"><div class="usage-stat-value">${value}</div><div class="usage-stat-label">${label}</div><div class="usage-stat-sub">${sub}</div></div>`;
    const html = `<div class="usage-wrap">
      <header class="usage-head">
        <div>
          <h1>Usage</h1>
          <p class="usage-sub">Tokens ${escapeHtml(this._bot())} used, read from Claude Code's session transcripts. Updated ${U.when(now, now)}.</p>
        </div>
        <button type="button" class="usage-btn" data-act="reload">Refresh</button>
      </header>
      ${reading}
      <section class="usage-cards" aria-label="Totals">
        ${card("Today", o.today, plain(o.today))}
        ${card("Last 5 hours", o.windows?.fiveHour, plain(o.windows?.fiveHour))}
        ${card("Last 7 days", o.week, plain(o.week))}
        ${jobsCard}
      </section>
      <section class="usage-stats" aria-label="Speed">
        ${stat("Average speed", speed.outTps != null ? U.tps(speed.outTps) : "none yet", "output, last 7 days")}
        ${stat("Peak speed", speed.peak ? U.tps(speed.peak.outTps) : "none yet", speed.peak ? `${escapeHtml(speed.peak.model)}, one call of ${U.tokens(speed.peak.output)} out` : "a call of 500 out or more")}
        ${stat("Total speed", speed.totalTps != null ? U.tps(speed.totalTps) : "none yet", "every token processed")}
        ${stat("Cache reads", U.pct(o.week?.cacheShare), "of the week's tokens")}
      </section>
      <section class="usage-panel">
        <div class="usage-panel-head">
          <h2>Over time</h2>
          <div class="usage-seg" role="group" aria-label="Chart range">
            <button type="button" data-chart="days" aria-pressed="${this._chart === "days"}">14 days</button>
            <button type="button" data-chart="hours" aria-pressed="${this._chart === "hours"}">24 hours</button>
          </div>
        </div>
        <div class="usage-chart" id="usageChart"></div>
        <div class="usage-legend"><span><i class="usage-sw is-new"></i>Input, cache writes and output</span><span><i class="usage-sw is-cache"></i>Cache reads</span></div>
      </section>
      <section class="usage-split">
        ${this._splitPanel("By model", (o.byModel || []).map((m) => ({ name: m.model, ...m })))}
        ${this._splitPanel("By channel", (o.byChannel || []).map((c) => ({ name: c.channel, ...c })))}
        ${this._splitPanel("By chat", (o.byChat || []).map((c) => ({ name: this.chatName(c.conversationId, c.title), convId: c.conversationId, ...c })))}
      </section>
      <section class="usage-panel">
        <div class="usage-panel-head"><h2>Heaviest jobs, last 7 days</h2></div>
        <div class="usage-jobs">${(o.heaviest || []).map((j) => this._jobRow(j, now, "h")).join("") || '<p class="usage-empty">No jobs yet.</p>'}</div>
      </section>
      <section class="usage-panel" id="usageJobList">${this._jobsPanel(now)}</section>
    </div>`;
    this.page.innerHTML = html;
    this._paintChart();
  },

  _splitPanel(title, rows) {
    const U = UsageCore;
    const max = Math.max(1, ...rows.map((r) => r.total || 0));
    const body = rows.length ? rows.map((r) => `<div class="usage-row">
        <div class="usage-row-top"><span class="usage-row-name">${r.convId ? `<button type="button" class="usage-link" data-filter="${escapeHtml(r.convId)}" title="Only this chat's jobs">${escapeHtml(r.name)}</button>` : escapeHtml(r.name)}</span>
        <span class="usage-row-num">${U.tokens(r.total)}</span></div>
        <div class="usage-bar"><i style="width:${Math.max(1, Math.round((r.total / max) * 100))}%"></i></div>
        <div class="usage-row-sub">${U.tokens(r.output)} out${r.outTps != null ? ` · ${U.tps(r.outTps)}` : ""} · ${U.pct(r.cacheShare)} cache</div>
      </div>`).join("") : '<p class="usage-empty">Nothing yet.</p>';
    return `<div class="usage-panel"><div class="usage-panel-head"><h2>${title}</h2></div>${body}</div>`;
  },

  _jobsPanel(now) {
    const all = this._jobs?.jobs || [];
    const bg = (j) => /^(cron:|heartbeat$|boot$)/.test(String(j.conversationId));
    const jobs = all.filter((j) => this._kind === "all" || (this._kind === "background") === bg(j));
    const chip = (days, label) => `<button type="button" data-days="${days}" aria-pressed="${this._days === days}">${label}</button>`;
    const kind = (k, label) => `<button type="button" data-kind="${k}" aria-pressed="${this._kind === k}">${label}</button>`;
    const filter = this._filter ? `<div class="usage-filter">Only ${escapeHtml(this.chatName(this._filter))} <button type="button" class="usage-link" data-filter="">Show every chat</button></div>` : "";
    const shown = jobs.slice(0, this._shown);
    const sum = jobs.reduce((a, j) => a + (j.total || 0), 0);
    return `<div class="usage-panel-head">
        <h2>Jobs</h2>
        <div class="usage-seg" role="group" aria-label="Which jobs">${kind("all", "All")}${kind("chats", "Chats")}${kind("background", "Background")}</div>
        <div class="usage-seg" role="group" aria-label="How far back">${chip(1, "Today")}${chip(7, "7 days")}${chip(30, "30 days")}</div>
      </div>
      ${filter}
      <p class="usage-quiet usage-jobs-sum">${jobs.length} job${jobs.length === 1 ? "" : "s"}, ${UsageCore.tokens(sum)} tokens. A job is a run of turns in one chat with no more than 45 minutes idle between them; each cron run, heartbeat and boot checklist is a job of its own.</p>
      <div class="usage-jobs">${shown.map((j) => this._jobRow(j, now, "j")).join("") || '<p class="usage-empty">No jobs in this range.</p>'}</div>
      ${jobs.length > shown.length ? `<button type="button" class="usage-btn usage-more" data-act="more">Show ${Math.min(40, jobs.length - shown.length)} more</button>` : ""}`;
  },

  _jobRow(j, now, list) {
    const U = UsageCore;
    const id = `${list}:${j.key}`;
    const open = this._openJobs.has(id);
    const meta = [
      escapeHtml(this.chatName(j.conversationId, j.chatTitle)),
      U.when(j.startedAt, now),
      j.running ? "running" : U.dur((j.endedAt || now) - j.startedAt),
      `${j.turns} turn${j.turns === 1 ? "" : "s"}`,
      // One model: it and its effort ("<model> high"); more: the two it used most ("<model> and <model>").
      escapeHtml((j.models || []).length > 1 ? j.models.slice(0, 2).join(" and ") : [j.models?.[0], j.effort].filter(Boolean).join(" ")),
    ].filter(Boolean).join(" · ");
    return `<div class="usage-job${open ? " is-open" : ""}" data-job="${escapeHtml(id)}">
      <button type="button" class="usage-job-line" aria-expanded="${open}" data-act="job">
        <span class="usage-job-main"><span class="usage-job-title">${escapeHtml(j.title)}${j.running ? ' <span class="usage-badge">running</span>' : ""}${j.merged ? ' <span class="usage-badge">merged</span>' : ""}</span>
        <span class="usage-job-meta">${meta}</span></span>
        <span class="usage-job-nums"><span class="usage-job-total">${U.tokens(j.total)}</span><span class="usage-job-tps">${j.outTps != null ? U.tps(j.outTps) : ""}</span></span>
      </button>
      ${open ? this._jobBody(j, now, list) : ""}
    </div>`;
  },

  _kvs(t) {
    return UsageCore.breakdown(t).map((r) => `<div class="usage-kv${r.strong ? " is-strong" : ""}"${r.note ? ` title="${escapeHtml(r.note)}"` : ""}><span>${r.label}</span><b>${r.value}</b>${r.note ? `<em>${escapeHtml(r.note)}</em>` : ""}</div>`).join("");
  },

  _jobBody(j, now, list) {
    const U = UsageCore;
    const turns = (this._turnsOf(j) || []).map((t) => `<li><a class="usage-turn" href="${escapeHtml(ChatCore.chatPath(t.conversationId))}" data-conv="${escapeHtml(t.conversationId)}">
        <span class="usage-turn-when">${U.when(t.startedAt, now)}</span>
        <span class="usage-turn-title">${escapeHtml(t.title || "A turn")}</span>
        <span class="usage-turn-nums">${escapeHtml(U.answerLine(t) || "no model calls")}</span></a></li>`).join("");
    const acts = list === "j" ? `<div class="usage-job-acts">
        <button type="button" class="usage-btn" data-act="rename" data-key="${escapeHtml(j.key)}">Rename</button>
        <button type="button" class="usage-btn" data-act="merge" data-key="${escapeHtml(j.key)}">Merge with the job before</button>
        ${j.mergedKeys?.length ? `<button type="button" class="usage-btn" data-act="split" data-key="${escapeHtml(j.key)}">Split it again</button>` : ""}
      </div>` : "";
    return `<div class="usage-job-body">
      <div class="usage-kvs">${this._kvs(j)}</div>
      ${turns ? `<h3>Turns</h3><ol class="usage-turns">${turns}</ol>` : ""}
      ${acts}
    </div>`;
  },

  /** A job's turns: in the job list's data (the heaviest list finds the same job there when the range covers it). */
  _turnsOf(j) {
    if (j.turnList) return j.turnList;
    const same = (this._jobs?.jobs || []).find((x) => x.key === j.key);
    return same?.turnList || null;
  },

  _paintChart() {
    const box = this.page.querySelector("#usageChart");
    if (!box) return;
    const U = UsageCore;
    const o = this._overview || {};
    const hours = this._chart === "hours";
    const rows = hours ? o.hours || [] : o.days || [];
    const W = Math.max(260, box.clientWidth || 600);
    const H = 180;
    const pad = { l: 44, r: 6, t: 10, b: 24 };
    const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    const top = U.niceMax(Math.max(1, ...rows.map((r) => r.total || 0)));
    const values = rows.map((r) => ({ total: (r.total || 0), part: (r.total || 0) - (r.cacheRead || 0) }));
    const { bars } = U.bars(values, pw, ph, { gap: rows.length > 16 ? 2 : 6 });
    // (bars scale to the tallest bar; the axis to a round number above it)
    const tallest = Math.max(1, ...values.map((v) => v.total));
    const k = tallest / top;
    const grid = [0, 0.5, 1].map((f) => {
      const y = pad.t + ph - f * ph;
      return `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y}" y2="${y}" class="usage-grid"/><text x="${pad.l - 6}" y="${y + 4}" text-anchor="end" class="usage-axis">${U.tokens(top * f)}</text>`;
    }).join("");
    const every = hours ? (W < 520 ? 6 : 3) : (W < 520 ? 4 : 2);
    // A day's bar is labelled from its middle (its start is midnight, which a clock change can move).
    const label = (r) => (hours ? U.hourLabel(r.from) : U.dayLabel(r.from + 12 * 3_600_000));
    const svgBars = bars.map((b, i) => {
      const h = b.h * k, y = pad.t + ph - h, partH = b.partH * k;
      const x = pad.l + b.x;
      return `<g class="usage-col" data-i="${i}">
        <rect class="usage-hit" x="${pad.l + i * (pw / bars.length)}" y="${pad.t}" width="${pw / bars.length}" height="${ph}"/>
        ${h ? `<rect class="usage-b-cache" x="${x}" y="${y}" width="${b.w}" height="${h}" rx="2"/>` : ""}
        ${partH ? `<rect class="usage-b-new" x="${x}" y="${pad.t + ph - partH}" width="${b.w}" height="${Math.max(1, partH)}" rx="1"/>` : ""}
        ${i % every === (rows.length - 1) % every ? `<text x="${x + b.w / 2}" y="${H - 6}" text-anchor="middle" class="usage-axis">${escapeHtml(label(rows[i]))}</text>` : ""}
      </g>`;
    }).join("");
    box.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Tokens ${hours ? "each hour, the last 24 hours" : "each day, the last 14 days"}">${grid}${svgBars}</svg><div class="usage-tip" hidden></div>`;
    const tip = box.querySelector(".usage-tip");
    const show = (g) => {
      const i = Number(g.dataset.i);
      const r = rows[i];
      if (!r) return;
      const head = hours ? `${label(r)}, ${U.dayLabel(r.from)}` : label(r);
      tip.innerHTML = `<b>${escapeHtml(head)}</b><span>${U.tokens(r.total)} tokens</span><span>${U.tokens(r.cacheRead)} cache reads</span><span>${U.tokens((r.input || 0) + (r.cacheWrite || 0))} in, ${U.tokens(r.output)} out</span>${r.outTps != null ? `<span>${U.tps(r.outTps)}</span>` : ""}`;
      tip.hidden = false;
      const bx = pad.l + (i + 0.5) * (pw / rows.length);
      tip.style.left = `${Math.min(Math.max(8, bx - tip.offsetWidth / 2), W - tip.offsetWidth - 8)}px`;
    };
    box.querySelectorAll(".usage-col").forEach((g) => {
      g.addEventListener("pointerenter", () => show(g));
      g.addEventListener("click", () => show(g));
    });
    box.addEventListener("pointerleave", () => { tip.hidden = true; });
  },

  // ------------------------------------------------------------------ what the page's buttons do

  async _onClick(e) {
    const t = e.target.closest("button, a");
    if (!t || !this.page.contains(t)) return;
    if (t.dataset.chart) { this._chart = t.dataset.chart; this.render(); return; }
    if (t.dataset.days) { this._days = Number(t.dataset.days); this._shown = 40; return this.load(); }
    if (t.dataset.kind) { this._kind = t.dataset.kind; this._shown = 40; this._repaintJobs(); return; }
    if (t.dataset.filter !== undefined) {
      this._filter = t.dataset.filter || null;
      this._shown = 40;
      await this.load();
      this.page.querySelector("#usageJobList")?.scrollIntoView({ block: "start", behavior: "smooth" });
      return;
    }
    if (t.classList.contains("usage-turn")) {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;   // (a new tab opens the chat there)
      e.preventDefault();
      this.close();
      Chat.openChat(t.dataset.conv, { push: true });
      return;
    }
    const act = t.dataset.act;
    if (act === "reload") return this.load();
    if (act === "more") { this._shown += 40; this._repaintJobs(); return; }
    if (act === "job") {
      const id = t.closest(".usage-job")?.dataset.job;
      if (!id) return;
      if (this._openJobs.has(id)) this._openJobs.delete(id); else this._openJobs.add(id);
      const [list, key] = [id.slice(0, 1), id.slice(2)];
      const job = list === "h" ? (this._overview?.heaviest || []).find((j) => j.key === key) : (this._jobs?.jobs || []).find((j) => j.key === key);
      if (job) t.closest(".usage-job").outerHTML = this._jobRow(job, this._overview?.at || Date.now(), list);
      return;
    }
    const key = t.dataset.key;
    if (act === "rename") {
      const job = (this._jobs?.jobs || []).find((j) => j.key === key);
      const name = await TarseeDialog.askText({ title: "Name this job", label: "Name", value: job?.name || job?.title || "", yes: "Save", no: "Cancel" });
      if (name == null) return;
      return this._change(key, { name: String(name) }, "Named");
    }
    if (act === "merge") {
      const ok = await TarseeDialog.ask({ title: "Merge with the job before?", text: "This job's turns join the job before it in the same chat, and their tokens are added up as one job. You can split them again.", yes: "Merge", no: "Cancel" });
      if (ok) return this._change(key, { merge: "previous" }, "Merged");
    }
    if (act === "split") return this._change(key, { split: true }, "Split again");
  },

  async _change(key, body, done) {
    try {
      await API.json(`/api/analytics/usage/jobs/${encodeURIComponent(key)}`, { method: "POST", body });
      App.showToast(done, "success");
      await this.load();
    } catch (err) {
      App.showToast(err.message || "That did not work", "error");
    }
  },

  _repaintJobs() {
    const box = this.page.querySelector("#usageJobList");
    if (box) box.innerHTML = this._jobsPanel(this._overview?.at || Date.now());
  },

  // ------------------------------------------------------------------ in a chat

  /** A chat's numbers (kept half a minute: the menu and the reply lines ask together). */
  async chatData(convId, { fresh = false } = {}) {
    if (!convId) return null;
    const c = this._chats.get(convId);
    if (c && !fresh && Date.now() - c.at < 30_000) return c.data;
    try {
      const data = await API.json(`/api/analytics/usage/chat/${encodeURIComponent(convId)}`);
      UsageCore.setTimeZone(data?.timeZone);
      this._chats.set(convId, { at: Date.now(), data });
      return data;
    } catch { return c?.data || null; }
  },

  /** The line under each saved reply of the chat on screen. */
  async decorate(convId) {
    const data = await this.chatData(convId, { fresh: true });
    if (!data || typeof Chat === "undefined" || Chat.currentConversationId !== convId) return;
    for (const el of document.querySelectorAll("#chatArea .message.assistant[data-message-id]")) {
      const t = data.byMessage?.[el.dataset.messageId];
      if (t) this.attachLine(el, t);
    }
  },

  /** Put (or update) the line under one reply. t: { total, outTps, ms, ... } */
  attachLine(msgEl, t) {
    const text = UsageCore.answerLine(t);
    if (!msgEl || !text) return;
    const content = msgEl.querySelector(".message-content");
    if (!content) return;
    let row = content.querySelector(".message-usage");
    if (!row) {
      row = document.createElement("div");
      row.className = "message-usage";
      row.innerHTML = '<button type="button" class="msg-usage" aria-expanded="false"></button>';
      const actions = content.querySelector(".message-actions");
      content.insertBefore(row, actions || null);
    }
    const b = row.querySelector(".msg-usage");
    b.textContent = text;
    b.title = "This turn's tokens and speed";
    b._turn = t;
    const panel = row.querySelector(".usage-breakdown");
    if (panel) panel.replaceWith(this._breakdownEl(t));
  },

  /**
   * A turn that just ended on screen (js/live.js): its line once the server has read the turn's calls
   * (it reads them a moment after every turn ends), asked twice in case that read was still going.
   */
  turnEnded(msgEl, turnId) {
    if (!turnId) return;
    const ask = async (again) => {
      try {
        const t = await API.json(`/api/analytics/usage/turn/${encodeURIComponent(turnId)}`);
        if (t?.total) { this.attachLine(msgEl, t); return; }
      } catch { /* not read yet */ }
      if (again && msgEl.isConnected) setTimeout(() => ask(false), 12_000);
    };
    setTimeout(() => ask(true), 3500);
  },

  _toggleBreakdown(b) {
    const row = b.closest(".message-usage");
    const open = b.getAttribute("aria-expanded") !== "true";
    b.setAttribute("aria-expanded", String(open));
    row.querySelector(".usage-breakdown")?.remove();
    if (open && b._turn) row.appendChild(this._breakdownEl(b._turn));
  },

  _breakdownEl(t) {
    const el = document.createElement("div");
    el.className = "usage-breakdown";
    const head = [t.model, t.effort, t.ms != null ? `${UsageCore.dur(t.ms)} in all` : ""].filter(Boolean).map((x) => escapeHtml(String(x))).join(" · ");
    el.innerHTML = `${head ? `<div class="usage-breakdown-head">${head}</div>` : ""}<div class="usage-kvs">${this._kvs(t)}</div>`;
    return el;
  },

  /** The chat's running total, for the top of its menu: a block of HTML, or "" when there is nothing to say. */
  menuBlock(data) {
    if (!data?.total?.total) return "";
    const U = UsageCore;
    const t = data.total;
    return `<div class="chat-menu-usage"><div class="chat-menu-usage-num">${U.tokens(t.total)} tokens</div>`
      + `<div class="chat-menu-usage-sub">${data.turns} turn${data.turns === 1 ? "" : "s"}${t.outTps != null ? ` · ${U.tps(t.outTps)} average` : ""} · ${U.pct(t.cacheShare)} cache reads</div>`
      + `${data.since ? `<div class="chat-menu-usage-sub">since ${U.when(data.since)}</div>` : ""}</div>`;
  },
};

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => Usage.init());
  else Usage.init();
}
