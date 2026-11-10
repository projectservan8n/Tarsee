import { CLAUDE_MODELS, MODEL_TIERS } from "../config/constants.js";
import { PROVIDERS, PROVIDER_IDS, getProvider, normalizeProviderId, isShipped as registryShipped, resolveModelFor } from "../ai/provider-registry.js";
import { parseModelRef } from "../ai/model-ref.js";
import { providerReadiness, defaultPick, readPick, levelsFor, describeModel, repliesWhole, modelChoices, checkModel, refreshChatgptModels } from "./model-catalog.js";
import { EFFORT_NAMES, clampEffort, matchModels, MESSAGE_AT_A_TIME, TARSEE_DEFAULT_EFFORT } from "./model-picker.js";
import { addCronJob, removeCronJob, loadCronJobs, runCronJob, startCronScheduler } from "./cron.js";
import { executeTool } from "./tools.js";
import { getSkillContent, installSkill, scanSkills } from "./skills-engine.js";
import { hasCheckpoint, peekCheckpoint, listRecentCheckpoints, CHECKPOINT_FILE_PATH } from "./checkpoint.js";
import { preview as previewRetention, runNow as runRetentionNow } from "./retention.js";
import { forgetConversation } from "./live-bus.js";
import { forgetChatFiles } from "./chat-files.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import config from "../config/env.js";
import { SettingsStore } from "../db/settings.js";

/**
 * Chat command processor.
 * Commands start with "/" and are handled before being sent to the AI.
 *
 * Returns { handled: true, response: "..." } if it was a command,
 * or { handled: false } if it's a normal message.
 *
 * ctx.ai (optional) carries what the AI commands read readiness and switches from: { isShipped, statusFor, env,
 * stateDir, listChatgptModels }. Without it they use the provider registry's own (lib/model-catalog.js
 * providerReadiness, and ai/codex-models.js for the ChatGPT account's models).
 */

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** The words /think and /effort take for each level. */
const EFFORT_WORDS = {
  low: "low", medium: "medium", med: "medium",
  high: "high", max: "max", xhigh: "xhigh", extra: "xhigh", ultra: "xhigh",
};
const EFFORT_HELP = {
  low: "Minimal thinking, fastest",
  medium: "Balanced (the default)",
  high: "Deep reasoning",
  xhigh: "Extra-high; the sweet spot for most coding and agentic work",
  max: "Maximum effort, when correctness matters more than cost",
};
const TIER_WORDS = new Set([...MODEL_TIERS, "top", "mid", "small"]);

/** The readiness and switches the AI commands go by (tests pass their own in ctx.ai). */
function aiDeps(ctx) {
  const ai = ctx.ai || {};
  return { isShipped: ai.isShipped || registryShipped, statusFor: ai.statusFor || null, env: ai.env || process.env, stateDir: ai.stateDir, listChatgptModels: ai.listChatgptModels || null };
}

/**
 * The ChatGPT account's models, read now if nothing has read them since the server started (they live only in
 * memory), so /model answers from the account's own list. Quick when they're already in (model-catalog.js keeps them).
 */
function chatgptModels(ctx) {
  const d = aiDeps(ctx);
  return refreshChatgptModels({ list: d.listChatgptModels, env: d.env, stateDir: d.stateDir, store: ctx.settingsStore });
}

function readiness(id, ctx) {
  const d = aiDeps(ctx);
  return providerReadiness(id, { store: ctx.settingsStore, env: d.env, statusFor: d.statusFor, isShipped: d.isShipped, stateDir: d.stateDir });
}

const isTierWord = (s) => TIER_WORDS.has(String(s || "").toLowerCase().trim().replace(/\[1m\]$/, ""));
const effortName = (id) => EFFORT_NAMES[id] || (id ? id.charAt(0).toUpperCase() + id.slice(1) : "");

/** "DeepSeek · DeepSeek Flash" */
function aiLabel(providerId, model, store) {
  return `${PROVIDERS[providerId].label} · ${describeModel(providerId, model, store)}`;
}

/**
 * The AI and model a chat's turns run on: its own pick when its AI is ready, else the default. { provider, model,
 * own, warning? }: `own` when the chat's pick is used, `warning` when it has one whose AI isn't ready.
 */
async function chatTarget(ctx) {
  const store = ctx.settingsStore;
  const d = aiDeps(ctx);
  const def = defaultPick(store, { env: d.env, isShipped: d.isShipped });
  const pick = readPick(store, ctx.conversationId);
  if (pick.provider) {
    const s = await readiness(pick.provider, ctx);
    if (s.ready) return { provider: pick.provider, model: pick.model, own: true };
    return { provider: def.provider, model: def.model, own: false, warning: `${s.label} isn't ready, so this chat uses the default AI. ${s.fix || ""}`.trim() };
  }
  // A model of the chat's own without an AI (the Claude-only picker saved that) is the Claude plan's, as the turn
  // layer reads it: it counts while the Claude plan is the default.
  if (pick.model && def.provider === "claude" && checkModel("claude", pick.model, store).ok) return { provider: "claude", model: pick.model, own: true };
  return { provider: def.provider, model: def.model, own: false };
}

/** Engine versions, from the installed packages: { claudeCode, agentSdk, codex } (null where one isn't installed). */
function engineVersions() {
  const read = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(APP_ROOT, "node_modules", rel, "package.json"), "utf8")); } catch { return null; } };
  const sdk = read("@anthropic-ai/claude-agent-sdk");
  const codex = read("@openai/codex") || read("@openai/codex-sdk");
  return { claudeCode: sdk?.claudeCodeVersion || null, agentSdk: sdk?.version || null, codex: codex?.version || null };
}

function enginesLine() {
  const v = engineVersions();
  const cc = v.claudeCode ? `Claude Code ${v.claudeCode}${v.agentSdk ? ` (Agent SDK ${v.agentSdk})` : ""}` : "Claude Code not installed";
  const cx = v.codex ? `Codex ${v.codex}` : "Codex not installed";
  return `${cc} · ${cx}`;
}

/** Save the default AI and model. `model` undefined keeps the AI's saved model, null clears it (the AI's own default). */
function saveDefault(store, providerId, model) {
  const p = PROVIDERS[providerId];
  store.set("ai.activeProvider", p.storageId);
  if (model === null) store.delete(`ai.${p.storageId}.model`);
  else if (model !== undefined) store.set(`ai.${p.storageId}.model`, model);
}

/** /model run in a chat with a model of its own: that chat follows the new default too. */
function releaseChat(ctx) {
  if (!ctx.conversationId) return false;
  const store = ctx.settingsStore;
  const pick = readPick(store, ctx.conversationId);
  if (!pick.provider && !pick.model) return false;
  store.delete(`session.${ctx.conversationId}.provider`);
  store.delete(`session.${ctx.conversationId}.model`);
  return true;
}

function switched(ctx, providerId, { released }) {
  const store = ctx.settingsStore;
  const def = defaultPick(store, aiDeps(ctx));
  const lines = [`Default AI: **${PROVIDERS[providerId].label}** · **${describeModel(providerId, def.model, store)}**`];
  if (repliesWhole(providerId, def.model, store)) lines.push(`${MESSAGE_AT_A_TIME} on this AI.`);
  if (released) lines.push("This chat had a model of its own; it now follows the default.");
  return lines.join("\n");
}

