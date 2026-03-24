/**
 * Tarsee API Client.
 * Handles all communication with the server, including CSRF tokens and auth.
 */
const API = {
  token: null,

  /**
   * Get CSRF token from cookie.
   */
  getCsrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)tarsee_csrf=([^;]+)/);
    return match ? match[1] : null;
  },

  /**
   * Make an authenticated API request.
   */
  async request(path, opts = {}) {
    const headers = {
      ...(opts.headers || {}),
    };

    // Add CSRF token for state-changing requests
    if (opts.method && opts.method !== "GET") {
      const csrf = this.getCsrfToken();
      if (csrf) headers["X-CSRF-Token"] = csrf;
    }

    // Add auth token if available (for API clients)
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }

    // Default to JSON if body is object
    if (opts.body && typeof opts.body === "object" && !(opts.body instanceof FormData)) {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.body);
    }

    const res = await fetch(path, { ...opts, headers, credentials: "same-origin" });

    if (res.status === 401) {
      // Session expired — redirect to login
      window.location.reload();
      throw new Error("Session expired");
    }

    return res;
  },

  /**
   * JSON request helper.
   */
  async json(path, opts = {}) {
    const res = await this.request(path, opts);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${res.status}`);
    }
    return res.json();
  },

  // --- Auth ---
  async login(password) {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
      credentials: "same-origin",
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Login failed");
    this.token = data.apiToken;
    return data;
  },

  async logout() {
    await this.request("/api/auth/logout", { method: "POST" });
  },

  async authStatus() {
    const res = await fetch("/api/auth/status", { credentials: "same-origin" });
    return res.json();
  },

  // --- Channels ---
  async listChannels() {
    return this.json("/api/chat/channels");
  },

  // --- Conversations ---
  async listConversations(limit = 50, offset = 0) {
    return this.json(`/api/chat/conversations?limit=${limit}&offset=${offset}`);
  },

  async getConversation(id) {
    return this.json(`/api/chat/conversations/${id}`);
  },

  async createConversation(opts = {}) {
    return this.json("/api/chat/conversations", { method: "POST", body: opts });
  },

  async deleteConversation(id) {
    return this.json(`/api/chat/conversations/${id}`, { method: "DELETE" });
  },

  async updateConversation(id, data) {
    return this.json(`/api/chat/conversations/${id}`, { method: "PATCH", body: data });
  },

  // --- Chat (SSE streaming) ---
  async sendMessage(conversationId, message, onText, onDone, onError, channelKey) {
    const csrf = this.getCsrfToken();
    const headers = {
      "Content-Type": "application/json",
    };
    if (csrf) headers["X-CSRF-Token"] = csrf;

    const body = { message };
    if (channelKey) body.channelKey = channelKey;
    if (conversationId) body.conversationId = conversationId;

    const res = await fetch("/api/chat/send", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      credentials: "same-origin",
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      onError?.(data.error || `HTTP ${res.status}`);
      return;
    }

    // Check if response is a command result (JSON, not SSE stream)
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      const data = await res.json();
      if (data.command) {
        onText?.(data.response);
        onDone?.({ conversationId: data.conversationId, type: "command" });
        return;
      }
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      let eventType = null;
      for (const line of lines) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const data = line.slice(6).trim();
          try {
            const parsed = JSON.parse(data);
            if (eventType === "text") onText?.(parsed.content);
            else if (eventType === "done") onDone?.(parsed);
            else if (eventType === "error") onError?.(parsed.message);
            else if (eventType === "conversation") onDone?.({ conversationId: parsed.id, type: "conversation" });
          } catch {}
          eventType = null;
        }
      }
    }
  },

  // --- Providers ---
  async getProviders() {
    return this.json("/api/chat/providers");
  },

  // --- Settings ---
  async getSettings() {
    return this.json("/api/settings");
  },

  async saveProvider(data) {
    return this.json("/api/settings/provider", { method: "POST", body: data });
  },

  async saveChannel(data) {
    return this.json("/api/settings/channel", { method: "POST", body: data });
  },

  // --- Admin ---
  async getStatus() {
    return this.json("/api/admin/status");
  },

  async restartChannel(type) {
    return this.json(`/api/admin/channels/${type}/restart`, { method: "POST" });
  },

  // --- Voice ---
  async tts(text, voiceId) {
    const res = await this.request("/api/voice/tts", {
      method: "POST",
      body: { text, voiceId },
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || "TTS failed");
    }
    return res.blob();
  },

  async getVoices() {
    return this.json("/api/voice/voices");
  },
};
