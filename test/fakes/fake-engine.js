/**
 * A scripted agent engine for the turn layer's tests (src/ai/turn.js registerEngine): it records what each call was
 * given and yields the events its script says, as a real engine (providers/claude-code.js, providers/codex.js) would.
 *
 *   const engine = createFakeEngine([
 *     [{ type: "session", id: "raw-1" }, { type: "text", content: "Hi" }, { type: "done", stopReason: "end_turn" }],
 *     ...one script per call; the last one repeats
 *   ]);
 *   registerEngine("claude-code", engine);
 *   engine.calls  // what each run() got
 *
 * Besides Tarsee's events a script can hold:
 *   { type: "session", id }   the engine reports its session: onSessionHandle(id) (and onSessionId)
 *   { type: "wait" }          wait until the turn's signal aborts, then end with done{aborted} (a stopped engine)
 *   { type: "sleep", ms }     wait that long (ends early, with done{aborted}, if the signal aborts)
 *   { type: "throw", message } the engine crashes
 * A script can also be a function (opts, callIndex) returning an array of events.
 */
export function createFakeEngine(scripts = [[{ type: "done", stopReason: "end_turn" }]]) {
  const isScript = (s) => Array.isArray(s) || typeof s === "function";
  const list = Array.isArray(scripts) && scripts.length && scripts.every(isScript) ? scripts : [scripts];
  const calls = [];

  async function* run(opts) {
    const index = calls.length;
    calls.push({ ...opts, prompt: lastUserText(opts.messages) });
    const pick = list[Math.min(index, list.length - 1)];
    const events = typeof pick === "function" ? await pick(opts, index) : pick;
    for (const evt of events) {
      if (evt.type === "session") {
        opts.onSessionHandle?.(evt.id);
        continue;
      }
      if (evt.type === "wait") {
        await abortOf(opts.signal);
        yield { type: "done", stopReason: "aborted" };
        return;
      }
      if (evt.type === "sleep") {
        const aborted = await Promise.race([sleep(evt.ms).then(() => false), abortOf(opts.signal).then(() => true)]);
        if (aborted) { yield { type: "done", stopReason: "aborted" }; return; }
        continue;
      }
      if (evt.type === "throw") throw new Error(evt.message || "the engine crashed");
      if (opts.signal?.aborted) { yield { type: "done", stopReason: "aborted" }; return; }
      yield structuredClone(evt);
    }
  }

  return { run, calls };
}

/** The words of a run's last user message (its content blocks' text joined), as the engine would send them. */
export function lastUserText(messages) {
  const last = [...(messages || [])].reverse().find((m) => m?.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  return (Array.isArray(last.content) ? last.content : []).filter((b) => b?.type === "text").map((b) => b.text).join("\n");
}

function sleep(ms) {
  return new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });
}

function abortOf(signal) {
  if (!signal) return new Promise(() => {});
  if (signal.aborted) return Promise.resolve();
  return new Promise((r) => signal.addEventListener("abort", () => r(), { once: true }));
}