/** Pick within one AI: a tier word, an exact id, or a few letters of a model. */
function resolveWithin(providerId, query, store, preferProvider) {
  const p = PROVIDERS[providerId];
  if (isTierWord(query)) return { model: resolveModelFor(p.id, query, store) || null };
  const exact = checkModel(p.id, query, store);
  if (exact.ok && exact.model) return { model: exact.model };
  const choices = modelChoices(p.id, store);
  const pickable = choices.filter((c) => c.selectable);
  const { matches } = matchModels(pickable, query, { preferProvider });
  if (matches.length === 1) return { model: matches[0].id };
  if (matches.length > 1) return { reply: choicesReply(query, matches) };
  const locked = matchModels(choices.filter((c) => !c.selectable), query).matches;
  if (locked.length) return { reply: `${locked[0].name} on ${p.label} hasn't been verified yet. Verify it in Settings > AI first.` };
  if (exact.verify) return { reply: exact.error };
  const known = pickable.slice(0, 6).map((c) => `\`${c.id}\``).join(", ");
  // OpenRouter and Local AI offer any model their server lists, once it has passed Verify.
  const verifyHint = p.id === "openrouter" || p.id === "local" ? " To use another of its models, verify it in Settings > AI first." : "";
  return { reply: `${p.label} has no ${verifyHint ? "verified " : ""}model matching "${query}".${known ? ` Try: ${known}.` : ""}${verifyHint}` };
}

function choicesReply(query, matches) {
  const lines = [`"${query}" fits more than one model. Pick one:`];
  for (const m of matches.slice(0, 12)) lines.push(`- \`/model ${m.ref || `${m.provider}:${m.id}`}\` — ${m.name} (${PROVIDERS[m.provider].label})`);
  if (matches.length > 12) lines.push(`…and ${matches.length - 12} more. Type more of the name.`);
  return lines.join("\n");
}

async function modelCommand(args, ctx) {
  const store = ctx.settingsStore;
  if (!store) return "Settings not available.";
  const d = aiDeps(ctx);
  if (!args) return modelOverview(ctx);
  const q = args.trim();

  // "deepseek:deepseek-flash", or "deepseek pro" / "chatgpt" (an AI, then maybe a model).
  let { provider, model } = parseModelRef(q);
  if (!provider) {
    const [first, ...rest] = q.split(/\s+/);
    const id = normalizeProviderId(first);
    if (id) { provider = id; model = rest.join(" ").trim() || null; }
  }
  if (provider) {
    const p = getProvider(provider);
    if (!d.isShipped(p.id)) return `${p.label} can't be used in this version of Tarsee.`;
    const s = await readiness(p.id, ctx);
    if (!s.ready) return `**${p.label}** isn't ready.${s.detail ? ` ${s.detail}` : ""}${s.fix ? `\n\n${s.fix}` : ""}`;
    if (p.id === "chatgpt") await chatgptModels(ctx);
    let chosen;
    if (model) {
      const r = resolveWithin(p.id, model, store, p.id);
      if (r.reply) return r.reply;
      chosen = r.model;
    }
    saveDefault(store, p.id, chosen);
    return switched(ctx, p.id, { released: releaseChat(ctx) });
  }

  const def = defaultPick(store, d);
  // A tier word ("haiku") stays on the default AI: its own model for that tier.
  if (isTierWord(q)) {
    saveDefault(store, def.provider, resolveModelFor(def.provider, q, store) || null);
    return switched(ctx, def.provider, { released: releaseChat(ctx) });
  }

  // A few letters of a model, on whichever ready AI has it.
  const ready = [];
  const notReady = [];
  for (const id of PROVIDER_IDS.filter((x) => d.isShipped(x))) (await readiness(id, ctx)).ready ? ready.push(id) : notReady.push(id);
  if (ready.includes("chatgpt")) await chatgptModels(ctx);
  const choices = ready.flatMap((id) => modelChoices(id, store));
  const { matches } = matchModels(choices.filter((c) => c.selectable), q, { preferProvider: def.provider });
  if (matches.length === 1) {
    saveDefault(store, matches[0].provider, matches[0].id);
    return switched(ctx, matches[0].provider, { released: releaseChat(ctx) });
  }
  if (matches.length > 1) return choicesReply(q, matches);
  const locked = matchModels(choices.filter((c) => !c.selectable), q).matches;
  if (locked.length) return `${locked[0].name} on ${PROVIDERS[locked[0].provider].label} hasn't been verified yet. Verify it in Settings > AI first.`;
  // Only an AI that isn't ready has it: say which, and what to do.
  const elsewhere = matchModels(notReady.flatMap((id) => modelChoices(id, store)), q).matches;
  if (elsewhere.length) {
    const m = elsewhere[0];
    const s = await readiness(m.provider, ctx);
    return `${m.name} is on **${s.label}**, which isn't ready.${s.detail ? ` ${s.detail}` : ""}${s.fix ? `\n\n${s.fix}` : ""}`;
  }
  return `No model matches "${q}". Type \`/model\` to see the AIs and models you can use.`;
}

async function modelOverview(ctx) {
  const store = ctx.settingsStore;
  const d = aiDeps(ctx);
  const def = defaultPick(store, d);
  const lines = [`**Default AI:** ${aiLabel(def.provider, def.model, store)}`];
  const target = await chatTarget(ctx);
  if (target.own) lines.push(`**This chat:** ${aiLabel(target.provider, target.model, store)} (picked for this chat)`);
  else if (target.warning) lines.push(`**This chat:** ${target.warning}`);

  const ready = [];
  const notReady = [];
  for (const id of PROVIDER_IDS.filter((x) => d.isShipped(x))) {
    const s = await readiness(id, ctx);
    (s.ready ? ready : notReady).push(s);
  }
  if (ready.some((s) => s.provider === "chatgpt")) await chatgptModels(ctx);
  lines.push("", "**Ready to use:**");
  for (const s of ready) {
    const choices = modelChoices(s.provider, store).filter((c) => c.selectable);
    const shown = s.provider === "claude" || s.provider === "anthropic"
      ? CLAUDE_MODELS.filter((m) => m.alias).map((m) => `\`${m.id}\``)
      : choices.slice(0, 6).map((c) => c.name);
    const more = s.provider === "claude" || s.provider === "anthropic" ? 0 : Math.max(0, choices.length - 6);
    const example = exampleFor(s.provider, choices, def.provider);
    lines.push(`- **${s.label}** (\`/model ${s.provider}\`): ${shown.join(", ") || describeModel(s.provider, null, store)}${more ? `, and ${more} more` : ""}${example ? ` — e.g. \`${example}\`` : ""}`);
  }
  if (notReady.length) {
    lines.push("", "**Not ready yet:**");
    for (const s of notReady) lines.push(`- **${s.label}**: ${[s.detail, s.fix].filter(Boolean).join(" ")}`);
  }
  if (ready.some((s) => s.provider === "claude" || s.provider === "anthropic")) {
    const pinned = CLAUDE_MODELS.filter((m) => !m.alias).map((m) => `\`${m.id}\``).join(", ");
    lines.push("", `Claude's pinned versions: ${pinned}.`);
  }
  lines.push("", "Switch with a provider, a model, or both: `/model <provider> [model]`, `/model <model>`, or `/model haiku` for the default AI's smallest model.");
  return lines.join("\n");
}

/** An example /model line for an AI: its second model's last word ("deepseek pro"), else just the AI. */
function exampleFor(providerId, choices, defaultProvider) {
  const second = choices.find((c, i) => i > 0 && c.id);
  if (providerId === "claude" || providerId === "anthropic") return `/model ${providerId === defaultProvider ? "opus" : `${providerId} opus`}`;
  if (!second) return `/model ${providerId}`;
  const word = String(second.name).split(/[\s:]+/).filter(Boolean).pop()?.toLowerCase();
  return word ? `/model ${providerId} ${word}` : `/model ${providerId}`;
}

