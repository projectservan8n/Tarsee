/**
 * Voice calls: the server's side of them.
 *
 * The call itself runs in the browser (public/js/call.js): it listens, cuts what the person says into utterances,
 * turns each into words with the speech-to-text chosen in Settings > Voice (POST /api/voice/transcribe), sends it as
 * an ordinary chat message to the call's own chat, "Calls with <name>" (POST /api/chat/send, so the chat's own AI and
 * model answer, or the default AI), and speaks the reply with Tarsee's text-to-speech engine (POST
 * /api/voice/tts-stream). Nothing here calls a paid service of its own.
 *
 * This file holds:
 *  - what a call's turn is: its message starts with "[call] ". The mark is taken off before the message is saved,
 *    and the AI is told it is on a call (CALL_HINT in the system prompt, CALL_TURN_REMINDER on the message), so it
 *    answers in a few spoken sentences rather than chat formatting
 *  - the call's chat: one conversation (channel_conv.call:default) named "Calls with <name>", where <name> is the
 *    name from Settings > Identity (identity.name), "Tarsee" when none is set
 *  - the deep ask: "think hard", "take your time" and the like run that one turn on the top tier of the call's AI
 *    (provider-registry.js tiers), when it has a top model other than the one it already runs
 *  - the hang-up handoff: hung up while the AI was still working, the answer goes to the channel chosen in Settings >
 *    Voice > Calls ("Send the answer to", setting call.handoffChannel), through the send_message tool, the same send
 *    path the agent uses. Off (the default) leaves the answer in the call's chat only.
 */
import { onEvent, activeTurnFor, queuedTurnList } from "./live-bus.js";

/** The call's chat, as the channels keep theirs: channel_conv.<key> = <conversation id>. */
export const CALL_CHANNEL_KEY = "call:default";
/** A call's message starts with this. */
export const CALL_MARK = "[call] ";
/** Where the answer goes after a hang-up: a channel id below, or nothing (Off). */
export const HANDOFF_SETTING = "call.handoffChannel";
/** How long after the hang-up an answer is still handed off. */
export const HANDOFF_WINDOW_MS = 30 * 60_000;
/** The channels an answer can be sent to (they can send a message on their own), with their names. */
export const HANDOFF_CHANNELS = Object.freeze({ telegram: "Telegram", discord: "Discord", slack: "Slack", whatsapp: "WhatsApp" });
/** The longest answer sent on (the channels' own limits are a little higher). */
const HANDOFF_MAX_CHARS = 3500;

/** In the system prompt of a call's turn: every word is spoken. */
export const CALL_HINT = "\n\n[LIVE CALL] You are on a live voice call. Everything you write is read aloud by a text-to-speech voice, so write only what a person would say out loud.\n"
  + "- Answer the way you would on the phone: by default a short, natural answer or summary in one to three sentences.\n"
  + "- If you are asked for detail, talk it through in a few flowing spoken sentences, and say the rest is in the chat.\n"
  + "- No formatting of any kind: no bullet points, numbered lists, headings, bold, tables, code, emoji or dashes.\n"
  + "- No web addresses, file paths, IDs or long strings of digits. Say dates, times and amounts the way people say them: October second, half past ten, about twelve hundred dollars.\n"
  + "- Use plain words and contractions, and words instead of symbols such as slashes, ampersands, arrows or percent signs: and, to, about, percent.\n"
  + "- What you hear comes through speech-to-text, so names and words can be misheard: go by the context.\n"
  + "- Do the work with your tools as usual. If you need a decision, ask for it in one sentence.";
/** On every call message, so a long call can't drift back to chat formatting. */
export const CALL_TURN_REMINDER = "\n\n(On a voice call: answer in natural spoken sentences, with no lists, formatting, links or symbols.)";

/** { isCall, text }: whether a message is a call's, and its words without the mark. */
export function callTurn(message) {
  const m = typeof message === "string" ? message : "";
  if (m.startsWith(CALL_MARK)) return { isCall: true, text: m.slice(CALL_MARK.length) };
  if (m === CALL_MARK.trim()) return { isCall: true, text: "" };
  return { isCall: false, text: m };
}

/** The name from Settings > Identity, "Tarsee" when none is set. */
export function botNameOf(settingsStore) {
  let name = "";
  try { name = String(settingsStore?.get?.("identity.name") ?? "").trim(); } catch { name = ""; }
  return name || "Tarsee";
}

export function callTitle(name) {
  return `Calls with ${String(name || "").trim() || "Tarsee"}`;
}

/**
 * The call's chat, made the first time: { id, title, created }. It is named "Calls with <name>", and named again
 * when the name in Settings > Identity changes; a name the owner gave it in the chat's menu is kept.
 */
export function callConversation({ settingsStore, convStore }) {
  const title = callTitle(botNameOf(settingsStore));
  let id = settingsStore.get(`channel_conv.${CALL_CHANNEL_KEY}`);
  let conv = id ? convStore.get(id) : null;
  if (conv) {
    if (conv.title !== title && /^Calls with /.test(String(conv.title || ""))) convStore.updateTitle(id, title);
    return { id, title: /^Calls with /.test(String(conv.title || "")) ? title : conv.title, created: false };
  }
  conv = convStore.create({ title });
  id = conv.id;
  settingsStore.set(`channel_conv.${CALL_CHANNEL_KEY}`, id);
  return { id, title, created: true };
}

/**
 * The words of a stored reply. One that used tools is saved as timeline JSON ({"__timeline":true,...,"text":...})
 * so the chat can draw its steps: the words are its text.
 */
