/**
 * LINE Messaging API channel for Tarsee.
 */

import { buildSystemPrompt } from "../lib/build-system-prompt.js";
import { chatStream } from "../ai/router.js";
import { SettingsStore } from "../db/settings.js";
import { ConversationStore } from "../db/conversations.js";
import { getToolDefinitions, executeTool } from "../lib/tools.js";
import { extractAndSaveMemories } from "../lib/memory-extractor.js";

export async function createLineBot(channelConfig, db) {
  const settingsStore = new SettingsStore(db);
  const convStore = new ConversationStore(db);
  const tools = getToolDefinitions();
  const channelAccessToken = channelConfig.token;
  if (!channelAccessToken) throw new Error("LINE requires a channel access token");

  let running = true;
  const API_BASE = "https://api.line.me/v2/bot";
  const headers = { Authorization: `Bearer ${channelAccessToken}`, "Content-Type": "application/json" };

  // LINE uses webhooks, but we can poll with long-polling or use a simple HTTP server
  // For simplicity, we register a webhook handler that the main express app can mount
  async function handleWebhook(events) {
    for (const event of events) {
      if (event.type !== "message" || event.message.type !== "text") continue;
      const text = event.message.text;
      const userId = event.source.userId || event.source.groupId || "unknown";
      const replyToken = event.replyToken;
      const chatId = event.source.groupId || event.source.roomId || userId;

      const channelKey = `line:${chatId}`;
      let convId = settingsStore.get(`channel_conv.${channelKey}`);
      if (!convId || !convStore.get(convId)) {
        const conv = convStore.create({ title: `LINE: ${chatId.slice(0, 20)}` });
        convId = conv.id;
        settingsStore.set(`channel_conv.${channelKey}`, convId);
      }

      convStore.addMessage(convId, { role: "user", content: text });
      const history = convStore.getRecentMessages(convId, 40);
      const systemPrompt = buildSystemPrompt({ settingsStore, db, conversationId: convId, messageCount: history.length, channelHint: "You are chatting on LINE." });
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
          // Reply via LINE API (5000 char limit)
          const chunks = fullResponse.match(/.{1,4800}/gs) || [fullResponse];
          const messages = chunks.map((c) => ({ type: "text", text: c })).slice(0, 5);
          await fetch(`${API_BASE}/message/reply`, {
            method: "POST", headers,
            body: JSON.stringify({ replyToken, messages }),
          });
        }
      } catch (err) { console.error("[line] error:", err.message); }
    }
  }

  console.log("[line] webhook handler ready. Mount POST /api/webhook/line on your express app.");
  return { stop: () => { running = false; }, handleWebhook };
}
