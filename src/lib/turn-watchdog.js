/**
 * turn-watchdog.js: the end of a turn that an HTTP caller is waiting on (the external API, ACP).
 *
 * The chat channels give up a turn that sends nothing for TARSEE_CHANNEL_IDLE_ABORT_MS (20 minutes when unset): an AI
 * that never answers (a Local AI server that hangs, a stalled connection) would otherwise hold the conversation's lock
 * and the engine's process for good, with nothing to stop it. A turn an HTTP caller waits on gets the same limit, and
 * it also stops when the caller goes away, since nobody is left to read the answer.
 *
 *   const watch = watchTurn(res);         (or watchTurn(res, { armed: false }) and watch.touch() once the turn begins,
 *                                          for a turn that may first wait in its conversation's queue)
 *   for await (const event of chatStream({ ..., signal: watch.signal })) { watch.touch(); ... }
 *   watch.stop();
 *   if (watch.idled) ... answer 504 with idleNote(route, watch.idleMs, { plain: true })
 *   if (watch.left) ... nobody to answer
 */

/** How long a turn may go without an event (the same variable as the chat channels'). */
export function idleLimitMs(env = process.env) {
  return Number(env?.TARSEE_CHANNEL_IDLE_ABORT_MS) || 20 * 60_000;
}

/**
 * Watch one turn for the response `res` (any object with on/off "close" and writableEnded). Returns
 * { signal, idleMs, idled, left, touch(), stop() }: signal aborts once the turn has been idle for idleMs, or the
 * caller left before the answer was written; idled and left say which. The idle clock starts now, or with armed: false
 * at the first touch().
 */
export function watchTurn(res, { idleMs = idleLimitMs(), armed = true } = {}) {
  const ac = new AbortController();
  let last = Date.now();
  let timer = null;
  const arm = () => {
    timer = setInterval(() => {
      if (Date.now() - last <= idleMs || ac.signal.aborted) return;
      watch.idled = true;
      clearInterval(timer);
      ac.abort();
    }, Math.min(15_000, Math.max(25, Math.floor(idleMs / 4))));
    timer.unref?.();
  };
  let stopped = false;
  const watch = {
    signal: ac.signal,
    idleMs,
    idled: false,
    left: false,
    touch() {
      last = Date.now();
      if (!timer && !stopped) arm();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      res?.off?.("close", onClose);
    },
  };
  const onClose = () => {
    if (res.writableEnded || ac.signal.aborted) return;
    watch.left = true;
    ac.abort();
  };
  res?.on?.("close", onClose);
  if (armed) arm();
  return watch;
}
