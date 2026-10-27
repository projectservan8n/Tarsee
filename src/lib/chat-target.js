/**
 * Which chat an outbound message or file goes to, when the agent names a channel but not a chat.
 *
 * Every channel keeps a setting per chat, channel_conv.<key> = <conversation id>, where the key is:
 *   telegram:<chat id>                  telegram:<chat id>:topic:<topic id>   (a forum topic)
 *   discord:<channel id>                discord:<parent id>:thread:<thread id>
 *   whatsapp:<chat id>
 *
 * Order of choice:
 *   1. the chat id the agent gave
 *   2. the chat this turn is in (its conversation is the value of one of those settings), so a file asked for on
 *      Telegram goes back to that same Telegram chat
 *   3. the chat of that channel with the latest message; a chat whose setting was cleared (null) is skipped
 * The old rule took the first setting in key order, which is whichever chat id sorts lowest: often a group nobody
 * uses any more.
 */

/** { chatId, threadId } a channel key points at, or null when it is not one of `channel`'s. */
export function chatTargetOf(channel, channelKey) {
  const parts = String(channelKey || "").replace(/^channel_conv\./, "").split(":");
  if (parts[0] !== channel || !parts[1]) return null;
  if (channel === "telegram") return { chatId: parts[1], threadId: parts[2] === "topic" && parts[3] ? parts[3] : null };
  // A Discord thread is a channel of its own: messages go to the thread's id.
  if (channel === "discord") return { chatId: parts[2] === "thread" && parts[3] ? parts[3] : parts[1], threadId: null };
  return { chatId: parts.slice(1).join(":"), threadId: null };
}

/**
 * The chat to send to: { chatId, threadId, how } (how: "given", "this chat" or "latest"), or null when the channel
 * has never had a chat.
 */
export function resolveChatTarget({ channel, channelId = "", conversationId = null, settingsStore = null, db = null }) {
  if (channelId) {
    const given = String(channelId).trim();
    // The current chat's own id given back: keep its forum topic.
    const here = settingsStore && conversationId ? chatsOf(channel, settingsStore).find((c) => c.conversationId === conversationId && c.chatId === given) : null;
    return { chatId: given, threadId: here?.threadId || null, how: "given" };
  }
  if (!settingsStore) return null;
  const chats = chatsOf(channel, settingsStore);
  if (!chats.length) return null;
  const here = conversationId ? chats.find((c) => c.conversationId === conversationId) : null;
  if (here) return { chatId: here.chatId, threadId: here.threadId, how: "this chat" };
  let best = null;
  let bestAt = "";
  for (const c of chats) {
    let at = "";
    try { at = db?.prepare("SELECT MAX(created_at) AS at FROM messages WHERE conversation_id = ?").get(c.conversationId)?.at || ""; } catch { /* no messages table: any chat will do */ }
    if (!best || at > bestAt) { best = c; bestAt = at; }
  }
  return best ? { chatId: best.chatId, threadId: best.threadId, how: "latest" } : null;
}

function chatsOf(channel, settingsStore) {
  const out = [];
  for (const s of settingsStore.getByPrefix(`channel_conv.${channel}:`) || []) {
    if (typeof s.value !== "string" || !s.value) continue;   // a chat whose conversation was cleared
    const t = chatTargetOf(channel, s.key);
    if (t) out.push({ ...t, conversationId: s.value });
  }
  return out;
}

/** The conversation of the chat a message or file went to ({ chatId, threadId }), or null when that chat has none. */
export function conversationOfChat(channel, target, settingsStore) {
  if (!settingsStore || !target?.chatId) return null;
  const want = String(target.chatId);
  // Exactly that chat: a group's own chat is not one of its forum topics.
  return chatsOf(channel, settingsStore).find((c) => c.chatId === want && (c.threadId || null) === (target.threadId || null))?.conversationId || null;
}
