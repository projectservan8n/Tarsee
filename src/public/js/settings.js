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
};
