/**
 * Live chat view.
 *
 * The server keeps one timeline per conversation (src/lib/live-bus.js):
 * messages, turn starts and ends, and every tool step, each with a sequence
 * number that is never reused. This module draws the chat from that timeline,
 * so every device shows the same thing as it happens, and a device that
 * sleeps, alt-tabs or reconnects asks for "everything after N" and is exactly
 * in sync again.
 *
 * A turn is drawn in the answer's own place, in the reading column: one quiet
 * line while the agent works ("Working · 3 steps · Reading README.md"), which
 * opens to the steps, and when the reply comes it goes under that line, which
 * folds into "Used 12 tools" (Chat.createSteps), so the tool calls never hide
 * what was said.
 *
 * Sends are optimistic: the bubble appears at once marked "Sending", is
 * confirmed when the server echoes it back (matched by clientMsgId), and is
 * kept in localStorage until then, so a reload or a dead tab can never lose
 * it. The server queues turns, so you can send while the agent is still working.
 *
 * Escape hatch: localStorage.tarsee_live_off = "1" falls back to the old
 * per-tab streaming view.
 */
const LIVE_PENDING_KEY = "tarsee_pending_sends";
const LIVE_UNSENT_AFTER_MS = 15_000; // after a reload, a send this old that never landed is "Not sent"
// A reply comes as its own message, just after its turn ends: it takes the turn's place within this long.
const LIVE_REPLY_WINDOW_MS = 90_000;

const SOURCE_LABELS = {
  web: "Dashboard", telegram: "Telegram", discord: "Discord", whatsapp: "WhatsApp",
  email: "Email", cron: "Cron", heartbeat: "Heartbeat", boot: "Boot checklist", api: "API",
};

