import { AI_PROVIDERS } from "../config/constants.js";

/**
 * Chat command processor.
 * Commands start with "/" and are handled before being sent to the AI.
 *
 * Returns { handled: true, response: "..." } if it was a command,
 * or { handled: false } if it's a normal message.
 */

const COMMANDS = {
  help: {
    description: "Show available commands",
    usage: "/help",
    handler: () => {
      const lines = ["**OpusClaw Commands**", ""];
      for (const [name, cmd] of Object.entries(COMMANDS)) {
        lines.push(`\`${cmd.usage}\` — ${cmd.description}`);
      }
      lines.push("", "Type anything else to chat with the AI.");
      return lines.join("\n");
    },
  },

  clear: {
    description: "Start a new conversation",
    usage: "/clear",
    handler: (_args, ctx) => {
      if (ctx.clearConversation) {
        ctx.clearConversation();
      }
      return "Conversation cleared. Starting fresh.";
    },
  },

  model: {
    description: "Show or switch the AI model",
    usage: "/model [model-name]",
    handler: (args, ctx) => {
      const settingsStore = ctx.settingsStore;
      if (!settingsStore) return "Settings not available.";

      const active = settingsStore.getActiveProvider();

      if (!args) {
        const provider = active?.provider || "none";
        const model = active?.model || "default";
        return `**Current model:** ${model}\n**Provider:** ${provider}`;
      }

      // Set the model
      const provider = active?.provider;
      if (!provider) return "No provider configured. Set one in Settings first.";

      settingsStore.set(`ai.${provider}.model`, args);
      return `Model switched to **${args}** (provider: ${provider})`;
    },
  },

  provider: {
    description: "Show or switch the AI provider",
    usage: "/provider [name]",
    handler: (args, ctx) => {
      const settingsStore = ctx.settingsStore;
      if (!settingsStore) return "Settings not available.";

      if (!args) {
        const active = settingsStore.getActiveProvider();
        const current = active?.provider || "none";
        const available = Object.keys(AI_PROVIDERS).join(", ");
        return `**Current provider:** ${current}\n**Available:** ${available}`;
      }

      if (!AI_PROVIDERS[args]) {
        return `Unknown provider: ${args}\n**Available:** ${Object.keys(AI_PROVIDERS).join(", ")}`;
      }

      settingsStore.setActiveProvider(args);
      return `Provider switched to **${AI_PROVIDERS[args].name}**`;
    },
  },

  system: {
    description: "Set or show the system prompt for this conversation",
    usage: "/system [prompt]",
    handler: (args, ctx) => {
      if (!ctx.conversationId || !ctx.convStore) {
        return "No active conversation.";
      }

      const conv = ctx.convStore.get(ctx.conversationId);
      if (!conv) return "Conversation not found.";

      if (!args) {
        const prompt = conv.system_prompt || "(none)";
        return `**System prompt:**\n${prompt}`;
      }

      ctx.convStore.update(ctx.conversationId, { systemPrompt: args });
      return `System prompt updated.`;
    },
  },

  title: {
    description: "Rename the current conversation",
    usage: "/title [new title]",
    handler: (args, ctx) => {
      if (!args) return "Usage: `/title My Conversation Name`";
      if (!ctx.conversationId || !ctx.convStore) return "No active conversation.";

      ctx.convStore.updateTitle(ctx.conversationId, args.slice(0, 200));
      return `Conversation renamed to **${args.slice(0, 200)}**`;
    },
  },

  status: {
    description: "Show system status",
    usage: "/status",
    handler: (_args, ctx) => {
      const mem = process.memoryUsage();
      const uptime = Math.floor(process.uptime());
      const hours = Math.floor(uptime / 3600);
      const mins = Math.floor((uptime % 3600) / 60);
      const secs = uptime % 60;

      const lines = [
        "**OpusClaw Status**",
        "",
        `**Uptime:** ${hours}h ${mins}m ${secs}s`,
        `**Memory:** ${Math.round(mem.rss / 1024 / 1024)}MB RSS, ${Math.round(mem.heapUsed / 1024 / 1024)}MB heap`,
        `**Node:** ${process.version}`,
      ];

      if (ctx.settingsStore) {
        const active = ctx.settingsStore.getActiveProvider();
        lines.push(`**Provider:** ${active?.provider || "none"}`);
        lines.push(`**Model:** ${active?.model || "default"}`);
      }

      if (ctx.channelManager) {
        const status = ctx.channelManager.getStatus();
        const channelLines = Object.entries(status)
          .map(([type, s]) => `  ${type}: ${s.status}`)
          .join("\n");
        lines.push(`**Channels:**\n${channelLines}`);
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
        const role = msg.role === "user" ? "You" : "OpusClaw";
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

  soul: {
    description: "Show current SOUL.md personality summary",
    usage: "/soul",
    handler: async () => {
      try {
        const { readWorkspaceFile } = await import("./workspace-files.js");
        const soul = readWorkspaceFile("SOUL.md");
        if (!soul || soul.trim().length < 10) {
          return "No soul defined yet. Edit **SOUL.md** in Settings to give your bot personality.";
        }
        return `**Current Soul:**\n\n${soul.slice(0, 2000)}`;
      } catch (err) {
        return `Failed to read SOUL.md: ${err.message}`;
      }
    },
  },

  daily: {
    description: "Add a note to today's daily memory log",
    usage: "/daily [note]",
    handler: async (args) => {
      if (!args) return "Usage: `/daily Met with client about project scope`";

      try {
        const { appendDailyLog } = await import("./workspace-files.js");
        appendDailyLog(args);
        const today = new Date().toISOString().slice(0, 10);
        return `Logged to **memory/${today}.md**: "${args}"`;
      } catch (err) {
        return `Failed to write daily log: ${err.message}`;
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

  reset: {
    description: "Create a fresh session for the current channel (keeps history in DB)",
    usage: "/reset",
    handler: async (_args, ctx) => {
      if (!ctx.conversationId || !ctx.convStore || !ctx.settingsStore) {
        return "No active conversation to reset.";
      }

      // Find which channel_conv key points to this conversation
      const channelSettings = ctx.settingsStore.getByPrefix("channel_conv.");
      let channelKey = null;
      for (const { key, value } of channelSettings) {
        if (value === ctx.conversationId) {
          channelKey = key.replace("channel_conv.", "");
          break;
        }
      }

      if (!channelKey) {
        return "Could not determine which channel this conversation belongs to.";
      }

      // Create a new conversation for this channel
      const conv = ctx.convStore.create({
        title: channelKey === "web:default" ? "Web Chat" : channelKey,
      });
      ctx.settingsStore.set(`channel_conv.${channelKey}`, conv.id);

      return `Session reset. Fresh conversation started for **${channelKey}**. Previous history is still in the database.`;
    },
  },

  identity: {
    description: "Show parsed IDENTITY.md metadata",
    usage: "/identity",
    handler: async () => {
      try {
        const { parseIdentityFile } = await import("./workspace-files.js");
        const parsed = parseIdentityFile();
        const keys = Object.keys(parsed);
        if (keys.length === 0) {
          return "No identity defined yet. Edit **IDENTITY.md** in Settings to set name, emoji, creature, vibe.";
        }
        const lines = ["**Identity**", ""];
        for (const [k, v] of Object.entries(parsed)) {
          lines.push(`- **${k}:** ${v}`);
        }
        return lines.join("\n");
      } catch (err) {
        return `Failed to read IDENTITY.md: ${err.message}`;
      }
    },
  },

  agents: {
    description: "Show current AGENTS.md rules summary",
    usage: "/agents",
    handler: async () => {
      try {
        const { readWorkspaceFile } = await import("./workspace-files.js");
        const content = readWorkspaceFile("AGENTS.md");
        if (!content || content.trim().length < 10) {
          return "No agent rules defined yet. Edit **AGENTS.md** in Settings.";
        }
        return `**Agent Rules:**\n\n${content.slice(0, 2000)}`;
      } catch (err) {
        return `Failed to read AGENTS.md: ${err.message}`;
      }
    },
  },

  tools: {
    description: "Show current TOOLS.md capabilities",
    usage: "/tools",
    handler: async () => {
      try {
        const { readWorkspaceFile } = await import("./workspace-files.js");
        const content = readWorkspaceFile("TOOLS.md");
        if (!content || content.trim().length < 10) {
          return "No tools defined yet. Edit **TOOLS.md** in Settings.";
        }
        return `**Tools & Capabilities:**\n\n${content.slice(0, 2000)}`;
      } catch (err) {
        return `Failed to read TOOLS.md: ${err.message}`;
      }
    },
  },

  heartbeat: {
    description: "Show heartbeat status or trigger a manual run",
    usage: "/heartbeat [run]",
    handler: async (args) => {
      try {
        const { getHeartbeatStatus, runHeartbeat } = await import("./heartbeat.js");

        if (args === "run") {
          const result = await runHeartbeat("manual");
          if (result.skipped) return `Heartbeat skipped: ${result.reason}`;
          if (result.error) return `Heartbeat error: ${result.error}`;
          if (result.suppressed) return "Heartbeat ran — **HEARTBEAT_OK** (nothing to report)";
          return `**Heartbeat result:**\n\n${result.response?.slice(0, 2000) || "(empty)"}`;
        }

        const status = getHeartbeatStatus();
        const lines = ["**Heartbeat Status**", ""];
        lines.push(`**Running:** ${status.running ? "Yes" : "No"}`);
        lines.push(`**Last run:** ${status.lastRun || "Never"}`);
        lines.push(`**Run count:** ${status.runCount || 0}`);
        if (status.lastResult) lines.push(`**Last result:** ${status.lastResult.slice(0, 200)}`);
        lines.push("", "Use `/heartbeat run` to trigger manually.");
        return lines.join("\n");
      } catch (err) {
        return `Heartbeat error: ${err.message}`;
      }
    },
  },

  boot: {
    description: "Show BOOT.md startup checklist",
    usage: "/boot",
    handler: async () => {
      try {
        const { readWorkspaceFile } = await import("./workspace-files.js");
        const content = readWorkspaceFile("BOOT.md");
        if (!content || content.trim().length < 10) {
          return "No boot checklist defined. Edit **BOOT.md** in Settings to add startup tasks.";
        }
        return `**Boot Checklist:**\n\n${content.slice(0, 2000)}`;
      } catch (err) {
        return `Failed to read BOOT.md: ${err.message}`;
      }
    },
  },

  forget: {
    description: "List and manage bot memories",
    usage: "/forget",
    handler: async (_args, ctx) => {
      try {
        const { MemoryStore } = await import("../db/memory.js");
        const db = ctx.db;
        if (!db) return "Database not available.";

        const store = new MemoryStore(db);
        const memories = store.list(20);

        if (memories.length === 0) return "No memories stored yet.";

        const lines = ["**Bot Memories** (manage in Settings > Memories)", ""];
        for (const m of memories) {
          lines.push(`- [${m.category}] ${m.content}`);
        }
        lines.push("", `Total: ${store.count()} memories`);
        return lines.join("\n");
      } catch (err) {
        return `Failed to load memories: ${err.message}`;
      }
    },
  },
};

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

  const response = await cmd.handler(args, ctx);
  return { handled: true, response };
}

/**
 * Get the list of commands (for UI hints).
 */
export function getCommandList() {
  return Object.entries(COMMANDS).map(([name, cmd]) => ({
    name,
    description: cmd.description,
    usage: cmd.usage,
  }));
}
