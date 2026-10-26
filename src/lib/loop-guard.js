/**
 * Notices a dashboard turn stuck repeating itself, so it can be stopped
 * before it burns through the turn budget.
 *
 * Only certain signals count:
 *   - a failure is the SDK's own error flag on a tool's result (is_error),
 *     never words like "error" or "not found" inside a file's text;
 *   - "the same call" is the same tool with the same full input: three Edits
 *     of one file are three different edits, three Reads of one file at
 *     different offsets are three different reads.
 * A turn's length is bounded elsewhere (maxTurns), not here.
 */
export function createLoopGuard() {
  const calls = []; // { id, name, input, isError: null until its result is in }

  /** A tool call started. */
  function onCall(id, name, input) {
    let key = "";
    try { key = JSON.stringify(input ?? null); } catch { key = `unreadable:${id}`; }
    calls.push({ id, name, input: key, isError: null });
  }

  /** A tool's result came back (ok: false when the SDK flags it as an error). */
  function onResult(id, ok) {
    const call = calls.find((c) => c.id === id) || calls[calls.length - 1];
    if (call) call.isError = ok === false;
  }

  /** Why the turn looks stuck, or false. */
  function check() {
    const done = calls.filter((c) => c.isError !== null);
    if (done.length < 3) return false;
    const last3 = done.slice(-3);
    if (last3.every((c) => c.isError && c.name === last3[0].name)) return `${last3[0].name} failed 3 times in a row`;
    if (last3.every((c) => c.input === last3[0].input && c.name === last3[0].name)) return `${last3[0].name} called 3 times with the same input`;
    const last5 = done.slice(-5);
    if (last5.length >= 5 && last5.every((c) => c.isError)) return "5 consecutive tool errors";
    return false;
  }

  return { onCall, onResult, check, get count() { return calls.length; } };
}
