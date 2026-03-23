/**
 * Chat UI module.
 * Handles message rendering, streaming, and conversation management.
 */
const Chat = {
  currentConversationId: null,
  isStreaming: false,
  conversations: [],
  botName: "OpusClaw",

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
      newChatBtn: document.getElementById("newChatBtn"),
      conversationList: document.getElementById("conversationList"),
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
    this.elements.newChatBtn.addEventListener("click", () => this.newChat());

    // Welcome suggestion cards
    document.querySelectorAll(".welcome-suggestion").forEach((el) => {
      el.addEventListener("click", () => {
        this.elements.messageInput.value = el.dataset.msg;
        this.elements.sendBtn.disabled = false;
        this.elements.messageInput.focus();
      });
    });

    this.loadConversations();
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

    // Update topbar title (only if showing old name or default)
    if (!this.currentConversationId) {
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
    // If usage has args placeholder like "/model [model-name]", place cursor after command name
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

  async loadConversations() {
    try {
      const data = await API.listConversations();
      this.conversations = data.conversations || [];
      this.renderConversationList();
    } catch (err) {
      console.error("Failed to load conversations:", err);
    }
  },

  renderConversationList() {
    const el = this.elements.conversationList;
    el.innerHTML = "";

    for (const conv of this.conversations) {
      const item = document.createElement("div");
      item.className = "conversation-item" + (conv.id === this.currentConversationId ? " active" : "");
      item.innerHTML = `
        <span class="title">${escapeHtml(conv.title)}</span>
        <button class="delete-btn" title="Delete">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
        </button>
      `;

      item.querySelector(".title").addEventListener("click", () => this.openConversation(conv.id));
      item.querySelector(".delete-btn").addEventListener("click", (e) => {
        e.stopPropagation();
        this.deleteConversation(conv.id);
      });

      el.appendChild(item);
    }
  },

  async openConversation(id) {
    this.currentConversationId = id;
    this.elements.welcomeScreen.style.display = "none";
    this.elements.chatArea.style.display = "flex";
    this.elements.inputArea.style.display = "block";

    try {
      const data = await API.getConversation(id);
      this.elements.topbarTitle.textContent = data.title || "Chat";
      this.renderMessages(data.messages || []);
      this.renderConversationList();
    } catch (err) {
      App.showToast("Failed to load conversation", "error");
    }

    this.elements.messageInput.focus();
  },

  renderMessages(messages) {
    this.elements.chatArea.innerHTML = "";
    for (const msg of messages) {
      this.appendMessage(msg.role, msg.content);
    }
    this.scrollToBottom();
  },

  appendMessage(role, content, isStreaming = false) {
    const msg = document.createElement("div");
    msg.className = `message ${role}`;

    const initials = this.botName ? this.botName.slice(0, 2).toUpperCase() : "OC";
    const avatar = role === "assistant" ? initials : "U";

    msg.innerHTML = `
      <div class="message-avatar">${avatar}</div>
      <div class="message-content">
        <div class="message-role">${role === "assistant" ? escapeHtml(this.botName) : "You"}</div>
        <div class="message-text ${isStreaming ? "streaming-cursor" : ""}">${this.renderMarkdown(content)}</div>
      </div>
    `;

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
  },

  async send() {
    const text = this.elements.messageInput.value.trim();
    if (!text || this.isStreaming) return;

    // Clear input
    this.elements.messageInput.value = "";
    this.elements.messageInput.style.height = "auto";
    this.elements.sendBtn.disabled = true;

    // Show chat area if hidden
    if (!this.currentConversationId) {
      this.elements.welcomeScreen.style.display = "none";
      this.elements.chatArea.style.display = "flex";
      this.elements.inputArea.style.display = "block";
    }

    // Handle /clear locally
    if (text === "/clear") {
      this.newChat();
      this.elements.welcomeScreen.style.display = "none";
      this.elements.chatArea.style.display = "flex";
      this.elements.inputArea.style.display = "block";
      this.elements.chatArea.innerHTML = "";
      this.appendMessage("assistant", "Conversation cleared. Starting fresh.");
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
          this.loadConversations();
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
        }
      );
    } catch (err) {
      this.finishStreaming(assistantMsg);
      App.showToast(err.message, "error");
    }

    this.isStreaming = false;
    this.elements.sendBtn.disabled = false;
    this.elements.messageInput.focus();
  },

  newChat() {
    this.currentConversationId = null;
    this.elements.chatArea.style.display = "none";
    this.elements.inputArea.style.display = "block";
    this.elements.welcomeScreen.style.display = "flex";
    this.elements.topbarTitle.textContent = this.botName || "OpusClaw";
    this.renderConversationList();
    this.elements.messageInput.focus();
  },

  async deleteConversation(id) {
    try {
      await API.deleteConversation(id);
      if (this.currentConversationId === id) {
        this.newChat();
      }
      await this.loadConversations();
      App.showToast("Conversation deleted", "success");
    } catch (err) {
      App.showToast(err.message, "error");
    }
  },

  scrollToBottom() {
    const el = this.elements.chatArea;
    el.scrollTop = el.scrollHeight;
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
