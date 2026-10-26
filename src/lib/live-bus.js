/**
 * Live bus — the single timeline behind the realtime dashboard.
 *
 * Every channel (web, Telegram, Discord, WhatsApp, email, crons) ends up here:
 *   - "message"     a persisted user/assistant message (ConversationStore.addMessage)
 *   - "turn_queued" a message came in while a turn of its conversation was running: this turn waits
 *                   behind it (lib/conversation-lock.js); same turnId as its turn_start later, or its
 *                   turn_end if it never begins
 *   - "turn_start"  the agent starts working on a conversation (provider)
 *   - "step"        a live step inside a turn: tool_start / tool_end / text / thinking / status, and
 *                   "usage" (the turn's tokens so far and its speed, every few seconds), read from the
 *                   SDK's messages as they arrive (lib/tool-steps.js)
 *   - "turn_end"    the turn finished, failed or was stopped (provider)
 *
 * Each event is written to `conversation_events` with a sequence number that is
 * never reused, then pushed to in-process subscribers (the WebSocket hub). A
 * device that reconnects asks for "everything after seq N" and is exactly in
 * sync again, even across a daemon restart. That is what the old in-memory
 * gateway buffer could not do (it emptied on restart and its ids restarted at 1).
 */
import { EventEmitter } from "node:events";
import crypto from "node:crypto";

const MAX_STRING = 8_000;          // cap any single string in a step payload
const MAX_MESSAGE_CHARS = 200_000; // a message event carries the full clean text up to this
const RETENTION_DAYS = Number(process.env.TARSEE_EVENT_RETENTION_DAYS) || 14;

let _db = null;
let _stmts = null;
const emitter = new EventEmitter();
emitter.setMaxListeners(0);

/** convId -> { turnId, startedAt, source, steps, runningTools: Map, lastStepAt } */
const activeTurns = new Map();
/** convId -> Map(turnId -> { turnId, queuedAt, source }): turns waiting behind the running one, oldest first. */
const queuedTurns = new Map();

export function initLiveBus(db) {
  _db = db;
  _stmts = {
    insert: db.prepare(
      "INSERT INTO conversation_events (conversation_id, turn_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)",
    ),
    since: db.prepare(
      "SELECT seq, conversation_id, turn_id, type, payload, created_at FROM conversation_events WHERE conversation_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
    ),
    lastN: db.prepare(
      "SELECT seq, conversation_id, turn_id, type, payload, created_at FROM conversation_events WHERE conversation_id = ? ORDER BY seq DESC LIMIT ?",
    ),
    maxSeq: db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM conversation_events"),
    maxSeqConv: db.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM conversation_events WHERE conversation_id = ?"),
    byTurn: db.prepare(
      "SELECT seq, conversation_id, turn_id, type, payload, created_at FROM conversation_events WHERE turn_id = ? ORDER BY seq ASC LIMIT 1000",
    ),
    prune: db.prepare("DELETE FROM conversation_events WHERE created_at < ?"),
    forgetConv: db.prepare("DELETE FROM conversation_events WHERE conversation_id = ?"),
    forgetMsg: db.prepare("DELETE FROM conversation_events WHERE conversation_id = ? AND type = 'message' AND json_extract(payload, '$.id') = ?"),
    clientIds: db.prepare(
      "SELECT json_extract(payload, '$.clientMsgId') AS c FROM conversation_events WHERE conversation_id = ? AND type = 'message' AND created_at > ? AND json_extract(payload, '$.clientMsgId') IS NOT NULL ORDER BY seq DESC LIMIT 200",
    ),
    hasClientId: db.prepare(
      "SELECT 1 FROM conversation_events WHERE conversation_id = ? AND type = 'message' AND json_extract(payload, '$.clientMsgId') = ? LIMIT 1",
    ),
  };
  // Prune old events hourly. Messages themselves live in `messages`; this is
  // only the live timeline, so two weeks is plenty for catch-up.
  const prune = () => {
    try { _stmts.prune.run(Date.now() - RETENTION_DAYS * 86_400_000); } catch (err) {
      console.warn("[live-bus] prune failed:", err.message);
    }
  };
  prune();
  setInterval(prune, 60 * 60_000).unref?.();

  // A restart kills any turn in flight. Close turns that started but never
  // ended, so no device shows the agent "working" forever on a dead turn.
  // (A turn still waiting in the queue too: its "Queued" line must not wait forever either.)
  try {
    const open = db.prepare(`
      SELECT s.conversation_id, s.turn_id FROM conversation_events s
      WHERE s.type IN ('turn_start', 'turn_queued') AND s.created_at > ?
        AND NOT EXISTS (SELECT 1 FROM conversation_events e
                        WHERE e.type = 'turn_end' AND e.turn_id = s.turn_id)
      GROUP BY s.turn_id
    `).all(Date.now() - 2 * 86_400_000);
    for (const r of open) {
      publish(r.conversation_id, "turn_end", { stopReason: "interrupted", note: "Tarsee restarted during this turn" }, { turnId: r.turn_id });
    }
    if (open.length) console.log(`[live-bus] closed ${open.length} turn(s) left open by a restart`);
  } catch (err) {
    console.warn("[live-bus] open-turn cleanup failed:", err.message);
  }
}

