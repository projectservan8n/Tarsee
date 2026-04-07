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
    const channels = ["discord", "telegram"];

    for (const type of channels) {
      try {
        const channelConfig = this.settings.get(`channel.${type}`);
        if (channelConfig?.enabled && channelConfig?.token) {
          await this.start(type, channelConfig);
        }
      } catch (err) {
        console.warn(`[channels] failed to start ${type}:`, err.message);
      }
    }
  }

  /**
   * Starts a specific channel.
   */
  async start(type, channelConfig) {
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
          bot = await createTelegramBot(channelConfig, this.db);
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
  async restart(type) {
    const channelConfig = this.settings.get(`channel.${type}`);
    if (!channelConfig?.enabled || !channelConfig?.token) {
      throw new Error(`${type} is not configured or not enabled`);
    }
    await this.start(type, channelConfig);
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
    for (const type of ["discord", "telegram"]) {
      if (!result[type]) {
        const config = this.settings.get(`channel.${type}`);
        result[type] = {
          status: config?.enabled ? "stopped" : "not_configured",
        };
      }
    }
    return result;
  }
}
