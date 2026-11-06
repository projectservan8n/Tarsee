/**
 * slack-stream.js — one reply, written into a Slack thread as the model produces it.
 *
 * Native (the default): Slack's streaming API (chat.startStream / appendStream / stopStream, 2025-10). Text arrives
 * as markdown chunks and each tool shows as a task card (task_update chunks, 2026-02) that turns complete or error,
 * in one message. Slack caps one stream at 12,000 characters of markdown, 50 tasks and 10 minutes from its start,
 * so a long turn rolls over to a new message in the same thread: the old one is stopped with session_status
 * "processing" (the turn is still going), an open code fence is closed there and opened again in the next message,
 * and tools still running are carried over as running.
 *
 * Editing (the fallback): when Slack refuses native streaming (a workspace or plan without it), the reply is posted
 * and then edited with markdown_text, the way the Discord channel does it: one message per stretch of text, a
 * "⚙️ Running…" line per tool that is edited to "✓ …" when it finishes.
 *
 * Every Slack call goes through one queue, so text, tool cards and the rollover clock never race each other.
 * Nothing here throws to the caller: a failed call is logged, and the reply carries on as best it can.
 */
import { openFence, splitForSlack, SLACK_MAX_MARKDOWN } from "./slack-format.js";

/** Slack's error code on an error @slack/web-api threw ("ratelimited", "feature_disabled"...), or null. */
export function slackErrorCode(err) {
  return err?.data?.error || null;
}

/** Errors meaning native streaming will not work for this app or workspace: stop trying it until a restart. */
const NATIVE_UNAVAILABLE = new Set([
  "feature_disabled", "unknown_method", "method_deprecated", "not_allowed_token_type", "missing_scope",
  "team_not_allowed", "access_denied", "paid_only", "paid_teams_only",
]);

export class SlackReplyStream {
  constructor({
    client, channel, threadTs, recipientUserId = null, recipientTeamId = null,
    native = true, now = Date.now,
    flushIntervalMs = 1000,                 // appendStream is Tier 4; one call a second per reply is well inside it
    editIntervalMs = 1500,                  // chat.update is Tier 3, shared by every reply in the workspace
    maxStreamMs = 9 * 60_000,               // Slack ends a stream 10 minutes after it starts
    maxStreamChars = SLACK_MAX_MARKDOWN,
    maxStreamTasks = 48,
    maxMessageChars = SLACK_MAX_MARKDOWN,
    onStoppedByUser = null, onNativeUnavailable = null, log = console,
  }) {
    Object.assign(this, { client, channel, threadTs, recipientUserId, recipientTeamId, flushIntervalMs, editIntervalMs, maxStreamMs, maxStreamChars, maxStreamTasks, maxMessageChars, onStoppedByUser, onNativeUnavailable, log });
    this.now = now;
    this.mode = native ? "native" : "edit";
    this.sentText = false;
    this.stoppedByUser = false;
    this._queue = Promise.resolve();
    this._pending = "";              // text not yet sent
    this._lastFlushAt = 0;
    this._openTasks = new Map();     // tool id → title, while it runs
    // native
    this._stream = null;             // { ts, startedAt, chars, text, tasks }
    this._reopen = "";               // fence to open again at the start of the next stream
    this._carryTasks = false;        // the last stream stopped mid-turn: show running tools again in the next
    this._endedMidTurn = false;      // the last stop left the agent session "processing"
    // editing
    this._seg = null;                // { ts, shown } the message the current stretch of text is in
    this._segText = "";
    this._toolMsgs = new Map();      // tool id → ts of its status line
  }

  // ── public ────────────────────────────────────────────────────────────────

  /** More of the answer. Sent now if the last send was long enough ago, otherwise with the next one. */
  text(delta) {
    if (!delta) return this._queue;
    return this._run(async () => {
      if (this.stoppedByUser) return;
      this._pending += delta;
      const interval = this.mode === "native" ? this.flushIntervalMs : this.editIntervalMs;
      if (this.now() - this._lastFlushAt >= interval) await this._flush();
    });
  }