async function thinkCommand(args, ctx) {
  const store = ctx.settingsStore;
  if (!store) return "Settings not available.";
  const target = await chatTarget(ctx);
  const levels = levelsFor(target.provider, target.model, store);
  const modelName = describeModel(target.provider, target.model, store);
  const defaultEffort = store.get("ai.defaultEffort") || TARSEE_DEFAULT_EFFORT;
  const own = ctx.conversationId ? store.get(`session.${ctx.conversationId}.effort`) : null;

  if (!args) {
    if (!levels.length) return `**${modelName}** has no effort levels: it always thinks the same amount.`;
    const shown = own ? clampEffort(levels, own) : `${clampEffort(levels, defaultEffort)} (the default)`;
    const rows = levels.map((id) => `- \`/think ${id}\` — ${effortName(id)}${EFFORT_HELP[id] ? `: ${EFFORT_HELP[id]}` : ""}`).join("\n");
    return `**Current effort:** ${shown}\n**Model:** ${modelName} (${levels.length} levels)\n\n**Options** (ascending cost):\n${rows}\n\nThe model and effort button beside Send sets the same thing.`;
  }

  const asked = EFFORT_WORDS[args.toLowerCase().trim()];
  if (!asked) return `Unknown level. Use: ${(levels.length ? levels : Object.keys(EFFORT_HELP)).join(", ")}.`;
  if (!levels.length) return `**${modelName}** has no effort levels, so there is nothing to set.`;
  const level = clampEffort(levels, asked);
  const note = level !== asked ? `${modelName} has no ${effortName(asked)}, so it is set to **${effortName(level)}**. Levels: ${levels.map(effortName).join(", ")}.` : null;
  if (ctx.conversationId) {
    store.set(`session.${ctx.conversationId}.effort`, level);
    return note || `Thinking effort set to **${level}**`;
  }
  store.set("ai.defaultEffort", level);
  return note ? `${note} It is the default for chats without a level of their own.` : `Default thinking effort set to **${level}**`;
}

async function autoCommand(args, ctx) {
  const store = ctx.settingsStore;
  if (!store) return "Settings not available.";
  const current = store.get("ai.autoRoute") === true;
  const a = (args || "").toLowerCase().trim();
  let on;
  if (!a) on = !current;
  else if (a === "on") on = true;
  else if (a === "off") on = false;
  else return "Usage: `/auto` (toggle), `/auto on`, `/auto off`";
  store.set("ai.autoRoute", on);
  if (!on) return "Auto-routing **disabled** — using default model.";
  const def = defaultPick(store, aiDeps(ctx));
  const name = (tier) => describeModel(def.provider, resolveModelFor(def.provider, tier, store), store);
  return `Auto-routing **enabled** on ${PROVIDERS[def.provider].label} — ${name("haiku")} for simple, ${name("sonnet")} for general, ${name("opus")} for complex.`;
}

