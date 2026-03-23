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
      <div style="text-align:center;margin-bottom:24px">
        <div style="font-size:48px;font-weight:800;color:var(--primary);margin-bottom:8px">OC</div>
        <h2 style="margin:0 0 4px">Welcome to OpusClaw</h2>
        <p style="color:var(--text-secondary);margin:0">Your personal AI gateway. Let's connect in under a minute.</p>
      </div>

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
      <button class="btn btn-primary" id="setupConnectBtn" style="width:100%;padding:12px">Connect & Start Chatting</button>
      <p style="text-align:center;margin-top:16px;font-size:12px;color:var(--text-muted)">
        You can also set API keys via environment variables (ANTHROPIC_API_KEY, etc.)
      </p>
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
   */
  async startPersonalityInterview() {
    this.isSetupConversation = true;
    this.personalityBuffer = "";

    // Create a conversation with the interview system prompt
    try {
      const conv = await API.createConversation({
        title: "Getting to know you",
        systemPrompt: INTERVIEW_SYSTEM_PROMPT,
      });
      this.setupConversationId = conv.id;
      Chat.openConversation(conv.id);

      // Send a hidden first message to kick off the interview
      // The bot will introduce itself and ask the first question
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
      await API.json("/api/settings/general", {
        method: "POST",
        body: { key: "identity.name", value: botName },
      });
      if (systemPrompt) {
        await API.json("/api/settings/general", {
          method: "POST",
          body: { key: "identity.systemPrompt", value: systemPrompt },
        });
      }

      // Save any preferences as memories
      if (identity.preferences && Array.isArray(identity.preferences)) {
        for (const pref of identity.preferences) {
          await API.json("/api/memory", {
            method: "POST",
            body: { content: pref, category: "preference", conversationId: this.setupConversationId },
          });
        }
      }

      App.showToast(`Setup complete! I'm ${botName} now.`, "success");

      // Update chat UI
      if (Chat.setBotName) Chat.setBotName(botName);

      // Rename conversation
      if (this.setupConversationId) {
        await API.updateConversation(this.setupConversationId, { title: `Hello from ${botName}` });
        Chat.loadConversations();
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