  /** A tool started: the text so far goes out first, then the tool's card or status line. */
  toolStart(id, title) {
    return this._run(async () => {
      if (this.stoppedByUser) return;
      this._openTasks.set(id, title);
      if (this.mode === "native") {
        const ok = await this._native(async () => {
          if (this._stream && !this._stream.tasks.has(id) && this._stream.tasks.size >= this.maxStreamTasks) await this._endStream("processing");
          await this._sendNative([{ type: "task_update", id, title, status: "in_progress" }], { flushText: true });
        });
        if (ok) return;
      }
      await this._closeSegment();
      const ts = await this._post(`⚙️ _${title}_`);
      if (ts) this._toolMsgs.set(id, ts);
    });
  }

  /** A tool finished (ok: false when it failed). */
  toolDone(id, title, ok) {
    return this._run(async () => {
      this._openTasks.delete(id);
      if (this.stoppedByUser) return;
      if (this.mode === "native") {
        const sent = await this._native(() => this._sendNative([{ type: "task_update", id, title, status: ok ? "complete" : "error" }], { flushText: true }));
        if (sent) return;
      }
      const line = ok ? `✓ _${title}_` : `❌ _${title}_`;
      const ts = this._toolMsgs.get(id);
      this._toolMsgs.delete(id);
      if (ts) await this._update(ts, line);
      else await this._post(line);
    });
  }

  /** Call every so often: hands a long-running reply over to a new message before Slack's 10-minute stream limit. */
  tick() {
    return this._run(async () => {
      if (this.mode !== "native" || !this._stream || this.stoppedByUser) return;
      if (this.now() - this._stream.startedAt < this.maxStreamMs) return;
      await this._native(async () => {
        await this._endStream("processing");
        // Tools still running show again straight away, so the thread does not look finished while they run.
        if (this._openTasks.size || this._pending) await this._sendNative([], { flushText: true });
      });
    });
  }

  /** The turn is over: send what is left and end the message. */
  finish() {
    return this._run(async () => {
      if (this.mode === "native") {
        const ok = await this._native(async () => {
          if (this.stoppedByUser) this._pending = "";
          // The last of the text rides on the stopStream call when it fits; otherwise it is sent first.
          const fits = this._stream && this._pending.length <= this.maxStreamChars - this._stream.chars
            && this.now() - this._stream.startedAt < this.maxStreamMs;
          if (this._pending && !fits) await this._sendNative([], { flushText: true });
          if (this._stream) {
            const tail = this._pending;
            this._pending = "";
            await this._endStream(undefined, tail);
          } else if (this._endedMidTurn) {
            await this._sessionActive();
          }
        });
        if (ok) return;
      }
      if (!this.stoppedByUser) await this._closeSegment();
      // Status lines of tools that never reported back.
      for (const [id, ts] of this._toolMsgs) {
        await this._update(ts, `❌ _${this._openTasks.get(id) || "Tool"} — did not finish_`);
      }
      this._toolMsgs.clear();
      this._openTasks.clear();
    });
  }

  /** Throw away what this reply has shown so far (the turn is being run again from the start). */
  discard() {
    return this._run(async () => {
      this._pending = "";
      this._openTasks.clear();
      this._reopen = "";
      this._carryTasks = false;
      if (this._stream) {
        const ts = this._stream.ts;
        await this._endStream(undefined);
        await this._call("delete", { channel: this.channel, ts });
      }
      if (this._seg?.ts) await this._call("delete", { channel: this.channel, ts: this._seg.ts });
      this._seg = null;
      this._segText = "";
      this.sentText = false;
    });
  }

  // ── queue ─────────────────────────────────────────────────────────────────

  _run(fn) {
    const p = this._queue.then(fn).catch((err) => this.log?.warn?.("[slack] reply stream:", err?.message || err));
    this._queue = p;
    return p;
  }

  async _flush() {
    if (!this._pending) return;
    if (this.mode === "native") {
      const ok = await this._native(() => this._sendNative([], { flushText: true }));
      if (ok) return;
    }
    await this._flushEdit();
  }

  // ── native streaming ──────────────────────────────────────────────────────

