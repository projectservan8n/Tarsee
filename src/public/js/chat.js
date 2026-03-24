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
      this.setBotName(data.botName || "Tarsee");
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
      welcomeLogo.style.fontSize = "32px";
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
    // Close settings if open
    if (typeof Settings !== "undefined" && Settings.isOpen) {
      Settings.close();
    }

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

    const avatar = role === "assistant"
      ? `<img src="/icon-32.png" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%">`
      : "U";

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
    let toolBlocks = ""; // Accumulated tool call/result HTML

    this.isStreaming = true;

    try {
      await API.sendMessage(
        this.currentConversationId,
        text,
        // onText (content for text, null + event for tool events)
        (content, event) => {
          if (event?.type === "tool_call") {
            // Render tool call block
            const detail = event.input?.command || event.input?.filename || event.input?.url || event.input?.query || event.input?.fact || "";
            const argsStr = event.input ? JSON.stringify(event.input, null, 2) : "";
            toolBlocks += `<div class="block-tool-call">
              <div class="block-tool-header">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M9.5 1.5L14 6l-4.5 4.5M6.5 14.5L2 10l4.5-4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
                <span class="block-tool-name">${escapeHtml(event.name)}</span>
                <span class="block-detail">${escapeHtml(String(detail).slice(0, 80))}</span>
              </div>
              ${argsStr ? `<pre class="block-code">${escapeHtml(argsStr)}</pre>` : ""}
            </div>`;
            this.updateStreamingMessage(assistantMsg, toolBlocks + `<div class="block-streaming-indicator"><span class="streaming-dots"><span></span><span></span><span></span></span> Running ${escapeHtml(event.name)}…</div>`, true);
            this.scrollToBottom();
            return;
          }
          if (event?.type === "tool_result") {
            // Render tool result block
            const resultText = event.result || "(no output)";
            const isLong = resultText.length > 200;
            if (isLong) {
              const preview = escapeHtml(resultText.slice(0, 150)) + "…";
              toolBlocks += `<details class="block-tool-response"><summary><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M2 8h8M2 12h10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg> Result<span class="block-preview">${preview}</span></summary><div class="block-body">${escapeHtml(resultText)}</div></details>`;
            } else {
              toolBlocks += `<div class="block-tool-response block-tool-response--inline"><div class="block-tool-response-header"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M2 4h12M2 8h8M2 12h10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg> Result</div><div class="block-body">${escapeHtml(resultText)}</div></div>`;
            }
            this.updateStreamingMessage(assistantMsg, toolBlocks, true);
            this.scrollToBottom();
            return;
          }
          // Normal text
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

    // Code blocks (```lang\ncode\n```)
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
      const langLabel = lang || "code";
      return `<div class="code-header"><span>${escapeHtml(langLabel)}</span><button class="copy-btn" onclick="navigator.clipboard.writeText(this.closest('.code-header').nextElementSibling.textContent)">Copy</button></div><pre><code>${code}</code></pre>`;
    });

    // Headings (### h3, ## h2, # h1) — must be at start of line
    html = html.replace(/(^|<br>)### (.+?)(<br>|$)/g, "$1<h3>$2</h3>$3");
    html = html.replace(/(^|<br>)## (.+?)(<br>|$)/g, "$1<h2>$2</h2>$3");
    html = html.replace(/(^|<br>)# (.+?)(<br>|$)/g, "$1<h1>$2</h1>$3");

    // Inline code
    html = html.replace(/`([^`]+)`/g, "<code>$1</code>");

    // Bold
    html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");

    // Italic
    html = html.replace(/\*(.+?)\*/g, "<em>$1</em>");

    // Strikethrough
    html = html.replace(/~~(.+?)~~/g, "<del>$1</del>");

    // Links
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // Horizontal rule
    html = html.replace(/(^|<br>)---(<br>|$)/g, "$1<hr>$2");

    // Unordered lists (- item)
    html = html.replace(/(^|<br>)- (.+?)(?=<br>|$)/g, "$1<li>$2</li>");

    // Newlines to <br> (but not inside pre blocks)
    html = html.replace(/\n/g, "<br>");

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

  return `<div class="block-tool-call">
    <div class="block-tool-header">
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M9.5 1.5L14 6l-4.5 4.5M6.5 14.5L2 10l4.5-4.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <span class="block-tool-name">${escapeHtml(name)}</span>
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