export function replyWords(content) {
  const raw = String(content ?? "");
  if (raw.startsWith('{"__timeline":true')) {
    try {
      const data = JSON.parse(raw);
      return String(data?.text ?? "").trim();
    } catch { return ""; }
  }
  return raw
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, "")
    .trim();
}

function savedChannel(settingsStore) {
  let v = null;
  try { v = settingsStore?.get?.(HANDOFF_SETTING); } catch { v = null; }
  return typeof v === "string" && Object.hasOwn(HANDOFF_CHANNELS, v) ? v : null;
}

function isConnected(channelManager, id) {
  try { return channelManager?.getStatus?.()?.[id]?.status === "running"; } catch { return false; }
}

/**
 * For Settings > Voice > Calls: the channel chosen (null: Off) and every channel an answer could go to, each saying
 * whether it is connected now. A chosen channel that isn't connected is listed too, so the choice shows as made.
 */
export function handoffChoices({ settingsStore, channelManager }) {
  const channel = savedChannel(settingsStore);
  const choices = Object.entries(HANDOFF_CHANNELS)
    .map(([id, label]) => ({ id, label, connected: isConnected(channelManager, id) }))
    .filter((c) => c.connected || c.id === channel);
  return { channel, choices };
}

/** The channel a hang-up's answer goes to now: { channel, label }, or null (Off, or that channel isn't connected). */
export function handoffTarget({ settingsStore, channelManager }) {
  const channel = savedChannel(settingsStore);
  if (!channel || !isConnected(channelManager, channel)) return null;
  return { channel, label: HANDOFF_CHANNELS[channel] };
}

/**
 * Tarsee's own send path (the send_message tool): the channel's latest chat. Resolves to { ok, detail }; never throws.
 */
export function sendThroughChannel({ db, settingsStore, channelManager }) {
  return async (channel, text) => {
    try {
      const { executeTool } = await import("./tools.js");
      // send_message says how it went in its result rather than by throwing.
      const result = String(await executeTool("send_message", { channel, message: text }, { db, settingsStore, channelManager }) ?? "");
      return { ok: /^Message sent/.test(result), detail: result.slice(0, 200) };
    } catch (err) {
      return { ok: false, detail: String(err?.message || err).slice(0, 200) };
    }
  };
}

/** conversationId -> { cancel } */
const pending = new Map();

/**
 * Send the answers that come in this conversation to `channel`, from now: the next reply with words in it, and the
 * one after it too while another of the call's messages is still running or waiting. Stops after that, after
 * `windowMs`, or when cancelHandoff() is called (a new call started). `send(channel, text)` sends one message.
 * Returns whether it was started.
 */
export function startHandoff({ conversationId, channel, send, windowMs = HANDOFF_WINDOW_MS, log = console }) {
  if (!conversationId || !channel || typeof send !== "function") return false;
  pending.get(conversationId)?.cancel();
  let done = false;
  let timer = null;
  const finish = () => {
    if (done) return;
    done = true;
    off();
    clearTimeout(timer);
    if (pending.get(conversationId)?.cancel === finish) pending.delete(conversationId);
  };
  const off = onEvent((evt) => {
    if (done || evt?.conversationId !== conversationId || evt.type !== "message" || evt.payload?.role !== "assistant") return;
    const words = replyWords(evt.payload.content);
    if (!words) return;   // tools only so far: the reply with the words is still to come
    const text = words.length > HANDOFF_MAX_CHARS ? `${words.slice(0, HANDOFF_MAX_CHARS).trimEnd()}…` : words;
    // Another thing said on the call is still running or waiting: its answer comes next, and goes too.
    if (!activeTurnFor(conversationId) && !queuedTurnList(conversationId).length) finish();
    Promise.resolve(send(channel, `From our call:\n\n${text}`)).then((r) => {
      if (r && r.ok === false) log.warn?.(`[call] sending the answer to ${channel} failed: ${r.detail || "no reason given"}`);
      else log.log?.(`[call] the answer went to ${channel} (${conversationId})`);
    }, (err) => log.warn?.(`[call] sending the answer to ${channel} failed: ${err?.message || err}`));
  });
  timer = setTimeout(finish, windowMs);
  timer.unref?.();
  pending.set(conversationId, { cancel: finish });
  return true;
}

/** A new call began before the answer came: it will be heard, not sent. */
export function cancelHandoff(conversationId) {
  pending.get(conversationId)?.cancel();
}

/** Whether an answer from this conversation is waiting to be sent on. */
export function handoffPending(conversationId) {
  return pending.has(conversationId);
}

/**
 * The deep ask for the call's chat: { model: "top", label } when its AI has a top tier model other than the one it
 * runs now (the turn layer maps "top" to it, ai/turn.js resolveTarget), else null. A ChatGPT plan or a Local AI
 * without a tier map has none; a chat already on its top model needs none.
 */
export async function deepAsk({ settingsStore, conversationId }) {
  try {
    const { resolveTarget } = await import("../ai/turn.js");
    const toolCtx = { settingsStore, conversationId };
    const now = (await resolveTarget({ toolCtx }, settingsStore))?.target;
    const top = (await resolveTarget({ toolCtx, model: "top" }, settingsStore))?.target;
    if (!now || !top?.model || !top.engine) return null;
    if (top.provider !== now.provider || top.model === now.model) return null;
    return { model: "top", label: top.label || top.model };
  } catch {
    return null;
  }
}
