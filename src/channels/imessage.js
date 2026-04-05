/**
 * iMessage channel via BlueBubbles server API.
 * macOS only.
 */

import { buildSystemPrompt } from "../lib/build-system-prompt.js";
import { chatStream } from "../ai/router.js";
import { SettingsStore } from "../db/settings.js";
import { ConversationStore } from "../db/conversations.js";
import { getToolDefinitions, executeTool } from "../lib/tools.js";
import { extractAndSaveMemories } from "../lib/memory-extractor.js";

export async function createIMessageBot(channelConfig, db) {
  if (process.platform !== "darwin") {
    console.warn("[imessage] iMessage is only available on macOS. Skipping.");
    return { stop: () => {} };
  }

  const settingsStore = new SettingsStore(db);
  const convStore = new ConversationStore(db);
  const tools = getToolDefinitions();
  const serverUrl = channelConfig.serverUrl || "http://localhost:1234";
  const password = channelConfig.password || "";

  let running = true;
  let pollTimeout;
  let lastTimestamp = Date.now();

  async function poll() {
    if (!running) return;
    try {
      const res = await fetch(`${serverUrl}/api/v1/message?after=${lastTimestamp}&limit=50`, {
        headers: { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString("base64")}` },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) {
        const data = await res.json();
        for (const msg of data.data || []) {
          if (msg.isFromMe || !msg.text) continue;
          lastTimestamp = Math.max(lastTimestamp, msg.dateCreated);
          const chatId = msg.chats?.[0]?.chatIdentifier || msg.handle?.address || "unknown";
          const text = msg.text;

          const channelKey = `imessage:${chatId}`;
          let convId = settingsStore.get(`channel_conv.${channelKey}`);
          if (!convId || !convStore.get(convId)) {
            const conv = convStore.create({ title: `iMessage: ${chatId}` });
            convId = conv.id;
            settingsStore.set(`channel_conv.${channelKey}`, convId);
          }

          convStore.addMessage(convId, { role: "user", content: text });
          const history = convStore.getRecentMessages(convId, 40);
          const systemPrompt = buildSystemPrompt({ settingsStore, db, conversationId: convId, messageCount: history.length, channelHint: "You are chatting on iMessage." });
          const activeProvider = settingsStore.getActiveProvider();
          if (!activeProvider?.ready) continue;

          let fullResponse = "";
          let workingMessages = history.map((m) => ({ role: m.role, content: m.content }));
          const toolCtx = { db, settingsStore, conversationId: convId };

          try {
            for (let round = 0; round < 10; round++) {
              const toolCalls = []; let roundText = "", stopReason = "end_turn";
              const stream = chatStream({ provider: activeProvider.provider, model: activeProvider.model, apiKey: activeProvider.apiKey, messages: workingMessages, systemPrompt, tools });
              for await (const event of stream) {
                if (event.type === "text") { roundText += event.content; fullResponse += event.content; }
                else if (event.type === "tool_use") toolCalls.push({ id: event.id, name: event.name, input: event.input });
                else if (event.type === "done") { stopReason = event.stopReason || "end_turn"; break; }
              }
              if (toolCalls.length === 0 || stopReason !== "tool_use") break;
              const ac = []; if (roundText) ac.push({ type: "text", text: roundText });
              for (const tc of toolCalls) ac.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
              workingMessages.push({ role: "assistant", content: ac });
              const tr = [];
              for (const tc of toolCalls) { tr.push({ type: "tool_result", tool_use_id: tc.id, content: await executeTool(tc.name, tc.input, toolCtx) }); }
              workingMessages.push({ role: "user", content: tr });
            }
            fullResponse = extractAndSaveMemories(fullResponse, db, convId);
            if (fullResponse) {
              convStore.addMessage(convId, { role: "assistant", content: fullResponse });
              await fetch(`${serverUrl}/api/v1/message/text`, {
                method: "POST",
                headers: { "Content-Type": "application/json", Authorization: `Basic ${Buffer.from(`admin:${password}`).toString("base64")}` },
                body: JSON.stringify({ chatGuid: msg.chats?.[0]?.guid, message: fullResponse }),
              });
            }
          } catch (err) { console.error("[imessage] error:", err.message); }
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") console.warn("[imessage] poll error:", err.message);
    }
    if (running) pollTimeout = setTimeout(poll, 3000);
  }

  poll();
  console.log("[imessage] polling started");
  return { stop: () => { running = false; clearTimeout(pollTimeout); } };
}
