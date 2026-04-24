import { AI_PROVIDERS } from "../config/constants.js";
import { addCronJob, removeCronJob, loadCronJobs, runCronJob, startCronScheduler } from "./cron.js";
import { executeTool } from "./tools.js";
import { getSkillContent, installSkill, scanSkills } from "./skills-engine.js";

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
    description: "Start a new conversation (saves a summary first)",
    usage: "/clear",
    handler: async (_args, ctx) => {
      let summaryNote = "";
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
      }
      if (ctx.clearConversation) {
        ctx.clearConversation();
      }
      return "Conversation cleared. Starting fresh." + summaryNote;
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
    description: "Set thinking effort (low, medium, high, max, xhigh)",
    usage: "/think [low|medium|high|max|xhigh]",
    handler: (args, ctx) => {
      const levels = {
        low: "low", medium: "medium", med: "medium",
        high: "high", max: "max", xhigh: "xhigh", ultra: "xhigh",
      };
      const settingsStore = ctx.settingsStore;
      if (!settingsStore) return "Settings not available.";

      if (!args) {
        const current = ctx.conversationId
          ? settingsStore.get(`session.${ctx.conversationId}.effort`) || "default"
          : "default";
        return `**Current effort:** ${current}\n\n**Options:**\n- \`/think low\` — Minimal thinking, fastest\n- \`/think medium\` — Balanced\n- \`/think high\` — Deep reasoning (default)\n- \`/think max\` — Maximum effort (Opus only)\n- \`/think xhigh\` — Extra-high budget (Opus 4.7 only)`;
      }

      const level = levels[args.toLowerCase()];
      if (!level) return `Unknown level. Use: low, medium, high, max, or xhigh`;

      if (ctx.conversationId) {
        settingsStore.set(`session.${ctx.conversationId}.effort`, level);
      }
      return `Thinking effort set to **${level}**`;
    },
  },

  // Alias of /think that also triggers the slider UI on the client.
  // Server-side behavior is identical; the web frontend intercepts the
  // command response and opens the effort slider if no argument was given.
  effort: {
    description: "Set thinking effort via slider or shortcut",
    usage: "/effort [low|medium|high|max|xhigh]",
    handler: (args, ctx) => {
      if (!args) {
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
    usage: "/send [telegram|discord|web]",
    handler: async (args, ctx) => {
      if (!args) return "Usage: `/send telegram`, `/send discord`, `/send web`";
      const target = args.toLowerCase().trim();
      const validChannels = ["telegram", "discord", "web"];
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
    description: "Toggle auto model routing (haiku for simple, sonnet for general, opus for complex)",
    usage: "/auto [on|off]",
    handler: (args, ctx) => {
      const settingsStore = ctx.settingsStore;
      if (!settingsStore) return "Settings not available.";

      const current = settingsStore.get("ai.autoRoute") === true;

      if (!args) {
        settingsStore.set("ai.autoRoute", !current);
        return !current
          ? "Auto-routing **enabled** — Haiku for simple, Sonnet for general, Opus for complex."
          : "Auto-routing **disabled** — using default model.";
      }

      if (args.toLowerCase() === "on") {
        settingsStore.set("ai.autoRoute", true);
        return "Auto-routing **enabled** — Haiku for simple, Sonnet for general, Opus for complex.";
      }
      if (args.toLowerCase() === "off") {
        settingsStore.set("ai.autoRoute", false);
        return "Auto-routing **disabled** — using default model.";
      }

      return "Usage: `/auto` (toggle), `/auto on`, `/auto off`";
    },
  },

  webhook: {
    description: "Manage webhook triggers (external events → AI)",
    usage: "/webhook [add <id> <prompt>|remove <id>|list]",
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
    handler: (args, ctx) => {
      const settingsStore = ctx.settingsStore;
      if (!settingsStore) return "Settings not available.";

      const BRIEFING_ID = "cron_briefingam";
      const BRIEFING_PROMPT = `Morning Briefing — run automatically.
1. Check today's date and day of week
2. Read MEMORY.md for any scheduled events, deadlines, or reminders
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
          });
          return `Briefing time changed to **${hour}:00** daily.`;
        }
        return `Briefing hour saved as **${hour}:00**. Enable with \`/briefing on\`.`;
      }

      return "Usage: `/briefing` (run now), `/briefing on`, `/briefing off`, `/briefing time <0-23>`";
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
    handler: (_args, ctx) => {
      const mem = process.memoryUsage();
      const uptime = Math.floor(process.uptime());
      const hrs = Math.floor(uptime / 3600);
      const mins = Math.floor((uptime % 3600) / 60);

      const lines = [
        "**Tarsee Status**",
        "",
        `⏱ **Uptime:** ${hrs}h ${mins}m | **RAM:** ${Math.round(mem.rss / 1024 / 1024)}MB`,
      ];

      // Provider + model
      if (ctx.settingsStore) {
        const active = ctx.settingsStore.getActiveProvider();
        const autoRoute = ctx.settingsStore.get("ai.autoRoute") === true;
        lines.push(`🤖 **Model:** ${active?.model || "default"}${autoRoute ? " (auto-routing ON)" : ""}`);
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
  { cat: "Tools",   names: ["skill", "doctor", "stop", "status", "stats", "usage", "version", "ultrareview", "fewer-prompts"] },
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
