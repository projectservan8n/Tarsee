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
      const lines = ["**Tarsee Commands**", ""];
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
        "**Tarsee Status**",
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

  cron: {
    description: "Manage scheduled cron jobs",
    usage: "/cron [list|add|remove|run|status]",
    handler: async (args) => {
      try {
        const { getCronStatus, addCronJob, removeCronJob, runCronJob, loadCronJobs } = await import("./cron.js");

        if (!args || args === "list" || args === "status") {
          const status = getCronStatus();
          if (status.jobs.length === 0) {
            return "No cron jobs configured. Use `/cron add \"0 9 * * *\" Your prompt here` to add one.";
          }
          const lines = ["**Cron Jobs**", ""];
          for (const j of status.jobs) {
            const badge = j.running ? "running" : j.enabled ? "enabled" : "disabled";
            lines.push(`- **${j.id}** [${badge}] \`${j.schedule}\` — ${j.prompt.slice(0, 60)}`);
          }
          lines.push("", `Active: ${status.activeJobs}/${status.totalJobs}`);
          return lines.join("\n");
        }

        if (args.startsWith("add ")) {
          // Parse: /cron add "schedule" prompt text
          const match = args.slice(4).match(/^"([^"]+)"\s+(.+)$/s);
          if (!match) {
            return 'Usage: `/cron add "0 9 * * *" Good morning summary`';
          }
          const job = addCronJob({ schedule: match[1], prompt: match[2] });
          return `Cron job created: **${job.id}** — \`${job.schedule}\``;
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
          return `**Cron result:**\n\n${result.response?.slice(0, 2000) || "(empty)"}`;
        }

        return 'Usage: `/cron list|add|remove|run|status`';
      } catch (err) {
        return `Cron error: ${err.message}`;
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

  consolidate: {
    description: "Deduplicate and clean up stored memories",
    usage: "/consolidate",
    handler: async (_args, ctx) => {
      try {
        const { MemoryStore } = await import("../db/memory.js");
        if (!ctx.db) return "Database not available.";
        const store = new MemoryStore(ctx.db);
        const removed = store.consolidate();
        const stats = store.getStats();
        const lines = [
          "**Memory Consolidation**",
          "",
          `Removed ${removed} duplicate(s).`,
          `**Total memories:** ${stats.total}`,
        ];
        for (const [cat, count] of Object.entries(stats.byCategory)) {
          lines.push(`  ${cat}: ${count}`);
        }
        if (stats.oldestDate) lines.push(`**Oldest:** ${stats.oldestDate}`);
        if (stats.newestDate) lines.push(`**Newest:** ${stats.newestDate}`);
        return lines.join("\n");
      } catch (err) {
        return `Consolidation error: ${err.message}`;
      }
    },
  },

  // ── New commands (OpenClaw parity) ──────────────────────────────────

  restart: {
    description: "Restart the server (Railway auto-restarts the process)",
    usage: "/restart",
    handler: (_args, _ctx) => {
      setTimeout(() => process.exit(0), 500);
      return "**Restarting Tarsee…** The server will be back in a few seconds.";
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

  new: {
    description: "Start a new session (alias for /clear)",
    usage: "/new",
    handler: (_args, ctx) => {
      if (ctx.clearConversation) ctx.clearConversation();
      return "New session started.";
    },
  },

  config: {
    description: "Show or set a config value",
    usage: "/config [key] [value]",
    handler: (args, ctx) => {
      const settingsStore = ctx.settingsStore;
      if (!settingsStore) return "Settings not available.";

      if (!args) {
        // Show all non-secret settings
        const all = settingsStore.getByPrefix("");
        const lines = ["**Configuration**", ""];
        for (const { key, value } of all) {
          if (key.includes("apiKey") || key.includes("token") || key.includes("secret")) {
            lines.push(`\`${key}\` = ••••••`);
          } else {
            lines.push(`\`${key}\` = ${value}`);
          }
        }
        if (lines.length === 2) lines.push("(no settings stored)");
        return lines.join("\n");
      }

      const parts = args.split(/\s+/);
      const key = parts[0];
      const value = parts.slice(1).join(" ");

      if (!value) {
        // Get single key
        const v = settingsStore.get(key);
        if (v === undefined || v === null) return `\`${key}\` is not set.`;
        if (key.includes("apiKey") || key.includes("token")) return `\`${key}\` = ••••••`;
        return `\`${key}\` = ${v}`;
      }

      // Set key
      settingsStore.set(key, value);
      return `Set \`${key}\` = ${value}`;
    },
  },

  usage: {
    description: "Show token usage and cost estimate",
    usage: "/usage",
    handler: async (_args, ctx) => {
      const db = ctx.db;
      if (!db) return "Database not available.";

      try {
        const total = db.prepare("SELECT COUNT(*) as count FROM messages").get();
        const userMsgs = db.prepare("SELECT COUNT(*) as count FROM messages WHERE role='user'").get();
        const aiMsgs = db.prepare("SELECT COUNT(*) as count FROM messages WHERE role='assistant'").get();
        const convs = db.prepare("SELECT COUNT(*) as count FROM conversations").get();

        // Estimate token count from message content
        const contentRows = db.prepare("SELECT SUM(LENGTH(content)) as chars FROM messages").get();
        const estTokens = Math.round((contentRows.chars || 0) / 4);

        const lines = [
          "**Usage Statistics**",
          "",
          `**Conversations:** ${convs.count}`,
          `**Total messages:** ${total.count}`,
          `  User: ${userMsgs.count}`,
          `  Assistant: ${aiMsgs.count}`,
          `**Est. tokens:** ~${estTokens.toLocaleString()} (based on message length)`,
        ];
        return lines.join("\n");
      } catch (err) {
        return `Usage error: ${err.message}`;
      }
    },
  },

  whoami: {
    description: "Show your identity and session info",
    usage: "/whoami",
    handler: async (_args, ctx) => {
      try {
        const { parseIdentityFile } = await import("./workspace-files.js");
        const identity = parseIdentityFile();
        const name = identity.Name || "Tarsee";
        const emoji = identity.Emoji || "";
        const creature = identity.Creature || "";
        const vibe = identity.Vibe || "";

        const lines = [
          `**${emoji} ${name}**`,
          creature ? `Creature: ${creature}` : null,
          vibe ? `Vibe: ${vibe}` : null,
          "",
          `**Channel:** ${ctx.channel || "web"}`,
          `**Conversation:** ${ctx.conversationId || "(none)"}`,
        ].filter(Boolean);

        if (ctx.settingsStore) {
          const active = ctx.settingsStore.getActiveProvider();
          lines.push(`**Provider:** ${active?.provider || "none"}`);
          lines.push(`**Model:** ${active?.model || "default"}`);
        }

        return lines.join("\n");
      } catch (err) {
        return `Identity error: ${err.message}`;
      }
    },
  },

  compact: {
    description: "Compact conversation by summarizing older messages",
    usage: "/compact",
    handler: async (_args, ctx) => {
      if (!ctx.conversationId || !ctx.convStore) return "No active conversation.";

      const messages = ctx.convStore.getMessages(ctx.conversationId);
      if (messages.length < 10) return "Conversation too short to compact (need 10+ messages).";

      // Keep the last 6 messages, summarize the rest
      const toSummarize = messages.slice(0, -6);
      const summary = toSummarize
        .map((m) => `${m.role}: ${m.content.slice(0, 100)}`)
        .join("\n");

      const lines = [
        "**Conversation Compacted**",
        "",
        `Summarized ${toSummarize.length} older messages.`,
        `Keeping ${Math.min(6, messages.length)} recent messages in context.`,
        "",
        "The AI will see a summary of earlier messages on the next turn.",
      ];

      // Store the summary as a system note
      ctx.convStore.addMessage(ctx.conversationId, {
        role: "system",
        content: `[Compacted ${toSummarize.length} messages] Summary of earlier conversation:\n${summary.slice(0, 2000)}`,
      });

      return lines.join("\n");
    },
  },

  context: {
    description: "Show what's included in the system prompt",
    usage: "/context",
    handler: async (_args, ctx) => {
      try {
        const { readWorkspaceFile } = await import("./workspace-files.js");

        const files = ["AGENTS.md", "SOUL.md", "IDENTITY.md", "USER.md", "TOOLS.md", "MEMORY.md"];
        const lines = ["**System Prompt Context**", ""];

        for (const f of files) {
          const content = readWorkspaceFile(f);
          const size = content ? content.length : 0;
          const status = size > 10 ? `${size} chars` : "(empty)";
          lines.push(`- **${f}**: ${status}`);
        }

        // DB memories
        if (ctx.db) {
          try {
            const { MemoryStore } = await import("../db/memory.js");
            const store = new MemoryStore(ctx.db);
            lines.push(`- **DB Memories**: ${store.count()} entries`);
          } catch { /* ignore */ }
        }

        // Skills
        try {
          const { getSkillsList } = await import("./skills-engine.js");
          const skills = getSkillsList();
          lines.push(`- **Skills**: ${skills.length} available`);
        } catch { /* ignore */ }

        // Conversation system prompt
        if (ctx.conversationId && ctx.convStore) {
          const conv = ctx.convStore.get(ctx.conversationId);
          const cp = conv?.system_prompt;
          lines.push(`- **Conv. prompt**: ${cp ? `${cp.length} chars` : "(none)"}`);
        }

        lines.push("", "All of the above is injected into every AI request (150KB max).");
        lines.push("Workspace files auto-reload within 5 seconds of editing.");
        return lines.join("\n");
      } catch (err) {
        return `Context error: ${err.message}`;
      }
    },
  },

  models: {
    description: "List available AI providers and their default models",
    usage: "/models",
    handler: () => {
      const lines = ["**Available Providers**", ""];
      for (const [id, provider] of Object.entries(AI_PROVIDERS)) {
        lines.push(`**${provider.name}** (\`${id}\`) — default: \`${provider.defaultModel || "none"}\``);
      }
      lines.push("", "Switch with `/model <model-name>` or `/provider <provider-id>`");
      lines.push("Any model ID supported by the provider will work.");
      return lines.join("\n");
    },
  },

  debug: {
    description: "Show debug info for troubleshooting",
    usage: "/debug",
    handler: (_args, ctx) => {
      const mem = process.memoryUsage();
      const lines = [
        "**Debug Info**",
        "",
        `**Node:** ${process.version}`,
        `**Platform:** ${process.platform} ${process.arch}`,
        `**PID:** ${process.pid}`,
        `**Uptime:** ${Math.floor(process.uptime())}s`,
        `**RSS:** ${Math.round(mem.rss / 1024 / 1024)}MB`,
        `**Heap:** ${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)}MB`,
        `**ENV:** ${process.env.NODE_ENV || "development"}`,
      ];

      if (ctx.settingsStore) {
        const active = ctx.settingsStore.getActiveProvider();
        lines.push(`**Provider:** ${active?.provider || "none"}`);
        lines.push(`**Model:** ${active?.model || "default"}`);
        lines.push(`**API Key:** ${active?.apiKey ? "••••" + active.apiKey.slice(-4) : "not set"}`);
      }

      return lines.join("\n");
    },
  },

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

  reload: {
    description: "Force-reload workspace files and skills cache",
    usage: "/reload",
    handler: async () => {
      try {
        const { invalidateCache } = await import("./workspace-files.js");
        invalidateCache();

        const skills = await import("./skills-engine.js");
        skills.invalidateCache();

        return "**Reloaded.** Workspace files and skills cache cleared. Changes take effect on next message.";
      } catch (err) {
        return `Reload error: ${err.message}`;
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
