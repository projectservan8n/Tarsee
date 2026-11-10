/**
 * The composer's microphone: dictation. Hold to record (or tap to start and tap again to stop), slide left to
 * cancel. What was said is turned into words with the speech-to-text chosen in Settings > Voice and put in the
 * message box at the caret, after anything already typed; it is never sent from here (Send is the owner's). A failure
 * is said by the box, with the server's reason and what to do. (Talking with the AI out loud is a call: js/call.js.)
 */
const Voice = {
  _chatRecording: false,
  _chatCancelled: false,
  _quickRecorder: null,
  _quickStream: null,
  _chatHoldTimer: null,

  init() {
    // Chat mic button: hold-to-record + click-to-toggle + drag-to-cancel
    this._initChatMicDrag();
  },

  /** Set up chat mic button: hold-to-record + tap-to-toggle + drag-to-cancel. */
  _initChatMicDrag() {
    const btn = document.getElementById("voiceInputBtn");
    if (!btn) return;

    let pressStart = 0;
    let startX = 0, startY = 0;
    let cancelled = false;
    const CANCEL_DISTANCE = 60;

    // Create cancel hint element
    const cancelHint = document.createElement("div");
    cancelHint.className = "voice-cancel-hint";
    cancelHint.innerHTML = '<span class="voice-cancel-arrow">‹</span> Slide to cancel';
    cancelHint.style.display = "none";
    btn.parentElement.appendChild(cancelHint);

    // Create recording timer element
    const recTimer = document.createElement("div");
    recTimer.className = "voice-rec-timer";
    recTimer.style.display = "none";
    btn.parentElement.appendChild(recTimer);

    let timerInterval = null;
    const startTimer = () => {
      const start = Date.now();
      recTimer.style.display = "flex";
      timerInterval = setInterval(() => {
        const s = Math.floor((Date.now() - start) / 1000);
        recTimer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
      }, 200);
    };
    const stopTimer = () => {
      clearInterval(timerInterval);
      recTimer.style.display = "none";
      recTimer.textContent = "";
    };

    const onMove = (x, y) => {
      const dx = x - startX;
      const dist = Math.abs(dx);

      // Only cancel when dragging left (away from button)
      if (dx < -CANCEL_DISTANCE) {
        if (!cancelled) {
          cancelled = true;
          cancelHint.classList.add("active");
          btn.classList.add("drag-cancel");
        }
      } else {
        if (cancelled) {
          cancelled = false;
          cancelHint.classList.remove("active");
          btn.classList.remove("drag-cancel");
        }
      }
    };

    const startRecording = async () => {
      if (this._chatRecording) return;

      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch { App.showToast("Microphone access denied", "error"); return; }

      this._chatRecording = true;
      this._chatCancelled = false;
      btn.classList.add("voice-active");
      cancelHint.style.display = "flex";
      startTimer();
      // Haptic: "recording started".
      App.buzz?.(20);

      const chunks = [];
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
      this._quickRecorder = recorder;
      this._quickStream = stream;

      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        this._chatRecording = false;
        this._quickRecorder = null;
        this._quickStream = null;
        btn.classList.remove("voice-active", "drag-cancel");
        cancelHint.style.display = "none";
        cancelHint.classList.remove("active");
        stopTimer();

        if (this._chatCancelled || chunks.length === 0) return;

        // Into words, then into the message box (never sent from here: Send is the owner's).
        await this._dictate(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }), btn);
      };
      recorder.start();
    };

    const stopRecording = (cancel = false) => {
      if (!this._chatRecording || !this._quickRecorder) return;
      this._chatCancelled = cancel;
      this._quickRecorder.stop();
    };

    // Mouse events
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pressStart = Date.now();
      startX = e.clientX; startY = e.clientY;
      cancelled = false;

      // Start recording after hold threshold
      this._chatHoldTimer = setTimeout(() => {
        if (!this._chatRecording) startRecording();
      }, 200);

      const mousemove = (e2) => onMove(e2.clientX, e2.clientY);
      const mouseup = () => {
        document.removeEventListener("mousemove", mousemove);
        document.removeEventListener("mouseup", mouseup);
        clearTimeout(this._chatHoldTimer);

        const duration = Date.now() - pressStart;
        if (duration < 200) {
          // Quick tap — toggle recording
          if (this._chatRecording) {
            stopRecording(cancelled);
          } else {
            startRecording();
          }
        } else {
          // Hold release — stop recording (send or cancel)
          stopRecording(cancelled);
        }
      };
      document.addEventListener("mousemove", mousemove);
      document.addEventListener("mouseup", mouseup);
    });

    // Touch events
    btn.addEventListener("touchstart", (e) => {
      e.preventDefault();
      pressStart = Date.now();
      const touch = e.touches[0];
      startX = touch.clientX; startY = touch.clientY;
      cancelled = false;

      this._chatHoldTimer = setTimeout(() => {
        if (!this._chatRecording) startRecording();
      }, 200);
    });
    btn.addEventListener("touchmove", (e) => {
      const touch = e.touches[0];
      onMove(touch.clientX, touch.clientY);
    });
    btn.addEventListener("touchend", () => {
      clearTimeout(this._chatHoldTimer);
      const duration = Date.now() - pressStart;
      if (duration < 200) {
        if (this._chatRecording) {
          stopRecording(cancelled);
        } else {
          startRecording();
        }
      } else {
        stopRecording(cancelled);
      }
    });
  },

  /** A recording into words, put in the message box; a failure says why, by the box. */
  async _dictate(blob, btn) {
    this._hideNote();
    btn?.classList.add("voice-transcribing");
    let result;
    try {
      result = await SpeechToText.transcribe(blob, "recording.webm");
    } finally {
      btn?.classList.remove("voice-transcribing");
    }
    if (!result.ok) {
      console.warn("[voice] dictation failed:", result.kind, result.reason);
      this._showNote(SpeechToText.explain(result), () => this._dictate(blob, btn));
      return;
    }
    if (result.text) this._insertIntoBox(result.text);
  },

  /**
   * The words go in at the caret, added to what is typed (a selection stays: they go after it), with a space either
   * side where one is needed. The box gets the focus; on a phone without the keyboard popping up, until the box is
   * tapped.
   */
  _insertIntoBox(words) {
    const input = document.getElementById("messageInput");
    if (!input) return;
    const value = input.value;
    const at = Math.min(Number.isInteger(input.selectionEnd) ? input.selectionEnd : value.length, value.length);
    const before = value.slice(0, at);
    const after = value.slice(at);
    const lead = before && !/\s$/.test(before) ? " " : "";
    const trail = after && !/^[\s.,!?;:)]/.test(after) ? " " : "";
    input.value = before + lead + words + trail + after;
    const caret = (before + lead + words).length;
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
  },

  /** By the message box: why dictation failed, and what to do (Open Settings → Voice, or Try again). */
  _showNote(info, retry) {
    let note = document.getElementById("micNote");
    if (!note) {
      note = document.createElement("div");
      note.id = "micNote";
      note.className = "mic-note";
      note.setAttribute("role", "alert");
      const area = document.getElementById("inputArea");
      const composer = area?.querySelector(".input-container");
      if (!area) return;
      area.insertBefore(note, composer || null);
    }
    note.innerHTML = "";
    const text = document.createElement("div");
    text.className = "mic-note-text";
    const title = document.createElement("strong");
    title.textContent = info.title;
    text.appendChild(title);
    if (info.reason) {
      const reason = document.createElement("span");
      reason.className = "mic-note-reason";
      reason.textContent = info.reason;
      text.appendChild(reason);
    }
    const actions = document.createElement("div");
    actions.className = "mic-note-actions";
    const button = (label, onClick, extra = "") => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `mic-note-btn ${extra}`.trim();
      b.textContent = label;
      b.addEventListener("click", onClick);
      actions.appendChild(b);
      return b;
    };
    if (info.settings) button(SpeechToText.SETTINGS_LABEL, () => { this._hideNote(); SpeechToText.openSettings(); });
    if (info.retry && retry) button("Try again", () => retry());
    const close = button("×", () => this._hideNote(), "mic-note-close");
    close.setAttribute("aria-label", "Close");
    close.title = "Close";
    note.append(text, actions);
    note.hidden = false;
  },

  _hideNote() {
    const note = document.getElementById("micNote");
    if (note) note.hidden = true;
  },
};

