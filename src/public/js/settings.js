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
      // Close sidebar on mobile
      const sidebar = document.getElementById("sidebar");
      const overlay = document.getElementById("sidebarOverlay");
      if (sidebar) sidebar.classList.remove("open");
      if (overlay) overlay.classList.remove("active");

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

    // Provider is always claude-code — no change handler needed
    this.elements.provider.value = "claude-code";

    this.elements.saveProviderBtn.addEventListener("click", () => this.saveProvider());
    this.elements.saveChannelsBtn.addEventListener("click", () => this.saveChannels());
    document.getElementById("saveAllowlistBtn")?.addEventListener("click", () => this.saveAllowlist());

    // Security handlers
    if (this.elements.runAuditBtn) {
      this.elements.runAuditBtn.addEventListener("click", () => this.loadSecurityAudit());
    }

    // Captcha solver settings
    const saveCaptchaBtn = document.getElementById("saveCaptchaBtn");
    if (saveCaptchaBtn) {
      saveCaptchaBtn.addEventListener("click", async () => {
        const service = document.getElementById("captchaService").value;
        const apiKey = document.getElementById("captchaApiKey").value.trim();
        try {
          await API.json("/api/settings", { method: "POST", body: { key: "captcha.service", value: service } });
          await API.json("/api/settings", { method: "POST", body: { key: "captcha.api_key", value: apiKey } });
          App.showToast("Captcha settings saved", "success");
        } catch { App.showToast("Failed to save", "error"); }
      });
      // Load existing values
      API.json("/api/settings").then(data => {
        const settings = data.settings || [];
        const svc = settings.find(s => s.key === "captcha.service")?.value;
        const key = settings.find(s => s.key === "captcha.api_key")?.value;
        if (svc) document.getElementById("captchaService").value = svc;
        if (key) document.getElementById("captchaApiKey").value = key;
      }).catch(() => {});
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

    // STT model save
    const saveSTTBtn = document.getElementById("saveSTTBtn");
    if (saveSTTBtn) {
      saveSTTBtn.addEventListener("click", async () => {
        const model = document.getElementById("settingsSTTModel").value;
        try {
          await API.json("/api/voice/stt-model", { method: "POST", body: { model } });
          App.showToast(`STT model set to ${model}`, "success");
          this.loadSTTModelStatus();
        } catch (e) { App.showToast(e.message, "error"); }
      });
      this.loadSTTModelStatus();
    }

    // Show/hide ElevenLabs key field based on engine selection
    if (this.elements.voiceEngine) {
      this.elements.voiceEngine.addEventListener("change", () => {
        const val = this.elements.voiceEngine.value;
        const elGroup = document.getElementById("elevenlabsKeyGroup");
        if (elGroup) elGroup.style.display = val === "elevenlabs" ? "block" : "none";
        // Reload voices for the selected engine
        this.loadVoicesForEngine(val);
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
    if (tabName === "audit") { this.loadAuditLog(); }
    if (tabName === "usage") { this.loadUsageChart(); }
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
    this.elements.openBtn.classList.add("settings-active");

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
    this.elements.openBtn.classList.remove("settings-active");
  },

  async load() {
    try {
      const { settings } = await API.getSettings();

      // Provider (always claude-code)
      this.elements.provider.value = "claude-code";
      const model = settings.find((s) => s.key === "ai.claude-code.model")?.value;
      if (model) this.elements.model.value = model;

      // Channels
      for (const type of ["discord", "telegram"]) {
        const config = settings.find((s) => s.key === `channel.${type}`)?.value;
        if (config?.token) {
          const el = type === "discord" ? this.elements.discordToken : this.elements.telegramToken;
          el.value = config.token;
        }
      }

      // Allowlists
      const telegramAllow = settings.find((s) => s.key === "allowlist.telegram")?.value;
      const discordAllow = settings.find((s) => s.key === "allowlist.discord")?.value;
      const slackAllow = settings.find((s) => s.key === "allowlist.slack")?.value;
      if (telegramAllow) document.getElementById("settingsTelegramAllowlist").value = Array.isArray(telegramAllow) ? telegramAllow.join("\n") : telegramAllow;
      if (discordAllow) document.getElementById("settingsDiscordAllowlist").value = Array.isArray(discordAllow) ? discordAllow.join("\n") : discordAllow;
      if (slackAllow) document.getElementById("settingsSlackAllowlist").value = Array.isArray(slackAllow) ? slackAllow.join("\n") : slackAllow;

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
      this.loadVoiceStatus();
      this.loadVoices();
      this.loadSkills();
      this.loadMemories();
    } catch (err) {
      App.showToast("Failed to load settings: " + err.message, "error");
    }
  },

  async saveProvider() {
    try {
      await API.saveProvider({
        provider: "claude-code",
        model: this.elements.model.value || "claude-sonnet-4-6",
      });
      App.showToast("Model saved", "success");
    } catch (err) {
      App.showToast(err.message, "error");
    }
  },

  async saveChannels() {
    try {
      const discord = this.elements.discordToken.value.trim();
      const telegram = this.elements.telegramToken.value.trim();
      if (telegram) await API.saveChannel({ type: "telegram", token: telegram, enabled: true });
      if (discord) await API.saveChannel({ type: "discord", token: discord, enabled: true });

      App.showToast("Channels saved. Restart to apply.", "success");
    } catch (err) {
      App.showToast(err.message, "error");
    }
  },

  async saveAllowlist() {
    try {
      const parse = (id) => (document.getElementById(id)?.value || "").split("\n").map(s => s.trim()).filter(Boolean);
      await API.json("/api/settings/general", { method: "POST", body: { key: "allowlist.telegram", value: JSON.stringify(parse("settingsTelegramAllowlist")) } });
      await API.json("/api/settings/general", { method: "POST", body: { key: "allowlist.discord", value: JSON.stringify(parse("settingsDiscordAllowlist")) } });
      App.showToast("Allowlist saved", "success");
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
      this.elements.voiceEngineStatus.classList.toggle("active", isActive);

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
        this.elements.voiceCloneUpload.classList.toggle("inactive", !isActive);
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

  /** Load voices for a specific engine and populate the dropdown with hardcoded defaults. */
  loadVoicesForEngine(engine) {
    if (!this.elements.defaultVoice) return;
    const voiceMap = {
      "elevenlabs": [
        { id: "wNl2YBRc8v5uIcq6gOxd", name: "Kuya Kaf" },
        { id: "21m00Tcm4TlvDq8ikWAM", name: "Rachel" },
        { id: "EXAVITQu4vr4xnSDxMaL", name: "Bella" },
        { id: "ErXwobaYiN019PkySvjV", name: "Antoni" },
        { id: "MF3mGyEYCl7XYWbV9V6O", name: "Elli" },
      ],
      "edge-tts": [
        { id: "en-US-AndrewMultilingualNeural", name: "Andrew (US)" },
        { id: "en-US-AvaMultilingualNeural", name: "Ava (US)" },
        { id: "en-US-BrianMultilingualNeural", name: "Brian (US)" },
        { id: "en-GB-SoniaNeural", name: "Sonia (UK)" },
        { id: "en-AU-NatashaNeural", name: "Natasha (AU)" },
        { id: "en-PH-JamesNeural", name: "James (PH)" },
      ],
    };

    const voices = voiceMap[engine] || [];
    this.elements.defaultVoice.innerHTML = '<option value="">Engine default</option>';
    for (const v of voices) {
      const opt = document.createElement("option");
      opt.value = v.id;
      opt.textContent = v.name;
      this.elements.defaultVoice.appendChild(opt);
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

  async loadSTTModelStatus() {
    const status = document.getElementById("sttModelStatus");
    const select = document.getElementById("settingsSTTModel");
    if (!status) return;
    try {
      const data = await API.json("/api/voice/stt-models");
      if (select && data.current) select.value = data.current;
      const lines = (data.models || []).map(m => {
        const dl = m.downloaded ? "downloaded" : "not downloaded";
        return `${m.name} (${m.sizeMB}MB) — ${dl}`;
      });
      status.textContent = lines.join(" · ");
    } catch { status.textContent = "Could not check STT models."; }
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
      // Fetch both skills list and install status
      const [skillsRes, statusRes] = await Promise.all([
        API.request("/api/skills").then(r => r.json()),
        API.json("/api/settings/skills-status").catch(() => ({ skills: [] })),
      ]);
      const skills = skillsRes.skills || [];
      const statusMap = {};
      for (const s of (statusRes.skills || [])) statusMap[s.name] = s;

      if (skills.length === 0) {
        this.elements.skillsList.innerHTML =
          '<div style="color: var(--text-muted); font-size: 13px">No skills yet. Create one to give the AI specialized instructions.</div>';
        return;
      }

      const customSkills = skills.filter(s => s.source === "custom");
      const builtinSkills = skills.filter(s => s.source !== "custom");

      const renderSkill = (s) => {
        const st = statusMap[s.name];
        const badge = st?.status === "ready" ? '<span class="memory-badge" style="background:rgba(76,175,80,0.15);color:#4caf50">ready</span>'
          : st?.status === "needs_install" ? `<span class="memory-badge" style="background:rgba(244,67,54,0.15);color:#f44336">needs: ${(st.missing || []).join(", ")}</span>`
          : '';
        return `<div class="skill-card">
          <div style="display: flex; justify-content: space-between; align-items: center">
            <div>
              <strong>${escapeHtml(s.name)}</strong>
              ${badge}
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
        </div>`;
      };

      let html = "";
      if (customSkills.length > 0) {
        html += `<div class="skills-section-label">Custom Skills</div>`;
        html += customSkills.map(renderSkill).join("");
      }
      if (builtinSkills.length > 0) {
        html += `<div class="skills-section-label">Built-in Skills <span style="color:var(--text-muted);font-weight:400">(${builtinSkills.length})</span></div>`;
        html += builtinSkills.map(renderSkill).join("");
      }
      this.elements.skillsList.innerHTML = html;

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

  async loadUsageChart() {
    try {
      const data = await API.json("/api/analytics");
      const stats = document.getElementById("usageStats");
      const models = document.getElementById("usageModels");

      if (stats) {
        const fmt = (n) => n >= 1000000 ? (n / 1000000).toFixed(1) + "M" : n >= 1000 ? (n / 1000).toFixed(1) + "K" : n;
        stats.innerHTML = `
          <div class="usage-stat"><div class="usage-stat-value">${fmt(data.tokens?.today?.in + data.tokens?.today?.out)}</div><div class="usage-stat-label">Tokens Today</div></div>
          <div class="usage-stat"><div class="usage-stat-value">${fmt(data.tokens?.week?.in + data.tokens?.week?.out)}</div><div class="usage-stat-label">This Week</div></div>
          <div class="usage-stat"><div class="usage-stat-value">${fmt(data.tokens?.allTime?.in + data.tokens?.allTime?.out)}</div><div class="usage-stat-label">All Time</div></div>
          <div class="usage-stat"><div class="usage-stat-value">${data.messages?.today || 0}</div><div class="usage-stat-label">Messages Today</div></div>
        `;
      }

      // Draw chart
      const canvas = document.getElementById("usageChart");
      if (canvas && data.tokens?.daily?.length) {
        this._drawTokenChart(canvas, data.tokens.daily);
      }

      // Model breakdown
      if (models && data.models?.length) {
        models.innerHTML = data.models.map(m => {
          const name = (m.model || "unknown").replace("claude-", "").replace(/-\d.*/, "");
          const total = (m.tokens_in || 0) + (m.tokens_out || 0);
          const fmt = total >= 1000000 ? (total / 1000000).toFixed(1) + "M" : total >= 1000 ? (total / 1000).toFixed(1) + "K" : total;
          return `<div class="usage-model-card"><span class="usage-model-name">${name}</span><span class="usage-model-count">${m.count} msgs / ${fmt} tokens</span></div>`;
        }).join("");
      }
    } catch { /* ignore */ }
  },

  _drawTokenChart(canvas, daily) {
    const ctx = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.parentElement.getBoundingClientRect();
    canvas.width = rect.width * dpr;
    canvas.height = 200 * dpr;
    canvas.style.width = rect.width + "px";
    canvas.style.height = "200px";
    ctx.scale(dpr, dpr);

    const w = rect.width;
    const h = 200;
    const pad = { top: 20, right: 20, bottom: 30, left: 50 };
    const plotW = w - pad.left - pad.right;
    const plotH = h - pad.top - pad.bottom;

    // Clear
    ctx.clearRect(0, 0, w, h);

    const values = daily.map(d => (d.tokens_in || 0) + (d.tokens_out || 0));
    const max = Math.max(...values, 1);
    const barW = Math.max(plotW / values.length - 4, 2);

    // Y-axis labels
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--text-muted").trim() || "#6b6b63";
    ctx.font = "11px monospace";
    ctx.textAlign = "right";
    for (let i = 0; i <= 4; i++) {
      const y = pad.top + plotH - (plotH * i / 4);
      const val = Math.round(max * i / 4);
      const label = val >= 1000000 ? (val / 1000000).toFixed(1) + "M" : val >= 1000 ? (val / 1000).toFixed(0) + "K" : val;
      ctx.fillText(label, pad.left - 8, y + 4);
      // Grid line
      ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--border-light").trim() || "#2f2e2b";
      ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    }

    // Bars
    const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#c45a35";
    values.forEach((val, i) => {
      const x = pad.left + (plotW / values.length) * i + 2;
      const barH = (val / max) * plotH;
      const y = pad.top + plotH - barH;

      ctx.fillStyle = accent;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.roundRect(x, y, barW, barH, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
    });

    // X-axis labels (dates)
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--text-muted").trim() || "#6b6b63";
    ctx.textAlign = "center";
    daily.forEach((d, i) => {
      if (i % Math.ceil(daily.length / 7) === 0) {
        const x = pad.left + (plotW / values.length) * i + barW / 2;
        const label = d.day?.slice(5) || "";
        ctx.fillText(label, x, h - 8);
      }
    });
  },

  _auditOffset: 0,

  async loadAuditLog(append = false) {
    const container = document.getElementById("auditLogEntries");
    const loadMoreBtn = document.getElementById("auditLoadMore");
    if (!container) return;

    if (!append) {
      this._auditOffset = 0;
      container.innerHTML = '<div class="text-muted text-sm">Loading...</div>';
    }

    try {
      const data = await API.json(`/api/admin/audit?limit=50&offset=${this._auditOffset}`);
      const entries = data.entries || [];

      if (!append) container.innerHTML = "";

      if (!entries.length && !append) {
        container.innerHTML = '<div class="text-muted text-sm">No audit entries yet.</div>';
        if (loadMoreBtn) loadMoreBtn.style.display = "none";
        return;
      }

      for (const e of entries) {
        const div = document.createElement("div");
        div.className = "audit-entry";
        const actionClass = e.action?.startsWith("auth") ? "auth" : e.action?.startsWith("tool") ? "tool" : "setting";
        const time = e.created_at ? new Date(e.created_at + "Z").toLocaleString() : "";
        div.innerHTML = `
          <span class="audit-entry-time">${time}</span>
          <span class="audit-entry-action ${actionClass}">${e.action}${e.target ? ` → ${e.target}` : ""}</span>
          <span class="audit-entry-detail" title="${e.detail || ""}">${e.detail || e.ip || ""}</span>
        `;
        container.appendChild(div);
      }

      this._auditOffset += entries.length;
      if (loadMoreBtn) {
        loadMoreBtn.style.display = entries.length >= 50 ? "block" : "none";
        loadMoreBtn.onclick = () => this.loadAuditLog(true);
      }
    } catch {
      if (!append) container.innerHTML = '<div class="text-muted text-sm">Failed to load audit log.</div>';
    }
  },
};
