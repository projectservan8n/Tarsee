/**
 * Chat UI module.
 *
 * Every channel (web, Discord, Telegram, WhatsApp, email) keeps one persistent
 * conversation, and the web can have as many as you start ("New chat"). Each
 * one has its own address, /chat/<conversationId>, as on claude.ai: switching
 * chats pushes it, Back and Forward go between them, and a reload or a shared
 * link opens that chat.
 *
 * The sidebar is plain rows grouped by where each chat lives, with no emoji or
 * icon in front; the rules are in js/chat-core.js. A reply's tool steps never
 * sit in the way of what was said: one quiet line in the answer's place while
 * the agent works, folded into "Used 12 tools" above the answer once it has
 * replied, each step one line that opens to show its input and output
 * (Chat.createSteps, used by js/live.js too).
 */
const Core = globalThis.ChatCore;

const Chat = {
  currentChannelKey: null,
  currentConversationId: null,
  isStreaming: false,
  channels: [],
  // Sidebar state kept on this device: collapsed groups, groups showing every row.
  _collapsed: new Set(),
  _expanded: new Set(),
  _navQuery: "",
  botName: "Tarsee",
  lastMessageRole: null,
  lastMessageTime: 0,
  pendingFiles: [],
  messageQueue: [],

  // The message box: its words as this page last saw them, and which of those aren't the owner's: a diagram's, or
  // words found there that the page didn't put there (setBox, _boxEdited). And until when Enter in it doesn't send
  // (insertIntoBox).
  _box: { value: "", marks: [], seen: [], sel: null, clip: null },
  _enterHeldUntil: 0,

  // Live context-window telemetry from the most recent turn. Lets us
  // render a real prompt-token meter instead of the chars/4 estimate.
  // Reset on conversation switch so a stale fill doesn't bleed across.
  _lastUsage: null,
  _lastContextTokens: null,
  _overflowBannerDismissed: false,

  elements: {},

  // Command palette state
  commands: [],
  paletteVisible: false,
  paletteIndex: -1,
  paletteCommands: [],

  init() {
    // Live view first: it takes over (and migrates) the old in-tab queue.
    if (typeof Live !== "undefined") Live.init();
    // Bring back any message that was queued but not yet sent before a reload.
    this._restoreQueue();
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

    // Settings → AI (js/settings.js) read the AIs and something the composer shows changed: the list and the defaults
    // again, now. A new default (or its model, or whether it can answer) also means the model the last turn ran on is
    // no longer what the next message runs on.
    window.addEventListener("tarsee:ai-changed", (ev) => {
      if (ev.detail?.defaultChanged !== false) this._turnModel = null;
      this.refreshPicker(true);
      this._loadPick({ fresh: true });
    });

    // Diagram node clicks: a click on a node puts its question in the message box (never sent from there)
    this._initDiagramListener();

    // Which of the box's words aren't the owner's (_boxEdited): where each edit was, for the one that follows; and
    // first, any change made with no edit since the last one (_boxSync), so an edit is always read against the words
    // just before it.
    this.elements.messageInput.addEventListener("beforeinput", (e) => {
      this._boxSync();
      const el = this.elements.messageInput;
      this._box.sel = { at: [el.selectionStart, el.selectionEnd], type: e.inputType };
    });
    // Words already in the box that this page didn't put there are not the owner's: a command made of them asks before
    // it runs. The box is autocomplete="off", so a browser shouldn't put a form's words back (after Back, or when it
    // restores its tabs), but one may: here as the page starts, and when it is shown again or Back or Forward moves it.
    this._boxFound();
    window.addEventListener("pageshow", () => this._boxFound());
    window.addEventListener("popstate", () => this._boxFound());
    // Words copied, cut or dragged out of the box: which of them were a diagram's, for when they are put back.
    for (const type of ["copy", "cut", "dragstart"]) this.elements.messageInput.addEventListener(type, () => this._boxClip());
    // The owner clicking in the box is the owner there: Enter sends again at once (see the keys below).
    this.elements.messageInput.addEventListener("pointerdown", (e) => { if (e.isTrusted) this._enterHeldUntil = 0; });

    // Auto-resize textarea + command palette trigger
    this.elements.messageInput.addEventListener("input", (e) => {
      // An edit of the owner's (the browser's own event), or else a change no edit made (the page's own changes come
      // through setBox, which has already taken note of them).
      if (e.isTrusted && e.inputType) this._boxEdited(e.inputType);
      else this._boxSync();
      // The owner typing in the box ends the wait for Enter too. Not a space alone: a node pressed twice quickly with
      // Space puts the second one here.
      if (e.isTrusted && !(/^insert(Text|LineBreak|Paragraph)$/.test(e.inputType) && !/\S/.test(e.data || ""))) this._enterHeldUntil = 0;
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
      // A held Enter acts once, when it goes down: its repeats neither send nor pick a command. So a key held down while
      // the focus moved here (a diagram's node puts its words in the box) never sends the words it finds. Nor does an
      // Enter in the second after a diagram put words here (insertIntoBox): a node pressed twice quickly (a double tap,
      // a key's chatter) puts its second press here, too soon for anyone to have read them. A click or typing in the
      // box ends that wait at once.
      if (e.key === "Enter" && (this.paletteVisible || !e.shiftKey) && (e.repeat || performance.now() < this._enterHeldUntil)) {
        e.preventDefault();
        return;
      }
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
      } else if (e.key === "Escape" && this.liveOn() && Live.canStop() && document.getElementById("fileManagerPanel")?.style.display !== "flex") {
        e.preventDefault();
        Live.stop();
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
        this.setBox("/" + input.value, { at: [0, 0] });
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

    // Attachment previews (no inline onclick: the CSP forbids inline script)
    document.addEventListener("click", (e) => {
      const img = e.target.closest("img.clickable-image[data-lightbox]");
      if (img) { this.openLightbox(img.src); return; }
      const chip = e.target.closest("[data-preview-idx]");
      if (chip) this.previewStoredFile(Number(chip.dataset.previewIdx));
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
        // The canvas's or the diagram's own address (embedHtml).
        const href = embed?.dataset.href;
        if (href) {
          const url = `${location.origin}${href}`;
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

    // The model, the effort and the context meter, small in the composer.
    this.elements.sessionModel = document.getElementById("sessionModel");
    this.elements.sessionStatus = document.getElementById("sessionStatus");
    this.elements.contextBarFill = document.getElementById("contextBarFill");
    this.elements.contextLabel = document.getElementById("contextLabel");
    this.elements.topbarWhere = document.getElementById("topbarWhere");
    this.elements.chatMenuBtn = document.getElementById("chatMenuBtn");
    this._initNav();
    this._initChatMenu();
    this._initRouter();

    this.loadChannels();
    this.loadCommands();
    this.loadBotName();
    window.ModelPicker?.init(document.getElementById("modelPickerBtn"));
    this.initSearch();
    this._initStreamResumeWatchers();
  },

  // Tab-wake handoff. With the server-side fix in place (chat.js no
  // longer aborts the AI generator when the SSE socket dies), every
  // event that landed during sleep is buffered in the gateway and
  // replayed via the existing WS `sync.resume` channel. On wake we
  //   (a) drop our claim to be "the streaming owner" so _handleSyncEvent
  //       at L1786 stops short-circuiting,
  //   (b) abort the (probably-dead) SSE reader so its spinner clears,
  //   (c) trigger sync.resume to backfill any missed text/tool events,
  //   (d) refetch the conversation as belt-and-suspenders for slept-past
  //       the gateway's 10-minute buffer window.
  _initStreamResumeWatchers() {
    if (this._streamResumeBound) return;
    this._streamResumeBound = true;
    let _lastWakeAt = 0;
    const onWake = () => {
      const now = Date.now();
      if (now - _lastWakeAt < 1000) return;
      _lastWakeAt = now;

      // Live view: catch up from the last sequence seen. Nothing is redrawn
      // or aborted, so nothing on screen can vanish.
      if (this.liveOn()) { Live.onWake(); return; }

      // Only take over a stream that has actually gone quiet. Aborting a
      // healthy one on every alt-tab killed the live reply and, with it, the
      // drain of any queued message, which is how sent messages vanished.
      // While the SSE stays live, isStreaming keeps the sync path deduped.
      // The server heartbeats every 15s, so 25s of silence means it's dead
      // and the gateway (WS sync) has every event we missed.
      const streamSilentMs = Date.now() - (API._lastStreamEventAt || 0);
      if (this.isStreaming && streamSilentMs > 25_000) {
        try { API.abortStream?.(); } catch { /* ignore */ }
        this.isStreaming = false;
        this._streamingConvId = null;
        this.elements.sendBtn?.classList.remove("stop-mode", "is-streaming");
        if (this.elements.sendBtn) this.elements.sendBtn.title = "Send";
        if (window.App?.showToast) App.showToast("Reconnected: recovering last turn", "info");
      }

      // Force a sync.resume even if the WS stayed alive through the wake.
      if (this.currentConversationId && this._typingWs?.readyState === 1) {
        const lastId = (this._lastEventIdByConv || {})[this.currentConversationId] || 0;
        try {
          this._typingWs.send(JSON.stringify({
            type: "sync.resume",
            convId: this.currentConversationId,
            lastEventId: lastId,
          }));
        } catch { /* ignore */ }
      }

      this._refetchActiveConversation();
      this._loadPick({ fresh: true });   // (a model or an effort picked on another device meanwhile)
    };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") onWake();
    });
    window.addEventListener("online", onWake);
    window.addEventListener("pageshow", onWake);
  },

  // Re-pull the current conversation from the server so any messages that
  // landed while we were asleep show up. Cheap one-shot — the WebSocket
  // sync.resume path covers incremental sync separately.
  async _refetchActiveConversation() {
    if (!this.currentConversationId || this.isStreaming) return;
    const convAtStart = this.currentConversationId;
    try {
      const data = await API.getConversation(this.currentConversationId);
      // The user may have sent or switched while we waited: don't paint a
      // stale snapshot over a newer UI.
      if (this.isStreaming || this.currentConversationId !== convAtStart) return;
      const msgs = data.messages || [];
      const total = data.totalMessages || msgs.length;
      const older = total - msgs.length;
      this.renderMessages(msgs, older > 0 ? older : 0, this.currentConversationId, data.leadFiles);
      this._drainQueueIfIdle();
    } catch { /* ignore — silent retry on next wake */ }
  },

  /**
   * The model and the context meter in the composer. The model's name is asked
   * for once (the server's default model) and replaced by the one a turn says
   * it ran on; the meter shows only once a turn in this chat has said how full
   * the context is (a number from another chat would be wrong here).
   */
  updateSessionBar() {
    if (!this._picker) this.refreshPicker(true);
    this._loadPick();
    const meter = document.getElementById("contextMeter");
    if (this._lastUsage && this._lastContextTokens) {
      this.applyContextMeter(this.promptTokensFromUsage(this._lastUsage), this._lastContextTokens);
      if (meter) meter.hidden = false;
    } else {
      if (meter) meter.hidden = true;
      if (this.elements.contextBarFill) { this.elements.contextBarFill.style.width = "0%"; this.elements.contextBarFill.className = "context-bar-fill"; }
      if (this.elements.contextLabel) this.elements.contextLabel.textContent = "0%";
    }
  },

  // Real prompt size = fresh input + cache hits + cache writes. All three
  // count against the context window even though they price differently.
  promptTokensFromUsage(u) {
    if (!u) return 0;
    // The last call's prompt when the engine knows it: a turn's usage sums its calls (routes/chat.js does the same).
    if (Number(u.context_input_tokens) > 0) return Number(u.context_input_tokens);
    return (u.input_tokens || 0)
      + (u.cache_read_input_tokens || 0)
      + (u.cache_creation_input_tokens || 0);
  },

  formatTokenCount(n) {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
    if (n >= 1_000) return (n / 1_000).toFixed(1) + "K";
    return String(n || 0);
  },

  // The single source of truth for the context meter. Called from the live
  // SSE `usage` event and from `updateSessionBar` on conversation switch.
  // Thresholds: <75% accent, 75-89% warning, 90%+ danger.
  applyContextMeter(promptTokens, contextTokens) {
    if (!this.elements.contextBarFill || !this.elements.contextLabel) return;
    const pct = contextTokens > 0
      ? Math.min(100, Math.round((promptTokens / contextTokens) * 100))
      : 0;
    this.elements.contextBarFill.style.width = `${pct}%`;
    let cls = "context-bar-fill";
    if (pct >= 90) cls += " danger";
    else if (pct >= 75) cls += " warning";
    this.elements.contextBarFill.className = cls;
    this.elements.contextLabel.textContent = `${pct}%`;
    const tip = `${this.formatTokenCount(promptTokens)} / ${this.formatTokenCount(contextTokens)} tokens: near the limit Claude Code summarizes the older part automatically`;
    this.elements.contextBarFill.parentElement?.setAttribute("title", tip);
    this.elements.contextLabel.title = tip;
    if (pct >= 90 && !this._overflowBannerDismissed) {
      this.showContextWarningBanner(pct);
    } else if (pct < 90) {
      this.hideContextWarningBanner();
    }
  },

  showContextWarningBanner(pct) {
    const inputArea = this.elements.inputArea;
    if (!inputArea) return;
    let banner = document.getElementById("contextWarningBanner");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "contextWarningBanner";
      banner.className = "context-warning-banner";
      banner.innerHTML = `
        <span class="context-warning-text"></span>
        <button type="button" class="context-warning-dismiss" aria-label="Dismiss">×</button>
      `;
      banner.querySelector(".context-warning-dismiss").addEventListener("click", () => {
        this._overflowBannerDismissed = true;
        this.hideContextWarningBanner();
      });
      inputArea.insertBefore(banner, inputArea.firstChild);
    }
    banner.querySelector(".context-warning-text").textContent =
      `Context is ${pct}% full: Claude Code will summarize the older part soon. Run /checkpoint first if you want a full record.`;
    banner.style.display = "flex";
  },

  hideContextWarningBanner() {
    const banner = document.getElementById("contextWarningBanner");
    if (banner) banner.style.display = "none";
  },

  showOverflowRecoveryCard(checkpointPath) {
    const inputArea = this.elements.inputArea;
    if (!inputArea) return;
    let card = document.getElementById("contextOverflowCard");
    if (!card) {
      card = document.createElement("div");
      card.id = "contextOverflowCard";
      card.className = "context-overflow-card";
      card.innerHTML = `
        <div class="context-overflow-title">Context overflowed: snapshot saved</div>
        <div class="context-overflow-body">Your last message pushed the model past its window. Tarsee saved a recovery checkpoint to <code class="context-overflow-path"></code>. Start a fresh session and the next instance will read this checkpoint as a handoff.</div>
        <div class="context-overflow-actions">
          <button type="button" class="context-overflow-fresh">Start fresh session</button>
          <button type="button" class="context-overflow-dismiss">Dismiss</button>
        </div>
      `;
      card.querySelector(".context-overflow-fresh").addEventListener("click", () => {
        card.remove();
        this.resetSession();
      });
      card.querySelector(".context-overflow-dismiss").addEventListener("click", () => card.remove());
      inputArea.insertBefore(card, inputArea.firstChild);
    }
    card.querySelector(".context-overflow-path").textContent = checkpointPath || "workspace/CHECKPOINT.md";
    card.style.display = "flex";
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

    // IDENTITY.md may name it too. (Its emoji is not shown: the icon is the picture, set in Settings.)
    try {
      const identity = await API.json("/api/settings/workspace-file?name=IDENTITY.md");
      if (identity.content) this.applyIdentity(identity.content);
    } catch {
      // ignore: the name above stands
    }
  },

  applyIdentity(content) {
    // Format: - **Label:** value
    let name = null;
    for (const line of String(content).split("\n")) {
      const match = line.match(/^-\s*\*\*(.+?)\*\*:?\s*(.+)/);
      if (!match) continue;
      if (match[1].toLowerCase().trim() === "name" && match[2].trim()) name = match[2].trim();
    }
    if (name && name !== this.botName) this.setBotName(name);
  },

  setBotName(name) {
    this.botName = name || "Tarsee";
    if (!this.currentChannelKey && !(typeof Settings !== "undefined" && Settings.isOpen) && !(typeof Usage !== "undefined" && Usage.isOpen)) {
      this.elements.topbarTitle.textContent = this.botName;
    }
    const brand = document.querySelector(".sidebar-header .brand-name");
    if (brand) brand.textContent = this.botName;
    const input = this.elements.messageInput;
    if (input) {
      const ph = `Message ${this.botName}`;
      if (input.dataset.idlePlaceholder) input.dataset.idlePlaceholder = ph; else input.placeholder = ph;
    }
    if (typeof Call !== "undefined") Call.paintButton();   // "Call <name>"
    this._paintTitle();
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
    // (The letters it keeps from what was typed keep their marks: a diagram's "/sta" made into /status is still a
    // diagram's command.)
    this.setBox(hasArgs ? `/${cmd.name} ` : cmd.usage);
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

  // --- Chats: the sidebar, the addresses, opening one ---
  async loadChannels() {
    try {
      const data = await API.listChannels();
      this.channels = data.channels || [];
    } catch (err) {
      console.error("Failed to load channels:", err);
      if (!this._routed) this.elements.inputArea.style.display = "block";
    }
    this.renderChannelList();
    // The first time: open what the address asks for (a chat's own, a new one, or the one this device had open).
    if (!this._routed) {
      this._routed = true;
      this.route(location.pathname, { replace: true });
    } else if (this.currentConversationId) {
      this._paintHeader();
    }
  },

  /** The sidebar's own controls: New chat, the search box, the groups, the rows (delegated: the list is redrawn often). */
  _initNav() {
    try {
      this._collapsed = new Set(JSON.parse(localStorage.getItem("tarsee_nav_collapsed") || "[]"));
      this._expanded = new Set(JSON.parse(localStorage.getItem("tarsee_nav_expanded") || "[]"));
    } catch { /* storage blocked: all open */ }
    const plainClick = (e) => e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
    for (const id of ["newChatBtn", "brandLink"]) {
      document.getElementById(id)?.addEventListener("click", (e) => {
        if (!plainClick(e)) return;   // (a new tab opens a new chat there)
        e.preventDefault();
        this.newChat();
      });
    }
    const list = this.elements.channelList;
    list.addEventListener("click", (e) => {
      const row = e.target.closest(".nav-row");
      if (row) {
        if (!plainClick(e)) return;
        e.preventDefault();
        const key = row.dataset.key;
        const id = row.dataset.convId || null;
        if (key?.startsWith("live:") && typeof Live !== "undefined") { Live.openBackground(id); return; }
        this.openChannel(key, id);
        return;
      }
      const head = e.target.closest(".nav-group-head");
      if (head) {
        const g = head.dataset.group;
        if (this._collapsed.has(g)) this._collapsed.delete(g); else this._collapsed.add(g);
        this._saveNav();
        this.renderChannelList();
        list.querySelector(`.nav-group-head[data-group="${CSS.escape(g)}"]`)?.focus();
        return;
      }
      const more = e.target.closest(".nav-more");
      if (more) {
        const g = more.dataset.group;
        if (this._expanded.has(g)) this._expanded.delete(g); else this._expanded.add(g);
        this._saveNav();
        this.renderChannelList();
      }
    });
    document.getElementById("sidebarCloseBtn")?.addEventListener("click", () => this._closeDrawer());
  },

  _saveNav() {
    try {
      localStorage.setItem("tarsee_nav_collapsed", JSON.stringify([...this._collapsed]));
      localStorage.setItem("tarsee_nav_expanded", JSON.stringify([...this._expanded]));
    } catch { /* memory only */ }
  },

  _closeDrawer() {
    document.getElementById("sidebar")?.classList.remove("open");
    document.getElementById("sidebarOverlay")?.classList.remove("active");
    document.getElementById("menuBtn")?.setAttribute("aria-expanded", "false");
  },

  /** What the agent is doing right now, from the live feed: the chats it works in, and the background jobs at work. */
  _activityNow() {
    const working = new Set();
    const background = [];
    if (this.liveOn()) {
      const chats = new Set((this.channels || []).map((c) => c.conversationId));
      for (const t of Live.activity.values()) {
        working.add(t.conversationId);
        if (!chats.has(t.conversationId)) background.push({ conversationId: t.conversationId, label: Live.labelFor(t.conversationId), startedAt: t.startedAt });
      }
    }
    return { working, background, unread: this.liveOn() ? Live.unread : new Set() };
  },

  /** The sidebar: the chats grouped by where they live (js/chat-core.js groupChats), drawn again only when it changed. */
  renderChannelList() {
    const el = this.elements.channelList;
    if (!el) return;
    const { working, background, unread } = this._activityNow();
    const bgOpen = String(this.currentChannelKey || "").startsWith("live:") ? this.currentChannelKey.slice(5) : null;
    const groups = Core.groupChats(this.channels, {
      current: this.currentConversationId || bgOpen, currentKey: this.currentChannelKey, working, unread, background,
      collapsed: this._collapsed, expanded: this._expanded, query: this._navQuery,
    });
    const e = escapeHtml;
    let html = "";
    for (const g of groups) {
      const open = !g.collapsed;
      html += `<section class="nav-group${open ? "" : " is-collapsed"}" data-group="${e(g.id)}">`
        + `<button type="button" class="nav-group-head" data-group="${e(g.id)}" aria-expanded="${open}">`
        + `<span class="nav-group-label">${e(g.label)}</span>`
        + (g.working && !open ? '<span class="nav-dot" aria-hidden="true"></span>' : "")
        + `<svg class="nav-group-caret" width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>`
        + `</button>`;
      if (open) {
        html += '<ul class="nav-rows">';
        for (const r of g.rows) {
          const cls = ["nav-row", r.current ? "is-current" : "", r.working ? "is-working" : "", r.unread ? "is-unread" : ""].filter(Boolean).join(" ");
          const href = r.convId ? Core.chatPath(r.convId) : "/";
          const label = `${r.name}${r.working ? `, ${this.botName} is working` : ""}${r.unread ? ", unread" : ""}`;
          html += `<li><a class="${cls}" href="${e(href)}" data-key="${e(r.key)}"${r.convId ? ` data-conv-id="${e(r.convId)}"` : ""}${r.current ? ' aria-current="page"' : ""} aria-label="${e(label)}" title="${e(r.name)}">`
            + `<span class="nav-row-name">${e(r.name)}</span>`
            + `<span class="nav-row-meta">${r.working ? '<span class="nav-dot" aria-hidden="true"></span>' : ""}<span class="nav-row-time">${e(r.time)}</span></span>`
            + `</a></li>`;
        }
        html += "</ul>";
        if (g.more) html += `<button type="button" class="nav-more" data-group="${e(g.id)}">Show ${g.more} more</button>`;
        else if (this._expanded.has(g.id) && g.total > Core.GROUP_LIMIT && !this._navQuery) html += `<button type="button" class="nav-more" data-group="${e(g.id)}">Show fewer</button>`;
      }
      html += "</section>";
    }
    if (!groups.length) html = `<p class="nav-empty">No chats match "${e(this._navQuery)}".</p>`;
    if (html === this._navHtml) return;
    this._navHtml = html;
    // Keep the keyboard where it was across a redraw (the working dots redraw the list often).
    const focused = el.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused?.dataset?.key || null;
    const focusGroup = focused?.classList?.contains("nav-group-head") ? focused.dataset.group : null;
    el.innerHTML = html;
    if (focusKey) el.querySelector(`.nav-row[data-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true });
    else if (focusGroup) el.querySelector(`.nav-group-head[data-group="${CSS.escape(focusGroup)}"]`)?.focus({ preventScroll: true });
  },

  /** Sidebar/topbar name for a channel (js/chat-core.js chatName). */
  displayNameFor(ch) {
    return Core.chatName(ch);
  },

  // --- Addresses ---
  _initRouter() {
    window.addEventListener("popstate", () => this.route(location.pathname, { push: false }));
  },

  /**
   * Open what an address asks for: /chat/<id> that chat, /chat/new a new one, "/" the chat this device had open
   * last (else the Main Session). push: false when it came from Back or Forward (the address is already there).
   */
  route(pathname, { push = false, replace = false } = {}) {
    if (pathname === "/usage" && typeof Usage !== "undefined") return Usage.open({ push: false });
    if (typeof Usage !== "undefined" && Usage.isOpen) Usage.close();
    const r = Core.parseChatPath(pathname);
    if (r.kind === "chat") return this.openChat(r.id, { push, replace });
    if (r.kind === "new") return this.newChat({ push, replace });
    let saved = null;
    try { saved = localStorage.getItem("tarsee_last_channel"); } catch { /* ignore */ }
    const ch = (saved && this.channels.find((c) => c.key === saved)) || this.channels.find((c) => c.key === "web:default");
    if (ch) return this.openChannel(ch.key, ch.conversationId, { push: false, replace: true });
    return this.openChannel("web:default", null, { push: false, replace: true });
  },

  /** Put the open chat's address in the address bar (and in history when it is a move from one chat to another). */
  _setAddress(path, { push = true, replace = false } = {}) {
    if (!path || typeof history === "undefined") return;
    const state = { convId: this.currentConversationId, key: this.currentChannelKey };
    if (location.pathname === path) { if (replace) history.replaceState(state, "", path); return; }
    if (push && !replace) history.pushState(state, "", path);
    else history.replaceState(state, "", path);
  },

  /** A chat by its conversation id (from an address): its channel if it has one, a background job's view, or the conversation alone. */
  async openChat(id, opts = {}) {
    if (/^(cron:|heartbeat$|boot$)/.test(id) && this.liveOn()) {
      Live.openBackground(id);
      this._setAddress(Core.chatPath(id), opts);
      return;
    }
    const ch = this.channels.find((c) => c.conversationId === id);
    if (ch) return this.openChannel(ch.key, id, opts);
    // Not a channel's (an older conversation, or one made by the API): open it as it is.
    return this.openChannel(null, id, opts);
  },

  /** A new chat on the web: nothing on the server until the first message, which makes it (and its address). */
  newChat({ push = true, replace = false } = {}) {
    if (typeof Settings !== "undefined" && Settings.isOpen) Settings.close();
    if (typeof Usage !== "undefined" && Usage.isOpen) Usage.close();
    if (this.liveOn() && Live.convId) Live.detach();
    const rnd = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`).replace(/-/g, "").slice(0, 12);
    this.currentChannelKey = `web:${rnd}`;
    this.currentConversationId = null;
    this._lastUsage = null;
    this._lastContextTokens = null;
    this._currentName = "New chat";
    this.elements.chatArea.innerHTML = "";
    this.lastMessageRole = null;
    this.elements.chatArea.style.display = "none";
    this.elements.welcomeScreen.style.display = "";
    this.elements.inputArea.style.display = "block";
    document.getElementById("appScreen")?.classList.add("is-new-chat");
    this._paintHeader();
    this.updateSessionBar();
    this.renderChannelList();
    this._setAddress("/chat/new", { push, replace });
    this._closeDrawer();
    if (this.liveOn()) Live.attach(null, null);
    if (window.matchMedia?.("(pointer: fine)").matches) this.elements.messageInput.focus();
  },

  /** The server made the conversation for the chat on screen (its first message): it gets its own address now. */
  onConversationCreated(convId) {
    if (!convId) return;
    // What was picked before the first message is this chat's own now.
    const pending = this._pickConv === null && (this._pick.model || this._pick.effort || this._pick.provider) ? ModelPickerCore.pickChange(null, this._pick) : null;
    this._pickConv = convId;
    if (pending) API.json(`/api/chat/conversations/${encodeURIComponent(convId)}/picker`, { method: "PUT", body: pending }).catch(() => {});
    document.getElementById("appScreen")?.classList.remove("is-new-chat");
    this._setAddress(Core.chatPath(convId), { replace: true });
  },

  /** The topbar's name and where the chat lives, and the tab's title. */
  _paintHeader() {
    const ch = this.channels.find((c) => (this.currentConversationId && c.conversationId === this.currentConversationId) || (!this.currentConversationId && c.key === this.currentChannelKey));
    let name = this._currentName || this.botName;
    if (ch) name = Core.chatName(ch);
    else if (this.currentChannelKey === "web:default") name = "Main Session";
    this._currentName = name;
    if (!(typeof Settings !== "undefined" && Settings.isOpen) && !(typeof Usage !== "undefined" && Usage.isOpen)) this.elements.topbarTitle.textContent = name;
    const platform = ch?.platform || String(this.currentChannelKey || "").split(":")[0];
    // Where it lives, beside the name (not for the web's own chats, nor when the name already says it).
    const label = platform && platform !== "web" && platform !== "live" ? Core.groupOf(platform).label : "";
    const where = label && !name.toLowerCase().includes(label.toLowerCase()) ? label : "";
    if (this.elements.topbarWhere) this.elements.topbarWhere.textContent = where;
    this._paintTitle();
  },

  _paintTitle() {
    if (typeof document === "undefined") return;
    const settingsOpen = typeof Settings !== "undefined" && Settings.isOpen;
    const usageOpen = typeof Usage !== "undefined" && Usage.isOpen;
    document.title = Core.pageTitle(settingsOpen ? "Settings" : usageOpen ? "Usage" : this._currentName, this.botName);
  },

  async openChannel(channelKey, conversationId, { push = true, replace = false } = {}) {
    // Close settings (or the Usage page) if open
    if (typeof Settings !== "undefined" && Settings.isOpen) {
      Settings.close();
    }
    if (typeof Usage !== "undefined" && Usage.isOpen) Usage.close();

    if (this.liveOn() && Live.convId && Live.convId !== conversationId) Live.detach();
    this.currentChannelKey = channelKey || null;
    this.currentConversationId = conversationId || null;
    if (channelKey) { try { localStorage.setItem("tarsee_last_channel", channelKey); } catch { /* ignore */ } }
    // Switching channels invalidates the prior turn's token telemetry —
    // reset so the meter reflects the new conversation's state, not stale
    // numbers from whichever channel we just left.
    this._lastUsage = null;
    this._lastContextTokens = null;
    this._turnModel = null;
    this._overflowBannerDismissed = false;
    this.hideContextWarningBanner();
    document.getElementById("contextOverflowCard")?.remove();
    document.getElementById("appScreen")?.classList.remove("is-new-chat");
    this.elements.welcomeScreen.style.display = "none";
    this.elements.chatArea.style.display = "flex";
    this.elements.inputArea.style.display = "block";
    this._currentName = null;
    this._paintHeader();
    this._setAddress(conversationId ? Core.chatPath(conversationId) : "/", { push, replace });
    this._closeDrawer();

    // Load messages (last 50 for speed, load more on demand)
    if (conversationId) {
      try {
        const data = await API.getConversation(conversationId);
        // Switched again while this loaded: don't paint the old one.
        if (this.currentConversationId !== conversationId) return;
        if (!channelKey && data?.title) { this._currentName = String(data.title); this._paintHeader(); }
        const total = data.totalMessages || data.messages?.length || 0;
        const older = total - (data.messages?.length || 0);
        this.renderMessages(data.messages || [], older > 0 ? older : 0, conversationId, data.leadFiles);
        if (!(data.messages || []).length) this._showEmptyChat();
        // Session recap — if the server flagged this convo as stale, show
        // a dismissible card above the first message summarizing what was
        // going on. Null means "recently active, no recap needed".
        if (data.recap?.text) {
          this.renderSessionRecap(data.recap);
        }
        if (this.liveOn()) Live.attach(conversationId, data);
        else this._drainQueueIfIdle();
      } catch (err) {
        if (this.currentConversationId !== conversationId) return;
        this.elements.chatArea.innerHTML = "";
        const note = document.createElement("div");
        note.className = "live-note";
        note.textContent = /not found|404/i.test(String(err?.message))
          ? "There is no chat at this address. It may have been deleted. Start a new chat from the menu."
          : "Couldn't load this conversation. Check the connection and open it again.";
        this.elements.chatArea.appendChild(note);
      }
    } else {
      this.elements.chatArea.innerHTML = "";
      this._showEmptyChat();
      if (this.liveOn()) Live.attach(null, null);
    }

    this.updateSessionBar();
    this.renderChannelList();
    // Phones: focusing pops the keyboard over the chat on every open/reload.
    if (window.matchMedia?.("(pointer: fine)").matches) this.elements.messageInput.focus();
  },

  /** A chat with nothing in it yet: the welcome in its place (the composer stays). */
  _showEmptyChat() {
    if (this.elements.chatArea.querySelector(".message")) return;
    this.elements.chatArea.style.display = "none";
    this.elements.welcomeScreen.style.display = "";
  },

  /** The chat's menu, from its name in the topbar: rename it, start a fresh session, delete it (our own menu). */
  _initChatMenu() {
    const btn = this.elements.chatMenuBtn;
    if (!btn) return;
    let menu = null;
    const close = (focusBack = false) => {
      if (!menu) return;
      menu.remove();
      menu = null;
      btn.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", away, true);
      if (focusBack) btn.focus();
    };
    const away = (e) => { if (menu && !menu.contains(e.target) && !btn.contains(e.target)) close(); };
    const open = () => {
      const id = this.currentConversationId;
      const items = [
        { act: "rename", label: "Rename", off: !id },
        { act: "fresh", label: "Start a fresh session", off: !id },
        { act: "usage", label: "This chat's usage", off: !id },
        { act: "delete", label: "Delete chat", off: !id, danger: true },
      ];
      menu = document.createElement("div");
      menu.className = "chat-menu";
      menu.setAttribute("role", "menu");
      menu.innerHTML = (id ? '<div class="chat-menu-usage-slot"></div>' : "")
        + items.map((it) => `<button type="button" role="menuitem" class="chat-menu-item${it.danger ? " is-danger" : ""}" data-act="${it.act}"${it.off ? " disabled" : ""}>${escapeHtml(it.label)}</button>`).join("")
        + (id ? "" : '<p class="chat-menu-note">These come once the chat has its first message.</p>');
      // The chat's running total (js/usage.js), at the top once it is added up.
      if (id && typeof Usage !== "undefined") {
        Usage.chatData(id).then((data) => {
          const slot = menu?.querySelector(".chat-menu-usage-slot");
          if (slot && this.currentConversationId === id) slot.innerHTML = Usage.menuBlock(data);
        });
      }
      document.body.appendChild(menu);
      const r = btn.getBoundingClientRect();
      menu.style.top = `${Math.round(r.bottom + 6)}px`;
      menu.style.left = `${Math.round(Math.max(8, Math.min(r.left, window.innerWidth - menu.offsetWidth - 8)))}px`;
      btn.setAttribute("aria-expanded", "true");
      menu.querySelector(".chat-menu-item:not([disabled])")?.focus();
      document.addEventListener("pointerdown", away, true);
      menu.addEventListener("keydown", (e) => {
        const all = [...menu.querySelectorAll(".chat-menu-item:not([disabled])")];
        const i = all.indexOf(document.activeElement);
        if (e.key === "Escape") { e.preventDefault(); close(true); }
        else if (e.key === "ArrowDown") { e.preventDefault(); all[(i + 1) % all.length]?.focus(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); all[(i - 1 + all.length) % all.length]?.focus(); }
        else if (e.key === "Tab") close();
      });
      menu.addEventListener("click", (e) => {
        const item = e.target.closest(".chat-menu-item");
        if (!item || item.disabled) return;
        close();
        if (item.dataset.act === "rename") this.renameChat();
        else if (item.dataset.act === "fresh") this.resetSession();
        else if (item.dataset.act === "usage" && typeof Usage !== "undefined") Usage.open({ conversationId: this.currentConversationId });
        else if (item.dataset.act === "delete") this.showDeleteModal(this._currentName || "this chat", this.currentConversationId, this.currentChannelKey);
      });
    };
    btn.addEventListener("click", () => (menu ? close() : open()));
  },

  async renameChat() {
    const id = this.currentConversationId;
    if (!id) return;
    const name = await TarseeDialog.askText({ title: "Rename this chat", label: "Name", value: this._currentName || "", yes: "Rename", no: "Cancel" });
    if (name == null || !String(name).trim() || this.currentConversationId !== id) return;
    try {
      await API.updateConversation(id, { title: String(name).trim().slice(0, 120) });
      this._currentName = String(name).trim();
      await this.loadChannels();
      this._paintHeader();
    } catch (err) {
      App.showToast(`Could not rename it: ${err.message}`, "error");
    }
  },

  /** The agent starts this chat with a clean context; the messages stay. */
  async resetSession() {
    // (The conversation shown when it was asked is the one reset, whatever the page did meanwhile.)
    const id = this.currentConversationId;
    if (!id) return;
    if (!(await TarseeDialog.ask({ title: "Start a fresh session?", text: `Messages stay, but ${this.botName} starts this chat with a clean context and won't recall the earlier back-and-forth.`, yes: "Start fresh", no: "Cancel" }))) return;
    try {
      await API.json(`/api/chat/conversations/${id}/reset-session`, { method: "POST" });
      App.showToast("Fresh session started", "success");
    } catch (err) {
      App.showToast(`Could not reset it: ${err.message}`, "error");
    }
  },

  // --- Messages ---
  renderMessages(messages, olderCount = 0, conversationId = null, leadFiles = null) {
    this.elements.chatArea.innerHTML = "";
    this.lastMessageRole = null;
    this.lastMessageTime = 0;

    // Show "load more" button if there are older messages on the server
    if (olderCount > 0 && conversationId) {
      const loadMoreBtn = document.createElement("button");
      loadMoreBtn.type = "button";
      loadMoreBtn.className = "load-more-btn";
      loadMoreBtn.textContent = `Show ${olderCount} older message${olderCount === 1 ? "" : "s"}`;
      loadMoreBtn.addEventListener("click", async () => {
        loadMoreBtn.textContent = "Loading…";
        try {
          const data = await API.json(`/api/chat/conversations/${conversationId}?all=true`);
          const allMsgs = data.messages || [];
          const scrollPos = this.elements.chatArea.scrollHeight;
          loadMoreBtn.remove();
          const olderMsgs = allMsgs.slice(0, allMsgs.length - messages.length);
          const frag = document.createDocumentFragment();
          const tempLastRole = this.lastMessageRole;
          const tempLastTime = this.lastMessageTime;
          this.lastMessageRole = null;
          this.lastMessageTime = 0;
          if (data.leadFiles?.length) frag.appendChild(this.fileRowEl(this._keptFiles(data.leadFiles)));
          for (const msg of olderMsgs) this._appendMessage(frag, msg, conversationId);
          this.elements.chatArea.insertBefore(frag, this.elements.chatArea.firstChild);
          this.lastMessageRole = tempLastRole;
          this.lastMessageTime = tempLastTime;
          this.elements.chatArea.scrollTop = this.elements.chatArea.scrollHeight - scrollPos;
          if (typeof Usage !== "undefined") Usage.decorate(conversationId);
        } catch {
          loadMoreBtn.textContent = "Couldn't load them. Try again";
        }
      });
      this.elements.chatArea.appendChild(loadMoreBtn);
    }

    if (leadFiles?.length && !olderCount) this.elements.chatArea.appendChild(this.fileRowEl(this._keptFiles(leadFiles)));
    for (const msg of messages) this._appendMessage(this.elements.chatArea, msg, conversationId);
    // Queued-but-unsent messages are not on the server yet: draw them again.
    this._renderQueuedBubbles();
    this.scrollToBottom(true);
    // Each reply's tokens and speed, in a quiet line under it (js/usage.js).
    if (conversationId && typeof Usage !== "undefined") Usage.decorate(conversationId);
  },

  /** A saved message, with its tools (history comes slim: names and summaries; the details are fetched when opened), and its files. */
  _messageEl(msg, conversationId) {
    const el = this._createMessageEl(msg.role, msg.content, { tools: msg.tools, messageId: msg.id, convId: conversationId, files: this._keptFiles(msg.files) });
    if (msg.id) el.dataset.messageId = msg.id;
    return el;
  },

  /**
   * A saved message and the files that come right after it as a row of their own (src/lib/chat-files.js placeFiles:
   * the agent's, sent here from another chat or with no reply after them), into a fragment or the chat.
   */
  _appendMessage(into, msg, conversationId) {
    into.appendChild(this._messageEl(msg, conversationId));
    if (msg.filesAfter?.length) into.appendChild(this.fileRowEl(this._keptFiles(msg.filesAfter)));
  },

  /**
   * One message. Yours: a bubble on the right (with who sent it in a channel, "[alice]: words"). The agent's: its words
   * across the reading column, the steps it took folded into one line above them, Copy under them.
   *   options { tools (the slim list), messageId, convId (for the steps' details), streaming }
   */
  _createMessageEl(role, content, options = {}) {
    const opts = typeof options === "boolean" ? { streaming: options } : (options || {});
    const msg = document.createElement("div");
    const now = Date.now();
    const isGrouped = (role === this.lastMessageRole) && (now - this.lastMessageTime < 5 * 60 * 1000);
    msg.className = `message ${role === "user" ? "user" : "assistant"}${isGrouped ? " grouped" : ""}`;
    const body = document.createElement("div");
    body.className = "message-content";
    msg.appendChild(body);
    if (role === "user") {
      const { who, body: said } = Core.sender(content);
      if (who) {
        const w = document.createElement("div");
        w.className = "message-who";
        w.textContent = who;
        body.appendChild(w);
      }
      // The files a channel saved with it come as notes in its words ("[Attached file saved: ...]"): cards instead.
      const noted = typeof ChatFiles !== "undefined" ? ChatFiles.split(said) : { text: said, files: [] };
      const files = [...noted.files, ...(opts.files || []).filter((f) => !noted.files.some((n) => n.path === f.path))];
      // "(sent a file: x)", what is saved for a message that was only files, says nothing the card does not.
      const words = files.length && /^\(sent (?:a file: .*|\d+ files)\)$/.test(noted.text.trim()) ? "" : noted.text;
      if (words || !files.length) {
        const text = document.createElement("div");
        text.className = "message-text message-bubble";
        text.innerHTML = this.renderMarkdown(words || said);
        body.appendChild(text);
      }
      if (files.length) this.filesIntoMessage(msg, "user", files);
    } else {
      const parts = Core.replyParts(content, opts.tools);
      if (parts.tools.length || parts.notes.length) {
        const lazy = opts.messageId && opts.convId && parts.tools.some((t) => !t.input && !t.output)
          ? () => API.json(`/api/chat/conversations/${encodeURIComponent(opts.convId)}/messages/${encodeURIComponent(opts.messageId)}/tools`).then((d) => d.tools || [])
          : null;
        const steps = this.createSteps({ state: "done", items: parts.steps, lazy });
        body.appendChild(steps.el);
        msg._steps = steps;
      }
      const text = document.createElement("div");
      text.className = "message-text";
      text.innerHTML = this.renderMarkdown(parts.answer);
      body.appendChild(text);
      body.appendChild(this._actionsEl(!!opts.streaming));
      if (opts.files?.length) this.filesIntoMessage(msg, "assistant", opts.files);   // (above its words: "attached above")
    }
    this.lastMessageRole = role;
    this.lastMessageTime = now;
    return msg;
  },

  /** The quiet row under an answer: Copy. */
  _actionsEl(hidden = false) {
    const row = document.createElement("div");
    row.className = "message-actions";
    if (hidden) row.hidden = true;
    row.innerHTML = '<button type="button" class="msg-copy-btn" title="Copy" aria-label="Copy this answer"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M11 5V3.5A1.5 1.5 0 009.5 2h-6A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5" stroke="currentColor" stroke-width="1.3"/></svg></button>';
    return row;
  },

  /** An answer's words into its message (a live reply, or a streamed one when it is done). */
  setAnswer(msgEl, content, { tools = null } = {}) {
    const parts = Core.replyParts(content, tools);
    const text = msgEl.querySelector(".message-text");
    if (text) text.innerHTML = this.renderMarkdown(parts.answer);
    // A reply that came without its turn being watched (a reload mid-way): its own steps, if it saved any.
    if (!msgEl._steps && (parts.tools.length || parts.notes.length)) {
      const steps = this.createSteps({ state: "done", items: parts.steps });
      msgEl.querySelector(".message-content")?.prepend(steps.el);
      msgEl._steps = steps;
    }
    const actions = msgEl.querySelector(".message-actions");
    if (actions) actions.hidden = !String(parts.answer || "").trim();
    msgEl.classList.toggle("has-answer", !!String(parts.answer || "").trim());
    return parts;
  },

  /**
   * The steps of a turn, in the answer's place: one quiet line ("Working · 3 steps · Reading README.md" while it
   * works, "Used 12 tools" after), that opens to the list of steps, each one line ("Read README.md") that opens to
   * its input and output in a box that scrolls. Collapsed by default. js/live.js feeds it as the turn goes; history
   * draws it done.
   *   options { state: "queued" | "running" | "done", startedAt, tools: [{ name, summary, input, output, ok, todos }],
   *             notes: [text], lazy: () => Promise<[tools]> (the details of a saved reply's steps, fetched once),
   *             onStop: () => void (a Stop button while it runs) }
   * "queued": waiting behind the turn still running in this chat, "Queued · after the reply above", no timer and no
   * tokens; begin(at) makes it the working line when the turn really begins.
   * The line always opens, even before the first step: to what it thought (a summary, for a turn sent from the
   * dashboard), why it waits (an API retry, compacting), or a word that nothing has happened yet.
   * setModel(name, streaming) names the AI answering ("Thinking with DeepSeek Flash"); one that sends its reply only
   * when each step finishes (a Codex model: streaming false) gets a note under the line while it works.
   */
  createSteps({ state = "running", startedAt = Date.now(), tools = [], notes = [], items = null, lazy = null, onStop = null } = {}) {
    const el = document.createElement("div");
    el.className = "steps";
    el.innerHTML = '<div class="steps-head"><button type="button" class="steps-line" aria-expanded="false">'
      + '<span class="steps-dot" aria-hidden="true"></span><span class="steps-title"></span><span class="steps-detail"></span>'
      + '<span class="steps-usage"></span><span class="steps-time"></span>'
      + '<svg class="steps-caret" width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      + '</button></div><p class="steps-hint" hidden></p><div class="steps-list" hidden></div>';
    const line = el.querySelector(".steps-line");
    const list = el.querySelector(".steps-list");
    const hint = el.querySelector(".steps-hint");
    hint.textContent = "This AI sends its reply when each step finishes; tools still appear as they start.";
    // What the list says while it has nothing in it yet (it opens all the same).
    const empty = document.createElement("p");
    empty.className = "steps-empty";
    list.appendChild(empty);
    const s = {
      el, state, startedAt, endedAt: null, error: null, rows: new Map(), order: [], notes: 0, last: "", lazy, loaded: null,
      model: null, streaming: true,
    };
    const setOpen = (open) => {
      list.hidden = !open;
      line.setAttribute("aria-expanded", String(open));
      el.classList.toggle("is-open", open);
    };
    line.addEventListener("click", () => setOpen(list.hidden));
    /** The Stop beside the line (null: none). A queued line's takes that message out of the queue, nothing else. */
    s.setStop = (fn) => {
      s.stopBtn?.remove();
      s.stopBtn = null;
      if (!fn) return;
      const stop = document.createElement("button");
      stop.type = "button";
      stop.className = "steps-stop";
      stop.textContent = "Stop";
      stop.title = s.state === "queued" ? "Take this message out of the queue" : "Stop (Esc)";
      stop.addEventListener("click", () => fn());
      el.querySelector(".steps-head").appendChild(stop);
      s.stopBtn = stop;
    };
    s.setStop(onStop);

    const toolCount = () => s.order.filter((k) => s.rows.get(k)?.kind === "tool").length;
    const failedCount = () => s.order.filter((k) => s.rows.get(k)?.ok === false).length;

    s.paint = () => {
      const now = Date.now();
      const ms = (s.endedAt || now) - (s.startedAt || now);
      const n = toolCount();
      const tl = Core.turnLine({ state: s.state, tools: n, failed: failedCount(), ms: s.state === "running" || s.startedAt ? ms : null, last: s.last, error: s.error, model: s.model });
      let title = tl.title;
      let detail = tl.detail;
      if (s.state === "done" && !n && s.notes) { title = "Thought process"; detail = ""; }
      if (s.state === "done" && !s.startedAt) detail = failedCount() ? `${failedCount()} failed` : "";
      el.querySelector(".steps-title").textContent = title;
      el.querySelector(".steps-detail").textContent = detail;
      el.querySelector(".steps-time").textContent = s.state === "running" ? Core.fmtDur(ms) : "";
      el.querySelector(".steps-usage").textContent = s.state === "running" && s.usage && typeof UsageCore !== "undefined" ? UsageCore.liveLine(s.usage) : "";
      el.dataset.state = s.state;
      el.dataset.tone = tl.tone;
      el.hidden = s.state === "done" && !n && !s.notes;
      hint.hidden = !(s.state === "running" && s.streaming === false);
      empty.hidden = s.order.length > 0;
      empty.textContent = s.state === "queued"
        ? "Waiting for the reply above to finish. It starts right after."
        : s.state === "running"
          ? `Nothing to show yet: ${Chat.botName || "Tarsee"} is thinking. Each step shows here as it happens.`
          : "It ended before any step.";
      for (const k of s.order) {
        const r = s.rows.get(k);
        if (r.kind === "tool" && !r.endedAt && r.startedAt && s.state === "running") r.time.textContent = Core.fmtDur(now - r.startedAt);
      }
    };

    /** The body of a step (its input and output), drawn when it is first opened. */
    const fillBody = (r) => {
      const b = r.body;
      b.replaceChildren();
      if (Array.isArray(r.todos) && r.todos.length) {
        const ul = document.createElement("ul");
        ul.className = "step-todos";
        for (const t of r.todos) {
          const li = document.createElement("li");
          li.className = `step-todo is-${t.status === "completed" ? "done" : t.status === "in_progress" ? "now" : "todo"}`;
          li.textContent = t.status === "in_progress" ? (t.activeForm || t.content) : t.content;
          ul.appendChild(li);
        }
        b.appendChild(ul);
        return;
      }
      const box = (label, text) => {
        const wrap = document.createElement("div");
        wrap.className = "step-io";
        const l = document.createElement("div");
        l.className = "step-io-label";
        l.textContent = label;
        const pre = document.createElement("pre");
        pre.className = "step-pre";
        pre.textContent = text;
        wrap.append(l, pre);
        b.appendChild(wrap);
      };
      if (r.input) box("Input", r.input);
      if (r.output) box(r.ok === false ? "Error" : "Output", r.output);
      if (!r.input && !r.output) {
        const p = document.createElement("p");
        p.className = "step-none";
        p.textContent = r.kind === "tool" && !r.endedAt && s.state === "running" ? "Still running." : "No details were kept for this step.";
        b.appendChild(p);
      }
    };

    const openRow = async (r) => {
      const opening = r.body.hidden;
      r.body.hidden = !opening;
      r.line.setAttribute("aria-expanded", String(opening));
      r.el.classList.toggle("is-open", opening);
      if (!opening) return;
      if (!r.input && !r.output && s.lazy && !r.todos) {
        r.body.innerHTML = '<p class="step-none">Loading…</p>';
        try {
          s.loaded ||= s.lazy();
          const got = await s.loaded;
          let i = 0;
          for (const k of s.order) {
            const row = s.rows.get(k);
            if (row.kind !== "tool") continue;
            const t = got[i++];
            if (t && !row.input && !row.output) { row.input = t.input || ""; row.output = t.output || ""; if (t.ok === false) row.ok = false; }
          }
        } catch { s.loaded = null; }
      }
      fillBody(r);
    };

    /** A tool step: { id, name, summary, input, output, ok, todos, startedAt, endedAt }. */
    s.addTool = (t) => {
      const key = t.id || `t${s.order.length}`;
      if (s.rows.has(key)) return s.rows.get(key);
      const rowEl = document.createElement("div");
      rowEl.className = "step";
      rowEl.innerHTML = '<button type="button" class="step-line" aria-expanded="false"><span class="step-dot" aria-hidden="true"></span>'
        + '<span class="step-label"></span><span class="step-time"></span></button><div class="step-body" hidden></div>';
      const r = {
        kind: "tool", key, el: rowEl, line: rowEl.querySelector(".step-line"), body: rowEl.querySelector(".step-body"), time: rowEl.querySelector(".step-time"),
        name: t.name, summary: t.summary || "", input: t.input || "", output: t.output || "", ok: t.ok, todos: t.todos || null,
        startedAt: t.startedAt || null, endedAt: t.endedAt || (s.state === "running" ? null : Date.now()),
      };
      const label = Core.stepLabel({ name: t.name, summary: t.summary, input: t.input }, { running: s.state === "running" && !t.endedAt });
      rowEl.querySelector(".step-label").textContent = label;
      r.line.title = `${t.name}${t.summary ? `: ${t.summary}` : ""}`;
      rowEl.dataset.state = s.state === "running" && !t.endedAt ? "running" : t.ok === false ? "failed" : "done";
      r.line.addEventListener("click", () => openRow(r));
      s.rows.set(key, r);
      s.order.push(key);
      list.appendChild(rowEl);
      if (s.state === "running") s.last = Core.stepLabel({ name: t.name, summary: t.summary, input: t.input }, { running: true });
      s.paint();
      return r;
    };

    /** A tool finished: { ok, output, endedAt }. */
    s.endTool = (id, { ok = true, output = "", endedAt = Date.now() } = {}) => {
      const r = s.rows.get(id);
      if (!r || r.endedAt) return;
      r.endedAt = endedAt;
      r.ok = ok;
      if (output) r.output = output;
      r.el.dataset.state = ok === false ? "failed" : "done";
      r.el.querySelector(".step-label").textContent = Core.stepLabel({ name: r.name, summary: r.summary, input: r.input }, { running: false });
      if (r.startedAt) r.time.textContent = Core.fmtDur(endedAt - r.startedAt);
      if (!r.body.hidden) fillBody(r);
      // Nothing running now: back to "Thinking with …" until the next step.
      if (s.order.every((k) => s.rows.get(k).kind !== "tool" || s.rows.get(k).endedAt)) s.last = "";
      s.paint();
    };

    /** What it said on the way (a text step that is not the answer). */
    s.addNote = (text, key = null) => {
      if (!String(text || "").trim()) return null;
      const k = key || `n${s.order.length}`;
      const n = document.createElement("div");
      n.className = "step-note";
      n.innerHTML = Chat.renderMarkdown(text);
      n.dataset.text = String(text).slice(0, 400);
      s.rows.set(k, { kind: "note", key: k, el: n });
      s.order.push(k);
      list.appendChild(n);
      s.notes += 1;
      s.paint();
      return n;
    };

    /** What it thought (a summary of a thinking block): a quiet paragraph that counts as a note. */
    s.addThought = (text) => {
      if (!String(text || "").trim()) return null;
      const k = `th${s.order.length}`;
      const n = document.createElement("div");
      n.className = "step-note step-thought";
      const label = document.createElement("div");
      label.className = "step-thought-label";
      label.textContent = "Thought";
      const body = document.createElement("div");
      body.className = "step-thought-text";
      body.innerHTML = Chat.renderMarkdown(text);
      n.append(label, body);
      s.rows.set(k, { kind: "thought", key: k, el: n });
      s.order.push(k);
      list.appendChild(n);
      s.notes += 1;
      if (s.state === "running") s.last = "";
      s.paint();
      return n;
    };

    /** Why it is waiting (an API error it retries, compacting): one muted line. */
    s.addStatus = (text) => {
      if (!String(text || "").trim()) return null;
      const k = `st${s.order.length}`;
      const n = document.createElement("div");
      n.className = "step-status";
      n.textContent = text;
      s.rows.set(k, { kind: "status", key: k, el: n });
      s.order.push(k);
      list.appendChild(n);
      if (s.state === "running") s.last = s.statusLast = String(text).split(". ")[0].slice(0, 80);
      s.paint();
      return n;
    };

    /** The turn's tokens so far ({ total, nowTps, outTps, ... } from a usage step), for the working line. */
    s.setUsage = (u) => {
      s.usage = u || null;
      // A model call going again after a retry: the line goes back from the retry's words to "Thinking with …".
      if (s.statusLast && s.last === s.statusLast) s.last = "";
      s.statusLast = null;
      s.paint();
    };

    /**
     * The AI answering: its model's name for the line, and whether its words come as they are written (false: a
     * Codex model, whose reply comes when each step finishes). Called again when a backup takes over.
     */
    s.setModel = (name, streaming) => {
      s.model = String(name || "").trim() || null;
      s.streaming = streaming !== false;
      s.paint();
    };

    /** The queued turn really began: the working line from now on (its timer starts here, not at the send). */
    s.begin = (at = Date.now()) => {
      if (s.state !== "queued") return;
      s.state = "running";
      s.startedAt = at;
      if (s.stopBtn) s.stopBtn.title = "Stop (Esc)";
      s.paint();
    };

    /** Drop the notes that are the answer itself (it is shown under the line). */
    s.trimNotes = (answer) => {
      const norm = (x) => Core.plainWords(x);
      const said = norm(answer);
      for (const k of [...s.order].reverse()) {
        const r = s.rows.get(k);
        if (r.kind !== "note") break;
        const t = norm(r.el.dataset.text).slice(0, 200);
        if (!t || !said.includes(t)) break;
        r.el.remove();
        s.rows.delete(k);
        s.order.splice(s.order.indexOf(k), 1);
        s.notes -= 1;
      }
      s.paint();
    };

    /** The turn ended: { state: "done" | "stopped" | "failed" | "interrupted", endedAt, error }. */
    s.finish = ({ state: end = "done", endedAt = Date.now(), error = null } = {}) => {
      s.state = end;
      s.endedAt = endedAt;
      s.error = error;
      for (const k of s.order) {
        const r = s.rows.get(k);
        if (r.kind === "tool" && !r.endedAt) {
          r.endedAt = endedAt;
          r.el.dataset.state = end === "done" ? "done" : "stopped";
          r.el.querySelector(".step-label").textContent = Core.stepLabel({ name: r.name, summary: r.summary, input: r.input }, { running: false });
        }
      }
      s.stopBtn?.remove();
      s.paint();
    };

    s.count = toolCount;
    s.setOpen = setOpen;
    // In the order they happened (items), or the tools then the notes.
    const ordered = Array.isArray(items) ? items : [...(tools || []).map((t) => ({ type: "tool", ...t })), ...(notes || []).map((text) => ({ type: "note", text }))];
    for (const it of ordered) {
      if (it.type === "note") s.addNote(it.text);
      else s.addTool({ ...it, endedAt: it.endedAt || (state === "running" ? null : 1) });
    }
    if (state !== "running") s.startedAt = null;
    s.paint();
    return s;
  },

  /**
   * Render the session-recap card above the first message when a stale
   * conversation is resumed. Dismissible: hides for the rest of this
   * device's viewing session.
   */
  renderSessionRecap(recap) {
    if (!recap?.text) return;
    const chatArea = this.elements.chatArea;
    if (!chatArea) return;
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
    chatArea.insertBefore(card, chatArea.firstChild);
  },

  appendMessage(role, content, isStreaming = false) {
    const msg = this._createMessageEl(role, content, { streaming: isStreaming });
    if (this.elements.welcomeScreen.style.display !== "none") {
      this.elements.welcomeScreen.style.display = "none";
      this.elements.chatArea.style.display = "flex";
    }
    this.elements.chatArea.appendChild(msg);
    this.scrollToBottom();
    return msg;
  },

  finishStreaming(msgEl) {
    msgEl.querySelector(".chat-thinking")?.remove();
    msgEl.querySelector(".message-text")?.classList.remove("streaming-cursor");
    const actions = msgEl.querySelector(".message-actions");
    if (actions) actions.hidden = !msgEl.querySelector(".message-text")?.textContent.trim();
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

    // Click previews to open them in the viewer
    container.querySelectorAll(".chat-attachment-thumb").forEach((thumb, i) => {
      thumb.style.cursor = "pointer";
      thumb.addEventListener("click", (e) => {
        if (e.target.closest(".chat-attachment-remove")) return; // Don't trigger on X button
        this.previewPending(i);
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

  // --- Files in the chat (js/chat-files.js: the cards, and the viewer they open in) ---

  /**
   * Files into a message: a person's under their bubble, the agent's above its words (under the steps line), as Discord
   * shows them "attached above". Cards already there are not drawn twice (each kept file has its id).
   */
  filesIntoMessage(msgEl, role, files) {
    if (!msgEl || !files?.length || typeof ChatFiles === "undefined") return null;
    const body = msgEl.querySelector(".message-content");
    if (!body) return null;
    let row = body.querySelector(":scope > .chat-files");
    if (row) { ChatFiles.addCards(row, files); return row; }
    row = ChatFiles.cards(files);
    if (role === "user") {
      const after = body.querySelector(":scope > .message-text") || body.querySelector(":scope > .message-who");
      if (after) after.after(row); else body.prepend(row);
    } else {
      const words = body.querySelector(":scope > .message-text");
      if (words) body.insertBefore(row, words); else body.appendChild(row);
    }
    msgEl.classList.add("has-files");
    return row;
  },

  /** The agent's files as a row of their own (sent here from another chat, or with no reply after them). */
  fileRowEl(files) {
    const el = document.createElement("div");
    el.className = "message assistant files-row";
    const body = document.createElement("div");
    body.className = "message-content";
    el.appendChild(body);
    if (typeof ChatFiles !== "undefined") body.appendChild(ChatFiles.cards(files));
    this.lastMessageRole = "assistant";
    this.lastMessageTime = Date.now();
    return el;
  },

  /** Kept files from the history (src/lib/chat-files.js rows) as the cards want them. */
  _keptFiles(list) {
    return typeof ChatFiles === "undefined" ? [] : (list || []).map((f) => ChatFiles.fromServer(f));
  },

  /** A message's files drawn from what this browser sent (the composer's packed files), before the server has them. */
  showSentFiles(msgEl, attachments) {
    if (!msgEl || !attachments?.length) return;
    if (typeof ChatFiles !== "undefined") {
      const files = attachments.map((a) => ChatFiles.fromPacked(a)).filter(Boolean);
      if (files.length) {
        const bubble = msgEl.querySelector(".message-content > .message-text");
        if (bubble && !bubble.textContent.trim()) bubble.remove();   // (only files: no empty bubble over them)
        this.filesIntoMessage(msgEl, "user", files);
        msgEl.dataset.localFiles = "1";
        return;
      }
    }
    msgEl.querySelector(".message-text")?.insertAdjacentHTML("afterend", this.renderMessageAttachments(attachments));
  },

  /** A file in the composer, before it is sent: the viewer (a spreadsheet as its table, read here). */
  previewPending(i) {
    const file = this.pendingFiles[i];
    if (!file) return;
    if (typeof ChatFiles !== "undefined" && !/\.xlsx?$/i.test(file.name || "")) {
      ChatFiles.open(this.pendingFiles.map((f) => ChatFiles.fromLocal(f)), i);
      return;
    }
    this.previewFile(file);
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
        html += `<img src="${src}" alt="${escapeHtml(img.name)}" class="clickable-image" data-lightbox="1" style="cursor:pointer">`;
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
        html += `<div class="message-file-chip message-file-previewable" data-preview-idx="${dataIdx}" role="button" tabindex="0" title="Click to preview"><svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 1h5l4 4v9a1 1 0 01-1 1H4a1 1 0 01-1-1V2a1 1 0 011-1z" stroke="currentColor" stroke-width="1.2"/><path d="M9 1v4h4" stroke="currentColor" stroke-width="1.2"/></svg> ${escapeHtml(name)} <span style="color:var(--text-muted);font-size:10px">▸ preview</span></div>`;
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

    // A command with words in it that aren't the owner's asks first: a diagram's (the AI chose them), or words found in
    // the box that the page didn't put there. A command runs as the owner. Every way to send comes through here
    // (Enter, the Send button). A command the owner typed themselves, or a diagram's words that aren't one, sends at
    // once.
    const whose = text.startsWith("/") ? this._notOwnersIn() : null;
    if (whose && !(await this._askToRun(text, whose))) return;

    // Subtle tactile ack on touch devices (Android; iOS ignores).
    App.buzz?.(12);

    if (this.liveOn()) return this.sendLive(text, hasFiles);

    // A /stop typed while the reply streams goes now: in the queue it would wait behind that reply and only arrive once
    // the reply had ended. The server stops the reply, as the Stop button does, and says so.
    if (this.isStreaming && !hasFiles && /^\/stop(\s|$)/i.test(text)) return this.sendStopNow(text);

    // Queue if already streaming
    if (this.isStreaming) {
      const attachments = hasFiles ? await this.buildAttachments() : [];
      if (hasFiles) { this.pendingFiles = []; this.renderAttachmentsPreview(); }
      this._emptyBox();
      this.elements.sendBtn.disabled = true;

      this.messageQueue.push({ text, attachments, convId: this.currentConversationId });
      this._persistQueue();
      // Show queued message in chat with badge
      const queuedMsg = this.appendMessage("user", text);
      const badge = document.createElement("span");
      badge.className = "queue-badge";
      badge.textContent = `Queued #${this.messageQueue.length}`;
      queuedMsg.querySelector(".message-content")?.appendChild(badge);
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
    this._emptyBox();
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
    if (attachments.length) this.showSentFiles(userMsg, attachments);
    await this._streamReply(text, attachments);
  },

  /** A /stop typed while the reply streams (the old view): sent at once, beside that reply's stream, and its answer shown. */
  async sendStopNow(text) {
    this._emptyBox();
    this.appendMessage("user", text);
    let answer = "";
    await API.sendMessage(
      this.currentConversationId,
      text,
      (content) => { if (content) answer += content; },
      () => { if (answer) this.appendMessage("assistant", answer); },
      (error) => App.showToast(error, "error"),
      this.currentChannelKey || "web:default",
      undefined,
      undefined,
      // Its own request: the reply's stream is read on to its end, where the stop shows.
      { independent: true },
    );
  },

  /**
   * The reply to one message, read from its own stream (the old view, for when the live view is off:
   * localStorage.tarsee_live_off = "1"). The steps go in the answer's place as they come, the words under them.
   */
  async _streamReply(text, attachments) {
    const assistantMsg = this.appendMessage("assistant", "", true);
    const steps = this.createSteps({ state: "running", startedAt: Date.now(), onStop: () => this.stopGeneration() });
    assistantMsg.querySelector(".message-content")?.prepend(steps.el);
    assistantMsg._steps = steps;
    let fullResponse = "";
    let lastToolId = null;
    let raf = 0;
    const paintText = () => {
      raf = 0;
      const shown = fullResponse.split("|||PERSONALITY_COMPLETE|||")[0].replace(/\[REMEMBER:\s*.+?\]/gi, "").replace(/\n{3,}/g, "\n\n");
      const el = assistantMsg.querySelector(".message-text");
      if (el) el.innerHTML = this.renderMarkdown(shown);
      this.scrollToBottom();
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
          if (event?.type === "usage" || event?.type === "context_overflow" || event?.type === "model_selected") {
            // The AI answering (a backup that takes over sends it again): named on the working line.
            if (event.type === "model_selected") steps.setModel(event.label, event.streaming);
            this.handleTurnMeta(event);
            return;
          }
          if (event?.type === "thinking") return;
          if (event?.type === "tool_call") {
            const inp = event.input || {};
            lastToolId = event.id || `t${Date.now()}`;
            steps.addTool({
              id: lastToolId, name: event.name, startedAt: Date.now(),
              summary: inp.description || inp.file_path || inp.pattern || inp.url || inp.query || inp.command || "",
              input: event.name === "Bash" && inp.command ? inp.command : JSON.stringify(inp, null, 2),
              todos: Array.isArray(inp.todos) ? inp.todos : null,
            });
            this.scrollToBottom();
            return;
          }
          if (event?.type === "tool_result") {
            const id = event.id || lastToolId;
            if (id) steps.endTool(id, { ok: !/^error/i.test(String(event.result || "")), output: String(event.result || "").slice(0, 4000) });
            return;
          }
          if (!content) return;
          fullResponse += content;
          if (!raf) raf = requestAnimationFrame(paintText);
          if (typeof Setup !== "undefined") Setup.handleStreamingText(fullResponse);
        },
        // onDone
        (data) => {
          if (data?.type === "conversation") {
            if (data.conversationId && !this.currentConversationId) {
              this.currentConversationId = data.conversationId;
              this._streamingConvId = data.conversationId;
              this.onConversationCreated(data.conversationId);
            }
            return;
          }
          if (data?.type === "command") this.afterPickCommand(text);
          this.handleTurnDone(data);
          if (raf) { cancelAnimationFrame(raf); paintText(); }
          steps.finish({ state: data?.stopReason === "stopped" ? "stopped" : "done" });
          this.finishStreaming(assistantMsg);
          this.loadChannels();
          if (typeof Setup !== "undefined") Setup.handleStreamComplete(fullResponse);
        },
        // onError
        (error) => {
          steps.finish({ state: fullResponse ? "done" : "failed", error });
          this.finishStreaming(assistantMsg);
          App.showToast(error, "error");
        },
        this.currentChannelKey,
        attachments.length ? attachments : undefined,
        this.getEffort(),
        { model: this.getModel() },
      );
    } catch (err) {
      steps.finish({ state: "failed", error: err.message });
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
    this._drainQueueIfIdle();
  },

  liveOn() {
    return typeof Live !== "undefined" && Live.enabled;
  },

  /** Live send: draw the bubble now, the server queues and runs the turn. */
  async sendLive(text, hasFiles) {
    // /clear (and its aliases) really delete this conversation's messages
    // on the server, so ask first. /reset used to be a client-only fake.
    if (/^\/(clear|reset|new)\b/i.test(text)) {
      if (!(await TarseeDialog.ask({ title: "Clear this conversation?", text: "Its messages are deleted on the server (a summary is saved to memory first). This can't be undone.", yes: "Clear it", no: "Cancel", danger: true }))) return;
      text = text.replace(/^\/reset\b/i, "/clear");
    }
    let attachments = [];
    if (hasFiles) {
      attachments = await this.buildAttachments();
      this.pendingFiles = [];
      this.renderAttachmentsPreview();
    }
    this._emptyBox();
    this.elements.sendBtn.disabled = true;
    this.elements.welcomeScreen.style.display = "none";
    this.elements.chatArea.style.display = "flex";
    this.elements.inputArea.style.display = "block";
    if (!this.currentChannelKey) this.currentChannelKey = "web:default";
    Live.send(text, attachments);
    this.elements.messageInput.focus();
  },

  /** Per-turn telemetry from the send stream (both send paths). */
  handleTurnMeta(event) {
    if (event?.type === "usage") {
      // Live token telemetry from the just-completed turn. We may not have
      // contextTokens yet (it lands on the `done` event) but we can still
      // stash the usage and wait.
      this._lastUsage = { ...(this._lastUsage || {}), ...event };
      if (this._lastContextTokens) {
        this.applyContextMeter(this.promptTokensFromUsage(this._lastUsage), this._lastContextTokens);
      }
    } else if (event?.type === "context_overflow") {
      this.showOverflowRecoveryCard(event.checkpointPath);
    } else if (event?.type === "model_selected") {
      // Every turn names the AI and model it runs on (the turn layer's route): with no pick of the chat's own (the
      // default, auto-routing, a backup that answered), the composer shows that model.
      if (event.model) { this._turnModel = { model: event.model, provider: event.provider || null, label: event.label || null }; this._paintPicker(); }
    }
  },

  /** The send stream's terminal `done` event (both send paths). */
  handleTurnDone(data) {
    // `done` carries the context window size for the model that ran.
    // Combine with the stashed usage and finalize the meter for this turn.
    if (data?.contextTokens) {
      this._lastContextTokens = data.contextTokens;
      // The done event carries the turn's usage: this turn's, never a figure left from the turn before.
      if (data.usage) this._lastUsage = { ...data.usage };
      if (this._lastUsage) {
        this.applyContextMeter(this.promptTokensFromUsage(this._lastUsage), this._lastContextTokens);
      }
    }
    if (data?.checkpointed) {
      App.showToast("Context near limit, auto-checkpoint saved", "info");
    }
    this.updateSessionBar();
  },

  // ── Queued messages (stopgap until the live rebuild) ─────────────────
  // A message sent while the agent is replying is queued in the tab. It used to
  // live ONLY in the DOM + memory: coming back to the tab redrew the chat
  // from the server (which never had it) and wiped it, and the queue only
  // drained from the SSE "done" that the wake handler had just aborted, so it
  // was never sent. Now the queue is persisted, re-drawn after every redraw,
  // and drained from every completion path.
  _persistQueue() {
    try {
      localStorage.setItem("tarsee_pending_queue", JSON.stringify(
        this.messageQueue.map((q) => ({ text: q.text, convId: q.convId || null })),
      ));
    } catch { /* storage unavailable: queue still works in memory */ }
  },

  _restoreQueue() {
    try {
      const saved = JSON.parse(localStorage.getItem("tarsee_pending_queue") || "[]");
      if (Array.isArray(saved) && saved.length && !this.messageQueue.length) {
        this.messageQueue = saved.filter((q) => q && q.text).map((q) => ({ text: q.text, attachments: [], convId: q.convId }));
      }
    } catch { /* ignore */ }
  },

  _renderQueuedBubbles() {
    const conv = this.currentConversationId;
    this.messageQueue.forEach((q, i) => {
      if (q.convId && conv && q.convId !== conv) return;
      const el = this.appendMessage("user", q.text);
      const badge = document.createElement("span");
      badge.className = "queue-badge";
      badge.textContent = `Queued #${i + 1}`;
      el.querySelector(".message-content")?.appendChild(badge);
      el.dataset.queued = "true";
    });
  },

  _drainQueueIfIdle() {
    if (this.isStreaming || this._draining || this.messageQueue.length === 0) return;
    const conv = this.currentConversationId;
    const idx = this.messageQueue.findIndex((q) => !q.convId || !conv || q.convId === conv);
    if (idx < 0) return;
    this._draining = true;
    const [next] = this.messageQueue.splice(idx, 1);
    this._persistQueue();
    const queued = this.elements.chatArea.querySelectorAll('[data-queued="true"]');
    queued.forEach((el, i) => {
      const b = el.querySelector(".queue-badge");
      if (i === 0) { b?.remove(); delete el.dataset.queued; } else if (b) b.textContent = `Queued #${i}`;
    });
    // Small delay so the user sees the transition
    setTimeout(() => { this._draining = false; this.sendQueued(next.text, next.attachments); }, 300);
  },

  /** Send a queued message (already displayed in chat) */
  async sendQueued(text, attachments) {
    this.elements.welcomeScreen.style.display = "none";
    this.elements.chatArea.style.display = "flex";
    this.elements.inputArea.style.display = "block";
    if (!this.currentChannelKey) this.currentChannelKey = "web:default";
    await this._streamReply(text, attachments || []);
  },

  /* ------------------------------------------------------------ the model and the effort (js/model-picker.js) */

  _picker: null,          // the list: every ready AI's models, from GET /api/chat/models (routes/models.js)
  _pickerAt: 0,
  _pickDefaults: { model: "sonnet", effort: "medium" },
  _pick: { provider: null, model: null, effort: null },   // this chat's own; null is the default
  _pickConv: undefined,   // the chat _pick belongs to

  /** The model and effort a new chat sends with its first message (an existing chat's are on the server). */
  getEffort() {
    return this.currentConversationId ? undefined : (this._pick.effort || undefined);
  },
  getModel() {
    return this.currentConversationId ? undefined : (this._pick.model || undefined);
  },

  /** The list, asked again when the menu opens and it is more than five minutes old (a new model shows up). */
  async refreshPicker(force = false) {
    if (!force && this._picker && Date.now() - this._pickerAt < 5 * 60_000) return;
    // A forced ask while one is on its way is asked again once it is back: what changed may be newer than that answer.
    if (this._pickerAsking) { if (force) this._pickerAgain = true; return; }
    this._pickerAsking = true;
    this._pickerAgain = false;
    try {
      const data = await API.json("/api/chat/models");
      this._models = data.models || [];
      if (data.picker) { this._picker = data.picker; this._pickerAt = Date.now(); }
      if (data.defaults) this._pickDefaults = data.defaults;
      this._paintPicker();
      window.ModelPicker?.refresh();
    } catch { /* the button keeps what it shows */ } finally {
      this._pickerAsking = false;
      if (this._pickerAgain) { this._pickerAgain = false; this.refreshPicker(true); }
    }
  },

  /** This chat's own model and effort (a chat is only asked once per visit, unless `fresh`). */
  async _loadPick({ fresh = false } = {}) {
    const id = this.currentConversationId || null;
    if (!fresh && this._pickConv === id) return;
    if (this._pickConv !== id) { this._pick = { provider: null, model: null, effort: null }; this._pickConv = id; this._paintPicker(); }
    if (!id) return;
    try {
      const data = await API.json(`/api/chat/conversations/${encodeURIComponent(id)}/picker`);
      if (this.currentConversationId !== id) return;
      this._pick = { provider: data.provider || null, model: data.model || null, effort: data.effort || null };
      if (data.defaults) this._pickDefaults = data.defaults;
      this._paintPicker();
      window.ModelPicker?.refresh();
    } catch { /* the defaults stay shown */ }
  },

  /** Picked in the menu: shown at once, saved for the chat (a new chat saves it once its first message makes it). */
  async setPick(change) {
    const before = { ...this._pick };
    this._pick = { ...this._pick, ...change };
    // A model without the chat's level runs at the nearest one it has: save that, as Claude Code does.
    if ("model" in change && this._pick.effort && this._picker) {
      const entry = ModelPickerCore.entryFor(this._picker, this._pick.model || this._pickDefaults.model);
      const level = ModelPickerCore.effortFor(entry, this._pick.effort, this._pickDefaults.effort);
      if (level && level !== this._pick.effort) this._pick.effort = level;
    }
    this._turnModel = null;
    this._paintPicker();
    const id = this.currentConversationId;
    if (!id) return;
    try {
      const body = ModelPickerCore.pickChange(before, this._pick);
      if (!Object.keys(body).length) return;
      const data = await API.json(`/api/chat/conversations/${encodeURIComponent(id)}/picker`, { method: "PUT", body });
      if (this.currentConversationId === id) { this._pick = { provider: data.provider || null, model: data.model || null, effort: data.effort || null }; this._paintPicker(); }
    } catch (err) {
      if (this.currentConversationId === id) { this._pick = before; this._paintPicker(); }
      App.showToast(`Couldn't change it: ${err.message}`, "error");
    }
  },

  /** /model changes the default, /think and /effort this chat's level: the button shows it. */
  afterPickCommand(text) {
    if (!/^\/(model|think|effort)\b/i.test(String(text || ""))) return;
    // (The last turn's model is no longer what the next one runs on.)
    this._turnModel = null;
    this.refreshPicker(true);
    this._loadPick({ fresh: true });
  },

  /** The composer's button: "Sonnet 5.5 · High". */
  _paintPicker() {
    const btn = document.getElementById("modelPickerBtn");
    if (!btn || typeof ModelPickerCore === "undefined") return;
    const label = ModelPickerCore.buttonLabel(this._picker, this._pick, this._pickDefaults);
    // No model of the chat's own (the default, auto-routing): the model the last turn ran on.
    const fromTurn = !this._pick.model && !this._pick.provider && this._turnModel;
    const model = fromTurn ? ModelPickerCore.turnName(this._picker, this._turnModel) : label.model;
    if (this.elements.sessionModel) this.elements.sessionModel.textContent = model;
    // The chat's AI as a dot in its color (style.css [data-ai]); the header chip shows the default AI's. Only with
    // other AIs listed: the Claude-only list has just the one.
    const dot = document.getElementById("sessionAi");
    if (dot) {
      const ai = Array.isArray(this._picker?.groups) ? ((fromTurn && this._turnModel.provider) || label.provider || null) : null;
      dot.hidden = !ai;
      if (ai) dot.dataset.ai = ai; else delete dot.dataset.ai;
    }
    const effortEl = document.getElementById("effortLabel");
    if (effortEl) effortEl.textContent = label.effort;
    btn.classList.toggle("no-effort", !label.effort);
    btn.classList.toggle("has-warning", !!label.warning);
    btn.dataset.level = label.level || "";
    btn.title = label.title;
    btn.setAttribute("aria-label", label.title);
  },

  _typingWs: null,
  _typingDebounce: null,
  _typingIndicatorTimeout: null,

  /**
   * A click on a diagram's node puts a question about that node in the message box, and nothing is sent: the AI chose
   * those words (and they may be one of the chat's commands, which run as the owner), so the owner reads them and
   * presses Send, as with dictation. They go in at the caret, added to a draft, and the files waiting to go with the
   * message stay where they are. Each node shows its words before any click (lib/diagram-renderer.js), and they go in
   * on one line, as the node shows them (ChatCore.oneLine): no run of blank lines, spaces or characters that look
   * blank can hide a command or make the box look empty, and no marks pile up over the words. Enter in the box doesn't
   * send for a moment after (a node pressed twice), and a command with a diagram's words in it asks before it is sent
   * (send, _askToRun).
   * Only a diagram Tarsee drew can put them there. A diagram is at
   * /diagram/<id>/: a page the server draws itself from the diagram's data on every request, whose CSP lets one script
   * run, Tarsee's own, the same for every diagram (lib/canvas.js, lib/diagram-renderer.js). Nothing the AI writes runs
   * there, neither through create_canvas nor as a file it puts in the workspace. A canvas (/canvas/<id>/) is a page the
   * AI wrote, so nothing a canvas posts is taken, whatever it is called.
   * The diagram's iframe is sandboxed without allow-same-origin (embedHtml) and the server adds a CSP sandbox, so its
   * messages come from origin "null", which every sandboxed page shares: the origin can't say who sent one. What does
   * is the sender's window being one of this chat's own diagram iframes, as the chat drew it. Then:
   *   - the message is a node click's exact shape, { type: "tarsee:diagram-click", diagramId, nodeId, label, sublabel,
   *     question?, click }, every field checked, and it names that iframe's diagram;
   *   - a person just clicked: the browser says so (navigator.userActivation, for a few seconds after a click), so a
   *     message nobody clicked for never fills the box;
   *   - once per click: click is the page's count of its clicks (1, 2, 3, ...), and each one is taken once.
   */
  _initDiagramListener() {
    const FIELDS = new Set(["type", "diagramId", "nodeId", "label", "sublabel", "question", "click"]);
    const DIAGRAM_ID = /^[a-z0-9-]{1,64}$/;
    // Words in one line, all in view, by the rule lib/diagram-renderer.js keeps them by (ChatCore.oneLine), whatever
    // the page posted.
    const fold = (words, max) => Core.oneLine(words, max);
    // For each diagram iframe, the last click taken from the page it shows. A page loaded again counts from 1.
    const lastClick = new WeakMap();
    this.elements.chatArea.addEventListener("load", (e) => {
      if (e.target instanceof HTMLIFrameElement) lastClick.delete(e.target);
    }, true);

    window.addEventListener("message", (event) => {
      // Sent by one of this chat's diagram iframes, sandboxed and showing its diagram's own address, as embedHtml drew
      // it. Its origin is "null": a diagram's page is always sandboxed, so any other origin is some other page.
      if (event.origin !== "null" || !event.source) return;
      const frame = [...this.elements.chatArea.querySelectorAll(".canvas-embed[data-diagram-id] > iframe.diagram-iframe")]
        .find((f) => f.contentWindow === event.source);
      if (!frame) return;
      const id = frame.parentElement.dataset.diagramId;
      if (!DIAGRAM_ID.test(id) || frame.getAttribute("src") !== `/diagram/${id}/` || frame.getAttribute("sandbox") !== "allow-scripts") return;

      // A node click's exact shape: a plain object of those fields only, naming this diagram.
      const data = event.data;
      if (!data || typeof data !== "object" || Object.getPrototypeOf(data) !== Object.prototype) return;
      if (Object.keys(data).some((k) => !FIELDS.has(k))) return;
      const { type, diagramId, nodeId, label, sublabel, question, click } = data;
      if (type !== "tarsee:diagram-click" || diagramId !== id) return;
      if (typeof nodeId !== "string" || !nodeId || typeof label !== "string" || typeof sublabel !== "string") return;
      // A node with no question of its own sends none (lib/diagram-renderer.js leaves out one that isn't words).
      if (question !== undefined && (typeof question !== "string" || !fold(question, 500))) return;
      // A click this page has not sent before, right after a person clicked.
      if (!Number.isSafeInteger(click) || click < 1 || click <= (lastClick.get(frame) || 0)) return;
      if (!navigator.userActivation?.isActive) return;

      const name = fold(label, 200);
      const more = fold(sublabel, 200);
      const custom = fold(question || "", 500);
      if (!name && !custom) return;
      lastClick.set(frame, click);
      const text = custom || (more ? `Tell me more about: ${name}. ${more}` : `Tell me more about: ${name}`);

      // Into the box, for the owner to read and send. Never sent from here.
      this.insertIntoBox(text);
    });
  },

  /**
   * A diagram's words into the message box at the caret, added to what is typed (a selection stays: they go after it),
   * with a space either side where one is needed, as dictation puts them (js/voice.js). Nothing is sent, and the files
   * waiting to go with the message stay. The box gets the focus; on a phone without the keyboard popping up, until the
   * box is tapped. The box scrolls to show the words (_showInBox), and keeps note of them as a diagram's (_boxMark):
   * a command with them in it asks before it is sent. For a second after, Enter in the box doesn't send.
   */
  insertIntoBox(words) {
    const input = this.elements.messageInput;
    const value = input.value;
    const scrolled = input.scrollTop;
    const at = Math.min(Number.isInteger(input.selectionEnd) ? input.selectionEnd : value.length, value.length);
    const before = value.slice(0, at);
    const after = value.slice(at);
    const lead = before && !/\s$/.test(before) ? " " : "";
    const trail = after && !/^[\s.,!?;:)]/.test(after) ? " " : "";
    const from = before.length + lead.length;
    const upToCaret = before + lead + words;
    this.setBox(upToCaret + trail + after, { at: [at, at] });
    this._boxMark(from, upToCaret.length);
    const caret = upToCaret.length;
    const phone = window.matchMedia?.("(pointer: coarse)").matches;
    if (phone && document.activeElement !== input) {
      // inputmode=none: focused, with no keyboard. A tap on the box (or leaving it) brings the keyboard back.
      input.setAttribute("inputmode", "none");
      const restore = () => {
        input.removeAttribute("inputmode");
        input.removeEventListener("pointerdown", restore);
        input.removeEventListener("blur", restore);
      };
      input.addEventListener("pointerdown", restore);
      input.addEventListener("blur", restore);
    }
    input.focus({ preventScroll: true });
    input.setSelectionRange(caret, caret);
    input.dispatchEvent(new Event("input", { bubbles: true }));   // Send turns on, the box grows to fit
    this._showInBox(from, caret, scrolled);
    this._enterHeldUntil = performance.now() + 1000;
  },

  /**
   * The box scrolled to show the words from `from` to `to` that were just put in (it stops growing at 200px, a long
   * draft may be scrolled away from them, and moving the caret doesn't scroll a box): as little as it must from where
   * it was (`scrolled`), all of them when they fit, else from their first line, never their end. And when the box's
   * words are a command, the line it starts on always shows, whatever else: what a press of Send would run.
   */
  _showInBox(from, to, scrolled) {
    const input = this.elements.messageInput;
    const value = input.value;
    const style = getComputedStyle(input);
    const padTop = parseFloat(style.paddingTop) || 0;
    const padBottom = parseFloat(style.paddingBottom) || 0;
    const view = input.clientHeight;
    const lead = value.length - value.trimStart().length;
    const command = value[lead] === "/";
    // The words' last character (both halves of one outside the first 65,536).
    let end = Math.max(from, to - 1);
    if (end > from && /[\uDC00-\uDFFF]/.test(value[end]) && /[\uD800-\uDBFF]/.test(value[end - 1])) end -= 1;
    const [first, last, start] = linesAt(input, [from, end, command ? lead : from]);
    if (!first || !last) return;
    let top = scrolled;
    if (last.bottom + padBottom <= view) top = 0;                                                // all of it shows from the top
    else if (last.bottom - first.top > view - padTop - padBottom) top = first.top - padTop;       // too long: from their first line
    else if (first.top - padTop < top) top = first.top - padTop;                                  // above what shows
    else if (last.bottom + padBottom > top + view) top = last.bottom + padBottom - view;          // below what shows
    if (command && start) top = Math.min(Math.max(top, start.bottom + padBottom - view), start.top - padTop);
    input.scrollTop = Math.max(0, top);
  },

  /**
   * The one way this page changes the message box's words: test/diagram-click.test.js checks that no script in
   * src/public sets them any other way, so what the marks say (this._box) is always about the box's words as they
   * are. `value` is the box's words now. What it put in is the owner's (a command picked from the list, the commands
   * button's "/", dictation, the setup tour's first message), unless the caller then marks it as a diagram's
   * (insertIntoBox). `at`, when the caller knows it: where the change is, [start, end) of the words before it; else
   * it is worked out from the words before and after, and the letters kept keep their marks. Emptied (each send):
   * nothing in the box is marked, so nothing is left over for what the owner types next.
   */
  setBox(value, { at = null } = {}) {
    const input = this.elements.messageInput;
    this._boxSync();   // (a change made with no edit before this one)
    input.value = value;
    if (input.value) {
      this._boxEdited("set", { at });
    } else {
      this._box.value = "";
      this._box.marks = [];
      this._box.sel = null;
    }
  },

  /** The box emptied, as a send leaves it (setBox), and back to one line. */
  _emptyBox() {
    this.setBox("");
    this.elements.messageInput.style.height = "auto";
  },

  /**
   * The box's words changed: by an edit (`how`, its inputType: typed, pasted, dropped, dictated, undone; or "set" for
   * setBox), or with no edit at all (`found`, seen now: _boxSync). The ranges of the words that aren't the owner's
   * (this._box.marks, [start, end, whose] of the box's words, whose "diagram" or "found") move along: an edit before
   * one shifts it, one in it cuts out what it changed. What an edit put in is the owner's; what changed with no edit
   * is not (whose "found"). So emptying the box, or typing over all of it, leaves none; and a send empties it. Two
   * ways bring a diagram's words back, and their ranges with them: an undo or a redo that brings back the box's words
   * as they were while a diagram's words were in them (the box's last states with such words in them are kept for
   * that: this._box.seen), and pasting or dropping the very words last copied, cut or dragged out of the box
   * (_boxClip). Where the edit was: `at`, or where the selection was when it began (beforeinput), checked against the
   * words; else what changed between the words before and after (the same start and end kept, the middle replaced).
   */
  _boxEdited(how = "", { at = null, found = false } = {}) {
    const box = this._box;
    const value = this.elements.messageInput.value;
    const was = box.value;
    const sel = at || (box.sel && box.sel.type === how ? box.sel.at : null);
    box.sel = null;
    if (value === was) return;
    const delta = value.length - was.length;
    let start = -1, cutTo = -1;
    if (sel && (how === "set" || /^(insert(Text|LineBreak|Paragraph|FromPaste|FromPasteAsQuotation|Transpose)|delete)/.test(how))) {
      let [a, b] = sel;
      if (a === b && delta < 0 && /Backward$/.test(how)) a = b + delta;
      else if (a === b && delta < 0 && /Forward$/.test(how)) b = a - delta;
      if (a >= 0 && b <= was.length && b + delta >= a && was.slice(0, a) === value.slice(0, a) && was.slice(b) === value.slice(b + delta)) {
        start = a;
        cutTo = b;
      }
    }
    if (start < 0) {
      const most = Math.min(was.length, value.length);
      start = 0;
      while (start < most && was[start] === value[start]) start++;
      let same = 0;
      while (same < most - start && was[was.length - 1 - same] === value[value.length - 1 - same]) same++;
      cutTo = was.length - same;
    }
    const newTo = cutTo + delta;
    let marks = [];
    for (const [a, b, whose] of box.marks) {
      if (b <= start) marks.push([a, b, whose]);
      else if (a >= cutTo) marks.push([a + delta, b + delta, whose]);
      else {
        if (a < start) marks.push([a, start, whose]);
        if (b > cutTo) marks.push([newTo, b + delta, whose]);
      }
    }
    if (found) marks.push([start, newTo, "found"]);
    if (how === "historyUndo" || how === "historyRedo") {
      for (const seen of box.seen) if (seen.value === value) marks = marks.concat(seen.marks);
    }
    const clip = box.clip;
    if (clip && clip.marks.length && /^insertFrom(Paste|PasteAsQuotation|Drop)$/.test(how)) {
      // The words put in, if they are the ones copied, cut or dragged out: where the edit was, or (a drop's place can
      // read as a little off when the letters around it repeat) touching it.
      let place = value.slice(start, newTo) === clip.text ? start : -1;
      if (place < 0) {
        const i = value.indexOf(clip.text, Math.max(0, start - clip.text.length));
        if (i >= 0 && i <= newTo) place = i;
      }
      if (place >= 0) marks = marks.concat(clip.marks.map(([a, b, whose]) => [a + place, b + place, whose]));
    }
    box.value = value;
    box.marks = spansOf(marks);
    this._boxSeen();
  },

  /**
   * The box's words as they are now, against those this page last saw: what changed with no edit (no event at all,
   * so neither this page nor the owner typing: a browser putting a form's words back, say) is not the owner's. Done
   * before every edit (beforeinput), before the box is read for a send, and whenever setBox changes it.
   */
  _boxSync() {
    this._boxEdited("", { found: true });
  },

  /** Words found in the box (_boxSync) as the page starts or is shown again, shown as any words in it are. */
  _boxFound() {
    this._boxSync();
    const el = this.elements.messageInput;
    if (!el.value.trim()) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 200) + "px";
    this.elements.sendBtn.disabled = false;
    if (this.isStreaming) this.elements.sendBtn.classList.remove("stop-mode");
  },

  /** The words selected in the box, as they are copied, cut or dragged out: which of them aren't the owner's. */
  _boxClip() {
    this._boxSync();
    const el = this.elements.messageInput;
    const from = el.selectionStart, to = el.selectionEnd;
    if (!(to > from)) return;
    const marks = [];
    for (const [a, b, whose] of this._box.marks) {
      const s = Math.max(a, from), e = Math.min(b, to);
      if (e > s) marks.push([s - from, e - from, whose]);
    }
    this._box.clip = { text: el.value.slice(from, to), marks };
  },

  /** The box's words from `from` to `to` are a diagram's (insertIntoBox). */
  _boxMark(from, to) {
    this._box.marks = spansOf([...this._box.marks, [from, to, "diagram"]]);
    this._boxSeen();
  },

  /** The box's words as they are now, kept if words not the owner's are in them (for an undo that comes back to them). */
  _boxSeen() {
    const box = this._box;
    if (!box.marks.length) return;
    const lastSeen = box.seen[box.seen.length - 1];
    if (lastSeen && lastSeen.value === box.value && JSON.stringify(lastSeen.marks) === JSON.stringify(box.marks)) return;
    box.seen.push({ value: box.value, marks: box.marks.map((m) => [...m]) });
    if (box.seen.length > 50) box.seen.shift();
  },

  /**
   * Whether words in the box aren't the owner's (more than a space of them): "diagram" when a diagram's are, else
   * "found" when words the page didn't put there are, else null.
   */
  _notOwnersIn() {
    this._boxSync();   // (a change made with no edit, first)
    const value = this.elements.messageInput.value;
    const there = (whose) => this._box.marks.some(([a, b, w]) => w === whose && /\S/.test(value.slice(a, b)));
    return there("diagram") ? "diagram" : there("found") ? "found" : null;
  },

  /**
   * Whether to send `text`, a command with words in it that aren't the owner's (`whose`, _notOwnersIn): Tarsee's own
   * question (js/dialogs.js), never the browser's. It shows the whole command, folded the way a diagram's words are
   * (ChatCore.oneLine), so nothing in it can hide, in a block of its own. Cancel is the answer to a plain Enter, and
   * Run counts only a second after the question shows: a key or a press still going from what sent it doesn't run
   * it. Yes only for Run, and only while the box still holds those words; Cancel leaves them in the box.
   */
  async _askToRun(text, whose = "diagram") {
    if (this._askingToRun) return false;
    this._askingToRun = true;
    try {
      const found = whose === "found";
      const run = await TarseeDialog.ask({
        title: found ? "Run this command?" : "Run this command from a diagram?",
        block: Core.oneLine(text),
        text: found
          ? "These words were already in your message box, and Tarsee didn't see who put them there (a browser can put back words from an earlier visit). A command runs as you."
          : "A diagram put these words in your message box, and the AI chose them. A command runs as you.",
        yes: "Run it",
        no: "Cancel",
        danger: true,
        defaultNo: true,
        settleMs: 1000,
        back: this.elements.messageInput,
      });
      return run && this.elements.messageInput.value.trim() === text;
    } finally {
      this._askingToRun = false;
    }
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
        // Live view: resubscribe from the last sequence seen (catches up on
        // everything missed while the socket was down).
        if (this.liveOn()) Live.onSocketOpen();
        // Ask the server to replay any events we missed for the conversation
        // we're currently viewing (if any).
        else if (this.currentConversationId) {
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
          } else if (typeof data.type === "string" && data.type.startsWith("live.")) {
            if (this.liveOn()) Live.onFrame(data);
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
  _syncFullText: "",

  /** Another device's turn, in the old view (the live view draws them itself). */
  _handleSyncEvent(data) {
    // The live timeline draws everything when it's on; this would duplicate it.
    if (this.liveOn()) return;
    // Only process events for the conversation we're currently viewing
    if (data.convId !== this.currentConversationId) return;
    // Dedup only against the conversation THIS device is actively driving.
    // If we're streaming conv A but viewing conv B, we still want B's sync
    // events — don't drop them just because isStreaming is true.
    if (this.isStreaming && this._streamingConvId === data.convId) return;

    const evt = data.event;
    const d = data.data || {};
    const ensure = () => {
      if (!this._syncStreamingEl) {
        this._syncStreamingEl = this.appendMessage("assistant", "", true);
        const steps = this.createSteps({ state: "running", startedAt: Date.now() });
        this._syncStreamingEl.querySelector(".message-content")?.prepend(steps.el);
        this._syncStreamingEl._steps = steps;
        this._syncFullText = "";
      }
      return this._syncStreamingEl;
    };

    if (evt === "user_message") {
      // Another device sent a message — show it
      this.appendMessage("user", d.content);
      return;
    }
    if (evt === "thinking") { if (d.status === "start") ensure(); return; }
    if (evt === "text") {
      const el = ensure();
      this._syncFullText += d.content || "";
      const textEl = el.querySelector(".message-text");
      if (textEl) textEl.innerHTML = this.renderMarkdown(this._syncFullText);
      this.scrollToBottom();
      return;
    }
    if (evt === "tool_call") {
      const el = ensure();
      const inp = d.input || {};
      el._steps.addTool({ id: d.id, name: d.name, startedAt: Date.now(), summary: inp.description || inp.file_path || inp.url || inp.query || inp.command || "" });
      this.scrollToBottom();
      return;
    }
    if (evt === "tool_result") {
      if (this._syncStreamingEl && d.id) this._syncStreamingEl._steps.endTool(d.id, { output: String(d.result || "").slice(0, 4000) });
      return;
    }
    if (evt === "done") {
      this._syncStreamingEl = null;
      this._syncFullText = "";
      // Reload messages to get the final saved version, then send anything queued.
      if (this.currentConversationId) {
        Promise.resolve(this.openChannel(this.currentChannelKey, this.currentConversationId, { push: false }))
          .finally(() => this._drainQueueIfIdle());
      }
    }
  },

  /**
   * The sidebar's search box: the chats' names filter as you type (js/chat-core.js), and from two letters the
   * messages that match come under them. Esc empties it.
   */
  initSearch() {
    const input = document.getElementById("searchInput");
    const results = document.getElementById("searchResults");
    if (!input || !results) return;

    let debounce = null;
    let asked = "";
    const clear = () => {
      input.value = "";
      this._navQuery = "";
      results.hidden = true;
      results.innerHTML = "";
      this.renderChannelList();
    };
    input.addEventListener("input", () => {
      clearTimeout(debounce);
      const q = input.value.trim();
      this._navQuery = q;
      this.renderChannelList();
      if (q.length < 2) { results.hidden = true; results.innerHTML = ""; return; }
      debounce = setTimeout(async () => {
        asked = q;
        try {
          const data = await API.searchMessages(q);
          if (asked !== input.value.trim()) return;   // (typed on meanwhile)
          const rows = data.results || [];
          results.innerHTML = `<div class="nav-results-label">Messages</div>`
            + (rows.length ? rows.map((r) => {
              const ch = this.channels?.find((c) => c.conversationId === r.conversation_id);
              const name = ch ? Core.chatName(ch) : (r.conversation_title || "A chat");
              return `<a class="search-result-item" href="${escapeHtml(Core.chatPath(r.conversation_id))}" data-conv="${escapeHtml(r.conversation_id)}">`
                + `<span class="search-result-title">${escapeHtml(name)}</span>`
                + `<span class="search-result-snippet">${escapeHtml(r.snippet).replace(/&lt;(\/?)mark&gt;/g, "<$1mark>")}</span></a>`;
            }).join("") : '<p class="search-empty">No messages match.</p>');
          results.hidden = false;
        } catch { results.hidden = true; }
      }, 300);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && input.value) { e.preventDefault(); clear(); }
      else if (e.key === "Enter") {
        // Enter opens the first chat that matches.
        const first = this.elements.channelList.querySelector(".nav-row");
        if (first) { e.preventDefault(); first.click(); }
      }
    });

    results.addEventListener("click", (e) => {
      const item = e.target.closest(".search-result-item");
      if (!item || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      this.openChat(item.dataset.conv);
      clear();
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
      <div class="delete-modal" role="dialog" aria-modal="true" aria-labelledby="deleteModalTitle">
        <div class="delete-modal-header" id="deleteModalTitle">Delete this chat?</div>
        <p class="delete-modal-text">This permanently deletes <strong>${escapeHtml(sessionName)}</strong> and all its messages.</p>
        <p class="delete-modal-text">Type <strong>${escapeHtml(sessionName)}</strong> to confirm:</p>
        <input type="text" class="delete-modal-input" id="deleteConfirmInput" placeholder="The chat's name" autocomplete="off" spellcheck="false">
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
    // Escape anywhere in the dialog (not only in the text box) closes it.
    modal.addEventListener("keydown", (e) => { if (e.key === "Escape") modal.remove(); });

    setTimeout(() => input.focus(), 50);
  },

  async deleteSession(conversationId, channelKey) {
    try {
      if (conversationId) {
        await API.deleteConversation(conversationId);
      }

      const wasOpen = conversationId ? conversationId === this.currentConversationId : channelKey === this.currentChannelKey;
      App.showToast("Chat deleted", "success");
      await this.loadChannels();
      // The chat on screen is gone: a new chat in its place (its address too).
      if (wasOpen) this.newChat({ replace: true });
    } catch (err) {
      App.showToast("Failed to delete: " + err.message, "error");
    }
  },

  // --- Attachment data store (for previewing sent attachments) ---
  _attachmentStore: [],
  _storeAttachmentData(att) {
    const idx = this._attachmentStore.length;
    this._attachmentStore.push(att);
    // Each entry holds a whole file as base64; a long session never let go
    // of them. Keep the last 20 previewable, free the rest.
    if (idx >= 20) this._attachmentStore[idx - 20] = null;
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
    // Pinch-zoom is allowed everywhere now (blocking it fails low-vision
    // users, and iOS ignored the block anyway; inputs are 16px on phones so
    // focusing doesn't auto-zoom). The lightbox just raises the zoom cap.
    const meta = document.querySelector('meta[name="viewport"]');
    if (!meta) return;
    meta.setAttribute(
      "content",
      enabled
        ? "width=device-width, initial-scale=1, maximum-scale=5, viewport-fit=cover"
        : "width=device-width, initial-scale=1, viewport-fit=cover"
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
  /**
   * Follow new content only when the reader is already at the bottom.
   * Scrolled up to read something? Stay put and offer a "jump" pill.
   */
  scrollToBottom(force = false) {
    const el = this.elements.chatArea;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (force || nearBottom) {
      el.scrollTop = el.scrollHeight;
      this._jumpPill?.classList.remove("visible");
      return;
    }
    if (!this._jumpPill) {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "jump-latest";
      pill.textContent = "Jump to the latest";
      pill.setAttribute("aria-label", "Jump to the latest message");
      pill.addEventListener("click", () => this.scrollToBottom(true));
      el.addEventListener("scroll", () => {
        if (el.scrollHeight - el.scrollTop - el.clientHeight < 160) pill.classList.remove("visible");
      }, { passive: true });
      // A zero-height anchor just above the composer holds the pill.
      const wrap = document.createElement("div");
      wrap.className = "jump-latest-wrap";
      wrap.appendChild(pill);
      el.parentNode?.insertBefore(wrap, this.elements.inputArea || null);
      this._jumpPill = pill;
    }
    this._jumpPill.classList.add("visible");
  },

  timeAgo(dateStr) {
    return Core.timeLabel(dateStr);
  },

  /**
   * A message's words as HTML (js/chat-core.js renderMarkdown, every character escaped). Before it, the blocks this
   * page draws itself are taken out and put back after: a canvas (drawn inline, with its "..." menu), a thinking
   * block (folded). Tool-call XML in old messages is dropped: the steps show the tools.
   */
  renderMarkdown(text) {
    if (!text) return "";
    // A saved timeline that reached here whole: its words only.
    if (String(text).startsWith('{"__timeline":true')) text = Core.replyParts(text).answer;

    // Strip any [REMEMBER: ...] markers that leaked through, and NUL characters:
    // the blocks below are put back by \u0000<n>\u0000 markers, which a message
    // must not be able to write itself.
    // eslint-disable-next-line no-control-regex -- U+0000 is the renderer's own block marker
    text = String(text).replace(/\u0000/g, "").replace(/\[REMEMBER:\s*.+?\]/gi, "").replace(/\n{3,}/g, "\n\n").trim();

    const blocks = [];
    const token = (html) => `\n\u0000${blocks.push(html) - 1}\u0000\n`;

    // Canvas and diagram embeds: the model sometimes wraps the URL in an <a> AND drops a bare /canvas/id/ too: one
    // embed per canvas or diagram, the anchor's leftovers gone.
    const seenEmbed = new Set();
    const placeEmbed = (kind, id) => {
      if (seenEmbed.has(`${kind}:${id}`)) return "";
      seenEmbed.add(`${kind}:${id}`);
      return token(embedHtml(kind, id));
    };
    // As an <a> tag: this page's own canvas or diagram (isOwnAddress, as for an address on its own below). Another
    // site's /canvas/ or /diagram/ address stays a link, with the tag's words.
    text = text.replace(/<a\s+[^>]*href=(["'])((?:https?:\/\/[^\s/"']+)?\/(canvas|diagram)\/([a-z0-9-]+)\/?)\1[^>]*>([\s\S]*?)<\/a>/gi, (_m, _q, href, kind, id, words) => {
      const k = kind.toLowerCase();
      return /^[a-z0-9-]+$/.test(id) && isOwnAddress(href, k, id) ? placeEmbed(k, id) : linkWords(href, words);
    });
    // A canvas's or a diagram's address on its own: Tarsee's own, as a path (/canvas/<id>/, /diagram/<id>/) or with
    // this page's origin in front. Only where an address starts (the start of the text, a space, an opening bracket or
    // quote), so never the end of a longer path (docs/diagram/flow.png) or of another site's address
    // (https://app.example.com/#/diagram/x/, https://example.com/login?next=/canvas/x/). And the whole address is read
    // as the browser reads it: only this page's own counts, so another site's (https://example.com/canvas/x/) stays a
    // link.
    text = text.replace(/(?<![^\s([{<"'])(?:https?:\/\/[^\s/?#)"'<>]+)?\/(canvas|diagram)\/([a-z0-9-]+)\/?(?=[\s)\]}>."',;:!?]|$)/g, (m, kind, id) => (isOwnAddress(m, kind, id) ? placeEmbed(kind, id) : m));

    // Thinking / reasoning: folded.
    text = text.replace(/<(thinking|antThinking|antml:thinking|reasoning)>([\s\S]*?)<\/\1>/g, (_m, tag, content) => token(renderThinkingBlock(tag.includes("thinking") || tag.includes("Thinking") ? "Thinking" : "Reasoning", content.trim())));
    // Tool calls and their results written into old messages: the steps show these.
    text = text
      .replace(/<function_calls>[\s\S]*?<\/function_calls>/g, "")
      .replace(/<function_response>[\s\S]*?<\/function_response>/g, "")
      .replace(/<(tool_call|tool_use)>[\s\S]*?<\/\1>/g, "")
      .replace(/<(tool_response|tool_result)>[\s\S]*?<\/\1>/g, "");
    // Search results, artifacts, results: folded.
    text = text.replace(/<(search_results|artifact|result)>([\s\S]*?)<\/\1>/g, (_m, tag, content) => token(renderGenericBlock(tag, content.trim())));

    let html = Core.renderMarkdown(text);
    // eslint-disable-next-line no-control-regex -- U+0000 is the renderer's own block marker
    html = html.replace(/\u0000(\d+)\u0000/g, (_m, i) => blocks[Number(i)] ?? "");
    return html;
  },
};

function escapeHtml(text) {
  return Core.escapeHtml(text);
}

/** Only http(s), mailto and same-site relative links are rendered as links. */
function safeHref(url) {
  return Core.safeHref(url);
}

/**
 * Whether `address`, as written in a message (/canvas/<id>/ or /diagram/<id>/, or a site in front of it), is the
 * address of this page's own canvas or diagram (`kind`) `id`, read as the browser reads it: this page's origin, that
 * path, and nothing else (no user name, no ? or # part).
 */
function isOwnAddress(address, kind, id) {
  try {
    const url = new URL(address, window.location.href);
    return url.origin === window.location.origin && !url.username && !url.password && !url.search && !url.hash
      && (url.pathname === `/${kind}/${id}/` || url.pathname === `/${kind}/${id}`);
  } catch {
    return false;
  }
}

/**
 * An <a> tag's link written as Markdown ([words](address)), for renderMarkdown to draw as every link is drawn: its
 * words with their tags taken out, on one line, or the address when it has none. An address Markdown can't hold (a
 * space, a bracket) leaves just the words.
 */
function linkWords(address, html) {
  const words = String(html).replace(/<[^>]*>/g, "").replace(/[[\]]/g, "").replace(/\s+/g, " ").trim() || address;
  return /[\s()<>]/.test(address) ? words : `[${words}](${address})`;
}

/** Ranges [start, end, whose] in order, those of the same whose that touch or overlap joined, empty ones left out. */
function spansOf(ranges) {
  const out = [];
  const last = new Map();   // for each whose, its last span in out
  for (const [a, b, whose] of ranges.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0])) {
    const prev = last.get(whose);
    if (prev && a <= prev[1]) prev[1] = Math.max(prev[1], b);
    else {
      const span = [a, b, whose];
      out.push(span);
      last.set(whose, span);
    }
  }
  return out;
}

/**
 * Where the lines holding these places of a text box's words are: { top, bottom } for each place (undefined for one
 * past the words), in the box's own scroll coordinates, its padding in them. A copy of the words is laid out as the
 * box lays them out (its font, its line height, its padding, its width inside its scroll bar, its wrapping), with the
 * character at each place in a span of its own; a span's line is the one its middle is on.
 */
function linesAt(input, places) {
  const style = getComputedStyle(input);
  const copy = document.createElement("div");
  for (const name of [
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "fontVariant", "fontStretch", "fontFeatureSettings", "fontKerning",
    "letterSpacing", "wordSpacing", "lineHeight", "textTransform", "textIndent", "tabSize", "whiteSpace", "overflowWrap",
    "wordBreak", "direction", "textAlign", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
  ]) copy.style[name] = style[name];
  Object.assign(copy.style, {
    position: "absolute", top: "0", left: "-10000px", visibility: "hidden", boxSizing: "border-box", border: "0",
    margin: "0", width: `${input.clientWidth}px`, height: "auto", overflow: "hidden",
  });
  if (!/^pre/.test(copy.style.whiteSpace)) copy.style.whiteSpace = "pre-wrap";
  const value = input.value;
  const order = [...new Set(places)].filter((p) => p >= 0 && p < value.length).sort((a, b) => a - b);
  const spans = new Map();
  let done = 0;
  for (const p of order) {
    if (p < done) continue;
    const next = p + (value.codePointAt(p) > 0xFFFF ? 2 : 1);
    copy.append(value.slice(done, p));
    const span = document.createElement("span");
    span.textContent = value.slice(p, next);
    copy.append(span);
    spans.set(p, span);
    done = next;
  }
  copy.append(value.slice(done));
  document.body.append(copy);
  const padTop = parseFloat(style.paddingTop) || 0;
  const lines = new Map();
  for (const [p, span] of spans) {
    const line = parseFloat(style.lineHeight) || span.offsetHeight || 20;
    const top = padTop + Math.floor((span.offsetTop + span.offsetHeight / 2 - padTop) / line) * line;
    lines.set(p, { top, bottom: top + line });
  }
  copy.remove();
  return places.map((p) => lines.get(p));
}

/**
 * A canvas (kind "canvas", /canvas/<id>/) or a diagram (kind "diagram", /diagram/<id>/) inline, with a floating "..."
 * menu (Copy link, Download), as Claude draws its diagrams. Only a diagram's iframe has data-diagram-id and the
 * diagram-iframe class: what _initDiagramListener takes a node click from.
 */
function embedHtml(kind, id) {
  const diagram = kind === "diagram";
  const safeId = escapeHtml(id);
  const href = `/${diagram ? "diagram" : "canvas"}/${safeId}/`;
  return `<div class="canvas-embed" ${diagram ? "data-diagram-id" : "data-canvas-id"}="${safeId}" data-href="${href}">
    <!-- No allow-same-origin. Canvas HTML is model-authored and the model
         reads untrusted input, so pairing allow-scripts with
         allow-same-origin handed any prompt injection full authority on
         Tarsee's origin: the API token, the vault, the Claude credentials.
         Dropping it keeps scripts working inside a null origin. The server
         sends a matching CSP sandbox header so a directly-opened canvas is
         covered too. -->
    <iframe src="${href}" class="canvas-iframe${diagram ? " diagram-iframe" : ""}" sandbox="allow-scripts" loading="lazy" title="${diagram ? "Diagram" : "Canvas"}"></iframe>
    <button type="button" class="canvas-embed-menu-btn" aria-label="${diagram ? "Diagram" : "Canvas"} options" aria-haspopup="menu" aria-expanded="false">
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="3" cy="8" r="1.5" fill="currentColor"/><circle cx="8" cy="8" r="1.5" fill="currentColor"/><circle cx="13" cy="8" r="1.5" fill="currentColor"/></svg>
    </button>
    <div class="canvas-embed-menu" role="menu">
      <button type="button" class="canvas-embed-menu-item" data-canvas-action="copy" role="menuitem">Copy link</button>
      <a class="canvas-embed-menu-item" href="${href}" download="${safeId}.html" role="menuitem">Download file</a>
    </div>
  </div>`;
}

function renderThinkingBlock(label, content) {
  const preview = escapeHtml(content.slice(0, 120).replace(/\n/g, " ")) + (content.length > 120 ? "…" : "");
  return `<details class="block-thinking">
    <summary>${escapeHtml(label)}<span class="block-preview">${preview}</span></summary>
    <div class="block-body">${Core.renderMarkdown(content)}</div>
  </details>`;
}

function renderGenericBlock(tag, content) {
  const label = tag.replace(/_/g, " ");
  return `<details class="block-generic">
    <summary>${escapeHtml(label.charAt(0).toUpperCase() + label.slice(1))}</summary>
    <div class="block-body">${escapeHtml(content).replace(/\n/g, "<br>")}</div>
  </details>`;
}