const COMMANDS = {
  help: {
    description: "Show available commands",
    usage: "/help",
    handler: () => {
      const lines = ["**Tarsee Commands**", ""];
      for (const [name, cmd] of Object.entries(COMMANDS)) {
        lines.push(`\`${cmd.usage}\` — ${cmd.description}`);
      }
      lines.push("", "Type anything else to chat with the AI.");
      return lines.join("\n");
    },
  },

  clear: {
    description: "Start a new conversation (saves a summary first)",
    usage: "/clear",
    handler: async (_args, ctx) => {
      let summaryNote = "";
      let clearedCount = 0;
      // Summarize the conversation before clearing so we don't lose the
      // gist. Lives in memory/summaries.md — searchable by Claude later.
      if (ctx.db && ctx.conversationId) {
        try {
          const { summarizeConversation } = await import("./auto-summarize.js");
          const result = summarizeConversation(ctx.db, ctx.conversationId);
          if (result?.ok) {
            summaryNote = `\n\nSaved a summary of the previous ${result.msgCount} messages to \`memory/summaries.md\`.`;
          }
        } catch (err) {
          console.warn("[commands] /clear summarize failed:", err?.message);
        }

        // Actually clear the conversation. Previously this relied entirely on
        // ctx.clearConversation being supplied by the calling channel — which
        // NO channel wired up, so /clear silently no-op'd everywhere and
        // sessions accumulated thousands of transcript entries.
        //
        // We DELETE messages but keep the conversations row (the channel
        // mapping stays valid), and NULL the session handle so the next turn
        // starts a fresh session on whichever AI runs it — without that, the
        // engine would resume the same session and reload the prior
        // (now-deleted) transcript. session.<conv>.clearedAt records when, so
        // a fresh session's handoff (ai/turn.js) never brings them back.
        try {
          const r1 = ctx.db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(ctx.conversationId);
          clearedCount = r1?.changes || 0;
          // The live timeline keeps each message's text too: it goes as well.
          forgetConversation(ctx.conversationId);
          // The chat's files go with its messages (lib/chat-files.js), so the fresh chat does not open on old ones.
          forgetChatFiles(ctx.conversationId);
          ctx.db.prepare("UPDATE conversations SET claude_session_id = NULL, updated_at = datetime('now') WHERE id = ?").run(ctx.conversationId);
          (ctx.settingsStore || new SettingsStore(ctx.db)).set(`session.${ctx.conversationId}.clearedAt`, new Date().toISOString());
        } catch (err) {
          console.warn("[commands] /clear DB cleanup failed:", err?.message);
        }
      }
      // Belt-and-suspenders: if a channel still wires up a custom
      // clearConversation (e.g. web chat doing extra in-memory cleanup),
      // call it too. Safe because our DB cleanup is idempotent.
      if (ctx.clearConversation) {
        ctx.clearConversation();
      }
      const countNote = clearedCount > 0 ? ` (${clearedCount} messages deleted, session reset)` : "";
      return "Conversation cleared. Starting fresh." + countNote + summaryNote;
    },
  },

  model: {
    description: "Show or switch the AI and model (deepseek pro, chatgpt, flash, haiku, or any model id)",
    usage: "/model [provider] [model]",
    handler: (args, ctx) => modelCommand(args, ctx),
  },

  think: {
    description: "Set thinking effort (the levels the model has: low, medium, high, xhigh, max)",
    usage: "/think [low|medium|high|xhigh|max]",
    handler: (args, ctx) => thinkCommand(args, ctx),
  },

  // Alias of /think that also opens the composer's picker on the client.
  // Server-side behavior is identical; the web frontend intercepts the
  // command response and opens the picker's Effort list if no argument was given.
  // Anywhere else (Telegram, Slack, …) there is no picker, so it lists the levels.
  effort: {
    description: "Set thinking effort (opens the picker's Effort list with no level)",
    usage: "/effort [low|medium|high|xhigh|max]",
    handler: (args, ctx) => {
      if (!args && (!ctx.platform || ctx.platform === "web")) {
        // Signal the client to open the slider. The frontend looks for
        // this sentinel in the command response and shows the slider
        // instead of printing this line.
        return "__OPEN_EFFORT_SLIDER__";
      }
      return COMMANDS.think.handler(args, ctx);
    },
  },

  theme: {
    description: "Switch the UI theme (warm-charcoal, noir, solarized-light, jarvis-blue)",
    usage: "/theme [name]",
    handler: (args, ctx) => {
      const settingsStore = ctx.settingsStore;
      if (!settingsStore) return "Settings not available.";

      // Built-in themes. Plugin-shipped themes also land here via
      // plugin-loader — settings key "ui.themes.available" stores the
      // unified list.
      const builtIn = ["warm-charcoal", "noir", "solarized-light", "jarvis-blue"];
      const pluginThemes = settingsStore.get("ui.themes.plugin") || [];
      const all = [...builtIn, ...pluginThemes];

      if (!args || args.toLowerCase() === "list") {
        const current = settingsStore.get("ui.theme") || "warm-charcoal";
        const lines = all.map((t) => (t === current ? `- **${t}** (current)` : `- ${t}`));
        return `**Available themes:**\n${lines.join("\n")}\n\nSwitch with \`/theme <name>\`.`;
      }

      const name = args.toLowerCase().trim();
      if (!all.includes(name)) {
        return `Unknown theme \`${name}\`. Available: ${all.join(", ")}.`;
      }

      settingsStore.set("ui.theme", name);
      // Client picks up the theme change via the __SET_THEME__ sentinel
      // so the switch is instant without a page reload.
      return `__SET_THEME__:${name}|Theme set to **${name}**.`;
    },
  },

  send: {
    description: "Forward conversation context to another channel",
    usage: "/send [telegram|discord|whatsapp|slack|web]",
    handler: async (args, ctx) => {
      if (!args) return "Usage: `/send telegram`, `/send discord`, `/send whatsapp`, `/send slack`, `/send web`";
      const target = args.toLowerCase().trim();
      const validChannels = ["telegram", "discord", "whatsapp", "slack", "web"];
      if (!validChannels.includes(target)) return `Unknown channel. Use: ${validChannels.join(", ")}`;

      if (!ctx.conversationId || !ctx.convStore) return "No active conversation.";

      const messages = ctx.convStore.getRecentMessages(ctx.conversationId, 10);
      if (!messages.length) return "No messages to forward.";

      const lines = messages.map((m) => {
        const role = m.role === "user" ? "You" : "Tarsee";
        const text = m.content.length > 300 ? m.content.slice(0, 300) + "..." : m.content;
        return `**${role}:** ${text}`;
      });

      const summary = `📨 **Conversation handoff**\n\n${lines.join("\n\n")}`;

      try {
        const { executeTool } = await import("./tools.js");
        await executeTool("send_message", { channel: target, message: summary }, ctx);
        return `Sent to **${target}**.`;
      } catch (err) {
        return `Failed to send: ${err.message}`;
      }
    },
  },

  auto: {
    description: "Toggle auto model routing (the default AI's small model for simple, mid for general, top for complex)",
    usage: "/auto [on|off]",
    handler: (args, ctx) => autoCommand(args, ctx),
  },

  mention: {
    description: "Show or set whether the bot requires @mention to respond (Discord/Telegram/Slack)",
    usage: "/mention [required|off|status] [discord|telegram|slack]",
    handler: (args, ctx) => {
      const settingsStore = ctx.settingsStore;
      if (!settingsStore) return "Settings not available.";

      const PLATFORMS = ["discord", "telegram", "slack"];
      const valueAlias = {
        required: "required", on: "required", always: "required", strict: "required",
        off: "off", lazy: "off", any: "off", none: "off",
      };

      const readMode = (p) => settingsStore.get(`${p}.mention_mode`) === "off" ? "off" : "required";
      const labelFor = (mode) => mode === "off"
        ? "**OFF** — responds to any allowed message (lazy)"
        : "**REQUIRED** — must @mention or reply to the bot";

      const tokens = (args || "").trim().split(/\s+/).filter(Boolean);

      // No args, or "status" — print current state for both platforms.
      if (tokens.length === 0 || tokens[0].toLowerCase() === "status") {
        const lines = ["**Mention mode**", ""];
        for (const p of PLATFORMS) lines.push(`- ${p}: ${labelFor(readMode(p))}`);
        lines.push("", "Set with `/mention required` or `/mention off`. Add `discord`, `telegram` or `slack` to target a specific platform.");
        return lines.join("\n");
      }

      const t0 = tokens[0].toLowerCase();
      const t1 = tokens[1]?.toLowerCase();

      let value, platform;
      if (valueAlias[t0]) {
        value = valueAlias[t0];
        if (t1 && PLATFORMS.includes(t1)) {
          platform = t1;
        } else if (ctx.platform && PLATFORMS.includes(ctx.platform)) {
          platform = ctx.platform;
        } else {
          return `Pick a platform: \`/mention ${t0} discord\`, \`/mention ${t0} telegram\` or \`/mention ${t0} slack\`.`;
        }
      } else if (PLATFORMS.includes(t0)) {
        // Reversed order: /mention discord off
        platform = t0;
        const v = t1 ? valueAlias[t1] : null;
        if (!v) return "Usage: `/mention required|off [discord|telegram|slack]`";
        value = v;
      } else {
        return "Unknown value. Use `required` (must @mention) or `off` (any allowed message). Example: `/mention off telegram`.";
      }

      settingsStore.set(`${platform}.mention_mode`, value);
      return `Mention mode for **${platform}** set to ${labelFor(value)}.`;
    },
  },

  webhook: {
    description: "Manage webhook triggers (external events → AI)",
    usage: "/webhook [add <id> <prompt>|remove <id>|list]",
    // It prints the API token, which reaches every route (switching on scheduled tasks included).
    ownerOnly: true,
    handler: async (args, ctx) => {
      const settingsStore = ctx.settingsStore;
      if (!settingsStore) return "Settings not available.";
      const hooks = settingsStore.get("webhooks") || {};
      // Prefer the settings override (if operator set one) else fall back
      // to the canonical API_TOKEN so the printed curl actually works.
      const resolveToken = async () => {
        const override = settingsStore.get("api.token");
        if (override) return override;
        try {
          const { default: config } = await import("../config/env.js");
          return config.API_TOKEN || "(not set)";
        } catch { return "(not set)"; }
      };

      if (!args || args.toLowerCase() === "list") {
        const entries = Object.entries(hooks);
        if (entries.length === 0) return "No webhooks configured.\n\nAdd one: `/webhook add github-pr Review this PR: {{payload}}`";
        const lines = entries.map(([id, h]) => `- **${id}** → ${h.prompt?.slice(0, 60) || "(default)"}...`);
        const token = await resolveToken();
        return `**Webhooks (${entries.length}):**\n${lines.join("\n")}\n\n**Trigger:**\n\`\`\`\ncurl -X POST /api/webhooks/<id> \\\n  -H "Authorization: Bearer ${token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"key":"value"}'\n\`\`\``;
      }
      const parts = args.split(/\s+/);
      const cmd = parts[0].toLowerCase();
      if (cmd === "add" && parts[1]) {
        const id = parts[1];
        const prompt = parts.slice(2).join(" ") || null;
        hooks[id] = { prompt, channel: "web:default", created: new Date().toISOString() };
        settingsStore.set("webhooks", hooks);
        const token = await resolveToken();
        return `Webhook **${id}** created.\n\n**Trigger:**\n\`\`\`\ncurl -X POST /api/webhooks/${id} \\\n  -H "Authorization: Bearer ${token}" \\\n  -H "Content-Type: application/json" \\\n  -d '{"key":"value"}'\n\`\`\`\n\nSend any JSON body; reference it in prompts as \`{{payload}}\` or \`{{json}}\`.`;
      }
      if (cmd === "remove" && parts[1]) {
        if (!hooks[parts[1]]) return `Webhook "${parts[1]}" not found.`;
        delete hooks[parts[1]];
        settingsStore.set("webhooks", hooks);
        return `Webhook **${parts[1]}** removed.`;
      }
      return "Usage: `/webhook list`, `/webhook add <id> <prompt>`, `/webhook remove <id>`";
    },
  },

  // /stats → alias for /status
  stats: { description: "Alias for /status", usage: "/stats", handler: (args, ctx) => COMMANDS.status.handler(args, ctx) },


  email: {
    description: "Check or manage email — Gmail (gog) + Zoho (himalaya)",
    usage: "/email [check|summary|draft <details>|gmail|zoho]",
    handler: (args) => {
      if (!args) return "**Email:**\n- `/email check` — Check both Gmail + Zoho\n- `/email gmail` — Gmail only\n- `/email zoho` — Zoho only\n- `/email summary` — Summarize today's inbox (both)\n- `/email draft <to> <subject>` — Draft an email";
      const cmd = args.toLowerCase().split(/\s+/)[0];

      if (cmd === "check" || cmd === "all") return `__PLAYBOOK__\nCheck ALL email inboxes for unread messages.

**Step 1 — Gmail (gog):**
\`\`\`
gog gmail search "is:unread" --plain 2>&1 | head -50
\`\`\`

**Step 2 — Zoho (himalaya):**
\`\`\`
himalaya envelope list --folder INBOX -s unread 2>&1 | head -50
\`\`\`

Combine results from both. For each email: sender, subject, 1-line preview. Group by account (Gmail / Zoho). If either tool fails, note the error and show results from the other.`;

      if (cmd === "gmail") return `__PLAYBOOK__\nCheck Gmail inbox for unread messages.

\`\`\`
gog gmail search "is:unread" --plain 2>&1 | head -50
\`\`\`

Summarize: sender, subject, 1-line preview.`;

      if (cmd === "zoho") return `__PLAYBOOK__\nCheck Zoho inbox for unread messages using himalaya.

\`\`\`
himalaya envelope list --folder INBOX -s unread 2>&1 | head -50
\`\`\`

Summarize: sender, subject, 1-line preview.`;

      if (cmd === "summary") return `__PLAYBOOK__\nSummarize today's email from ALL accounts.

**Gmail:**
\`\`\`
gog gmail search "newer_than:1d" --plain 2>&1 | head -80
\`\`\`

**Zoho:**
\`\`\`
himalaya envelope list --folder INBOX 2>&1 | head -80
\`\`\`

Combine both. Group by priority: urgent/action-needed first, FYI/newsletters last. 1-2 lines each.`;

      if (cmd === "draft") return `__PLAYBOOK__\nDraft an email. Details: ${args.slice(6).trim()}

Write a professional email draft and show it for approval. Read USER.md for my writing style.

To send after approval:
- **Gmail:** \`gog gmail messages send --to <email> --subject "<subject>" --body "<body>"\`
- **Zoho:** \`himalaya message send --from <zoho-email> --to <email> --subject "<subject>" --body "<body>"\`

Do NOT send without my explicit approval. Ask which account to send from.`;

      return "Use: `/email check`, `/email gmail`, `/email zoho`, `/email summary`, `/email draft <details>`";
    },
  },

  briefing: {
    description: "Morning briefing — trigger now, or schedule daily",
    usage: "/briefing [on|off|time <0-23>]",
    ownerOnly: true,
    handler: (args, ctx) => {
      const settingsStore = ctx.settingsStore;
      if (!settingsStore) return "Settings not available.";

      const BRIEFING_ID = "cron_briefingam";
      const BRIEFING_PROMPT = `Morning Briefing — run automatically.
1. Check today's date and day of week
2. Grep MEMORY.md for scheduled events, deadlines, or reminders (e.g. \`grep -n -i -E "deadline|due|remind|meeting" "${path.join(config.WORKSPACE_DIR, "MEMORY.md")}"\`); don't read it whole
3. Search daily logs from the last 3 days for context on ongoing work
4. Summarize what's happening today and any pending action items
5. Send the briefing to all active channels using send_message (telegram if configured, always web)

Keep it concise — 5-10 bullet points max. Be direct and useful.`;

      if (!args) {
        // Trigger immediate briefing
        const job = { id: "briefing-now", prompt: BRIEFING_PROMPT, channel: "web:default" };
        runCronJob(job).catch(() => {});
        return "Running briefing now...";
      }

      const cmd = args.toLowerCase().split(/\s+/);

      if (cmd[0] === "on") {
        const hour = settingsStore.get("briefing.hour") || 8;
        try {
          // Remove existing if any
          removeCronJob(BRIEFING_ID);
        } catch { /* ignore */ }
        addCronJob({
          schedule: `0 ${hour} * * *`,
          prompt: BRIEFING_PROMPT,
          channel: "web:default",
          name: "briefingam",
          id: BRIEFING_ID, // its own fixed id, which off and time find it by
          createdBy: "owner", // typed by the owner (ownerOnly)
        });
        return `Morning briefing enabled — runs daily at **${hour}:00**\n\nChange time: \`/briefing time <hour>\`\nDisable: \`/briefing off\``;
      }

      if (cmd[0] === "off") {
        const removed = removeCronJob(BRIEFING_ID);
        if (removed) {
          startCronScheduler(); // Restart to pick up changes
          return "Morning briefing disabled.";
        }
        return "No briefing scheduled.";
      }

      if (cmd[0] === "time" && cmd[1]) {
        const hour = parseInt(cmd[1], 10);
        if (isNaN(hour) || hour < 0 || hour > 23) return "Hour must be 0-23.";
        settingsStore.set("briefing.hour", hour);

        // Update existing job if running
        const jobs = loadCronJobs();
        const existing = jobs.find((j) => j.id === BRIEFING_ID);
        if (existing) {
          removeCronJob(BRIEFING_ID);
          addCronJob({
            schedule: `0 ${hour} * * *`,
            prompt: BRIEFING_PROMPT,
            channel: "web:default",
            name: "briefingam",
            id: BRIEFING_ID,
            createdBy: "owner",
            enabled: existing.enabled !== false,
          });
          return `Briefing time changed to **${hour}:00** daily.`;
        }
        return `Briefing hour saved as **${hour}:00**. Enable with \`/briefing on\`.`;
      }

      return "Usage: `/briefing` (run now), `/briefing on`, `/briefing off`, `/briefing time <0-23>`";
    },
  },

  // Inspect/trigger retention sweep — auto-deletes old conversations
  // and checkpoint archives. Runs daily at 03:00; this is the manual
  // knob for inspection + on-demand run.
  retention: {
    description: "Preview or run the retention sweep (auto-deletes old conversations + checkpoints)",
    usage: "/retention [preview|run]",
    category: "Tools",
    handler: async (args, ctx) => {
      const sub = (args || "").toLowerCase().trim() || "preview";
      const settings = ctx.settingsStore;

      if (sub === "run") {
        try {
          const result = await runRetentionNow();
          return `**Retention sweep complete.**\n- ${result.convs} conversations deleted\n- ${result.checks} checkpoint archives deleted\n\nSummaries of pruned conversations appended to \`memory/archived-conversations.md\`.`;
        } catch (err) {
          return `Retention run failed: ${err.message}`;
        }
      }

      // Default: preview (dry-run).
      try {
        const p = previewRetention();
        const lines = [];
        lines.push(`**Retention preview** — *nothing has been deleted yet*`);
        lines.push("");
        lines.push(`**Config:** conversations ${p.config.convDays}d · checkpoints ${p.config.checkDays}d (max ${p.config.checkMax} files)`);
        lines.push("");
        lines.push(`**Conversations that WOULD be deleted (${p.conversations.length}):**`);
        if (p.conversations.length === 0) {
          lines.push("_None — nothing older than the cutoff._");
        } else {
          for (const c of p.conversations.slice(0, 20)) {
            lines.push(`- ${(c.updated_at || "").slice(0, 10)} · ${c.title || "Untitled"} · ${c.msg_count} msgs`);
          }
          if (p.conversations.length > 20) lines.push(`_…and ${p.conversations.length - 20} more._`);
        }
        lines.push("");
        lines.push(`**Checkpoints that WOULD be deleted (${p.checkpoints.length}):**`);
        if (p.checkpoints.length === 0) {
          lines.push("_None._");
        } else {
          for (const c of p.checkpoints.slice(0, 10)) {
            lines.push(`- ${c.name} (${c.age_days}d old)`);
          }
          if (p.checkpoints.length > 10) lines.push(`_…and ${p.checkpoints.length - 10} more._`);
        }
        lines.push("");
        const lastRun = settings?.get("retention.last_run_at");
        if (lastRun) lines.push(`_Last sweep: ${lastRun}_`);
        lines.push("");
        lines.push("Run now: `/retention run`");
        lines.push("Tune: set `retention.conversations_days`, `retention.checkpoints_days`, `retention.checkpoints_max` in settings.");
        return lines.join("\n");
      } catch (err) {
        return `Retention preview failed: ${err.message}`;
      }
    },
  },

  // Checkpoint the current session to a detailed handoff document so a
  // follow-on instance (after container wipe / redeploy) can pick up the
  // context. Writes to workspace/CHECKPOINT.md; the next session's first
  // message automatically consumes + archives it via buildSystemPrompt.
  checkpoint: {
    description: "Write a detailed session handoff to CHECKPOINT.md before a restart",
    usage: "/checkpoint [list|show]",
    category: "Context",
    handler: (args, _ctx) => {
      const sub = (args || "").toLowerCase().trim();

      if (sub === "list") {
        const recent = listRecentCheckpoints(10);
        if (recent.length === 0) return "No archived checkpoints yet. Run `/checkpoint` to create one.";
        const lines = recent.map((c) => `- ${c.name} (${Math.round(c.size / 1024)} KB)`);
        return `**Recent checkpoints (${recent.length}):**\n${lines.join("\n")}\n\nLocation: \`memory/checkpoints/\``;
      }

      if (sub === "show") {
        const body = peekCheckpoint();
        if (!body) return "No active checkpoint. Run `/checkpoint` to create one.";
        return `**Current CHECKPOINT.md (unconsumed):**\n\n${body.slice(0, 8000)}`;
      }

      // Default: return a detailed playbook prompting Claude to write
      // an exhaustive handoff to CHECKPOINT.md. The prompt is opinionated
      // so the output is actually useful after a wipe.
      return `__PLAYBOOK__
You're about to be restarted with a container wipe (Railway redeploy).
Write a COMPREHENSIVE handoff document to \`${CHECKPOINT_FILE_PATH}\` so
the next Tarsee instance can pick up exactly where we left off.

Use the \`tarsee_write_file\` tool with filename = "CHECKPOINT.md".

The document MUST cover every section below. Be specific, concrete, and
include code/commands/IDs where they exist. No vague summaries.

\`\`\`markdown
# Tarsee Session Checkpoint
*Written: <ISO timestamp you generate>*
*Session context: <1-2 sentence framing of what this session was about>*

## Active Projects
For each project the user mentioned or worked on this session, write:
- **Project name** — client/context (e.g. "Acme Bakery — website refresh", "Side project — SMS reminders")
- Current status (what's done, what's in-flight, what's blocked)
- Recent decisions + rationale
- Next concrete step
- Key files, repos, or branches touched
- Any pending action items

## Keys / Credentials Referenced
List every API key, bot token, account, or credential that came up this
session. DO NOT include the actual secret values — those are in the
vault. Reference by semantic name + where it's stored:
- e.g. "Twilio Account SID (SMS reminders): vault key \`twilio.sid\`"
- e.g. "Acme Bakery's SendGrid key: vault key \`acme.sendgrid\`"
- Note any keys that WEREN'T stored and need to be re-added on next boot.

## Open Questions / Blockers
Anything the user asked that wasn't fully resolved. Anything waiting on
them vs. waiting on you vs. waiting on an external party.

## Pending Scheduled Work
- Cron jobs that might fire during the restart window — list their IDs
  and what they do, so the new instance knows not to double-fire.
- Webhooks expected to receive traffic
- Long-running tasks that got interrupted (if any)

## Recent Conversation Summary
5-10 bullets on what's been discussed in this session, ordered
chronologically. Each bullet: 1-2 sentences.

## Context You Should Re-Absorb
- MEMORY.md entries that were updated this session (with \`/remember\`)
- Any SOUL.md / IDENTITY.md / USER.md changes
- Settings or configuration that changed (model, effort, theme, push,
  cron, skills installed)

## Next Action on Reboot
ONE clear first action the next instance should take. Example:
"Greet the user, confirm you've absorbed this checkpoint, then resume
the Twilio webhook fix — the merge was blocked by the auth-token race,
see line 45 of src/channels/webhook.js."

## Anything Else
Free-form — inside jokes, running gags, the user's current mood,
specific tone to use, things to avoid bringing up, etc.
\`\`\`

After writing the file, reply to me with a ONE-LINE confirmation in the
format: "Checkpoint written: N sections, M KB. Safe to restart."

Do NOT paraphrase the whole file back to me — the file itself is the
artifact. Just confirm.`;
    },
  },

  // Run the ultrareview skill — multi-agent code review on current branch.
  // Both this and /fewer-prompts use the __PLAYBOOK__ mechanism to feed
  // the skill body to Claude as a user-message prefix, same pattern as
  // the /email subcommands.
  ultrareview: {
    description: "Deep multi-agent code review on the current branch",
    usage: "/ultrareview",
    category: "Tools",
    handler: (_args, _ctx) => {
      const skill = getSkillContent("ultrareview");
      if (!skill?.content) {
        return "UltraReview skill isn't installed. Try `/skills` to see what's available, or re-deploy to trigger auto-install.";
      }
      return `__PLAYBOOK__\nFollow the UltraReview skill exactly:\n\n${skill.content}`;
    },
  },

  "fewer-prompts": {
    description: "Propose a tool-permission allowlist based on recent audit log",
    usage: "/fewer-prompts",
    category: "Tools",
    handler: (_args, _ctx) => {
      const skill = getSkillContent("fewer-permission-prompts");
      if (!skill?.content) {
        return "fewer-permission-prompts skill isn't installed. Try `/skills` to see what's available, or re-deploy to trigger auto-install.";
      }
      return `__PLAYBOOK__\nFollow the fewer-permission-prompts skill exactly:\n\n${skill.content}`;
    },
  },

  status: {
    description: "Full system dashboard — uptime, tokens, messages, channels, memory",
    usage: "/status",
    handler: async (_args, ctx) => {
      const mem = process.memoryUsage();
      const uptime = Math.floor(process.uptime());
      const hrs = Math.floor(uptime / 3600);
      const mins = Math.floor((uptime % 3600) / 60);

      const lines = [
        "**Tarsee Status**",
        "",
        `⏱ **Uptime:** ${hrs}h ${mins}m | **RAM:** ${Math.round(mem.rss / 1024 / 1024)}MB`,
      ];

      // The AI and model (the default, and this chat's own if it has one), and the engines that run them
      if (ctx.settingsStore) {
        const store = ctx.settingsStore;
        const def = defaultPick(store, aiDeps(ctx));
        const autoRoute = store.get("ai.autoRoute") === true;
        const s = await readiness(def.provider, ctx);
        lines.push(`🤖 **AI:** ${aiLabel(def.provider, def.model, store)}${s.ready ? "" : ` (not ready: ${s.fix || s.detail || s.state})`}${autoRoute ? " (auto-routing ON)" : ""}`);
        const target = await chatTarget(ctx);
        if (target.own && (target.provider !== def.provider || target.model !== def.model)) lines.push(`**This chat:** ${aiLabel(target.provider, target.model, store)}`);
        else if (target.warning) lines.push(`**This chat:** ${target.warning}`);
        lines.push(`**Engines:** ${enginesLine()}`);
      }

      // Channels
      if (ctx.channelManager) {
        const status = ctx.channelManager.getStatus();
        const chLines = Object.entries(status).map(([t, s]) => `${t}: ${s.status}`).join(" · ");
        lines.push(`📡 **Channels:** ${chLines}`);
      }

      // Messages + tokens (if DB available)
      if (ctx.db) {
        try {
          const msgCount = ctx.db.prepare("SELECT COUNT(*) as c FROM messages").get()?.c || 0;
          const todayMsgs = ctx.db.prepare("SELECT COUNT(*) as c FROM messages WHERE created_at >= date('now')").get()?.c || 0;
          const convCount = ctx.db.prepare("SELECT COUNT(*) as c FROM conversations").get()?.c || 0;
          const tokens = ctx.db.prepare(`SELECT COALESCE(SUM(tokens_in),0) as ti, COALESCE(SUM(tokens_out),0) as to_, COALESCE(SUM(CASE WHEN created_at >= date('now') THEN tokens_in ELSE 0 END),0) as tdi, COALESCE(SUM(CASE WHEN created_at >= date('now') THEN tokens_out ELSE 0 END),0) as tdo FROM messages`).get() || {};
          let memCount = 0;
          try { memCount = ctx.db.prepare("SELECT COUNT(*) as c FROM bot_memory").get()?.c || 0; } catch {}

          lines.push("");
          lines.push(`💬 **Conversations:** ${convCount} | **Messages:** ${msgCount} (${todayMsgs} today)`);
          lines.push(`🔢 **Tokens today:** ${(tokens.tdi||0).toLocaleString()} in / ${(tokens.tdo||0).toLocaleString()} out`);
          lines.push(`📊 **Tokens all-time:** ${(tokens.ti||0).toLocaleString()} in / ${(tokens.to_||0).toLocaleString()} out`);
          lines.push(`🧠 **Memories:** ${memCount}`);
        } catch { /* ignore */ }
      }

      return lines.join("\n");
    },
  },

  voices: {
    description: "List available voice profiles",
    usage: "/voices",
    handler: async (_args, ctx) => {
      try {
        const { getTTSEngine } = await import("../voice/engine-registry.js");
        const engine = getTTSEngine();

        if (engine.name === "stub") {
          return "No TTS engine active. Configure one in Settings > Voice.";
        }

        const voices = await engine.listVoices();
        if (voices.length === 0) {
          return `**TTS Engine:** ${engine.name}\nNo cloned voices yet. Use Settings > Voice to clone a voice.`;
        }

        const voiceList = voices.map((v) => `  - ${v.name || v.id}${v.isClone ? " (cloned)" : ""}`).join("\n");
        return `**TTS Engine:** ${engine.name}\n**Voices:**\n${voiceList}`;
      } catch {
        return "Could not load voices.";
      }
    },
  },

  export: {
    description: "Export current conversation as text",
    usage: "/export",
    handler: (_args, ctx) => {
      if (!ctx.conversationId || !ctx.convStore) return "No active conversation.";

      const conv = ctx.convStore.get(ctx.conversationId);
      if (!conv) return "Conversation not found.";

      const messages = ctx.convStore.getMessages(ctx.conversationId);
      if (messages.length === 0) return "Conversation is empty.";

      const lines = [`# ${conv.title || "Untitled"}`, `Exported: ${new Date().toISOString()}`, ""];
      for (const msg of messages) {
        const role = msg.role === "user" ? "You" : "Tarsee";
        lines.push(`**${role}:**`);
        lines.push(msg.content);
        lines.push("");
      }

      return lines.join("\n");
    },
  },
  remember: {
    description: "Save a fact or preference to bot memory (DB + MEMORY.md)",
    usage: "/remember [something to remember]",
    handler: async (args, ctx) => {
      if (!args) return "Usage: `/remember The user prefers dark mode`";

      try {
        const { MemoryStore } = await import("../db/memory.js");
        const db = ctx.db;
        if (!db) return "Database not available.";

        const store = new MemoryStore(db);
        store.addAndSync(args, "preference", ctx.conversationId || null);
        return `Remembered: "${args}" (saved to DB + MEMORY.md)`;
      } catch (err) {
        return `Failed to save memory: ${err.message}`;
      }
    },
  },

  skills: {
    description: "List available skills",
    usage: "/skills",
    handler: async () => {
      try {
        const { getSkillsList } = await import("./skills-engine.js");
        const skills = getSkillsList();

        if (skills.length === 0) {
          return "No skills available yet. Create skills in **Settings > Skills**.";
        }

        const lines = ["**Available Skills**", ""];
        for (const s of skills) {
          const badge = s.source === "built-in" ? "(built-in)" : "(custom)";
          lines.push(`- **${s.name}** ${badge} — ${s.description}`);
        }
        lines.push("", "Manage skills in **Settings > Skills**.");
        return lines.join("\n");
      } catch (err) {
        return `Failed to load skills: ${err.message}`;
      }
    },
  },

  cron: {
    description: "Scheduled tasks: list them, add one, switch one on or off, run or remove one",
    usage: "/cron [list|add|on|off|run|remove]",
    ownerOnly: true,
    handler: async (args) => {
      try {
        const { getCronStatus, addCronJob, removeCronJob, runCronJob, loadCronJobs, setCronJobEnabled } = await import("./cron.js");

        if (!args || args === "list" || args === "status") {
          const status = getCronStatus();
          if (status.jobs.length === 0) {
            return "No scheduled tasks yet. Add one in Settings > Automation > Scheduled tasks, or with `/cron add \"0 9 * * *\" Your prompt here`.";
          }
          const STATE = { waiting: "waiting for your OK", running: "running", on: "on", off: "off" };
          const WHO = { ai: "made by the AI in a chat", owner: "made by you" };
          const lines = ["**Scheduled tasks**", ""];
          // A task that runs a tool directly shows the tool and its args, so the owner sees what /cron on switches on,
          // every secret masked (lib/cron.js shownDirectAction): JSON in a code span, with each backtick in it written as
          // its JSON escape (backslash, u0060), so it can't end the span.
          const code = (v) => JSON.stringify(v).replace(/`/g, "\\u0060");
          const runs = ({ tool, args }) => {
            const none = args === undefined || (args && typeof args === "object" && !Array.isArray(args) && Object.keys(args).length === 0);
            const name = /^[A-Za-z0-9_]+$/.test(tool) ? tool : `\`${code(tool)}\``;
            return `runs ${name} directly, no AI${none ? "" : `, with \`${code(args)}\``}`;
          };
          for (const j of status.jobs) {
            const what = j.actionShown ? runs(j.actionShown) : String(j.prompt || "").slice(0, 60);
            const who = WHO[j.createdBy] ? ` · ${WHO[j.createdBy]}` : "";
            lines.push(`- **${j.id}** [${STATE[j.state] || j.state}] \`${j.schedule}\` — ${what}${who}`);
          }
          lines.push("", "Switch one on with `/cron on <id>`, or pause one with `/cron off <id>`.");
          lines.push(`On: ${status.activeJobs}/${status.totalJobs}`);
          return lines.join("\n");
        }

        if (args.startsWith("add ")) {
          // Parse: /cron add "schedule" prompt text
          const match = args.slice(4).match(/^"([^"]+)"\s+(.+)$/s);
          if (!match) {
            return 'Usage: `/cron add "0 9 * * *" Good morning summary`';
          }
          // Typed by the owner (ownerOnly), so it is theirs and switched on.
          const job = addCronJob({ schedule: match[1], prompt: match[2], createdBy: "owner" });
          return `Scheduled task created and switched on: **${job.id}** — \`${job.schedule}\``;
        }

        const onOff = /^(on|off)(?:\s+(\S+))?$/i.exec(args);
        if (onOff) {
          const on = onOff[1].toLowerCase() === "on";
          const id = onOff[2];
          if (!id) return `Usage: \`/cron ${on ? "on" : "off"} <id>\` (\`/cron list\` shows the ids)`;
          const job = setCronJobEnabled(id, on);
          if (!job) return `No scheduled task ${id}. \`/cron list\` shows the ids.`;
          return on
            ? `Switched on **${id}**: it runs at \`${job.schedule}\`.`
            : `Paused **${id}**: it won't run until you switch it on again (\`/cron on ${id}\`).`;
        }

        if (args.startsWith("remove ")) {
          const id = args.slice(7).trim();
          const removed = removeCronJob(id);
          return removed ? `Removed cron job **${id}**` : `Job not found: ${id}`;
        }

        if (args.startsWith("run ")) {
          const id = args.slice(4).trim();
          const jobs = loadCronJobs();
          const job = jobs.find((j) => j.id === id);
          if (!job) return `Job not found: ${id}`;
          const result = await runCronJob(job);
          if (result.error) return `Cron error: ${result.error}`;
          return `**Cron result:**\n\n${result.response?.slice(0, 2000) || "(empty)"}${result.warning ? `\n\n_${result.warning}_` : ""}`;
        }

        return 'Usage: `/cron list|add|on <id>|off <id>|run <id>|remove <id>`';
      } catch (err) {
        return `Cron error: ${err.message}`;
      }
    },
  },

  stop: {
    description: "Stop the current AI generation",
    usage: "/stop",
    handler: (_args, ctx) => {
      if (ctx.abortController) {
        ctx.abortController.abort();
        return "Generation stopped.";
      }
      return "Nothing is currently generating.";
    },
  },

  // /new → alias for /clear
  new: { description: "Alias for /clear", usage: "/new", handler: (_args, ctx) => COMMANDS.clear.handler(_args, ctx) },

  // /usage → alias for /status
  usage: { description: "Alias for /status", usage: "/usage", handler: (_args, ctx) => COMMANDS.status.handler(_args, ctx) },

  doctor: {
    description: "Run diagnostics and self-heal (use /doctor fix to auto-repair)",
    usage: "/doctor [fix]",
    handler: async (args, ctx) => {
      try {
        const { runDiagnostics, autoRepair, formatDiagnostics } = await import("./self-heal.js");
        const diagnostics = await runDiagnostics(ctx);
        let repairs = [];
        if (args === "fix" || args === "repair") {
          repairs = await autoRepair(diagnostics, ctx);
        }
        return formatDiagnostics(diagnostics, repairs);
      } catch (err) {
        return `Doctor error: ${err.message}`;
      }
    },
  },

  version: {
    description: "Show the Tarsee version, the AI and model, and the engines",
    usage: "/version",
    handler: async (_args, ctx) => {
      try {
        // package.json beside src/ (/app/package.json in the image), wherever Tarsee is installed.
        const pkg = JSON.parse(fs.readFileSync(path.join(APP_ROOT, "package.json"), "utf8"));
        const commit = process.env.TARSEE_COMMIT_SHA?.slice(0, 7) || "unknown";
        const lines = [`**Tarsee** v${pkg.version} (${commit})`];
        if (ctx?.settingsStore) {
          const def = defaultPick(ctx.settingsStore, aiDeps(ctx));
          lines.push(`**AI:** ${aiLabel(def.provider, def.model, ctx.settingsStore)}`);
        }
        lines.push(`**Engines:** ${enginesLine()}`, `**Node:** ${process.version}`);
        return lines.join("\n");
      } catch (err) {
        return `Version check failed: ${err.message}`;
      }
    },
  },
};

