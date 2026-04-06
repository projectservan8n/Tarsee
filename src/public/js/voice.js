/**
 * Voice mode module.
 * Hold-to-talk or click-to-toggle with waveform visualization.
 * Uses Whisper STT + ElevenLabs v3 TTS with conversational emotions.
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
  analyser: null,
  waveformAnim: null,
  holdTimer: null,
  isHolding: false,

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
      waveform: document.getElementById("voiceWaveform"),
    };

    // Event listeners
    this.elements.modeBtn?.addEventListener("click", () => this.open());
    this.elements.closeBtn?.addEventListener("click", () => this.close());

    // Orb: hold-to-talk (mousedown + mouseup) or click-to-toggle (quick click)
    const orb = this.elements.orb;
    if (orb) {
      let pressStart = 0;
      orb.addEventListener("mousedown", (e) => { e.preventDefault(); pressStart = Date.now(); this.onPressStart(); });
      orb.addEventListener("mouseup", () => { this.onPressEnd(Date.now() - pressStart); });
      orb.addEventListener("mouseleave", () => { if (this.isHolding) this.onPressEnd(500); });
      // Touch support
      orb.addEventListener("touchstart", (e) => { e.preventDefault(); pressStart = Date.now(); this.onPressStart(); });
      orb.addEventListener("touchend", () => { this.onPressEnd(Date.now() - pressStart); });
    }

    // Auto-restart listening after TTS ends
    this.elements.audio.addEventListener("ended", () => {
      this.isSpeaking = false;
      this.setOrbState("idle");
      this.elements.status.textContent = "Hold to talk";
      if (this.autoListen && this.elements.panel.classList.contains("active")) {
        setTimeout(() => this.startRecording(), 400);
      }
    });

    // Voice input button in chat input (quick dictation)
    this.elements.voiceInputBtn?.addEventListener("click", () => this.quickListen());
  },

  /** Handle press start — start recording after short delay (hold detection). */
  onPressStart() {
    this.isHolding = true;
    this.holdTimer = setTimeout(() => {
      if (this.isHolding && !this.isRecording && !this.isSpeaking && !this.isProcessing) {
        this.startRecording();
      }
    }, 150); // 150ms = hold threshold
  },

  /** Handle press end — if quick click, toggle. If held, stop recording. */
  onPressEnd(duration) {
    this.isHolding = false;
    clearTimeout(this.holdTimer);

    if (duration < 150) {
      // Quick click — toggle recording
      this.toggleRecording();
    } else if (this.isRecording) {
      // Released after hold — stop and send
      this.stopRecording();
    }
  },

  open() {
    this.elements.panel.classList.add("active");
    this.autoListen = true;
    this.elements.status.textContent = "Hold to talk · Click to toggle";

    const label = document.getElementById("voiceActiveLabel");
    if (label) {
      const voiceId = localStorage.getItem("voice.defaultVoiceId");
      if (voiceId) {
        label.textContent = `Voice: ${voiceId}`;
        API.getVoices?.().then((data) => {
          const match = data?.voices?.find((v) => v.id === voiceId);
          if (match) label.textContent = `Voice: ${match.name || voiceId}`;
        }).catch(() => {});
      } else {
        label.textContent = "";
      }
    }

    setTimeout(() => this.startRecording(), 300);
  },

  close() {
    this.autoListen = false;
    this.stopRecording(true);
    this.stopSpeaking();
    this.stopWaveform();
    this.elements.panel.classList.remove("active");
    if (this.elements.conversation) this.elements.conversation.innerHTML = "";
  },

  toggleRecording() {
    if (this.isRecording) {
      this.stopRecording();
    } else if (!this.isSpeaking && !this.isProcessing) {
      this.startRecording();
    }
  },

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
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "";

    this.mediaRecorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : {});

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.audioChunks.push(e.data);
    };

    this.mediaRecorder.onstop = () => {
      this.stream?.getTracks().forEach((t) => t.stop());
      this.stream = null;
    };

    this.mediaRecorder.start();
    this.isRecording = true;
    this.setOrbState("listening");
    this.elements.status.textContent = "Listening...";
    this.elements.micBtn?.classList.add("active");

    // Start waveform visualization
    this.startWaveform();
  },

  stopRecording(discard = false) {
    if (!this.isRecording || !this.mediaRecorder) return;

    this.isRecording = false;
    this.elements.micBtn?.classList.remove("active");
    this.stopWaveform();

    if (discard) {
      this.mediaRecorder.stop();
      this.setOrbState("idle");
      this.elements.status.textContent = "Hold to talk";
      return;
    }

    const recorder = this.mediaRecorder;
    recorder.onstop = () => {
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

  /** Start waveform visualization from mic input. */
  startWaveform() {
    const canvas = this.elements.waveform;
    if (!canvas || !this.stream) return;

    const ctx = canvas.getContext("2d");
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioCtx.createMediaStreamSource(this.stream);
    this.analyser = audioCtx.createAnalyser();
    this.analyser.fftSize = 128;
    source.connect(this.analyser);

    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    const draw = () => {
      if (!this.isRecording) return;
      this.waveformAnim = requestAnimationFrame(draw);

      this.analyser.getByteFrequencyData(dataArray);

      ctx.clearRect(0, 0, canvas.width, canvas.height);

      const barWidth = (canvas.width / bufferLength) * 1.5;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * canvas.height * 0.9;
        const hue = 35; // amber
        const lightness = 40 + (dataArray[i] / 255) * 30;
        ctx.fillStyle = `hsl(${hue}, 90%, ${lightness}%)`;
        ctx.fillRect(x, (canvas.height - barHeight) / 2, barWidth - 1, barHeight || 1);
        x += barWidth;
      }
    };
    draw();

    this._audioCtx = audioCtx;
  },

  /** Stop waveform visualization. */
  stopWaveform() {
    if (this.waveformAnim) cancelAnimationFrame(this.waveformAnim);
    this.waveformAnim = null;
    if (this._audioCtx) { this._audioCtx.close().catch(() => {}); this._audioCtx = null; }
    const canvas = this.elements.waveform;
    if (canvas) canvas.getContext("2d").clearRect(0, 0, canvas.width, canvas.height);
  },

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

      let res;
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          this.elements.status.textContent = `Retrying (${attempt}/2)...`;
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
        res = await fetch("/api/voice/transcribe", { method: "POST", headers, credentials: "same-origin", body: formData });
        if (res.ok || (res.status !== 503 && res.status !== 429)) break;
      }

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `Transcription failed (${res.status})`);
      }

      const data = await res.json();
      const text = data.text?.trim();
      if (!text) {
        this.isProcessing = false;
        this.setOrbState("idle");
        this.elements.status.textContent = "Didn't catch that. Try again.";
        return;
      }
      this.handleTranscript(text);
    } catch (err) {
      console.error("[voice] Whisper error:", err);
      this.isProcessing = false;
      this.setOrbState("idle");
      this.elements.status.textContent = "Error: " + err.message;
    }
  },

  async handleTranscript(text) {
    this.addBubble("user", text);
    this.setOrbState("processing");
    this.elements.status.textContent = "Thinking...";

    // Prefix with voice mode tag so backend adds conversational style
    const voiceText = `[voice] ${text}`;

    let fullResponse = "";
    try {
      await API.sendMessage(
        Chat.currentConversationId, voiceText,
        (content) => { fullResponse += content; },
        async (data) => {
          if (data?.conversationId) Chat.currentConversationId = data.conversationId;
          Chat.loadConversations?.();
          this.isProcessing = false;
          this.handleAIResponse(fullResponse);
        },
        (error) => {
          this.isProcessing = false;
          this.setOrbState("idle");
          this.elements.status.textContent = "Error: " + error;
          this.addBubble("assistant", "Something went wrong.");
        }
      );
    } catch (err) {
      this.isProcessing = false;
      this.setOrbState("idle");
      this.elements.status.textContent = "Error: " + err.message;
    }
  },

  handleAIResponse(text) {
    if (!text?.trim()) {
      this.setOrbState("idle");
      this.elements.status.textContent = "Hold to talk";
      return;
    }

    if (this.isComplexResponse(text)) {
      this.addBubble("assistant", "Details sent to chat.");
      this.speak("Check the chat for details.");
      if (Chat.currentConversationId) Chat.loadMessages?.(Chat.currentConversationId);
    } else {
      // Strip emotion markers from display bubble but keep for TTS
      const displayText = text.replace(/\[(laughs|sighs|chuckles|whispers|gasps|clears throat)\]/gi, "").replace(/\s{2,}/g, " ").trim();
      this.addBubble("assistant", displayText);
      // Keep emotion markers in speak text — ElevenLabs v3 vocalizes them
      const speakText = text
        .replace(/\*\*(.*?)\*\*/g, "$1")
        .replace(/\*(.*?)\*/g, "$1")
        .replace(/#{1,6}\s+/g, "")
        .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
        .replace(/^[-*]\s+/gm, "")
        .trim();
      this.speak(speakText);
    }
  },

  isComplexResponse(text) {
    if (/```[\s\S]*?```/.test(text)) return true;
    if (/\|.*\|.*\|/.test(text) && /[-]{3,}/.test(text)) return true;
    if (text.length > 2000) return true;
    return false;
  },

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
      this.elements.audio.addEventListener("ended", () => URL.revokeObjectURL(audioUrl), { once: true });
    } catch (err) {
      console.warn("[voice] TTS error:", err.message);
      this.isSpeaking = false;
      this.setOrbState("idle");
      this.elements.status.textContent = "TTS unavailable";
      if (this.autoListen && this.elements.panel.classList.contains("active")) {
        setTimeout(() => this.startRecording(), 1000);
      }
    }
  },

  stopSpeaking() {
    this.elements.audio.pause();
    this.elements.audio.currentTime = 0;
    this.isSpeaking = false;
    this.setOrbState("idle");
  },

  addBubble(role, text) {
    const container = this.elements.conversation;
    if (!container) return;
    const turn = document.createElement("div");
    turn.className = `voice-turn ${role}`;
    const label = document.createElement("div");
    label.className = "voice-turn-label";
    label.textContent = role === "user" ? "You" : "Tarsee";
    const bubble = document.createElement("div");
    bubble.className = "voice-turn-text";
    bubble.textContent = text;
    turn.appendChild(label);
    turn.appendChild(bubble);
    container.appendChild(turn);
    container.scrollTop = container.scrollHeight;
  },

  setOrbState(state) {
    const orb = this.elements.orb;
    if (!orb) return;
    orb.classList.remove("idle", "listening", "processing", "speaking");
    orb.classList.add(state);
  },

  /** Quick listen from chat input mic button. */
  async quickListen() {
    if (this.isRecording) {
      this.isRecording = false;
      this.elements.voiceInputBtn?.classList.remove("voice-active");
      if (this._quickRecorder) this._quickRecorder.stop();
      return;
    }

    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { App.showToast("Microphone access denied", "error"); return; }

    this.isRecording = true;
    this.elements.voiceInputBtn?.classList.add("voice-active");

    const chunks = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "";
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
    this._quickRecorder = recorder;

    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
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
        const res = await fetch("/api/voice/transcribe", { method: "POST", headers, credentials: "same-origin", body: formData });
        if (!res.ok) throw new Error("Transcription failed");
        const data = await res.json();
        const text = data.text?.trim();
        if (text) {
          const input = document.getElementById("messageInput");
          input.value += (input.value ? " " : "") + text;
          input.dispatchEvent(new Event("input"));
        }
      } catch (err) {
        console.error("[voice] Quick listen error:", err);
        App.showToast("Could not transcribe audio", "error");
      }
    };
    recorder.start();
  },
};
