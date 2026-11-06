/**
 * slack-format.js — text going in and out of Slack.
 *
 * In: Slack sends message text in its own markup (`<@U123>`, `<#C1|general>`, `<https://x|label>`, `&amp;`). The
 * agent reads plain words, so slackTextToPlain unwraps it.
 *
 * Out: Slack draws standard markdown itself now (the `markdown_text` field on chat.postMessage / chat.update and the
 * markdown chunks of chat.startStream, tables and code fences included, since 2026-03). So unlike discord-format.js
 * nothing is redrawn: the answer goes out as the model wrote it, minus Tarsee's own markers.
 */
import { parseReactions } from "./reaction-parser.js";
import { splitMessageFenceSafe } from "./discord-format.js";

/** Most markdown one message or stream takes: Slack's cap is 12,000; the rest is room for a closing fence. */
export const SLACK_MAX_MARKDOWN = 11_000;

/** Slack message text → plain words the agent can read. userName(id) gives a person's name, or null. */
export function slackTextToPlain(text, { botUserId = null, userName = null } = {}) {
  if (!text) return "";
  return String(text)
    .replace(/<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g, (_m, id) => {
      if (id === botUserId) return "";
      const name = typeof userName === "function" ? userName(id) : null;
      return `@${name || id}`;
    })
    .replace(/<#([CG][A-Z0-9]+)(?:\|([^>]*))?>/g, (_m, id, name) => `#${name || id}`)
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_m, label) => label || "@group")
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<((?:https?|mailto):[^|>]+)(?:\|([^>]*))?>/g, (_m, url, label) => {
      const bare = url.replace(/^mailto:/, "");
      if (!label || label === url || label === bare) return bare;
      return `${label} (${bare})`;
    })
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+([,.!?;:])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Whether Slack message text mentions this user (the bot). */
export function mentionsUser(text, userId) {
  if (!text || !userId) return false;
  return new RegExp(`<@${userId}(?:\\|[^>]*)?>`).test(String(text));
}

// The emoji the model tends to react with, by Slack's name. reactions.add takes names, never the emoji itself.
const EMOJI_NAMES = {
  "✅": "white_check_mark", "✔️": "heavy_check_mark", "✔": "heavy_check_mark", "☑️": "ballot_box_with_check",
  "👍": "+1", "👎": "-1", "👀": "eyes", "❤️": "heart", "❤": "heart", "🎉": "tada", "🔥": "fire", "🚀": "rocket",
  "😂": "joy", "🙏": "pray", "👏": "clap", "🤔": "thinking_face", "💯": "100", "⚠️": "warning", "⚠": "warning",
  "❌": "x", "✨": "sparkles", "😊": "blush", "😄": "smile", "🙂": "slightly_smiling_face", "😅": "sweat_smile",
  "👌": "ok_hand", "💪": "muscle", "🙌": "raised_hands", "🤖": "robot_face", "📌": "pushpin", "📝": "memo",
  "⏳": "hourglass_flowing_sand", "😢": "cry", "😮": "open_mouth", "🫡": "saluting_face", "💡": "bulb", "⭐": "star",
  "😎": "sunglasses", "🎯": "dart", "🐒": "monkey", "👋": "wave", "🤝": "handshake", "📎": "paperclip",
  "📅": "date", "🗓️": "spiral_calendar_pad", "📊": "bar_chart", "📈": "chart_with_upwards_trend", "🧠": "brain",
  "🛠️": "hammer_and_wrench", "🔧": "wrench", "🐛": "bug", "🎊": "confetti_ball", "🥳": "partying_face", "😁": "grin",
  "🤯": "exploding_head", "😬": "grimacing", "🙃": "upside_down_face", "😴": "sleeping", "☕": "coffee",
};

/** A reaction the model asked for → the name reactions.add takes, or null when there is none. */
export function slackEmojiName(marker) {
  const s = String(marker || "").trim();
  if (!s) return null;
  if (EMOJI_NAMES[s]) return EMOJI_NAMES[s];
  const bare = s.replace(/^:|:$/g, "");
  // Slack names: lower case letters, digits, _ + - and the ::skin-tone-N suffix.
  if (/^[a-z0-9_+'-]+(?:::skin-tone-[2-6])?$/.test(bare)) return bare;
  return null;
}

/** An answer as Slack shows it: [react: ...] markers and tool-call records out, no runs of blank lines. */
export function displayForSlack(raw) {
  const { cleanText } = parseReactions(raw);
  return String(cleanText ?? "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<tool_response>[\s\S]*?<\/tool_response>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Markdown in pieces Slack takes as one message each, never cutting a code fence in half. */
export function splitForSlack(text, maxLen = SLACK_MAX_MARKDOWN) {
  return splitMessageFenceSafe(String(text || ""), maxLen).filter(Boolean);
}

/** The opening line of a code fence still open at the end of the text ("```js"), or null when none is. */
export function openFence(text) {
  let open = null;
  for (const line of String(text || "").split("\n")) {
    const m = /^\s*(```+)(.*)$/.exec(line);
    if (!m) continue;
    open = open ? null : `${m[1]}${m[2].trim()}`;
  }
  return open;
}

const MARKER_HEADS = ["[react:", "[remember:"];
const MARKER = /^\[(?:react|remember):[^\]\n]*\]/i;
const MAX_MARKER = 300;

/**
 * Takes the [react: ...] and [REMEMBER: ...] markers out of streamed text as it arrives. A Slack stream cannot take
 * back what it has sent, so a "[" that could still turn into a marker is held until it either closes (and is
 * dropped: the reaction is added and the memory saved from the full answer afterwards) or turns out to be ordinary
 * text, a link or a footnote, and is let through.
 */
export class MarkerFilter {
  constructor() { this.held = ""; }

  /** More text in; the part of it that is safe to show out. */
  push(delta) {
    let buf = this.held + String(delta ?? "");
    this.held = "";
    let out = "";
    for (;;) {
      const i = buf.indexOf("[");
      if (i < 0) return out + buf;
      out += buf.slice(0, i);
      buf = buf.slice(i);
      const whole = MARKER.exec(buf);
      if (whole) { buf = buf.slice(whole[0].length); continue; }
      const lower = buf.toLowerCase();
      const maybe = MARKER_HEADS.some((h) => h.startsWith(lower) || (lower.startsWith(h) && !/[\]\n]/.test(buf)));
      if (maybe && buf.length < MAX_MARKER) { this.held = buf; return out; }
      out += "[";
      buf = buf.slice(1);
    }
  }

  /** The stream is over: whatever was held was never a marker. */
  end() {
    const rest = this.held;
    this.held = "";
    return rest;
  }
}

/** A command reply without the web dashboard's sentinels ("__SET_THEME__:dark|Theme set..." → "Theme set..."). */
export function stripCommandSentinel(text) {
  return String(text ?? "").replace(/^__SET_THEME__:[^|]*\|/, "");
}