const Live = {
  enabled: true,
  convId: null,          // conversation on screen (a chat id, or "cron:<id>" / "heartbeat" / "boot")
  lastSeq: 0,
  seen: new Set(),
  turns: new Map(),      // turnId -> { turnId, el (its message), steps, startedAt, endedAt, ended, answered, source }
  activeTurnId: null,
  activity: new Map(),   // conversationId -> active turn summary (every conversation)
  unread: new Set(),
  inflight: new Set(),   // clientMsgIds this tab is sending right now
  _ticker: null,

  init() {
    try { this.enabled = localStorage.getItem("tarsee_live_off") !== "1"; } catch { this.enabled = true; }
    if (!this.enabled) return;
    // Messages queued by the previous client version: keep them, offer Retry.
    try {
      const old = JSON.parse(localStorage.getItem("tarsee_pending_queue") || "[]");
      if (Array.isArray(old) && old.length) {
        const list = this.loadPending();
        for (const q of old) {
          if (q?.text) list.push({ clientMsgId: this.newId(), convId: q.convId || null, channelKey: null, text: q.text, createdAt: 0 });
        }
        this.savePending(list);
      }
      localStorage.removeItem("tarsee_pending_queue");
    } catch { /* ignore */ }
    if (typeof Chat !== "undefined") Chat.messageQueue = [];
    this._ticker = setInterval(() => this.tick(), 1000);
  },

  newId() {
    return "c-" + (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  },

  // ── Socket ──────────────────────────────────────────────────────────
  sock() {
    const ws = Chat._typingWs;
    return ws && ws.readyState === 1 ? ws : null;
  },

  wsSend(obj) {
    const ws = this.sock();
    if (!ws) return false;
    try { ws.send(JSON.stringify(obj)); return true; } catch { return false; }
  },

  /** Called by Chat's socket on every (re)connect. */
  onSocketOpen() {
    if (!this.enabled) return;
    this.wsSend({ type: "live.activity.subscribe" });
    this.subscribe();
  },

  subscribe() {
    if (!this.convId) return;
    // A background job's view starts from its recent runs, not from seq 0.
    const tail = this.pseudo && !this.lastSeq;
    this.wsSend({ type: "live.subscribe", convId: this.convId, sinceSeq: this.lastSeq, ...(tail ? { tail: true } : {}) });
  },

  /** Tab came back: ask for anything missed. No refetch, no redraw. */
  onWake() {
    if (this.sock()) this.subscribe();
  },

  onFrame(data) {
    if (!this.enabled) return;
    if (data.type === "live.backlog") {
      if (data.convId !== this.convId) return;
      const events = data.events || [];
      for (const e of events) this.apply(e, true);
      // A conversation can outrun the backlog cap while a device sleeps for
      // days: redraw from history instead of showing a hole.
      if (events.length >= 1000 && !this.pseudo) Chat.openChannel(Chat.currentChannelKey, this.convId, { push: false });
      if (!data.activeTurn && this.activeTurnId) this.closeStaleTurn();
      Chat.scrollToBottom();
    } else if (data.type === "live.event") {
      if (data.event?.conversationId === this.convId) this.apply(data.event, false);
    } else if (data.type === "live.activity.snapshot") {
      this.activity.clear();
      for (const t of data.turns || []) {
        // The server's label is "Bash: <the raw command>": the step on now, in plain words (as the calls show it).
        const tool = (t.runningTools || []).at(-1);
        this.activity.set(t.conversationId, { ...t, lastStepLabel: tool ? ChatCore.stepLabel(tool, { running: true }) : null });
      }
      this.renderActivity();
    } else if (data.type === "live.activity") {
      this.onActivity(data.event);
    }
  },

  // ── Attaching a conversation ───────────────────────────────────────
  /**
   * Show a conversation live. `data` is the GET /conversations/:id answer
   * (history is already drawn); null for a channel with no conversation yet.
   */
  attach(convId, data, { pseudo = false } = {}) {
    if (!this.enabled) return;
    this.convId = convId || null;
    this.pseudo = pseudo;
    this.lastSeq = Number(data?.liveSeq) || 0;
    this.seen = new Set();
    this.turns = new Map();
    this.activeTurnId = null;
    if (convId) this.unread.delete(convId);
    if (!pseudo) this.drawPendingFor(convId, data?.deliveredClientIds || []);
    this.subscribe();
    this.renderActivity();
    this.updateComposer();
  },

  detach() {
    if (this.convId) this.wsSend({ type: "live.unsubscribe", convId: this.convId });
    this.convId = null;
    this.pseudo = false;
    this.turns = new Map();
    this.activeTurnId = null;
    this.updateComposer();
  },

  /** Open a background job (cron, heartbeat) as a read-only live view, at its own address. */
  openBackground(convId) {
    if (typeof Settings !== "undefined" && Settings.isOpen) Settings.close();
    if (this.convId && this.convId !== convId) this.wsSend({ type: "live.unsubscribe", convId: this.convId });
    Chat.currentChannelKey = "live:" + convId;
    Chat.currentConversationId = null;
    Chat.elements.welcomeScreen.style.display = "none";
    Chat.elements.chatArea.style.display = "flex";
    Chat.elements.inputArea.style.display = "none";
    Chat.elements.chatArea.innerHTML = "";
    Chat.lastMessageRole = null;
    Chat._currentName = this.labelFor(convId);
    Chat._paintHeader();
    Chat._setAddress(ChatCore.chatPath(convId));
    Chat._closeDrawer?.();
    const note = document.createElement("div");
    note.className = "live-note";
    note.textContent = "Background job. Recent runs below; a run in progress updates live.";
    Chat.elements.chatArea.appendChild(note);
    this.attach(convId, { liveSeq: 0 }, { pseudo: true });
    Chat.renderChannelList();
  },

  // ── Applying events ────────────────────────────────────────────────
  apply(evt, fromBacklog) {
    if (!evt || this.seen.has(evt.seq)) return;
    this.seen.add(evt.seq);
    if (evt.seq > this.lastSeq) this.lastSeq = evt.seq;
    switch (evt.type) {
      case "message": this.onMessage(evt, fromBacklog); break;
      case "turn_start": this.onTurnStart(evt); break;
      case "step": this.onStep(evt); break;
      case "turn_end": this.onTurnEnd(evt); break;
      case "cleared": this.onCleared(evt); break;
    }
  },

  area() { return Chat.elements.chatArea; },

  findMsg(attr, value) {
    if (!value) return null;
    try { return this.area().querySelector(`[${attr}="${CSS.escape(String(value))}"]`); } catch { return null; }
  },

  /** The turn a reply that comes now belongs to: the latest one still waiting for its words. */
  waitingTurn(at = Date.now()) {
    const all = [...this.turns.values()];
    for (let i = all.length - 1; i >= 0; i--) {
      const t = all[i];
      if (!t.el?.isConnected) continue;
      if (t.answered) return null;   // (the newest turn has its reply: this one is a second part, or another's)
      if (!t.ended || at - (t.endedAt || at) < LIVE_REPLY_WINDOW_MS) return t;
      return null;
    }
    return null;
  },

  onMessage(evt, fromBacklog) {
    const p = evt.payload || {};
    if (p.id && this.findMsg("data-message-id", p.id)) return;
    if (p.role === "user" && p.clientMsgId) {
      const mine = this.findMsg("data-client-msg-id", p.clientMsgId);
      if (mine) { this.markSent(mine, p.id); this.dropPending(p.clientMsgId); return; }
    }
    let content = String(p.content || "");
    const role = p.role === "user" ? "user" : "assistant";
    if (role === "assistant") {
      content = content.split("|||PERSONALITY_COMPLETE|||")[0].replace(/\[REMEMBER:\s*.+?\]/gi, "").replace(/\n{3,}/g, "\n\n").trim();
      // The reply to a turn on screen goes in that turn's place, under its steps line.
      const turn = this.waitingTurn(evt.createdAt || Date.now());
      if (turn) {
        const parts = Chat.setAnswer(turn.el, content);
        turn.steps.trimNotes(parts.answer);
        turn.answered = true;
        if (p.id) turn.el.dataset.messageId = p.id;
        if (p.truncated) turn.el.querySelector(".message-text")?.insertAdjacentHTML("beforeend", '<p class="live-truncated">(Long reply cut short here. Reload the chat for the full text.)</p>');
        if (!fromBacklog && typeof Setup !== "undefined") Setup.handleStreamComplete(String(p.content || ""));
        Chat.scrollToBottom();
        return;
      }
    }
    const el = Chat._createMessageEl(role, content);
    if (p.id) el.dataset.messageId = p.id;
    if (p.truncated) el.querySelector(".message-text")?.insertAdjacentHTML("beforeend", '<p class="live-truncated">(Long reply cut short here. Reload the chat for the full text.)</p>');
    this.area().appendChild(el);
    if (role === "assistant" && !fromBacklog && typeof Setup !== "undefined") Setup.handleStreamComplete(String(p.content || ""));
    Chat.scrollToBottom();
  },

  onCleared() {
    const area = this.area();
    area.innerHTML = "";
    Chat.lastMessageRole = null;
    this.turns = new Map();
    this.activeTurnId = null;
    const note = document.createElement("div");
    note.className = "live-note";
    note.textContent = "Conversation cleared. A summary was saved to memory.";
    area.appendChild(note);
    this.updateComposer();
  },

  // ── Turns: in the answer's place ───────────────────────────────────
  onTurnStart(evt) {
    if (this.turns.has(evt.turnId)) return;
    const p = evt.payload || {};
    if (Chat.elements.welcomeScreen.style.display !== "none") {
      Chat.elements.welcomeScreen.style.display = "none";
      Chat.elements.chatArea.style.display = "flex";
    }
    const el = Chat._createMessageEl("assistant", "", { streaming: true });
    el.classList.add("is-turn", "is-working");
    el.dataset.turnId = evt.turnId;
    const steps = Chat.createSteps({ state: "running", startedAt: evt.createdAt || Date.now(), onStop: p.source === "web" ? () => this.stop() : null });
    // The chat is an aria-live log; announcing every tool step would drown
    // a screen reader. The reply itself is still announced.
    steps.el.setAttribute("aria-live", "off");
    if (this.pseudo && p.prompt) steps.el.title = p.prompt;
    // Where it came from, when that is not this chat's own app (a cron's run, a message sent from the dashboard).
    const own = String(Chat.currentChannelKey || "").split(":")[0];
    const source = SOURCE_LABELS[p.source] || "";
    if (source && p.source !== own && !(own === "web" && p.source === "web")) {
      const tag = document.createElement("span");
      tag.className = "steps-source";
      tag.textContent = `via ${source}`;
      steps.el.querySelector(".steps-line")?.insertBefore(tag, steps.el.querySelector(".steps-time"));
    }
    el.querySelector(".message-content").prepend(steps.el);
    el._steps = steps;
    const turn = { turnId: evt.turnId, el, steps, startedAt: evt.createdAt, endedAt: null, ended: false, answered: false, source: p.source || null };
    this.turns.set(evt.turnId, turn);
    this.area().appendChild(el);
    this.activeTurnId = evt.turnId;
    this.updateComposer();
    Chat.scrollToBottom();
  },

  onStep(evt) {
    const turn = this.turns.get(evt.turnId);
    if (!turn) return;
    const p = evt.payload || {};
    if (p.kind === "tool_start") {
      turn.steps.addTool({ id: p.id, name: p.name || "tool", summary: p.summary || "", input: p.input || "", startedAt: evt.createdAt });
    } else if (p.kind === "tool_end") {
      turn.steps.endTool(p.id, { ok: p.ok !== false, output: p.preview || "", endedAt: evt.createdAt });
    } else if (p.kind === "text" && p.text) {
      turn.steps.addNote(p.text);
    }
    Chat.scrollToBottom();
  },

  onTurnEnd(evt) {
    const turn = this.turns.get(evt.turnId);
    if (this.activeTurnId === evt.turnId) this.activeTurnId = null;
    this.updateComposer();
    if (!turn || turn.ended) return;
    turn.ended = true;
    turn.endedAt = evt.createdAt || Date.now();
    const reason = String(evt.payload?.stopReason || "ended");
    const error = evt.payload?.error || null;
    const state = error ? "failed" : /interrupt/i.test(reason) ? "interrupted" : /abort|stop/i.test(reason) ? "stopped" : "done";
    turn.steps.finish({ state, endedAt: turn.endedAt, error });
    turn.el.classList.remove("is-working");
    // Nothing to show and no reply came: the turn leaves no trace (a reply that comes later still takes its place).
    if (!turn.answered && state === "done") {
      setTimeout(() => {
        if (!turn.answered && !turn.steps.count() && !turn.steps.notes && turn.el.isConnected) turn.el.remove();
      }, LIVE_REPLY_WINDOW_MS);
    }
    // Sidebar times and order follow the conversation's last activity.
    clearTimeout(this._chanRefresh);
    this._chanRefresh = setTimeout(() => Chat.loadChannels(), 800);
  },

  /** A restart can lose a turn_end that was never written. Close the panel. */
  closeStaleTurn() {
    const turn = this.turns.get(this.activeTurnId);
    this.activeTurnId = null;
    if (turn && !turn.ended) this.onTurnEnd({ turnId: turn.turnId, createdAt: Date.now(), payload: { stopReason: "interrupted" } });
    this.updateComposer();
  },

  tick() {
    for (const turn of this.turns.values()) if (!turn.ended) turn.steps.paint();
  },

  fmtDur(ms) {
    return ChatCore.fmtDur(ms);
  },

  // ── Stop ───────────────────────────────────────────────────────────
  canStop() {
    const turn = this.turns.get(this.activeTurnId);
    return !!(turn && !turn.ended && turn.source === "web" && this.convId);
  },

  async stop() {
    if (!this.convId) return;
    try {
      const r = await API.json("/api/chat/stop", { method: "POST", body: { conversationId: this.convId } });
      App.showToast(r?.stopped ? "Stopping" : "Nothing to stop here", "info");
    } catch (err) {
      App.showToast(err.message || "Stop failed", "error");
    }
  },

  /** Composer hint while a turn runs: sending still works, it queues. */
  updateComposer() {
    const input = Chat.elements.messageInput;
    if (!input) return;
    const busy = !!this.activeTurnId;
    if (!input.dataset.idlePlaceholder) input.dataset.idlePlaceholder = input.placeholder || "";
    input.placeholder = busy ? `${Chat.botName || "Tarsee"} is working. Send to queue.` : input.dataset.idlePlaceholder;
  },

  // ── Sending ────────────────────────────────────────────────────────
  loadPending() {
    try { const v = JSON.parse(localStorage.getItem(LIVE_PENDING_KEY) || "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
  },

  savePending(list) {
    try { localStorage.setItem(LIVE_PENDING_KEY, JSON.stringify(list.slice(-50))); } catch { /* memory only */ }
  },

  dropPending(clientMsgId) {
    this.savePending(this.loadPending().filter((p) => p.clientMsgId !== clientMsgId));
  },

  /** Redraw this conversation's unconfirmed sends after a (re)load. */
  drawPendingFor(convId, delivered) {
    const landed = new Set(delivered || []);
    let list = this.loadPending();
    const before = list.length;
    list = list.filter((p) => !landed.has(p.clientMsgId));
    if (list.length !== before) this.savePending(list);
    const key = Chat.currentChannelKey;
    for (const p of list) {
      const mine = convId ? p.convId === convId || (!p.convId && p.channelKey === key) : (!p.convId && p.channelKey === key);
      if (!mine || this.findMsg("data-client-msg-id", p.clientMsgId)) continue;
      const el = this.drawBubble(p);
      if (this.inflight.has(p.clientMsgId)) continue;
      if (Date.now() - (p.createdAt || 0) > LIVE_UNSENT_AFTER_MS) this.markUnsent(el, p);
      else setTimeout(() => { if (el.isConnected && el.classList.contains("pending") && !this.inflight.has(p.clientMsgId)) this.markUnsent(el, p); }, LIVE_UNSENT_AFTER_MS);
    }
  },

  drawBubble(item, attachments = []) {
    if (Chat.elements.welcomeScreen.style.display !== "none") {
      Chat.elements.welcomeScreen.style.display = "none";
      Chat.elements.chatArea.style.display = "flex";
    }
    const el = Chat._createMessageEl("user", item.text);
    el.dataset.clientMsgId = item.clientMsgId;
    el.classList.add("pending");
    if (attachments.length) el.querySelector(".message-text")?.insertAdjacentHTML("afterend", Chat.renderMessageAttachments(attachments));
    const status = document.createElement("div");
    status.className = "msg-status";
    status.textContent = "Sending…";
    el.querySelector(".message-content")?.appendChild(status);
    this.area().appendChild(el);
    return el;
  },

  markSent(el, messageId) {
    el.classList.remove("pending", "unsent");
    if (messageId) el.dataset.messageId = messageId;
    el.querySelector(".msg-status")?.remove();
  },

  markUnsent(el, item, reason) {
    if (!el?.isConnected) return;
    el.classList.remove("pending");
    el.classList.add("unsent");
    let status = el.querySelector(".msg-status");
    if (!status) {
      status = document.createElement("div");
      status.className = "msg-status";
      el.querySelector(".message-content")?.appendChild(status);
    }
    status.innerHTML = `<span>Not sent${reason ? `: ${escapeHtml(String(reason).slice(0, 120))}` : ""}.</span> `
      + '<button type="button" class="msg-retry">Retry</button> <button type="button" class="msg-discard">Discard</button>';
    status.querySelector(".msg-retry").addEventListener("click", () => {
      el.classList.remove("unsent");
      el.classList.add("pending");
      status.textContent = "Sending…";
      this.post(item, [], el);
    });
    status.querySelector(".msg-discard").addEventListener("click", () => {
      this.dropPending(item.clientMsgId);
      el.remove();
    });
  },

  /** Send from the composer. Never blocked: the server queues behind a running turn. */
  send(text, attachments = []) {
    const item = {
      clientMsgId: this.newId(),
      convId: Chat.currentConversationId || null,
      channelKey: Chat.currentChannelKey || "web:default",
      text,
      createdAt: Date.now(),
    };
    if (!/^\//.test(text)) this.savePending([...this.loadPending(), item]);
    const el = this.drawBubble(item, attachments);
    Chat.scrollToBottom(true);
    this.post(item, attachments, el);
  },

  async post(item, attachments, el) {
    this.inflight.add(item.clientMsgId);
    let confirmed = false;
    let commandText = null;
    const confirm = (convId) => {
      if (confirmed) return;
      confirmed = true;
      this.markSent(el, null);
      this.dropPending(item.clientMsgId);
      // First message of a fresh channel: the server just created it.
      if (Chat.currentChannelKey === item.channelKey) this.adopt(convId);
    };
    try {
      await API.sendMessage(
        item.convId || Chat.currentConversationId,
        item.text,
        (content, event) => {
          if (event) { Chat.handleTurnMeta(event); return; }
          if (content != null) commandText = (commandText || "") + content;
        },
        (data) => {
          if (data?.type === "conversation") { confirm(data.conversationId); return; }
          if (data?.type === "command") {
            // Commands are answered by the server directly and not saved.
            confirmed = true;
            Chat.afterPickCommand?.(item.text);   // /model, /think, /effort: the picker's button shows the change
            this.dropPending(item.clientMsgId);
            this.markSent(el, null);
            el.classList.add("local-command");
            if (commandText) {
              const reply = Chat._createMessageEl("assistant", commandText);
              reply.classList.add("command-result");
              this.area().appendChild(reply);
              Chat.scrollToBottom(true);
            }
            if (/^\/(clear|new)\b/i.test(item.text)) Chat.loadChannels();
            return;
          }
          Chat.handleTurnDone(data);
        },
        (error, info) => {
          if (info?.status === 409 && info.data?.duplicate) { confirm(info.data.conversationId); return; }
          if (!confirmed) { this.markUnsent(el, item, error); return; }
          // After the message landed, the live timeline carries the outcome;
          // a dropped HTTP stream is not an error the user needs to see.
          if (!/connection lost|stream interrupted|network/i.test(String(error))) App.showToast(error, "error");
        },
        item.channelKey,
        attachments.length ? attachments : undefined,
        Chat.getEffort(),
        { clientMsgId: item.clientMsgId, independent: true, model: Chat.getModel?.() },
      );
    } finally {
      this.inflight.delete(item.clientMsgId);
    }
  },

  /** The server just created the conversation for the channel on screen: it gets its own address. */
  adopt(convId) {
    if (!convId || Chat.currentConversationId) return;
    Chat.currentConversationId = convId;
    if (this.enabled) this.attach(convId, { liveSeq: 0 });
    Chat.onConversationCreated?.(convId);
    Chat.loadChannels();
  },

  // ── Activity: what the agent is doing in every conversation ─────────
  onActivity(e) {
    if (!e) return;
    const id = e.conversationId;
    if (e.type === "turn_start") {
      this.activity.set(id, { conversationId: id, turnId: e.turnId, startedAt: e.createdAt, source: e.payload?.source || null, steps: 0, lastStepLabel: null });
    } else if (e.type === "step") {
      const t = this.activity.get(id);
      if (t) {
        t.steps += 1;
        if (e.payload?.kind === "tool_start") t.lastStepLabel = ChatCore.stepLabel({ name: e.payload.name, summary: e.payload.summary }, { running: true });
      }
    } else if (e.type === "turn_end") {
      this.activity.delete(id);
    } else if (e.type === "message") {
      if (id !== this.convId && e.payload?.role === "assistant") this.unread.add(id);
    }
    clearTimeout(this._actPaint);
    this._actPaint = setTimeout(() => this.renderActivity(), 150);
  },

  labelFor(convId) {
    if (convId === "heartbeat") return "Heartbeat";
    if (convId === "boot") return "Boot checklist";
    if (String(convId).startsWith("cron:")) return `Cron · ${String(convId).slice(5).replace(/^cron_/, "")}`;
    const ch = (Chat.channels || []).find((c) => c.conversationId === convId);
    if (!ch) return "Conversation";
    return ChatCore.chatName(ch);
  },

  /** The sidebar shows who is working where (a dot on the row, crons under Background): it is drawn again. */
  renderActivity() {
    Chat.renderChannelList();
  },
};