  /**
   * Run native work. On an error that native streaming cannot get past, switch this reply to editing (and tell the
   * bot when the workspace will never stream) and return false so the caller does the same work by editing.
   */
  async _native(fn) {
    if (this.mode !== "native") return false;
    try {
      await fn();
      return true;
    } catch (err) {
      const code = slackErrorCode(err);
      if (code === "stopped_by_user") {
        this._userStopped();
        return true;
      }
      this.log?.warn?.(`[slack] native streaming failed (${code || err?.message}); editing messages for the rest of this reply`);
      if (NATIVE_UNAVAILABLE.has(code)) {
        try { this.onNativeUnavailable?.(code); } catch { /* the bot's cache is best-effort */ }
      }
      if (this._stream) {
        // Best-effort: end the half-written stream so it does not sit "processing" until Slack times it out.
        try { await this.client.chat.stopStream({ channel: this.channel, ts: this._stream.ts }); } catch { /* already gone */ }
        this._stream = null;
      }
      this.mode = "edit";
      return false;
    }
  }

  _userStopped() {
    if (this.stoppedByUser) return;
    this.stoppedByUser = true;
    this._pending = "";
    try { this.onStoppedByUser?.(); } catch { /* caller's handler */ }
  }

  /**
   * Send the waiting text (flushText) and these chunks on the current stream, starting one when there is none and
   * rolling over to a new one before a cap. Throws on a Slack error other than an expired stream.
   */
  async _sendNative(chunks, { flushText = false } = {}) {
    if (this._stream && this.now() - this._stream.startedAt >= this.maxStreamMs) await this._endStream("processing");
    while (flushText && this._pending) {
      const prefix = this._stream ? "" : this._reopen;
      const room = this.maxStreamChars - (this._stream?.chars || 0) - prefix.length;
      if (room <= 0) { await this._endStream("processing"); continue; }
      let piece = this._pending;
      if (piece.length > room) {
        const cut = piece.lastIndexOf("\n", room - 1);
        piece = cut > 0 ? piece.slice(0, cut + 1) : piece.slice(0, room);
      }
      const rest = this._pending.slice(piece.length);
      const last = !rest;
      await this._append([{ type: "markdown_text", text: prefix + piece }, ...(last ? chunks : [])]);
      this._pending = rest;
      if (!last) await this._endStream("processing");
      else return;
    }
    if (chunks.length || !this._stream) await this._append(chunks);
  }

  /** One startStream or appendStream call. A stream Slack already ended is replaced by a new one, once. */
  async _append(chunks) {
    const starting = !this._stream;
    let send = chunks;
    if (starting) send = this._openingChunks(chunks);
    if (!send.length) return;
    try {
      await this._streamCall(starting, send);
    } catch (err) {
      if (slackErrorCode(err) !== "message_not_in_streaming_state" || starting) throw err;
      // Slack closed the stream itself (its 10 minutes ran out): carry on in a new message.
      this._reopen = openFence(this._stream.text) ? `${openFence(this._stream.text)}\n` : "";
      this._stream = null;
      this._carryTasks = true;
      const fresh = this._openingChunks(chunks.map((c) => (c.type === "markdown_text" && this._reopen ? { ...c, text: this._reopen + c.text } : c)));
      this._reopen = "";
      await this._streamCall(true, fresh);
    }
  }

  /** The first chunks of a new stream: running tools carried over, then the fence reopened in front of the text. */
  _openingChunks(chunks) {
    const out = [];
    if (this._carryTasks) {
      for (const [id, title] of this._openTasks) {
        if (!chunks.some((c) => c.type === "task_update" && c.id === id)) out.push({ type: "task_update", id, title, status: "in_progress" });
      }
    }
    if (this._reopen && !chunks.some((c) => c.type === "markdown_text")) out.push({ type: "markdown_text", text: this._reopen });
    return [...out, ...chunks];
  }

  async _streamCall(starting, chunks) {
    if (starting) {
      const args = { channel: this.channel, thread_ts: this.threadTs, task_display_mode: "timeline", chunks };
      if (this.recipientUserId) args.recipient_user_id = this.recipientUserId;
      if (this.recipientTeamId) args.recipient_team_id = this.recipientTeamId;
      const res = await this.client.chat.startStream(args);
      this._stream = { ts: res.ts, startedAt: this.now(), chars: 0, text: "", tasks: new Set() };
      this._reopen = "";
      this._carryTasks = false;
      this._endedMidTurn = false;
    } else {
      await this.client.chat.appendStream({ channel: this.channel, ts: this._stream.ts, chunks });
    }
    for (const c of chunks) {
      if (c.type === "markdown_text") {
        this._stream.chars += c.text.length;
        this._stream.text += c.text;
        if (c.text.trim()) this.sentText = true;
      } else if (c.type === "task_update") {
        this._stream.tasks.add(c.id);
      }
    }
    this._lastFlushAt = this.now();
  }