/**
 * Speech-to-text from the page: POST /api/voice/transcribe, with what Settings > Voice has chosen (faster-whisper on
 * the server, or the OpenAI Whisper API). Dictation (Voice above) and calls (js/call.js) both use it, so both say
 * why it failed the same way.
 */
const SpeechToText = {
  SETTINGS_LABEL: "Open Settings → Voice",

  /**
   * { ok: true, text }, or { ok: false, kind, reason }. kind: "not-set-up" (nothing on the server can turn speech into
   * words: HTTP 501), "failed" (it tried and couldn't), "network" (no answer from Tarsee). reason: the server's own
   * words, which say what to change.
   */
  async transcribe(blob, filename = "recording.webm") {
    let res;
    let body = {};
    try {
      const fd = new FormData();
      fd.append("audio", blob, filename);
      const csrf = API.getCsrfToken() || await API.refreshCsrf?.();
      res = await fetch("/api/voice/transcribe", { method: "POST", headers: csrf ? { "X-CSRF-Token": csrf } : {}, credentials: "same-origin", body: fd });
      body = await res.json().catch(() => ({}));
    } catch (err) {
      return { ok: false, kind: "network", reason: String(err?.message || "") };
    }
    if (res.ok) return { ok: true, text: String(body.text || "").trim() };
    const reason = String(body.error || "").trim() || `The server answered ${res.status}.`;
    return { ok: false, kind: res.status === 501 || body.code === "stt-unavailable" ? "not-set-up" : "failed", reason };
  },

  /**
   * A failure in plain words: { title, reason, settings, retry }. settings: Settings → Voice can fix it; retry: trying
   * the same recording again may work. call: { name } for a call's wording (it can't hear you), else dictation's.
   */
  explain(result, { call = null } = {}) {
    const k = result?.kind;
    if (k === "network") {
      return {
        title: call ? "Couldn't reach Tarsee to hear that. Check the connection." : "Couldn't reach Tarsee, so the recording wasn't turned into words. Check the connection and try again.",
        reason: "", settings: false, retry: true,
      };
    }
    if (k === "not-set-up") {
      return {
        title: call ? `Speech-to-text isn't set up, so ${call.name} can't hear you.` : "Speech-to-text isn't set up, so the recording can't be turned into words.",
        reason: result.reason || "", settings: true, retry: false,
      };
    }
    return {
      title: call ? "Didn't catch that: speech-to-text failed. Say it again?" : "Speech-to-text failed, so the recording wasn't turned into words.",
      reason: result?.reason || "", settings: true, retry: true,
    };
  },

  /** Settings on the Voice tab, at speech-to-text. */
  async openSettings() {
    if (typeof Settings === "undefined") return;
    if (!Settings.isOpen) await Settings.open();
    Settings.switchTab("voice");
    const stt = document.getElementById("settingsSTTProvider")?.closest(".settings-section");
    (stt || document.querySelector('.settings-tab-panel[data-tab="voice"]'))?.scrollIntoView?.({ block: "start" });
  },
};
