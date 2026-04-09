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
    description: "Show or switch the AI model (opus, sonnet, haiku)",
    usage: "/model [opus|sonnet|haiku]",
    handler: (args, ctx) => {
      const settingsStore = ctx.settingsStore;
      if (!settingsStore) return "Settings not available.";

      const MODELS = {
        opus: "claude-opus-4-6",
        sonnet: "claude-sonnet-4-6",
        haiku: "claude-haiku-4-5",
      };

      const active = settingsStore.getActiveProvider();

      if (!args) {
        const model = active?.model || "claude-opus-4-6";
        const alias = Object.entries(MODELS).find(([, v]) => v === model)?.[0] || model;
        return `**Current model:** ${alias} (\`${model}\`)\n\n**Available:**\n- \`/model opus\` — Opus 4.6 (smartest, 1M context)\n- \`/model sonnet\` — Sonnet 4.6 (fast, 1M context)\n- \`/model haiku\` — Haiku 4.5 (fastest)`;
      }

      const provider = active?.provider || "claude-code";
      const modelId = MODELS[args.toLowerCase()] || args;
      settingsStore.set(`ai.${provider}.model`, modelId);
      const alias = Object.entries(MODELS).find(([, v]) => v === modelId)?.[0] || modelId;
      return `Model switched to **${alias}** (\`${modelId}\`)`;
    },
  },

  think: {
    description: "Set thinking effort (low, medium, high, max)",
    usage: "/think [low|medium|high|max]",
    handler: (args, ctx) => {
      const levels = { low: "low", medium: "medium", med: "medium", high: "high", max: "max" };
      const settingsStore = ctx.settingsStore;
      if (!settingsStore) return "Settings not available.";

      if (!args) {
        const current = ctx.conversationId
          ? settingsStore.get(`session.${ctx.conversationId}.effort`) || "default"
          : "default";
        return `**Current effort:** ${current}\n\n**Options:**\n- \`/think low\` — Minimal thinking, fastest\n- \`/think medium\` — Balanced\n- \`/think high\` — Deep reasoning (default)\n- \`/think max\` — Maximum effort (Opus only)`;
      }

      const level = levels[args.toLowerCase()];
      if (!level) return `Unknown level. Use: low, medium, high, or max`;

      if (ctx.conversationId) {
        settingsStore.set(`session.${ctx.conversationId}.effort`, level);
      }
      return `Thinking effort set to **${level}**`;
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

  // ── Session & system commands ──────────────────────────────────

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

  update: {
    description: "Check for updates and hot-swap code from GitHub",
    usage: "/update",
    handler: async () => {
      const { execSync } = await import("node:child_process");
      const fs = await import("node:fs");
      const path = await import("node:path");

      const REPO = "https://github.com/projectservan8n/Tarsee.git";
      const CACHE_DIR = path.join(process.env.TARSEE_STATE_DIR || "/data/tarsee", "repo-cache");
      const APP_DIR = "/app";

      try {
        // Get current version
        const pkg = JSON.parse(fs.readFileSync(path.join(APP_DIR, "package.json"), "utf8"));
        const currentCommit = process.env.TARSEE_COMMIT_SHA?.slice(0, 7) || "unknown";

        // Fetch latest from GitHub
        if (fs.existsSync(path.join(CACHE_DIR, ".git"))) {
          execSync("git fetch origin main --depth=1", { cwd: CACHE_DIR, stdio: "ignore", timeout: 30_000 });
          execSync("git reset --hard origin/main", { cwd: CACHE_DIR, stdio: "ignore" });
        } else {
          fs.mkdirSync(CACHE_DIR, { recursive: true });
          execSync(`git clone --depth=1 ${REPO} ${CACHE_DIR}`, { stdio: "ignore", timeout: 60_000 });
        }

        const latestCommit = execSync("git rev-parse --short HEAD", { cwd: CACHE_DIR, encoding: "utf8" }).trim();
        const latestPkg = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, "package.json"), "utf8"));

        // Check if deps changed (would need a full redeploy)
        const currentDeps = JSON.stringify(pkg.dependencies || {});
        const latestDeps = JSON.stringify(latestPkg.dependencies || {});
        const depsChanged = currentDeps !== latestDeps;

        if (currentCommit === latestCommit) {
          return `**Already up to date.** v${pkg.version} (${currentCommit})`;
        }

        // Get commit log between versions
        let changelog = "";
        try {
          changelog = execSync(`git log --oneline -10`, { cwd: CACHE_DIR, encoding: "utf8" }).trim();
        } catch { /* ignore */ }

        if (depsChanged) {
          return `**Update available:** ${currentCommit} -> ${latestCommit} (v${latestPkg.version})\n\n` +
            `**Dependencies changed** — this update requires a full redeploy from your Railway dashboard.\n\n` +
            `**Recent changes:**\n\`\`\`\n${changelog}\n\`\`\``;
        }

        // Hot-swap src/ files
        const srcFrom = path.join(CACHE_DIR, "src");
        const srcTo = path.join(APP_DIR, "src");
        execSync(`cp -rf ${srcFrom}/* ${srcTo}/`, { stdio: "ignore" });

        // Also update entrypoint.sh and package.json version
        try { fs.copyFileSync(path.join(CACHE_DIR, "entrypoint.sh"), path.join(APP_DIR, "entrypoint.sh")); } catch {}
        try { fs.copyFileSync(path.join(CACHE_DIR, "package.json"), path.join(APP_DIR, "package.json")); } catch {}

        // Update commit SHA env
        process.env.TARSEE_COMMIT_SHA = latestCommit;

        // Invalidate caches
        try {
          const { invalidateCache } = await import("./workspace-files.js");
          invalidateCache();
          const skills = await import("./skills-engine.js");
          skills.invalidateCache();
        } catch { /* ignore */ }

        return `**Updated!** ${currentCommit} -> ${latestCommit} (v${latestPkg.version})\n\n` +
          `**Recent changes:**\n\`\`\`\n${changelog}\n\`\`\`\n\n` +
          `Hot-swapped \`src/\` files. Run \`/restart\` to apply, or it takes effect on next server restart.`;
      } catch (err) {
        return `**Update failed:** ${err.message}`;
      }
    },
  },

  version: {
    description: "Show current Tarsee version",
    usage: "/version",
    handler: async () => {
      const fs = await import("node:fs");
      const path = await import("node:path");
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join("/app", "package.json"), "utf8"));
        const commit = process.env.TARSEE_COMMIT_SHA?.slice(0, 7) || "unknown";
        const { execSync } = await import("node:child_process");
        const claudeVersion = execSync("claude --version 2>/dev/null || echo unknown", { encoding: "utf8" }).trim();
        return `**Tarsee** v${pkg.version} (${commit})\n**Claude Code:** ${claudeVersion}\n**Node:** ${process.version}`;
      } catch (err) {
        return `Version check failed: ${err.message}`;
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
