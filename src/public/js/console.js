/**
 * Tarsee Console — Real-time server console in the WebUI.
 * Connects via WebSocket to stream live server logs and execute debug commands.
 */
const Console = {
  ws: null,
  isOpen: false,
  isMaximized: false,
  autoScroll: true,
  commandHistory: [],
  historyIndex: -1,
  availableCommands: [],

  init() {
    this.panel = document.getElementById("consolePanel");
    this.output = document.getElementById("consoleOutput");
    this.input = document.getElementById("consoleInput");
    this.statusEl = document.getElementById("consoleStatus");
    this.toggleBtn = document.getElementById("consoleToggleBtn");
    this.badge = document.getElementById("consoleBadge");

    if (!this.panel) return;

    // Toggle button
    this.toggleBtn.addEventListener("click", () => this.toggle());

    // Close button
    document.getElementById("consoleCloseBtn").addEventListener("click", () => this.close());

    // Maximize button
    document.getElementById("consoleMaxBtn").addEventListener("click", () => this.toggleMaximize());

    // Clear button
    document.getElementById("consoleClearBtn").addEventListener("click", () => this.clear());

    // Auto-scroll toggle
    document.getElementById("consoleAutoScrollBtn").addEventListener("click", (e) => {
      this.autoScroll = !this.autoScroll;
      e.currentTarget.classList.toggle("active", this.autoScroll);
    });

    // Input handling
    this.input.addEventListener("keydown", (e) => this.handleKeydown(e));

    // Load available commands
    this.loadCommands();
  },

  async loadCommands() {
    try {
      const res = await fetch("/api/debug/commands", { credentials: "same-origin" });
      if (res.ok) {
        const data = await res.json();
        this.availableCommands = data.commands || [];
      }
    } catch { /* ignore */ }
  },

  toggle() {
    if (this.isOpen) {
      this.close();
    } else {
      this.open();
    }
  },

  open() {
    this.isOpen = true;
    this.panel.classList.add("open");
    this.toggleBtn.classList.add("active");
    this.connect();
    this.input.focus();
  },

  close() {
    this.isOpen = false;
    this.isMaximized = false;
    this.panel.classList.remove("open", "maximized");
    this.toggleBtn.classList.remove("active");
    this.disconnect();
  },

  toggleMaximize() {
    this.isMaximized = !this.isMaximized;
    this.panel.classList.toggle("maximized", this.isMaximized);
  },

  clear() {
    this.output.innerHTML = "";
    this.appendSystem("Console cleared.");
  },

  connect() {
    if (this.ws && this.ws.readyState <= 1) return; // already connected/connecting

    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${location.host}/ws`;

    this.setStatus("connecting");
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      // Session cookie is sent automatically with the upgrade request,
      // so the server may already authenticate us. If not, try token auth.
      const token = this.getApiToken();
      if (token) {
        this.ws.send(JSON.stringify({ type: "auth", token }));
      }
      // If no token and no session, server will send auth_ok if session-authed,
      // or timeout after 10s if truly unauthenticated
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        this.handleMessage(msg);
      } catch { /* ignore bad messages */ }
    };

    this.ws.onclose = () => {
      this.setStatus("disconnected");
      // Auto-reconnect if still open
      if (this.isOpen) {
        setTimeout(() => this.connect(), 3000);
      }
    };

    this.ws.onerror = () => {
      this.setStatus("error");
    };
  },

  disconnect() {
    if (this.ws) {
      // Unsubscribe from console before closing
      try {
        this.ws.send(JSON.stringify({ type: "console.unsubscribe" }));
      } catch { /* ignore */ }
      this.ws.close();
      this.ws = null;
    }
  },

  getApiToken() {
    // Try API.token first (set during login), then settings input as fallback
    if (typeof API !== "undefined" && API.token) return API.token;
    const tokenEl = document.getElementById("settingsApiToken");
    return tokenEl?.value || null;
  },

  handleMessage(msg) {
    switch (msg.type) {
      case "auth_ok":
        this.setStatus("connected");
        // Subscribe to console logs
        this.ws.send(JSON.stringify({ type: "console.subscribe" }));
        this.appendSystem("Connected to Tarsee server console.");
        break;

      case "auth_error":
        this.setStatus("auth failed");
        this.appendSystem("Authentication failed. Check your API token in Settings.");
        break;

      case "console.history":
        // Render historical entries
        if (msg.entries && msg.entries.length > 0) {
          this.appendSystem(`--- ${msg.entries.length} historical entries ---`);
          for (const entry of msg.entries) {
            this.appendLogEntry(entry);
          }
          this.appendSystem("--- live stream ---");
        }
        break;

      case "console.log":
        this.appendLogEntry(msg.entry);
        // Show badge if console is closed
        if (!this.isOpen && this.badge) {
          this.badge.classList.add("active");
        }
        break;

      case "console.result":
        this.appendResult(msg.command, msg.output);
        break;

      case "console.error":
        this.appendError(msg.message || msg.error || "Unknown error");
        break;

      // Ignore other message types (chat messages etc)
    }
  },

  handleKeydown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const cmd = this.input.value.trim();
      if (!cmd) return;

      this.commandHistory.unshift(cmd);
      if (this.commandHistory.length > 50) this.commandHistory.pop();
      this.historyIndex = -1;

      this.executeCommand(cmd);
      this.input.value = "";
    }

    // Command history navigation
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (this.historyIndex < this.commandHistory.length - 1) {
        this.historyIndex++;
        this.input.value = this.commandHistory[this.historyIndex];
      }
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (this.historyIndex > 0) {
        this.historyIndex--;
        this.input.value = this.commandHistory[this.historyIndex];
      } else {
        this.historyIndex = -1;
        this.input.value = "";
      }
    }

    // Tab completion
    if (e.key === "Tab") {
      e.preventDefault();
      this.tabComplete();
    }

    // Escape to close
    if (e.key === "Escape") {
      this.close();
    }
  },

  tabComplete() {
    const val = this.input.value.trim();
    if (!val) {
      // Show all commands
      this.appendSystem("Available commands: " + this.availableCommands.map((c) => c.name).join(", "));
      this.appendSystem("Also: help, clear, history");
      return;
    }

    const matches = this.availableCommands.filter((c) => c.name.startsWith(val));
    if (matches.length === 1) {
      this.input.value = matches[0].name;
    } else if (matches.length > 1) {
      this.appendSystem("Matches: " + matches.map((c) => c.name).join(", "));
    }
  },

  executeCommand(input) {
    this.appendCommand(input);

    // Built-in console commands
    if (input === "help") {
      let help = "Built-in: help, clear, history\n\nServer commands:\n";
      for (const cmd of this.availableCommands) {
        help += `  ${cmd.name.padEnd(20)} ${cmd.description}\n`;
      }
      this.appendResult("help", help);
      return;
    }

    if (input === "clear") {
      this.clear();
      return;
    }

    if (input === "history") {
      const hist = this.commandHistory.slice(0, 20).map((c, i) => `  ${i + 1}. ${c}`).join("\n");
      this.appendResult("history", hist || "(empty)");
      return;
    }

    // Send to server via WebSocket
    if (!this.ws || this.ws.readyState !== 1) {
      this.appendError("Not connected to server.");
      return;
    }

    // Parse command and args
    const parts = input.split(/\s+/);
    const command = parts[0];
    const args = parts.slice(1).join(" ") || undefined;

    this.ws.send(JSON.stringify({ type: "console.exec", command, args }));
  },

  // --- DOM rendering helpers ---

  appendLogEntry(entry) {
    const div = document.createElement("div");
    div.className = `console-entry ${entry.level}`;

    const ts = new Date(entry.ts).toISOString().slice(11, 23);
    div.innerHTML =
      `<span class="ts">${ts}</span>` +
      `<span class="level ${entry.level}">${entry.level}</span>` +
      `<span class="text">${this.escapeHtml(entry.text)}</span>`;

    this.output.appendChild(div);
    this.scrollToBottom();
  },

  appendCommand(text) {
    const div = document.createElement("div");
    div.className = "console-entry cmd-input";
    div.innerHTML = `<span class="text">&gt; ${this.escapeHtml(text)}</span>`;
    this.output.appendChild(div);
    this.scrollToBottom();
  },

  appendResult(command, output) {
    const div = document.createElement("div");
    div.className = "console-entry cmd-result";
    div.innerHTML = `<span class="text">${this.escapeHtml(output)}</span>`;
    this.output.appendChild(div);
    this.scrollToBottom();
  },

  appendError(text) {
    const div = document.createElement("div");
    div.className = "console-entry error";
    div.innerHTML = `<span class="text">${this.escapeHtml(text)}</span>`;
    this.output.appendChild(div);
    this.scrollToBottom();
  },

  appendSystem(text) {
    const div = document.createElement("div");
    div.className = "console-entry";
    div.innerHTML = `<span class="text" style="color:#585B70;font-style:italic">${this.escapeHtml(text)}</span>`;
    this.output.appendChild(div);
    this.scrollToBottom();
  },

  scrollToBottom() {
    if (this.autoScroll) {
      requestAnimationFrame(() => {
        this.output.scrollTop = this.output.scrollHeight;
      });
    }
  },

  setStatus(status) {
    if (!this.statusEl) return;
    this.statusEl.textContent = status;
    this.statusEl.className = "console-status" + (status === "connected" ? " connected" : "");
  },

  escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  },
};