export function newTurnId() {
  return crypto.randomUUID();
}

function capStrings(value, depth = 0) {
  if (typeof value === "string") return value.length > MAX_STRING ? value.slice(0, MAX_STRING) + "…" : value;
  if (depth > 4 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => capStrings(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = capStrings(v, depth + 1);
  return out;
}

function rowToEvent(r) {
  let payload = {};
  try { payload = JSON.parse(r.payload); } catch { /* keep {} */ }
  return {
    seq: r.seq,
    conversationId: r.conversation_id,
    turnId: r.turn_id,
    type: r.type,
    payload,
    createdAt: r.created_at,
  };
}

function trackTurn(evt) {
  const id = evt.conversationId;
  if (evt.type === "turn_queued") {
    if (!queuedTurns.has(id)) queuedTurns.set(id, new Map());
    queuedTurns.get(id).set(evt.turnId, { turnId: evt.turnId, queuedAt: evt.createdAt, source: evt.payload?.source || null });
  } else if (evt.type === "turn_start") {
    unqueue(id, evt.turnId);
    activeTurns.set(id, {
      conversationId: id,
      turnId: evt.turnId,
      startedAt: evt.createdAt,
      source: evt.payload?.source || null,
      steps: 0,
      runningTools: new Map(),
      lastStepAt: evt.createdAt,
      lastStepLabel: null,
    });
  } else if (evt.type === "step") {
    const t = activeTurns.get(id);
    // (A step of another turn, one that overlapped this one, is not this turn's.)
    if (!t || (evt.turnId && t.turnId !== evt.turnId)) return;
    if (evt.payload?.kind === "usage") { t.usage = evt.payload; return; }   // tokens so far, not a step
    t.steps += 1;
    t.lastStepAt = evt.createdAt;
    const p = evt.payload || {};
    if (p.kind === "tool_start") {
      t.runningTools.set(p.id, { name: p.name, summary: p.summary, startedAt: evt.createdAt });
      t.lastStepLabel = p.summary ? `${p.name}: ${p.summary}` : p.name;
    } else if (p.kind === "tool_end") {
      t.runningTools.delete(p.id);
    }
  } else if (evt.type === "turn_end") {
    unqueue(id, evt.turnId);
    // Only the turn that ended: when two overlap in one conversation, the
    // first one's end must not make the one still running look finished.
    const t = activeTurns.get(id);
    if (t && (!evt.turnId || t.turnId === evt.turnId)) activeTurns.delete(id);
  }
}

function unqueue(convId, turnId) {
  const q = queuedTurns.get(convId);
  if (!q) return;
  q.delete(turnId);
  if (!q.size) queuedTurns.delete(convId);
}

/**
 * Append an event to the timeline and push it to subscribers.
 * Never throws: the live view is best-effort and must not break a turn.
 */
export function publish(conversationId, type, payload = {}, { turnId = null } = {}) {
  if (!_db || !conversationId || !type) return null;
  try {
    const createdAt = Date.now();
    const clean = capStrings(payload);
    const info = _stmts.insert.run(conversationId, turnId, type, JSON.stringify(clean), createdAt);
    const evt = { seq: Number(info.lastInsertRowid), conversationId, turnId, type, payload: clean, createdAt };
    trackTurn(evt);
    emitter.emit("event", evt);
    return evt;
  } catch (err) {
    console.warn(`[live-bus] publish ${type} failed: ${err.message}`);
    return null;
  }
}

/**
 * A message's words as its timeline event keeps them, before the ends are
 * trimmed: tool-call JSON stripped (it belongs to steps), no runs of blank
 * lines. [replies] db/conversations.js counts where a reply's own words start
 * in the same words.
 */
export function tidyMessageText(text) {
  return String(text ?? "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, "")
    .replace(/\n{3,}/g, "\n\n");
}

/** Publish a persisted message. Tool-call JSON is stripped: it belongs to steps. */
export function publishMessage(conversationId, message, extra = {}) {
  if (!message) return null;
  let content = tidyMessageText(message.content || "").trim();
  const truncated = content.length > MAX_MESSAGE_CHARS;
  if (truncated) content = content.slice(0, MAX_MESSAGE_CHARS);
  // Bypass the per-string cap: a message carries its full clean text.
  if (!_db || !conversationId) return null;
  try {
    const createdAt = Date.now();
    const payload = { id: message.id, role: message.role, content, truncated, ...extra };
    const info = _stmts.insert.run(conversationId, extra.turnId || null, "message", JSON.stringify(payload), createdAt);
    const evt = { seq: Number(info.lastInsertRowid), conversationId, turnId: extra.turnId || null, type: "message", payload, createdAt };
    emitter.emit("event", evt);
    return evt;
  } catch (err) {
    console.warn(`[live-bus] publishMessage failed: ${err.message}`);
    return null;
  }
}

export function onEvent(fn) {
  emitter.on("event", fn);
  return () => emitter.off("event", fn);
}

/** Events for one conversation after `sinceSeq` (oldest first). */
export function eventsSince(conversationId, sinceSeq = 0, limit = 500) {
  if (!_db) return [];
  return _stmts.since.all(conversationId, Number(sinceSeq) || 0, limit).map(rowToEvent);
}

/** The most recent `limit` events for a conversation (oldest first). */
export function recentEvents(conversationId, limit = 200) {
  if (!_db) return [];
  return _stmts.lastN.all(conversationId, limit).map(rowToEvent).reverse();
}

export function latestSeq(conversationId = null) {
  if (!_db) return 0;
  return (conversationId ? _stmts.maxSeqConv.get(conversationId) : _stmts.maxSeq.get()).seq || 0;
}

/** All events of one turn, oldest first (to rebuild a turn in progress). */
export function eventsForTurn(turnId) {
  if (!_db || !turnId) return [];
  return _stmts.byTurn.all(turnId).map(rowToEvent);
}

/** The turn currently running in a conversation, if any. */
export function activeTurnFor(conversationId) {
  const t = activeTurns.get(conversationId);
  if (!t) return null;
  return {
    conversationId: t.conversationId, turnId: t.turnId, startedAt: t.startedAt, source: t.source,
    steps: t.steps, lastStepAt: t.lastStepAt, lastStepLabel: t.lastStepLabel,
    runningTools: [...t.runningTools.entries()].map(([id, v]) => ({ id, ...v })),
  };
}

/** Snapshot of turns in progress right now (for "working" indicators). */
export function activeTurnList() {
  return [...activeTurns.values()].map((t) => ({
    conversationId: t.conversationId,
    turnId: t.turnId,
    startedAt: t.startedAt,
    source: t.source,
    steps: t.steps,
    lastStepAt: t.lastStepAt,
    lastStepLabel: t.lastStepLabel,
    runningTools: [...t.runningTools.entries()].map(([id, v]) => ({ id, ...v })),
  }));
}

/**
 * clientMsgIds of user messages that reached the server recently. A device
 * that reloads with unconfirmed sends in storage uses this to tell "it
 * landed" from "it never arrived" (and only offers Retry for the latter).
 */
export function recentClientMsgIds(conversationId, sinceMs = 24 * 3_600_000) {
  if (!_db || !conversationId) return [];
  try { return _stmts.clientIds.all(conversationId, Date.now() - sinceMs).map((r) => r.c); } catch { return []; }
}

/** Turns waiting behind a running one right now, oldest first: [{ conversationId, turnId, queuedAt, source }]. */
export function queuedTurnList(conversationId = null) {
  const out = [];
  for (const [convId, q] of queuedTurns) {
    if (conversationId && convId !== conversationId) continue;
    for (const t of q.values()) out.push({ conversationId: convId, ...t });
  }
  return out;
}

/**
 * A deleted or cleared conversation's timeline goes with it: the events carry
 * the messages' full text, and would otherwise stay readable for two weeks.
 */
export function forgetConversation(conversationId) {
  if (!_db || !conversationId) return 0;
  try { return _stmts.forgetConv.run(conversationId).changes; } catch { return 0; }
}

/** A deleted message's event goes with it. */
export function forgetMessage(conversationId, messageId) {
  if (!_db || !conversationId || !messageId) return 0;
  try { return _stmts.forgetMsg.run(conversationId, messageId).changes; } catch { return 0; }
}

/** True when this clientMsgId was already saved in the conversation (retry dedupe). */
export function hasClientMsgId(conversationId, clientMsgId) {
  if (!_db || !conversationId || !clientMsgId) return false;
  try { return !!_stmts.hasClientId.get(conversationId, clientMsgId); } catch { return false; }
}
