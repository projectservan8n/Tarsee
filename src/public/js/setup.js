/**
 * First-time setup wizard.
 * Step 1: Connect Claude (terminal + claude login)
 * Step 2: Choose skills to install
 * Step 3: Personality interview OR skip
 * Step 4: Channel setup (Telegram/Discord)
 *
 * Progress bar shows current step throughout.
 */
const Setup = {
  isSetupConversation: false,
  setupConversationId: null,
  personalityBuffer: "",
  currentStep: 1,
  totalSteps: 4,

  // Skills recommended by default for new users
  DEFAULT_SKILLS: ["weather", "github", "gog", "summarize", "canvas", "nano-pdf", "session-logs", "frontend-design", "gsap-core", "gsap-scrolltrigger"],

  /** Render the progress bar HTML */
  _progressBar(step) {
    const steps = ["Connect", "Skills", "Personality", "Channels"];
    return `<div style="display:flex;gap:4px;margin-bottom:20px;padding:0 4px">${steps.map((label, i) => {
      const num = i + 1;
      const done = num < step;
      const active = num === step;
      const bg = done ? "var(--success)" : active ? "var(--accent)" : "var(--border)";
      const color = done || active ? "var(--text-inverse)" : "var(--text-muted)";
      return `<div style="flex:1;text-align:center">
        <div style="height:4px;border-radius:2px;background:${bg};margin-bottom:6px"></div>
        <span style="font-size:10px;color:${done || active ? 'var(--text)' : 'var(--text-muted)'};font-weight:${active ? '600' : '400'}">${label}</span>
      </div>`;
    }).join("")}</div>`;
  },

  /** Step 1: Connect Claude */
  show(status) {
    this.currentStep = 1;
    document.getElementById("loginScreen").style.display = "none";
    document.getElementById("appScreen").style.display = "none";
    const wizard = document.getElementById("setupWizard");
    wizard.style.display = "flex";

    document.getElementById("setupContent").innerHTML = `
      ${this._progressBar(1)}
      <div class="setup-card-header">
        <div class="logo-large"><img src="/icon-192.png" alt="Tarsee" style="width:100%;height:100%;object-fit:cover;border-radius:inherit"></div>
        <h2>Welcome to Tarsee</h2>
        <p>Your personal AI agent. Let's get connected.</p>
      </div>
      <div class="setup-card-body">
        <div style="margin-bottom:16px">
          <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:14px">
            <span style="background:var(--accent);color:var(--text-inverse);border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:13px;font-weight:700">1</span>
            <div><strong>Open Tarsee's Server Terminal</strong><br><span style="color:var(--text-muted);font-size:13px">This opens a terminal on the server where Tarsee runs (not your local machine)</span></div>
          </div>
          <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:14px">
            <span style="background:var(--accent);color:var(--text-inverse);border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:13px;font-weight:700">2</span>
            <div><strong>Click inside the terminal, then type:</strong><br>
              <code id="setupCmd" style="background:var(--bg-input);padding:4px 10px;border-radius:4px;display:inline-flex;align-items:center;gap:8px;margin-top:4px;cursor:pointer;user-select:all" title="Click to copy">claude login</code>
              <span id="setupCmdCopied" style="color:var(--success);font-size:11px;margin-left:6px;display:none">Copied!</span>
              <br><span style="color:var(--text-muted);font-size:13px;margin-top:4px;display:block">A link will appear — open it in your browser and log in with your Claude Max account.<br>
              <em>Tip: To copy the login link, highlight it and right-click → Copy (Ctrl+C won't work in the terminal)</em></span>
            </div>
          </div>
          <div style="display:flex;align-items:flex-start;gap:12px;margin-bottom:14px">
            <span style="background:var(--accent);color:var(--text-inverse);border-radius:50%;width:24px;height:24px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:13px;font-weight:700">3</span>
            <div><strong>Come back here and click "I'm connected"</strong><br><span style="color:var(--text-muted);font-size:13px">Tarsee will verify your credentials and you're all set</span></div>
          </div>
        </div>
        <a href="/terminal.html" target="_blank" class="btn btn-ghost" style="width:100%;padding:12px;font-size:14px;margin-bottom:10px;text-align:center;display:block;text-decoration:none">Open Tarsee's Terminal →</a>
        <div id="setupError" style="color:var(--danger);font-size:13px;margin-bottom:12px;display:none"></div>
        <button class="btn btn-primary" id="setupConnectBtn" style="width:100%;padding:12px;font-size:14px">I'm connected — Next →</button>
        <p style="text-align:center;margin-top:14px;font-size:11px;color:var(--text-muted)">
          Requires Claude Max subscription. Pro works but hits limits quickly.
        </p>
      </div>
    `;

    // Click-to-copy
    document.getElementById("setupCmd")?.addEventListener("click", () => {
      navigator.clipboard.writeText("claude login").then(() => {
        const el = document.getElementById("setupCmdCopied");
        if (el) { el.style.display = "inline"; setTimeout(() => el.style.display = "none", 2000); }
      }).catch(() => {});
    });

    document.getElementById("setupConnectBtn").addEventListener("click", () => this.saveAndProceed());
  },

  async saveAndProceed() {
    const errorEl = document.getElementById("setupError");
    errorEl.style.display = "none";
    document.getElementById("setupConnectBtn").disabled = true;
    document.getElementById("setupConnectBtn").textContent = "Checking...";

    try {
      await API.saveProvider({ provider: "claude-code", apiKey: "subscription", model: "claude-sonnet-4-6" });
      this.showSkillPicker();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = "block";
      document.getElementById("setupConnectBtn").disabled = false;
      document.getElementById("setupConnectBtn").textContent = "I'm connected — Next →";
    }
  },

  /** Step 2: Skill picker */
  async showSkillPicker() {
    this.currentStep = 2;
    const wizard = document.getElementById("setupWizard");
    wizard.style.display = "flex";

    let skills = [];
    try { const data = await API.json("/api/skills"); skills = data.skills || []; } catch {}

    const skillCards = skills.map(s => {
      const recommended = this.DEFAULT_SKILLS.includes(s.name);
      const checked = recommended ? "checked" : "";
      const badge = recommended ? ' <span style="font-size:9px;color:var(--accent);font-weight:600">RECOMMENDED</span>' : "";
      return `<label style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;background:var(--bg-input);border-radius:8px;cursor:pointer;border:1px solid ${recommended ? 'var(--accent-glow)' : 'var(--border)'}">
        <input type="checkbox" name="skill" value="${s.name}" ${checked} style="margin-top:3px;accent-color:var(--accent)">
        <div>
          <strong style="font-size:13px">${s.name}</strong>${badge}
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${s.description || "No description"}</div>
        </div>
      </label>`;
    }).join("");

    document.getElementById("setupContent").innerHTML = `
      ${this._progressBar(2)}
      <div class="setup-card-header">
        <h2>Choose Your Skills</h2>
        <p style="color:var(--text-muted);font-size:13px">Skills give your agent specialized abilities. Recommended ones are pre-selected. Change anytime in Settings.</p>
      </div>
      <div class="setup-card-body">
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <button class="btn btn-sm btn-ghost" id="setupSkillsAll">Select All</button>
          <button class="btn btn-sm btn-ghost" id="setupSkillsNone">Deselect All</button>
        </div>
        <div id="setupSkillsList" style="display:flex;flex-direction:column;gap:6px;max-height:300px;overflow-y:auto;padding-right:4px">
          ${skillCards}
        </div>
        <button class="btn btn-primary" id="setupSkillsSave" style="width:100%;padding:12px;font-size:14px;margin-top:16px">Install & Continue →</button>
      </div>
    `;

    document.getElementById("setupSkillsAll").addEventListener("click", () => {
      document.querySelectorAll('#setupSkillsList input[type="checkbox"]').forEach(cb => cb.checked = true);
    });
    document.getElementById("setupSkillsNone").addEventListener("click", () => {
      document.querySelectorAll('#setupSkillsList input[type="checkbox"]').forEach(cb => cb.checked = false);
    });

    document.getElementById("setupSkillsSave").addEventListener("click", async () => {
      const install = [];
      document.querySelectorAll('#setupSkillsList input[type="checkbox"]:checked').forEach(cb => install.push(cb.value));
      const btn = document.getElementById("setupSkillsSave");
      btn.disabled = true;
      btn.textContent = `Installing ${install.length} skills...`;
      try { await API.json("/api/skills/setup", { method: "POST", body: { install } }); } catch {}
      this.showPersonalityStep();
    });
  },

  /** Step 3: Personality interview OR skip */
  showPersonalityStep() {
    this.currentStep = 3;
    document.getElementById("setupContent").innerHTML = `
      ${this._progressBar(3)}
      <div class="setup-card-header">
        <h2>Set Up Personality</h2>
        <p style="color:var(--text-muted);font-size:13px">Have a quick chat to teach your agent who you are and how you like to communicate.</p>
      </div>
      <div class="setup-card-body">
        <div style="background:var(--bg-input);border-radius:8px;padding:16px;margin-bottom:16px">
          <p style="font-size:13px;color:var(--text-secondary);margin:0">The agent will ask you:</p>
          <ul style="font-size:13px;color:var(--text-muted);margin:8px 0 0 0;padding-left:20px">
            <li>What to call itself</li>
            <li>Your communication style</li>
            <li>What you'll use it for</li>
            <li>Personality preferences</li>
          </ul>
        </div>
        <button class="btn btn-primary" id="setupStartInterview" style="width:100%;padding:12px;font-size:14px;margin-bottom:10px">Start Personality Chat →</button>
        <button class="btn btn-ghost" id="setupSkipInterview" style="width:100%;padding:10px;font-size:13px;color:var(--text-muted)">Skip — use defaults</button>
      </div>
    `;

    document.getElementById("setupStartInterview").addEventListener("click", async () => {
      await API.json("/api/settings/general", { method: "POST", body: { key: "setup.completed", value: "true" } }).catch(() => {});
      App.bootApp();
      this.startPersonalityInterview();
    });

    document.getElementById("setupSkipInterview").addEventListener("click", async () => {
      await API.json("/api/settings/general", { method: "POST", body: { key: "setup.completed", value: "true" } }).catch(() => {});
      App.bootApp();
      this.showChannelSetup();
    });
  },

  /** Step 4: Channel setup (optional) */
  showChannelSetup() {
    this.currentStep = 4;

    // Show a toast-like overlay on the main UI
    const overlay = document.createElement("div");
    overlay.id = "setupChannelOverlay";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:300;display:flex;align-items:center;justify-content:center;padding:20px";
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border-radius:12px;padding:24px;max-width:420px;width:100%;border:1px solid var(--border)">
        ${this._progressBar(4)}
        <h2 style="font-size:18px;margin-bottom:4px">Connect Channels</h2>
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">Optional — talk to your agent from Telegram or Discord too.</p>

        <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:20px">
          <a href="https://t.me/BotFather" target="_blank" style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg-input);border-radius:8px;text-decoration:none;color:var(--text);border:1px solid var(--border)">
            <span style="font-size:24px">✈️</span>
            <div>
              <strong>Telegram</strong>
              <div style="font-size:11px;color:var(--text-muted)">Create a bot with @BotFather, paste the token in Settings > Channels</div>
            </div>
          </a>
          <a href="https://discord.com/developers/applications" target="_blank" style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg-input);border-radius:8px;text-decoration:none;color:var(--text);border:1px solid var(--border)">
            <span style="font-size:24px">🎮</span>
            <div>
              <strong>Discord</strong>
              <div style="font-size:11px;color:var(--text-muted)">Create a bot in Developer Portal, enable Message Content Intent</div>
            </div>
          </a>
        </div>

        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost" id="setupChannelSettings" style="flex:1;padding:10px">Open Settings</button>
          <button class="btn btn-primary" id="setupChannelDone" style="flex:1;padding:10px">Done — Start Chatting</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById("setupChannelSettings").addEventListener("click", () => {
      overlay.remove();
      Settings.open();
      Settings.switchTab("channels");
    });

    document.getElementById("setupChannelDone").addEventListener("click", () => {
      overlay.remove();
      this.showWelcomeTour();
    });
  },

  /** Welcome tour — highlight key UI elements */
  showWelcomeTour() {
    const tips = [
      { selector: "#voiceModeBtn", text: "Hold to talk — voice mode with speech-to-text", pos: "below" },
      { selector: "#consoleToggleBtn", text: "Server console — see what your agent is doing", pos: "below" },
      { selector: "#settingsBtn", text: "Settings — configure everything", pos: "above" },
      { selector: ".channel-list", text: "Your channels — web, Telegram, Discord", pos: "right" },
    ];

    let currentTip = 0;

    const showTip = () => {
      // Remove previous
      document.getElementById("welcomeTip")?.remove();

      if (currentTip >= tips.length) {
        // Tour done — send sample message
        this.sendSampleMessage();
        return;
      }

      const tip = tips[currentTip];
      const el = document.querySelector(tip.selector);
      if (!el) { currentTip++; showTip(); return; }

      const rect = el.getBoundingClientRect();
      const overlay = document.createElement("div");
      overlay.id = "welcomeTip";
      overlay.style.cssText = "position:fixed;inset:0;z-index:400;pointer-events:none";

      const tipEl = document.createElement("div");
      tipEl.style.cssText = `position:absolute;background:var(--accent);color:white;padding:10px 16px;border-radius:8px;font-size:13px;max-width:250px;pointer-events:auto;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.3)`;

      if (tip.pos === "below") {
        tipEl.style.top = (rect.bottom + 8) + "px";
        tipEl.style.left = Math.max(8, rect.left - 40) + "px";
      } else if (tip.pos === "above") {
        tipEl.style.bottom = (window.innerHeight - rect.top + 8) + "px";
        tipEl.style.left = Math.max(8, rect.left) + "px";
      } else {
        tipEl.style.top = rect.top + "px";
        tipEl.style.left = (rect.right + 8) + "px";
      }

      tipEl.innerHTML = `${tip.text}<div style="font-size:10px;margin-top:4px;opacity:0.7">Tap to continue (${currentTip + 1}/${tips.length})</div>`;
      tipEl.addEventListener("click", () => { currentTip++; showTip(); });

      overlay.appendChild(tipEl);
      document.body.appendChild(overlay);

      // Auto-advance after 4s
      setTimeout(() => { if (document.getElementById("welcomeTip")) { currentTip++; showTip(); } }, 4000);
    };

    showTip();
  },

  /** Send a sample first message so the UI isn't empty */
  sendSampleMessage() {
    setTimeout(() => {
      if (Chat.elements?.messageInput) {
        Chat.elements.messageInput.value = "Hey! I just finished setting you up. What can you do?";
        Chat.send();
      }
    }, 500);
  },

  /** Start the personality interview as the first conversation */
  async startPersonalityInterview() {
    this.isSetupConversation = true;
    this.personalityBuffer = "";

    let bootstrapContent = "";
    try {
      const bsData = await API.json("/api/settings/workspace-file?name=BOOTSTRAP.md");
      if (bsData.content && bsData.content.trim().length > 10) bootstrapContent = bsData.content;
    } catch {}

    const systemPrompt = bootstrapContent
      ? `${INTERVIEW_SYSTEM_PROMPT}\n\n--- BOOTSTRAP CONTEXT ---\n${bootstrapContent}`
      : INTERVIEW_SYSTEM_PROMPT;

    try {
      const conv = await API.createConversation({ title: "Getting to know you", systemPrompt });
      this.setupConversationId = conv.id;
      Chat.openChannel("web:default", conv.id);
      setTimeout(() => {
        Chat.elements.messageInput.value = "Hey! I just set you up. Let's get to know each other.";
        Chat.send();
      }, 500);
    } catch (err) {
      console.error("[setup] Failed to start interview:", err);
      App.showToast("Setup chat failed — configure personality in Settings", "error");
      this.isSetupConversation = false;
      this.showChannelSetup();
    }
  },

  handleStreamingText(fullText) {
    if (!this.isSetupConversation) return;
    this.personalityBuffer = fullText;
  },

  async handleStreamComplete(fullText) {
    if (!this.isSetupConversation) return;

    const marker = "|||PERSONALITY_COMPLETE|||";
    const markerIdx = fullText.indexOf(marker);
    if (markerIdx === -1) return;

    const jsonStr = fullText.slice(markerIdx + marker.length).trim();
    let identity = {};
    try {
      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) identity = JSON.parse(jsonMatch[0]);
    } catch {}

    const botName = identity.name || "Tarsee";
    const systemPrompt = identity.systemPrompt || identity.personality || "";

    try {
      await API.json("/api/settings/general", { method: "POST", body: { key: "identity.name", value: botName } });

      if (systemPrompt) {
        await API.json("/api/settings/workspace-file", { method: "PUT", body: { name: "SOUL.md", content: `# Soul & Personality\n\n${systemPrompt}\n` } });
        await API.json("/api/settings/general", { method: "POST", body: { key: "identity.systemPrompt", value: systemPrompt } });
      }

      if (identity.preferences && Array.isArray(identity.preferences)) {
        const prefLines = identity.preferences.map(p => `- ${p}`).join("\n");
        await API.json("/api/settings/workspace-file", { method: "PUT", body: { name: "USER.md", content: `# About the User\n\n${prefLines}\n` } });
      }

      try { await API.json("/api/settings/bootstrap", { method: "DELETE" }); } catch {}

      App.showToast(`Setup complete! I'm ${botName} now.`, "success");
      if (Chat.setBotName) Chat.setBotName(botName);
      if (this.setupConversationId) {
        await API.updateConversation(this.setupConversationId, { title: `Hello from ${botName}` });
        Chat.loadChannels();
      }
    } catch (err) {
      console.error("[setup] Failed to save identity:", err);
    }

    this.isSetupConversation = false;
    this.setupConversationId = null;

    // After interview, show channel setup
    this.showChannelSetup();
  },
};

const INTERVIEW_SYSTEM_PROMPT = `You are being set up for the first time by your new owner. Your job is to have a warm, brief conversation (3-5 exchanges) to learn who they want you to be.

Discover:
1. What they want to call you (suggest fun names, or let them pick)
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
  "systemPrompt": "A system prompt paragraph that captures the full personality. Write it as instructions to yourself.",
  "preferences": ["preference 1", "preference 2"]
}
\`\`\`

Start by greeting them warmly and asking what they'd like to call you.`;
