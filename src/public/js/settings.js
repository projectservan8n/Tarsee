/**
 * Settings page module — full-page tabbed layout with auto-save.
 */

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

const Settings = {
  elements: {},
  isOpen: false,
  _previousView: null, // track what was showing before settings opened

  init() {
    this.elements = {
      settingsPage: document.getElementById("settingsPage"),
      openBtn: document.getElementById("settingsBtn"),
      provider: document.getElementById("settingsProvider"),
      apiKey: document.getElementById("settingsApiKey"),
      model: document.getElementById("settingsModel"),
      baseUrl: document.getElementById("settingsBaseUrl"),
      baseUrlGroup: document.getElementById("customBaseUrlGroup"),
      saveProviderBtn: document.getElementById("saveProviderBtn"),
      discordToken: document.getElementById("settingsDiscordToken"),
      telegramToken: document.getElementById("settingsTelegramToken"),
      slackToken: document.getElementById("settingsSlackToken"),
      slackAppToken: document.getElementById("settingsSlackAppToken"),
      whatsappToken: document.getElementById("settingsWhatsappToken"),
      signalPhone: document.getElementById("settingsSignalPhone"),
      signalApiUrl: document.getElementById("settingsSignalApiUrl"),
      imessageUrl: document.getElementById("settingsImessageUrl"),
      imessagePassword: document.getElementById("settingsImessagePassword"),
      lineToken: document.getElementById("settingsLineToken"),
      saveChannelsBtn: document.getElementById("saveChannelsBtn"),
      apiToken: document.getElementById("settingsApiToken"),
      // Identity
      botName: document.getElementById("settingsBotName"),
      // Workspace files
      soulMd: document.getElementById("settingsSoulMd"),
      userMd: document.getElementById("settingsUserMd"),
      memoryMd: document.getElementById("settingsMemoryMd"),
      agentsMd: document.getElementById("settingsAgentsMd"),
      identityMd: document.getElementById("settingsIdentityMd"),
      toolsMd: document.getElementById("settingsToolsMd"),
      heartbeatMd: document.getElementById("settingsHeartbeatMd"),
      bootMd: document.getElementById("settingsBootMd"),
      // Memory
      memoriesList: document.getElementById("memoriesList"),
      memoryInput: document.getElementById("memoryInput"),
      addMemoryBtn: document.getElementById("addMemoryBtn"),
      // Auth profiles
      profilesList: document.getElementById("profilesList"),
      profileNameInput: document.getElementById("profileNameInput"),
      profileProviderInput: document.getElementById("profileProviderInput"),
      profileApiKeyInput: document.getElementById("profileApiKeyInput"),
      profileModelInput: document.getElementById("profileModelInput"),
      addProfileBtn: document.getElementById("addProfileBtn"),
      // Voice settings
      voiceEngine: document.getElementById("settingsVoiceEngine"),
      voiceEngineStatus: document.getElementById("voiceEngineStatus"),
      defaultVoice: document.getElementById("settingsDefaultVoice"),
      voiceCloneFile: document.getElementById("voiceOnnxFile"),
      voiceCloneUpload: document.getElementById("voiceCloneUpload"),
      voiceCloneName: document.getElementById("voiceCloneName"),
      voiceCloneBtn: document.getElementById("voiceCloneBtn"),
      voiceCloneResult: document.getElementById("voiceCloneResult"),
      voiceCloneInfo: document.getElementById("voiceCloneInfo"),
      voicesList: document.getElementById("voicesList"),
      saveVoiceBtn: document.getElementById("saveVoiceBtn"),
      // Cron jobs
      cronJobsList: document.getElementById("cronJobsList"),
      cronScheduleInput: document.getElementById("cronScheduleInput"),
      cronPromptInput: document.getElementById("cronPromptInput"),
      addCronBtn: document.getElementById("addCronBtn"),
      // Session reset
      resetMode: document.getElementById("settingsResetMode"),
      resetHour: document.getElementById("settingsResetHour"),
      resetIdle: document.getElementById("settingsResetIdle"),
      resetDailyGroup: document.getElementById("resetDailyGroup"),
      resetIdleGroup: document.getElementById("resetIdleGroup"),
      saveResetBtn: document.getElementById("saveResetBtn"),
      // Skills
      skillsList: document.getElementById("skillsList"),
      createSkillBtn: document.getElementById("createSkillBtn"),
      skillDialog: document.getElementById("skillDialog"),
      skillNameInput: document.getElementById("skillNameInput"),
      skillDescInput: document.getElementById("skillDescInput"),
      skillContentInput: document.getElementById("skillContentInput"),
      skillSaveBtn: document.getElementById("skillSaveBtn"),
      skillCancelBtn: document.getElementById("skillCancelBtn"),
      runAuditBtn: document.getElementById("runAuditBtn"),
    };

    // Toggle settings page open/close
    this.elements.openBtn.addEventListener("click", () => {
      if (this.isOpen) {
        this.close();
      } else {
        this.open();
      }
    });

    // Tab switching
    document.querySelectorAll(".settings-tab").forEach((tab) => {
      tab.addEventListener("click", () => this.switchTab(tab.dataset.tab));
    });

    // Provider change handler
    this.elements.provider.addEventListener("change", () => {
      const val = this.elements.provider.value;
      const showBaseUrl = val === "custom" || val === "ollama";
      this.elements.baseUrlGroup.style.display = showBaseUrl ? "block" : "none";

      // Show model presets for OpenRouter
      const presetsGroup = document.getElementById("modelPresetsGroup");
      if (presetsGroup) presetsGroup.style.display = val === "openrouter" ? "block" : "none";

      const defaults = {
        anthropic: "claude-sonnet-4-5-20250929",
        openai: "gpt-4o",
        gemini: "gemini-2.5-flash",
        openrouter: "anthropic/claude-sonnet-4-5",
        ollama: "gemma3:4b",
        custom: "",
      };
      this.elements.model.placeholder = defaults[val] || "";

      // Update hints per provider
      if (val === "ollama") {
        this.elements.apiKey.placeholder = "(optional — Ollama usually needs no key)";
        this.elements.baseUrl.placeholder = "https://your-tunnel.trycloudflare.com";
      } else if (val === "openrouter") {
        this.elements.apiKey.placeholder = "sk-or-...";
      } else {
        this.elements.apiKey.placeholder = "sk-...";
        this.elements.baseUrl.placeholder = "http://localhost:11434/v1";
      }
    });

    // Model preset selector (OpenRouter)
    const modelPresets = document.getElementById("modelPresets");
    if (modelPresets) {
      modelPresets.addEventListener("change", () => {
        if (modelPresets.value) {
          this.elements.model.value = modelPresets.value;
          modelPresets.selectedIndex = 0; // Reset to placeholder
        }
      });
    }

    this.elements.saveProviderBtn.addEventListener("click", () => this.saveProvider());
    this.elements.saveChannelsBtn.addEventListener("click", () => this.saveChannels());

    // Security handlers
    if (this.elements.runAuditBtn) {
      this.elements.runAuditBtn.addEventListener("click", () => this.loadSecurityAudit());
    }

    // --- Auto-save: Bot Name (debounced) ---
    if (this.elements.botName) {
      const autoSaveName = debounce(() => this.saveIdentity(), 1200);
      this.elements.botName.addEventListener("input", autoSaveName);
    }

    // --- Auto-save: Workspace Files (debounced 1.5s) ---
    const workspaceFiles = [
      ["SOUL.md", this.elements.soulMd, "statusSoulMd"],
      ["USER.md", this.elements.userMd, "statusUserMd"],
      ["MEMORY.md", this.elements.memoryMd, "statusMemoryMd"],
      ["AGENTS.md", this.elements.agentsMd, "statusAgentsMd"],
      ["IDENTITY.md", this.elements.identityMd, "statusIdentityMd"],
      ["TOOLS.md", this.elements.toolsMd, "statusToolsMd"],
      ["HEARTBEAT.md", this.elements.heartbeatMd, "statusHeartbeatMd"],
      ["BOOT.md", this.elements.bootMd, "statusBootMd"],
    ];

    for (const [name, el, statusId] of workspaceFiles) {
      if (!el) continue;
      const statusEl = document.getElementById(statusId);
      const autoSave = debounce(async () => {
        if (statusEl) { statusEl.textContent = "Saving..."; statusEl.className = "save-status saving"; }
        await this.saveWorkspaceFile(name, el.value, true);
        if (statusEl) { statusEl.textContent = "Saved"; statusEl.className = "save-status saved"; }
        setTimeout(() => { if (statusEl) { statusEl.textContent = ""; statusEl.className = "save-status"; } }, 2000);
      }, 1500);
      el.addEventListener("input", autoSave);
    }

    // Session reset handlers
    if (this.elements.resetMode) {
      this.elements.resetMode.addEventListener("change", () => {
        const mode = this.elements.resetMode.value;
        this.elements.resetDailyGroup.style.display = mode === "daily" ? "block" : "none";
        this.elements.resetIdleGroup.style.display = mode === "idle" ? "block" : "none";
      });
    }
    if (this.elements.saveResetBtn) {
      this.elements.saveResetBtn.addEventListener("click", () => this.saveSessionReset());
    }

    // Auth profile handlers
    if (this.elements.addProfileBtn) {
      this.elements.addProfileBtn.addEventListener("click", () => this.addProfile());
    }

    // Cron handlers
    if (this.elements.addCronBtn) {
      this.elements.addCronBtn.addEventListener("click", () => this.addCronJob());
    }

    // Memory handlers
    if (this.elements.addMemoryBtn) {
      this.elements.addMemoryBtn.addEventListener("click", () => this.addMemory());
      this.elements.memoryInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.addMemory();
      });
    }

    // Voice settings handlers — upload always clickable
    if (this.elements.voiceCloneUpload) {
      const dropZone = this.elements.voiceCloneUpload;

      dropZone.addEventListener("click", () => this.elements.voiceCloneFile.click());

      this.elements.voiceCloneFile.addEventListener("change", () => {
        const file = this.elements.voiceCloneFile.files[0];
        if (file) {
          dropZone.querySelector("p").textContent = file.name;
        }
      });

      dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("dragover");
      });
      dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
      dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("dragover");
        const file = e.dataTransfer.files[0];
        if (file && file.name.endsWith(".onnx")) {
          const dt = new DataTransfer();
          dt.items.add(file);
          this.elements.voiceCloneFile.files = dt.files;
          dropZone.querySelector("p").textContent = file.name;
        } else {
          App.showToast("Please drop an .onnx voice model file", "error");
        }
      });
    }

    if (this.elements.voiceCloneBtn) {
      this.elements.voiceCloneBtn.addEventListener("click", () => this.cloneVoice());
    }

    if (this.elements.saveVoiceBtn) {
      this.elements.saveVoiceBtn.addEventListener("click", () => this.saveVoiceSettings());
    }

    // Show/hide ElevenLabs key field based on engine selection
    if (this.elements.voiceEngine) {
      this.elements.voiceEngine.addEventListener("change", () => {
        const elGroup = document.getElementById("elevenlabsKeyGroup");
        if (elGroup) elGroup.style.display = this.elements.voiceEngine.value === "elevenlabs" ? "block" : "none";
      });
    }

    // Skills handlers
    if (this.elements.createSkillBtn) {
      this.elements.createSkillBtn.addEventListener("click", () => this.showSkillDialog());
    }
    if (this.elements.skillCancelBtn) {
      this.elements.skillCancelBtn.addEventListener("click", () => this.hideSkillDialog());
    }
    if (this.elements.skillSaveBtn) {
      this.elements.skillSaveBtn.addEventListener("click", () => this.saveSkill());
    }
  },

  // --- Tab Switching ---
  switchTab(tabName) {
    document.querySelectorAll(".settings-tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.tab === tabName);
    });
    document.querySelectorAll(".settings-tab-panel").forEach((p) => {
      p.classList.toggle("active", p.dataset.tab === tabName);
    });
    // Load data for new tabs
    if (tabName === "security") { this.loadToolPermissions(); }
    if (tabName === "canvas") { this.loadCanvasGallery(); }
  },

  // --- Open / Close ---
  async open() {
    this.isOpen = true;
    // Remember what was showing
    const welcome = document.getElementById("welcomeScreen");
    const chatArea = document.getElementById("chatArea");
    const inputArea = document.getElementById("inputArea");
    this._previousView = {
      welcome: welcome.style.display,
      chat: chatArea.style.display,
      input: inputArea.style.display,
    };

    // Hide chat/welcome, show settings
    welcome.style.display = "none";
    chatArea.style.display = "none";
    inputArea.style.display = "none";
    this.elements.settingsPage.classList.add("open");

    // Update topbar
    document.getElementById("topbarTitle").textContent = "Settings";

    // Highlight settings button
    this.elements.openBtn.style.color = "var(--primary)";

    await this.load();
  },

  close() {
    this.isOpen = false;
    this.elements.settingsPage.classList.remove("open");

    // Restore chat or welcome view based on active conversation
    const welcome = document.getElementById("welcomeScreen");
    const chatArea = document.getElementById("chatArea");
    const inputArea = document.getElementById("inputArea");

    if (typeof Chat !== "undefined" && Chat.currentConversationId) {
      // Has active conversation — show chat
      welcome.style.display = "none";
      chatArea.style.display = "flex";
      inputArea.style.display = "block";
    } else {
      // No conversation — show welcome
      welcome.style.display = "";
      chatArea.style.display = "none";
      inputArea.style.display = "block";
    }

    // Restore topbar title
    if (typeof Chat !== "undefined" && Chat.currentChannelKey) {
      const ch = Chat.channels.find((c) => c.key === Chat.currentChannelKey);
      if (ch) {
        const icon = { web: "\u{1F310}", discord: "\u{1F4AC}", telegram: "\u{2708}\uFE0F", slack: "\u{1F4BC}" };
        document.getElementById("topbarTitle").textContent = `${icon[ch.platform] || icon.web} ${ch.title}`;
      }
    } else {
      document.getElementById("topbarTitle").textContent = Chat?.botName || "Tarsee";
    }

    // Un-highlight settings button
    this.elements.openBtn.style.color = "var(--text-muted)";
  },

  async load() {
    try {
      const { settings } = await API.getSettings();

      // Provider
      const activeProvider = settings.find((s) => s.key === "ai.activeProvider")?.value;
      if (activeProvider) {
        this.elements.provider.value = activeProvider;
        this.elements.provider.dispatchEvent(new Event("change"));
        const model = settings.find((s) => s.key === `ai.${activeProvider}.model`)?.value;
        const apiKey = settings.find((s) => s.key === `ai.${activeProvider}.apiKey`)?.value;
        const baseUrl = settings.find((s) => s.key === `ai.${activeProvider}.baseUrl`)?.value;
        if (model) this.elements.model.value = model;
        if (apiKey) this.elements.apiKey.value = apiKey;
        if (baseUrl) this.elements.baseUrl.value = baseUrl;
      }

      // Channels
      for (const type of ["discord", "telegram"]) {
        const config = settings.find((s) => s.key === `channel.${type}`)?.value;
        if (config?.token) {
          const el = type === "discord" ? this.elements.discordToken : this.elements.telegramToken;
          el.value = config.token;
        }
      }
      const slackConfig = settings.find((s) => s.key === "channel.slack")?.value;
      if (slackConfig?.token) this.elements.slackToken.value = slackConfig.token;
      if (slackConfig?.appToken) this.elements.slackAppToken.value = slackConfig.appToken;

      // API token
      if (API.token) this.elements.apiToken.value = API.token;

      // Identity
      const botName = settings.find((s) => s.key === "identity.name")?.value;
      if (botName && this.elements.botName) this.elements.botName.value = botName;

      // Voice engine
      const voiceEngine = settings.find((s) => s.key === "voice.engine")?.value;
      if (voiceEngine && this.elements.voiceEngine) {
        this.elements.voiceEngine.value = voiceEngine;
      }
      // Show ElevenLabs key field if engine is elevenlabs
      const elGroup = document.getElementById("elevenlabsKeyGroup");
      if (elGroup) elGroup.style.display = voiceEngine === "elevenlabs" ? "block" : "none";

      // Default voice
      const defaultVoiceId = settings.find((s) => s.key === "voice.defaultVoiceId")?.value;
      if (defaultVoiceId) {
        localStorage.setItem("voice.defaultVoiceId", defaultVoiceId);
      }

      // Load all sub-sections
      this.loadWorkspaceFiles();
      this.loadSessionReset();
      this.loadCronJobs();
      this.loadProfiles();
      this.loadVoiceStatus();
      this.loadVoices();
      this.loadSkills();
      this.loadMemories();
    } catch (err) {
      App.showToast("Failed to load settings: " + err.message, "error");
    }
  },

  async saveProvider() {
    const provider = this.elements.provider.value;
    if (!provider) {
      App.showToast("Select a provider", "error");
      return;
    }
    try {
      await API.saveProvider({
        provider,
        apiKey: this.elements.apiKey.value.trim() || undefined,
        model: this.elements.model.value.trim() || undefined,
        baseUrl: this.elements.baseUrl.value.trim() || undefined,
      });
      App.showToast("Provider saved", "success");
    } catch (err) {
      App.showToast(err.message, "error");
    }
  },

  async saveChannels() {
    try {
      const discord = this.elements.discordToken.value.trim();
      const telegram = this.elements.telegramToken.value.trim();
      const slackBot = this.elements.slackToken.value.trim();
      const slackApp = this.elements.slackAppToken.value.trim();

      if (discord) await API.saveChannel({ type: "discord", token: discord, enabled: true });
      if (telegram) await API.saveChannel({ type: "telegram", token: telegram, enabled: true });
      if (slackBot && slackApp) await API.saveChannel({ type: "slack", token: slackBot, appToken: slackApp, enabled: true });

      // New channels
      const wa = this.elements.whatsappToken?.value?.trim();
      if (wa) await API.saveChannel({ type: "whatsapp", token: wa, enabled: true });
      const sigPhone = this.elements.signalPhone?.value?.trim();
      const sigUrl = this.elements.signalApiUrl?.value?.trim();
      if (sigPhone) await API.saveChannel({ type: "signal", token: sigPhone, phoneNumber: sigPhone, apiUrl: sigUrl || "http://localhost:8080", enabled: true });
      const imUrl = this.elements.imessageUrl?.value?.trim();
      const imPass = this.elements.imessagePassword?.value?.trim();
      if (imUrl) await API.saveChannel({ type: "imessage", token: imUrl, serverUrl: imUrl, password: imPass, enabled: true });
      const lineT = this.elements.lineToken?.value?.trim();
      if (lineT) await API.saveChannel({ type: "line", token: lineT, enabled: true });

      App.showToast("Channels saved. Restart channels in Admin to apply.", "success");
    } catch (err) {
      App.showToast(err.message, "error");
    }
  },

  async loadVoiceStatus() {
    if (!this.elements.voiceEngineStatus) return;
    try {
      const res = await API.request("/api/voice/status");
      const data = await res.json();
      const engine = data.engine || "stub";
      const isActive = engine !== "stub" && engine !== "none";
      const status = isActive ? `Engine: ${engine}` : "No TTS engine active";
      this.elements.voiceEngineStatus.textContent = status;
      this.elements.voiceEngineStatus.style.color = isActive ? "var(--primary)" : "var(--text-muted)";

      // Show info message when no engine (but keep upload clickable!)
      if (this.elements.voiceCloneInfo) {
        this.elements.voiceCloneInfo.style.display = isActive ? "none" : "block";
      }
      if (this.elements.voiceCloneBtn) {
        this.elements.voiceCloneBtn.disabled = !isActive;
        if (!isActive) {
          this.elements.voiceCloneBtn.title = "Enable a TTS engine first";
        }
      }
      // Keep upload area always clickable (no pointerEvents: "none")
      if (this.elements.voiceCloneUpload) {
        this.elements.voiceCloneUpload.style.opacity = isActive ? "1" : "0.6";
      }
    } catch {
      this.elements.voiceEngineStatus.textContent = "Could not load voice status";
    }
  },

  async loadVoices() {
    if (!this.elements.voicesList) return;
    try {
      const res = await API.request("/api/voice/voices");
      const data = await res.json();
      const voices = data.voices || [];

      if (voices.length === 0) {
        this.elements.voicesList.innerHTML =
          '<div style="color: var(--text-muted); font-size: 13px">No cloned voices yet</div>';
      } else {
        this.elements.voicesList.innerHTML = voices
          .map((v) =>
            `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px">
              <span style="flex:1">${v.name || v.id}</span>
              ${v.isClone ? '<span style="color:var(--primary);font-size:11px">cloned</span>' : ""}
            </div>`
          )
          .join("");
      }

      // Populate default voice dropdown
      if (this.elements.defaultVoice) {
        const current = this.elements.defaultVoice.value;
        this.elements.defaultVoice.innerHTML = '<option value="">Engine default</option>';
        for (const v of voices) {
          const opt = document.createElement("option");
          opt.value = v.id;
          opt.textContent = v.name || v.id;
          if (v.isClone) opt.textContent += " (cloned)";
          this.elements.defaultVoice.appendChild(opt);
        }
        // Restore saved selection
        const saved = localStorage.getItem("voice.defaultVoiceId");
        if (saved) this.elements.defaultVoice.value = saved;
        else if (current) this.elements.defaultVoice.value = current;
      }
    } catch {
      this.elements.voicesList.innerHTML = "";
    }
  },

  async cloneVoice() {
    // Upload ONNX voice model
    const onnxFile = document.getElementById("voiceOnnxFile")?.files[0];
    const jsonFile = document.getElementById("voiceOnnxJson")?.files[0];
    const name = this.elements.voiceCloneName?.value.trim();

    if (!onnxFile) {
      App.showToast("Select an .onnx voice model file", "error");
      return;
    }
    if (!name) {
      App.showToast("Enter a name for the voice", "error");
      return;
    }

    this.elements.voiceCloneBtn.disabled = true;
    this.elements.voiceCloneBtn.textContent = "Uploading...";
    this.elements.voiceCloneResult.textContent = "";

    try {
      const formData = new FormData();
      formData.append("onnx", onnxFile);
      if (jsonFile) formData.append("config", jsonFile);
      formData.append("name", name);

      const res = await API.request("/api/voice/upload-model", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Upload failed" }));
        throw new Error(err.error || "Upload failed");
      }

      const data = await res.json();
      this.elements.voiceCloneResult.innerHTML =
        `<span style="color: var(--primary)">Voice "${data.name}" installed (${data.voiceId})</span>`;
      this.elements.voiceCloneName.value = "";
      document.getElementById("voiceOnnxFile").value = "";
      if (document.getElementById("voiceOnnxJson")) document.getElementById("voiceOnnxJson").value = "";
      this.elements.voiceCloneUpload.querySelector("p").textContent =
        "Drop .onnx voice model file here or click to upload";

      this.loadVoices();
      App.showToast("Voice cloned successfully", "success");
    } catch (err) {
      this.elements.voiceCloneResult.innerHTML =
        `<span style="color: #e74c3c">${err.message}</span>`;
      App.showToast(err.message, "error");
    } finally {
      this.elements.voiceCloneBtn.disabled = false;
      this.elements.voiceCloneBtn.textContent = "Clone Voice";
    }
  },

  async saveVoiceSettings() {
    const engine = this.elements.voiceEngine?.value;
    if (!engine) return;
    try {
      await API.json("/api/settings/general", {
        method: "POST",
        body: { key: "voice.engine", value: engine },
      });

      // Save ElevenLabs key if provided
      const elKey = document.getElementById("settingsElevenlabsKey")?.value.trim();
      if (elKey && engine === "elevenlabs") {
        await API.json("/api/settings/general", {
          method: "POST",
          body: { key: "voice.elevenlabs.apiKey", value: elKey },
        });
      }

      // Save default voice selection
      const defaultVoiceId = this.elements.defaultVoice?.value || "";
      localStorage.setItem("voice.defaultVoiceId", defaultVoiceId);
      await API.json("/api/settings/general", {
        method: "POST",
        body: { key: "voice.defaultVoiceId", value: defaultVoiceId },
      });

      App.showToast("Voice settings saved and applied.", "success");
      // Refresh status to show the new engine
      this.loadVoiceStatus();
    } catch (err) {
      App.showToast(err.message, "error");
    }
  },

  // --- Identity (auto-saved) ---
  async saveIdentity() {
    const name = this.elements.botName?.value.trim() || "Tarsee";
    try {
      await API.json("/api/settings/general", {
        method: "POST",
        body: { key: "identity.name", value: name },
      });
      if (typeof Chat !== "undefined" && Chat.setBotName) Chat.setBotName(name);
    } catch {
      // silent — auto-save
    }
  },

  // --- Workspace Files ---
  async loadWorkspaceFiles() {
    for (const [name, el] of [
      ["SOUL.md", this.elements.soulMd],
      ["USER.md", this.elements.userMd],
      ["MEMORY.md", this.elements.memoryMd],
      ["AGENTS.md", this.elements.agentsMd],
      ["IDENTITY.md", this.elements.identityMd],
      ["TOOLS.md", this.elements.toolsMd],
      ["HEARTBEAT.md", this.elements.heartbeatMd],
      ["BOOT.md", this.elements.bootMd],
    ]) {
      if (!el) continue;
      try {
        const data = await API.json(`/api/settings/workspace-file?name=${name}`);
        el.value = data.content || "";
      } catch {
        // ignore
      }
    }
  },

  async saveWorkspaceFile(name, content, silent = false) {
    try {
      await API.json("/api/settings/workspace-file", {
        method: "PUT",
        body: { name, content },
      });
      if (!silent) App.showToast(`${name} saved`, "success");
    } catch (err) {
      if (!silent) App.showToast(err.message, "error");
    }
  },

  // --- Session Reset ---
  async loadSessionReset() {
    try {
      const data = await API.json("/api/settings/session-reset");
      if (this.elements.resetMode) {
        this.elements.resetMode.value = data.mode || "manual";
        this.elements.resetMode.dispatchEvent(new Event("change"));
      }
      if (this.elements.resetHour) this.elements.resetHour.value = data.atHour || 0;
      if (this.elements.resetIdle) this.elements.resetIdle.value = data.idleMinutes || 60;
    } catch {
      // ignore
    }
  },

  async saveSessionReset() {
    try {
      await API.json("/api/settings/session-reset", {
        method: "POST",
        body: {
          mode: this.elements.resetMode?.value || "manual",
          atHour: Number(this.elements.resetHour?.value) || 0,
          idleMinutes: Number(this.elements.resetIdle?.value) || 60,
        },
      });
      App.showToast("Session reset config saved", "success");
    } catch (err) {
      App.showToast(err.message, "error");
    }
  },

  // --- Auth Profiles ---
  async loadProfiles() {
    if (!this.elements.profilesList) return;
    try {
      const data = await API.json("/api/settings/profiles");
      const profiles = data.profiles || [];

      if (profiles.length === 0) {
        this.elements.profilesList.innerHTML =
          '<div style="color: var(--text-muted); font-size: 13px">No auth profiles. Add one below for multi-key rotation.</div>';
        return;
      }

      this.elements.profilesList.innerHTML = profiles.map((p) => {
        const status = p.inCooldown ? `cooldown (${p.cooldownReason || "error"})` : p.enabled ? "active" : "disabled";
        const statusColor = p.inCooldown ? "color:#fbbf24" : p.enabled ? "" : "color:var(--text-muted)";
        return `<div class="memory-item">
          <span class="memory-badge" style="${statusColor}">${status}</span>
          <span class="memory-content">
            <strong>${escapeHtml(p.name)}</strong> (${p.provider}) ${p.apiKeyHint || ""}
            ${p.stats.requests > 0 ? `<span style="color:var(--text-muted);font-size:11px"> — ${p.stats.requests} reqs, ${p.stats.errors} errs</span>` : ""}
          </span>
          <button class="memory-delete" data-profile-id="${p.id}" title="Delete">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>`;
      }).join("");

      this.elements.profilesList.querySelectorAll("[data-profile-id]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            await API.json(`/api/settings/profiles/${btn.dataset.profileId}`, { method: "DELETE" });
            this.loadProfiles();
            App.showToast("Profile removed", "success");
          } catch (err) {
            App.showToast(err.message, "error");
          }
        });
      });
    } catch {
      this.elements.profilesList.innerHTML = "";
    }
  },

  async addProfile() {
    const name = this.elements.profileNameInput?.value.trim();
    const provider = this.elements.profileProviderInput?.value;
    const apiKey = this.elements.profileApiKeyInput?.value.trim();
    const model = this.elements.profileModelInput?.value.trim();

    if (!name || !provider || !apiKey) {
      App.showToast("Name, provider, and API key are required", "error");
      return;
    }
    try {
      await API.json("/api/settings/profiles", {
        method: "POST",
        body: { name, provider, apiKey, model: model || undefined },
      });
      this.elements.profileNameInput.value = "";
      this.elements.profileApiKeyInput.value = "";
      this.elements.profileModelInput.value = "";
      this.loadProfiles();
      App.showToast("Auth profile added", "success");
    } catch (err) {
      App.showToast(err.message, "error");
    }
  },

  // --- Cron Jobs ---
  async loadCronJobs() {
    if (!this.elements.cronJobsList) return;
    try {
      const data = await API.json("/api/settings/cron");
      const jobs = data.jobs || [];

      if (jobs.length === 0) {
        this.elements.cronJobsList.innerHTML =
          '<div style="color: var(--text-muted); font-size: 13px">No cron jobs. Add one below or use <code>/cron add</code> in chat.</div>';
        return;
      }

      this.elements.cronJobsList.innerHTML = jobs.map((j) =>
        `<div class="memory-item">
          <span class="memory-badge">${j.running ? "running" : j.enabled ? "enabled" : "off"}</span>
          <span class="memory-content"><code>${j.schedule}</code> — ${escapeHtml(j.prompt.slice(0, 60))}</span>
          <button class="memory-delete" data-cron-id="${j.id}" title="Delete">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>`
      ).join("");

      this.elements.cronJobsList.querySelectorAll("[data-cron-id]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            await API.json(`/api/settings/cron/${btn.dataset.cronId}`, { method: "DELETE" });
            this.loadCronJobs();
            App.showToast("Cron job removed", "success");
          } catch (err) {
            App.showToast(err.message, "error");
          }
        });
      });
    } catch {
      this.elements.cronJobsList.innerHTML = "";
    }
  },

  async addCronJob() {
    const schedule = this.elements.cronScheduleInput?.value.trim();
    const prompt = this.elements.cronPromptInput?.value.trim();
    if (!schedule || !prompt) {
      App.showToast("Schedule and prompt are required", "error");
      return;
    }
    try {
      await API.json("/api/settings/cron", {
        method: "POST",
        body: { schedule, prompt },
      });
      this.elements.cronScheduleInput.value = "";
      this.elements.cronPromptInput.value = "";
      this.loadCronJobs();
      App.showToast("Cron job added", "success");
    } catch (err) {
      App.showToast(err.message, "error");
    }
  },

  // --- Memories ---
  async loadMemories() {
    if (!this.elements.memoriesList) return;
    try {
      const data = await API.json("/api/memory?limit=50");
      const memories = data.memories || [];

      if (memories.length === 0) {
        this.elements.memoriesList.innerHTML =
          '<div style="color: var(--text-muted); font-size: 13px">No memories yet. The bot will learn over time.</div>';
        return;
      }

      this.elements.memoriesList.innerHTML = memories.map((m) =>
        `<div class="memory-item">
          <span class="memory-badge">${m.category}</span>
          <span class="memory-content">${m.content}</span>
          <button class="memory-delete" data-memory-id="${m.id}" title="Delete">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </button>
        </div>`
      ).join("");

      this.elements.memoriesList.querySelectorAll("[data-memory-id]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          try {
            await API.json(`/api/memory/${btn.dataset.memoryId}`, { method: "DELETE" });
            this.loadMemories();
          } catch (err) {
            App.showToast(err.message, "error");
          }
        });
      });
    } catch {
      this.elements.memoriesList.innerHTML = "";
    }
  },

  async addMemory() {
    const text = this.elements.memoryInput?.value.trim();
    if (!text) return;

    try {
      await API.json("/api/memory", {
        method: "POST",
        body: { content: text, category: "manual" },
      });
      this.elements.memoryInput.value = "";
      this.loadMemories();
      App.showToast("Memory added", "success");
    } catch (err) {
      App.showToast(err.message, "error");
    }
  },

  // --- Skills ---
  _editingSkill: null,

  async loadSkills() {
    if (!this.elements.skillsList) return;
    try {
      const res = await API.request("/api/skills");
      const data = await res.json();
      const skills = data.skills || [];

      if (skills.length === 0) {
        this.elements.skillsList.innerHTML =
          '<div style="color: var(--text-muted); font-size: 13px">No skills yet. Create one to give the AI specialized instructions.</div>';
        return;
      }

      this.elements.skillsList.innerHTML = skills.map((s) =>
        `<div class="skill-card">
          <div style="display: flex; justify-content: space-between; align-items: center">
            <div>
              <strong>${escapeHtml(s.name)}</strong>
              <span class="memory-badge">${s.source}</span>
            </div>
            <div style="display: flex; gap: 4px">
              ${s.source === "custom" ? `
                <button class="btn btn-sm" data-skill-edit="${s.name}">Edit</button>
                <button class="btn btn-sm" style="color: var(--danger)" data-skill-delete="${s.name}">Delete</button>
              ` : `
                <button class="btn btn-sm" data-skill-view="${s.name}">View</button>
              `}
            </div>
          </div>
          <div style="font-size: 13px; color: var(--text-muted); margin-top: 4px">${escapeHtml(s.description)}</div>
        </div>`
      ).join("");

      this.elements.skillsList.querySelectorAll("[data-skill-edit]").forEach((btn) => {
        btn.addEventListener("click", () => this.editSkill(btn.dataset.skillEdit));
      });
      this.elements.skillsList.querySelectorAll("[data-skill-delete]").forEach((btn) => {
        btn.addEventListener("click", () => this.deleteSkill(btn.dataset.skillDelete));
      });
      this.elements.skillsList.querySelectorAll("[data-skill-view]").forEach((btn) => {
        btn.addEventListener("click", () => this.viewSkill(btn.dataset.skillView));
      });
    } catch {
      this.elements.skillsList.innerHTML = "";
    }
  },

  showSkillDialog(name, desc, content) {
    this._editingSkill = name || null;
    this.elements.skillNameInput.value = name || "";
    this.elements.skillDescInput.value = desc || "";
    this.elements.skillContentInput.value = content || "";
    this.elements.skillNameInput.disabled = !!name;
    this.elements.skillDescInput.disabled = false;
    this.elements.skillContentInput.disabled = false;
    this.elements.skillSaveBtn.style.display = "";
    this.elements.skillDialog.style.display = "block";
    (name ? this.elements.skillContentInput : this.elements.skillNameInput).focus();
  },

  hideSkillDialog() {
    this._editingSkill = null;
    this.elements.skillDialog.style.display = "none";
  },

  async editSkill(name) {
    try {
      const res = await API.request(`/api/skills/${encodeURIComponent(name)}`);
      const data = await res.json();
      this.showSkillDialog(name, data.description, data.content);
    } catch (err) {
      App.showToast(err.message, "error");
    }
  },

  async viewSkill(name) {
    try {
      const res = await API.request(`/api/skills/${encodeURIComponent(name)}`);
      const data = await res.json();
      this.showSkillDialog(name, data.description, data.content);
      this.elements.skillContentInput.disabled = true;
      this.elements.skillDescInput.disabled = true;
      this.elements.skillSaveBtn.style.display = "none";
    } catch (err) {
      App.showToast(err.message, "error");
    }
  },

  async saveSkill() {
    const name = this.elements.skillNameInput.value.trim();
    const description = this.elements.skillDescInput.value.trim();
    const content = this.elements.skillContentInput.value.trim();

    if (!name || !content) {
      App.showToast("Name and content are required", "error");
      return;
    }

    try {
      if (this._editingSkill) {
        await API.request(`/api/skills/${encodeURIComponent(name)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ description, content }),
        });
        App.showToast("Skill updated", "success");
      } else {
        const res = await API.request("/api/skills", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, description, content }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({ error: "Failed" }));
          throw new Error(err.error);
        }
        App.showToast("Skill created", "success");
      }

      this.hideSkillDialog();
      this.loadSkills();
    } catch (err) {
      App.showToast(err.message, "error");
    }
  },

  async deleteSkill(name) {
    if (!confirm(`Delete skill "${name}"?`)) return;
    try {
      await API.request(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
      this.loadSkills();
      App.showToast("Skill deleted", "success");
    } catch (err) {
      App.showToast(err.message, "error");
    }
  },

  async loadSecurityAudit() {
    try {
      const data = await API.json("/api/admin/security-audit");
      const el = document.getElementById("auditResults");
      if (!el) return;
      if (data.issues && data.issues.length > 0) {
        el.innerHTML = data.issues.map(i => {
          const bg = i.severity === "critical" ? "rgba(255,50,50,0.15)" : i.severity === "warning" ? "rgba(255,165,0,0.15)" : "rgba(100,200,100,0.1)";
          return '<div style="padding:8px;margin-bottom:6px;border-radius:6px;font-size:13px;background:' + bg + '">' +
            '<strong>' + i.severity.toUpperCase() + '</strong>: ' + i.message +
            '<br><span style="color:var(--text-muted);font-size:12px">Fix: ' + i.fix + '</span></div>';
        }).join("");
      } else {
        el.innerHTML = '<div style="color:#22c55e;font-size:13px">All checks passed!</div>';
      }
    } catch(err) { App.showToast("Audit failed: " + err.message, "error"); }
  },

  async loadToolPermissions() {
    try {
      const data = await API.json("/api/admin/tool-permissions");
      const el = document.getElementById("toolPermissionsList");
      if (!el) return;
      const tools = ["read_file","write_file","edit_file","exec","web_fetch","web_search","browser","spawn_agent","send_message","generate_image","analyze_image","create_canvas","schedule_task","pdf_read","remember","search_memories"];
      const perms = data.permissions || {};
      el.innerHTML = tools.map(function(t) {
        var mode = perms[t] || "always_allow";
        return '<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-light);font-size:13px">' +
          '<code>' + t + '</code>' +
          '<select data-tool="' + t + '" class="tool-perm-select" style="font-size:12px;padding:2px 6px;background:var(--bg-raised);color:var(--text);border:1px solid var(--border-light);border-radius:4px">' +
          '<option value="always_allow"' + (mode==="always_allow"?" selected":"") + '>Allow</option>' +
          '<option value="warn"' + (mode==="warn"?" selected":"") + '>Warn</option>' +
          '<option value="always_deny"' + (mode==="always_deny"?" selected":"") + '>Deny</option>' +
          '</select></div>';
      }).join("");
      el.querySelectorAll(".tool-perm-select").forEach(function(sel) {
        sel.addEventListener("change", async function() {
          await API.json("/api/admin/tool-permissions", { method: "POST", body: { toolName: sel.dataset.tool, mode: sel.value }});
          App.showToast("Permission updated", "success");
        });
      });
    } catch(err) { console.warn("Tool permissions error:", err); }
  },

  async loadCanvasGallery() {
    var gallery = document.getElementById("canvasGallery");
    var empty = document.getElementById("canvasEmpty");
    if (!gallery) return;
    gallery.innerHTML = '<a href="/canvas/" target="_blank" class="btn btn-sm" style="margin-bottom:8px">Open Canvas Gallery</a>';
    if (empty) empty.style.display = "none";
  },
};
