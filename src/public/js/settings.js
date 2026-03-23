/**
 * Settings panel module.
 */
const Settings = {
  elements: {},

  init() {
    this.elements = {
      overlay: document.getElementById("settingsOverlay"),
      openBtn: document.getElementById("settingsBtn"),
      closeBtn: document.getElementById("settingsClose"),
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
      saveChannelsBtn: document.getElementById("saveChannelsBtn"),
      apiToken: document.getElementById("settingsApiToken"),
      // Voice settings
      voiceEngine: document.getElementById("settingsVoiceEngine"),
      voiceEngineStatus: document.getElementById("voiceEngineStatus"),
      voiceCloneFile: document.getElementById("voiceCloneFile"),
      voiceCloneUpload: document.getElementById("voiceCloneUpload"),
      voiceCloneName: document.getElementById("voiceCloneName"),
      voiceCloneBtn: document.getElementById("voiceCloneBtn"),
      voiceCloneResult: document.getElementById("voiceCloneResult"),
      voicesList: document.getElementById("voicesList"),
      saveVoiceBtn: document.getElementById("saveVoiceBtn"),
    };

    this.elements.openBtn.addEventListener("click", () => this.open());
    this.elements.closeBtn.addEventListener("click", () => this.close());
    this.elements.overlay.addEventListener("click", (e) => {
      if (e.target === this.elements.overlay) this.close();
    });

    this.elements.provider.addEventListener("change", () => {
      const isCustom = this.elements.provider.value === "custom";
      this.elements.baseUrlGroup.style.display = isCustom ? "block" : "none";

      // Set default model hints
      const defaults = {
        anthropic: "claude-sonnet-4-5-20250929",
        openai: "gpt-4o",
        gemini: "gemini-2.5-flash",
        openrouter: "anthropic/claude-sonnet-4-5",
        custom: "",
      };
      this.elements.model.placeholder = defaults[this.elements.provider.value] || "";
    });

    this.elements.saveProviderBtn.addEventListener("click", () => this.saveProvider());
    this.elements.saveChannelsBtn.addEventListener("click", () => this.saveChannels());

    // Voice settings handlers
    if (this.elements.voiceCloneUpload) {
      const dropZone = this.elements.voiceCloneUpload;

      // Click to select file
      dropZone.addEventListener("click", () => this.elements.voiceCloneFile.click());

      this.elements.voiceCloneFile.addEventListener("change", () => {
        const file = this.elements.voiceCloneFile.files[0];
        if (file) {
          dropZone.querySelector("p").textContent = file.name;
        }
      });

      // Drag-and-drop
      dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("dragover");
      });
      dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
      dropZone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropZone.classList.remove("dragover");
        const file = e.dataTransfer.files[0];
        if (file && file.type.startsWith("audio/")) {
          const dt = new DataTransfer();
          dt.items.add(file);
          this.elements.voiceCloneFile.files = dt.files;
          dropZone.querySelector("p").textContent = file.name;
        } else {
          App.showToast("Please drop an audio file (WAV or MP3)", "error");
        }
      });
    }

    if (this.elements.voiceCloneBtn) {
      this.elements.voiceCloneBtn.addEventListener("click", () => this.cloneVoice());
    }

    if (this.elements.saveVoiceBtn) {
      this.elements.saveVoiceBtn.addEventListener("click", () => this.saveVoiceSettings());
    }
  },

  async open() {
    this.elements.overlay.classList.add("open");
    await this.load();
  },

  close() {
    this.elements.overlay.classList.remove("open");
  },

  async load() {
    try {
      // Load current settings
      const { settings } = await API.getSettings();

      // Find active provider
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

      // Load channel configs
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
      if (API.token) {
        this.elements.apiToken.value = API.token;
      }

      // Load voice settings
      const voiceEngine = settings.find((s) => s.key === "voice.engine")?.value;
      if (voiceEngine && this.elements.voiceEngine) {
        this.elements.voiceEngine.value = voiceEngine;
      }

      // Load voice engine status and voices list
      this.loadVoiceStatus();
      this.loadVoices();
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

      if (discord) {
        await API.saveChannel({ type: "discord", token: discord, enabled: true });
      }
      if (telegram) {
        await API.saveChannel({ type: "telegram", token: telegram, enabled: true });
      }
      if (slackBot && slackApp) {
        await API.saveChannel({ type: "slack", token: slackBot, appToken: slackApp, enabled: true });
      }

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
      const status = engine === "stub" ? "No TTS engine active" : `Engine: ${engine}`;
      this.elements.voiceEngineStatus.textContent = status;
      this.elements.voiceEngineStatus.style.color =
        engine === "stub" ? "var(--text-muted)" : "var(--primary)";
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
        return;
      }

      this.elements.voicesList.innerHTML = voices
        .map(
          (v) =>
            `<div style="display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px">
              <span style="flex:1">${v.name || v.id}</span>
              ${v.isClone ? '<span style="color:var(--primary);font-size:11px">cloned</span>' : ""}
            </div>`
        )
        .join("");
    } catch {
      this.elements.voicesList.innerHTML = "";
    }
  },

  async cloneVoice() {
    const file = this.elements.voiceCloneFile?.files[0];
    const name = this.elements.voiceCloneName?.value.trim();

    if (!file) {
      App.showToast("Select an audio file first (6-30 seconds recommended)", "error");
      return;
    }
    if (!name) {
      App.showToast("Enter a name for the voice", "error");
      return;
    }

    this.elements.voiceCloneBtn.disabled = true;
    this.elements.voiceCloneBtn.textContent = "Cloning...";
    this.elements.voiceCloneResult.textContent = "";

    try {
      const formData = new FormData();
      formData.append("audio", file);
      formData.append("name", name);

      const res = await API.request("/api/voice/clone", {
        method: "POST",
        body: formData,
        // Don't set Content-Type — browser sets it with boundary for FormData
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Clone failed" }));
        throw new Error(err.error || "Clone failed");
      }

      const data = await res.json();
      this.elements.voiceCloneResult.innerHTML =
        `<span style="color: var(--primary)">Voice "${data.name}" cloned (${data.voiceId})</span>`;
      this.elements.voiceCloneName.value = "";
      this.elements.voiceCloneFile.value = "";
      this.elements.voiceCloneUpload.querySelector("p").textContent =
        "Drop an audio file here or click to upload";

      // Refresh voices list
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
      await API.request("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "voice.engine", value: engine }),
      });
      App.showToast("Voice engine saved. Restart server to apply.", "success");
    } catch (err) {
      App.showToast(err.message, "error");
    }
  },
};