  /**
   * Stop the current stream, with the last of the text (tail) when there is some. "processing": the turn goes on in
   * a next message, so close what is open here.
   */
  async _endStream(sessionStatus, tail = "") {
    if (!this._stream) return;
    const stream = this._stream;
    this._stream = null;
    const chunks = [];
    const text = stream.text + tail;
    if (tail) {
      chunks.push({ type: "markdown_text", text: tail });
      if (tail.trim()) this.sentText = true;
    }
    const fence = openFence(text);
    if (fence) chunks.push({ type: "markdown_text", text: `${text.endsWith("\n") ? "" : "\n"}${fence.match(/^`+/)[0]}` });
    for (const [id, title] of this._openTasks) {
      if (!stream.tasks.has(id)) continue;
      // Mid-turn the tool goes on in the next message; at the end of the turn it never finished (stopped, aborted).
      chunks.push(sessionStatus === "processing"
        ? { type: "task_update", id, title, status: "pending", details: "Continued below" }
        : { type: "task_update", id, title, status: "error", details: "Did not finish" });
    }
    if (sessionStatus !== "processing") this._openTasks.clear();
    const args = { channel: this.channel, ts: stream.ts };
    if (chunks.length) args.chunks = chunks;
    if (sessionStatus) args.session_status = sessionStatus;
    try {
      await this.client.chat.stopStream(args);
    } catch (err) {
      const code = slackErrorCode(err);
      if (code === "stopped_by_user") this._userStopped();
      else if (code !== "message_not_in_streaming_state") this.log?.warn?.(`[slack] stopStream failed: ${code || err?.message}`);
    }
    if (sessionStatus === "processing") {
      this._reopen = fence ? `${fence}\n` : "";
      this._carryTasks = true;
      this._endedMidTurn = true;
    } else {
      this._endedMidTurn = false;
    }
  }

  /** The turn ended between two streams: set the agent session back to active (it would otherwise spin for an hour). */
  async _sessionActive() {
    this._endedMidTurn = false;
    try {
      await this.client.agents?.sessions?.setStatus?.({ channel_id: this.channel, thread_ts: this.threadTs, status: "active" });
    } catch { /* no agent features in this workspace: nothing is spinning */ }
  }

  // ── editing ───────────────────────────────────────────────────────────────

  async _flushEdit() {
    if (!this._pending) return;
    this._segText += this._pending;
    this._pending = "";
    const pieces = splitForSlack(this._segText, this.maxMessageChars);
    if (!pieces.length) return;
    // Every piece but the last is finished: it goes in the current message, the rest in new ones.
    while (pieces.length > 1) {
      await this._showSegment(pieces.shift());
      this._seg = null;
    }
    this._segText = pieces[0];
    await this._showSegment(pieces[0]);
  }

  async _showSegment(text) {
    if (!text?.trim()) return;
    if (!this._seg?.ts) {
      const ts = await this._post(text);
      this._seg = { ts, shown: text };
    } else if (text !== this._seg.shown) {
      await this._update(this._seg.ts, text);
      this._seg.shown = text;
    }
    this._lastFlushAt = this.now();
    this.sentText = true;
  }

  async _closeSegment() {
    await this._flushEdit();
    this._seg = null;
    this._segText = "";
  }

  async _post(markdown) {
    const res = await this._call("postMessage", { channel: this.channel, thread_ts: this.threadTs, markdown_text: markdown });
    return res?.ts || null;
  }

  async _update(ts, markdown) {
    await this._call("update", { channel: this.channel, ts, markdown_text: markdown });
  }

  async _call(method, args) {
    try {
      return await this.client.chat[method](args);
    } catch (err) {
      this.log?.warn?.(`[slack] chat.${method} failed: ${slackErrorCode(err) || err?.message}`);
      return null;
    }
  }
}
