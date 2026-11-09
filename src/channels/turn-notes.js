/**
 * What a chat channel (Telegram, Discord, Slack, WhatsApp, email) tells the person when a turn ends without a whole
 * answer, and when a voice note can't be transcribed. One wording for every channel.
 *
 * The AI is named the way the turn layer's route event names it (ai/turn.js: the model's label, "Claude Sonnet",
 * "DeepSeek Flash"), whichever AI the turn ran on, or "The AI" before that event came. The turn layer's errors are
 * already in plain words (what went wrong and, when there is one, what to do), so they are passed on as they are.
 */

/** The AI's name for the person, from the turn's route event. */
export function aiName(route) {
  return route?.label || route?.providerLabel || "The AI";
}

/**
 * An error the turn reported, as the channel says it.
 *   clearHint: how /clear is typed in this channel ("/clear"; in Slack, "reply `@tarsee /clear`")
 *   plain: no emoji (email)
 */
export function turnErrorNote(route, message, { clearHint = "/clear", plain = false } = {}) {
  const said = clip(String(message || "something went wrong").trim(), 600);
  return `${plain ? "" : "⚠️ "}${aiName(route)} ran into a problem: ${said}\n\nTry again — if it keeps happening, ${clearHint} and try fresh.`;
}

/** A turn that went quiet for too long and was given up (the channels' idle watchdog). */
export function idleNote(route, idleMs) {
  const minutes = Math.max(1, Math.round(Number(idleMs) / 60_000) || 1);
  return `⚠️ ${aiName(route)} stopped responding (${minutes} min idle). Try again — maybe with a smaller ask.`;
}

/**
 * Whether an error still has to be said after the answer. Not when the answer already says it: the turn layer's
 * refusals ("Tarsee isn't connected to an AI yet...") are the reply and the error at once.
 */
export function errorStillToSay(answer, message) {
  if (!message) return false;
  return !String(answer || "").includes(String(message).trim());
}

/**
 * What a person can do about a voice note that wasn't transcribed: the transcriber's own words when it says what to
 * set up (voice/stt-handler.js: "stt-unavailable", "stt-failed"), else null (the channel's own wording then).
 */
export function sttProblem(err) {
  if (!err || (err.code !== "stt-unavailable" && err.code !== "stt-failed")) return null;
  return String(err.message || "").trim() || null;
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
