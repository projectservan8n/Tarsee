/**
 * Chat UI module.
 * Handles message rendering, streaming, and conversation management.
 */
const Chat = {
  currentConversationId: null,
  isStreaming: false,
  conversations: [],

  elements: {},

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

    // Auto-resize textarea
    this.elements.messageInput.addEventListener("input", () => {
      const el = this.elements.messageInput;
      el.style.height = "auto";
      el.style.height = Math.min(el.scrollHeight, 200) + "px";
      this.elements.sendBtn.disabled = !el.value.trim();
    });

    // Send on Enter (Shift+Enter for newline)
    this.elements.messageInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (!this.isStreaming && this.elements.messageInput.value.trim()) {
          this.send();
        }
      }
    });

    this.elements.sendBtn.addEventListener("click", () => this.send());
    this.elements.newChatBtn.addEventListener("click", () => this.newChat());

    this.loadConversations();
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

    const avatar = role === "assistant" ? "OC" : "U";

    msg.innerHTML = `
      <div class="message-avatar">${avatar}</div>
      <div class="message-content">
        <div class="message-role">${role === "assistant" ? "OpusClaw" : "You"}</div>
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
          this.updateStreamingMessage(assistantMsg, fullResponse);
          this.scrollToBottom();
        },
        // onDone
        (data) => {
          if (data?.type === "conversation" && data.conversationId) {
            this.currentConversationId = data.conversationId;
          }
          this.finishStreaming(assistantMsg);
          this.loadConversations();
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
    this.elements.topbarTitle.textContent = "OpusClaw";
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
