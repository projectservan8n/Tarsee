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
      // Identity
      botName: document.getElementById("settingsBotName"),
      saveIdentityBtn: document.getElementById("saveIdentityBtn"),
      // Workspace files
      soulMd: document.getElementById("settingsSoulMd"),
      saveSoulBtn: document.getElementById("saveSoulBtn"),
      userMd: document.getElementById("settingsUserMd"),
      saveUserBtn: document.getElementById("saveUserBtn"),
      memoryMd: document.getElementById("settingsMemoryMd"),
      saveMemoryFileBtn: document.getElementById("saveMemoryFileBtn"),
      // Memory
      memoriesList: document.getElementById("memoriesList"),
      memoryInput: document.getElementById("memoryInput"),
      addMemoryBtn: document.getElementById("addMemoryBtn"),
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
      // Skills
      skillsList: document.getElementById("skillsList"),
      createSkillBtn: document.getElementById("createSkillBtn"),
      skillDialog: document.getElementById("skillDialog"),
      skillNameInput: document.getElementById("skillNameInput"),
      skillDescInput: document.getElementById("skillDescInput"),
      skillContentInput: document.getElementById("skillContentInput"),
      skillSaveBtn: document.getElementById("skillSaveBtn"),
      skillCancelBtn: document.getElementById("skillCancelBtn"),
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

    // Identity handlers
    if (this.elements.saveIdentityBtn) {
      this.elements.saveIdentityBtn.addEventListener("click", () => this.saveIdentity());
    }
    // Workspace file handlers
    if (this.elements.saveSoulBtn) {
      this.elements.saveSoulBtn.addEventListener("click", () => this.saveWorkspaceFile("SOUL.md", this.elements.soulMd.value));
    }
    if (this.elements.saveUserBtn) {
      this.elements.saveUserBtn.addEventListener("click", () => this.saveWorkspaceFile("USER.md", this.elements.userMd.value));
    }
    if (this.elements.saveMemoryFileBtn) {
      this.elements.saveMemoryFileBtn.addEventListener("click", () => this.saveWorkspaceFile("MEMORY.md", this.elements.memoryMd.value));
    }

    // Memory handlers
    if (this.elements.addMemoryBtn) {
      this.elements.addMemoryBtn.addEventListener("click", () => this.addMemory());
      this.elements.memoryInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") this.addMemory();
      });
    }

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

      // Load identity
      const botName = settings.find((s) => s.key === "identity.name")?.value;
      if (botName && this.elements.botName) this.elements.botName.value = botName;

      // Load workspace files (SOUL.md, USER.md, MEMORY.md)
      this.loadWorkspaceFiles();

      // Load voice settings
      const voiceEngine = settings.find((s) => s.key === "voice.engine")?.value;
      if (voiceEngine && this.elements.voiceEngine) {
        this.elements.voiceEngine.value = voiceEngine;
      }

      // Load voice engine status and voices list
      this.loadVoiceStatus();
      this.loadVoices();

      // Load skills
      this.loadSkills();

      // Load memories
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
      const isActive = engine !== "stub" && engine !== "none";
      const status = isActive ? `Engine: ${engine}` : "No TTS engine active — voice cloning requires Coqui TTS";
      this.elements.voiceEngineStatus.textContent = status;
      this.elements.voiceEngineStatus.style.color =
        isActive ? "var(--primary)" : "var(--text-muted)";

      // Disable clone UI when no engine
      if (this.elements.voiceCloneBtn) {
        this.elements.voiceCloneBtn.disabled = !isActive;
        if (!isActive) {
          this.elements.voiceCloneBtn.title = "Enable a TTS engine first";
        }
      }
      if (this.elements.voiceCloneUpload) {
        this.elements.voiceCloneUpload.style.opacity = isActive ? "1" : "0.5";
        this.elements.voiceCloneUpload.style.pointerEvents = isActive ? "auto" : "none";
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

  // --- Identity ---
  async saveIdentity() {
    const name = this.elements.botName?.value.trim() || "OpusClaw";

    try {
      await API.json("/api/settings/general", {
        method: "POST",
        body: { key: "identity.name", value: name },
      });
      App.showToast("Bot name saved", "success");
      if (typeof Chat !== "undefined" && Chat.setBotName) Chat.setBotName(name);
    } catch (err) {
      App.showToast(err.message, "error");
    }
  },

  // --- Workspace Files (SOUL.md, USER.md, MEMORY.md) ---
  async loadWorkspaceFiles() {
    for (const [name, el] of [
      ["SOUL.md", this.elements.soulMd],
      ["USER.md", this.elements.userMd],
      ["MEMORY.md", this.elements.memoryMd],
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

  async saveWorkspaceFile(name, content) {
    try {
      await API.json("/api/settings/workspace-file", {
        method: "PUT",
        body: { name, content },
      });
      App.showToast(`${name} saved`, "success");
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

      // Delete buttons
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
  _editingSkill: null, // null = creating, string = editing skill name

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

      // Wire up buttons
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
      // Show in the dialog as read-only
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
};
