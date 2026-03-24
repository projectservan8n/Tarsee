/**
 * Voice mode module.
 * Continuous conversational voice interface with Whisper transcription,
 * AI chat integration, and TTS playback.
 */
const Voice = {
  isListening: false,
  isRecording: false,
  isSpeaking: false,
  isProcessing: false,
  mediaRecorder: null,
  audioChunks: [],
  stream: null,
  autoListen: true,

  elements: {},

  init() {
    this.elements = {
      panel: document.getElementById("voicePanel"),
      conversation: document.getElementById("voiceConversation"),
      orb: document.getElementById("voiceOrb"),
      status: document.getElementById("voiceStatus"),
      micBtn: document.getElementById("voiceMicBtn"),
      closeBtn: document.getElementById("voiceClose"),
      modeBtn: document.getElementById("voiceModeBtn"),
      audio: document.getElementById("voiceAudio"),
      voiceInputBtn: document.getElementById("voiceInputBtn"),
    };

    // Event listeners
    this.elements.modeBtn?.addEventListener("click", () => this.open());
    this.elements.closeBtn?.addEventListener("click", () => this.close());
    this.elements.micBtn?.addEventListener("click", () => this.toggleRecording());
    this.elements.orb?.addEventListener("click", () => this.toggleRecording());

    // Auto-restart listening after TTS ends
    this.elements.audio.addEventListener("ended", () => {
      this.isSpeaking = false;
      this.setOrbState("idle");
      this.elements.status.textContent = "Tap to speak";
      if (this.autoListen && this.elements.panel.classList.contains("active")) {
        setTimeout(() => this.startRecording(), 400);
      }
    });

    // Voice input button in chat input (quick dictation, not full voice mode)
    this.elements.voiceInputBtn?.addEventListener("click", () => {
      this.quickListen();
    });
  },

  /**
   * Open voice panel and start listening.
   */
  open() {
    this.elements.panel.classList.add("active");
    this.autoListen = true;
    this.elements.status.textContent = "Starting...";
    setTimeout(() => this.startRecording(), 300);
  },

  /**
   * Close voice panel and stop everything.
   */
  close() {
    this.autoListen = false;
    this.stopRecording(true); // discard
    this.stopSpeaking();
    this.elements.panel.classList.remove("active");
    // Clear conversation bubbles
    if (this.elements.conversation) {
      this.elements.conversation.innerHTML = "";
    }
  },

  /**
   * Toggle recording on/off.
   */
  toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
    } else if (!this.isSpeaking && !this.isProcessing) {
      this.startRecording();
    }
  },

  /**
   * Start recording audio with MediaRecorder.
   */
  async startRecording() {
    if (this.isRecording || this.isProcessing || this.isSpeaking) return;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      console.error("[voice] Microphone access denied:", err);
      this.elements.status.textContent = "Microphone access denied";
      this.setOrbState("idle");
      return;
    }

    this.audioChunks = [];

    // Prefer webm/opus, fall back to whatever is available
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm")
        ? "audio/webm"
        : "";

    this.mediaRecorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : {});

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.audioChunks.push(e.data);
    };

    this.mediaRecorder.onstop = () => {
      // Release mic
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = null;
    };

    this.mediaRecorder.start();
    this.isRecording = true;
    this.setOrbState("listening");
    this.elements.status.textContent = "Listening...";
    this.elements.micBtn?.classList.add("active");
  },

  /**
   * Stop recording and send audio to Whisper for transcription.
   * @param {boolean} discard - If true, discard the recording.
   */
  stopRecording(discard = false) {
    if (!this.isRecording || !this.mediaRecorder) return;

    this.isRecording = false;
    this.elements.micBtn?.classList.remove("active");

    if (discard) {
      this.mediaRecorder.stop();
      this.setOrbState("idle");
      this.elements.status.textContent = "Tap to start";
      return;
    }

    // Capture onstop to send audio
    const recorder = this.mediaRecorder;

    recorder.onstop = () => {
      // Clean up mic
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = null;

      if (this.audioChunks.length === 0) {
        this.setOrbState("idle");
        this.elements.status.textContent = "No audio captured";
        return;
      }

      const blob = new Blob(this.audioChunks, { type: recorder.mimeType || "audio/webm" });
      this.audioChunks = [];
      this.sendToWhisper(blob);
    };

    recorder.stop();
  },

  /**
   * Send audio blob to /api/voice/transcribe (Whisper) for transcription.
   */
  async sendToWhisper(audioBlob) {
    this.isProcessing = true;
    this.setOrbState("processing");
    this.elements.status.textContent = "Transcribing...";

    try {
      const formData = new FormData();
      formData.append("audio", audioBlob, "recording.webm");

      const csrf = API.getCsrfToken();
      const headers = {};
      if (csrf) headers["X-CSRF-Token"] = csrf;

      const res = await fetch("/api/voice/transcribe", {
        method: "POST",
        headers,
        credentials: "same-origin",
        body: formData,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Transcription failed (${res.status})`);
      }

      const data = await res.json();
      const text = data.text?.trim();

      if (!text) {
        this.isProcessing = false;
        this.setOrbState("idle");
        this.elements.status.textContent = "Didn't catch that. Tap to try again.";
        return;
      }

      this.handleTranscript(text);
    } catch (err) {
      console.error("[voice] Whisper transcription error:", err);
      this.isProcessing = false;
      this.setOrbState("idle");
      this.elements.status.textContent = "Transcription error: " + err.message;
    }
  },

  /**
   * Handle transcribed text: show as user bubble, send to AI.
   */
  async handleTranscript(text) {
    this.addBubble("user", text);
    this.setOrbState("processing");
    this.elements.status.textContent = "Thinking...";

    let fullResponse = "";

    try {
      await API.sendMessage(
        Chat.currentConversationId,
        text,
        // onText (streaming chunks)
        (content) => {
          fullResponse += content;
        },
        // onDone
        async (data) => {
          if (data?.conversationId) {
            Chat.currentConversationId = data.conversationId;
          }
          Chat.loadConversations?.();

          this.isProcessing = false;
          this.handleAIResponse(fullResponse);
        },
        // onError
        (error) => {
          this.isProcessing = false;
          this.setOrbState("idle");
          this.elements.status.textContent = "Error: " + error;
          this.addBubble("assistant", "Sorry, something went wrong.");
        }
      );
    } catch (err) {
      this.isProcessing = false;
      this.setOrbState("idle");
      this.elements.status.textContent = "Error: " + err.message;
      this.addBubble("assistant", "Sorry, something went wrong.");
    }
  },

  /**
   * Handle AI response: detect if conversational or complex, route accordingly.
   */
  handleAIResponse(text) {
    if (!text?.trim()) {
      this.setOrbState("idle");
      this.elements.status.textContent = "Tap to speak";
      return;
    }

    if (this.isComplexResponse(text)) {
      // Complex response — speak a summary, show full content in main chat
      this.addBubble("assistant", "I've sent the details to the chat.");
      this.speak("I've added the details to your chat. Take a look when you're ready.");

      // Refresh the main chat to show the full response
      if (Chat.currentConversationId) {
        Chat.loadMessages?.(Chat.currentConversationId);
      }
    } else {
      // Conversational response — show and speak it
      this.addBubble("assistant", text);
      this.speak(text);
    }
  },

  /**
   * Detect if a response is "complex" (code, tables, long lists, lengthy text).
   * Returns true if the text has code blocks, tables, long lists, or is over 500 chars.
   */
  isComplexResponse(text) {
    // Code blocks
    if (/```[\s\S]*?```/.test(text)) return true;

    // Tables (markdown pipe tables)
    if (/\|.*\|.*\|/.test(text) && /[-]{3,}/.test(text)) return true;

    // Long lists (more than 3 items with - or * or numbered)
    const listItems = text.match(/^[\s]*[-*]\s+.+/gm) || [];
    const numberedItems = text.match(/^[\s]*\d+[.)]\s+.+/gm) || [];
    if (listItems.length > 3 || numberedItems.length > 3) return true;

    // Long text
    if (text.length > 500) return true;

    return false;
  },

  /**
   * Speak text via TTS API. Sets speaking state and plays audio.
   */
  async speak(text) {
    if (!text?.trim()) return;

    this.isSpeaking = true;
    this.setOrbState("speaking");
    this.elements.status.textContent = "Speaking...";

    try {
      const audioBlob = await API.tts(text);
      const audioUrl = URL.createObjectURL(audioBlob);
      this.elements.audio.src = audioUrl;
      await this.elements.audio.play();

      // Clean up object URL after playback (handled in 'ended' event)
      this.elements.audio.addEventListener("ended", () => {
        URL.revokeObjectURL(audioUrl);
      }, { once: true });
    } catch (err) {
      console.warn("[voice] TTS not available:", err.message);
      this.isSpeaking = false;
      this.setOrbState("idle");
      this.elements.status.textContent = "TTS unavailable. Tap to speak.";
      // Auto-listen even if TTS fails
      if (this.autoListen && this.elements.panel.classList.contains("active")) {
        setTimeout(() => this.startRecording(), 1000);
      }
    }
  },

  /**
   * Stop any currently playing TTS audio.
   */
  stopSpeaking() {
    this.elements.audio.pause();
    this.elements.audio.currentTime = 0;
    this.isSpeaking = false;
    this.setOrbState("idle");
  },

  /**
   * Add a conversation bubble to the voice panel.
   * @param {"user"|"assistant"} role
   * @param {string} text
   */
  addBubble(role, text) {
    const container = this.elements.conversation;
    if (!container) return;

    const turn = document.createElement("div");
    turn.className = `voice-turn ${role}`;

    const label = document.createElement("div");
    label.className = "voice-turn-label";
    label.textContent = role === "user" ? "You" : "Assistant";

    const bubble = document.createElement("div");
    bubble.className = "voice-turn-text";
    bubble.textContent = text;

    turn.appendChild(label);
    turn.appendChild(bubble);
    container.appendChild(turn);

    // Auto-scroll to bottom
    container.scrollTop = container.scrollHeight;
  },

  /**
   * Set the orb visual state.
   * @param {"idle"|"listening"|"processing"|"speaking"} state
   */
  setOrbState(state) {
    const orb = this.elements.orb;
    if (!orb) return;
    orb.classList.remove("idle", "listening", "processing", "speaking");
    orb.classList.add(state);
  },

  /**
   * Quick listen from the chat input (not full voice mode).
   * Uses MediaRecorder + Whisper for accuracy.
   */
  async quickListen() {
    if (this.isRecording) {
      // Stop and transcribe into input
      this.isRecording = false;
      this.elements.voiceInputBtn?.classList.remove("voice-active");

      if (this._quickRecorder) {
        this._quickRecorder.stop();
      }
      return;
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      App.showToast("Microphone access denied", "error");
      return;
    }

    this.isRecording = true;
    this.elements.voiceInputBtn?.classList.add("voice-active");

    const chunks = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "";

    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    this._quickRecorder = recorder;

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      this.isRecording = false;
      this.elements.voiceInputBtn?.classList.remove("voice-active");
      this._quickRecorder = null;

      if (chunks.length === 0) return;

      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });

      try {
        const formData = new FormData();
        formData.append("audio", blob, "recording.webm");

        const csrf = API.getCsrfToken();
        const headers = {};
        if (csrf) headers["X-CSRF-Token"] = csrf;

        const res = await fetch("/api/voice/transcribe", {
          method: "POST",
          headers,
          credentials: "same-origin",
          body: formData,
        });

        if (!res.ok) throw new Error("Transcription failed");

        const data = await res.json();
        const text = data.text?.trim();
        if (text) {
          const input = document.getElementById("messageInput");
          input.value += (input.value ? " " : "") + text;
          input.dispatchEvent(new Event("input"));
        }
      } catch (err) {
        console.error("[voice] Quick listen transcription error:", err);
        App.showToast("Could not transcribe audio", "error");
      }
    };

    recorder.start();
  },
};
