import { SettingsStore } from "../db/settings.js";
import { ConversationStore } from "../db/conversations.js";

/**
 * Manages all messaging channel bots (Discord, Telegram, Slack).
 * Starts/stops channels based on stored configuration.
 */
export class ChannelManager {
  constructor(db) {
    this.db = db;
    this.settings = new SettingsStore(db);
    this.conversations = new ConversationStore(db);
    this.channels = new Map(); // channelId → { bot, type, status }
  }

  /**
   * Starts all configured channels.
   */
  async startAll() {
    // Channels start in PARALLEL. This used to be a serial await-loop, which
    // meant one slow channel blocked every channel after it — and because
    // WhatsApp was registered last, a stuck Telegram poller (e.g. minutes of
    // 409 retries against another poller) stopped WhatsApp from EVER starting.
    // A failure in one channel must never gate the others.
    //
    // Email has a different "ready" check than token-based channels — it needs
    // imap + smtp config + enabled, not a single token.
    const tokenChannels = ["discord", "telegram", "whatsapp"];
    const tasks = [];

    for (const type of tokenChannels) {
      const channelConfig = this.settings.get(`channel.${type}`);
      if (!channelConfig?.enabled || !channelConfig?.token) continue;
      tasks.push(this._startWithRetry(type, channelConfig));
    }

    const emailConfig = this.settings.get("channel.email");
    if (isEmailReady(emailConfig)) {
      tasks.push(
        this.start("email", emailConfig).catch((err) =>
          console.warn("[channels] failed to start email:", err.message),
        ),
      );
    }

    // server.js already treats startAll() as fire-and-forget; allSettled just
    // lets us surface one completion log once everything has settled.
    const results = await Promise.allSettled(tasks);
    const ok = results.filter((r) => r.status === "fulfilled").length;
    console.log(`[channels] startup settled: ${ok}/${results.length} channel(s) running`);
  }

  /**
   * Start a channel, retrying with exponential backoff. Transient network
   * failures at boot (DNS not up yet, upstream 5xx) previously killed a
   * channel for the whole process lifetime — on Railway that means until
   * the next deploy, because there is no console to restart it by hand.
   */
  async _startWithRetry(type, channelConfig, maxAttempts = 8) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.start(type, channelConfig);
        return;
      } catch (err) {
        const last = attempt === maxAttempts;
        console.warn(
          `[channels] start ${type} attempt ${attempt}/${maxAttempts} failed:`, err.message,
          "| code=" + (err.code || "?"),
          "| errno=" + (err.errno || "?"),
          "| cause=" + (err.cause?.code || err.cause?.message || "?"),
        );
        if (last) return;
        const delay = Math.min(2_000 * Math.pow(2, attempt - 1), 45_000); // 2,4,8,16,32,45,45s
        console.warn(`[channels] retrying ${type} in ${delay}ms...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  /**
   * Starts a specific channel.
   */
  async start(type, channelConfig, opts = {}) {
    // Stop existing instance if running
    if (this.channels.has(type)) {
      await this.stop(type);
    }

    console.log(`[channels] starting ${type}...`);

    try {
      let bot;
      switch (type) {
        case "discord": {
          const { createDiscordBot } = await import("./discord.js");
          bot = await createDiscordBot(channelConfig, this.db);
          break;
        }
        case "telegram": {
          const { createTelegramBot } = await import("./telegram.js");
          // opts carries deliverPending: when the health monitor relaunches a
          // WEDGED poller, the queued updates are real messages the stuck
          // poller failed to pull, so they must be delivered not dropped.
          bot = await createTelegramBot(channelConfig, this.db, opts);
          break;
        }
        case "email": {
          const { createEmailBot } = await import("./email.js");
          bot = await createEmailBot(channelConfig, this.db);
          break;
        }
        case "whatsapp": {
          const { createWhatsAppBot } = await import("./whatsapp.js");
          bot = await createWhatsAppBot(channelConfig, this.db);
          break;
        }
        default:
          throw new Error(`Unknown channel type: ${type}`);
      }

      this.channels.set(type, { bot, type, status: "running" });
      console.log(`[channels] ${type} started`);
    } catch (err) {
      this.channels.set(type, { bot: null, type, status: "error", error: err.message });
      throw err;
    }
  }

  /**
   * Stops a specific channel.
   */
  async stop(type) {
    const channel = this.channels.get(type);
    if (!channel?.bot) return;

    console.log(`[channels] stopping ${type}...`);
    try {
      await channel.bot.stop();
    } catch (err) {
      console.warn(`[channels] error stopping ${type}:`, err.message);
    }
    this.channels.delete(type);
  }

  /**
   * Stops all channels.
   */
  stopAll() {
    for (const [type] of this.channels) {
      this.stop(type).catch(() => {});
    }
  }

  /**
   * Restarts a specific channel.
   */
  async restart(type, opts = {}) {
    const channelConfig = this.settings.get(`channel.${type}`);
    // Email uses imap/smtp instead of a single token — different readiness check.
    if (type === "email") {
      if (!isEmailReady(channelConfig)) {
        throw new Error("email is not configured or not enabled");
      }
    } else if (!channelConfig?.enabled || !channelConfig?.token) {
      throw new Error(`${type} is not configured or not enabled`);
    }
    await this.start(type, channelConfig, opts);
  }

  /**
   * Send an outbound message to a channel.
   * @param {string} type - Channel type (telegram, discord, slack)
   * @param {string} chatId - Platform-specific chat/channel ID
   * @param {string} message - Message text
   */
  async sendMessage(type, chatId, message) {
    const channel = this.channels.get(type);
    if (!channel?.bot?.sendMessage) {
      throw new Error(`Channel ${type} is not running or does not support outbound messages`);
    }
    await channel.bot.sendMessage(chatId, message);
  }

  /**
   * Gets status of all channels.
   */
  getStatus() {
    const result = {};
    for (const [type, channel] of this.channels) {
      result[type] = {
        status: channel.status,
        error: channel.error || null,
      };
    }
    // Add unconfigured channels
    for (const type of ["discord", "telegram", "whatsapp"]) {
      if (!result[type]) {
        const config = this.settings.get(`channel.${type}`);
        result[type] = {
          status: config?.enabled ? "stopped" : "not_configured",
        };
      }
    }
    // Email uses a different readiness shape
    if (!result.email) {
      const config = this.settings.get("channel.email");
      result.email = {
        status: isEmailReady(config) ? "stopped" : "not_configured",
      };
    }
    return result;
  }
}

/**
 * Email is "ready to start" when it's enabled + has both IMAP and SMTP
 * host+user configured. Passwords are stored separately (encrypted) so we
 * can't check them here without decryption; the channel will fail fast
 * on connect if they're missing, which surfaces as a clean error.
 */
function isEmailReady(c) {
  return !!(
    c &&
    c.enabled &&
    c.imap?.host && c.imap?.user &&
    c.smtp?.host && c.smtp?.user
  );
}
