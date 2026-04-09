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
  botName: "Tarsee",
  lastMessageRole: null,
  lastMessageTime: 0,
  pendingFiles: [],
  messageQueue: [],

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
      chatFileInput: document.getElementById("chatFileInput"),
      attachBtn: document.getElementById("attachBtn"),
      attachmentsPreview: document.getElementById("attachmentsPreview"),
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
      const hasText = el.value.trim() || this.pendingFiles.length;
      this.elements.sendBtn.disabled = !hasText;
      // During streaming: show send button (for queueing) when there's text, stop when empty
      if (this.isStreaming) {
        this.elements.sendBtn.classList.toggle("stop-mode", !hasText);
      }
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

      // Normal Enter to send (or queue if streaming)
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (this.elements.messageInput.value.trim() || this.pendingFiles.length) {
          this.send(); // send() handles queueing internally when isStreaming
        }
      }

      // Escape to stop generation
      if (e.key === "Escape" && this.isStreaming) {
        e.preventDefault();
        this.stopGeneration();
      }
    });

    // Dismiss palette on outside click
    document.addEventListener("click", (e) => {
      if (this.paletteVisible && !this.elements.commandPalette.contains(e.target) && e.target !== this.elements.messageInput) {
        this.hidePalette();
      }
    });

    this.elements.sendBtn.addEventListener("click", () => {
      if (this.isStreaming && !this.elements.messageInput.value.trim()) {
        // Empty input + streaming = stop generation
        this.stopGeneration();
      } else if (this.isStreaming && this.elements.messageInput.value.trim()) {
        // Has text + streaming = queue the message
        this.send();
      } else {
        this.send();
      }
    });

    // File upload: attach button triggers hidden input
    this.elements.attachBtn.addEventListener("click", () => this.elements.chatFileInput.click());
    this.elements.chatFileInput.addEventListener("change", (e) => {
      if (e.target.files.length) {
        this.addPendingFiles(Array.from(e.target.files));
        e.target.value = ""; // reset so same file can be re-selected
      }
    });

    // Drag-and-drop on chat area
    const chatArea = this.elements.chatArea;
    chatArea.addEventListener("dragover", (e) => { e.preventDefault(); chatArea.classList.add("drag-over"); });
    chatArea.addEventListener("dragleave", (e) => { e.preventDefault(); chatArea.classList.remove("drag-over"); });
    chatArea.addEventListener("drop", (e) => {
      e.preventDefault();
      chatArea.classList.remove("drag-over");
      if (e.dataTransfer.files.length) {
        this.addPendingFiles(Array.from(e.dataTransfer.files));
      }
    });

    // Paste images from clipboard (Ctrl+V / Cmd+V screenshots)
    this.elements.messageInput.addEventListener("paste", (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files = [];
      for (const item of items) {
        if (item.kind === "file") {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length) {
        e.preventDefault();
        this.addPendingFiles(files);
      }
    });

    // Copy button delegation (works for both message copy and code block copy)
    document.addEventListener("click", (e) => {
      const copyBtn = e.target.closest(".msg-copy-btn, .copy-btn");
      if (!copyBtn) return;
      const msg = copyBtn.closest(".message");
      const codeBlock = copyBtn.closest(".code-header")?.nextElementSibling;
      let text;
      if (codeBlock) {
        text = codeBlock.textContent;
      } else if (msg) {
        // Clone message text, remove tool blocks, get clean text only
        const clone = msg.querySelector(".message-text")?.cloneNode(true);
        if (clone) {
          clone.querySelectorAll(".tool-block, .block-streaming-indicator").forEach(el => el.remove());
          text = clone.textContent?.trim();
        }
      }
      if (text) {
        navigator.clipboard.writeText(text).then(() => {
          copyBtn.textContent = "Copied!";
          setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
        }).catch(() => {
          // Fallback for non-HTTPS
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
          copyBtn.textContent = "Copied!";
          setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
        });
      }
    });

    // Welcome suggestion cards
    document.querySelectorAll(".welcome-suggestion").forEach((el) => {
      el.addEventListener("click", () => {
        this.elements.messageInput.value = el.dataset.msg;
        this.elements.sendBtn.disabled = false;
        this.elements.messageInput.focus();
      });
    });

    // Session bar
    this.elements.sessionBar = document.getElementById("sessionBar");
    this.elements.sessionModel = document.getElementById("sessionModel");
    this.elements.sessionStatus = document.getElementById("sessionStatus");
    this.elements.contextBarFill = document.getElementById("contextBarFill");
    this.elements.contextLabel = document.getElementById("contextLabel");
    document.getElementById("newSessionBtn")?.addEventListener("click", async () => {
      if (this.currentConversationId) {
        try {
          await API.json(`/api/chat/conversations/${this.currentConversationId}/reset-session`, { method: "POST" });
          this.elements.sessionStatus.textContent = "New Session";
          App.showToast("Session reset", "success");
        } catch { /* ignore */ }
      }
    });

    this.loadChannels();
    this.loadCommands();
    this.loadBotName();
    this.initEffortPills();
  },

  updateSessionBar() {
    const bar = this.elements.sessionBar;
    if (!bar) return;
    bar.style.display = "flex";

    // Model name — read from server settings
    const alias = { "claude-opus-4-6": "opus", "claude-sonnet-4-6": "sonnet", "claude-haiku-4-5": "haiku" };
    API.json("/api/settings").then(data => {
      const model = (data.settings || []).find(s => s.key === "ai.claude-code.model")?.value;
      this.elements.sessionModel.textContent = alias[model] || alias[Object.keys(alias).find(k => k.includes("opus"))] || "opus";
    }).catch(() => {});

    // Context usage (approximate from message count)
    if (this.currentConversationId) {
      API.json(`/api/chat/conversations/${this.currentConversationId}`).then(data => {
        const msgs = data.messages || [];
        const totalChars = msgs.reduce((sum, m) => sum + (m.content?.length || 0), 0);
        // Rough estimate: 4 chars per token, 1M token window
        const approxTokens = Math.round(totalChars / 4);
        const maxTokens = 1_000_000;
        const pct = Math.min(100, Math.round((approxTokens / maxTokens) * 100));
        this.elements.contextBarFill.style.width = `${pct}%`;
        this.elements.contextBarFill.className = `context-bar-fill${pct > 80 ? " danger" : pct > 50 ? " warning" : ""}`;
        this.elements.contextLabel.textContent = `${pct}%`;
        this.elements.sessionStatus.textContent = msgs.length > 0 ? `${msgs.length} messages` : "New Session";
      }).catch(() => {});
    } else {
      this.elements.sessionStatus.textContent = "New Session";
      this.elements.contextBarFill.style.width = "0%";
      this.elements.contextLabel.textContent = "0%";
    }
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
      // Ignore default/autofill names — only use names set via IDENTITY.md
      const name = data.botName;
      const ignored = ["admin", "user", "root", "tarsee", ""];
      this.setBotName(name && !ignored.includes(name.toLowerCase()) ? name : "Tarsee");
    } catch {
      this.setBotName("Tarsee");
    }

    // Also load IDENTITY.md to get emoji for welcome screen
    try {
      const identity = await API.json("/api/settings/workspace-file?name=IDENTITY.md");
      if (identity.content) this.applyIdentity(identity.content);
    } catch {
      // ignore — use initials
    }
  },

  applyIdentity(content) {
    // Parse IDENTITY.md for emoji and name
    // Format: - **Label:** value
    let emoji = null;
    let name = null;
    for (const line of content.split("\n")) {
      const match = line.match(/^-\s*\*\*(.+?)\*\*:?\s*(.+)/);
      if (!match) continue;
      const label = match[1].toLowerCase().trim();
      const value = match[2].trim();
      if (label === "emoji" && value) emoji = value;
      if (label === "name" && value) name = value;
    }

    // Update welcome logo with emoji if available
    const welcomeLogo = document.getElementById("welcomeLogo");
    if (welcomeLogo && emoji) {
      welcomeLogo.textContent = emoji;
      welcomeLogo.classList.add("emoji");
    }

    // If identity has a name, update bot name
    if (name && name !== this.botName) {
      this.setBotName(name);
    }
  },

  setBotName(name) {
    this.botName = name || "Tarsee";
    const initials = this.botName.slice(0, 2).toUpperCase();

    // Update topbar title (only if showing default, not in settings)
    if (!this.currentChannelKey && !(typeof Settings !== "undefined" && Settings.isOpen)) {
      this.elements.topbarTitle.textContent = this.botName;
    }

    // Update welcome screen
    const welcomeTitle = document.getElementById("welcomeTitle");
    if (welcomeTitle) welcomeTitle.textContent = `Welcome to ${this.botName}`;

    // Update sidebar header
    const sidebarH1 = document.querySelector(".sidebar-header h1");
    if (sidebarH1) sidebarH1.textContent = this.botName;

    // Sidebar logo and welcome logo use the tarsier image — don't overwrite with initials
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
      : [{ key: "web:default", platform: "web", title: "Main Session", conversationId: null, updatedAt: null }, ...this.channels];

    // Group by platform
    const groups = {};
    for (const ch of allChannels) {
      if (!groups[ch.platform]) groups[ch.platform] = [];
      groups[ch.platform].push(ch);
    }

    // Platform labels
    const platformLabels = { web: "Web", telegram: "Telegram", discord: "Discord" };
    const platformOrder = ["web", "telegram", "discord"];

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

        // Clean display name — use platform name for non-web channels
        let displayName = ch.title;
        if (ch.key === "web:default") displayName = "Main Session";
        else if (ch.platform === "telegram" && ch.title.startsWith("Chat with")) displayName = ch.title.replace("Chat with ", "");
        else if (ch.platform !== "web" && ch.title.length > 25) displayName = ch.title.slice(0, 25) + "...";

        item.innerHTML = `
          <span class="channel-icon">${icon}</span>
          <span class="channel-name">${escapeHtml(displayName)}</span>
          <span class="channel-time">${timeAgo}</span>
          <button class="channel-delete" title="Delete session">&times;</button>
        `;

        item.querySelector(".channel-name").addEventListener("click", () => this.openChannel(ch.key, ch.conversationId));
        item.querySelector(".channel-icon").addEventListener("click", () => this.openChannel(ch.key, ch.conversationId));
        item.querySelector(".channel-delete").addEventListener("click", (e) => {
          e.stopPropagation();
          this.showDeleteModal(displayName, ch.conversationId, ch.key);
        });
        el.appendChild(item);
      }
    }
  },

  async openChannel(channelKey, conversationId) {
    // Close settings if open
    if (typeof Settings !== "undefined" && Settings.isOpen) {
      Settings.close();
    }

    this.currentChannelKey = channelKey;
    this.currentConversationId = conversationId || null;
    this.elements.welcomeScreen.style.display = "none";
    this.elements.chatArea.style.display = "flex";
    this.elements.inputArea.style.display = "block";


    // Update topbar with clean display name
    const ch = this.channels.find((c) => c.key === channelKey);
    const icon = PLATFORM_ICONS[ch?.platform] || PLATFORM_ICONS.web;
    let topbarName = ch?.title || channelKey;
    if (channelKey === "web:default") topbarName = "Main Session";
    else if (ch?.platform === "telegram" && topbarName.startsWith("Chat with")) topbarName = topbarName.replace("Chat with ", "");
    this.elements.topbarTitle.textContent = `${icon} ${topbarName}`;

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

    this.updateSessionBar();
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

    const avatar = role === "assistant"
      ? `<img src="/icon-32.png" alt="" class="avatar-img">`
      : "U";

    // Copy button for assistant messages
    const copyBtn = role === "assistant" && !isStreaming
      ? `<button class="msg-copy-btn">Copy</button>`
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

  updateStreamingMessage(msgEl, content, rawHtml = false) {
    const textEl = msgEl.querySelector(".message-text");
    if (textEl) {
      if (rawHtml) {
        textEl.innerHTML = content;
      } else {
        // Hide incomplete XML blocks during streaming (they render as raw text until closed)
        const cleaned = hideIncompleteBlocks(content);
        textEl.innerHTML = this.renderMarkdown(cleaned);
      }
    }
  },

  finishStreaming(msgEl) {
    // Remove thinking indicator if still present
    const thinkEl = msgEl.querySelector(".chat-thinking");
    if (thinkEl) thinkEl.remove();
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

  // --- File Attachments ---
  addPendingFiles(files) {
    for (const file of files) {
      // Limit individual file to 10 MB
      if (file.size > 10 * 1024 * 1024) {
        App.showToast(`File "${file.name}" exceeds 10 MB limit`, "error");
        continue;
      }
      this.pendingFiles.push(file);
    }
    this.renderAttachmentsPreview();
    this.elements.sendBtn.disabled = !(this.elements.messageInput.value.trim() || this.pendingFiles.length);
  },

  removePendingFile(index) {
    this.pendingFiles.splice(index, 1);
    this.renderAttachmentsPreview();
    this.elements.sendBtn.disabled = !(this.elements.messageInput.value.trim() || this.pendingFiles.length);
  },

  renderAttachmentsPreview() {
    const container = this.elements.attachmentsPreview;
    if (!this.pendingFiles.length) {
      container.style.display = "none";
      container.innerHTML = "";
      return;
    }
    container.style.display = "flex";
    container.innerHTML = this.pendingFiles.map((file, i) => {
      const isImage = file.type.startsWith("image/");
      const thumb = isImage
        ? `<img src="${URL.createObjectURL(file)}" alt="">`
        : `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z" stroke="currentColor" stroke-width="1.2"/><path d="M9 1v4h4" stroke="currentColor" stroke-width="1.2"/></svg>`;
      return `<div class="chat-attachment-thumb">
        ${thumb}
        <span class="att-name">${escapeHtml(file.name)}</span>
        <button class="chat-attachment-remove" data-index="${i}" title="Remove">&times;</button>
      </div>`;
    }).join("");

    container.querySelectorAll(".chat-attachment-remove").forEach((btn) => {
      btn.addEventListener("click", () => this.removePendingFile(parseInt(btn.dataset.index, 10)));
    });
  },

  fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(",")[1]); // strip data:...;base64, prefix
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  },

  getAttachmentType(mimeType) {
    if (mimeType.startsWith("image/")) return "image";
    if (mimeType.startsWith("audio/")) return "audio";
    if (mimeType === "application/pdf") return "pdf";
    return "file";
  },

  async buildAttachments() {
    const attachments = [];
    for (const file of this.pendingFiles) {
      const data = await this.fileToBase64(file);
      attachments.push({
        type: this.getAttachmentType(file.type),
        name: file.name,
        data,
        mediaType: file.type || "application/octet-stream",
      });
    }
    return attachments;
  },

  renderMessageAttachments(attachments) {
    if (!attachments || !attachments.length) return "";
    const images = attachments.filter(a => a.type === "image");
    const others = attachments.filter(a => a.type !== "image");
    let html = "";
    if (images.length) {
      html += '<div class="message-images">';
      for (const img of images) {
        html += `<img src="data:${escapeHtml(img.mediaType)};base64,${img.data}" alt="${escapeHtml(img.name)}">`;
      }
      html += "</div>";
    }
    for (const f of others) {
      html += `<div class="message-file-chip"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z" stroke="currentColor" stroke-width="1.2"/><path d="M9 1v4h4" stroke="currentColor" stroke-width="1.2"/></svg> ${escapeHtml(f.name)}</div>`;
    }
    return html;
  },

  // --- Send ---
  async send() {
    const text = this.elements.messageInput.value.trim();
    const hasFiles = this.pendingFiles.length > 0;
    if (!text && !hasFiles) return;

    // Queue if already streaming
    if (this.isStreaming) {
      const attachments = hasFiles ? await this.buildAttachments() : [];
      if (hasFiles) { this.pendingFiles = []; this.renderAttachmentsPreview(); }
      this.elements.messageInput.value = "";
      this.elements.messageInput.style.height = "auto";
      this.elements.sendBtn.disabled = true;

      this.messageQueue.push({ text, attachments });
      // Show queued message in chat with badge
      const queuedMsg = this.appendMessage("user", text);
      const badge = document.createElement("span");
      badge.className = "queue-badge";
      badge.textContent = `Queued #${this.messageQueue.length}`;
      queuedMsg.querySelector(".message-role")?.appendChild(badge);
      queuedMsg.dataset.queued = "true";
      this.scrollToBottom();
      return;
    }

    // Build attachments from pending files before clearing
    let attachments = [];
    if (hasFiles) {
      attachments = await this.buildAttachments();
      this.pendingFiles = [];
      this.renderAttachmentsPreview();
    }

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

    // Append user message (with attachment previews if any)
    const userMsg = this.appendMessage("user", text);
    if (attachments.length) {
      const textEl = userMsg.querySelector(".message-text");
      textEl.insertAdjacentHTML("afterend", this.renderMessageAttachments(attachments));
    }

    // Create streaming assistant message with thinking indicator as initial content
    const assistantMsg = this.appendMessage("assistant", "", true);
    const msgTextEl = assistantMsg.querySelector(".message-text");
    if (msgTextEl) {
      msgTextEl.innerHTML = '<div class="chat-thinking"><span class="thinking-text">Thinking</span><span class="thinking-dots"></span></div>';
      msgTextEl.classList.remove("streaming-cursor"); // Don't show cursor while thinking
    }
    let hasReceivedText = false;
    let fullResponse = "";
    let toolBlocks = ""; // Accumulated tool call/result HTML

    this.isStreaming = true;
    this.elements.sendBtn.disabled = false;
    this.elements.sendBtn.classList.add("stop-mode");
    this.elements.sendBtn.title = "Stop generation (Esc)";

    try {
      await API.sendMessage(
        this.currentConversationId,
        text,
        // onText (content for text, null + event for tool/thinking events)
        (content, event) => {
          if (event?.type === "model_selected") {
            // Auto-routing: update session bar badge with the chosen model
            const badge = document.getElementById("sessionModel");
            if (badge) {
              const isOpus = event.model?.includes("opus");
              const isHaiku = event.model?.includes("haiku");
              badge.textContent = isOpus ? "OPUS" : isHaiku ? "HAIKU" : "SONNET";
              badge.className = "session-model model-" + (isOpus ? "opus" : isHaiku ? "haiku" : "sonnet");
            }
            return;
          }
          if (event?.type === "thinking") {
            // Show/keep thinking indicator — don't remove it, it stays until text/tools arrive
            if (!hasReceivedText) {
              const existing = assistantMsg.querySelector(".chat-thinking");
              if (!existing) {
                const thinkingEl = document.createElement("div");
                thinkingEl.className = "chat-thinking";
                thinkingEl.innerHTML = '<span class="thinking-text">Thinking</span><span class="thinking-dots"></span>';
                assistantMsg.querySelector(".message-text")?.appendChild(thinkingEl);
              }
            }
            return;
          }
          if (event?.type === "tool_call") {
            if (!hasReceivedText) hasReceivedText = true;
            // Clean tool block — name + detail, collapsible input
            // Build human-readable detail based on tool type
            const inp = event.input || {};
            let detail = "";
            let label = event.name;
            if (event.name === "Bash") { detail = inp.command || ""; }
            else if (event.name === "Read") { detail = inp.file_path || inp.filename || ""; label = "Read"; }
            else if (event.name === "Write") { detail = inp.file_path || inp.filename || ""; label = "Write"; }
            else if (event.name === "Edit") { detail = inp.file_path || ""; label = "Edit"; }
            else if (event.name === "Grep") { detail = `"${inp.pattern || ""}" ${inp.path || ""}`; label = "Search"; }
            else if (event.name === "Glob") { detail = inp.pattern || ""; label = "Find"; }
            else { detail = inp.command || inp.filename || inp.url || inp.query || inp.message || inp.task || inp.schedule || inp.key || JSON.stringify(inp).slice(0, 80); }

            toolBlocks += `<details class="tool-block">
              <summary class="tool-block-header">
                <span class="tool-indicator running"></span>
                <span class="tool-name">${escapeHtml(label)}</span>
                <span class="tool-detail">${escapeHtml(String(detail).slice(0, 120))}</span>
              </summary>
              <div class="tool-block-body">
                <pre class="tool-block-code">${escapeHtml(String(detail).slice(0, 500) || "(no args)")}</pre>
              </div>
            </details>`;
            this.updateStreamingMessage(assistantMsg, toolBlocks, true);
            this.scrollToBottom();
            return;
          }
          if (event?.type === "tool_result") {
            const resultText = event.result || "";
            // Update indicator to done
            toolBlocks = toolBlocks.replace(/running"><\/span>(?![\s\S]*running"><\/span>)/, 'done"></span>');
            // Add output (only if there's content)
            if (resultText && resultText !== "(no output)") {
              const outputHtml = `<div class="tool-block-output"><pre class="tool-block-code">${escapeHtml(resultText.slice(0, 2000))}</pre></div>`;
              toolBlocks = toolBlocks.replace(/<\/div>\s*<\/details>$/, outputHtml + "</div></details>");
            }
            this.updateStreamingMessage(assistantMsg, toolBlocks, true);
            this.scrollToBottom();
            return;
          }
          // Normal text — updateStreamingMessage will overwrite thinking indicator
          if (!hasReceivedText) hasReceivedText = true;
          fullResponse += content;
          // Strip setup marker and [REMEMBER: ...] markers from display
          let displayText = fullResponse.split("|||PERSONALITY_COMPLETE|||")[0];
          displayText = displayText.replace(/\[REMEMBER:\s*.+?\]/gi, "").replace(/\n{3,}/g, "\n\n");
          this.updateStreamingMessage(assistantMsg, toolBlocks + this.renderMarkdown(displayText), true);
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
          this.updateSessionBar();
          this.loadChannels();
          // Check for personality completion
          if (typeof Setup !== "undefined") Setup.handleStreamComplete(fullResponse);
        },
        // onError
        (error) => {
          this.finishStreaming(assistantMsg);
          if (!fullResponse) {
            assistantMsg.querySelector(".message-text").innerHTML =
              `<span class="text-danger">${escapeHtml(error)}</span>`;
          }
          App.showToast(error, "error");
        },
        // channelKey
        this.currentChannelKey,
        // attachments
        attachments.length ? attachments : undefined,
        // effort
        this.getEffort()
      );
    } catch (err) {
      this.finishStreaming(assistantMsg);
      App.showToast(err.message, "error");
    }

    this.isStreaming = false;
    this.elements.sendBtn.disabled = false;
    this.elements.sendBtn.classList.remove("stop-mode");
    this.elements.sendBtn.title = "Send";
    this.elements.messageInput.focus();

    // Drain queue — send next queued message
    if (this.messageQueue.length > 0) {
      const next = this.messageQueue.shift();
      // Remove "Queued" badges and update remaining positions
      document.querySelectorAll('.queue-badge').forEach((b, i) => {
        if (i === 0) b.remove(); // Remove badge from the one being sent now
        else b.textContent = `Queued #${i}`;
      });
      // Small delay so the user sees the transition
      setTimeout(() => this.sendQueued(next.text, next.attachments), 300);
    }
  },

  /** Send a queued message (already displayed in chat) */
  async sendQueued(text, attachments) {
    // Show chat area
    this.elements.welcomeScreen.style.display = "none";
    this.elements.chatArea.style.display = "flex";
    this.elements.inputArea.style.display = "block";

    if (!this.currentChannelKey) {
      this.currentChannelKey = `web:default`;
    }

    // Session bar
    const sessionBar = document.getElementById("sessionBar");
    if (sessionBar) sessionBar.style.display = "flex";

    // Create assistant message with thinking indicator
    const assistantMsg = this.appendMessage("assistant", "", true);
    const thinkingEl = document.createElement("div");
    thinkingEl.className = "chat-thinking";
    thinkingEl.innerHTML = '<span class="thinking-text">Thinking</span><span class="thinking-dots"></span>';
    const msgContent = assistantMsg.querySelector(".message-content");
    const msgText = assistantMsg.querySelector(".message-text");
    if (msgContent && msgText) msgContent.insertBefore(thinkingEl, msgText);
    let hasReceivedText = false;
    let fullResponse = "";
    let toolBlocks = "";

    this.isStreaming = true;
    this.elements.sendBtn.disabled = false;
    this.elements.sendBtn.classList.add("stop-mode");
    this.elements.sendBtn.title = "Stop generation (Esc)";

    try {
      await API.sendMessage(
        this.currentConversationId,
        text,
        (content, event) => {
          if (event?.type === "thinking") return;
          if (event?.type === "tool_call") {
            if (!hasReceivedText) {
              hasReceivedText = true;
              const thinkEl = assistantMsg.querySelector(".chat-thinking");
              if (thinkEl) thinkEl.remove();
            }
            const inp = event.input || {};
            let detail = "";
            let label = event.name;
            if (event.name === "Bash") { detail = inp.command || ""; }
            else if (event.name === "Read") { detail = inp.file_path || inp.filename || ""; label = "Read"; }
            else if (event.name === "Write") { detail = inp.file_path || inp.filename || ""; label = "Write"; }
            else if (event.name === "Edit") { detail = inp.file_path || ""; label = "Edit"; }
            else if (event.name === "Grep") { detail = `"${inp.pattern || ""}" ${inp.path || ""}`; label = "Search"; }
            else if (event.name === "Glob") { detail = inp.pattern || ""; label = "Find"; }
            else { detail = inp.command || inp.filename || inp.url || inp.query || inp.message || inp.task || inp.schedule || inp.key || JSON.stringify(inp).slice(0, 80); }
            toolBlocks += `<details class="tool-block"><summary class="tool-block-header"><span class="tool-indicator running"></span><span class="tool-name">${escapeHtml(label)}</span><span class="tool-detail">${escapeHtml(String(detail).slice(0, 120))}</span></summary><div class="tool-block-body"><pre class="tool-block-code">${escapeHtml(String(detail).slice(0, 500) || "(no args)")}</pre></div></details>`;
            this.updateStreamingMessage(assistantMsg, toolBlocks, true);
            this.scrollToBottom();
            return;
          }
          if (event?.type === "tool_result") {
            const resultText = event.result || "";
            toolBlocks = toolBlocks.replace(/running"><\/span>(?![\s\S]*running"><\/span>)/, 'done"></span>');
            if (resultText && resultText !== "(no output)") {
              toolBlocks = toolBlocks.replace(/<\/div>\s*<\/details>$/, `<div class="tool-block-output"><pre class="tool-block-code">${escapeHtml(resultText.slice(0, 2000))}</pre></div></div></details>`);
            }
            this.updateStreamingMessage(assistantMsg, toolBlocks, true);
            this.scrollToBottom();
            return;
          }
          if (!hasReceivedText) {
            hasReceivedText = true;
            const thinkEl = assistantMsg.querySelector(".chat-thinking");
            if (thinkEl) thinkEl.remove();
          }
          fullResponse += content;
          let displayText = fullResponse.split("|||PERSONALITY_COMPLETE|||")[0];
          displayText = displayText.replace(/\[REMEMBER:\s*.+?\]/gi, "").replace(/\n{3,}/g, "\n\n");
          this.updateStreamingMessage(assistantMsg, toolBlocks + this.renderMarkdown(displayText), true);
          this.scrollToBottom();
        },
        (data) => {
          if (data?.type === "conversation" && data.conversationId) {
            this.currentConversationId = data.conversationId;
          }
          this.finishStreaming(assistantMsg);
          this.updateSessionBar();
          this.loadChannels();
        },
        (error) => {
          this.finishStreaming(assistantMsg);
          if (!fullResponse) {
            assistantMsg.querySelector(".message-text").innerHTML =
              `<span class="text-danger">${escapeHtml(error)}</span>`;
          }
          App.showToast(error, "error");
        },
        this.currentChannelKey,
        attachments.length ? attachments : undefined
      );
    } catch (err) {
      this.finishStreaming(assistantMsg);
      App.showToast(err.message, "error");
    }

    this.isStreaming = false;
    this.elements.sendBtn.disabled = false;
    this.elements.sendBtn.classList.remove("stop-mode");
    this.elements.sendBtn.title = "Send";
    this.elements.messageInput.focus();

    // Continue draining queue
    if (this.messageQueue.length > 0) {
      const next = this.messageQueue.shift();
      document.querySelectorAll('.queue-badge').forEach((b, i) => {
        if (i === 0) b.remove();
        else b.textContent = `Queued #${i}`;
      });
      setTimeout(() => this.sendQueued(next.text, next.attachments), 300);
    }
  },

  getEffort() {
    const active = document.querySelector(".effort-pill.active");
    return active?.dataset.effort || undefined;
  },

  initEffortPills() {
    const container = document.getElementById("effortSelect");
    if (!container) return;
    container.addEventListener("click", (e) => {
      const pill = e.target.closest(".effort-pill");
      if (!pill) return;
      container.querySelectorAll(".effort-pill").forEach((p) => p.classList.remove("active"));
      pill.classList.add("active");
    });
  },

  stopGeneration() {
    if (!this.isStreaming) return;
    // Abort via HTTP endpoint
    const csrf = API.getCsrfToken();
    const headers = { "Content-Type": "application/json" };
    if (csrf) headers["X-CSRF-Token"] = csrf;
    fetch("/api/chat/stop", {
      method: "POST", headers, credentials: "same-origin",
      body: JSON.stringify({ conversationId: this.currentConversationId }),
    }).catch(() => {});
    App.showToast("Stopping...", "info");
  },

  // --- Session Deletion ---
  showDeleteModal(sessionName, conversationId, channelKey) {
    // Remove existing modal if any
    document.getElementById("deleteModal")?.remove();

    const modal = document.createElement("div");
    modal.id = "deleteModal";
    modal.className = "delete-modal-overlay";
    modal.innerHTML = `
      <div class="delete-modal">
        <div class="delete-modal-header">Delete Session</div>
        <p class="delete-modal-text">This will permanently delete <strong>${escapeHtml(sessionName)}</strong> and all its messages.</p>
        <p class="delete-modal-text">Type <strong>${escapeHtml(sessionName)}</strong> to confirm:</p>
        <input type="text" class="delete-modal-input" id="deleteConfirmInput" placeholder="Type session name..." autocomplete="off" spellcheck="false">
        <div class="delete-modal-actions">
          <button class="btn btn-sm delete-modal-cancel" id="deleteModalCancel">Cancel</button>
          <button class="btn btn-sm delete-modal-confirm" id="deleteModalConfirm" disabled>Delete</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    const input = document.getElementById("deleteConfirmInput");
    const confirmBtn = document.getElementById("deleteModalConfirm");
    const cancelBtn = document.getElementById("deleteModalCancel");

    input.addEventListener("input", () => {
      confirmBtn.disabled = input.value !== sessionName;
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && input.value === sessionName) {
        this.deleteSession(conversationId, channelKey);
        modal.remove();
      } else if (e.key === "Escape") {
        modal.remove();
      }
    });

    confirmBtn.addEventListener("click", () => {
      this.deleteSession(conversationId, channelKey);
      modal.remove();
    });

    cancelBtn.addEventListener("click", () => modal.remove());
    modal.addEventListener("click", (e) => { if (e.target === modal) modal.remove(); });

    setTimeout(() => input.focus(), 50);
  },

  async deleteSession(conversationId, channelKey) {
    try {
      if (conversationId) {
        await API.deleteConversation(conversationId);
      }

      // If deleted the current session, reset view
      if (channelKey === this.currentChannelKey) {
        this.currentChannelKey = null;
        this.currentConversationId = null;
        this.elements.chatArea.style.display = "none";
        this.elements.inputArea.style.display = "none";
        this.elements.welcomeScreen.style.display = "flex";
      }

      App.showToast("Session deleted", "success");
      this.loadChannels();
    } catch (err) {
      App.showToast("Failed to delete: " + err.message, "error");
    }
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
   * Markdown renderer with tool call, tool response, and thinking block support.
   */
  renderMarkdown(text) {
    if (!text) return "";
    // Strip any [REMEMBER: ...] markers that leaked through
    text = text.replace(/\[REMEMBER:\s*.+?\]/gi, "").replace(/\n{3,}/g, "\n\n").trim();

    // ── Extract special blocks BEFORE escaping HTML ──

    // Placeholders for blocks we'll inject after escaping
    const blocks = [];
    const PH = (i) => `\x00BLOCK${i}\x00`;

    // Canvas embeds: /canvas/id/ → inline iframe
    text = text.replace(/\/canvas\/([a-z0-9-]+)\/?/g, (_m, canvasId) => {
      const i = blocks.length;
      blocks.push(`<div class="canvas-embed"><div class="canvas-embed-header"><span class="canvas-embed-title">Canvas: ${escapeHtml(canvasId)}</span><a href="/canvas/${canvasId}/" target="_blank" class="canvas-embed-open">Open ↗</a></div><iframe src="/canvas/${canvasId}/" class="canvas-iframe" sandbox="allow-scripts allow-same-origin" loading="lazy"></iframe></div>`);
      return PH(i);
    });

    // Thinking / reasoning blocks: <thinking>, <antThinking>, <reasoning>
    text = text.replace(/<(thinking|antThinking|antml:thinking|reasoning)>([\s\S]*?)<\/\1>/g, (_m, tag, content) => {
      const i = blocks.length;
      const label = tag.includes("thinking") ? "Thinking" : "Reasoning";
      blocks.push(renderThinkingBlock(label, content.trim()));
      return PH(i);
    });

    // Function calls block: <function_calls>...<invoke name="X">...<parameter>...</parameter></invoke>...</function_calls>
    text = text.replace(/<function_calls>\s*([\s\S]*?)\s*<\/function_calls>/g, (_m, content) => {
      const i = blocks.length;
      blocks.push(renderFunctionCallsBlock(content.trim()));
      return PH(i);
    });

    // Function responses: <function_response>...</function_response>
    text = text.replace(/<function_response>\s*([\s\S]*?)\s*<\/function_response>/g, (_m, content) => {
      const i = blocks.length;
      blocks.push(renderToolResponseBlock(content.trim()));
      return PH(i);
    });

    // Tool calls: <tool_call> or <tool_use>
    text = text.replace(/<(tool_call|tool_use)>\s*(\{[\s\S]*?\})\s*<\/\1>/g, (_m, _tag, json) => {
      const i = blocks.length;
      blocks.push(renderToolCallBlock(json));
      return PH(i);
    });
    // Also handle the named format: <tool_call>\n{"name": "...", "arguments": {...}}\n</tool_call>
    text = text.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (_m, content) => {
      const i = blocks.length;
      blocks.push(renderToolCallBlock(content));
      return PH(i);
    });

    // Tool responses: <tool_response> or <tool_result>
    text = text.replace(/<(tool_response|tool_result)>\s*([\s\S]*?)\s*<\/\1>/g, (_m, _tag, content) => {
      const i = blocks.length;
      blocks.push(renderToolResponseBlock(content.trim()));
      return PH(i);
    });

    // Search/artifact blocks: <search_results>, <artifact>
    text = text.replace(/<(search_results|artifact|result)>([\s\S]*?)<\/\1>/g, (_m, tag, content) => {
      const i = blocks.length;
      blocks.push(renderGenericBlock(tag, content.trim()));
      return PH(i);
    });

    // Streaming indicator divs (injected by hideIncompleteBlocks during streaming)
    text = text.replace(/<div class="block-streaming-indicator">[\s\S]*?<\/div>/g, (match) => {
      const i = blocks.length;
      blocks.push(match);
      return PH(i);
    });

    // ── Now escape HTML on the remaining text ──
    let html = escapeHtml(text);

    // ── Markdown formatting ──

    // Code blocks FIRST (preserve newlines inside)
    const codeBlocks = [];
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
      const langLabel = lang || "code";
      const idx = codeBlocks.length;
      codeBlocks.push(`<div class="code-header"><span>${escapeHtml(langLabel)}</span><button class="copy-btn">Copy</button></div><pre><code>${code}</code></pre>`);
      return `\x01CODE${idx}\x01`;
    });

    // Convert newlines to <br> BEFORE parsing block elements
    html = html.replace(/\n/g, "<br>");

    // Markdown tables: | col | col | with |---|---| separator
    // Split into lines, find contiguous table blocks, convert to HTML
    const lines = html.split("<br>");
    let inTable = false;
    let tableLines = [];
    const outputLines = [];

    const flushTable = () => {
      if (tableLines.length < 2) {
        outputLines.push(...tableLines);
        tableLines = [];
        return;
      }
      const rows = tableLines.map(r => r.trim()).filter(r => r.startsWith("|") && r.endsWith("|"));
      const sepIdx = rows.findIndex(r => {
        const cells = r.replace(/^\||\|$/g, "").split("|");
        return cells.length >= 1 && cells.every(c => /^[\s\-:]+$/.test(c));
      });
      if (sepIdx === -1 || rows.length < 3) {
        outputLines.push(...tableLines);
        tableLines = [];
        return;
      }
      const parseRow = (r) => r.replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
      const headerRows = rows.slice(0, sepIdx);
      const bodyRows = rows.slice(sepIdx + 1);
      let table = '<table class="md-table">';
      if (headerRows.length > 0) {
        table += "<thead>";
        for (const r of headerRows) table += "<tr>" + parseRow(r).map(c => `<th>${c}</th>`).join("") + "</tr>";
        table += "</thead>";
      }
      if (bodyRows.length > 0) {
        table += "<tbody>";
        for (const r of bodyRows) table += "<tr>" + parseRow(r).map(c => `<td>${c}</td>`).join("") + "</tr>";
        table += "</tbody>";
      }
      table += "</table>";
      outputLines.push(table);
      tableLines = [];
    };

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
        tableLines.push(line);
      } else {
        if (tableLines.length > 0) flushTable();
        outputLines.push(line);
      }
    }
    if (tableLines.length > 0) flushTable();
    html = outputLines.join("<br>");

    // Headings (### h3, ## h2, # h1) — at start of line
    html = html.replace(/(^|<br>)### (.+?)(<br>|$)/g, "$1<h3>$2</h3>$3");
    html = html.replace(/(^|<br>)## (.+?)(<br>|$)/g, "$1<h2>$2</h2>$3");
    html = html.replace(/(^|<br>)# (.+?)(<br>|$)/g, "$1<h1>$2</h1>$3");

    // Horizontal rule
    html = html.replace(/(^|<br>)---(<br>|$)/g, "$1<hr>$2");

    // Blockquotes (> text) — collect consecutive lines into one blockquote
    html = html.replace(/((?:(?:^|<br>)&gt; .+?(?=<br>|$))+)/g, (block) => {
      const lines = block.split("<br>").map(l => l.replace(/^&gt;\s?/, "").trim()).filter(Boolean);
      return `<blockquote>${lines.join("<br>")}</blockquote>`;
    });

    // Ordered lists (1. item)
    html = html.replace(/(^|<br>)\d+\.\s(.+?)(?=<br>|$)/g, "$1<li>$2</li>");

    // Unordered lists (- item)
    html = html.replace(/(^|<br>)- (.+?)(?=<br>|$)/g, "$1<li>$2</li>");

    // Inline code
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

    // Italic
    html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");

    // Strikethrough
    html = html.replace(/~~(.+?)~~/g, "<del>$1</del>");

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // Re-inject code blocks
    for (let i = 0; i < codeBlocks.length; i++) {
      html = html.replace(`\x01CODE${i}\x01`, codeBlocks[i]);
    }

    // ── Re-inject extracted blocks ──
    for (let i = 0; i < blocks.length; i++) {
      html = html.replace(escapeHtml(PH(i)), blocks[i]);
    }

    return html;
  },
};

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// ── Streaming block helper ───────────────────────────────────────────

/**
 * During streaming, XML blocks like <tool_call>...</tool_call> appear as raw
 * text until the closing tag arrives. This replaces any unclosed block tags
 * with a nice "working" indicator so the user doesn't see raw XML.
 */
function hideIncompleteBlocks(text) {
  const blockTags = ["thinking", "antThinking", "antml:thinking", "reasoning", "tool_call", "tool_use", "tool_response", "tool_result", "function_calls", "function_response", "invoke", "search_results", "artifact", "result"];
  let result = text;

  for (const tag of blockTags) {
    // Check for opening tag without matching closing tag
    const openPattern = new RegExp(`<${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`, "g");
    const closePattern = new RegExp(`</${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}>`, "g");
    const opens = (result.match(openPattern) || []).length;
    const closes = (result.match(closePattern) || []).length;

    if (opens > closes) {
      // There's an unclosed block — replace the incomplete one with a placeholder
      const lastOpen = result.lastIndexOf(`<${tag}>`);
      if (lastOpen !== -1) {
        const label = tag.includes("think") || tag.includes("reason") ? "Thinking" :
                      tag.includes("tool_call") || tag.includes("tool_use") ? "Running tool" :
                      tag.includes("tool_r") ? "Processing result" : "Working";
        result = result.slice(0, lastOpen) +
          `\n<div class="block-streaming-indicator"><span class="streaming-dots"><span></span><span></span><span></span></span> ${label}…</div>`;
      }
    }
  }

  return result;
}

// ── Tool & Thinking Block Renderers ──────────────────────────────────

function renderThinkingBlock(label, content) {
  const preview = escapeHtml(content.slice(0, 120).replace(/\n/g, " ")) + (content.length > 120 ? "…" : "");
  const full = escapeHtml(content).replace(/\n/g, "<br>");
  return `<details class="block-thinking">
    <summary><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.2"/><path d="M6 6a2 2 0 012-2 2 2 0 012 2c0 1-1 1.5-1 2.5M8 11.5v.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg> ${label}<span class="block-preview">${preview}</span></summary>
    <div class="block-body">${full}</div>
  </details>`;
}

function renderToolCallBlock(content) {
  let name = "tool_call";
  let detail = "";
  let args = "";
  try {
    const parsed = JSON.parse(content);
    name = parsed.name || "tool_call";
    args = parsed.arguments ? JSON.stringify(parsed.arguments, null, 2) : "";
    // Extract a useful detail from arguments
    if (parsed.arguments) {
      detail = parsed.arguments.path || parsed.arguments.command || parsed.arguments.query || parsed.arguments.url || "";
      if (typeof detail === "string" && detail.length > 80) detail = detail.slice(0, 77) + "…";
    }
  } catch {
    // Not valid JSON — just show raw content
    args = content;
  }

  const argsHtml = args ? `<pre class="block-code">${escapeHtml(args)}</pre>` : "";
  const detailHtml = detail ? `<span class="block-detail">${escapeHtml(detail)}</span>` : "";

  const toolColors = {exec:"#f59e0b",read_file:"#3b82f6",write_file:"#8b5cf6",edit_file:"#8b5cf6",web_search:"#10b981",web_fetch:"#10b981",browser:"#10b981",remember:"#ec4899",search_memories:"#ec4899",spawn_agent:"#f97316",generate_image:"#06b6d4",analyze_image:"#06b6d4",create_canvas:"#a855f7",send_message:"#6366f1",schedule_task:"#eab308",pdf_read:"#ef4444"};
  const tc = toolColors[name] || "#6b7280";
  return `<div class="block-tool-call">
    <div class="block-tool-header">
      <span style="display:inline-flex;align-items:center;gap:5px;background:${tc}22;color:${tc};padding:2px 8px;border-radius:4px;font-size:12px;font-weight:600">
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none"><path d="M9.5 1.5L14 6l-4.5 4.5M6.5 14.5L2 10l4.5-4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        ${escapeHtml(name)}
      </span>
      ${detailHtml}
    </div>
    ${argsHtml}
  </div>`;
}

function renderToolResponseBlock(content) {
  const isLong = content.length > 200;
  const displayContent = escapeHtml(content).replace(/\n/g, "<br>");

  if (isLong) {
    const preview = escapeHtml(content.slice(0, 150).replace(/\n/g, " ")) + "…";
    return `<details class="block-tool-response">
      <summary><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M2 8h8M2 12h10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg> Tool output<span class="block-preview">${preview}</span></summary>
      <div class="block-body">${displayContent}</div>
    </details>`;
  }

  return `<div class="block-tool-response block-tool-response--inline">
    <div class="block-tool-response-header"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M2 8h8M2 12h10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg> Tool output</div>
    <div class="block-body">${displayContent}</div>
  </div>`;
}

function renderFunctionCallsBlock(content) {
  // Parse <invoke name="X"><parameter name="Y">value</parameter></invoke> blocks
  const invocations = [];
  const invokePattern = /<invoke\s+name="([^"]+)">([\s\S]*?)<\/invoke>/g;
  let match;
  while ((match = invokePattern.exec(content)) !== null) {
    const name = match[1];
    const params = {};
    const paramPattern = /<parameter\s+name="([^"]+)">([\s\S]*?)<\/parameter>/g;
    let pm;
    while ((pm = paramPattern.exec(match[2])) !== null) {
      params[pm[1]] = pm[2].trim();
    }
    invocations.push({ name, params });
  }

  if (invocations.length === 0) {
    // Fallback: show as generic tool call
    return renderToolCallBlock(content);
  }

  return invocations.map((inv) => {
    const detail = inv.params.cmd || inv.params.path || inv.params.command || inv.params.query || "";
    const argsStr = Object.entries(inv.params).length > 0
      ? JSON.stringify(inv.params, null, 2)
      : "";
    const argsHtml = argsStr ? `<pre class="block-code">${escapeHtml(argsStr)}</pre>` : "";
    const detailHtml = detail ? `<span class="block-detail">${escapeHtml(detail.slice(0, 80))}</span>` : "";

    return `<div class="block-tool-call">
      <div class="block-tool-header">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M9.5 1.5L14 6l-4.5 4.5M6.5 14.5L2 10l4.5-4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="block-tool-name">${escapeHtml(inv.name)}</span>
        ${detailHtml}
      </div>
      ${argsHtml}
    </div>`;
  }).join("");
}

function renderGenericBlock(tag, content) {
  const displayContent = escapeHtml(content).replace(/\n/g, "<br>");
  const label = tag.replace(/_/g, " ");
  return `<details class="block-generic">
    <summary><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.2"/><path d="M5 6h6M5 8h6M5 10h4" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg> ${escapeHtml(label)}</summary>
    <div class="block-body">${displayContent}</div>
  </details>`;
}
