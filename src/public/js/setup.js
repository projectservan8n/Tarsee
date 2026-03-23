/**
 * First-time setup module.
 * Step 1: Quick config card (provider + API key)
 * Step 2: Personality interview in the chat UI
 */
const Setup = {
  isSetupConversation: false,
  setupConversationId: null,
  personalityBuffer: "",

  /**
   * Show the provider config card (step 1).
   */
  show(status) {
    document.getElementById("loginScreen").style.display = "none";
    document.getElementById("appScreen").style.display = "none";
    const wizard = document.getElementById("setupWizard");
    wizard.style.display = "flex";

    document.getElementById("setupContent").innerHTML = `
      <div class="setup-card-header">
        <div class="logo-large">OC</div>
        <h2>Welcome to OpusClaw</h2>
        <p>Your personal AI gateway. Connect in under a minute.</p>
      </div>
      <div class="setup-card-body">
        <div class="form-group">
          <label>AI Provider</label>
          <select id="setupProvider">
            <option value="">Select a provider...</option>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI</option>
            <option value="gemini">Google Gemini</option>
            <option value="openrouter">OpenRouter</option>
            <option value="custom">Custom (OpenAI-compatible)</option>
          </select>
        </div>
        <div class="form-group">
          <label>API Key</label>
          <input type="password" id="setupApiKey" placeholder="sk-...">
          <div class="hint">Stored securely, never committed to files.</div>
        </div>
        <div class="form-group" id="setupModelGroup">
          <label>Model (optional)</label>
          <input type="text" id="setupModel" placeholder="Leave blank for default">
        </div>
        <div class="form-group" id="setupBaseUrlGroup" style="display:none">
          <label>Base URL</label>
          <input type="text" id="setupBaseUrl" placeholder="http://localhost:11434/v1">
        </div>
        <div id="setupError" style="color:var(--danger);font-size:13px;margin-bottom:12px;display:none"></div>
        <button class="btn btn-primary" id="setupConnectBtn" style="width:100%;padding:12px;font-size:14px">Connect & Start Chatting</button>
        <p style="text-align:center;margin-top:14px;font-size:11px;color:var(--text-muted)">
          You can also set API keys via environment variables
        </p>
      </div>
    `;

    // Show base URL for custom provider
    document.getElementById("setupProvider").addEventListener("change", (e) => {
      document.getElementById("setupBaseUrlGroup").style.display =
        e.target.value === "custom" ? "block" : "none";
    });

    document.getElementById("setupConnectBtn").addEventListener("click", () => this.saveAndProceed());
  },

  async saveAndProceed() {
    const provider = document.getElementById("setupProvider").value;
    const apiKey = document.getElementById("setupApiKey").value.trim();
    const model = document.getElementById("setupModel").value.trim();
    const baseUrl = document.getElementById("setupBaseUrl")?.value.trim();
    const errorEl = document.getElementById("setupError");

    if (!provider) {
      errorEl.textContent = "Please select a provider";
      errorEl.style.display = "block";
      return;
    }
    if (!apiKey) {
      errorEl.textContent = "Please enter an API key";
      errorEl.style.display = "block";
      return;
    }

    errorEl.style.display = "none";
    document.getElementById("setupConnectBtn").disabled = true;
    document.getElementById("setupConnectBtn").textContent = "Connecting...";

    try {
      await API.saveProvider({
        provider,
        apiKey,
        model: model || undefined,
        baseUrl: baseUrl || undefined,
      });

      // Mark setup as started so it doesn't re-trigger if interview is interrupted
      await API.json("/api/settings/general", {
        method: "POST",
        body: { key: "setup.completed", value: "true" },
      }).catch(() => {});

      // Boot the app and start personality interview
      App.bootApp();
      this.startPersonalityInterview();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
      document.getElementById("setupConnectBtn").disabled = false;
      document.getElementById("setupConnectBtn").textContent = "Connect & Start Chatting";
    }
  },

  /**
   * Start the personality interview as the first conversation.
   * If BOOTSTRAP.md exists, uses it to enhance the interview.
   */
  async startPersonalityInterview() {
    this.isSetupConversation = true;
    this.personalityBuffer = "";

    // Check for BOOTSTRAP.md (first-run ritual)
    let bootstrapContent = "";
    try {
      const bsData = await API.json("/api/settings/workspace-file?name=BOOTSTRAP.md");
      if (bsData.content && bsData.content.trim().length > 10) {
        bootstrapContent = bsData.content;
      }
    } catch {
      // No bootstrap file, that's fine
    }

    const systemPrompt = bootstrapContent
      ? `${INTERVIEW_SYSTEM_PROMPT}\n\n--- BOOTSTRAP CONTEXT ---\nThe following is the BOOTSTRAP.md ritual file. Use it to guide the setup:\n\n${bootstrapContent}`
      : INTERVIEW_SYSTEM_PROMPT;

    // Create a conversation with the interview system prompt
    try {
      const conv = await API.createConversation({
        title: "Getting to know you",
        systemPrompt,
      });
      this.setupConversationId = conv.id;
      Chat.openChannel("web:default", conv.id);

      // Send a hidden first message to kick off the interview
      setTimeout(() => {
        Chat.elements.messageInput.value = "Hey! I just set you up. Let's get to know each other.";
        Chat.send();
      }, 500);
    } catch (err) {
      console.error("[setup] Failed to start interview:", err);
      App.showToast("Setup chat failed — you can configure personality in Settings", "error");
      this.isSetupConversation = false;
    }
  },

  /**
   * Called by Chat's streaming handler on every text chunk.
   * Watches for the completion marker.
   */
  handleStreamingText(fullText) {
    if (!this.isSetupConversation) return;
    this.personalityBuffer = fullText;
  },

  /**
   * Called when streaming completes for setup conversation.
   * Checks for the personality completion marker.
   */
  async handleStreamComplete(fullText) {
    if (!this.isSetupConversation) return;

    const marker = "|||PERSONALITY_COMPLETE|||";
    const markerIdx = fullText.indexOf(marker);
    if (markerIdx === -1) return; // Not done yet, keep chatting

    // Extract the JSON after the marker
    const jsonStr = fullText.slice(markerIdx + marker.length).trim();
    let identity = {};

    try {
      // Try to find JSON in the remaining text
      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        identity = JSON.parse(jsonMatch[0]);
      }
    } catch {
      console.warn("[setup] Could not parse personality JSON, using defaults");
    }

    // Save identity
    const botName = identity.name || "OpusClaw";
    const systemPrompt = identity.systemPrompt || identity.personality || "";

    try {
      // Save bot name to DB (for display in topbar/UI)
      await API.json("/api/settings/general", {
        method: "POST",
        body: { key: "identity.name", value: botName },
      });

      // Write personality to SOUL.md file (source of truth for identity)
      if (systemPrompt) {
        await API.json("/api/settings/workspace-file", {
          method: "PUT",
          body: {
            name: "SOUL.md",
            content: `# Soul & Personality\n\n${systemPrompt}\n`,
          },
        });
        // Also keep in DB as fallback
        await API.json("/api/settings/general", {
          method: "POST",
          body: { key: "identity.systemPrompt", value: systemPrompt },
        });
      }

      // Save preferences to USER.md + bot_memory DB
      if (identity.preferences && Array.isArray(identity.preferences)) {
        const prefLines = identity.preferences.map((p) => `- ${p}`).join("\n");
        await API.json("/api/settings/workspace-file", {
          method: "PUT",
          body: {
            name: "USER.md",
            content: `# About the User\n\n${prefLines}\n`,
          },
        });
        for (const pref of identity.preferences) {
          await API.json("/api/memory", {
            method: "POST",
            body: { content: pref, category: "preference", conversationId: this.setupConversationId },
          });
        }
      }

      // Populate IDENTITY.md with extracted metadata
      const identityLines = [
        "# Identity",
        "",
        `- **Name:** ${botName}`,
        `- **Emoji:** ${identity.emoji || "\u{1F99E}"}`,
        `- **Creature:** ${identity.creature || "Lobster"}`,
        `- **Vibe:** ${identity.vibe || "Helpful and sharp"}`,
      ];
      await API.json("/api/settings/workspace-file", {
        method: "PUT",
        body: { name: "IDENTITY.md", content: identityLines.join("\n") + "\n" },
      });

      // Delete BOOTSTRAP.md (first-run ritual complete)
      try {
        await API.json("/api/settings/bootstrap", { method: "DELETE" });
      } catch {
        // May not exist, that's fine
      }

      // Mark setup as permanently completed so it never re-triggers on redeploy
      await API.json("/api/settings/general", {
        method: "POST",
        body: { key: "setup.completed", value: "true" },
      });

      App.showToast(`Setup complete! I'm ${botName} now.`, "success");

      // Update chat UI
      if (Chat.setBotName) Chat.setBotName(botName);

      // Rename conversation
      if (this.setupConversationId) {
        await API.updateConversation(this.setupConversationId, { title: `Hello from ${botName}` });
        Chat.loadChannels();
      }
    } catch (err) {
      console.error("[setup] Failed to save identity:", err);
      App.showToast("Identity saved partially — check Settings to complete", "error");
    }

    this.isSetupConversation = false;
    this.setupConversationId = null;
  },
};

