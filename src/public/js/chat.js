/**
 * Chat UI module.
 * Channel-based: each channel (web, discord, telegram, slack) has one persistent session.
 * No multi-conversation sidebar — the sidebar shows channels.
 */
const PLATFORM_ICONS = {
  web: "\u{1F310}",       // 🌐
  discord: "\u{1F4AC}",   // 💬
  telegram: "\u{2708}\uFE0F", // ✈️
  slack: "\u{1F4BC}",     // 💼
};

const Chat = {
  currentChannelKey: null,
  currentConversationId: null,
  isStreaming: false,
  channels: [],
  botName: "OpusClaw",
  lastMessageRole: null,
  lastMessageTime: 0,

  elements: {},

  // Command palette state
  commands: [],
  paletteVisible: false,
  paletteIndex: -1,
  paletteCommands: [],

  init() {
    this.elements = {
      chatArea: document.getElementById("chatArea"),
      inputArea: document.getElementById("inputArea"),
      messageInput: document.getElementById("messageInput"),
      sendBtn: document.getElementById("sendBtn"),
      channelList: document.getElementById("channelList"),
      welcomeScreen: document.getElementById("welcomeScreen"),
      topbarTitle: document.getElementById("topbarTitle"),
    };

    // Create command palette
    const palette = document.createElement("div");
    palette.id = "commandPalette";
    palette.className = "command-palette";
    palette.style.display = "none";
    palette.innerHTML = '<div class="command-palette-list"></div>';
    this.elements.inputArea.appendChild(palette);
    this.elements.commandPalette = palette;
    this.elements.commandPaletteList = palette.querySelector(".command-palette-list");

    // Auto-resize textarea + command palette trigger
    this.elements.messageInput.addEventListener("input", () => {
      const el = this.elements.messageInput;
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
      this.elements.sendBtn.disabled = !el.value.trim();
      this.handleCommandPalette();
    });

    // Keyboard: palette navigation + Enter to send
    this.elements.messageInput.addEventListener("keydown", (e) => {
      if (this.paletteVisible) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          this.paletteIndex = Math.min(this.paletteIndex + 1, this.paletteCommands.length - 1);
          this.updatePaletteHighlight();
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          this.paletteIndex = Math.max(this.paletteIndex - 1, 0);
          this.updatePaletteHighlight();
          return;
        }
        if (e.key === "Enter" || e.key === "Tab") {
          e.preventDefault();
          if (this.paletteIndex >= 0) this.selectPaletteItem(this.paletteIndex);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          this.hidePalette();
          return;
        }
      }

      // Normal Enter to send
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!this.isStreaming && this.elements.messageInput.value.trim()) {
          this.send();
        }
      }
    });

    // Dismiss palette on outside click
    document.addEventListener("click", (e) => {
      if (this.paletteVisible && !this.elements.commandPalette.contains(e.target) && e.target !== this.elements.messageInput) {
        this.hidePalette();
      }
    });

    this.elements.sendBtn.addEventListener("click", () => this.send());

    // Welcome suggestion cards
    document.querySelectorAll(".welcome-suggestion").forEach((el) => {
      el.addEventListener("click", () => {
        this.elements.messageInput.value = el.dataset.msg;
        this.elements.sendBtn.disabled = false;
        this.elements.messageInput.focus();
      });
    });

    this.loadChannels();
    this.loadCommands();
    this.loadBotName();
  },

  async loadCommands() {
    try {
      const data = await API.json("/api/chat/commands");
      this.commands = data.commands || [];
    } catch {
      this.commands = [];
    }
  },

  async loadBotName() {
    try {
      const data = await API.json("/api/settings/setup-status");
      this.setBotName(data.botName || "OpusClaw");
    } catch {
      this.setBotName("OpusClaw");
    }
  },

  setBotName(name) {
    this.botName = name || "OpusClaw";
    const initials = this.botName.slice(0, 2).toUpperCase();

    // Update topbar title (only if showing default)
    if (!this.currentChannelKey) {
      this.elements.topbarTitle.textContent = this.botName;
    }

    // Update welcome screen
    const welcomeTitle = document.getElementById("welcomeTitle");
    if (welcomeTitle) welcomeTitle.textContent = `Welcome to ${this.botName}`;

    // Update sidebar header
    const sidebarH1 = document.querySelector(".sidebar-header h1");
    if (sidebarH1) sidebarH1.textContent = this.botName;

    // Update sidebar logo initials
    const sidebarLogo = document.querySelector(".sidebar-header .logo");
    if (sidebarLogo) sidebarLogo.textContent = initials;

    // Update welcome logo initials
    const welcomeLogo = document.querySelector(".welcome .logo-large");
    if (welcomeLogo) welcomeLogo.textContent = initials;
  },

  // --- Command Palette ---
  handleCommandPalette() {
    const text = this.elements.messageInput.value;
    if (text.startsWith("/") && !text.includes(" ") && text.length < 30) {
      const filter = text.slice(1).toLowerCase();
      const filtered = this.commands.filter(
        (c) => c.name.toLowerCase().includes(filter) || c.description.toLowerCase().includes(filter)
      );
      this.showPalette(filtered);
    } else {
      this.hidePalette();
    }
  },

  showPalette(commands) {
    if (commands.length === 0) { this.hidePalette(); return; }
    this.paletteVisible = true;
    this.paletteIndex = 0;
    this.paletteCommands = commands;

    this.elements.commandPaletteList.innerHTML = commands
      .map((cmd, i) =>
        `<div class="command-palette-item${i === 0 ? " active" : ""}" data-index="${i}">
          <span class="command-palette-name">/${escapeHtml(cmd.name)}</span>
          <span class="command-palette-desc">${escapeHtml(cmd.description)}</span>
        </div>`
      ).join("");

    this.elements.commandPaletteList.querySelectorAll(".command-palette-item").forEach((el) => {
      el.addEventListener("click", () => this.selectPaletteItem(parseInt(el.dataset.index, 10)));
      el.addEventListener("mouseenter", () => {
        this.paletteIndex = parseInt(el.dataset.index, 10);
        this.updatePaletteHighlight();
      });
    });

    this.elements.commandPalette.style.display = "block";
  },

  hidePalette() {
    this.paletteVisible = false;
    this.paletteIndex = -1;
    this.elements.commandPalette.style.display = "none";
  },

  selectPaletteItem(index) {
    const cmd = this.paletteCommands[index];
    if (!cmd) return;
    const hasArgs = cmd.usage.includes("[");
    this.elements.messageInput.value = hasArgs ? `/${cmd.name} ` : cmd.usage;
    this.elements.messageInput.focus();
    const len = this.elements.messageInput.value.length;
    this.elements.messageInput.setSelectionRange(len, len);
    this.hidePalette();
    this.elements.sendBtn.disabled = !this.elements.messageInput.value.trim();
  },

  updatePaletteHighlight() {
    const items = this.elements.commandPaletteList.querySelectorAll(".command-palette-item");
    items.forEach((el, i) => el.classList.toggle("active", i === this.paletteIndex));
    items[this.paletteIndex]?.scrollIntoView({ block: "nearest" });
  },

  // --- Channel Management ---
  async loadChannels() {
    try {
      const data = await API.listChannels();
      this.channels = data.channels || [];
      this.renderChannelList();

      // Auto-open web:default channel on first load
      if (!this.currentChannelKey) {
        const webChannel = this.channels.find((c) => c.key === "web:default");
        if (webChannel) {
          this.openChannel(webChannel.key, webChannel.conversationId);
        } else {
          // Show welcome + input — first message will create web:default
          this.elements.inputArea.style.display = "block";
        }
      }
    } catch (err) {
      console.error("Failed to load channels:", err);
      // Still show input so user can chat
      this.elements.inputArea.style.display = "block";
    }
  },

  renderChannelList() {
    const el = this.elements.channelList;
    if (!el) return;
    el.innerHTML = "";

    // Always ensure web:default is visible
    const hasWeb = this.channels.some((c) => c.key === "web:default");
    const allChannels = hasWeb
      ? this.channels
      : [{ key: "web:default", platform: "web", title: "Web Chat", conversationId: null, updatedAt: null }, ...this.channels];

    // Group by platform
    const groups = {};
    for (const ch of allChannels) {
      if (!groups[ch.platform]) groups[ch.platform] = [];
      groups[ch.platform].push(ch);
    }

    // Platform labels
    const platformLabels = { web: "Web", discord: "Discord", telegram: "Telegram", slack: "Slack" };
    const platformOrder = ["web", "discord", "telegram", "slack"];

    for (const platform of platformOrder) {
      const items = groups[platform];
      if (!items || items.length === 0) continue;

      // Section label
      const label = document.createElement("div");
      label.className = "channel-section-label";
      label.textContent = platformLabels[platform] || platform;
      el.appendChild(label);

      for (const ch of items) {
        const item = document.createElement("div");
        const isActive = ch.key === this.currentChannelKey;
        item.className = "channel-item" + (isActive ? " active" : "");

        const icon = PLATFORM_ICONS[ch.platform] || PLATFORM_ICONS.web;
        const timeAgo = ch.updatedAt ? this.timeAgo(ch.updatedAt) : "";

        item.innerHTML = `
          <span class="channel-icon">${icon}</span>
          <span class="channel-name">${escapeHtml(ch.title)}</span>
          <span class="channel-time">${timeAgo}</span>
        `;

        item.addEventListener("click", () => this.openChannel(ch.key, ch.conversationId));
        el.appendChild(item);
      }
    }
  },

  async openChannel(channelKey, conversationId) {
    this.currentChannelKey = channelKey;
    this.currentConversationId = conversationId || null;
    this.elements.welcomeScreen.style.display = "none";
    this.elements.chatArea.style.display = "flex";
    this.elements.inputArea.style.display = "block";

    // Update topbar
    const ch = this.channels.find((c) => c.key === channelKey);
    const icon = PLATFORM_ICONS[ch?.platform] || PLATFORM_ICONS.web;
    this.elements.topbarTitle.textContent = ch ? `${icon} ${ch.title}` : channelKey;

    // Load messages
    if (conversationId) {
      try {
        const data = await API.getConversation(conversationId);
        this.renderMessages(data.messages || []);
      } catch {
        this.elements.chatArea.innerHTML = "";
      }
    } else {
      this.elements.chatArea.innerHTML = "";
    }

    this.renderChannelList();
    this.elements.messageInput.focus();
  },

  // --- Messages ---
  renderMessages(messages) {
    this.elements.chatArea.innerHTML = "";
    this.lastMessageRole = null;
    this.lastMessageTime = 0;
    for (const msg of messages) {
      this.appendMessage(msg.role, msg.content);
    }
    this.scrollToBottom();
  },

  appendMessage(role, content, isStreaming = false) {
    const msg = document.createElement("div");

    // Slack-style grouping: same sender within 5 minutes
    const now = Date.now();
    const isGrouped = (role === this.lastMessageRole) && (now - this.lastMessageTime < 5 * 60 * 1000);
    msg.className = `message ${role}${isGrouped ? " grouped" : ""}`;

    const initials = this.botName ? this.botName.slice(0, 2).toUpperCase() : "OC";
    const avatar = role === "assistant" ? initials : "U";

    // Copy button for assistant messages
    const copyBtn = role === "assistant" && !isStreaming
      ? `<button class="msg-copy-btn" onclick="navigator.clipboard.writeText(this.closest('.message').querySelector('.message-text').textContent)">Copy</button>`
      : "";

    msg.innerHTML = `
      <div class="message-avatar">${avatar}</div>
      <div class="message-content">
        <div class="message-role">${role === "assistant" ? escapeHtml(this.botName) : "You"}</div>
        <div class="message-text ${isStreaming ? "streaming-cursor" : ""}">${this.renderMarkdown(content)}</div>
      </div>
      ${copyBtn}
    `;

    this.lastMessageRole = role;
    this.lastMessageTime = now;

    this.elements.chatArea.appendChild(msg);
    this.scrollToBottom();
    return msg;
  },

  updateStreamingMessage(msgEl, content) {
    const textEl = msgEl.querySelector(".message-text");
    if (textEl) {
      textEl.innerHTML = this.renderMarkdown(content);
    }
  },

  finishStreaming(msgEl) {
    const textEl = msgEl.querySelector(".message-text");
    if (textEl) {
      textEl.classList.remove("streaming-cursor");
    }
    // Add copy button after streaming completes
    if (!msgEl.querySelector(".msg-copy-btn")) {
      const btn = document.createElement("button");
      btn.className = "msg-copy-btn";
      btn.textContent = "Copy";
      btn.onclick = () => navigator.clipboard.writeText(textEl.textContent);
      msgEl.appendChild(btn);
    }
  },

  // --- Send ---
  async send() {
    const text = this.elements.messageInput.value.trim();
    if (!text || this.isStreaming) return;

    // Clear input
    this.elements.messageInput.value = "";
    this.elements.messageInput.style.height = "auto";
    this.elements.sendBtn.disabled = true;

    // Show chat area if on welcome screen
    this.elements.welcomeScreen.style.display = "none";
    this.elements.chatArea.style.display = "flex";
    this.elements.inputArea.style.display = "block";

    // Default to web:default channel
    if (!this.currentChannelKey) {
      this.currentChannelKey = "web:default";
    }

    // Handle /clear locally — clear display, keep history
    if (text === "/clear") {
      this.elements.chatArea.innerHTML = "";
      this.appendMessage("assistant", "Chat cleared. History preserved in database.");
      this.elements.sendBtn.disabled = false;
      this.elements.messageInput.focus();
      return;
    }

    // Handle /reset — create fresh conversation for this channel
    if (text === "/reset") {
      this.currentConversationId = null;
      this.lastMessageRole = null;
      this.lastMessageTime = 0;
      this.elements.chatArea.innerHTML = "";
      this.appendMessage("assistant", "Session reset. Starting fresh conversation for this channel.");
      this.elements.sendBtn.disabled = false;
      this.elements.messageInput.focus();
      return;
    }

    // Append user message
    this.appendMessage("user", text);

    // Create streaming assistant message
    const assistantMsg = this.appendMessage("assistant", "", true);
    let fullResponse = "";

    this.isStreaming = true;

    try {
      await API.sendMessage(
        this.currentConversationId,
        text,
        // onText
        (content) => {
          fullResponse += content;
          // Strip setup marker from display
          const displayText = fullResponse.split("|||PERSONALITY_COMPLETE|||")[0];
          this.updateStreamingMessage(assistantMsg, displayText);
          this.scrollToBottom();
          // Notify setup module
          if (typeof Setup !== "undefined") Setup.handleStreamingText(fullResponse);
        },
        // onDone
        (data) => {
          if (data?.type === "conversation" && data.conversationId) {
            this.currentConversationId = data.conversationId;
          }
          this.finishStreaming(assistantMsg);
          this.loadChannels();
          // Check for personality completion
          if (typeof Setup !== "undefined") Setup.handleStreamComplete(fullResponse);
        },
        // onError
        (error) => {
          this.finishStreaming(assistantMsg);
          if (!fullResponse) {
            assistantMsg.querySelector(".message-text").innerHTML =
              `<span style="color:var(--danger)">${escapeHtml(error)}</span>`;
          }
          App.showToast(error, "error");
        },
        // channelKey
        this.currentChannelKey
      );
    } catch (err) {
      this.finishStreaming(assistantMsg);
      App.showToast(err.message, "error");
    }

    this.isStreaming = false;
    this.elements.sendBtn.disabled = false;
    this.elements.messageInput.focus();
  },

  // --- Utilities ---
  scrollToBottom() {
    const el = this.elements.chatArea;
    el.scrollTop = el.scrollHeight;
  },

  timeAgo(dateStr) {
    if (!dateStr) return "";
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "now";
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  },

  /**
   * Simple markdown renderer (no external deps).
   */
  renderMarkdown(text) {
    if (!text) return "";
    let html = escapeHtml(text);

    // Code blocks (```lang\ncode\n```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
      const langLabel = lang || "code";
      return `<div class="code-header"><span>${escapeHtml(langLabel)}</span><button class="copy-btn" onclick="navigator.clipboard.writeText(this.closest('.code-header').nextElementSibling.textContent)">Copy</button></div><pre><code>${code}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

    // Italic
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // Newlines to <br> (but not inside pre blocks)
    html = html.replace(/\n/g, "<br>");

    return html;
  },
};

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