/**
 * A handful of commands (/checkpoint, /ultrareview, /email check, …) return
 * a playbook instead of a plain reply: a string prefixed with
 * "__PLAYBOOK__\n" that the caller should feed to the AI as the user's
 * turn, not echo back. Channels forget to check this and end up sending
 * the entire playbook back to the user as a message. This helper
 * centralises the check + prefix stripping.
 *
 * @param {{ handled?: boolean, response?: string } | null | undefined} cmdResult
 * @returns {string|null} The stripped playbook body, or null if the
 *   result is a normal command response.
 */
export function extractPlaybookPrompt(cmdResult) {
  if (!cmdResult?.handled) return null;
  const r = cmdResult.response;
  if (typeof r !== "string") return null;
  if (!r.startsWith("__PLAYBOOK__\n")) return null;
  return r.slice("__PLAYBOOK__\n".length);
}

/**
 * Process a potential command message.
 *
 * @param {string} message - The raw user message
 * @param {object} ctx - Context object with settingsStore, convStore, conversationId, channelManager, clearConversation, db
 * @returns {Promise<{handled: boolean, response?: string}>}
 */
export async function processCommand(message, ctx = {}) {
  if (!message || !message.startsWith("/")) {
    return { handled: false };
  }

  const parts = message.slice(1).split(/\s+/);
  const cmdName = parts[0]?.toLowerCase();
  const args = parts.slice(1).join(" ").trim() || null;

  const cmd = COMMANDS[cmdName];
  if (!cmd) {
    return { handled: false }; // Not a known command — treat as normal message
  }
  if (cmd.ownerOnly && !fromOwner(ctx)) {
    return { handled: true, response: notTheOwner(cmdName, ctx) };
  }

  const response = await cmd.handler(args, ctx);
  return { handled: true, response };
}

