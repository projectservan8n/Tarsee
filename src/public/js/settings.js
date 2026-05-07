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
      // Privacy / redaction toggle (security tab)
      redactSecrets: document.getElementById("settingsRedactSecrets"),
      // Email channel
      emailEnabled: document.getElementById("settingsEmailEnabled"),
      emailAddress: document.getElementById("settingsEmailAddress"),
      emailImapHost: document.getElementById("settingsEmailImapHost"),
      emailImapPort: document.getElementById("settingsEmailImapPort"),
      emailImapUser: document.getElementById("settingsEmailImapUser"),
      emailImapPassword: document.getElementById("settingsEmailImapPassword"),
      emailSmtpHost: document.getElementById("settingsEmailSmtpHost"),
      emailSmtpPort: document.getElementById("settingsEmailSmtpPort"),
      emailSmtpUser: document.getElementById("settingsEmailSmtpUser"),
      emailSmtpPassword: document.getElementById("settingsEmailSmtpPassword"),
      emailMentionKeyword: document.getElementById("settingsEmailMentionKeyword"),
      emailReplyAllMarker: document.getElementById("settingsEmailReplyAllMarker"),
      emailFromName: document.getElementById("settingsEmailFromName"),
      emailAllowlist: document.getElementById("settingsEmailAllowlist"),
      emailMentionHint: document.getElementById("emailMentionHint"),
      emailChannelStatus: document.getElementById("emailChannelStatus"),
      saveEmailChannelBtn: document.getElementById("saveEmailChannelBtn"),
      apiToken: document.getElementById("settingsApiToken"),
      apiTokenReveal: document.getElementById("settingsApiTokenReveal"),
      apiTokenCopy: document.getElementById("settingsApiTokenCopy"),
      // Mention mode (per-platform toggle for guild/group bots)
      discordMentionMode: document.getElementById("settingsDiscordMentionMode"),
      telegramMentionMode: document.getElementById("settingsTelegramMentionMode"),
      saveMentionModeBtn: document.getElementById("saveMentionModeBtn"),
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
      // Appearance
      theme: document.getElementById("settingsTheme"),
      enablePushBtn: document.getElementById("enablePushBtn"),
      disablePushBtn: document.getElementById("disablePushBtn"),
      testPushBtn: document.getElementById("testPushBtn"),
      pushStatus: document.getElementById("pushStatus"),
    };

    // --- Push notifications (per-device toggle) ---
    const refreshPushStatus = async () => {
      if (!window.TarseePush) {
        if (this.elements.pushStatus) this.elements.pushStatus.textContent = "Not supported in this browser.";
        this.elements.enablePushBtn?.setAttribute("disabled", "");
        return;
      }
      const status = await window.TarseePush.status();
      const on = status === "subscribed";
      if (this.elements.enablePushBtn) this.elements.enablePushBtn.style.display = on ? "none" : "";
      if (this.elements.disablePushBtn) this.elements.disablePushBtn.style.display = on ? "" : "none";
      if (this.elements.testPushBtn) this.elements.testPushBtn.style.display = on ? "" : "none";
      const label = {
        unsupported: "Not supported in this browser.",
        denied: "Notifications blocked in browser settings.",
        default: "Not enabled yet.",
        subscribed: "✓ Enabled on this device.",
        "granted-unsubscribed": "Permission granted — click Enable to subscribe.",
      }[status] || status;
      if (this.elements.pushStatus) this.elements.pushStatus.textContent = label;
    };

    this.elements.enablePushBtn?.addEventListener("click", async () => {
      try {
        await window.TarseePush.enable();
        App.showToast?.("Push enabled — try the test button.", "success");
      } catch (err) {
        App.showToast?.("Push: " + err.message, "error");
      }
      refreshPushStatus();
    });
    this.elements.disablePushBtn?.addEventListener("click", async () => {
      try { await window.TarseePush.disable(); App.showToast?.("Push disabled on this device.", "info"); }
      catch (err) { App.showToast?.(err.message, "error"); }
      refreshPushStatus();
    });
    this.elements.testPushBtn?.addEventListener("click", async () => {
      try {
        const res = await API.json("/api/push/test", {
          method: "POST",
          body: { message: "Push test from Settings." },
        });
        App.showToast?.(`Sent ${res.sent}/${res.total} · failed ${res.failed}`, res.sent ? "success" : "error");
      } catch (err) {
        App.showToast?.("Test failed: " + err.message, "error");
      }
    });
    // Kick an initial status check on settings open.
    refreshPushStatus();

    // --- Theme picker ---
    // Reflect current theme on open, persist + apply instantly on change.
    if (this.elements.theme) {
      const current = (() => {
        try { return localStorage.getItem("tarsee_theme") || "warm-charcoal"; }
        catch { return "warm-charcoal"; }
      })();
      // "dark" was the legacy value before the theme switcher — alias it.
      this.elements.theme.value = current === "dark" ? "warm-charcoal" : current;

      this.elements.theme.addEventListener("change", async () => {
        const name = this.elements.theme.value;
        document.documentElement.setAttribute("data-theme", name);
        try { localStorage.setItem("tarsee_theme", name); } catch {}
        // Persist to server so other devices signed in to the same account
        // can see the pick via /api/settings. Failure is non-fatal — the
        // local-storage value is the authoritative per-device theme.
        try {
          await API.json("/api/settings/general", {
            method: "POST",
            body: { key: "ui.theme", value: name },
          });
        } catch { /* server side optional */ }
      });
    }

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
    this.elements.saveMentionModeBtn?.addEventListener("click", () => this.saveMentionMode());
    this.elements.saveEmailChannelBtn?.addEventListener("click", () => this.saveEmailChannel());

    // API Token mask + reveal + copy. The token sits in API.token already
    // (loaded at login for WebSocket auth), so the reveal toggle is purely
    // a display concern — no extra fetch needed.
    this.elements.apiTokenReveal?.addEventListener("click", () => this.toggleApiTokenReveal());
    this.elements.apiTokenCopy?.addEventListener("click", () => this.copyApiToken());

    // Email preset buttons
    document.querySelectorAll(".email-preset-btn").forEach((btn) => {
      btn.addEventListener("click", () => this.applyEmailPreset(btn.dataset.preset));
    });

    // Keep the "triggers on @tarsee" hint in sync with the user's keyword
    if (this.elements.emailMentionKeyword && this.elements.emailMentionHint) {
      this.elements.emailMentionKeyword.addEventListener("input", () => {
        const v = this.elements.emailMentionKeyword.value.trim() || "@tarsee";
        this.elements.emailMentionHint.textContent = v;
      });
    }

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
          await API.json("/api/settings/general", { method: "POST", body: { key: "captcha.service", value: service } });
          await API.json("/api/settings/general", { method: "POST", body: { key: "captcha.api_key", value: apiKey } });
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
        const ok = await this.saveWorkspaceFile(name, el.value, true);
        if (statusEl) {
          statusEl.textContent = ok ? "Saved" : "Save failed";
          statusEl.className = ok ? "save-status saved" : "save-status error";
        }
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

    // Piper voice file labels
    document.getElementById("piperOnnxFile")?.addEventListener("change", (e) => {
      document.getElementById("piperOnnxLabel").textContent = e.target.files[0]?.name || "No file";
    });
    document.getElementById("piperJsonFile")?.addEventListener("change", (e) => {
      document.getElementById("piperJsonLabel").textContent = e.target.files[0]?.name || "No file";
    });

    // Piper voice upload
    const piperUploadBtn = document.getElementById("piperUploadBtn");
    if (piperUploadBtn) {
      piperUploadBtn.addEventListener("click", async () => {
        const name = document.getElementById("piperVoiceName").value.trim();
        const onnxFile = document.getElementById("piperOnnxFile").files[0];
        const jsonFile = document.getElementById("piperJsonFile").files[0];
        if (!name) return App.showToast("Enter a voice name", "error");
        if (!onnxFile) return App.showToast("Select .onnx file", "error");
        if (!jsonFile) return App.showToast("Select .onnx.json file", "error");

        piperUploadBtn.disabled = true;
        const origText = piperUploadBtn.textContent;
        piperUploadBtn.textContent = "Uploading 0%...";

        try {
          const form = new FormData();
          form.append("name", name);
          form.append("onnx", onnxFile);
          form.append("json", jsonFile);
          const sizeMB = ((onnxFile.size + jsonFile.size) / 1024 / 1024).toFixed(1);

          const data = await new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open("POST", "/api/voice/piper-upload");
            const csrf = API.getCsrfToken();
            if (csrf) xhr.setRequestHeader("X-CSRF-Token", csrf);
            xhr.withCredentials = true;

            xhr.upload.onprogress = (e) => {
              if (e.lengthComputable) {
                const pct = Math.round((e.loaded / e.total) * 100);
                piperUploadBtn.textContent = `Uploading ${pct}% (${sizeMB}MB)...`;
              }
            };

            xhr.onload = () => {
              try {
                const res = JSON.parse(xhr.responseText);
                if (xhr.status >= 200 && xhr.status < 300) resolve(res);
                else reject(new Error(res.error || `Upload failed (${xhr.status})`));
              } catch { reject(new Error("Invalid response")); }
            };

            xhr.onerror = () => reject(new Error("Network error"));
            xhr.send(form);
          });

          App.showToast(`Voice "${data.name}" uploaded (${sizeMB}MB)`, "success");
          document.getElementById("piperVoiceName").value = "";
          document.getElementById("piperOnnxFile").value = "";
          document.getElementById("piperJsonFile").value = "";
          document.getElementById("piperOnnxLabel").textContent = "No file";
          document.getElementById("piperJsonLabel").textContent = "No file selected";
          this.loadPiperVoices();
          // Refresh the Default Voice dropdown if Piper is selected
          if (this.elements.voiceEngine?.value === "piper") this.loadVoicesForEngine("piper");
        } catch (e) { App.showToast(e.message, "error"); }
        finally { piperUploadBtn.disabled = false; piperUploadBtn.textContent = origText; }
      });
      this.loadPiperVoices();
    }

    // STT save (provider + model + OpenAI key)
    const saveSTTBtn = document.getElementById("saveSTTBtn");
    if (saveSTTBtn) {
      saveSTTBtn.addEventListener("click", async () => {
        const model = document.getElementById("settingsSTTModel").value;
        const provider = document.getElementById("settingsSTTProvider")?.value || "local";
        const openaiKey = document.getElementById("settingsOpenaiKey")?.value?.trim();
        try {
          await API.json("/api/voice/stt-model", { method: "POST", body: { model } });
          await API.json("/api/settings/general", { method: "POST", body: { key: "voice.stt_provider", value: provider } });
          if (openaiKey) {
            // Save in both formats — voice-specific and provider-generic (for getApiKey)
            await API.json("/api/settings/general", { method: "POST", body: { key: "voice.openai_api_key", value: openaiKey } });
            await API.json("/api/settings/general", { method: "POST", body: { key: "ai.openai.apiKey", value: openaiKey } });
          }
          App.showToast(`STT: ${provider}${provider === "local" ? ` (${model})` : ""}`, "success");
          this.loadSTTModelStatus();
        } catch (e) { App.showToast(e.message, "error"); }
      });
      this.loadSTTModelStatus();

      // Load saved values
      API.json("/api/settings").then(data => {
        const settings = data.settings || [];
        const provider = settings.find(s => s.key === "voice.stt_provider")?.value;
        const key = settings.find(s => s.key === "voice.openai_api_key")?.value;
        if (provider) document.getElementById("settingsSTTProvider").value = provider;
        if (key) document.getElementById("settingsOpenaiKey").value = key;
      }).catch(() => {});
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
      // Populate the model dropdown FIRST so setting its value below actually sticks —
      // assigning to <select>.value silently no-ops if the matching <option> isn't there.
      await this.loadModelsDropdown();

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

      // Email channel
      this.loadEmailChannel(settings);

      // Privacy: redact-secrets toggle (default on if unset)
      if (this.elements.redactSecrets) {
        const redactSetting = settings.find((s) => s.key === "ui.redactSecrets")?.value;
        this.elements.redactSecrets.checked = redactSetting !== false;
        if (!this.elements._redactSecretsBound) {
          this.elements._redactSecretsBound = true;
          this.elements.redactSecrets.addEventListener("change", async (e) => {
            try {
              await API.json("/api/settings/general", {
                method: "POST",
                body: { key: "ui.redactSecrets", value: !!e.target.checked },
              });
            } catch (err) {
              window.App?.showToast?.(err?.message || "Failed to save", "error");
            }
          });
        }
      }

      // API token — render masked by default. The full value is in API.token
      // already; reveal/copy buttons read from there. Reset reveal state on
      // every (re)load so revisiting the page doesn't expose a previously-
      // revealed token.
      this._apiTokenRevealed = false;
      if (this.elements.apiToken) {
        this.elements.apiToken.value = this.maskedApiToken();
      }
      if (this.elements.apiTokenReveal) {
        this.elements.apiTokenReveal.textContent = "Reveal";
      }

      // Mention mode (Discord/Telegram per-platform toggle)
      const discordMode = settings.find((s) => s.key === "discord.mention_mode")?.value;
      const telegramMode = settings.find((s) => s.key === "telegram.mention_mode")?.value;
      if (this.elements.discordMentionMode) {
        this.elements.discordMentionMode.value = discordMode === "off" ? "off" : "required";
      }
      if (this.elements.telegramMentionMode) {
        this.elements.telegramMentionMode.value = telegramMode === "off" ? "off" : "required";
      }

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
        model: this.elements.model.value,
      });
      App.showToast("Model saved", "success");
    } catch (err) {
      App.showToast(err.message, "error");
    }
  },

  /**
   * Populate the Settings > AI Provider model dropdown from the server's
   * central model registry. Called on page load so new models added in
   * src/config/constants.js show up without any client-side code change.
   */
  async loadModelsDropdown() {
    const select = this.elements.model;
    if (!select) return;
    try {
      const { models } = await API.json("/api/chat/models");
      if (!Array.isArray(models) || !models.length) return;
      const current = select.value;
      select.innerHTML = models.map((m) => {
        const notes = [m.context];
        if (m.recommended) notes.push("recommended");
        return `<option value="${m.id}">${m.displayName} (${notes.join(", ")})</option>`;
      }).join("");
      // Restore previous selection if still present; otherwise leave on the first option.
      if (current && models.some((m) => m.id === current)) {
        select.value = current;
      }
    } catch (err) {
      // Leave the (empty) select alone — saveProvider still works with whatever
      // value is already stored server-side; the dropdown just won't render.
      console.warn("[settings] Failed to load model list:", err.message);
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

  async saveMentionMode() {
    try {
      const discordMode = this.elements.discordMentionMode?.value === "off" ? "off" : "required";
      const telegramMode = this.elements.telegramMentionMode?.value === "off" ? "off" : "required";

      // Footgun guard: warn if switching to "off" while the matching allowlist
      // is empty. Empty allowlist + mode=off means the bot will respond to
      // anyone in any channel/chat it can see. Confirm before saving.
      const discordAllow = (document.getElementById("settingsDiscordAllowlist")?.value || "").split("\n").map(s => s.trim()).filter(Boolean);
      const telegramAllow = (document.getElementById("settingsTelegramAllowlist")?.value || "").split("\n").map(s => s.trim()).filter(Boolean);
      const dangers = [];
      if (discordMode === "off" && discordAllow.length === 0) dangers.push("Discord");
      if (telegramMode === "off" && telegramAllow.length === 0) dangers.push("Telegram");
      if (dangers.length > 0) {
        const ok = window.confirm(
          `${dangers.join(" and ")}: mention mode is OFF and the allowlist is empty.\n\n` +
          `The bot will respond to EVERY message in EVERY ${dangers.length > 1 ? "channel/chat" : (dangers[0] === "Discord" ? "channel" : "chat")} it can see.\n\n` +
          `Continue?`
        );
        if (!ok) return;
      }

      await API.json("/api/settings/general", { method: "POST", body: { key: "discord.mention_mode", value: discordMode } });
      await API.json("/api/settings/general", { method: "POST", body: { key: "telegram.mention_mode", value: telegramMode } });
      App.showToast("Bot behavior saved", "success");
    } catch (err) {
      App.showToast(err.message || "Failed to save bot behavior", "error");
    }
  },

  /** Build a `first4…last4` mask of the current API token, or a placeholder. */
  maskedApiToken() {
    const t = API?.token;
    if (!t || t.length < 12) return "••••••••";
    return `${t.slice(0, 4)}${"•".repeat(Math.max(8, t.length - 8))}${t.slice(-4)}`;
  },

  toggleApiTokenReveal() {
    if (!this.elements.apiToken) return;
    this._apiTokenRevealed = !this._apiTokenRevealed;
    if (this._apiTokenRevealed) {
      this.elements.apiToken.value = API?.token || "";
      if (this.elements.apiTokenReveal) this.elements.apiTokenReveal.textContent = "Hide";
    } else {
      this.elements.apiToken.value = this.maskedApiToken();
      if (this.elements.apiTokenReveal) this.elements.apiTokenReveal.textContent = "Reveal";
    }
  },

  async copyApiToken() {
    const token = API?.token;
    if (!token) {
      App.showToast("No API token to copy", "error");
      return;
    }
    try {
      // Modern clipboard API. Requires secure context (HTTPS or localhost).
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(token);
        App.showToast("API token copied", "success");
        return;
      }
      // Legacy fallback for environments without the clipboard API.
      const ta = document.createElement("textarea");
      ta.value = token;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      App.showToast(ok ? "API token copied" : "Press Ctrl+C to copy", ok ? "success" : "error");
    } catch (err) {
      App.showToast("Copy failed: " + (err?.message || "unknown"), "error");
    }
  },

  loadEmailChannel(settings) {
    const cfg = settings.find((s) => s.key === "channel.email")?.value || {};
    const e = this.elements;
    if (!e.emailEnabled) return; // UI not present

    e.emailEnabled.checked = !!cfg.enabled;
    e.emailAddress.value = cfg.tarseeEmailAddress || "";
    e.emailImapHost.value = cfg.imap?.host || "";
    e.emailImapPort.value = cfg.imap?.port || "";
    e.emailImapUser.value = cfg.imap?.user || "";
    // Passwords are never returned plaintext — show placeholder only if a pw exists server-side
    e.emailImapPassword.value = "";
    e.emailImapPassword.placeholder = cfg.imap?.hasPassword
      ? "••••••••  (leave blank to keep existing)"
      : "16-character app password (not your login password)";
    e.emailSmtpHost.value = cfg.smtp?.host || "";
    e.emailSmtpPort.value = cfg.smtp?.port || "";
    e.emailSmtpUser.value = cfg.smtp?.user || "";
    e.emailSmtpPassword.value = "";
    e.emailSmtpPassword.placeholder = cfg.smtp?.hasPassword
      ? "••••••••  (leave blank to keep existing)"
      : "16-character app password (not your login password)";

    e.emailMentionKeyword.value = cfg.mentionKeyword || "@tarsee";
    e.emailReplyAllMarker.value = cfg.replyAllMarker || "[reply-all]";
    e.emailFromName.value = cfg.fromName || "";

    const allow = cfg.allowlistFromAddresses;
    e.emailAllowlist.value = Array.isArray(allow) ? allow.join("\n") : (allow || "");

    if (e.emailMentionHint) {
      e.emailMentionHint.textContent = e.emailMentionKeyword.value.trim() || "@tarsee";
    }
  },

  applyEmailPreset(name) {
    const presets = {
      gmail:    { imapHost: "imap.gmail.com",        imapPort: 993, smtpHost: "smtp.gmail.com",        smtpPort: 465 },
      outlook:  { imapHost: "outlook.office365.com", imapPort: 993, smtpHost: "smtp.office365.com",    smtpPort: 587 },
      icloud:   { imapHost: "imap.mail.me.com",      imapPort: 993, smtpHost: "smtp.mail.me.com",      smtpPort: 587 },
      zoho:     { imapHost: "imap.zoho.com",         imapPort: 993, smtpHost: "smtp.zoho.com",         smtpPort: 465 },
      fastmail: { imapHost: "imap.fastmail.com",     imapPort: 993, smtpHost: "smtp.fastmail.com",     smtpPort: 465 },
      yahoo:    { imapHost: "imap.mail.yahoo.com",   imapPort: 993, smtpHost: "smtp.mail.yahoo.com",   smtpPort: 465 },
      custom:   null,
    };
    if (name === "custom") {
      this.elements.emailImapHost.value = "";
      this.elements.emailImapPort.value = "";
      this.elements.emailSmtpHost.value = "";
      this.elements.emailSmtpPort.value = "";
      this.elements.emailImapHost.focus();
      return;
    }
    const p = presets[name];
    if (!p) return;
    this.elements.emailImapHost.value = p.imapHost;
    this.elements.emailImapPort.value = p.imapPort;
    this.elements.emailSmtpHost.value = p.smtpHost;
    this.elements.emailSmtpPort.value = p.smtpPort;
  },

  async saveEmailChannel() {
    try {
      const e = this.elements;
      const parseAddrs = (v) => (v || "").split(/[\n,]/).map((s) => s.trim().toLowerCase()).filter(Boolean);

      const payload = {
        type: "email",
        enabled: !!e.emailEnabled.checked,
        tarseeEmailAddress: e.emailAddress.value.trim(),
        imap: {
          host: e.emailImapHost.value.trim(),
          port: Number(e.emailImapPort.value) || 993,
          user: e.emailImapUser.value.trim(),
        },
        smtp: {
          host: e.emailSmtpHost.value.trim(),
          port: Number(e.emailSmtpPort.value) || 465,
          user: e.emailSmtpUser.value.trim(),
        },
        mentionKeyword: e.emailMentionKeyword.value.trim() || "@tarsee",
        replyAllMarker: e.emailReplyAllMarker.value.trim() || "[reply-all]",
        fromName: e.emailFromName.value.trim(),
        allowlistFromAddresses: parseAddrs(e.emailAllowlist.value),
      };

      // Only include passwords if the user typed new ones — empty string means "keep existing"
      const imapPw = e.emailImapPassword.value;
      const smtpPw = e.emailSmtpPassword.value;
      if (imapPw) payload.imap.password = imapPw;
      if (smtpPw) payload.smtp.password = smtpPw;

      if (e.emailChannelStatus) e.emailChannelStatus.textContent = "Saving...";
      await API.saveChannel(payload);

      // Clear password fields after save so they don't show plaintext in the DOM
      e.emailImapPassword.value = "";
      e.emailSmtpPassword.value = "";

      if (e.emailChannelStatus) e.emailChannelStatus.textContent = payload.enabled ? "Saved — channel starting." : "Saved — channel disabled.";
      App.showToast("Email channel saved", "success");

      // Refresh to pick up hasPassword flags
      setTimeout(() => this.loadSettings(), 500);
    } catch (err) {
      if (this.elements.emailChannelStatus) this.elements.emailChannelStatus.textContent = "";
      App.showToast(err.message || "Failed to save email channel", "error");
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

  /** Load voices for a specific engine and populate the dropdown. */
  async loadVoicesForEngine(engine) {
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

    let voices = voiceMap[engine] || [];

    // For Piper, load uploaded voices dynamically
    if (engine === "piper") {
      try {
        const data = await API.json("/api/voice/piper-voices");
        voices = (data.voices || []).map(v => ({ id: v.id, name: v.id + ` (${v.sizeMB}MB)` }));
      } catch { voices = []; }
    }

    this.elements.defaultVoice.innerHTML = '<option value="">Engine default</option>';
    if (engine === "piper" && voices.length === 0) {
      this.elements.defaultVoice.innerHTML = '<option value="">No voices uploaded — add below</option>';
    }
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

  async loadPiperVoices() {
    const list = document.getElementById("piperVoicesList");
    if (!list) return;
    try {
      const data = await API.json("/api/voice/piper-voices");
      if (!data.voices?.length) {
        list.innerHTML = '<div class="text-muted text-sm">No Piper voices uploaded yet.</div>';
        return;
      }
      list.innerHTML = data.voices.map(v => `
        <div class="audit-entry" style="margin-bottom:4px">
          <span class="audit-entry-action">${v.id}</span>
          <span class="audit-entry-detail">${v.sizeMB}MB</span>
          <button class="btn btn-sm btn-ghost" onclick="Settings.deletePiperVoice('${v.id}')" style="color:var(--danger);padding:2px 8px">Delete</button>
        </div>
      `).join("");
    } catch { list.innerHTML = '<div class="text-muted text-sm">Failed to load voices.</div>'; }
  },

  async deletePiperVoice(id) {
    if (!confirm(`Delete voice "${id}"?`)) return;
    try {
      const csrf = API.getCsrfToken();
      const headers = {};
      if (csrf) headers["X-CSRF-Token"] = csrf;
      await fetch(`/api/voice/piper-voices/${id}`, { method: "DELETE", headers, credentials: "same-origin" });
      App.showToast("Voice deleted", "success");
      this.loadPiperVoices();
    } catch { App.showToast("Failed to delete", "error"); }
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
      return true;
    } catch (err) {
      // Errors always surface even in silent mode — silent was only
      // meant to suppress success noise from per-keystroke autosave,
      // not hide failures from the user.
      App.showToast(`${name}: ${err.message}`, "error");
      return false;
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
        const isInstalled = s.installed === true;
        const badge = isInstalled
          ? '<span class="memory-badge" style="background:rgba(76,175,80,0.15);color:#4caf50">installed</span>'
          : '<span class="memory-badge" style="background:rgba(158,158,158,0.15);color:#9e9e9e">not installed</span>';
        const actionBtn = isInstalled
          ? `<button class="btn btn-sm" data-skill-uninstall="${s.name}" style="color:var(--danger)">Uninstall</button>`
          : `<button class="btn btn-sm" data-skill-install="${s.name}" style="color:var(--success)">Install</button>`;
        return `<div class="skill-card" style="${isInstalled ? "" : "opacity:0.6"}">
          <div style="display: flex; justify-content: space-between; align-items: center">
            <div>
              <strong>${escapeHtml(s.name)}</strong>
              ${badge}
            </div>
            <div style="display: flex; gap: 4px; align-items: center">
              ${actionBtn}
              ${isInstalled ? `<button class="btn btn-sm" data-skill-view="${s.name}">View</button>` : ""}
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
      this.elements.skillsList.querySelectorAll("[data-skill-install]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const name = btn.dataset.skillInstall;
          btn.disabled = true; btn.textContent = "Installing...";
          try {
            await API.json("/api/skills/install", { method: "POST", body: { name } });
            App.showToast(`${name} installed`, "success");
            this.loadSkills();
          } catch (e) { App.showToast(e.message, "error"); btn.disabled = false; btn.textContent = "Install"; }
        });
      });
      this.elements.skillsList.querySelectorAll("[data-skill-uninstall]").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const name = btn.dataset.skillUninstall;
          btn.disabled = true; btn.textContent = "Removing...";
          try {
            await API.json("/api/skills/uninstall", { method: "POST", body: { name } });
            App.showToast(`${name} uninstalled`, "success");
            this.loadSkills();
          } catch (e) { App.showToast(e.message, "error"); btn.disabled = false; btn.textContent = "Uninstall"; }
        });
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
          const raw = m.model || "unknown";
          const name = raw.replace("claude-", "").replace(/-202\d.*/, "").replace("4-6", "4.6").replace("4-5", "4.5");
          const total = (m.tokens_in || 0) + (m.tokens_out || 0);
          const fmt = total >= 1000000 ? (total / 1000000).toFixed(1) + "M" : total >= 1000 ? (total / 1000).toFixed(1) + "K" : total;
          return `<div class="usage-model-card"><span class="usage-model-name">${name}</span><span class="usage-model-count">${m.count} msgs &middot; ${fmt} tokens</span></div>`;
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
