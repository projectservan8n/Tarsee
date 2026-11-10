/**
 * Voice calls (lib/voice-call.js, public/js/call.js). Mounted at /api/call behind the session and CSRF checks.
 *
 *   POST /api/call/start     a call begins: its chat (made the first time), the name to say, the deep ask, where a
 *                            hang-up's answer would go; an answer still waiting from the last call is heard now
 *   POST /api/call/handoff   hung up while the AI was working: its answer goes to the chosen channel, if any
 *   GET  /api/call/settings  Settings > Voice > Calls: the channel chosen and the ones that could be
 *   PUT  /api/call/settings  { channel } a channel id, or null / "" for Off
 */
import { Router } from "express";
import { ConversationStore } from "../db/conversations.js";
import { getTTSEngine } from "../voice/engine-registry.js";
import {
  botNameOf, callConversation, cancelHandoff, deepAsk, handoffChoices, handoffTarget, sendThroughChannel, startHandoff,
  HANDOFF_CHANNELS, HANDOFF_SETTING,
} from "../lib/voice-call.js";

export const callRouter = Router();

/** How long the start waits for the deep ask's answer (it may read an AI's model list). */
const DEEP_ASK_WAIT_MS = 3000;

function stores(req) {
  const db = req.app.get("db");
  return {
    db,
    settingsStore: req.app.get("settingsStore"),
    channelManager: req.app.get("channelManager") || null,
    convStore: new ConversationStore(db),
  };
}

callRouter.post("/start", async (req, res) => {
  const { settingsStore, channelManager, convStore } = stores(req);
  const conv = callConversation({ settingsStore, convStore });
  cancelHandoff(conv.id);
  // Start a local voice's worker (Phonon) now, so the first words don't also wait for its model to load.
  try {
    const engine = getTTSEngine();
    if (typeof engine?.warm === "function") Promise.resolve(engine.warm()).catch(() => {});
  } catch { /* the call speaks without it */ }
  const deep = await Promise.race([
    deepAsk({ settingsStore, conversationId: conv.id }),
    new Promise((r) => { const t = setTimeout(() => r(null), DEEP_ASK_WAIT_MS); t.unref?.(); }),
  ]);
  res.json({
    conversationId: conv.id,
    title: conv.title,
    created: conv.created,
    botName: botNameOf(settingsStore),
    deep,
    handoff: handoffTarget({ settingsStore, channelManager }),
  });
});

callRouter.post("/handoff", (req, res) => {
  const { db, settingsStore, channelManager, convStore } = stores(req);
  const conversationId = typeof req.body?.conversationId === "string" ? req.body.conversationId : "";
  if (!conversationId || !convStore.get(conversationId)) return res.status(404).json({ error: "There is no call chat with that id." });
  const target = handoffTarget({ settingsStore, channelManager });
  if (!target) {
    const chosen = settingsStore.get(HANDOFF_SETTING);
    const reason = chosen && HANDOFF_CHANNELS[chosen] ? `${HANDOFF_CHANNELS[chosen]} isn't connected` : "off";
    return res.json({ ok: false, channel: null, label: null, reason });
  }
  startHandoff({ conversationId, channel: target.channel, send: sendThroughChannel({ db, settingsStore, channelManager }) });
  res.json({ ok: true, ...target });
});

callRouter.get("/settings", (req, res) => {
  const { settingsStore, channelManager } = stores(req);
  res.json(handoffChoices({ settingsStore, channelManager }));
});

callRouter.put("/settings", (req, res) => {
  const { settingsStore, channelManager } = stores(req);
  const raw = req.body?.channel;
  const channel = raw == null || raw === "" || raw === "off" ? null : String(raw);
  if (channel && !Object.hasOwn(HANDOFF_CHANNELS, channel)) {
    return res.status(400).json({ error: `An answer can go to ${Object.values(HANDOFF_CHANNELS).join(", ")}, or nowhere (Off).` });
  }
  if (channel) settingsStore.set(HANDOFF_SETTING, channel, { actor: "user", ip: req.ip });
  else settingsStore.delete(HANDOFF_SETTING, { actor: "user", ip: req.ip });
  res.json({ ok: true, ...handoffChoices({ settingsStore, channelManager }) });
});
