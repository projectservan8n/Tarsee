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
      slashBtn: document.getElementById("slashBtn"),
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

    // Typing indicator WebSocket
    this._initTypingSocket();

    // Diagram node clicks: iframes post a message when a node is clicked
    this._initDiagramListener();

    // Auto-resize textarea + command palette trigger
    this.elements.messageInput.addEventListener("input", () => {
      this._sendTypingIndicator();
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

    // Slash button: opens the command palette without requiring the user to
    // type "/". Inserts a slash if the input is empty so the palette has
    // something to filter; otherwise just shows the full command list.
    this.elements.slashBtn?.addEventListener("click", () => {
      const input = this.elements.messageInput;
      if (!input.value.startsWith("/")) {
        input.value = "/" + input.value;
        input.dispatchEvent(new Event("input"));
      }
      input.focus();
      // Place caret at end so further typing filters the list.
      const len = input.value.length;
      input.setSelectionRange(len, len);
      this.showPalette(this.commands);
    });
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
        const origHTML = copyBtn.innerHTML;
        const flashSuccess = () => {
          copyBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8.5l3 3 7-7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
          copyBtn.style.opacity = "1";
          copyBtn.classList.add("copy-success");
          setTimeout(() => {
            copyBtn.innerHTML = origHTML;
            copyBtn.style.opacity = "";
            copyBtn.classList.remove("copy-success");
          }, 1500);
        };
        navigator.clipboard.writeText(text).then(flashSuccess).catch(() => {
          // Fallback for non-HTTPS
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); } catch {}
          document.body.removeChild(ta);
          flashSuccess();
        });
      }
    });

    // Canvas embed menu — "..." button opens Copy/Download. Clicking
    // anywhere else closes the menu.
    document.addEventListener("click", (e) => {
      const btn = e.target.closest(".canvas-embed-menu-btn");
      if (btn) {
        e.stopPropagation();
        const embed = btn.closest(".canvas-embed");
        const menu = embed?.querySelector(".canvas-embed-menu");
        const wasOpen = menu?.classList.contains("open");
        // Close any other open menus first.
        document.querySelectorAll(".canvas-embed-menu.open").forEach(m => m.classList.remove("open"));
        document.querySelectorAll(".canvas-embed-menu-btn.open").forEach(b => { b.classList.remove("open"); b.setAttribute("aria-expanded", "false"); });
        if (!wasOpen && menu) {
          menu.classList.add("open");
          btn.classList.add("open");
          btn.setAttribute("aria-expanded", "true");
        }
        return;
      }

      const copyItem = e.target.closest(".canvas-embed-menu-item[data-canvas-action='copy']");
      if (copyItem) {
        e.preventDefault();
        const embed = copyItem.closest(".canvas-embed");
        const canvasId = embed?.dataset.canvasId;
        if (canvasId) {
          const url = `${location.origin}/canvas/${canvasId}/`;
          navigator.clipboard.writeText(url).then(() => {
            if (window.App?.showToast) App.showToast("Link copied", "success");
          }).catch(() => {});
        }
        embed?.querySelector(".canvas-embed-menu")?.classList.remove("open");
        embed?.querySelector(".canvas-embed-menu-btn")?.classList.remove("open");
        return;
      }

      // Click outside — close any open menu.
      if (!e.target.closest(".canvas-embed-menu")) {
        document.querySelectorAll(".canvas-embed-menu.open").forEach(m => m.classList.remove("open"));
        document.querySelectorAll(".canvas-embed-menu-btn.open").forEach(b => { b.classList.remove("open"); b.setAttribute("aria-expanded", "false"); });
      }
    });

    // Welcome suggestion cards — clickable + keyboard activated (tabindex=0 set in markup)
    const activateSuggestion = (el) => {
      this.elements.messageInput.value = el.dataset.msg;
      this.elements.sendBtn.disabled = false;
      this.elements.messageInput.focus();
    };
    document.querySelectorAll(".welcome-suggestion").forEach((el) => {
      el.addEventListener("click", () => activateSuggestion(el));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          activateSuggestion(el);
        }
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
    this.initSearch();
  },

  updateSessionBar() {
    const bar = this.elements.sessionBar;
    if (!bar) return;
    bar.style.display = "flex";

    // Model name — pair the active model id with its registry tier so the
    // session bar shows "opus" / "sonnet" / "haiku" for any known model.
    Promise.all([
      API.json("/api/settings").catch(() => ({ settings: [] })),
      API.json("/api/chat/models").catch(() => ({ models: [] })),
    ]).then(([settingsData, modelsData]) => {
      const activeId = (settingsData.settings || []).find((s) => s.key === "ai.claude-code.model")?.value;
      const models = modelsData.models || [];
      const meta = models.find((m) => m.id === activeId);
      this.elements.sessionModel.textContent = meta?.tier || (activeId ? activeId.split("-")[1] : "opus");
    });

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
        // Match the CSS class names — was "warning" which doesn't match ".warn".
        this.elements.contextBarFill.className = `context-bar-fill${pct > 80 ? " danger" : pct > 50 ? " warn" : ""}`;
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

    // Group by category, preserving insertion order so the categories
    // line up with how getCommandList orders them.
    const groups = new Map();
    commands.forEach((cmd) => {
      const cat = cmd.category || "Other";
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat).push(cmd);
    });

    // Flatten back to a positional index for keyboard nav.
    const flat = [];
    let html = "";
    groups.forEach((items, cat) => {
      html += `<div class="cmd-palette-section-title">${escapeHtml(cat)}</div>`;
      items.forEach((cmd) => {
        const idx = flat.length;
        flat.push(cmd);
        // Right-aligned hint = the usage shape minus the leading "/name"
        const usage = cmd.usage || `/${cmd.name}`;
        const hintMatch = usage.match(/^\/\S+\s+(.+)$/);
        const hint = hintMatch ? hintMatch[1] : "";
        html += `<div class="cmd-palette-item${idx === 0 ? " active" : ""}" data-index="${idx}" role="option">
          <div class="cmd-palette-row-main">
            <span class="cmd-palette-name">/${escapeHtml(cmd.name)}</span>
            <span class="cmd-palette-desc">${escapeHtml(cmd.description || "")}</span>
          </div>
          ${hint ? `<span class="cmd-palette-hint">${escapeHtml(hint)}</span>` : ""}
        </div>`;
      });
    });
    this.paletteCommands = flat;

    this.elements.commandPaletteList.innerHTML = html;

    // Replace any previous filter input — the input lives at the top of the
    // palette and forwards keystrokes to the textarea so the existing
    // filter pipeline still drives results. We do NOT add it inside the
    // composer flow; keyboard nav from the textarea continues to work.
    this.elements.commandPaletteList.querySelectorAll(".cmd-palette-item").forEach((el) => {
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
    const items = this.elements.commandPaletteList.querySelectorAll(".cmd-palette-item");
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
    // Scroll fade hint — purely decorative, ignored by AT.
    const fade = document.createElement("div");
    fade.className = "channel-list-scroll-fade";
    fade.setAttribute("aria-hidden", "true");

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

    el.appendChild(fade);
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

    // Load messages (last 50 for speed, load more on demand)
    if (conversationId) {
      try {
        const data = await API.getConversation(conversationId);
        const total = data.totalMessages || data.messages?.length || 0;
        const older = total - (data.messages?.length || 0);
        this.renderMessages(data.messages || [], older > 0 ? older : 0, conversationId);
        // Session recap — if the server flagged this convo as stale, show
        // a dismissible card above the first message summarizing what was
        // going on. Null means "recently active, no recap needed".
        if (data.recap?.text) {
          this.renderSessionRecap(data.recap);
        }
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
  renderMessages(messages, olderCount = 0, conversationId = null) {
    this.elements.chatArea.innerHTML = "";
    this.lastMessageRole = null;
    this.lastMessageTime = 0;

    // Show "load more" button if there are older messages on the server
    if (olderCount > 0 && conversationId) {
      const loadMoreBtn = document.createElement("div");
      loadMoreBtn.className = "load-more-btn";
      loadMoreBtn.textContent = `Load ${olderCount} older messages`;
      loadMoreBtn.addEventListener("click", async () => {
        loadMoreBtn.textContent = "Loading...";
        try {
          const data = await API.json(`/api/chat/conversations/${conversationId}?all=true`);
          const allMsgs = data.messages || [];
          const scrollPos = this.elements.chatArea.scrollHeight;
          loadMoreBtn.remove();
          // Prepend older messages
          const olderMsgs = allMsgs.slice(0, allMsgs.length - messages.length);
          const frag = document.createDocumentFragment();
          const tempLastRole = this.lastMessageRole;
          const tempLastTime = this.lastMessageTime;
          this.lastMessageRole = null;
          this.lastMessageTime = 0;
          for (const msg of olderMsgs) {
            frag.appendChild(this._createMessageEl(msg.role, msg.content));
          }
          this.elements.chatArea.insertBefore(frag, this.elements.chatArea.firstChild);
          this.lastMessageRole = tempLastRole;
          this.lastMessageTime = tempLastTime;
          this.elements.chatArea.scrollTop = this.elements.chatArea.scrollHeight - scrollPos;
        } catch {
          loadMoreBtn.textContent = "Failed to load — click to retry";
        }
      });
      this.elements.chatArea.appendChild(loadMoreBtn);
    }

    for (const msg of messages) {
      this.appendMessage(msg.role, msg.content);
    }
    this.scrollToBottom();
  },

  _createMessageEl(role, content, isStreaming = false) {
    const msg = document.createElement("div");
    const now = Date.now();
    const isGrouped = (role === this.lastMessageRole) && (now - this.lastMessageTime < 5 * 60 * 1000);
    msg.className = `message ${role}${isGrouped ? " grouped" : ""}`;

    const avatar = role === "assistant"
      ? `<img src="/icon-32.png" alt="" class="avatar-img">`
      : "U";

    const copyIcon = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" stroke="currentColor" stroke-width="1.3"/></svg>';
    const copyBtn = role === "assistant" && !isStreaming
      ? `<button class="msg-copy-btn" title="Copy">${copyIcon}</button>`
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
    return msg;
  },

  /**
   * Render the session-recap card above the first message when a stale
   * conversation is resumed. Dismissible — hides for the rest of this
   * device's viewing session.
   */
  renderSessionRecap(recap) {
    if (!recap?.text) return;
    const chatArea = this.elements.chatArea;
    if (!chatArea) return;

    // Don't double-render if one is already there.
    chatArea.querySelector(".session-recap")?.remove();

    const card = document.createElement("div");
    card.className = "session-recap";
    card.setAttribute("role", "status");
    card.innerHTML = `
      <div class="session-recap-content">
        <div class="session-recap-label">Last time</div>
        <div class="session-recap-text"></div>
      </div>
      <button type="button" class="session-recap-dismiss" aria-label="Dismiss recap">×</button>
    `;
    card.querySelector(".session-recap-text").textContent = recap.text;
    card.querySelector(".session-recap-dismiss").addEventListener("click", () => card.remove());

    // Insert at top of chat area so it sits above the first real message.
    chatArea.insertBefore(card, chatArea.firstChild);
  },

  appendMessage(role, content, isStreaming = false) {
    const msg = this._createMessageEl(role, content, isStreaming);
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
      btn.title = "Copy";
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" stroke="currentColor" stroke-width="1.3"/></svg>';
      btn.onclick = () => navigator.clipboard.writeText(textEl.textContent);
      msgEl.appendChild(btn);
    }
  },

  // --- File Attachments ---
  addPendingFiles(files) {
    for (const file of files) {
      // Limit individual file to 20 MB (Claude supports up to 32MB for PDFs, 20MB for images)
      if (file.size > 20 * 1024 * 1024) {
        App.showToast(`File "${file.name}" exceeds 20 MB limit`, "error");
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
      const url = URL.createObjectURL(file);
      const thumb = isImage
        ? `<img src="${url}" alt="" class="att-preview-img" data-url="${url}">`
        : `<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z" stroke="currentColor" stroke-width="1.2"/><path d="M9 1v4h4" stroke="currentColor" stroke-width="1.2"/></svg>`;
      const sizeKB = (file.size / 1024).toFixed(0);
      return `<div class="chat-attachment-thumb" title="${escapeHtml(file.name)} (${sizeKB}KB)">
        ${thumb}
        <span class="att-name">${escapeHtml(file.name)}</span>
        <button class="chat-attachment-remove" data-index="${i}" title="Remove">&times;</button>
      </div>`;
    }).join("");

    // Click previews to open lightbox/viewer
    container.querySelectorAll(".chat-attachment-thumb").forEach((thumb, i) => {
      thumb.style.cursor = "pointer";
      thumb.addEventListener("click", (e) => {
        if (e.target.closest(".chat-attachment-remove")) return; // Don't trigger on X button
        this.previewFile(this.pendingFiles[i]);
      });
    });

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
        const src = `data:${escapeHtml(img.mediaType)};base64,${img.data}`;
        html += `<img src="${src}" alt="${escapeHtml(img.name)}" class="clickable-image" onclick="Chat.openLightbox('${src.replace(/'/g, "\\'")}')" style="cursor:pointer">`;
      }
      html += "</div>";
    }
    for (const f of others) {
      const name = f.name || "file";
      const lname = name.toLowerCase();
      const isPdf = lname.endsWith(".pdf") || f.mediaType === "application/pdf";
      const isSheet = lname.endsWith(".csv") || lname.endsWith(".tsv") || lname.endsWith(".xlsx") || lname.endsWith(".xls");
      const isText = [".txt",".md",".json",".js",".py",".ts",".html",".css",".yml",".yaml",".xml",".sh",".sql",".go",".rs",".java",".c",".cpp",".rb",".php"].some(e => lname.endsWith(e));
      const previewable = isPdf || isSheet || isText;
      const dataIdx = this._storeAttachmentData(f);
      if (previewable) {
        html += `<div class="message-file-chip message-file-previewable" onclick="Chat.previewStoredFile(${dataIdx})" title="Click to preview"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z" stroke="currentColor" stroke-width="1.2"/><path d="M9 1v4h4" stroke="currentColor" stroke-width="1.2"/></svg> ${escapeHtml(name)} <span style="color:var(--text-muted);font-size:10px">▸ preview</span></div>`;
      } else {
        const dataUrl = `data:${f.mediaType || "application/octet-stream"};base64,${f.data}`;
        html += `<a class="message-file-chip" href="${dataUrl}" download="${escapeHtml(name)}" title="Click to download"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z" stroke="currentColor" stroke-width="1.2"/><path d="M9 1v4h4" stroke="currentColor" stroke-width="1.2"/></svg> ${escapeHtml(name)}</a>`;
      }
    }
    return html;
  },

  // --- Send ---
  async send() {
    const text = this.elements.messageInput.value.trim();
    const hasFiles = this.pendingFiles.length > 0;
    if (!text && !hasFiles) return;

    // Subtle tactile ack on touch devices (Android; iOS ignores).
    App.buzz?.(12);

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

    // Handle /clear and /reset — both start a fresh conversation now
    if (text === "/clear" || text === "/reset") {
      this.currentConversationId = null;
      this.lastMessageRole = null;
      this.lastMessageTime = 0;
      this.elements.chatArea.innerHTML = "";
      this.elements.sendBtn.disabled = false;
      this.elements.messageInput.focus();
      // Show welcome screen instead of empty chat
      this.elements.chatArea.style.display = "none";
      this.elements.welcomeScreen.style.display = "flex";
      this.loadChannels(); // Refresh sidebar
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
    let currentTextChunk = ""; // Text accumulated since last tool
    const timeline = []; // Array of {type: "text"|"tool", html: "..."} in order
    let lastToolIndex = -1; // Index of last tool block in timeline (for adding output)
    // Buffer early content — show thinking for at least 1s
    const thinkingStartTime = Date.now();
    let pendingContent = null; // Buffered first updateStreamingMessage call

    const renderTimeline = () => {
      const items = timeline.map((item, i) => {
        if (item.type === "text") {
          return `<div class="tl-item tl-text"><div class="tl-dot"></div><div class="tl-content">${item.html}</div></div>`;
        }
        return `<div class="tl-item tl-tool"><div class="tl-dot ${item.status || "running"}"></div><div class="tl-content">${item.html}</div></div>`;
      }).join("");
      return `<div class="tl-timeline">${items}</div>`;
    };

    this.isStreaming = true;
    this._streamingConvId = this.currentConversationId;
    this.elements.sendBtn.disabled = false;
    this.elements.sendBtn.classList.add("stop-mode", "is-streaming");
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
            // Finalize current text chunk (it's already in the timeline from renderUpdate)
            // Just reset the chunk so next text starts a new timeline item
            currentTextChunk = "";

            if (!hasReceivedText) {
              hasReceivedText = true;
              const elapsed = Date.now() - thinkingStartTime;
              if (elapsed < 1000) {
                pendingContent = () => { this.updateStreamingMessage(assistantMsg, renderTimeline(), true); this.scrollToBottom(); };
                setTimeout(() => { if (pendingContent) { pendingContent(); pendingContent = null; } }, 1000 - elapsed);
                // Still add to timeline, just delay rendering
              }
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
            else if (event.name === "TodoWrite" || event.name === "todowrite" || event.name === "todo_write") { label = "Update Todos"; detail = ""; }
            else { detail = inp.command || inp.filename || inp.url || inp.query || inp.message || inp.task || inp.schedule || inp.key || JSON.stringify(inp).slice(0, 80); }

            // Special rendering for TodoWrite — show checklist
            const isTodoEvent = event.name === "TodoWrite" || event.name === "todowrite" || event.name === "todo_write";
            let toolHtml;
            if (isTodoEvent && Array.isArray(inp.todos)) {
              toolHtml = `<div class="tl-tool-header"><span class="tl-tool-name"><i class="ph ph-list-checks"></i> Update Todos</span></div><div class="tl-todos">${inp.todos.map(t => {
                const icon = t.status === "completed" ? '<i class="ph ph-check-circle tl-todo-done"></i>'
                  : t.status === "in_progress" ? '<i class="ph ph-circle-notch tl-todo-active"></i>'
                  : '<i class="ph ph-circle tl-todo-pending"></i>';
                const cls = t.status === "completed" ? "tl-todo-item done" : t.status === "in_progress" ? "tl-todo-item active" : "tl-todo-item";
                return `<div class="${cls}">${icon} <span>${escapeHtml(t.status === "in_progress" ? (t.activeForm || t.content) : t.content)}</span></div>`;
              }).join("")}</div>`;
            } else {
              toolHtml = `<div class="tl-tool-header"><span class="tl-tool-name">${escapeHtml(label)}</span> <span class="tl-tool-detail">${escapeHtml(String(detail).slice(0, 100))}</span></div><div class="tl-tool-in"><span class="tl-io-label">IN</span><pre class="tl-tool-code">${escapeHtml(String(detail).slice(0, 500) || "(no args)")}</pre></div>`;
            }
            lastToolIndex = timeline.length;
            timeline.push({ type: "tool", status: "running", html: toolHtml });
            if (!pendingContent) { this.updateStreamingMessage(assistantMsg, renderTimeline(), true); this.scrollToBottom(); }
            return;
          }
          if (event?.type === "tool_result") {
            if (lastToolIndex >= 0 && timeline[lastToolIndex]) {
              timeline[lastToolIndex].status = "done";
              const resultText = event.result || "";
              if (resultText && resultText !== "(no output)") {
                timeline[lastToolIndex].html += `<div class="tl-tool-out"><span class="tl-io-label">OUT</span><pre class="tl-tool-code">${escapeHtml(resultText.slice(0, 2000))}</pre></div>`;
              }
            }
            // Reset text chunk so next text starts a new timeline item
            currentTextChunk = "";
            this.updateStreamingMessage(assistantMsg, renderTimeline(), true);
            this.scrollToBottom();
            return;
          }
          // Normal text — accumulate into current chunk
          fullResponse += content;
          currentTextChunk += content;
          const renderUpdate = () => {
            // Update the last text item in timeline or add new one
            const lastItem = timeline[timeline.length - 1];
            let displayChunk = currentTextChunk.split("|||PERSONALITY_COMPLETE|||")[0];
            displayChunk = displayChunk.replace(/\[REMEMBER:\s*.+?\]/gi, "").replace(/\n{3,}/g, "\n\n").trim();
            if (lastItem?.type === "text") {
              lastItem.html = this.renderMarkdown(displayChunk);
            } else if (displayChunk) {
              timeline.push({ type: "text", html: this.renderMarkdown(displayChunk) });
            }
            this.updateStreamingMessage(assistantMsg, renderTimeline(), true);
            this.scrollToBottom();
          };
          if (!hasReceivedText) {
            hasReceivedText = true;
            const elapsed = Date.now() - thinkingStartTime;
            if (elapsed < 1000) {
              setTimeout(renderUpdate, 1000 - elapsed);
            } else {
              renderUpdate();
            }
          } else {
            renderUpdate();
          }
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
    this._streamingConvId = null;
    this.elements.sendBtn.disabled = false;
    this.elements.sendBtn.classList.remove("stop-mode", "is-streaming");
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
    const msgText = assistantMsg.querySelector(".message-text");
    if (msgText) msgText.innerHTML = '<span class="streaming-dots"><span></span><span></span><span></span></span>';

    const timeline = [];
    let currentTextChunk = "";
    let lastToolIndex = -1;
    let pendingContent = null;

    const renderTimeline = () => {
      return '<div class="tl-timeline">' + timeline.map((item) => {
        if (item.type === "text") return `<div class="tl-item tl-text"><div class="tl-dot"></div><div class="tl-content">${this.renderMarkdown(item.text)}</div></div>`;
        return `<div class="tl-item tl-tool"><div class="tl-dot ${item.status || "running"}"></div><div class="tl-content">${item.html}</div></div>`;
      }).join("") + '</div>';
    };

    this.isStreaming = true;
    this._streamingConvId = this.currentConversationId;
    this.elements.sendBtn.disabled = false;
    this.elements.sendBtn.classList.add("stop-mode", "is-streaming");
    this.elements.sendBtn.title = "Stop generation (Esc)";

    try {
      await API.sendMessage(
        this.currentConversationId,
        text,
        (content, event) => {
          if (event?.type === "thinking") return;
          if (event?.type === "tool_call") {
            // Flush text to timeline
            if (currentTextChunk.trim()) {
              const last = timeline[timeline.length - 1];
              if (last?.type === "text") last.text = currentTextChunk;
              else timeline.push({ type: "text", text: currentTextChunk });
            }
            currentTextChunk = "";

            const inp = event.input || {};
            let detail = "";
            let label = event.name;
            const isTodoEvent = event.name === "TodoWrite" || event.name === "todowrite" || event.name === "todo_write";
            if (event.name === "Bash") { detail = inp.command || ""; }
            else if (event.name === "Read") { detail = inp.file_path || inp.filename || ""; label = "Read"; }
            else if (event.name === "Write") { detail = inp.file_path || inp.filename || ""; label = "Write"; }
            else if (event.name === "Edit") { detail = inp.file_path || ""; label = "Edit"; }
            else if (event.name === "Grep") { detail = `"${inp.pattern || ""}" ${inp.path || ""}`; label = "Search"; }
            else if (event.name === "Glob") { detail = inp.pattern || ""; label = "Find"; }
            else if (isTodoEvent) { label = "Update Todos"; detail = ""; }
            else { detail = inp.command || inp.filename || inp.url || inp.query || inp.message || inp.task || inp.schedule || inp.key || JSON.stringify(inp).slice(0, 80); }

            let toolHtml;
            if (isTodoEvent && Array.isArray(inp.todos)) {
              toolHtml = `<div class="tl-tool-header"><span class="tl-tool-name"><i class="ph ph-list-checks"></i> Update Todos</span></div><div class="tl-todos">${inp.todos.map(t => {
                const icon = t.status === "completed" ? '<i class="ph ph-check-circle tl-todo-done"></i>' : t.status === "in_progress" ? '<i class="ph ph-circle-notch tl-todo-active"></i>' : '<i class="ph ph-circle tl-todo-pending"></i>';
                const cls = t.status === "completed" ? "tl-todo-item done" : t.status === "in_progress" ? "tl-todo-item active" : "tl-todo-item";
                return `<div class="${cls}">${icon} <span>${escapeHtml(t.status === "in_progress" ? (t.activeForm || t.content) : t.content)}</span></div>`;
              }).join("")}</div>`;
            } else {
              toolHtml = `<div class="tl-tool-header"><span class="tl-tool-name">${escapeHtml(label)}</span> <span class="tl-tool-detail">${escapeHtml(String(detail).slice(0, 100))}</span></div><div class="tl-tool-in"><span class="tl-io-label">IN</span><pre class="tl-tool-code">${escapeHtml(String(detail).slice(0, 500) || "(no args)")}</pre></div>`;
            }
            lastToolIndex = timeline.length;
            timeline.push({ type: "tool", status: "running", html: toolHtml });
            this.updateStreamingMessage(assistantMsg, renderTimeline(), true);
            this.scrollToBottom();
            return;
          }
          if (event?.type === "tool_result") {
            if (lastToolIndex >= 0 && timeline[lastToolIndex]) {
              timeline[lastToolIndex].status = "done";
              const resultText = event.result || "";
              if (resultText && resultText !== "(no output)") {
                timeline[lastToolIndex].html += `<div class="tl-tool-out"><span class="tl-io-label">OUT</span><pre class="tl-tool-code">${escapeHtml(resultText.slice(0, 2000))}</pre></div>`;
              }
            }
            currentTextChunk = "";
            this.updateStreamingMessage(assistantMsg, renderTimeline(), true);
            this.scrollToBottom();
            return;
          }
          if (content) {
            currentTextChunk += content;
            const last = timeline[timeline.length - 1];
            if (last?.type === "text") last.text = currentTextChunk;
            else if (!last || last.type === "tool") timeline.push({ type: "text", text: currentTextChunk });

            pendingContent = () => { this.updateStreamingMessage(assistantMsg, renderTimeline(), true); this.scrollToBottom(); };
            if (!this._queuedRaf) {
              this._queuedRaf = requestAnimationFrame(() => { this._queuedRaf = null; if (pendingContent) { pendingContent(); pendingContent = null; } });
            }
          }
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
          const textEl = assistantMsg.querySelector(".message-text");
          if (textEl && !currentTextChunk) {
            textEl.innerHTML = `<span class="text-danger">${escapeHtml(error)}</span>`;
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
    this._streamingConvId = null;
    this.elements.sendBtn.disabled = false;
    this.elements.sendBtn.classList.remove("stop-mode", "is-streaming");
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

  _effortLevel: "",
  _effortLevels: [
    { value: "", icon: "⚡", label: "Auto" },
    { value: "low", icon: "🐇", label: "Quick" },
    { value: "medium", icon: "⚖️", label: "Balanced" },
    { value: "high", icon: "🧠", label: "Deep" },
    { value: "max", icon: "🔮", label: "Maximum" },
    { value: "xhigh", icon: "🌌", label: "Ultra" },
  ],

  getEffort() {
    return this._effortLevel || undefined;
  },

  setEffort(value) {
    const lvl = this._effortLevels.find((l) => l.value === value);
    if (!lvl) return;
    this._effortLevel = lvl.value;
    const btn = document.getElementById("effortToggle");
    if (btn) {
      btn.dataset.level = lvl.value;
      const iconEl = document.getElementById("effortIcon");
      const labelEl = document.getElementById("effortLabel");
      if (iconEl) iconEl.textContent = lvl.icon;
      if (labelEl) labelEl.textContent = lvl.label;
    }
  },

  initEffortPills() {
    const btn = document.getElementById("effortToggle");
    if (!btn) return;

    // Short tap: cycle through levels (fallback for narrow screens where
    // the slider would be cramped). Long-press or focus: open slider.
    let pressTimer = null;
    let longPressFired = false;
    const LONG_PRESS_MS = 500;

    const openSlider = () => {
      longPressFired = true;
      window.EffortSlider?.open();
    };

    btn.addEventListener("pointerdown", () => {
      longPressFired = false;
      pressTimer = setTimeout(openSlider, LONG_PRESS_MS);
    });
    btn.addEventListener("pointerup", () => { clearTimeout(pressTimer); });
    btn.addEventListener("pointerleave", () => { clearTimeout(pressTimer); });
    btn.addEventListener("pointercancel", () => { clearTimeout(pressTimer); });

    btn.addEventListener("click", (e) => {
      // If long-press already fired, don't also cycle.
      if (longPressFired) { e.preventDefault(); return; }
      const levels = this._effortLevels;
      const idx = levels.findIndex((l) => l.value === this._effortLevel);
      const next = levels[(idx + 1) % levels.length];
      this.setEffort(next.value);
    });

    // Keyboard users: space/enter opens the slider too.
    btn.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "Enter") {
        e.preventDefault();
        openSlider();
      }
    });
  },

  _typingWs: null,
  _typingDebounce: null,
  _typingIndicatorTimeout: null,

  _initDiagramListener() {
    window.addEventListener("message", (event) => {
      // Defense-in-depth: same-origin check (canvas iframes run allow-same-origin).
      if (event.origin !== location.origin) return;
      const data = event.data;
      if (!data || data.type !== "tarsee:diagram-click") return;
      // Verify the source is one of our canvas iframes
      const iframes = document.querySelectorAll('iframe.canvas-iframe');
      let trusted = false;
      for (const f of iframes) {
        if (f.contentWindow === event.source) { trusted = true; break; }
      }
      if (!trusted) return;

      const label = String(data.label || "").slice(0, 200);
      const sublabel = String(data.sublabel || "").slice(0, 200);
      const custom = typeof data.question === "string" ? data.question.slice(0, 500) : "";
      if (!label && !custom) return;

      const question = custom
        || (sublabel ? `Tell me more about: ${label} — ${sublabel}` : `Tell me more about: ${label}`);

      // Reuse the normal send path — send() handles queueing during streaming.
      this.elements.messageInput.value = question;
      this.elements.sendBtn.disabled = false;
      this.send();
    });
  },

  _initTypingSocket() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws`;
    this._typingReconnect = this._typingReconnect || { attempts: 0, timer: null };
    // Track the highest eventId we've received per conversation so we can
    // ask the server to replay anything we missed while the WS was dead.
    this._lastEventIdByConv = this._lastEventIdByConv || {};
    const clearHeartbeat = () => {
      if (this._typingHb) { clearInterval(this._typingHb); this._typingHb = null; }
      if (this._typingPongTimer) { clearTimeout(this._typingPongTimer); this._typingPongTimer = null; }
    };
    try {
      clearHeartbeat();
      this._typingWs = new WebSocket(url);
      this._typingWs.onopen = () => {
        // Successful connection resets backoff
        this._typingReconnect.attempts = 0;
        const token = API.token || localStorage.getItem("tarsee_api_token");
        if (token) this._typingWs.send(JSON.stringify({ type: "auth", token }));
        // Ask the server to replay any events we missed for the conversation
        // we're currently viewing (if any).
        if (this.currentConversationId) {
          const lastId = this._lastEventIdByConv[this.currentConversationId] || 0;
          try {
            this._typingWs.send(JSON.stringify({
              type: "sync.resume",
              convId: this.currentConversationId,
              lastEventId: lastId,
            }));
          } catch { /* ignore */ }
        }
        // Heartbeat: ping every 25s. If no pong in 10s, treat the socket as
        // dead — iOS silently stalls WS connections when backgrounded and
        // never fires `close`, so we need our own liveness check.
        this._typingHb = setInterval(() => {
          if (this._typingWs?.readyState !== 1) return;
          try { this._typingWs.send(JSON.stringify({ type: "ping" })); } catch {}
          clearTimeout(this._typingPongTimer);
          this._typingPongTimer = setTimeout(() => {
            try { this._typingWs?.close(); } catch {}
          }, 10_000);
        }, 25_000);
      };
      this._typingWs.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data);
          if (data.type === "pong") {
            clearTimeout(this._typingPongTimer);
          } else if (data.type === "typing") {
            this._showTypingIndicator(data.channel);
          } else if (data.type === "sync") {
            if (data.eventId && data.convId) {
              const prev = this._lastEventIdByConv[data.convId] || 0;
              if (data.eventId > prev) this._lastEventIdByConv[data.convId] = data.eventId;
            }
            this._handleSyncEvent(data);
          }
        } catch { /* ignore */ }
      };
      this._typingWs.onerror = () => {};
      this._typingWs.onclose = () => {
        clearHeartbeat();
        // Exponential backoff with cap + jitter — avoid thundering herd
        // if the server is down.
        const attempt = ++this._typingReconnect.attempts;
        const base = Math.min(30_000, 1000 * Math.pow(2, Math.min(attempt, 5)));
        const jitter = Math.floor(Math.random() * 1000);
        clearTimeout(this._typingReconnect.timer);
        this._typingReconnect.timer = setTimeout(() => this._initTypingSocket(), base + jitter);
      };
    } catch {
      // Schedule a retry even if construction threw
      const attempt = ++this._typingReconnect.attempts;
      const base = Math.min(30_000, 1000 * Math.pow(2, Math.min(attempt, 5)));
      clearTimeout(this._typingReconnect.timer);
      this._typingReconnect.timer = setTimeout(() => this._initTypingSocket(), base);
    }

    // Force a reconnect on resume events. iOS + Android Chrome can leave the
    // WS in a zombie state when the tab is backgrounded; the events fire
    // when the user returns, and we slam the dead socket so onclose +
    // backoff picks up a fresh one.
    if (!this._typingWsResumeBound) {
      this._typingWsResumeBound = true;
      const forceReconnect = () => {
        if (this._typingWs && this._typingWs.readyState !== 1) {
          try { this._typingWs.close(); } catch {}
        } else if (!this._typingWs) {
          this._initTypingSocket();
        }
      };
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") forceReconnect();
      });
      window.addEventListener("pageshow", forceReconnect);
      window.addEventListener("online", forceReconnect);
    }
  },

  _sendTypingIndicator() {
    clearTimeout(this._typingDebounce);
    this._typingDebounce = setTimeout(() => {
      if (this._typingWs?.readyState === 1) {
        this._typingWs.send(JSON.stringify({ type: "typing", channel: "web" }));
      }
    }, 500);
  },

  _showTypingIndicator(channel) {
    // Show a brief typing indicator in the chat area
    let el = document.getElementById("typingIndicator");
    if (!el) {
      el = document.createElement("div");
      el.id = "typingIndicator";
      el.className = "typing-indicator";
      el.innerHTML = '<span class="typing-dot"></span><span class="typing-dot"></span><span class="typing-dot"></span> <span class="typing-label">typing on another device...</span>';
      this.elements.chatArea?.appendChild(el);
    }
    el.style.display = "flex";
    clearTimeout(this._typingIndicatorTimeout);
    this._typingIndicatorTimeout = setTimeout(() => { el.style.display = "none"; }, 3000);
  },

  _syncStreamingEl: null,
  _syncTimeline: [],
  _syncFullText: "",

  _handleSyncEvent(data) {
    // Only process events for the conversation we're currently viewing
    if (data.convId !== this.currentConversationId) return;
    // Dedup only against the conversation THIS device is actively driving.
    // If we're streaming conv A but viewing conv B, we still want B's sync
    // events — don't drop them just because isStreaming is true.
    if (this.isStreaming && this._streamingConvId === data.convId) return;

    const evt = data.event;
    const d = data.data;

    if (evt === "user_message") {
      // Another device sent a message — show it
      this.appendMessage("user", d.content);
      return;
    }

    if (evt === "thinking") {
      if (d.status === "start") {
        // Create assistant message with thinking indicator
        if (!this._syncStreamingEl) {
          this._syncStreamingEl = this.appendMessage("assistant", "");
          this._syncTimeline = [];
          this._syncFullText = "";
        }
        const textEl = this._syncStreamingEl?.querySelector(".message-text");
        if (textEl && !textEl.querySelector(".streaming-dots")) {
          textEl.innerHTML = '<span class="streaming-dots"><span></span><span></span><span></span></span>';
        }
      }
      return;
    }

    if (evt === "text") {
      if (!this._syncStreamingEl) {
        this._syncStreamingEl = this.appendMessage("assistant", "");
        this._syncTimeline = [];
        this._syncFullText = "";
      }
      this._syncFullText += d.content;
      const textEl = this._syncStreamingEl?.querySelector(".message-text");
      if (textEl) textEl.innerHTML = this.renderMarkdown(this._syncFullText);
      this.scrollToBottom();
      return;
    }

    if (evt === "tool_call") {
      if (!this._syncStreamingEl) {
        this._syncStreamingEl = this.appendMessage("assistant", "");
        this._syncTimeline = [];
        this._syncFullText = "";
      }
      const inp = d.input || {};
      const detail = inp.command || inp.file_path || inp.url || inp.query || "";
      this._syncTimeline.push({ type: "tool", name: d.name, detail: String(detail).slice(0, 200), status: "running" });
      this._renderSyncTimeline();
      return;
    }

    if (evt === "tool_result") {
      const last = this._syncTimeline[this._syncTimeline.length - 1];
      if (last) last.status = "done";
      this._renderSyncTimeline();
      return;
    }

    if (evt === "done") {
      this._syncStreamingEl = null;
      this._syncTimeline = [];
      this._syncFullText = "";
      // Reload messages to get the final saved version
      if (this.currentConversationId) {
        this.openChannel(this.currentChannelKey, this.currentConversationId);
      }
      return;
    }
  },

  _renderSyncTimeline() {
    const textEl = this._syncStreamingEl?.querySelector(".message-text");
    if (!textEl) return;
    let html = "";
    if (this._syncFullText) html += this.renderMarkdown(this._syncFullText);
    html += '<div class="tl-timeline">';
    for (const item of this._syncTimeline) {
      if (item.type === "tool") {
        const statusClass = item.status === "running" ? "running" : "";
        html += `<div class="tl-item"><span class="tl-dot ${statusClass}"></span><div class="tl-tool"><div class="tl-tool-header"><span class="tl-tool-name">${escapeHtml(item.name)}</span><span class="tl-tool-detail">${escapeHtml(item.detail || "")}</span></div></div></div>`;
      }
    }
    html += "</div>";
    textEl.innerHTML = html;
    this.scrollToBottom();
  },

  initSearch() {
    const input = document.getElementById("searchInput");
    const results = document.getElementById("searchResults");
    if (!input || !results) return;

    let debounce = null;
    input.addEventListener("input", () => {
      clearTimeout(debounce);
      const q = input.value.trim();
      if (!q) { results.style.display = "none"; return; }
      debounce = setTimeout(async () => {
        try {
          const data = await API.searchMessages(q);
          if (!data.results?.length) {
            results.innerHTML = '<div class="search-empty">No results</div>';
          } else {
            results.innerHTML = data.results.map(r => `
              <div class="search-result-item" data-conv="${r.conversation_id}">
                <div class="search-result-title">${escapeHtml(r.conversation_title)} &middot; ${r.role}</div>
                <div class="search-result-snippet">${r.snippet}</div>
              </div>
            `).join("");
          }
          results.style.display = "block";
        } catch { results.style.display = "none"; }
      }, 300);
    });

    results.addEventListener("click", (e) => {
      const item = e.target.closest(".search-result-item");
      if (!item) return;
      const convId = item.dataset.conv;
      // Find the channel for this conversation and open it
      const ch = this.channels?.find(c => c.conversationId === convId);
      if (ch) this.openChannel(ch.key, convId);
      results.style.display = "none";
      input.value = "";
    });

    // Close on click outside
    document.addEventListener("click", (e) => {
      if (!e.target.closest(".sidebar-search")) results.style.display = "none";
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

  // --- Attachment data store (for previewing sent attachments) ---
  _attachmentStore: [],
  _storeAttachmentData(att) {
    const idx = this._attachmentStore.length;
    this._attachmentStore.push(att);
    return idx;
  },
  previewStoredFile(idx) {
    const att = this._attachmentStore[idx];
    if (!att) return;
    // Create a fake File-like object for previewFile
    const blob = new Blob([Uint8Array.from(atob(att.data), c => c.charCodeAt(0))], { type: att.mediaType });
    blob.name = att.name;
    this.previewFile(blob);
  },

  // --- Preview / Lightbox ---
  _setViewportScalable(enabled) {
    // The app shell uses maximum-scale=1, user-scalable=no to block pinch-
    // zoom. Lightbox is the one surface where pinch should work, so we
    // rewrite the viewport meta for its lifetime.
    const meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return;
    meta.setAttribute(
      "content",
      enabled
        ? "width=device-width, initial-scale=1, maximum-scale=5, user-scalable=yes, viewport-fit=cover"
        : "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover"
    );
  },

  openLightbox(src, type) {
    const existing = document.querySelector(".lightbox-overlay");
    if (existing) existing.remove();
    const overlay = document.createElement("div");
    overlay.className = "lightbox-overlay";

    if (type === "pdf") {
      overlay.innerHTML = `<iframe src="${src}" class="lightbox-frame"></iframe><button class="lightbox-close">&times;</button>`;
    } else if (type === "sheet") {
      overlay.innerHTML = `<div class="lightbox-sheet">${src}</div><button class="lightbox-close">&times;</button>`;
    } else {
      overlay.innerHTML = `<img src="${src}" class="lightbox-img"><button class="lightbox-close">&times;</button>`;
    }

    this._setViewportScalable(true);
    const escHandler = (e) => { if (e.key === "Escape") closeLightbox(); };
    const closeLightbox = () => {
      document.removeEventListener("keydown", escHandler);
      this._setViewportScalable(false);
      overlay.remove();
    };
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay || e.target.classList.contains("lightbox-close")) closeLightbox();
    });
    document.addEventListener("keydown", escHandler);
    document.body.appendChild(overlay);
  },

  /** Parse CSV/TSV text into an HTML table */
  csvToTable(text, separator) {
    const sep = separator || (text.includes("\t") ? "\t" : ",");
    const rows = text.trim().split("\n").map(r => r.split(sep));
    if (rows.length === 0) return "<p>Empty file</p>";
    let html = '<table class="md-table"><thead><tr>';
    for (const cell of rows[0]) html += `<th>${escapeHtml(cell.trim())}</th>`;
    html += "</tr></thead><tbody>";
    for (let i = 1; i < rows.length && i < 200; i++) {
      html += "<tr>";
      for (const cell of rows[i]) html += `<td>${escapeHtml(cell.trim())}</td>`;
      html += "</tr>";
    }
    html += "</tbody></table>";
    if (rows.length > 200) html += `<p style="color:var(--text-muted);font-size:12px">Showing first 200 of ${rows.length} rows</p>`;
    return html;
  },

  /** Preview a file attachment — routes to correct preview type */
  previewFile(file) {
    const name = file.name?.toLowerCase() || "";
    const type = file.type || "";

    // Image
    if (type.startsWith("image/")) {
      const url = file instanceof File ? URL.createObjectURL(file) : `data:${type};base64,${file.data}`;
      this.openLightbox(url);
      return;
    }

    // PDF
    if (type === "application/pdf" || name.endsWith(".pdf")) {
      const url = file instanceof File ? URL.createObjectURL(file) : `data:application/pdf;base64,${file.data}`;
      this.openLightbox(url, "pdf");
      return;
    }

    // CSV / TSV
    if (name.endsWith(".csv") || name.endsWith(".tsv")) {
      if (file instanceof File) {
        file.text().then((text) => this.openLightbox(this.csvToTable(text), "sheet"));
      } else {
        const text = atob(file.data);
        this.openLightbox(this.csvToTable(text), "sheet");
      }
      return;
    }

    // XLSX — parse with lightweight reader
    if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      if (file instanceof File) {
        file.arrayBuffer().then((buf) => this._parseXlsx(buf));
      } else {
        const binary = atob(file.data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        this._parseXlsx(bytes.buffer);
      }
      return;
    }

    // Text/code files — show in preformatted block
    const textExts = [".txt", ".md", ".json", ".js", ".py", ".ts", ".html", ".css", ".yml", ".yaml", ".xml", ".sh", ".env", ".log", ".sql", ".go", ".rs", ".java", ".c", ".cpp", ".h", ".rb", ".php"];
    if (textExts.some(ext => name.endsWith(ext)) || type.startsWith("text/")) {
      if (file instanceof File) {
        file.text().then((text) => {
          const html = `<pre style="white-space:pre-wrap;font-family:var(--font-mono);font-size:13px;max-height:80vh;overflow:auto;padding:16px;color:var(--text)">${escapeHtml(text.slice(0, 50000))}</pre>`;
          this.openLightbox(html, "sheet");
        });
      }
      return;
    }

    // Fallback — download
    if (file instanceof File) {
      const url = URL.createObjectURL(file);
      const a = document.createElement("a");
      a.href = url; a.download = file.name; a.click();
      URL.revokeObjectURL(url);
    }
  },

  /** Simple XLSX parser — extracts first sheet as HTML table */
  async _parseXlsx(buffer) {
    try {
      // Use JSZip-like approach: xlsx is a zip of XML files
      // Minimal inline parser — extracts shared strings + sheet1 data
      const { entries } = await this._unzip(buffer);
      const sharedStringsXml = entries["xl/sharedStrings.xml"] || "";
      const sheet1Xml = entries["xl/worksheets/sheet1.xml"] || "";

      // Parse shared strings
      const strings = [];
      const ssMatches = sharedStringsXml.matchAll(/<t[^>]*>([^<]*)<\/t>/g);
      for (const m of ssMatches) strings.push(m[1]);

      // Parse sheet rows
      const rows = [];
      const rowMatches = sheet1Xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g);
      for (const rm of rowMatches) {
        const cells = [];
        const cellMatches = rm[1].matchAll(/<c[^>]*(?:t="s"[^>]*)?>[\s\S]*?<v>(\d+)<\/v>[\s\S]*?<\/c>|<c[^>]*>[\s\S]*?<v>([^<]*)<\/v>[\s\S]*?<\/c>/g);
        for (const cm of cellMatches) {
          if (cm[1] !== undefined) cells.push(strings[parseInt(cm[1])] || "");
          else if (cm[2] !== undefined) cells.push(cm[2]);
          else cells.push("");
        }
        rows.push(cells);
      }

      if (rows.length === 0) { this.openLightbox("<p>Empty spreadsheet</p>", "sheet"); return; }

      let html = '<table class="md-table"><thead><tr>';
      for (const cell of rows[0]) html += `<th>${escapeHtml(cell)}</th>`;
      html += "</tr></thead><tbody>";
      for (let i = 1; i < rows.length && i < 200; i++) {
        html += "<tr>";
        for (const cell of rows[i]) html += `<td>${escapeHtml(cell)}</td>`;
        html += "</tr>";
      }
      html += "</tbody></table>";
      if (rows.length > 200) html += `<p style="color:var(--text-muted);font-size:12px">Showing first 200 of ${rows.length} rows</p>`;
      this.openLightbox(html, "sheet");
    } catch (err) {
      App.showToast("Could not preview spreadsheet: " + err.message, "error");
    }
  },

  /** Minimal ZIP extractor for XLSX (no dependencies) */
  async _unzip(buffer) {
    const entries = {};
    try {
      // Use DecompressionStream API (modern browsers)
      const blob = new Blob([buffer]);
      const ds = new Response(blob.stream().pipeThrough(new DecompressionStream("deflate-raw")));
      // Fallback: try native unzip via Response
      // Actually, zip files need proper parsing. Use a simpler approach:
      // Read the zip directory and extract XML entries
      const view = new DataView(buffer);
      const bytes = new Uint8Array(buffer);

      // Find end of central directory
      let eocdOffset = -1;
      for (let i = bytes.length - 22; i >= 0; i--) {
        if (view.getUint32(i, true) === 0x06054b50) { eocdOffset = i; break; }
      }
      if (eocdOffset === -1) return { entries };

      const cdOffset = view.getUint32(eocdOffset + 16, true);
      const cdCount = view.getUint16(eocdOffset + 10, true);

      let pos = cdOffset;
      for (let i = 0; i < cdCount; i++) {
        if (view.getUint32(pos, true) !== 0x02014b50) break;
        const compMethod = view.getUint16(pos + 10, true);
        const compSize = view.getUint32(pos + 20, true);
        const uncompSize = view.getUint32(pos + 24, true);
        const nameLen = view.getUint16(pos + 28, true);
        const extraLen = view.getUint16(pos + 30, true);
        const commentLen = view.getUint16(pos + 32, true);
        const localOffset = view.getUint32(pos + 42, true);
        const name = new TextDecoder().decode(bytes.slice(pos + 46, pos + 46 + nameLen));

        // Read from local file header
        const lfhPos = localOffset;
        const lfNameLen = view.getUint16(lfhPos + 26, true);
        const lfExtraLen = view.getUint16(lfhPos + 28, true);
        const dataStart = lfhPos + 30 + lfNameLen + lfExtraLen;
        const rawData = bytes.slice(dataStart, dataStart + compSize);

        if (name.endsWith(".xml") || name.endsWith(".rels")) {
          if (compMethod === 0) {
            entries[name] = new TextDecoder().decode(rawData);
          } else if (compMethod === 8) {
            try {
              const ds = new DecompressionStream("deflate-raw");
              const writer = ds.writable.getWriter();
              writer.write(rawData);
              writer.close();
              const reader = ds.readable.getReader();
              const chunks = [];
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
              }
              const totalLen = chunks.reduce((s, c) => s + c.length, 0);
              const result = new Uint8Array(totalLen);
              let off = 0;
              for (const c of chunks) { result.set(c, off); off += c.length; }
              entries[name] = new TextDecoder().decode(result);
            } catch { /* skip unreadable entry */ }
          }
        }

        pos += 46 + nameLen + extraLen + commentLen;
      }
    } catch { /* zip parsing failed */ }
    return { entries };
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
  /** Render a persisted timeline from saved JSON data */
  renderTimelineFromData(items) {
    const parts = items.map((item) => {
      if (item.type === "text") {
        const html = this.renderMarkdown(item.text || "");
        return `<div class="tl-item tl-text"><div class="tl-dot"></div><div class="tl-content">${html}</div></div>`;
      }
      if (item.type === "tool") {
        // Special rendering for saved TodoWrite
        if (item.todos && Array.isArray(item.todos)) {
          const todosHtml = item.todos.map(t => {
            const icon = t.status === "completed" ? '<i class="ph ph-check-circle tl-todo-done"></i>'
              : t.status === "in_progress" ? '<i class="ph ph-circle-notch tl-todo-active"></i>'
              : '<i class="ph ph-circle tl-todo-pending"></i>';
            const cls = t.status === "completed" ? "tl-todo-item done" : t.status === "in_progress" ? "tl-todo-item active" : "tl-todo-item";
            return `<div class="${cls}">${icon} <span>${escapeHtml(t.content)}</span></div>`;
          }).join("");
          return `<div class="tl-item tl-tool"><div class="tl-dot done"></div><div class="tl-content"><div class="tl-tool-header"><span class="tl-tool-name"><i class="ph ph-list-checks"></i> Update Todos</span></div><div class="tl-todos">${todosHtml}</div></div></div>`;
        }
        let toolHtml = `<div class="tl-tool-header"><span class="tl-tool-name">${escapeHtml(item.name || "Tool")}</span> <span class="tl-tool-detail">${escapeHtml(item.detail || "")}</span></div>`;
        if (item.input) {
          toolHtml += `<div class="tl-tool-in"><span class="tl-io-label">IN</span><pre class="tl-tool-code">${escapeHtml(item.input)}</pre></div>`;
        }
        if (item.output && item.output !== "(no output)") {
          toolHtml += `<div class="tl-tool-out"><span class="tl-io-label">OUT</span><pre class="tl-tool-code">${escapeHtml(item.output)}</pre></div>`;
        }
        return `<div class="tl-item tl-tool"><div class="tl-dot done"></div><div class="tl-content">${toolHtml}</div></div>`;
      }
      return "";
    }).join("");
    return `<div class="tl-timeline">${parts}</div>`;
  },

  renderMarkdown(text) {
    if (!text) return "";

    // Check for persisted timeline JSON from DB
    if (text.startsWith('{"__timeline":true')) {
      try {
        const data = JSON.parse(text);
        if (data.__timeline && data.items) {
          return this.renderTimelineFromData(data.items);
        }
      } catch { /* not valid JSON, render as normal markdown */ }
    }

    // Strip any [REMEMBER: ...] markers that leaked through
    text = text.replace(/\[REMEMBER:\s*.+?\]/gi, "").replace(/\n{3,}/g, "\n\n").trim();

    // ── Extract special blocks BEFORE escaping HTML ──

    // Placeholders for blocks we'll inject after escaping
    const blocks = [];
    const PH = (i) => `\x00BLOCK${i}\x00`;

    // Canvas embeds: render the diagram/canvas inline with a floating "..."
    // menu (Copy link / Download file). Same feel as Claude's inline
    // diagrams — no header chrome.
    //
    // The model sometimes wraps the canvas URL in a redundant
    // <a href="/canvas/id/" target="_blank" ...>View Diagram</a> link
    // AND also drops a bare /canvas/id/ somewhere. If we just run the
    // URL regex, we end up with (a) two iframes for the same canvas and
    // (b) a broken <a> tag leaking attributes like `target="_blank"
    // rel="noopener">View Diagram` as visible text once the href is
    // replaced by a placeholder. So we:
    //   1. Strip anchor wrappers around canvas URLs first.
    //   2. Dedupe by canvasId across the whole message — only one embed
    //      per canvas, extras collapse away.
    const seenCanvas = new Set();
    const canvasEmbedHtml = (canvasId) => {
      const safeId = escapeHtml(canvasId);
      return `<div class="canvas-embed" data-canvas-id="${safeId}">
        <iframe src="/canvas/${safeId}/" class="canvas-iframe" sandbox="allow-scripts allow-same-origin" loading="lazy"></iframe>
        <button type="button" class="canvas-embed-menu-btn" aria-label="Diagram options" aria-haspopup="menu" aria-expanded="false">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="3" cy="8" r="1.5" fill="currentColor"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/><circle cx="13" cy="8" r="1.5" fill="currentColor"/></svg>
        </button>
        <div class="canvas-embed-menu" role="menu">
          <button type="button" class="canvas-embed-menu-item" data-canvas-action="copy" role="menuitem">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M5.5 5.5h7.5v7.5h-7.5z" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M3 3h7.5v2.5M3 3v7.5h2.5" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>
            Copy to clipboard
          </button>
          <a class="canvas-embed-menu-item" href="/canvas/${safeId}/" download="${safeId}.html" role="menuitem">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 2v9m0 0l-3-3m3 3l3-3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M2.5 12v1.5a1 1 0 001 1h9a1 1 0 001-1V12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
            Download file
          </a>
        </div>
      </div>`;
    };
    const placeCanvas = (canvasId) => {
      if (seenCanvas.has(canvasId)) return ""; // dedupe extras
      seenCanvas.add(canvasId);
      const i = blocks.length;
      blocks.push(canvasEmbedHtml(canvasId));
      return PH(i);
    };

    // 1. Anchor-wrapped canvas URLs: <a href="/canvas/id/" ...>anything</a>
    text = text.replace(
      /<a\s+[^>]*href=["'](?:https?:\/\/[^\s/"']+)?\/canvas\/([a-z0-9-]+)\/?["'][^>]*>[\s\S]*?<\/a>/gi,
      (_m, canvasId) => placeCanvas(canvasId)
    );

    // 2. Bare canvas URLs (or full URLs pointing at /canvas/id/).
    text = text.replace(
      /(?:https?:\/\/[^\s/]+)?\/canvas\/([a-z0-9-]+)\/?/g,
      (_m, canvasId) => placeCanvas(canvasId)
    );

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

    // Ordered lists (1. item) — tag with a sentinel so we can tell OL from UL later
    html = html.replace(/(^|<br>)\d+\.\s(.+?)(?=<br>|$)/g, "$1<oli>$2</oli>");

    // Unordered lists (- item)
    html = html.replace(/(^|<br>)- (.+?)(?=<br>|$)/g, "$1<uli>$2</uli>");

    // Inline code
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

    // Italic
    html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, "<em>$1</em>");

    // Strikethrough
    html = html.replace(/~~(.+?)~~/g, "<del>$1</del>");

    // Markdown links [text](url)
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // Auto-link bare URLs (not already inside an href or <a> tag)
    html = html.replace(/(?<!href="|">)(https?:\/\/[^\s<"')\]]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');

    // Re-inject code blocks
    for (let i = 0; i < codeBlocks.length; i++) {
      html = html.replace(`\x01CODE${i}\x01`, codeBlocks[i]);
    }

    // Wrap consecutive list-item sentinels into real <ol>/<ul> blocks.
    // Keeping OL and UL distinct preserves numbering for ordered lists and
    // lets the themed ::before bullet apply cleanly to unordered lists.
    html = html.replace(/(?:<oli>[\s\S]*?<\/oli>(?:<br>)?)+/g, (run) => {
      const inner = run.replace(/<br>/g, "").replace(/<oli>/g, "<li>").replace(/<\/oli>/g, "</li>");
      return `<ol>${inner}</ol>`;
    });
    html = html.replace(/(?:<uli>[\s\S]*?<\/uli>(?:<br>)?)+/g, (run) => {
      const inner = run.replace(/<br>/g, "").replace(/<uli>/g, "<li>").replace(/<\/uli>/g, "</li>");
      return `<ul>${inner}</ul>`;
    });

    // ── Re-inject extracted blocks ──
    // Done AFTER list wrapping so tool-call blocks never get swallowed into a <ul>.
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
