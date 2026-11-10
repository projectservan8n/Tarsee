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
      // AI (Settings → AI, the header chip and its banner)
      aiPanel: document.querySelector('.settings-tab-panel[data-tab="ai"]'),
      aiChips: document.getElementById("aiChips"),
      aiBanners: document.getElementById("aiBanners"),
      aiDefaultNow: document.getElementById("aiDefaultNow"),
      aiKeysOnly: document.getElementById("aiKeysOnly"),
      aiKeysOnlyNote: document.getElementById("aiKeysOnlyNote"),
      aiBackupModel: document.getElementById("aiBackupModel"),
      aiMonthlyCap: document.getElementById("aiMonthlyCap"),
      aiMonthSpend: document.getElementById("aiMonthSpend"),
      aiSaveExtrasBtn: document.getElementById("aiSaveExtrasBtn"),
      aiTermsNote: document.getElementById("aiTermsNote"),
      aiHeaderChip: document.getElementById("aiHeaderChip"),
      aiHeaderChipText: document.getElementById("aiHeaderChipText"),
      aiAttention: document.getElementById("aiAttention"),
      // Telegram and Discord: one bot token each
      telegramEnabled: document.getElementById("settingsTelegramEnabled"),
      telegramToken: document.getElementById("settingsTelegramToken"),
      saveTelegramBtn: document.getElementById("saveTelegramBtn"),
      discordEnabled: document.getElementById("settingsDiscordEnabled"),
      discordToken: document.getElementById("settingsDiscordToken"),
      discordInviteGroup: document.getElementById("discordInviteGroup"),
      discordInviteLink: document.getElementById("discordInviteLink"),
      saveDiscordBtn: document.getElementById("saveDiscordBtn"),
      channelJump: document.getElementById("channelJump"),
      emailPresetHint: document.getElementById("emailPresetHint"),
      // WhatsApp channel (via WHAPI)
      whatsappEnabled: document.getElementById("settingsWhatsappEnabled"),
      whatsappToken: document.getElementById("settingsWhatsappToken"),
      whatsappWebhookUrl: document.getElementById("settingsWhatsappWebhookUrl"),
      whatsappWebhookCopy: document.getElementById("settingsWhatsappWebhookCopy"),
      whatsappWebhookRegenerate: document.getElementById("settingsWhatsappWebhookRegenerate"),
      saveWhatsappBtn: document.getElementById("saveWhatsappBtn"),
      // Slack channel (Socket Mode: a bot token and an app-level token)
      slackEnabled: document.getElementById("settingsSlackEnabled"),
      slackToken: document.getElementById("settingsSlackToken"),
      slackAppToken: document.getElementById("settingsSlackAppToken"),
      slackManifestCopy: document.getElementById("settingsSlackManifestCopy"),
      saveSlackBtn: document.getElementById("saveSlackBtn"),
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
      saveEmailChannelBtn: document.getElementById("saveEmailChannelBtn"),
      apiToken: document.getElementById("settingsApiToken"),
      apiTokenReveal: document.getElementById("settingsApiTokenReveal"),
      apiTokenCopy: document.getElementById("settingsApiTokenCopy"),
      // Mention mode (per-platform toggle for guild/group bots)
      discordMentionMode: document.getElementById("settingsDiscordMentionMode"),
      telegramMentionMode: document.getElementById("settingsTelegramMentionMode"),
      slackMentionMode: document.getElementById("settingsSlackMentionMode"),
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
      defaultVoiceGroup: document.getElementById("defaultVoiceGroup"),
      phononGroup: document.getElementById("phononGroup"),
      phononVoice: document.getElementById("settingsPhononVoice"),
      phononSpeed: document.getElementById("settingsPhononSpeed"),
      phononSpeedValue: document.getElementById("phononSpeedValue"),
      phononBarePeso: document.getElementById("settingsPhononBarePeso"),
      phononInstallStatus: document.getElementById("phononInstallStatus"),
      phononInstallBtn: document.getElementById("phononInstallBtn"),
      phononInstallProgress: document.getElementById("phononInstallProgress"),
      phononInstallHint: document.getElementById("phononInstallHint"),
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
        subscribed: "Enabled on this device.",
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

    // Settings → AI: the guides into their cards, the controls wired, and the header chip
    this.initAi();

    this.elements.saveTelegramBtn?.addEventListener("click", () => this.saveTokenChannel("telegram"));
    this.elements.saveDiscordBtn?.addEventListener("click", () => this.saveTokenChannel("discord"));
    this.drawChannelGuides();
    document.getElementById("saveAllowlistBtn")?.addEventListener("click", () => this.saveAllowlist());
    this.elements.saveMentionModeBtn?.addEventListener("click", () => this.saveMentionMode());
    this.elements.saveEmailChannelBtn?.addEventListener("click", () => this.saveEmailChannel());
    this.elements.saveWhatsappBtn?.addEventListener("click", () => this.saveWhatsappChannel());
    this.elements.whatsappWebhookCopy?.addEventListener("click", () => this.copyWhatsappWebhook());
    this.elements.whatsappWebhookRegenerate?.addEventListener("click", () => this.regenerateWhatsappSecret());
    this.elements.saveSlackBtn?.addEventListener("click", () => this.saveSlackChannel());
    this.elements.slackManifestCopy?.addEventListener("click", () => this.copySlackManifest());

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

    // Captcha solver settings. GET /api/settings sends a saved key as its masked display ("abcd...wxyz"): it is never
    // put in the box (Save would write the mask over the key). The line under the box says a key is saved, Save writes
    // only a key typed in, and Remove deletes the saved one.
    const saveCaptchaBtn = document.getElementById("saveCaptchaBtn");
    if (saveCaptchaBtn) {
      const keyBox = document.getElementById("captchaApiKey");
      const removeBtn = document.getElementById("removeCaptchaKeyBtn");
      const showSavedKey = (masked) => {
        const status = document.getElementById("captchaKeyStatus");
        const last4 = typeof masked === "string" && /^.{4}\.\.\..{4}$/.test(masked) ? ` …${masked.slice(-4)}` : "";
        keyBox.placeholder = masked ? `Saved${last4}` : "Your API key";
        if (status) {
          status.textContent = masked ? `A key is saved${last4}. Type a new one to replace it.` : "";
          status.hidden = !masked;
        }
        if (removeBtn) removeBtn.hidden = !masked;
      };
      saveCaptchaBtn.addEventListener("click", async () => {
        const service = document.getElementById("captchaService").value;
        const apiKey = keyBox.value.trim();
        try {
          await API.json("/api/settings/general", { method: "POST", body: { key: "captcha.service", value: service } });
          if (apiKey) {
            await API.json("/api/settings/general", { method: "POST", body: { key: "captcha.api_key", value: apiKey } });
            keyBox.value = "";
            showSavedKey(apiKey.length >= 12 ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : "****");
          }
          App.showToast("Captcha settings saved", "success");
        } catch { App.showToast("Failed to save", "error"); }
      });
      removeBtn?.addEventListener("click", async () => {
        try {
          await API.json("/api/settings/general", { method: "POST", body: { key: "captcha.api_key", value: "" } });
          showSavedKey(null);
          App.showToast("Captcha key removed", "success");
        } catch { App.showToast("Failed to remove the key", "error"); }
      });
      // Load existing values
      API.json("/api/settings").then(data => {
        const settings = data.settings || [];
        const svc = settings.find(s => s.key === "captcha.service")?.value;
        const key = settings.find(s => s.key === "captcha.api_key")?.value;
        if (svc) document.getElementById("captchaService").value = svc;
        showSavedKey(typeof key === "string" && key ? key : null);
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

    // STT save (provider + model; an OpenAI key pasted here is the one Settings → AI keeps)
    const saveSTTBtn = document.getElementById("saveSTTBtn");
    if (saveSTTBtn) {
      saveSTTBtn.addEventListener("click", async () => {
        const model = document.getElementById("settingsSTTModel").value;
        const provider = document.getElementById("settingsSTTProvider")?.value || "local";
        const keyBox = document.getElementById("settingsOpenaiKey");
        const openaiKey = keyBox?.value?.trim();
        try {
          // The OpenAI key is one slot, shared with the OpenAI API key card: saved through Settings → AI's own route,
          // with its checks, and never put back in the box.
          if (openaiKey) {
            await API.json("/api/ai/keys/openai", { method: "PUT", body: { apiKey: openaiKey } });
            keyBox.value = "";
          }
          await API.json("/api/voice/stt-model", { method: "POST", body: { model } });
          await API.json("/api/settings/general", { method: "POST", body: { key: "voice.stt_provider", value: provider } });
          App.showToast(`STT: ${provider}${provider === "local" ? ` (${model})` : ""}${openaiKey ? ", OpenAI key saved" : ""}`, "success");
          this.loadSTTModelStatus();
        } catch (e) { App.showToast(e.message, "error"); }
        // (The header's read draws the key's line again, and the header chip and the composer hear of a new key.)
        if (openaiKey) this.refreshAiHeader();
      });
      this.loadSTTModelStatus();

      // The speech-to-text choice saved
      API.json("/api/settings").then(data => {
        const provider = (data.settings || []).find(s => s.key === "voice.stt_provider")?.value;
        if (provider) document.getElementById("settingsSTTProvider").value = provider;
      }).catch(() => {});
    }

    // Show/hide ElevenLabs key field based on engine selection
    if (this.elements.voiceEngine) {
      this.elements.voiceEngine.addEventListener("change", () => {
        const val = this.elements.voiceEngine.value;
        const elGroup = document.getElementById("elevenlabsKeyGroup");
        if (elGroup) elGroup.style.display = val === "elevenlabs" ? "block" : "none";
        this.showPhononGroup(val === "phonon");
        // Reload voices for the selected engine (Phonon has its own list)
        if (val !== "phonon") this.loadVoicesForEngine(val);
      });
    }
    this.elements.phononSpeed?.addEventListener("input", () => {
      if (this.elements.phononSpeedValue) {
        this.elements.phononSpeedValue.textContent = Number(this.elements.phononSpeed.value).toFixed(2).replace(/0$/, "");
      }
    });
    this.elements.phononInstallBtn?.addEventListener("click", () => this.installPhonon());

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
    if (tabName === "ai") { this.loadAi(); }
    if (tabName === "voice") { this.refreshAiHeader(); }   // (draws the OpenAI key's line, drawSttKey)
    if (tabName === "security") { this.loadToolPermissions(); }
    if (tabName === "canvas") { this.loadCanvasGallery(); }
    if (tabName === "audit") { this.loadAuditLog(); }
    if (tabName === "health") { this.loadContextHealth(); }
  },

  async loadContextHealth() {
    const el = document.getElementById("contextHealthContent");
    if (!el) return;
    const btn = document.getElementById("refreshContextHealthBtn");
    if (btn && !btn._wired) { btn._wired = true; btn.addEventListener("click", () => this.loadContextHealth()); }
    el.textContent = "Loading…";
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const fmt = (n) => n >= 1000 ? Math.round(n / 1000) + "k" : String(n);
    try {
      const data = await API.json("/api/admin/context-health");
      if (!data.conversations || !data.conversations.length) { el.textContent = "No conversations yet."; return; }
      this._healthData = data;
      this._drawContextHealth();
    } catch (err) {
      el.textContent = "Could not load token health.";
    }
  },

  /**
   * Token Health's table: one row per chat, the AI it runs on (a column and a filter once more than one AI has
   * chats), its transcript (Claude Code keeps one per chat; Codex keeps none here) and how full its context is.
   */
  _drawContextHealth() {
    const el = document.getElementById("contextHealthContent");
    const data = this._healthData;
    if (!el || !data) return;
    const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const fmt = (n) => n >= 1000 ? Math.round(n / 1000) + "k" : String(n);
    const ais = [];
    for (const c of data.conversations) if (c.provider && !ais.some((a) => a.id === c.provider)) ais.push({ id: c.provider, label: c.providerLabel || c.provider });
    const several = ais.length > 1;
    if (!ais.some((a) => a.id === this._healthProvider)) this._healthProvider = "";
    const shown = data.conversations.filter((c) => !this._healthProvider || c.provider === this._healthProvider);
    const filter = several
      ? `<label class="text-sm" style="display:inline-flex;gap:6px;align-items:center;margin-bottom:8px">AI <select id="contextHealthProvider" class="ai-input">
          <option value="">All AIs</option>${ais.map((a) => `<option value="${esc(a.id)}"${a.id === this._healthProvider ? " selected" : ""}>${esc(a.label)}</option>`).join("")}
        </select></label>`
      : "";
    const body = shown.map((c) => {
      const color = c.status === "critical" ? "#ef4444" : c.status === "warning" ? "#f59e0b" : "#22c55e";
      const mb = c.transcriptMB != null ? c.transcriptMB + " MB" : (c.engine === "codex" ? '<span class="text-muted">no transcript</span>' : "—");
      const reset = c.willResetNextTurn ? ' <span style="color:#f59e0b;font-size:11px">↻ resets next turn</span>' : "";
      // An estimate must never be shown as if it were measured telemetry.
      const approx = c.measured ? "" : "~";
      const est = c.measured ? "" : ' <span style="color:var(--text-muted);font-size:11px">est.</span>';
      return `<tr style="border-top:1px solid var(--border)">
        <td style="padding:7px 8px">${esc(c.title)}</td>
        ${several ? `<td style="padding:7px 8px">${esc(c.providerLabel || c.provider || "")}</td>` : ""}
        <td style="padding:7px 8px;text-align:right">${c.messages}</td>
        <td style="padding:7px 8px;text-align:right;white-space:nowrap">${mb}${reset}</td>
        <td style="padding:7px 8px;text-align:right;white-space:nowrap">${approx}${fmt(c.contextTokens)} / ${fmt(c.contextWindow)}</td>
        <td style="padding:7px 8px;text-align:right;white-space:nowrap"><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${color};margin-right:6px"></span>${approx}${c.contextPct}%${est}</td>
      </tr>`;
    }).join("");
    el.innerHTML = `${filter}<div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:12px">
      <thead><tr style="text-align:left;color:var(--text-muted);font-size:11px;text-transform:uppercase;letter-spacing:.5px">
        <th style="padding:6px 8px">Conversation</th>${several ? '<th style="padding:6px 8px">AI</th>' : ""}<th style="padding:6px 8px;text-align:right">Msgs</th>
        <th style="padding:6px 8px;text-align:right">Transcript</th><th style="padding:6px 8px;text-align:right">Context</th>
        <th style="padding:6px 8px;text-align:right">Fill</th>
      </tr></thead><tbody>${body}</tbody></table></div>
      <div class="hint mt-2">Transcript cap: ${data.sessionCapMB} MB · under 80% is fine, 80 to 95% is a warning, past 95% it starts fresh · “est.” means no token telemetry recorded yet for that conversation. Codex-run chats (ChatGPT, OpenAI, Local AI) keep no Claude transcript here.</div>`;
    el.querySelector("#contextHealthProvider")?.addEventListener("change", (ev) => {
      this._healthProvider = ev.target.value;
      this._drawContextHealth();
    });
  },

  // --- Open / Close ---
  async open() {
    // The Usage page has its own address; Settings has none, so the open chat's goes back in the address bar.
    if (typeof Usage !== "undefined" && Usage.isOpen) Usage.close({ address: true });
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

    // Update topbar (and the tab's title)
    document.getElementById("topbarTitle").textContent = "Settings";
    const where = document.getElementById("topbarWhere");
    if (where) where.textContent = "";
    const chatMenu = document.getElementById("chatMenuBtn");
    if (chatMenu) chatMenu.disabled = true;   // (a chat's menu has nothing to do with Settings)
    if (typeof Chat !== "undefined") Chat._paintTitle?.();

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

    if (typeof Chat !== "undefined" && Chat.currentConversationId && chatArea.querySelector(".message")) {
      welcome.style.display = "none";
      chatArea.style.display = "flex";
      inputArea.style.display = "block";
    } else {
      welcome.style.display = "";
      chatArea.style.display = "none";
      inputArea.style.display = "block";
    }

    // Restore the topbar's name and the tab's title (plain names: no emoji)
    const chatMenu = document.getElementById("chatMenuBtn");
    if (chatMenu) chatMenu.disabled = false;
    if (typeof Chat !== "undefined" && Chat._paintHeader) Chat._paintHeader();
    else document.getElementById("topbarTitle").textContent = "Tarsee";

    // The composer was hidden while Settings was open: its model list and defaults, fresh, for whatever was changed
    // here (a key saved or removed, a model verified, Local AI's address, a sign-in).
    if (typeof Chat !== "undefined") { Chat.refreshPicker?.(true); Chat._loadPick?.({ fresh: true }); }

    // Un-highlight settings button
    this.elements.openBtn.classList.remove("settings-active");
  },

  async load() {
    try {
      const { settings } = await API.getSettings();

      // AI: every provider's card, the default AI and the switches (GET /api/ai/providers)
      this.loadAi({ settings });

      // Channels
      // Bot tokens are never sent to the browser any more — the server
      // reports `hasToken` instead. Show that the channel is configured and
      // leave the field empty; submitting it empty keeps the stored token,
      // and typing a new one rotates it.
      for (const type of ["discord", "telegram"]) {
        const config = settings.find((s) => s.key === `channel.${type}`)?.value;
        const el = this.elements[`${type}Token`];
        if (!el) continue;
        el.value = "";
        if (config?.hasToken) el.placeholder = "Stored — type a new token to replace it";
        const enabled = this.elements[`${type}Enabled`];
        if (enabled) enabled.checked = !!config?.enabled;
      }

      // Allowlists
      const telegramAllow = settings.find((s) => s.key === "allowlist.telegram")?.value;
      const discordAllow = settings.find((s) => s.key === "allowlist.discord")?.value;
      const slackAllow = settings.find((s) => s.key === "allowlist.slack")?.value;
      const whatsappAllow = settings.find((s) => s.key === "allowlist.whatsapp")?.value;
      if (telegramAllow) document.getElementById("settingsTelegramAllowlist").value = Array.isArray(telegramAllow) ? telegramAllow.join("\n") : telegramAllow;
      if (discordAllow) document.getElementById("settingsDiscordAllowlist").value = Array.isArray(discordAllow) ? discordAllow.join("\n") : discordAllow;
      const slackAllowEl = document.getElementById("settingsSlackAllowlist");
      if (slackAllow && slackAllowEl) slackAllowEl.value = Array.isArray(slackAllow) ? slackAllow.join("\n") : slackAllow;
      if (whatsappAllow) document.getElementById("settingsWhatsappAllowlist").value = Array.isArray(whatsappAllow) ? whatsappAllow.join("\n") : whatsappAllow;

      // Email channel
      this.loadEmailChannel(settings);

      // WhatsApp channel (via WHAPI)
      this.loadWhatsappChannel(settings);

      // Slack channel
      this.loadSlackChannel(settings);

      // Which channels have a token (or mail server) saved: one switched off then says "Off", not "Not set up".
      const cfgOf = (type) => settings.find((s) => s.key === `channel.${type}`)?.value || {};
      this._channelConfigured = {
        telegram: !!cfgOf("telegram").hasToken,
        discord: !!cfgOf("discord").hasToken,
        slack: !!(cfgOf("slack").hasToken || cfgOf("slack").hasAppToken),
        whatsapp: !!cfgOf("whatsapp").hasToken,
        email: !!cfgOf("email").imap?.host,
      };

      // Whether each channel is connected, and as whom
      this.refreshChannelStatuses();

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
      const slackMode = settings.find((s) => s.key === "slack.mention_mode")?.value;
      if (this.elements.slackMentionMode) {
        this.elements.slackMentionMode.value = slackMode === "off" ? "off" : "required";
      }
      if (this.elements.discordMentionMode) {
        this.elements.discordMentionMode.value = discordMode === "off" ? "off" : "required";
      }
      if (this.elements.telegramMentionMode) {
        this.elements.telegramMentionMode.value = telegramMode === "off" ? "off" : "required";
      }

      // Identity
      const botName = settings.find((s) => s.key === "identity.name")?.value;
      if (botName && this.elements.botName) this.elements.botName.value = botName;

      // Voice engine (unset means Phonon, the default)
      const voiceEngine = settings.find((s) => s.key === "voice.engine")?.value || "phonon";
      if (this.elements.voiceEngine) {
        this.elements.voiceEngine.value = voiceEngine;
      }
      // Show ElevenLabs key field if engine is elevenlabs
      const elGroup = document.getElementById("elevenlabsKeyGroup");
      if (elGroup) elGroup.style.display = voiceEngine === "elevenlabs" ? "block" : "none";
      this.showPhononGroup(voiceEngine === "phonon");

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

  // --- AI: Settings → AI, the header chip and its banner ---
  //
  // Everything comes from /api/ai (src/routes/ai.js). GET /providers draws the chips, the default AI, the switches and
  // one card per provider; each card's buttons call their own endpoint, then the cards are drawn again. The steps and
  // the status words come from js/provider-guides-core.js (window.ProviderGuides). Keys are never shown: only where a
  // key lives and its last 4 characters. A provider this version doesn't switch on (shipped: false) has no card.

  _ai: null,             // the last GET /api/ai/providers answer
  _aiAt: 0,              // when it came
  _aiSettings: null,     // the settings list (GET /api/settings), for the backup model and the monthly cap
  _aiModels: {},         // provider id → { models, at } (GET /api/ai/models/:id)
  _aiTest: {},           // provider id → the last Test, Verify or Save answer on its card ({ text, tone })
  _aiOpen: {},           // provider id → the state its guide was last unfolded or folded for
  _aiLoginCtl: null,     // the ChatGPT sign-in this page started ({ cancel })
  _aiLoginView: null,    // what that sign-in shows now
  _aiDismissed: null,    // "<provider>|<state>" of a header banner hidden for this visit

  _esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  },

  /** The guides into their cards, the controls wired, and the header chip kept up to date. */
  initAi() {
    const G = window.ProviderGuides;
    const e = this.elements;
    if (G) {
      for (const p of G.PROVIDERS) {
        const slot = document.querySelector(`[data-ai-guide-slot="${p.id}"]`);
        if (slot) slot.innerHTML = G.guideHtml(p.id, { open: true });
        const needs = document.querySelector(`[data-ai-needs="${p.id}"]`);
        if (needs) needs.textContent = p.needs;
      }
      if (e.aiTermsNote) e.aiTermsNote.innerHTML = G.TERMS_NOTE;
    }
    if (e.aiKeysOnlyNote) e.aiKeysOnlyNote.dataset.text = e.aiKeysOnlyNote.textContent.trim();
    e.aiChips?.addEventListener("click", (ev) => {
      const chip = ev.target.closest("[data-ai-jump]");
      if (chip) this.focusAi(chip.dataset.aiJump);
    });
    e.aiPanel?.addEventListener("click", (ev) => this._aiClick(ev));
    e.aiPanel?.addEventListener("change", (ev) => {
      const bg = ev.target.closest("[data-ai-bg-model]");
      if (bg) { this.saveAiBackgroundModel(bg.closest("[data-ai]")?.dataset.ai, bg.value); return; }
      const select = ev.target.closest("[data-ai-model]");
      if (select) this.saveAiModel(select.closest("[data-ai]")?.dataset.ai, select.value);
    });
    e.aiPanel?.addEventListener("input", (ev) => {
      if (ev.target.matches("[data-ai-or-search]")) this._aiDrawOpenRouter();
    });
    e.aiKeysOnly?.addEventListener("change", () => this.saveKeysOnly());
    e.aiSaveExtrasBtn?.addEventListener("click", () => this.saveAiExtras());
    e.aiBanners?.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-ai-banner-use]");
      if (b) this.useAi(b.dataset.aiBannerUse, b);
      const fix = ev.target.closest("[data-ai-banner-fix]");
      if (fix) this.fixSettingsFile(fix.dataset.aiBannerFix, fix);
    });
    e.aiHeaderChip?.addEventListener("click", () => this.openAiSettings());
    e.aiAttention?.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-ai-attention]");
      if (!b) return;
      if (b.dataset.aiAttention === "open") this.openAiSettings();
      else {
        const a = this._ai?.active;
        this._aiDismissed = a ? `${a.provider}|${a.state}` : null;
        e.aiAttention.hidden = true;
      }
    });

    // The header chip: now, every 5 minutes while the page is in view, and on coming back to it.
    this.refreshAiHeader();
    clearInterval(this._aiHeaderTimer);
    this._aiHeaderTimer = setInterval(() => { if (!document.hidden) this.refreshAiHeader(); }, 5 * 60 * 1000);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && Date.now() - this._aiAt > 60 * 1000) this.refreshAiHeader();
    });
  },

  /** Settings → AI opened (from the header chip, its banner, or a link). */
  async openAiSettings() {
    if (!this.isOpen) await this.open();
    this.switchTab("ai");
  },

  /** The AI tab shown, at a provider's card when id names one (js/model-picker.js calls this after Settings.open()). */
  focusAI(id) {
    this.switchTab("ai");
    if (id) this.focusAi(id);
  },

  /** The providers this version switches on, as GET /api/ai/providers drew them. */
  _aiShipped() {
    return (this._ai?.providers || []).filter((c) => c.shipped);
  },

  _aiCard(id) {
    return (this._ai?.providers || []).find((c) => c.id === id) || null;
  },

  /**
   * Read every provider again and draw the AI tab and the header. settings: the settings list if the caller has it
   * (the backup model and the cap live there). refresh: read OpenRouter's and DeepSeek's balances now, not from cache.
   */
  async loadAi({ settings = null, refresh = false } = {}) {
    let data;
    try {
      data = await API.json(`/api/ai/providers${refresh ? "?refresh=1" : ""}`);
    } catch (err) {
      if (this.elements.aiDefaultNow) {
        this.elements.aiDefaultNow.textContent = `Couldn't read the AI settings: ${err.message}`;
        this.elements.aiDefaultNow.dataset.tone = "bad";
      }
      return null;
    }
    this._ai = data;
    this._aiAt = Date.now();
    this._aiNoticeChange();
    if (!settings) {
      try { settings = (await API.getSettings()).settings; } catch { settings = this._aiSettings || []; }
    }
    this._aiSettings = settings || [];
    this.drawAi();
    this.drawAiHeader();
    this.drawSttKey();
    for (const c of this._aiShipped()) {
      // ChatGPT's list is the signed-in account's own; Local AI's comes from its server once it has an address.
      if (c.id === "chatgpt" && !c.ready) continue;
      if (c.id === "local" && !c.settings?.baseUrl) continue;
      this.loadAiModels(c.id);
    }
    return data;
  },

  /**
   * Tell the composer (js/chat.js) when a fresh GET /api/ai/providers changed what its model button and list show:
   * the default AI, its model, whether it can answer, "Only use API keys", or which AIs are ready (and on which
   * model). Every read goes through here, so a change made on this page, in a chat command's wake or on another
   * device is caught the same way. detail.defaultChanged: what the next message runs on changed, so the model the
   * last turn ran on is no longer the one to show. The first read only sets what is compared against.
   */
  _aiNoticeChange() {
    const d = this._ai;
    if (!d) return;
    const a = d.active || {};
    const def = [a.provider, a.model, !!a.ready, !!d.keysOnly?.on].join("|");
    const ready = (d.providers || []).filter((c) => c.ready).map((c) => `${c.id}:${c.model || ""}`).sort().join(",");
    const was = this._aiSeen;
    this._aiSeen = { def, ready };
    if (!was || (was.def === def && was.ready === ready)) return;
    window.dispatchEvent(new CustomEvent("tarsee:ai-changed", { detail: { defaultChanged: was.def !== def, provider: a.provider || null } }));
  },

  /** A provider's models (GET /api/ai/models/:id), kept a minute unless force. Draws its card's model list. */
  async loadAiModels(id, { force = false } = {}) {
    const have = this._aiModels[id];
    if (!force && have && Date.now() - have.at < 60 * 1000) {
      this._aiDrawModels(id);
      return have;
    }
    try {
      const r = await API.json(`/api/ai/models/${encodeURIComponent(id)}`);
      // note: what the list says about itself (a model DeepSeek doesn't list for this key, ChatGPT's list unread).
      const note = typeof r.note === "string" && r.note.trim() ? r.note : null;
      this._aiModels[id] = { models: Array.isArray(r.models) ? r.models : [], note, at: Date.now() };
    } catch (err) {
      this._aiModels[id] = { models: have?.models || [], note: have?.note || null, at: Date.now(), error: err.message };
    }
    this._aiDrawModels(id);
    const c = this._aiCard(id);
    if (c) this._aiDrawStatus(c);
    if (this._ai?.active?.provider === id) { this.drawAiHeader(); this._aiDrawDefault(); }
    if (c?.ready) this._aiDrawSwitches();
    return this._aiModels[id];
  },

  /** A model's name in words: its label from the list, a Claude size word capitalised, or the id. */
  _aiModelLabel(id, model) {
    if (!model) return id === "chatgpt" ? "your account's default model" : "its default model";
    const m = this._aiModels[id]?.models?.find((x) => x.id === model);
    if (m?.label && m.label !== m.id) return m.label;
    if (/^(fable|opus|sonnet|haiku)(\[1m\])?$/i.test(model)) return model[0].toUpperCase() + model.slice(1);
    return model;
  },

  drawAi() {
    const data = this._ai;
    const G = window.ProviderGuides;
    if (!data || !G) return;
    for (const p of G.PROVIDERS) {
      const el = document.getElementById(p.section);
      if (el) el.hidden = !this._aiCard(p.id)?.shipped;
    }
    this._aiDrawChips();
    this._aiDrawBanners();
    this._aiDrawDefault();
    this._aiDrawSwitches();
    for (const c of this._aiShipped()) this._aiDrawCard(c);
  },

  _aiDrawChips() {
    const G = window.ProviderGuides;
    const el = this.elements.aiChips;
    if (!el) return;
    this._aiSetHtml(el, this._aiShipped().map((c) => {
      const p = G.get(c.id);
      return `<button type="button" class="channel-chip ai-chip" data-ai-jump="${c.id}"${c.active ? ' aria-current="true"' : ""}>` +
        `<span class="channel-dot" data-tone="${G.toneOf(c.state)}"></span>${this._esc(p?.shortName || c.label)} · ${this._esc(G.stateWord(c.state))}${c.active ? " · default" : ""}</button>`;
    }).join(""));
  },

  /**
   * Put this markup in el, unless it's what el already shows. Every read of the AIs draws the page again, and opening
   * Settings reads them more than once: rebuilding a part that didn't change would take away the box someone is in,
   * its caret, and a click under way (pressed on the old button, let go on the new one, it is no click at all).
   * @returns {boolean} whether el was rebuilt
   */
  _aiSetHtml(el, html) {
    if (el._aiHtml === html) return false;
    el.innerHTML = html;
    el._aiHtml = html;
    return true;
  },

  /** The box or button someone is in, inside root, and their caret, to give back when root is built again. */
  _aiFocusOf(root) {
    const el = document.activeElement;
    if (!el || el === root || !root.contains(el)) return null;
    // A list (select) is drawn by custom-select.js, which moves a new one into its wrapper and takes the focus off it
    // on the next frame: focus on it can't be kept, and a focused list isn't filled with its models.
    if (el.tagName === "SELECT") return null;
    const esc = (s) => (window.CSS?.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, "\\$&"));
    // A button is found again by all its data- attributes: several share an action (each model's Choose and Verify,
    // Local AI's presets) and only their data-model or data-url tells them apart.
    const dataSel = () => [...el.attributes].filter((a) => a.name.startsWith("data-")).map((a) => `[${a.name}="${esc(a.value)}"]`).join("");
    const sel = el.id ? `#${esc(el.id)}`
      : el.dataset?.keep ? `[data-keep="${esc(el.dataset.keep)}"]`
      : el.dataset?.aiAction ? dataSel()
      : null;
    // Only what is found again for sure: focus put on another button (another model's Choose) would act on that one.
    if (!sel || root.querySelectorAll(sel).length !== 1) return null;
    let range = null;
    try {
      if (typeof el.selectionStart === "number") range = [el.selectionStart, el.selectionEnd, el.selectionDirection || "none"];
    } catch { /* a box with no caret (a number box): focus alone */ }
    return { sel, range };
  },
  _aiRefocus(root, focus) {
    if (!focus) return;
    const el = root.querySelector(focus.sel);
    if (!el) return;
    el.focus({ preventScroll: true });
    if (focus.range) {
      try { el.setSelectionRange(...focus.range); } catch { /* a box with no caret */ }
    }
  },

  _aiDrawBanners() {
    const el = this.elements.aiBanners;
    if (!el) return;
    this._aiSetHtml(el, (this._ai?.banners || []).map((b) => {
      let action = "";
      if (b.action?.kind === "settings-guard" && b.action.file) {
        action = ` <button type="button" class="btn btn-sm" data-ai-banner-fix="${this._esc(b.action.file)}">${this._esc(b.action.label || "Remove these entries")}</button>`;
      } else if (b.action?.provider) {
        action = ` <button type="button" class="btn btn-sm" data-ai-banner-use="${this._esc(b.action.provider)}">${this._esc(b.action.label || "Use it")}</button>`;
      }
      return `<div class="ai-banner" data-level="${this._esc(b.level || "info")}"><span>${this._esc(b.message)}</span>${action}</div>`;
    }).join(""));
  },

  _aiDrawDefault() {
    const el = this.elements.aiDefaultNow;
    const a = this._ai?.active;
    if (!el || !a) return;
    const how = a.chosenBy === "env" ? " (set by the Railway variable TARSEE_AI_PROVIDER)"
      : a.chosenBy === "default" ? " (nothing chosen yet, so Tarsee starts with the Claude plan)" : "";
    const model = this._aiModelLabel(a.provider, a.model);
    el.textContent = a.ready
      ? `✓ ${a.label}, using ${model}${how}`
      : `${a.label}${how} can't answer right now: ${[a.detail, a.fix].filter(Boolean).join(" ")}`;
    el.dataset.tone = a.ready ? "ok" : "bad";
  },

  _aiDrawSwitches() {
    const e = this.elements;
    const k = this._ai?.keysOnly || { on: false, locked: false };
    // With no API-key AI switched on in this version, the switch would only silence Tarsee: it isn't offered then,
    // unless it is already on (it shows, so it can be switched off).
    const anyKey = this._aiShipped().some((c) => c.kind !== "subscription");
    const group = e.aiKeysOnly?.closest(".form-group");
    if (group) group.hidden = !(anyKey || k.on || k.locked);
    if (e.aiKeysOnly) {
      e.aiKeysOnly.checked = !!k.on;
      e.aiKeysOnly.disabled = !!k.locked;
    }
    if (e.aiKeysOnlyNote) {
      e.aiKeysOnlyNote.textContent = k.locked
        ? "Locked on by the Railway variable TARSEE_KEYS_ONLY=1: the Claude and ChatGPT plan sign-ins stay off. Remove that variable to change it here."
        : (e.aiKeysOnlyNote.dataset.text || "");
    }

    // The backup model: Off, or a ready AI with its model. The one saved stays listed even when it isn't ready now.
    // Neither it nor the cap saves on change (only "Save backup and cap" does), and every card action draws this
    // again: a choice not saved yet stays chosen (dataset.drawn and defaultValue hold what was last drawn as saved).
    const setting = (key) => (this._aiSettings || []).find((s) => s.key === key)?.value;
    const saved = typeof setting("ai.backupModel") === "string" ? setting("ai.backupModel") : "";
    const sel = e.aiBackupModel;
    if (sel && document.activeElement !== sel) {
      const dirty = "drawn" in sel.dataset && sel.value !== sel.dataset.drawn;
      const want = dirty ? sel.value : saved;
      const options = [{ value: "", label: "Off" }];
      for (const c of this._aiShipped()) {
        if (!c.ready || !c.model) continue;
        options.push({ value: `${c.id}:${c.model}`, label: `${c.label} · ${this._aiModelLabel(c.id, c.model)}` });
      }
      for (const v of new Set([saved, want])) {
        if (v && !options.some((o) => o.value === v)) options.push({ value: v, label: `${v} (not ready now)` });
      }
      sel.innerHTML = options.map((o) => `<option value="${this._esc(o.value)}">${this._esc(o.label)}</option>`).join("");
      sel.value = want;
      if (!dirty) sel.dataset.drawn = saved;
    }
    const cap = e.aiMonthlyCap;
    if (cap && document.activeElement !== cap && cap.value === cap.defaultValue) {
      const v = setting("ai.spendCap.monthlyUsd");
      const s = v === undefined || v === null ? "" : String(v).replace(/[$,\s]/g, "");
      cap.value = s;
      cap.defaultValue = s;
    }
    // What API-key AIs have cost so far this month (GET /api/ai/providers), next to the cap.
    const spent = e.aiMonthSpend;
    const sp = this._ai?.spend;
    if (spent) {
      const usd = Number(sp?.monthUsd);
      spent.hidden = !(sp && Number.isFinite(usd));
      if (!spent.hidden) {
        const money = (n) => `$${n < 10 ? n.toFixed(2) : n.toFixed(0)}`;
        // costNote "exact": every cost is the provider's own figure (Anthropic's, OpenRouter's); anything else, or an
        // answer without it, holds an estimate from the price table.
        const est = sp.costNote === "exact" ? "" : " (est.)";
        spent.textContent = `Spent so far this month: ${money(usd)}${est}${sp.capUsd ? ` of your ${money(Number(sp.capUsd))} cap` : ""}.`;
      }
    }
  },

  /** One provider's card: its status line, its guide (unfolded until it's ready) and its controls. */
  _aiDrawCard(c) {
    const G = window.ProviderGuides;
    const p = G.get(c.id);
    if (!p) return;
    const section = document.getElementById(p.section);
    if (!section) return;
    this._aiDrawStatus(c);
    const guide = section.querySelector(".ai-guide");
    if (guide && this._aiOpen[c.id] !== c.state) {
      guide.open = !c.ready;
      this._aiOpen[c.id] = c.state;
    }
    const body = section.querySelector("[data-ai-body]");
    if (!body) return;
    const html = this._aiBodyHtml(c);
    let focus = null;
    if (body._aiHtml !== html) {
      // Built again: what someone typed and hasn't saved, the part they opened or closed (OpenRouter's whole list,
      // Local AI's key) and the box they are in, caret and all, stay as they were.
      const kept = this._aiKeep(body);
      focus = this._aiFocusOf(body);
      const opened = new Map([...body.querySelectorAll("details[class]")].map((d) => [d.className, d.open]));
      this._aiSetHtml(body, html);
      body.querySelectorAll("details[class]").forEach((d) => { if (opened.has(d.className)) d.open = opened.get(d.className); });
      this._aiRestore(body, kept);
    }
    this._aiDrawModels(c.id);
    if (c.id === "chatgpt") this.renderChatgptLogin(body.querySelector("[data-ai-device]"), this._aiLoginView);
    // Focus goes back last, once the card's lists are filled: a list that has the focus isn't filled (it may be open).
    this._aiRefocus(body, focus);
  },

  /** A card's status line (again once its model list, and so the model's name, is in). */
  _aiDrawStatus(c) {
    const G = window.ProviderGuides;
    const status = document.getElementById(`${c.id}AiStatus`);
    if (!G || !status) return;
    const { text, tone } = G.statusLine(c, { modelLabel: c.model ? this._aiModelLabel(c.id, c.model) : null });
    status.textContent = tone === "ok" ? `✓ ${text}` : tone === "bad" ? `✗ ${text}` : text;
    status.dataset.tone = tone;
  },

  /** What someone typed in a card (and hasn't saved), so drawing it again doesn't lose it. */
  _aiKeep(root) {
    const out = {};
    root.querySelectorAll("[data-keep]").forEach((el) => {
      if (el.value !== el.defaultValue) out[el.dataset.keep] = el.value;
    });
    return out;
  },
  _aiRestore(root, kept) {
    for (const [name, value] of Object.entries(kept)) {
      const el = root.querySelector(`[data-keep="${name}"]`);
      if (el) el.value = value;
    }
  },

  _aiBodyHtml(c) {
    const esc = (s) => this._esc(s);
    const parts = [];
    if (c.notes?.length) parts.push(`<ul class="ai-notes">${c.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`);
    if (c.state === "blocked-keys-only") {
      parts.push(`<div class="ai-note-off">"Only use API keys" is on, so this plan sign-in isn't used. Switch it off at the top of this page to use it.</div>`);
      return parts.join("");
    }
    if (c.id === "claude") parts.push(this._aiClaudeHtml(c));
    else if (c.id === "chatgpt") parts.push(this._aiChatgptHtml(c));
    else if (c.id === "local") parts.push(this._aiLocalHtml(c));
    else parts.push(this._aiKeyHtml(c));
    const t = this._aiTest[c.id];
    parts.push(`<div class="ai-test-result" data-ai-test aria-live="polite"${t ? ` data-tone="${t.tone}"` : ""}>${t ? esc(t.text) : ""}</div>`);
    parts.push(this._aiModelHtml(c));
    if (c.id === "openrouter") parts.push(this._aiOpenRouterHtml());
    return parts.join("");
  },

  _aiKeySourceHtml(c, { none = "No key yet." } = {}) {
    if (!c.keySource) return `<div class="ai-keysource">${this._esc(none)}</div>`;
    const where = c.keySourceText || c.keySource;
    return `<div class="ai-keysource">Key: ${this._esc(where)}${c.keyHint ? ` <code>${this._esc(c.keyHint)}</code>` : ""}</div>`;
  },

  _aiKeyFormHtml(c, { label, placeholder }) {
    const id = c.id;
    return `<form class="ai-key-form" autocomplete="off" data-no-submit>` +
      `<label class="ai-label" for="aiKey-${id}">${this._esc(label)}</label>` +
      `<div class="ai-inline">` +
      `<input type="password" id="aiKey-${id}" class="ai-input" data-ai-key data-keep="key" placeholder="${this._esc(placeholder || "")}" autocomplete="off" spellcheck="false" autocapitalize="off">` +
      `<button type="button" class="btn btn-sm btn-primary" data-ai-action="save-key">Save key</button>` +
      `</div></form>`;
  },

  _aiKeyHtml(c) {
    const p = window.ProviderGuides.get(c.id);
    const fromEnv = (c.keySource || "").startsWith("env:");
    return this._aiKeySourceHtml(c) +
      this._aiKeyFormHtml(c, { label: c.keySource ? "Replace the key" : "API key", placeholder: p?.keyPlaceholder }) +
      (fromEnv ? `<div class="hint">A key saved here is used instead of the Railway variable; remove it here to go back to the variable.</div>` : "") +
      `<div class="ai-actions">` +
      `<button type="button" class="btn btn-sm" data-ai-action="test">Test</button>` +
      (c.keySource === "settings" ? `<button type="button" class="btn btn-sm btn-ghost" data-ai-action="remove-key">Remove key</button>` : "") +
      (p?.getKeyUrl ? `<a class="btn btn-sm btn-ghost" href="${p.getKeyUrl}" target="_blank" rel="noopener noreferrer">Get a key ↗</a>` : "") +
      `</div>`;
  },

  _aiClaudeHtml(c) {
    const p = window.ProviderGuides.get("claude");
    const how = c.keySourceText ? `<div class="ai-keysource">${this._esc(c.keySourceText)}</div>` : "";
    return how + `<div class="ai-actions">` +
      `<a class="btn btn-sm" href="/terminal.html" target="_blank" rel="noopener noreferrer">Open the Terminal ↗</a>` +
      `<button type="button" class="setup-copy-chip" data-copy="${p.command}" aria-label="Copy the command ${p.command}"><span class="setup-copy-cmd">${p.command}</span><span class="setup-copy-label">Copy</span></button>` +
      `<button type="button" class="btn btn-sm btn-primary" data-ai-action="test">Check</button>` +
      `</div>`;
  },

  _aiChatgptHtml(c) {
    const signedIn = c.keySource === "sign-in" || !!c.account || c.ready;
    let html = c.account ? `<div class="ai-keysource">Signed in as ${this._esc(c.account)}</div>` : "";
    html += `<div class="ai-actions">`;
    if (!c.ready) html += `<button type="button" class="btn btn-sm btn-primary" data-ai-action="chatgpt-login">Sign in with ChatGPT</button>`;
    if (signedIn) html += `<button type="button" class="btn btn-sm" data-ai-action="test">Check</button><button type="button" class="btn btn-sm btn-ghost" data-ai-action="chatgpt-logout">Sign out</button>`;
    html += `</div><div class="ai-device" data-ai-device hidden></div>`;
    return html;
  },

  _aiLocalHtml(c) {
    const p = window.ProviderGuides.get("local");
    const s = c.settings || {};
    const presets = p.presets.map((x) => `<button type="button" class="btn btn-sm btn-ghost" data-ai-action="preset" data-url="${x.url}">${x.name}</button>`).join("");
    // The context box holds only what the owner saved: empty means "what the server says, else the default", shown as
    // its placeholder, so a Save that didn't touch it never stores a number nobody chose.
    const n = (v) => Number(v).toLocaleString("en-US");
    const placeholder = s.serverContext ? `${n(s.serverContext)}, read from your server` : `${n(s.defaultContext || 128000)} unless you set it`;
    const used = s.context && s.serverContext && s.serverContext < s.context
      ? `<div class="hint" data-ai-local-context-note>Your server gives this model ${n(s.serverContext)}, so Tarsee uses that.</div>`
      : "";
    return `<label class="ai-label" for="aiLocalUrl">Server address</label>` +
      `<div class="ai-presets">Fill in: ${presets}</div>` +
      (p.presetNote ? `<div class="hint">${p.presetNote}</div>` : "") +
      `<input type="url" id="aiLocalUrl" class="ai-input" data-keep="url" value="${this._esc(s.baseUrl || "")}" placeholder="http://localhost:11434/v1" autocomplete="off" spellcheck="false" autocapitalize="off">` +
      `<label class="ai-label" for="aiLocalContext">How much it can read at once, in tokens</label>` +
      `<input type="number" id="aiLocalContext" class="ai-input ai-input-short" data-keep="context" value="${this._esc(s.context || "")}" placeholder="${this._esc(placeholder)}" min="1000" step="any" inputmode="numeric">` +
      used +
      `<div class="ai-actions"><button type="button" class="btn btn-sm btn-primary" data-ai-action="save-local">Save</button>` +
      `<button type="button" class="btn btn-sm" data-ai-action="test">Test</button></div>` +
      `<details class="ai-local-key"${c.keySource ? " open" : ""}><summary>A key, if your server asks for one</summary>` +
      this._aiKeySourceHtml(c, { none: "No key: none is sent." }) +
      this._aiKeyFormHtml(c, { label: c.keySource ? "Replace the key" : "Key", placeholder: p.keyPlaceholder }) +
      (c.keySource === "settings" ? `<div class="ai-actions"><button type="button" class="btn btn-sm btn-ghost" data-ai-action="remove-key">Remove key</button></div>` : "") +
      `</details>`;
  },

  _aiModelHtml(c) {
    const active = this._ai?.active?.provider === c.id;
    const use = active
      ? `<span class="ai-default-badge">✓ Your default AI</span>`
      : `<button type="button" class="btn btn-sm btn-primary" data-ai-action="use"${c.ready ? "" : " disabled"}>Use this AI</button>`;
    // Local AI: each of the server's models gets its own row (with its own Verify), so verifying one never changes
    // the card's model (_aiDrawLocalModels).
    const localList = c.id === "local" ? `<div class="ai-local-models" data-ai-local-list hidden></div>` : "";
    // The OpenAI key: a newer model its list lacks is checked by its id (Verify runs that exact model), and once it
    // passes it is in the list above and in a chat's model menu.
    const custom = c.id === "openai" && c.ready
      ? `<details class="ai-custom-model"><summary>A model that isn't in this list</summary>` +
        `<div class="hint">A newer OpenAI model your key can use: type its id as OpenAI names it, then Verify. That's a short check that it can use Tarsee's tools, and it costs a few cents on your key. Once it passes, you can choose it here and in a chat's model menu.</div>` +
        `<div class="ai-inline"><input type="text" class="ai-input" data-ai-custom-model data-keep="custom-model" placeholder="The model's id" aria-label="OpenAI model id" autocomplete="off" spellcheck="false" autocapitalize="off">` +
        `<button type="button" class="btn btn-sm" data-ai-action="verify-custom">Verify</button></div></details>`
      : "";
    const why = !c.ready && !active ? `<div class="hint">Once its line says Ready, you can make it your default.</div>` : "";
    // Background jobs (scheduled tasks, summaries) run on ai.<id>.backgroundModel, else the cheapest (turn.js).
    const bg = c.ready
      ? `<label class="ai-label" for="aiBgModel-${c.id}">Background jobs use</label>` +
        `<select id="aiBgModel-${c.id}" class="ai-input" data-ai-bg-model></select>` +
        `<div class="hint">Scheduled tasks and other work done without a chat. The cheapest model keeps them cheap.</div>`
      : "";
    return `<div class="ai-model-row">` +
      `<label class="ai-label" for="aiModel-${c.id}">Model</label>` +
      `<div class="ai-inline"><select id="aiModel-${c.id}" class="ai-input" data-ai-model></select>${use}</div>` +
      `<div class="hint" id="aiModelNote-${c.id}" hidden></div>${localList}${custom}${why}${bg}` +
      `</div>`;
  },

  /** The background model saved for a provider ("" when it's left to the cheapest), under the id its card says it is stored by. */
  _aiSavedBackground(id) {
    const sid = this._aiCard(id)?.storageId || id;
    const v = (this._aiSettings || []).find((s) => s.key === `ai.${sid}.backgroundModel`)?.value;
    return typeof v === "string" ? v.trim() : "";
  },

  /** A card's model list: the ones it can use now (OpenRouter's others are under "All OpenRouter models"). */
  _aiDrawModels(id) {
    const c = this._aiCard(id);
    const sel = document.getElementById(`aiModel-${id}`);
    const bgSel = document.getElementById(`aiBgModel-${id}`);
    if (!c || !sel) {
      if (id === "openrouter") this._aiDrawOpenRouter();
      return;
    }
    const models = (this._aiModels[id]?.models || []).filter((m) => !m.needsVerification);
    const noteEl = document.getElementById(`aiModelNote-${id}`);
    if (noteEl) {
      const note = this._aiModels[id]?.note || "";
      noteEl.textContent = note;
      noteEl.hidden = !note;
    }
    const opts = [];
    if (id === "chatgpt" || id === "local") opts.push({ value: "", label: id === "chatgpt" ? "Your account's default" : "Choose a model" });
    for (const m of models) {
      const bits = [m.label && m.label !== m.id ? m.label : m.id];
      if (m.free) bits.push("Free");
      if (m.verified) bits.push("Verified");
      // (the provider's own list leaves it out for this key, so a turn on it would be refused)
      if (m.confirmed === false) bits.push("Not listed for this key");
      opts.push({ value: m.id, label: bits.join(" · ") });
    }
    if (c.model && !opts.some((o) => o.value === c.model)) opts.unshift({ value: c.model, label: this._aiModelLabel(id, c.model) });
    const html = (list) => list.map((o) => `<option value="${this._esc(o.value)}">${this._esc(o.label)}</option>`).join("");
    // (A list someone has open is left alone: drawing it again would close it.)
    if (bgSel && document.activeElement !== bgSel) {
      const saved = this._aiSavedBackground(id);
      const bgOpts = [{ value: "", label: "Automatic: the cheapest model" }, ...opts.filter((o) => o.value)];
      if (saved && !bgOpts.some((o) => o.value === saved)) bgOpts.push({ value: saved, label: this._aiModelLabel(id, saved) });
      bgSel.innerHTML = html(bgOpts);
      bgSel.value = saved;
    }
    if (document.activeElement !== sel) {
      if (!opts.length) opts.push({ value: "", label: this._aiModels[id] ? "No models yet" : "Loading…" });
      sel.innerHTML = html(opts);
      sel.value = c.model || "";
    }
    if (id === "openrouter") this._aiDrawOpenRouter();
    if (id === "local") this._aiDrawLocalModels(c);
  },

  /**
   * Local AI's models, a row each (GET /api/ai/models/local): the one chosen on the card, and any verified one, are in
   * a chat's model menu (inMenu); any other needs a Verify first, on its own row, so verifying it never changes the
   * card's model.
   */
  _aiDrawLocalModels(c) {
    const list = document.querySelector("#localAiCard [data-ai-local-list]");
    if (!list) return;
    const esc = (s) => this._esc(s);
    const models = this._aiModels.local?.models || [];
    list.hidden = !models.length;
    if (!models.length) { this._aiDrawList(list, ""); return; }
    const row = (m) => {
      const inMenu = m.inMenu === true || m.verified === true || m.id === c?.model;
      const badges = (m.verified ? `<span class="ai-badge" data-kind="ok">Verified</span>` : "")
        + (m.recheck ? `<span class="ai-badge" data-kind="warn" title="It was verified on an older version of Tarsee's engine: Verify it again to be sure it still works.">Check again</span>` : "");
      const k = (v) => (v % 1024 === 0 ? `${v / 1024}K` : `${Math.round(v / 1000)}K`);
      const ctx = m.context ? `${k(m.context)} context${m.serverContext ? " (from your server)" : ""}` : "";
      const meta = [inMenu ? "In a chat's model menu" : "Verify to use it in a chat", ctx].filter(Boolean).join(" · ");
      const btn = `<button type="button" class="btn btn-sm${inMenu ? " btn-ghost" : ""}" data-ai-action="verify" data-model="${esc(m.id)}">${m.verified ? "Verify again" : "Verify"}</button>`;
      return `<div class="ai-or-row" data-ai-local-row><div class="ai-or-name"><span>${esc(m.label || m.id)}</span>${badges}<div class="ai-or-meta">${esc(meta)}</div></div>${btn}</div>`;
    };
    this._aiDrawList(list, `<div class="ai-or-title">Your server's models (${models.length})</div>` +
      `<div class="hint">Verify checks that a model can use Tarsee's tools, which is worth doing for small models.</div>` +
      models.map(row).join(""));
  },

  /**
   * A card's list of models (Local AI's, OpenRouter's), drawn again each time the models are read: only when it
   * changed, and with the focus given back to the very model's button someone is on, so Enter verifies or chooses
   * the model they were on.
   */
  _aiDrawList(list, html) {
    if (list._aiHtml === html) return;
    const focus = this._aiFocusOf(list);
    this._aiSetHtml(list, html);
    this._aiRefocus(list, focus);
  },

  _aiOpenRouterHtml() {
    return `<details class="ai-or"><summary>All OpenRouter models</summary>` +
      `<div class="hint">Claude and OpenAI models work straight away. Any other model needs one <strong>Verify</strong> first: a short check that it can use Tarsee's tools (it costs a few cents).</div>` +
      `<input type="search" class="ai-input" data-ai-or-search data-keep="search" placeholder="Search: gemini, qwen, free…" aria-label="Search OpenRouter's models" autocomplete="off">` +
      `<div class="ai-or-list" data-ai-or-list></div></details>`;
  },

  /** OpenRouter's whole list, searchable: verified by you, ready to use, then everything else (Verify to use). */
  _aiDrawOpenRouter() {
    const card = document.getElementById("openrouterAiCard");
    const list = card?.querySelector("[data-ai-or-list]");
    if (!list) return;
    const esc = (s) => this._esc(s);
    const q = (card.querySelector("[data-ai-or-search]")?.value || "").trim().toLowerCase();
    const have = this._aiModels.openrouter;
    const models = have?.models || [];
    if (!models.length) {
      this._aiDrawList(list, `<div class="hint">${have ? esc(have.error || "OpenRouter's model list isn't in yet. Try again in a minute.") : "Loading the model list…"}</div>`);
      return;
    }
    const match = (m) => !q || (q === "free" ? m.free : `${m.id} ${m.label || ""}`.toLowerCase().includes(q));
    const price = (m) => {
      if (m.free) return "Free";
      const p = m.price;
      return p && Number.isFinite(p.in) && Number.isFinite(p.out) ? `$${Number(p.in.toPrecision(3))} in, $${Number(p.out.toPrecision(3))} out per million tokens` : "";
    };
    const row = (m) => {
      const badges = (m.free ? `<span class="ai-badge" data-kind="free">Free</span>` : "") + (m.verified ? `<span class="ai-badge" data-kind="ok">Verified</span>` : "")
        + (m.recheck ? `<span class="ai-badge" data-kind="warn" title="It was verified on an older version of Tarsee's engine: Verify it again to be sure it still works.">Check again</span>` : "");
      const meta = [m.id, price(m), m.context ? `${Math.round(m.context / 1000)}K context` : ""].filter(Boolean).join(" · ");
      const verifyBtn = (label) => `<button type="button" class="btn btn-sm${m.needsVerification ? "" : " btn-ghost"}" data-ai-action="verify" data-model="${esc(m.id)}">${label}</button>`;
      const btn = m.needsVerification
        ? verifyBtn("Verify")
        : (m.recheck ? verifyBtn("Verify again") : "") + `<button type="button" class="btn btn-sm" data-ai-action="choose" data-model="${esc(m.id)}">Choose</button>`;
      return `<div class="ai-or-row"><div class="ai-or-name"><span>${esc(m.label || m.id)}</span>${badges}<div class="ai-or-meta">${esc(meta)}</div></div>${btn}</div>`;
    };
    const LIMIT = 30;
    const groups = [
      ["Verified by you", models.filter((m) => m.verified)],
      ["Ready to use", models.filter((m) => !m.verified && !m.needsVerification)],
      ["Verify to use", models.filter((m) => !m.verified && m.needsVerification)],
    ];
    const html = groups.map(([title, ms]) => {
      const hits = ms.filter(match);
      if (!hits.length) return "";
      const more = hits.length > LIMIT ? `<div class="hint">${hits.length - LIMIT} more: search to narrow the list.</div>` : "";
      return `<div class="ai-or-group"><div class="ai-or-title">${title} (${hits.length})</div>${hits.slice(0, LIMIT).map(row).join("")}${more}</div>`;
    }).join("");
    this._aiDrawList(list, html || `<div class="hint">No model matches “${esc(q)}”.</div>`);
  },

  /** Scroll to a provider's card and unfold its steps (the chips and the setup wizard use this). */
  focusAi(id) {
    const p = window.ProviderGuides?.get(id);
    const section = p && document.getElementById(p.section);
    if (!section || section.hidden) return;
    const guide = section.querySelector(".ai-guide");
    if (guide) guide.open = true;
    section.scrollIntoView({ behavior: "smooth", block: "start" });
    section.classList.remove("channel-flash");
    void section.offsetWidth;   // restart the highlight
    section.classList.add("channel-flash");
  },

  _aiSetTest(id, line) {
    this._aiTest[id] = line;
    const el = document.querySelector(`[data-ai="${id}"] [data-ai-test]`);
    if (el) {
      el.textContent = line?.text || "";
      if (line?.tone) el.dataset.tone = line.tone;
      else delete el.dataset.tone;
    }
  },

  /** A button shows it's working; the returned function puts it back. */
  _aiBusy(btn, text) {
    if (!btn) return () => {};
    const was = btn.textContent;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    if (text) btn.textContent = text;
    return () => {
      btn.disabled = false;
      btn.removeAttribute("aria-busy");
      btn.textContent = was;
    };
  },

  /** An /api/ai call that keeps the answer's fix: resolves to the JSON, or throws an Error whose message says what to do. */
  async _aiCall(path, { method = "GET", body } = {}) {
    const res = await API.request(path, { method, body });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const err = new Error([data.error || `HTTP ${res.status}`, data.fix].filter(Boolean).join(" "));
      err.data = data;
      err.status = res.status;
      throw err;
    }
    return data;
  },

  _aiClick(ev) {
    const copy = ev.target.closest("[data-copy]");
    if (copy) { this.copyText(copy); return; }
    const btn = ev.target.closest("[data-ai-action]");
    if (!btn) return;
    const card = btn.closest("[data-ai]");
    const id = card?.dataset.ai;
    switch (btn.dataset.aiAction) {
      case "save-key": this.saveAiKey(id, btn); break;
      case "remove-key": this.removeAiKey(id, btn); break;
      case "test": this.testAi(id, btn); break;
      case "use": this.useAi(id, btn); break;
      case "verify": this.verifyAiModel(id, btn.dataset.model || card?.querySelector("[data-ai-model]")?.value, btn); break;
      case "verify-custom": {
        const model = card?.querySelector("[data-ai-custom-model]")?.value.trim() || "";
        if (!model) this._aiSetTest(id, { text: "Type a model id first.", tone: "bad" });
        else if (/\s/.test(model)) this._aiSetTest(id, { text: "A model id has no spaces in it.", tone: "bad" });
        else this.verifyAiModel(id, model, btn);
        break;
      }
      case "choose": this.saveAiModel(id, btn.dataset.model); break;
      case "chatgpt-login": this.chatgptLoginInCard(); break;
      case "chatgpt-cancel": this.cancelChatgptLogin(); break;
      case "chatgpt-logout": this.chatgptLogout(btn); break;
      case "preset": {
        const input = card?.querySelector("#aiLocalUrl");
        if (input) { input.value = btn.dataset.url; input.focus(); }
        break;
      }
      case "save-local": this.saveLocalAi(btn); break;
    }
  },

  /** Copy a button's data-copy text, and say so on the button. */
  async copyText(btn) {
    const text = btn?.dataset.copy;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      window.App?.showToast?.("Couldn't copy: select the text and copy it by hand.", "error");
      return;
    }
    const label = btn.querySelector(".setup-copy-label");
    // The chip's own word, kept from the first click: a second click within the 1.5 s would otherwise keep "Copied".
    if (label) label.dataset.idle ??= label.textContent;
    clearTimeout(btn._copyTimer);
    btn.classList.add("copied");
    if (label) label.textContent = "Copied";
    btn._copyTimer = setTimeout(() => {
      btn.classList.remove("copied");
      if (label) label.textContent = label.dataset.idle;
    }, 1500);
  },

  /** Save a pasted key (PUT /api/ai/keys/:id), then Test it so the card shows whether it works and the balance. */
  async saveAiKey(id, btn) {
    const input = document.querySelector(`[data-ai="${id}"] [data-ai-key]`);
    const key = input?.value.trim() || "";
    if (!key) { this._aiSetTest(id, { text: "Paste a key first.", tone: "bad" }); input?.focus(); return; }
    const done = this._aiBusy(btn, "Saving…");
    try {
      const r = await this._aiCall(`/api/ai/keys/${id}`, { method: "PUT", body: { apiKey: key } });
      input.value = "";
      input.defaultValue = "";
      App.showToast(r.encrypted === false ? "Key saved (not encrypted: set ENCRYPTION_KEY)" : "Key saved", r.encrypted === false ? "info" : "success");
    } catch (err) {
      this._aiSetTest(id, { text: `✗ ${err.message}`, tone: "bad" });
      done();
      return;
    }
    done();
    delete this._aiModels[id];
    await this.testAi(id);
  },

  async removeAiKey(id, btn) {
    const c = this._aiCard(id);
    const after = c?.envKey ? ` Tarsee then uses the Railway variable ${c.envKey}, if it's set.` : "";
    const ok = await TarseeDialog.ask({ title: `Remove the saved ${c?.label || "AI"} key?`, text: `It's deleted from Tarsee.${after}`, yes: "Remove", no: "Cancel", danger: true });
    if (!ok) return;
    const done = this._aiBusy(btn, "Removing…");
    try {
      await this._aiCall(`/api/ai/keys/${id}`, { method: "DELETE" });
      this._aiSetTest(id, null);
      App.showToast("Key removed", "success");
    } catch (err) {
      App.showToast(err.message, "error");
    }
    done();
    delete this._aiModels[id];
    await this.loadAi();
    this.drawAiHeader();
  },

  /** Test (or Check, on the plans): a key typed in the box is tried before it's saved; else what's saved. */
  async testAi(id, btn) {
    const G = window.ProviderGuides;
    const typed = document.querySelector(`[data-ai="${id}"] [data-ai-key]`)?.value.trim();
    const done = this._aiBusy(btn, "Testing…");
    this._aiSetTest(id, { text: "Testing…", tone: "wait" });
    let line;
    try {
      const r = await this._aiCall(`/api/ai/test/${id}`, { method: "POST", body: typed ? { apiKey: typed } : {} });
      line = G.testLine(r);
      if (typed && r.ok) line = { text: `${line.text} (not saved yet: click Save key)`, tone: line.tone };
    } catch (err) {
      line = G.testLine({ ok: false, state: err.data?.state, message: err.message });
    }
    done();
    this._aiSetTest(id, line);
    await this.loadAi();
    this.loadAiModels(id, { force: true });
  },

  /** Make a ready provider the default AI, with the model chosen on its card. */
  async useAi(id, btn) {
    const model = document.getElementById(`aiModel-${id}`)?.value || undefined;
    const done = this._aiBusy(btn, "Switching…");
    try {
      await this._aiCall("/api/ai/active", { method: "PUT", body: { provider: id, model } });
      App.showToast(`${this._aiCard(id)?.label || "That AI"} is now your default AI`, "success");
      // (the composer hears of it from the loadAi below: _aiNoticeChange)
    } catch (err) {
      this._aiSetTest(id, { text: `✗ ${err.message}`, tone: "bad" });
      App.showToast(err.message, "error");
    }
    done();
    await this.loadAi();
  },

  /** A provider's own model (PUT /api/ai/providers/:id): its default for every chat that uses it. */
  async saveAiModel(id, model) {
    if (!id) return;
    try {
      await this._aiCall(`/api/ai/providers/${id}`, { method: "PUT", body: { model: model || null } });
      App.showToast("Model saved", "success");
    } catch (err) {
      this._aiSetTest(id, { text: `✗ ${err.message}`, tone: "bad" });
    }
    await this.loadAi();
    // Local AI's rows say which model is in a chat's menu, and that follows the card's model.
    if (id === "local") await this.loadAiModels("local", { force: true });
  },

  /** The model a provider's background jobs use (PUT /api/ai/providers/:id); empty goes back to the cheapest. */
  async saveAiBackgroundModel(id, model) {
    if (!id) return;
    try {
      await this._aiCall(`/api/ai/providers/${id}`, { method: "PUT", body: { backgroundModel: model || null } });
      this._aiSetTest(id, { text: `✓ Background jobs now use ${model ? this._aiModelLabel(id, model) : "the cheapest model"}.`, tone: "ok" });
    } catch (err) {
      this._aiSetTest(id, { text: `✗ ${err.message}`, tone: "bad" });
    }
    document.getElementById(`aiBgModel-${id}`)?.blur();
    await this.loadAi();
  },

  /**
   * The banner's one-click fix for a settings file the engines refuse (POST /api/ai/settings-guard/fix): the entries
   * that could send a key or its requests elsewhere come out of that file (or, if it can't be read, it is set aside).
   */
  async fixSettingsFile(file, btn) {
    const banner = (this._ai?.banners || []).find((b) => b.action?.file === file);
    const setAside = banner?.action?.label === "Set this file aside";
    const ok = await TarseeDialog.ask({
      title: setAside ? "Set this file aside?" : "Remove these entries?",
      text: setAside
        ? `${file} is renamed, so nothing loads it any more. Nothing in it is deleted.`
        : `Tarsee removes the entries that could send an AI key or its requests somewhere else from ${file}. The rest of the file stays as it is.`,
      yes: setAside ? "Set it aside" : "Remove",
      no: "Cancel",
      back: btn,
    });
    if (!ok) return;
    const done = this._aiBusy(btn, "Fixing…");
    try {
      await this._aiCall("/api/ai/settings-guard/fix", { method: "POST", body: { file } });
      App.showToast(setAside ? "File set aside" : "Entries removed", "success");
    } catch (err) {
      App.showToast(`Couldn't fix it: ${err.message}`, "error");
    }
    done();
    await this.loadAi();
  },

  /** Verify a model (POST /api/ai/verify/:id): a short real turn with a tool. A pass makes it choosable. */
  async verifyAiModel(id, model, btn) {
    if (!model) { this._aiSetTest(id, { text: "Choose a model first.", tone: "bad" }); return; }
    // It spends a little on the owner's own key: say what, and ask first (the server's estimate, GET /api/ai/models).
    const row = this._aiModels[id]?.models?.find((m) => m.id === model);
    const cost = row?.verifyCost || "a few cents (est.)";
    const ok = await TarseeDialog.ask({
      title: `Verify ${row?.label || model}?`,
      text: `Tarsee runs a few short test turns with it: a reply, one of Tarsee's tools, the shell, and picking the conversation back up. It takes up to a minute.\n\nCost: ${cost}.`,
      yes: "Verify",
      no: "Cancel",
      back: btn,
    });
    if (!ok) return;
    const done = this._aiBusy(btn, "Verifying…");
    this._aiSetTest(id, { text: `Verifying ${model}… this takes up to a minute.`, tone: "wait" });
    try {
      const r = await this._aiCall(`/api/ai/verify/${id}`, { method: "POST", body: { model } });
      this._aiSetTest(id, { text: `${r.ok ? "✓" : "✗"} ${r.message || (r.ok ? "It passed." : "It didn't pass.")}`, tone: r.ok ? "ok" : "bad" });
    } catch (err) {
      this._aiSetTest(id, { text: `✗ ${err.message}`, tone: "bad" });
    }
    done();
    await this.loadAiModels(id, { force: true });
    await this.loadAi();
  },

  /** Local AI's address and context size (PUT /api/ai/providers/local), then a Test that lists its models. */
  async saveLocalAi(btn) {
    const url = document.getElementById("aiLocalUrl")?.value.trim() || "";
    const box = document.getElementById("aiLocalContext");
    const body = { baseUrl: url || null };
    // The context only when the owner changed it: an emptied box goes back to the server's size (else the default).
    if (box && box.value.trim() !== box.defaultValue.trim()) body.context = box.value.trim() ? Number(box.value.trim()) : null;
    const done = this._aiBusy(btn, "Saving…");
    try {
      await this._aiCall("/api/ai/providers/local", { method: "PUT", body });
      App.showToast("Local AI saved", "success");
      ["aiLocalUrl", "aiLocalContext"].forEach((elId) => { const el = document.getElementById(elId); if (el) el.defaultValue = el.value; });
    } catch (err) {
      this._aiSetTest("local", { text: `✗ ${err.message}`, tone: "bad" });
      done();
      return;
    }
    done();
    delete this._aiModels.local;
    if (url) await this.testAi("local");
    else await this.loadAi();
  },

  /** "Only use API keys" (PUT /api/ai/keys-only). Asked first when it would switch off the default AI. */
  async saveKeysOnly() {
    const box = this.elements.aiKeysOnly;
    const on = !!box.checked;
    const a = this._ai?.active;
    const planDefault = a && (a.provider === "claude" || a.provider === "chatgpt");
    if (on && planDefault) {
      const ok = await TarseeDialog.ask({
        title: "Only use API keys?",
        text: `Your default AI is the ${a.label}, which this switches off. Tarsee won't answer until you choose an API-key AI as the default.`,
        yes: "Switch it on", no: "Cancel",
      });
      if (!ok) { box.checked = false; return; }
    }
    try {
      const r = await this._aiCall("/api/ai/keys-only", { method: "PUT", body: { on } });
      App.showToast(r.message || (on ? "Only API keys from now on" : "Plan sign-ins can be used again"), r.activeBlocked ? "info" : "success");
    } catch (err) {
      box.checked = !on;
      App.showToast(err.message, "error");
    }
    await this.loadAi();
  },

  /** The backup model and the monthly cap (ai.backupModel, ai.spendCap.monthlyUsd; empty turns each off). */
  async saveAiExtras() {
    const e = this.elements;
    const backup = e.aiBackupModel?.value || "";
    const capRaw = (e.aiMonthlyCap?.value || "").trim().replace(/[$,\s]/g, "");
    if (capRaw && !(Number(capRaw) > 0)) {
      App.showToast("The cap is a number of US dollars, like 20 (or leave it empty for no cap).", "error");
      return;
    }
    const done = this._aiBusy(e.aiSaveExtrasBtn, "Saving…");
    try {
      await API.json("/api/settings/general", { method: "POST", body: { key: "ai.backupModel", value: backup } });
      await API.json("/api/settings/general", { method: "POST", body: { key: "ai.spendCap.monthlyUsd", value: capRaw ? String(Number(capRaw)) : "" } });
      // Saved: both are drawn from the settings again (a failed save leaves them as chosen, for another try).
      if (e.aiBackupModel) e.aiBackupModel.dataset.drawn = backup;
      if (e.aiMonthlyCap) e.aiMonthlyCap.defaultValue = e.aiMonthlyCap.value;
      App.showToast(`Saved: backup ${backup ? "on" : "off"}, ${capRaw ? `cap $${Number(capRaw)} a month` : "no monthly cap"}`, "success");
    } catch (err) {
      App.showToast(err.message, "error");
    }
    done();
    e.aiBackupModel?.blur();
    e.aiMonthlyCap?.blur();
    await this.loadAi();
  },

  // ChatGPT's device-code sign-in, shared with the setup wizard (js/setup.js).

  /**
   * Start ChatGPT's sign-in (POST /api/ai/chatgpt/login) and follow it (GET every 3 seconds). render(view) gets
   * { state: "starting" | "waiting" | "done" | "failed" | "expired" | "cancelled", url, code, expiresAt, error, account }
   * at once, every second while it waits (for the countdown) and on every change. A sign-in the server no longer has
   * (Tarsee restarted, or another window cancelled it or signed out) is a failed one that says to start again.
   * Returns { cancel() (ends it, on the server too), stop() (stops following it here, and draws nothing more) }.
   */
  startChatgptLogin(render) {
    let stopped = false;
    let timer = null;
    let tick = null;
    let last = null;
    const stop = () => { stopped = true; clearTimeout(timer); clearInterval(tick); };
    const poll = async () => {
      if (stopped) return;
      let r = null;
      try { r = await API.json("/api/ai/chatgpt/login"); } catch { /* try again */ }
      if (stopped) return;
      if (r?.state === "waiting") { last = r; render(r); }
      else if (r?.state === "done" || r?.state === "failed" || r?.state === "expired") { stop(); render(r); return; }
      else if (r?.state === "idle") {
        stop();
        render({ state: "failed", error: "The sign-in stopped: Tarsee restarted, or it was cancelled or signed out in another window. Click Sign in with ChatGPT for a new code." });
        return;
      }
      timer = setTimeout(poll, 3000);
    };
    render({ state: "starting" });
    // (through _aiCall, so a refusal keeps its code: device-code-disabled, network, codex-missing...)
    this._aiCall("/api/ai/chatgpt/login", { method: "POST" }).then((r) => {
      if (stopped) return;
      if (r.state !== "waiting") { stop(); render(r); return; }
      last = r;
      render(r);
      tick = setInterval(() => { if (!stopped && last) render(last); }, 1000);
      timer = setTimeout(poll, 3000);
    }, (err) => {
      stop();
      render({ state: "failed", error: err.message, code: err.data?.code ?? null });
    });
    return {
      cancel: async () => {
        stop();
        try { await API.json("/api/ai/chatgpt/login", { method: "DELETE" }); } catch { /* it ends by itself */ }
        render({ state: "cancelled" });
      },
      stop,
    };
  },

  /** Minutes and seconds until a code runs out ("14:05"). */
  _aiLeft(expiresAt) {
    const left = Math.max(0, (Date.parse(expiresAt) || 0) - Date.now());
    return `${Math.floor(left / 60000)}:${String(Math.floor(left / 1000) % 60).padStart(2, "0")}`;
  },

  /** A sign-in as HTML: the link, the code to type with a Copy button, and how long the code lasts. */
  chatgptLoginHtml(v) {
    const esc = (s) => this._esc(s);
    if (!v || v.state === "cancelled") return "";
    if (v.state === "starting") return `<div class="ai-device-wait"><span class="ai-spinner" aria-hidden="true"></span><span>Starting the ChatGPT sign-in…</span></div>`;
    if (v.state === "waiting") {
      const url = /^https:\/\/[^\s"'<>]+$/i.test(v.url || "") ? v.url : null;
      const open = url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(url)}</a>` : "the sign-in page";
      return `<div class="ai-device-box">` +
        `<ol class="ai-device-steps"><li>Open ${open} and sign in to ChatGPT.</li>` +
        `<li>Type this code: <button type="button" class="setup-copy-chip ai-device-code" data-copy="${esc(v.code)}" aria-label="Copy the code"><span class="setup-copy-cmd">${esc(v.code)}</span><span class="setup-copy-label">Copy</span></button></li></ol>` +
        `<div class="ai-device-wait"><span class="ai-spinner" aria-hidden="true"></span><span>Waiting for you to finish. The code works for another <span data-ai-countdown>${this._aiLeft(v.expiresAt)}</span>.</span></div>` +
        `<button type="button" class="btn btn-sm btn-ghost" data-ai-action="chatgpt-cancel">Cancel</button></div>`;
    }
    if (v.state === "done") return `<div class="ai-test-result" data-tone="ok">✓ Signed in to ChatGPT${v.account ? ` as ${esc(v.account)}` : ""}.</div>`;
    if (v.state === "expired") return `<div class="ai-test-result" data-tone="bad">✗ The code ran out before sign-in finished. Click Sign in with ChatGPT for a new one.</div>`;
    // The switch in step 1 only when it is the reason, or the reason isn't known. An allow-list: a failed view's code
    // can still be the one-time code that was shown, and a network, Codex or rate-limit failure has its own fix.
    const hint = v.code === "device-code-disabled" || v.code === "failed"
      ? " Check that \"Enable device code sign-in for Codex\" is switched on in ChatGPT (step 1), then try again."
      : "";
    return `<div class="ai-test-result" data-tone="bad">✗ ${esc(v.error || "Sign-in didn't finish.")}${hint}</div>`;
  },

  /** Draw a sign-in into el. While it waits only the countdown changes, so the Copy button stays put. */
  renderChatgptLogin(el, v) {
    if (!el) return;
    if (v?.state === "waiting" && el.dataset.code === v.code) {
      const cd = el.querySelector("[data-ai-countdown]");
      if (cd) { cd.textContent = this._aiLeft(v.expiresAt); return; }
    }
    el.dataset.code = v?.state === "waiting" ? v.code : "";
    el.innerHTML = this.chatgptLoginHtml(v);
    el.hidden = !el.innerHTML;
  },

  chatgptLoginInCard() {
    this._aiLoginCtl?.cancel?.();
    this._aiLoginView = null;
    this._aiSetTest("chatgpt", null);
    // (render runs once before startChatgptLogin returns, so ctl is still null then)
    let ctl = null;
    ctl = this.startChatgptLogin(async (v) => {
      if (ctl && this._aiLoginCtl !== ctl && v.state !== "cancelled") return;
      this._aiLoginView = v;
      this.renderChatgptLogin(document.querySelector("#chatgptAiCard [data-ai-device]"), v);
      if (v.state === "done") {
        App.showToast("Signed in to ChatGPT", "success");
        delete this._aiModels.chatgpt;
        await this.loadAi();
      }
    });
    this._aiLoginCtl = ctl;
  },

  cancelChatgptLogin() {
    const ctl = this._aiLoginCtl;
    this._aiLoginCtl = null;
    ctl?.cancel();
    this._aiLoginView = null;
  },

  async chatgptLogout(btn) {
    const ok = await TarseeDialog.ask({ title: "Sign out of ChatGPT?", text: "Tarsee stops using your ChatGPT plan until you sign in again.", yes: "Sign out", no: "Cancel", danger: true });
    if (!ok) return;
    // Signing out ends a sign-in still waiting here too: stop following it first, or its end would read as a failure.
    this._aiLoginCtl?.stop();
    this._aiLoginCtl = null;
    this._aiLoginView = null;
    const done = this._aiBusy(btn, "Signing out…");
    try {
      await this._aiCall("/api/ai/chatgpt/logout", { method: "POST" });
      delete this._aiModels.chatgpt;
      App.showToast("Signed out of ChatGPT", "success");
    } catch (err) {
      App.showToast(err.message, "error");
    }
    done();
    await this.loadAi();
  },

  /** The header chip and its banner, from a fresh GET /api/ai/providers. */
  async refreshAiHeader() {
    try {
      this._ai = await API.json("/api/ai/providers");
      this._aiAt = Date.now();
    } catch {
      return;
    }
    this._aiNoticeChange();
    this.drawAiHeader();
    this.drawSttKey();
    const a = this._ai.active;
    if (a?.model && !this._aiModels[a.provider] && !(a.provider === "chatgpt" && !a.ready)) this.loadAiModels(a.provider);
  },

  /** The active AI in the header (a red dot when it can't answer), and a banner saying what to do. */
  drawAiHeader() {
    const e = this.elements;
    const a = this._ai?.active;
    if (!a || !e.aiHeaderChip) return;
    const G = window.ProviderGuides;
    const name = G?.get(a.provider)?.shortName || a.label;
    e.aiHeaderChip.hidden = false;
    // The default AI, in its own color (style.css [data-ai]): a chat on another AI shows that one's color on its
    // model button, so the two can be told apart.
    e.aiHeaderChip.dataset.ai = a.provider;
    e.aiHeaderChip.querySelector(".channel-dot")?.setAttribute("data-tone", a.ready ? "ok" : "bad");
    if (e.aiHeaderChipText) {
      e.aiHeaderChipText.innerHTML = `<span class="ai-header-chip-label">Default: </span><span class="ai-header-chip-ai">${this._esc(name)}</span>`
        + `<span class="ai-header-chip-model"> · ${this._esc(this._aiModelLabel(a.provider, a.model))}</span>`;
    }
    const words = a.ready ? `${a.label}: ready` : `${a.label}: ${[a.detail, a.fix].filter(Boolean).join(" ")}`;
    e.aiHeaderChip.title = `Your default AI, for new chats and scheduled tasks. ${words}`;
    e.aiHeaderChip.setAttribute("aria-label", `Your default AI, ${words}. Open Settings, AI.`);
    const att = e.aiAttention;
    if (!att) return;
    if (a.ready || this._aiDismissed === `${a.provider}|${a.state}`) {
      att.hidden = true;
      return;
    }
    att.innerHTML = `<span class="ai-attention-text">${this._esc(`${a.label} can't answer right now: ${[a.detail, a.fix].filter(Boolean).join(" ")}`)}</span>` +
      `<button type="button" class="btn btn-sm" data-ai-attention="open">Open Settings → AI</button>` +
      `<button type="button" class="ai-attention-close" data-ai-attention="dismiss" aria-label="Hide this message">×</button>`;
    att.hidden = false;
  },

  loadWhatsappChannel(settings) {
    const cfg = settings.find((s) => s.key === "channel.whatsapp")?.value || {};
    const e = this.elements;
    if (!e.whatsappEnabled) return; // UI not present
    e.whatsappEnabled.checked = !!cfg.enabled;
    // The token is no longer sent to the browser; the server reports whether
    // one is stored. Leave the field empty and rotate by typing a new one.
    if (e.whatsappToken) {
      e.whatsappToken.value = "";
      e.whatsappToken.placeholder = cfg.hasToken
        ? "Stored — replace to rotate"
        : "panel.whapi.cloud → your channel → API token";
    }
    if (e.whatsappWebhookUrl) {
      // The secret no longer rides along in the bulk settings payload, so ask
      // the dedicated endpoint for it only while this panel is on screen.
      e.whatsappWebhookUrl.value = "";
      e.whatsappWebhookUrl.placeholder = "Save the channel first to make this URL";
      API.json("/api/settings/channel/whatsapp/webhook-url")
        .then(({ configured, webhook_url }) => {
          if (configured && webhook_url) {
            e.whatsappWebhookUrl.value = `${location.origin}${webhook_url}`;
          }
        })
        .catch(() => { /* leave the placeholder in place */ });
    }
  },

  loadSlackChannel(settings) {
    const cfg = settings.find((s) => s.key === "channel.slack")?.value || {};
    const e = this.elements;
    if (!e.slackEnabled) return; // UI not present
    e.slackEnabled.checked = !!cfg.enabled;
    // Tokens never come back to the browser: the server says whether each one is stored.
    if (e.slackToken) {
      e.slackToken.value = "";
      e.slackToken.placeholder = cfg.hasToken ? "Stored — type a new xoxb- token to replace it" : "xoxb-… (Install App → Bot User OAuth Token)";
    }
    if (e.slackAppToken) {
      e.slackAppToken.value = "";
      e.slackAppToken.placeholder = cfg.hasAppToken ? "Stored — type a new xapp- token to replace it" : "xapp-… (Basic Information → App-Level Tokens, scope connections:write)";
    }
  },

  async saveSlackChannel() {
    const e = this.elements;
    try {
      const token = e.slackToken.value.trim();
      const appToken = e.slackAppToken.value.trim();
      const enabled = e.slackEnabled.checked;
      await API.saveChannel({ type: "slack", token, appToken, enabled });
      e.slackToken.value = "";
      e.slackAppToken.value = "";
      if (token) e.slackToken.placeholder = "Stored — type a new xoxb- token to replace it";
      if (appToken) e.slackAppToken.placeholder = "Stored — type a new xapp- token to replace it";
      if (token || appToken) this._markConfigured("slack");
      App.showToast(enabled ? "Slack saved, connecting…" : "Slack saved (off)", "success");
      this.showChannelStatus("slack", { wait: enabled });
    } catch (err) {
      App.showToast(err.message || "Failed to save Slack channel", "error");
    }
  },

  // --- Channels: guides and status ---

  /** Each platform's steps (js/channel-guides-core.js) into its section, and the row of links at the top. */
  drawChannelGuides() {
    const G = window.ChannelGuides;
    if (!G) return;
    for (const p of G.PLATFORMS) {
      const slot = document.querySelector(`[data-guide-slot="${p.id}"]`);
      if (slot) slot.innerHTML = G.guideHtml(p.id);
    }
    const jump = this.elements.channelJump;
    if (jump) {
      jump.innerHTML = G.PLATFORMS.map((p) =>
        `<button type="button" class="channel-chip" data-channel="${p.id}"><span class="channel-dot" data-tone="off"></span>${p.name}</button>`).join("");
      jump.addEventListener("click", (ev) => {
        const chip = ev.target.closest(".channel-chip");
        if (chip) this.focusChannel(chip.dataset.channel);
      });
    }
    // Typing a token ticks its Enable box: a token pasted and saved should connect, not sit there switched off.
    document.querySelectorAll("[data-enables]").forEach((input) => {
      input.addEventListener("input", () => {
        const box = document.getElementById(input.dataset.enables);
        if (box && input.value.trim()) box.checked = true;
      });
    });
  },

  /** Scroll to a platform's section and unfold its steps (the setup wizard and the row of links use this). */
  focusChannel(id) {
    const p = window.ChannelGuides?.get(id);
    const section = p && document.getElementById(p.section);
    if (!section) return;
    const guide = section.querySelector(".channel-guide");
    if (guide) guide.open = true;
    section.scrollIntoView({ behavior: "smooth", block: "start" });
    section.classList.remove("channel-flash");
    void section.offsetWidth;   // restart the highlight
    section.classList.add("channel-flash");
  },

  /** Every channel's status line, once (opening Settings). A channel not set up yet gets its steps unfolded. */
  async refreshChannelStatuses() {
    let channels = {};
    try { channels = (await API.getStatus())?.channels || {}; } catch { return; }
    for (const p of window.ChannelGuides?.PLATFORMS || []) {
      const s = channels[p.id];
      this.setChannelStatus(p.id, s);
      const guide = document.querySelector(`[data-guide-slot="${p.id}"] .channel-guide`);
      if (guide && (!s || s.status === "not_configured" || s.status === "error")) guide.open = true;
    }
  },

  /**
   * One channel's status line (and its dot in the row at the top). wait: it was just saved, so poll for a while
   * until it connects or says why not.
   */
  async showChannelStatus(type, { wait = false } = {}) {
    if (wait) this.setChannelStatus(type, { status: "starting" });
    const tries = wait ? 24 : 1;   // ~35 s: WHAPI takes ~16 s to refuse a token, a mail server can be slow too
    for (let i = 0; i < tries; i++) {
      if (i) await new Promise((r) => setTimeout(r, 1500));
      let s;
      try { s = (await API.getStatus())?.channels?.[type]; } catch { continue; }
      if (!wait || s?.status === "running" || s?.status === "error") {
        this.setChannelStatus(type, s);
        return;
      }
    }
    this.setChannelStatus(type, { status: "error", error: `Still connecting. The Console's [${type}] lines say what it's waiting for.` });
  },

  _markConfigured(type) {
    this._channelConfigured = { ...(this._channelConfigured || {}), [type]: true };
  },

  setChannelStatus(type, s) {
    const G = window.ChannelGuides;
    if (!G) return;
    const enabledBox = document.getElementById(`settings${type[0].toUpperCase()}${type.slice(1)}Enabled`);
    const { text, tone } = G.statusLine(s, {
      enabled: enabledBox ? enabledBox.checked : undefined,
      configured: this._channelConfigured?.[type],
    });
    const el = document.getElementById(`${type}ChannelStatus`);
    if (el) {
      el.textContent = tone === "ok" ? `✓ ${text}` : tone === "bad" ? `✗ ${text}` : text;
      el.dataset.tone = tone;
    }
    const dot = this.elements.channelJump?.querySelector(`.channel-chip[data-channel="${type}"] .channel-dot`);
    if (dot) { dot.dataset.tone = tone; dot.title = text; }
    if (type === "discord" && this.elements.discordInviteGroup) {
      const url = s?.status === "running" ? s.inviteUrl : null;
      this.elements.discordInviteGroup.hidden = !url;
      if (url) this.elements.discordInviteLink.href = url;
    }
  },

  async copySlackManifest() {
    try {
      const res = await API.request("/api/settings/channel/slack/manifest");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const yml = await res.text();
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(yml);
      } else {
        const ta = document.createElement("textarea");
        ta.value = yml;
        ta.setAttribute("readonly", "");
        ta.style.position = "absolute";
        ta.style.left = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (!ok) throw new Error("the browser would not copy");
      }
      App.showToast("Manifest copied: paste it at api.slack.com/apps → Create New App → From a manifest", "success");
    } catch (err) {
      App.showToast("Copy failed: " + (err?.message || "unknown"), "error");
    }
  },

  async saveWhatsappChannel() {
    try {
      const token = this.elements.whatsappToken.value.trim();
      const enabled = this.elements.whatsappEnabled.checked;
      const result = await API.saveChannel({ type: "whatsapp", token, enabled });
      if (token) {
        this.elements.whatsappToken.value = "";
        this.elements.whatsappToken.placeholder = "Stored — replace to rotate";
        this._markConfigured("whatsapp");
      }
      if (result?.webhook_url && this.elements.whatsappWebhookUrl) {
        this.elements.whatsappWebhookUrl.value = `${location.origin}${result.webhook_url}`;
      }
      App.showToast(enabled ? "WhatsApp saved, connecting… Now paste the webhook URL into WHAPI." : "WhatsApp saved (off)", "success");
      this.showChannelStatus("whatsapp", { wait: enabled });
    } catch (err) {
      App.showToast(err.message || "Failed to save WhatsApp channel", "error");
    }
  },

  async copyWhatsappWebhook() {
    const url = this.elements.whatsappWebhookUrl?.value;
    if (!url) {
      App.showToast("No webhook URL to copy — save the channel first", "error");
      return;
    }
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(url);
        App.showToast("Webhook URL copied", "success");
        return;
      }
      const ta = document.createElement("textarea");
      ta.value = url;
      ta.setAttribute("readonly", "");
      ta.style.position = "absolute";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      App.showToast(ok ? "Webhook URL copied" : "Press Ctrl+C to copy", ok ? "success" : "error");
    } catch (err) {
      App.showToast("Copy failed: " + (err?.message || "unknown"), "error");
    }
  },

  async regenerateWhatsappSecret() {
    if (!(await TarseeDialog.ask({
      title: "Regenerate the webhook secret?",
      text: "The current URL will stop working until you update it in the WHAPI dashboard.",
      yes: "Regenerate", no: "Cancel", danger: true,
    }))) {
      return;
    }
    try {
      const r = await API.json("/api/settings/channel/whatsapp/regenerate-secret", { method: "POST" });
      if (r?.webhook_url && this.elements.whatsappWebhookUrl) {
        this.elements.whatsappWebhookUrl.value = `${location.origin}${r.webhook_url}`;
      }
      App.showToast("New secret generated — update WHAPI dashboard", "info");
    } catch (err) {
      App.showToast(err.message || "Failed to regenerate secret", "error");
    }
  },

  /** Telegram or Discord: one bot token. Saving connects at once (or disconnects, with Enable off). */
  async saveTokenChannel(type) {
    const name = window.ChannelGuides?.get(type)?.name || type;
    const tokenEl = this.elements[`${type}Token`];
    const enabledEl = this.elements[`${type}Enabled`];
    try {
      const token = tokenEl.value.trim();
      const enabled = !!enabledEl?.checked;
      await API.saveChannel({ type, token, enabled });
      tokenEl.value = "";
      if (token) {
        tokenEl.placeholder = "Stored — type a new token to replace it";
        this._markConfigured(type);
      }
      App.showToast(enabled ? `${name} saved, connecting…` : `${name} saved (off)`, "success");
      this.showChannelStatus(type, { wait: enabled });
    } catch (err) {
      App.showToast(err.message || `Failed to save ${name}`, "error");
    }
  },

  async saveAllowlist() {
    try {
      const parse = (id) => (document.getElementById(id)?.value || "").split("\n").map(s => s.trim()).filter(Boolean);
      await API.json("/api/settings/general", { method: "POST", body: { key: "allowlist.telegram", value: JSON.stringify(parse("settingsTelegramAllowlist")) } });
      await API.json("/api/settings/general", { method: "POST", body: { key: "allowlist.discord", value: JSON.stringify(parse("settingsDiscordAllowlist")) } });
      await API.json("/api/settings/general", { method: "POST", body: { key: "allowlist.whatsapp", value: JSON.stringify(parse("settingsWhatsappAllowlist")) } });
      await API.json("/api/settings/general", { method: "POST", body: { key: "allowlist.slack", value: JSON.stringify(parse("settingsSlackAllowlist")) } });
      App.showToast("Allowlist saved", "success");
    } catch (err) {
      App.showToast(err.message, "error");
    }
  },

  async saveMentionMode() {
    try {
      const discordMode = this.elements.discordMentionMode?.value === "off" ? "off" : "required";
      const telegramMode = this.elements.telegramMentionMode?.value === "off" ? "off" : "required";
      const slackMode = this.elements.slackMentionMode?.value === "off" ? "off" : "required";

      // Footgun guard: warn if switching to "off" while the matching allowlist
      // is empty. Empty allowlist + mode=off means the bot will respond to
      // anyone in any channel/chat it can see. Confirm before saving.
      const discordAllow = (document.getElementById("settingsDiscordAllowlist")?.value || "").split("\n").map(s => s.trim()).filter(Boolean);
      const telegramAllow = (document.getElementById("settingsTelegramAllowlist")?.value || "").split("\n").map(s => s.trim()).filter(Boolean);
      const slackAllow = (document.getElementById("settingsSlackAllowlist")?.value || "").split("\n").map(s => s.trim()).filter(Boolean);
      const dangers = [];
      if (discordMode === "off" && discordAllow.length === 0) dangers.push("Discord");
      if (telegramMode === "off" && telegramAllow.length === 0) dangers.push("Telegram");
      if (slackMode === "off" && slackAllow.length === 0) dangers.push("Slack");
      if (dangers.length > 0) {
        const ok = await TarseeDialog.ask({
          title: `${dangers.join(" and ")}: mention mode is OFF and the allowlist is empty.`,
          text: `The bot will respond to EVERY message in EVERY ${dangers.length > 1 ? "channel/chat" : (dangers[0] === "Telegram" ? "chat" : "channel")} it can see.\n\n` +
            `Continue?`,
          yes: "Continue", no: "Cancel", danger: true,
        });
        if (!ok) return;
      }

      await API.json("/api/settings/general", { method: "POST", body: { key: "discord.mention_mode", value: discordMode } });
      await API.json("/api/settings/general", { method: "POST", body: { key: "telegram.mention_mode", value: telegramMode } });
      await API.json("/api/settings/general", { method: "POST", body: { key: "slack.mention_mode", value: slackMode } });
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
    const note = window.ChannelGuides?.EMAIL_PROVIDERS?.[name];
    if (this.elements.emailPresetHint) {
      this.elements.emailPresetHint.innerHTML = note || "";
      this.elements.emailPresetHint.hidden = !note;
    }
    const presets = {
      gmail:    { imapHost: "imap.gmail.com",        imapPort: 993, smtpHost: "smtp.gmail.com",        smtpPort: 465 },
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

      await API.saveChannel(payload);
      if (payload.imap.host) this._markConfigured("email");

      // Clear password fields after save so they don't show plaintext in the DOM
      e.emailImapPassword.value = "";
      e.emailSmtpPassword.value = "";

      App.showToast(payload.enabled ? "Email saved, connecting…" : "Email saved (off)", "success");
      this.showChannelStatus("email", { wait: payload.enabled });

      // The saved-password placeholders ("leave blank to keep existing") come from the server's hasPassword flags.
      try { this.loadEmailChannel((await API.getSettings()).settings); } catch { /* keeps what is on screen */ }
    } catch (err) {
      App.showToast(err.message || "Failed to save email channel", "error");
    }
  },

  /** Phonon has its own voice and speed controls; the generic Default Voice list is for the other engines. */
  showPhononGroup(show) {
    if (this.elements.phononGroup) this.elements.phononGroup.style.display = show ? "block" : "none";
    if (this.elements.defaultVoiceGroup) this.elements.defaultVoiceGroup.style.display = show ? "none" : "";
    if (show) this.loadPhonon();
    else this._stopPhononPoll();
  },

  async loadPhonon() {
    const sel = this.elements.phononVoice;
    if (!sel) return;
    try {
      const data = await API.json("/api/voice/phonon");
      sel.innerHTML = "";
      for (const v of data.voices || []) {
        const opt = document.createElement("option");
        opt.value = v.id;
        opt.textContent = v.name;
        sel.appendChild(opt);
      }
      sel.value = data.voice;
      const sp = this.elements.phononSpeed;
      if (sp) {
        sp.min = data.speedMin;
        sp.max = data.speedMax;
        sp.value = data.speed;
        sp.dispatchEvent(new Event("input"));
      }
      if (this.elements.phononBarePeso) this.elements.phononBarePeso.checked = !!data.barePeso;
      this.renderPhononInstall(data.install);
    } catch {
      sel.innerHTML = '<option value="">Could not load the Phonon voices</option>';
    }
  },

  /** Show the install state: not installed / downloading with progress / installed / failed with retry. */
  renderPhononInstall(install) {
    const statusEl = this.elements.phononInstallStatus;
    const btn = this.elements.phononInstallBtn;
    const bar = this.elements.phononInstallProgress;
    const hint = this.elements.phononInstallHint;
    if (!statusEl || !install) return;
    const phaseText = {
      runtime: "Setting up the Python runtime",
      model: "Downloading the model",
      voices: "Downloading the voices",
      check: "Testing the model",
    };
    let text = "";
    let showBtn = false;
    let btnText = "Install Phonon";
    if (install.state === "installed") {
      text = "Installed.";
    } else if (install.state === "installing") {
      text = `${phaseText[install.phase] || "Installing"}… ${install.percent}%. Edge TTS speaks until it is ready.`;
    } else if (install.state === "failed") {
      text = `Install failed: ${install.error || "unknown error"}. Edge TTS speaks instead.`;
      showBtn = true;
      btnText = "Retry";
    } else {
      text = "Not installed yet. Edge TTS speaks until it is.";
      showBtn = true;
    }
    statusEl.textContent = text;
    if (btn) {
      btn.style.display = showBtn ? "" : "none";
      btn.textContent = btnText;
      btn.disabled = false;
    }
    if (bar) {
      bar.style.display = install.state === "installing" ? "" : "none";
      bar.value = install.percent || 0;
    }
    if (hint) hint.style.display = install.state === "installed" ? "none" : "";
    if (install.state === "installing") this._startPhononPoll();
    else {
      const wasPolling = !!this._phononPoll;
      this._stopPhononPoll();
      // The engine switches to Phonon by itself when the install finishes.
      if (wasPolling && install.state === "installed") this.loadVoiceStatus();
    }
  },

  async installPhonon() {
    const btn = this.elements.phononInstallBtn;
    if (btn) btn.disabled = true;
    try {
      const install = await API.json("/api/voice/phonon/install", { method: "POST" });
      this.renderPhononInstall(install);
    } catch (err) {
      if (btn) btn.disabled = false;
      App.showToast(err.message || "Could not start the Phonon install", "error");
    }
  },

  _startPhononPoll() {
    if (this._phononPoll) return;
    let errors = 0;
    this._phononPoll = setInterval(async () => {
      // Only ask while the Phonon settings are on screen; the poll stays armed
      // so the progress is current when the Voice tab is opened again.
      if (!this.elements.phononGroup || this.elements.phononGroup.offsetParent === null) return;
      try {
        // Plain fetch: a background poll should never toast or reload the page.
        const res = await fetch("/api/voice/phonon", { credentials: "same-origin" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        errors = 0;
        this.renderPhononInstall((await res.json()).install);
      } catch {
        if (++errors >= 5) this._stopPhononPoll();
      }
    }, 1500);
  },

  _stopPhononPoll() {
    if (this._phononPoll) clearInterval(this._phononPoll);
    this._phononPoll = null;
  },

  async loadVoiceStatus() {
    if (!this.elements.voiceEngineStatus) return;
    try {
      const res = await API.request("/api/voice/status");
      const data = await res.json();
      const engine = data.tts?.engine || data.engine || "stub";
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
    if (!(await TarseeDialog.ask({ title: `Delete voice "${id}"?`, yes: "Delete", no: "Cancel", danger: true }))) return;
    try {
      const csrf = API.getCsrfToken();
      const headers = {};
      if (csrf) headers["X-CSRF-Token"] = csrf;
      await fetch(`/api/voice/piper-voices/${id}`, { method: "DELETE", headers, credentials: "same-origin" });
      App.showToast("Voice deleted", "success");
      this.loadPiperVoices();
    } catch { App.showToast("Failed to delete", "error"); }
  },

  /**
   * Settings → Voice: where the OpenAI key Whisper uses comes from, from the last read of the AIs (drawn after every
   * one). It is the OpenAI API key card's (one slot, shared with Settings → AI), so the box stays empty and only says
   * which key it is: "Saved in Tarsee (encrypted) …wxyz".
   */
  drawSttKey() {
    const box = document.getElementById("settingsOpenaiKey");
    const status = document.getElementById("openaiKeyStatus");
    if (!box || !status) return;
    const card = (this._ai?.providers || []).find((p) => p.id === "openai") || null;
    const hint = card?.keyHint ? ` ${card.keyHint}` : "";
    if (card?.keySource === "settings") {
      box.placeholder = `Saved${hint}`;
      status.textContent = `${card.keySourceText || "Saved in Tarsee"}${hint}. It's the key on the OpenAI API key card in Settings > AI; paste a new one here to replace it.`;
    } else if (card?.keySource?.startsWith("env:")) {
      box.placeholder = `From Railway${hint}`;
      status.textContent = `${card.keySourceText || "A Railway variable"}${hint}. It's the key on the OpenAI API key card in Settings > AI; a key pasted here is saved in Tarsee and used instead.`;
    } else {
      box.placeholder = "sk-...";
      status.textContent = card ? "No OpenAI key yet. One pasted here is also the OpenAI API key card's in Settings > AI." : "";
    }
    status.hidden = !status.textContent;
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
      if (engine === "phonon") {
        // Phonon's voice, speed and peso option are its own settings; the other
        // engines' Default Voice is left as it was. Saved before the engine so
        // the engine starts with them.
        const save = (key, value) => API.json("/api/settings/general", { method: "POST", body: { key, value } });
        const voice = this.elements.phononVoice?.value;
        if (voice) await save("voice.phonon.voice", voice);
        const speed = this.elements.phononSpeed?.value;
        if (speed) await save("voice.phonon.speed", String(speed));
        if (this.elements.phononBarePeso) await save("voice.phonon.barePeso", this.elements.phononBarePeso.checked ? "true" : "false");
        await save("voice.engine", engine);
        App.showToast("Voice settings saved and applied. Edge TTS speaks if Phonon is not ready.", "success");
        this.loadVoiceStatus();
        return;
      }
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
    if (!(await TarseeDialog.ask({ title: `Delete skill "${name}"?`, yes: "Delete", no: "Cancel", danger: true }))) return;
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

  /**
   * Tool Permissions: every tool the agent can run, from the registry (GET /api/admin/tool-registry: Tarsee's own
   * tools, the tarsee MCP server's live list, and the tools built into the AIs), grouped as it groups them. Tarsee's
   * own tools get Allow / Warn / Deny; the built-in ones say plainly that nothing here limits them.
   */
  async loadToolPermissions() {
    const el = document.getElementById("toolPermissionsList");
    if (!el) return;
    const esc = (s) => this._esc(s);
    let tools;
    try {
      // Without the API token: this list answers only the signed-in owner's own session (routes/admin.js).
      const res = await fetch("/api/admin/tool-registry", { credentials: "same-origin", cache: "no-store" });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      tools = Array.isArray(body) ? body : (body.tools || []);
    } catch (err) {
      el.textContent = `Couldn't list the tools: ${err.message}`;
      return;
    }
    const MODES = [["always_allow", "Allow"], ["warn", "Warn"], ["always_deny", "Deny"]];
    const OTHER_MODES = { check_ssrf: "Allow, but not private addresses" };
    const groups = new Map();
    for (const t of tools) {
      const g = t.group || "Other";
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(t);
    }
    // Tarsee's own tools first, the AI's built-in ones last.
    const ordered = [...groups].sort(([, a], [, b]) => (a.some((t) => t.policyCovered) ? 0 : 1) - (b.some((t) => t.policyCovered) ? 0 : 1));
    el.innerHTML = ordered.map(([group, list]) => {
      const covered = list.some((t) => t.policyCovered);
      const rows = list.map((t) => {
        const desc = [t.description, t.mcpName ? `(${t.mcpName})` : ""].filter(Boolean).join(" ");
        let control;
        if (t.policyCovered) {
          const mode = t.mode || "always_allow";
          const opts = MODES.map(([v, label]) => `<option value="${v}"${mode === v ? " selected" : ""}>${label}</option>`);
          if (!MODES.some(([v]) => v === mode)) opts.unshift(`<option value="${esc(mode)}" selected>${esc(OTHER_MODES[mode] || mode)}</option>`);
          control = `<select class="tool-perm-select" data-tool="${esc(t.name)}" data-mode="${esc(mode)}" aria-label="${esc(t.label || t.name)}">${opts.join("")}</select>`;
        } else {
          control = `<span class="tool-perm-fixed" title="Built into the AI itself: Tool Permissions can't limit it">Always on</span>`;
        }
        return `<div class="tool-perm-row"><div class="tool-perm-name"><span>${esc(t.label || t.name)}</span><div class="tool-perm-desc">${esc(desc)}</div></div>${control}</div>`;
      }).join("");
      const note = covered ? "" : `<div class="hint">Every AI has these, and nothing here can switch them off or limit them.</div>`;
      return `<div class="tool-perm-group"><h4>${esc(group)}</h4>${note}${rows}</div>`;
    }).join("") || `<div class="hint">No tools listed.</div>`;
    el.querySelectorAll(".tool-perm-select").forEach((sel) => {
      sel.addEventListener("change", async () => {
        try {
          await API.json("/api/admin/tool-permissions", { method: "POST", body: { toolName: sel.dataset.tool, mode: sel.value } });
          sel.dataset.mode = sel.value;
          App.showToast("Permission updated", "success");
        } catch (err) {
          sel.value = sel.dataset.mode;
          App.showToast(err.message, "error");
        }
      });
    });
  },

  async loadCanvasGallery() {
    var gallery = document.getElementById("canvasGallery");
    var empty = document.getElementById("canvasEmpty");
    if (!gallery) return;
    gallery.innerHTML = '<a href="/canvas/" target="_blank" class="btn btn-sm" style="margin-bottom:8px">Open Canvas Gallery</a>';
    if (empty) empty.style.display = "none";
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

      // Every value is set as text: entries carry model names, file entries and the agent's shell commands as they were.
      const span = (className, text) => {
        const el = document.createElement("span");
        el.className = className;
        el.textContent = text;
        return el;
      };
      for (const e of entries) {
        const div = document.createElement("div");
        div.className = "audit-entry";
        const action = String(e.action ?? "");
        const actionClass = action.startsWith("auth") ? "auth" : action.startsWith("tool") ? "tool" : "setting";
        const time = e.created_at ? new Date(e.created_at + "Z").toLocaleString() : "";
        const detail = span("audit-entry-detail", String(e.detail || e.ip || ""));
        detail.title = String(e.detail || "");
        div.append(
          span("audit-entry-time", time),
          span(`audit-entry-action ${actionClass}`, `${action}${e.target ? ` → ${e.target}` : ""}`),
          detail,
        );
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
