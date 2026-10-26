/**
 * Per-conversation turn serialization.
 *
 * Every channel handler resolved a conversation, read its stored Claude
 * session id, and started a turn — with nothing stopping two messages in the
 * same chat from doing that at once. Two concurrent turns then resumed the
 * SAME Claude Code session, which is not a supported thing to do: both
 * processes append to one transcript .jsonl, the second resume reads a file
 * the first is still writing, replies interleave, and the session can be left
 * corrupt enough that every later turn in that chat fails.
 *
 * It is easy to hit without trying. Someone sends "check my calendar", then
 * immediately "actually make it 3pm". On a multi-minute turn, a group chat
 * with two people talking does it constantly.
 *
 * So: at most one turn per conversation, others queue behind it in arrival
 * order. Queueing rather than rejecting matters because the follow-up message
 * is usually a correction the user expects to be read.
 *
 * A turn that has to wait goes on the live timeline as "turn_queued" (the
 * dashboard's "Queued · after the reply above" line, no timer), when the
 * caller says how (opts.live). When its slot comes, the provider claims that
 * turn id (claimQueuedTurn) for its turn_start, so the same line becomes the
 * working line. Its Stop takes it out of the queue alone (removeQueuedTurn):
 * the turn running ahead goes on, and this one never runs.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { publish, newTurnId } from "./live-bus.js";

/** conversationId -> promise chain tail. Absent means idle. */
const chains = new Map();

/** conversationId -> number of turns waiting or running, for observability. */
const depth = new Map();

/** What withConversationTurn returns for a turn taken out of the queue before its slot came. */
export const QUEUE_REMOVED = Symbol("removed from the queue");

/** The queued turn whose slot is running now, for the provider that begins it (claimQueuedTurn). */
const turnStore = new AsyncLocalStorage();

/** turnId -> a turn still waiting for its slot, for removeQueuedTurn. */
const waiting = new Map();

/** Put a turn that has to wait on the live timeline as queued. */
function queueLive(live, convId) {
  const liveConv = live.conversationId || convId;
  const q = { turnId: newTurnId(), liveConv, removed: false, claimed: false, ended: false, slot: false };
  /** Its line ends without the turn having begun (taken out, stopped, or nothing to run). */
  q.end = (stopReason, extra = {}) => {
    if (q.ended || q.claimed) return;
    q.ended = true;
    waiting.delete(q.turnId);
    publish(liveConv, "turn_end", { stopReason, ...extra }, { turnId: q.turnId });
  };
  q.remove = () => {
    if (q.removed || q.slot || q.ended) return false;
    q.removed = true;
    q.end("removed");
    try { live.onRemoved?.(); } catch { /* advisory only */ }
    return true;
  };
  waiting.set(q.turnId, q);
  publish(liveConv, "turn_queued", {
    source: live.source || null,
    model: live.model || null,
    prompt: String(live.prompt || "").slice(0, 300),
  }, { turnId: q.turnId });
  return q;
}

/**
 * The provider beginning a turn in a slot that waited in the queue: the turn
 * id its "Queued" line has, once (a second turn in the same slot gets its
 * own). Null when this turn did not wait, or for another conversation.
 */
export function claimQueuedTurn(liveConvId) {
  const q = turnStore.getStore();
  if (!q || q.claimed || q.ended || (liveConvId && q.liveConv !== liveConvId)) return null;
  q.claimed = true;
  return q.turnId;
}

/** The queued turn whose slot is running now (the caller's own, inside its fn), or null. */
export function currentQueuedTurn() {
  return turnStore.getStore() || null;
}

/**
 * Take a turn still waiting for its slot out of the queue (the Stop on its
 * "Queued" line). False when it is not waiting: it began, ended, or is of
 * another conversation.
 */
export function removeQueuedTurn(turnId, conversationId = null) {
  const q = waiting.get(turnId);
  if (!q || (conversationId && q.liveConv !== conversationId)) return false;
  return q.remove();
}

/**
 * How many turns are queued or running for a conversation.
 * @param {string} convId
 * @returns {number}
 */
export function queueDepth(convId) {
  return depth.get(convId) || 0;
}

/**
 * Run `fn` with exclusive access to a conversation's turn slot.
 *
 * Serializes per conversation only: different chats still run in parallel, so
 * one slow turn in a Telegram group never blocks Discord.
 *
 * The returned promise settles with whatever `fn` returns or throws — callers
 * keep their own error handling. A rejection does not poison the chain: the
 * next queued turn still runs.
 *
 * @template T
 * @param {string} convId
 * @param {() => Promise<T>} fn
 * @param {object} [opts]
 * @param {(position: number) => void} [opts.onQueued] - called when the turn
 *   has to wait, with how many turns are ahead of it. Use it to tell the user
 *   "hold on, still working on the last one" rather than looking hung.
 * @param {object} [opts.live] - when the turn has to wait, show it on the live
 *   timeline as queued: { conversationId (default convId), source, prompt,
 *   model, onRemoved () => void (its Stop took it out of the queue) }
 * @returns {Promise<T | typeof QUEUE_REMOVED>}
 */
export function withConversationTurn(convId, fn, opts = {}) {
  if (!convId) return fn();

  const previous = chains.get(convId);
  depth.set(convId, (depth.get(convId) || 0) + 1);

  if (previous && opts.onQueued) {
    // depth includes this turn, so subtract it to get the number ahead.
    try { opts.onQueued((depth.get(convId) || 1) - 1); } catch { /* advisory only */ }
  }

  // Chain onto the previous turn regardless of how it settled. `.catch` here
  // swallows only the ORDERING dependency, never the caller's result: the
  // caller awaits `run` below, which still rejects properly.
  const queued = previous && opts.live ? queueLive(opts.live, convId) : null;
  const body = !queued ? fn : () => {
    queued.slot = true;
    waiting.delete(queued.turnId);
    if (queued.removed) return QUEUE_REMOVED;
    // Inside fn the provider claims the queued turn id; if nothing does (the
    // turn failed first, a command answered without the model), the line ends.
    return Promise.resolve().then(() => turnStore.run(queued, fn)).then(
      (v) => { queued.end("ended"); return v; },
      (err) => { queued.end("error", { error: "It could not start" }); throw err; },
    );
  };
  const run = (previous ? previous.catch(() => {}) : Promise.resolve()).then(body);

  // The chain tail must never reject, or an unhandled rejection escapes from a
  // link nobody is awaiting and takes the process down.
  const tail = run.catch(() => {});
  chains.set(convId, tail);

  tail.then(() => {
    const remaining = (depth.get(convId) || 1) - 1;
    if (remaining <= 0) {
      // Last one out clears both maps so they cannot grow without bound across
      // the lifetime of a long-running server.
      depth.delete(convId);
      if (chains.get(convId) === tail) chains.delete(convId);
    } else {
      depth.set(convId, remaining);
    }
  });

  return run;
}

/** Test hook: drop all state. */
export function _resetConversationLocks() {
  chains.clear();
  depth.clear();
  waiting.clear();
}
