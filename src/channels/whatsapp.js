/**
 * WhatsApp channel via Baileys (WhiskeySockets/Baileys).
 * QR code auth, session persistence, group support, tool calling.
 */

import { buildSystemPrompt } from "../lib/build-system-prompt.js";
import { chatStream } from "../ai/router.js";
import { SettingsStore } from "../db/settings.js";
import { ConversationStore } from "../db/conversations.js";
import { getToolDefinitions, executeTool } from "../lib/tools.js";
import { extractAndSaveMemories } from "../lib/memory-extractor.js";

export async function createWhatsAppBot(channelConfig, db) {
  let makeWASocket, useMultiFileAuthState, DisconnectReason;
  try {
    const baileys = await import("@whiskeysockets/baileys");
    makeWASocket = baileys.default || baileys.makeWASocket;
    useMultiFileAuthState = baileys.useMultiFileAuthState;
    DisconnectReason = baileys.DisconnectReason;
  } catch {
    throw new Error("WhatsApp requires @whiskeysockets/baileys. Install: npm i @whiskeysockets/baileys");
  }

  const settingsStore = new SettingsStore(db);
  const convStore = new ConversationStore(db);
  const tools = getToolDefinitions();
  const allowedChats = channelConfig.allowedChats ? channelConfig.allowedChats.split(",").map((s) => s.trim()) : null;

  const authDir = channelConfig.authDir || "/tmp/tarsee-wa-auth";
  const { state, saveCreds } = await useMultiFileAuthState(authDir);

  const sock = makeWASocket({ auth: state, printQRInTerminal: true });
  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) console.log("[whatsapp] Scan QR code above to connect");
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code !== DisconnectReason?.loggedOut) {
        console.log("[whatsapp] Reconnecting...");
        setTimeout(() => createWhatsAppBot(channelConfig, db), 5000);
      } else {
        console.log("[whatsapp] Logged out.");
      }
    }
    if (connection === "open") console.log("[whatsapp] Connected!");
  });

  sock.ev.on("messages.upsert", async ({ messages: msgs }) => {
    for (const msg of msgs) {
      if (!msg.message || msg.key.fromMe) continue;
      const chatId = msg.key.remoteJid;
      if (allowedChats && !allowedChats.includes(chatId)) continue;

      const text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
      if (!text) continue;

      const channelKey = `whatsapp:${chatId}`;
      let convId = settingsStore.get(`channel_conv.${channelKey}`);
      if (!convId || !convStore.get(convId)) {
        const conv = convStore.create({ title: `WhatsApp: ${chatId.split("@")[0]}` });
        convId = conv.id;
        settingsStore.set(`channel_conv.${channelKey}`, convId);
      }

      convStore.addMessage(convId, { role: "user", content: text });
      const history = convStore.getRecentMessages(convId, 40);
      const systemPrompt = buildSystemPrompt({ settingsStore, db, conversationId: convId, messageCount: history.length, channelHint: "You are chatting on WhatsApp." });
      const activeProvider = settingsStore.getActiveProvider();
      if (!activeProvider?.ready) continue;

      let fullResponse = "";
      let workingMessages = history.map((m) => ({ role: m.role, content: m.content }));
      const toolCtx = { db, settingsStore, conversationId: convId };

      try {
        for (let round = 0; round < 10; round++) {
          const toolCalls = [];
          let roundText = "";
          let stopReason = "end_turn";
          const stream = chatStream({ provider: activeProvider.provider, model: activeProvider.model, apiKey: activeProvider.apiKey, messages: workingMessages, systemPrompt, tools });
          for await (const event of stream) {
            if (event.type === "text") { roundText += event.content; fullResponse += event.content; }
            else if (event.type === "tool_use") toolCalls.push({ id: event.id, name: event.name, input: event.input });
            else if (event.type === "done") { stopReason = event.stopReason || "end_turn"; break; }
          }
          if (toolCalls.length === 0 || stopReason !== "tool_use") break;
          const assistantContent = [];
          if (roundText) assistantContent.push({ type: "text", text: roundText });
          for (const tc of toolCalls) assistantContent.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.input });
          workingMessages.push({ role: "assistant", content: assistantContent });
          const toolResults = [];
          for (const tc of toolCalls) {
            const result = await executeTool(tc.name, tc.input, toolCtx);
            toolResults.push({ type: "tool_result", tool_use_id: tc.id, content: result });
          }
          workingMessages.push({ role: "user", content: toolResults });
        }

        fullResponse = extractAndSaveMemories(fullResponse, db, convId);
        if (fullResponse) {
          convStore.addMessage(convId, { role: "assistant", content: fullResponse });
          // Split at 4096 chars
          const chunks = fullResponse.match(/.{1,4000}/gs) || [fullResponse];
          for (const chunk of chunks) {
            await sock.sendMessage(chatId, { text: chunk });
          }
        }
      } catch (err) {
        console.error("[whatsapp] error:", err.message);
        await sock.sendMessage(chatId, { text: "Sorry, I encountered an error processing your message." });
      }
    }
  });

  return { stop: () => sock.end(undefined) };
}
