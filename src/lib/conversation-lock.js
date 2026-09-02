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
 */

/** conversationId -> promise chain tail. Absent means idle. */
const chains = new Map();

/** conversationId -> number of turns waiting or running, for observability. */
const depth = new Map();

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
 * @returns {Promise<T>}
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
  const run = (previous ? previous.catch(() => {}) : Promise.resolve()).then(fn);

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
}