/**
 * Whether a command comes from the owner, for the owner's commands (ownerOnly: /cron, /briefing, /webhook). They set
 * up work that runs the AI with nobody asking at the time, and /webhook shows the API token, so someone the owner let
 * talk to the bot (a group, a server channel, or anyone at all when a platform has no allowlist) must not use them.
 *
 *   platform "web"   the dashboard (its chat and its WebSocket): behind the owner's login, so the owner.
 *   owner: true      a chat platform's own word for it (channels/*.js): the sender's own user id (on WhatsApp, their
 *                    number) is on that platform's allowlist. A listed group or channel lets its members talk to the
 *                    bot, not manage it; with no allowlist anyone can talk to it, so nobody there counts; email never
 *                    says it, since a From address is easy to fake.
 * Anything else is not the owner: a caller that says nothing is refused.
 */
function fromOwner(ctx) {
  return ctx.platform === "web" || ctx.owner === true;
}

const OWNER_ID_ON = {
  telegram: "your own Telegram user ID",
  discord: "your own Discord user ID",
  slack: "your own Slack user ID",
  whatsapp: "your own WhatsApp number",
};

const OWNER_ONLY_WHY = {
  cron: "scheduled tasks run the AI with nobody asking at the time, and each run can cost money",
  briefing: "the briefing runs the AI and can be scheduled every day, and each run can cost money",
  webhook: "it shows Tarsee's API token and sets up webhooks that run the AI",
};