const INTERVIEW_SYSTEM_PROMPT = `You are being set up for the first time by your new owner. Your job is to have a warm, brief conversation (3-5 exchanges) to learn who they want you to be.

Discover:
1. What they want to call you (suggest "OpusClaw" as default, but let them pick anything)
2. Their preferred communication style (formal/casual/technical/friendly/witty)
3. What they'll mainly use you for (coding, business, creative writing, general assistant, etc.)
4. Any personality traits they want (humor level, emoji usage, verbosity, directness)

Guidelines:
- Be warm, curious, and conversational — not a boring questionnaire
- Keep it natural. Don't ask all questions at once. One or two per message.
- Your identity is stored in SOUL.md (not CLAUDE.md). User preferences go in USER.md. Memories go in MEMORY.md. These are workspace files on the server.
- After 3-5 exchanges, summarize what you learned and ask for confirmation
- When the user confirms (says yes, sounds good, perfect, etc.), output EXACTLY this on its own line:

|||PERSONALITY_COMPLETE|||

Followed by a JSON block with the extracted config:
\`\`\`json
{
  "name": "the bot name they chose",
  "systemPrompt": "A system prompt paragraph that captures the full personality they described. Write it as instructions to yourself, e.g. 'You are [name], a [style] AI assistant who...'",
  "preferences": ["preference 1", "preference 2", "..."]
}
\`\`\`

Start by greeting them warmly and asking what they'd like to call you.`;
