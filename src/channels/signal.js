/**
 * Signal channel via signal-cli REST API.
 */

import { buildSystemPrompt } from "../lib/build-system-prompt.js";
import { chatStream } from "../ai/router.js";
import { SettingsStore } from "../db/settings.js";
import { ConversationStore } from "../db/conversations.js";
import { getToolDefinitions, executeTool } from "../lib/tools.js";
import { extractAndSaveMemories } from "../lib/memory-extractor.js";

export async function createSignalBot(channelConfig, db) {
  const settingsStore = new SettingsStore(db);
  const convStore = new ConversationStore(db);
  const tools = getToolDefinitions();
  const apiUrl = channelConfig.apiUrl || "http://localhost:8080";
  const phoneNumber = channelConfig.phoneNumber;
  if (!phoneNumber) throw new Error("Signal requires a phone number");

  let running = true;
  let pollTimeout;

  async function poll() {
    if (!running) return;
    try {
      const res = await fetch(`${apiUrl}/v1/receive/${phoneNumber}`, { signal: AbortSignal.timeout(30000) });
      if (res.ok) {
        const messages = await res.json();
        for (const msg of messages) {
          if (!msg.envelope?.dataMessage?.message) continue;
          const text = msg.envelope.dataMessage.message;
          const sender = msg.envelope.source;
          const groupId = msg.envelope.dataMessage.groupInfo?.groupId;
          const chatId = groupId || sender;

          const channelKey = `signal:${chatId}`;
          let convId = settingsStore.get(`channel_conv.${channelKey}`);
          if (!convId || !convStore.get(convId)) {
            const conv = convStore.create({ title: `Signal: ${chatId}` });
            convId = conv.id;
            settingsStore.set(`channel_conv.${channelKey}`, convId);
          }

          convStore.addMessage(convId, { role: "user", content: text });
          const history = convStore.getRecentMessages(convId, 40);
          const systemPrompt = buildSystemPrompt({ settingsStore, db, conversationId: convId, messageCount: history.length, channelHint: "You are chatting on Signal." });
          const activeProvider = settingsStore.getActiveProvider();
          if (!activeProvider?.apiKey) continue;

          let fullResponse = "";
          let workingMessages = history.map((m) => ({ role: m.role, content: m.content }));
          const toolCtx = { db, settingsStore, conversationId: convId };

          try {
            for (let round = 0; round < 10; round++) {
              const toolCalls = [];
              let roundText = "", stopReason = "end_turn";
              const stream = chatStream({ provider: activeProvider.provider, model: activeProvider.model, apiKey: activeProvider.apiKey, messages: workingMessages, systemPrompt, tools });
              for await (const event of stream) {
                if (event.type === "text") { roundText += event.content; fullResponse += event.content; }
                else if (event.type === "tool_use") toolCalls.push({ id: event.id, name: event.name, input: event.input });
                else if (event.type === "done") { stopReason = event.stopReason || "end_turn"; break; }
              }
              if (toolCalls.length === 0 || stopReason !== "tool_use") break;
              const ac = [];
              if (roundText) ac.push({ type: "text", text: roundText });
              for (const tc of toolCalls) ac.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
              workingMessages.push({ role: "assistant", content: ac });
              const tr = [];
              for (const tc of toolCalls) { tr.push({ type: "tool_result", tool_use_id: tc.id, content: await executeTool(tc.name, tc.input, toolCtx) }); }
              workingMessages.push({ role: "user", content: tr });
            }
            fullResponse = extractAndSaveMemories(fullResponse, db, convId);
            if (fullResponse) {
              convStore.addMessage(convId, { role: "assistant", content: fullResponse });
              const endpoint = groupId ? `${apiUrl}/v2/send` : `${apiUrl}/v2/send`;
              await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ message: fullResponse, number: phoneNumber, recipients: groupId ? undefined : [sender] }),
              });
            }
          } catch (err) { console.error("[signal] error:", err.message); }
        }
      }
    } catch (err) {
      if (err.name !== "AbortError") console.warn("[signal] poll error:", err.message);
    }
    if (running) pollTimeout = setTimeout(poll, 2000);
  }

  poll();
  console.log("[signal] polling started");
  return { stop: () => { running = false; clearTimeout(pollTimeout); } };
}