/** What someone who isn't the owner gets for an owner's command. */
function notTheOwner(cmdName, ctx) {
  const why = OWNER_ONLY_WHY[cmdName] || "it changes what Tarsee does on its own";
  const where = cmdName === "webhook"
    ? "Use it in the dashboard's chat"
    : "Use Settings > Automation > Scheduled tasks on the dashboard, or this command in the dashboard's chat";
  const lead = `Only the owner can use /${cmdName}: ${why}.`;
  if (ctx.platform === "email") return `${lead} That can't be done by email, since a sender's address is easy to fake. ${where}.`;
  const id = OWNER_ID_ON[ctx.platform];
  if (id) return `${lead} ${where}. If you are the owner, put ${id} on the allowlist in Settings > Channels, and you can use it here.`;
  return `${lead} ${where}.`;
}

/**
 * Get the list of commands (for UI hints).
 *
 * Each command is auto-categorized by name so the palette can render
 * grouped sections without us touching every COMMAND entry. Override by
 * adding a `category: "..."` field directly on a command if needed.
 */
const CATEGORY_RULES = [
  { cat: "Context", names: ["clear", "new", "send", "export", "remember", "memory"] },
  { cat: "Model",   names: ["model", "think", "effort", "auto-route", "voice"] },
  { cat: "Appearance", names: ["theme"] },
  { cat: "Automation", names: ["webhook", "cron", "briefing"] },
  { cat: "Comms",   names: ["email"] },
  { cat: "Tools",   names: ["skill", "doctor", "stop", "status", "stats", "usage", "version", "ultrareview", "fewer-prompts", "retention", "checkpoint"] },
  { cat: "Help",    names: ["help"] },
];

function categorize(name, cmd) {
  if (cmd.category) return cmd.category;
  for (const rule of CATEGORY_RULES) {
    if (rule.names.includes(name)) return rule.cat;
  }
  return "Other";
}

export function getCommandList() {
  return Object.entries(COMMANDS).map(([name, cmd]) => ({
    name,
    description: cmd.description,
    usage: cmd.usage,
    category: categorize(name, cmd),
  }));
}
