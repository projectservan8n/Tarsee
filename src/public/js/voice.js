/**
 * Voice mode module.
 * Hold-to-talk or click-to-toggle with waveform visualization.
 * Drag away to cancel recording (both voice mode orb + chat mic button).
 * Uses Whisper STT + Edge TTS / ElevenLabs TTS.
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
  _dragCancelled: false,

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

    // Orb: hold-to-talk + click-to-toggle + drag-to-cancel
    this._initOrbDrag();

    // Chat mic button: hold-to-record + click-to-toggle + drag-to-cancel
    this._initChatMicDrag();

    // Keyboard: spacebar hold/toggle + space+c to cancel (voice mode only)
    this._initKeyboard();
  },

  /** Spacebar hold-to-talk / toggle + Space+C to cancel in voice mode. */
  _initKeyboard() {
    let spaceDown = false;
    let spaceStart = 0;

    document.addEventListener("keydown", (e) => {
      // Only when voice panel is open and not typing in an input
      if (!this.elements.panel?.classList.contains("active")) return;
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if (e.code === "Space" && !spaceDown) {
        e.preventDefault();
        spaceDown = true;
        spaceStart = Date.now();
        this.onPressStart();
      }

      // Space + C = cancel
      if (e.code === "KeyC" && spaceDown && this.isRecording) {
        e.preventDefault();
        spaceDown = false;
        clearTimeout(this.holdTimer);
        this.isHolding = false;
        this.stopRecording(true);
        this.elements.status.textContent = "Cancelled";
        setTimeout(() => {
          if (!this.isRecording && !this.isProcessing && !this.isSpeaking) {
            this.elements.status.textContent = "Hold to talk · Tap to toggle";
          }
        }, 1000);
      }
    });

    document.addEventListener("keyup", (e) => {
      if (e.code === "Space" && spaceDown) {
        e.preventDefault();
        spaceDown = false;
        this.onPressEnd(Date.now() - spaceStart);
      }
    });
  },

  /** Set up orb drag-to-cancel (voice mode). */
  _initOrbDrag() {
    const orb = this.elements.orb;
    if (!orb) return;

    let pressStart = 0;
    let startX = 0, startY = 0;
    this._dragCancelled = false;

    const CANCEL_DISTANCE = 80;

    const onMove = (x, y) => {
      if (!this.isHolding && !this.isRecording) return;
      const dx = x - startX;
      const dy = y - startY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist > CANCEL_DISTANCE) {
        if (!this._dragCancelled) {
          this._dragCancelled = true;
          this.elements.status.textContent = "Release to cancel";
          orb.classList.add("drag-cancel");
        }
      } else {
        if (this._dragCancelled) {
          this._dragCancelled = false;
          this.elements.status.textContent = "Listening...";
          orb.classList.remove("drag-cancel");
        }
      }
    };

    // Mouse
    orb.addEventListener("mousedown", (e) => {
      e.preventDefault();
      pressStart = Date.now();
      startX = e.clientX; startY = e.clientY;
      this._dragCancelled = false;
      this.onPressStart();
      const mousemove = (e2) => onMove(e2.clientX, e2.clientY);
      const mouseup = () => {
        document.removeEventListener("mousemove", mousemove);
        document.removeEventListener("mouseup", mouseup);
        this.onPressEnd(Date.now() - pressStart);
      };
      document.addEventListener("mousemove", mousemove);
      document.addEventListener("mouseup", mouseup);
    });

    // Touch
    orb.addEventListener("touchstart", (e) => {
      e.preventDefault();
      pressStart = Date.now();
      const touch = e.touches[0];
      startX = touch.clientX; startY = touch.clientY;
      this._dragCancelled = false;
      this.onPressStart();
    });
    orb.addEventListener("touchmove", (e) => {
      const touch = e.touches[0];
      onMove(touch.clientX, touch.clientY);
    });
    orb.addEventListener("touchend", () => {
      this.onPressEnd(Date.now() - pressStart);
    });
  },

  /** Set up chat mic button: hold-to-record + tap-to-toggle + drag-to-cancel. */
  _initChatMicDrag() {
    const btn = this.elements.voiceInputBtn;
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
      if (this.isRecording || this._chatRecording) return;

      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
      catch { App.showToast("Microphone access denied", "error"); return; }

      this._chatRecording = true;
      this._chatCancelled = false;
      btn.classList.add("voice-active");
      cancelHint.style.display = "flex";
      startTimer();

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

        // Transcribe and send as chat message
        const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        btn.classList.add("voice-transcribing");
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
            // Auto-send as a message (like Telegram voice)
            const input = document.getElementById("messageInput");
            input.value = text;
            input.dispatchEvent(new Event("input"));
            Chat.send();
          }
        } catch (err) {
          console.error("[voice] Chat mic error:", err);
          App.showToast("Could not transcribe audio", "error");
        } finally {
          btn.classList.remove("voice-transcribing");
        }
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

  /** Handle press start — start recording after short delay (hold detection). */
  onPressStart() {
    this.isHolding = true;
    this.holdTimer = setTimeout(() => {
      if (this.isHolding && !this.isRecording && !this.isSpeaking && !this.isProcessing) {
        this.startRecording();
      }
    }, 150);
  },

  /** Handle press end — if quick click, toggle. If held, stop recording. */
  onPressEnd(duration) {
    this.isHolding = false;
    clearTimeout(this.holdTimer);

    if (this._dragCancelled) {
      // Drag cancel — discard recording
      this._dragCancelled = false;
      this.elements.orb?.classList.remove("drag-cancel");
      this.stopRecording(true);
      this.elements.status.textContent = "Cancelled";
      setTimeout(() => {
        if (!this.isRecording && !this.isProcessing && !this.isSpeaking) {
          this.elements.status.textContent = "Hold to talk · Tap to toggle";
        }
      }, 1000);
      return;
    }

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
    this.autoListen = false;
    this.elements.status.textContent = "Hold to talk · Tap to toggle";

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

    // Prime audio element with user gesture (iOS requires this)
    this.elements.audio.load();
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
    this.elements.status.textContent = "Listening... drag away to cancel";
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

  /** Show waveform from audio playback (agent speaking). */
  startSpeakingWaveform(audioEl) {
    const canvas = this.elements.waveform;
    if (!canvas) return;

    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaElementSource(audioEl);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 128;
      source.connect(analyser);
      analyser.connect(audioCtx.destination);

      const ctx = canvas.getContext("2d");
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const draw = () => {
        if (!this.isSpeaking) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          audioCtx.close().catch(() => {});
          return;
        }
        this._speakAnim = requestAnimationFrame(draw);
        analyser.getByteFrequencyData(dataArray);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const barWidth = (canvas.width / bufferLength) * 1.5;
        let x = 0;
        for (let i = 0; i < bufferLength; i++) {
          const barHeight = (dataArray[i] / 255) * canvas.height * 0.9;
          const lightness = 40 + (dataArray[i] / 255) * 30;
          ctx.fillStyle = `hsl(200, 80%, ${lightness}%)`;
          ctx.fillRect(x, (canvas.height - barHeight) / 2, barWidth - 1, barHeight || 1);
          x += barWidth;
        }
      };
      draw();
    } catch {
      // AudioContext not available — skip waveform
    }
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
    this._startThinkingAnimation();

    const voiceText = `[voice] ${text}`;
    let fullResponse = "";

    try {
      await API.sendMessage(
        Chat.currentConversationId, voiceText,
        (content, event) => {
          if (content) fullResponse += content;
          if (event) this._handleVoiceEvent(event);
        },
        async (data) => {
          if (data?.type === "conversation") {
            Chat.currentConversationId = data.conversationId;
            return; // Don't process conversation events as "done"
          }
          if (data?.conversationId) Chat.currentConversationId = data.conversationId;
          this.isProcessing = false;
          this._stopThinkingAnimation();

          if (!fullResponse?.trim()) {
            this.setOrbState("idle");
            this.elements.status.textContent = "Hold to talk";
            return;
          }

          // Show full response visually (tables, code, formatting all visible)
          this.addBubble("assistant", fullResponse);

          // Clean response for TTS — strip non-speakable content
          const speakText = this.makeSpokenText(fullResponse);

          if (!speakText || speakText.length < 3) {
            this.setOrbState("idle");
            this.elements.status.textContent = "Hold to talk";
            return;
          }

          this.speak(speakText);
        },
        (error) => {
          this.isProcessing = false;
          this.setOrbState("idle");
          this.elements.status.textContent = "Error: " + error;
        }
      );
    } catch (err) {
      this.isProcessing = false;
      this.setOrbState("idle");
      this.elements.status.textContent = "Error: " + err.message;
    }
  },

  /** Speak text via streaming TTS. Retries once on failure. */
  async speak(text) {
    if (!text?.trim()) return;
    this.isSpeaking = true;
    this.setOrbState("speaking");
    this.elements.status.textContent = "Speaking...";

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const csrf = API.getCsrfToken();
        const headers = { "Content-Type": "application/json" };
        if (csrf) headers["X-CSRF-Token"] = csrf;

        // Abort if TTS fetch takes too long (12s — Edge TTS should respond in <5s)
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12_000);

        const res = await fetch("/api/voice/tts-stream", {
          method: "POST",
          headers,
          credentials: "same-origin",
          body: JSON.stringify({ text }),
          signal: controller.signal,
        });
        clearTimeout(timeout);

        if (!res.ok) throw new Error("TTS failed");

        const audioBlob = await res.blob();
        if (audioBlob.size < 100) throw new Error("Empty audio");

        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = this.elements.audio;
        audio.src = audioUrl;
        audio.onended = () => { URL.revokeObjectURL(audioUrl); this.isSpeaking = false; this.setOrbState("idle"); this.elements.status.textContent = "Hold to talk"; };
        audio.onerror = () => { URL.revokeObjectURL(audioUrl); this.isSpeaking = false; this.setOrbState("idle"); };
        await audio.play().catch(() => { this.isSpeaking = false; this.setOrbState("idle"); });

        // Safety timeout
        const estimatedMs = Math.max(3000, (text.length / 5 / 150) * 60000 + 2000);
        setTimeout(() => { if (this.isSpeaking) { this.isSpeaking = false; this.setOrbState("idle"); this.elements.status.textContent = "Hold to talk"; } }, estimatedMs);
        return; // Success — exit retry loop
      } catch (err) {
        console.warn(`[voice] TTS attempt ${attempt + 1} failed:`, err.message);
        if (attempt === 0 && text.length > 80) {
          // Retry with much shorter text
          text = text.slice(0, 80) + ". Check chat for details.";
          continue;
        }
      }
    }
    // Both attempts failed — show response in chat, don't block
    this.isSpeaking = false;
    this.setOrbState("idle");
    this.elements.status.textContent = "Response in chat · Hold to talk";
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
    // Render markdown for assistant, plain text for user
    if (role === "assistant" && typeof Chat !== "undefined" && Chat.renderMarkdown) {
      bubble.innerHTML = Chat.renderMarkdown(text);
    } else {
      bubble.textContent = text;
    }
    turn.appendChild(label);
    turn.appendChild(bubble);
    container.appendChild(turn);
    container.scrollTop = container.scrollHeight;
  },

  /**
   * Handle streaming events in voice mode — update status with what's happening.
   */
  _handleVoiceEvent(event) {
    if (!event) return;
    const statusEl = this.elements.status;

    if (event.type === "thinking") {
      if (event.status === "start") {
        this._setVoiceStatus("Thinking...");
      }
      return;
    }

    if (event.type === "tool_call") {
      const name = event.name || "";
      const inp = event.input || {};
      let status = "";

      if (name === "Bash") {
        const cmd = (inp.command || "").split(" ")[0].split("/").pop();
        status = `Running ${cmd || "command"}...`;
      } else if (name === "Read") {
        const file = (inp.file_path || inp.filename || "").split("/").pop();
        status = `Reading ${file || "file"}...`;
      } else if (name === "Write") {
        const file = (inp.file_path || inp.filename || "").split("/").pop();
        status = `Writing ${file || "file"}...`;
      } else if (name === "Edit") {
        const file = (inp.file_path || "").split("/").pop();
        status = `Editing ${file || "file"}...`;
      } else if (name === "Grep" || name === "Search") {
        status = `Searching for "${(inp.pattern || "").slice(0, 20)}"...`;
      } else if (name === "Glob" || name === "Find") {
        status = `Finding files...`;
      } else if (name === "TodoWrite") {
        status = "Updating tasks...";
      } else if (name.startsWith("tarsee_")) {
        const tool = name.replace("tarsee_", "").replace(/_/g, " ");
        status = `Running ${tool}...`;
      } else if (name === "browser") {
        const action = inp.action || "";
        if (action === "navigate") status = "Opening page...";
        else if (action === "screenshot") status = "Taking screenshot...";
        else if (action === "click") status = "Clicking element...";
        else if (action === "type") status = "Typing text...";
        else if (action === "solve_captcha") status = "Solving captcha...";
        else status = `Browser: ${action}...`;
      } else {
        status = `Running ${name}...`;
      }

      this._setVoiceStatus(status);
      return;
    }

    if (event.type === "tool_result") {
      this._setVoiceStatus("Processing...");
      return;
    }
  },

  _setVoiceStatus(text) {
    this._stopThinkingAnimation();
    this.elements.status.textContent = text;
  },

  /** Animated "Thinking..." ellipsis in status text. */
  _startThinkingAnimation() {
    this._stopThinkingAnimation();
    let dots = 0;
    this.elements.status.textContent = "Thinking";
    this.elements.status.classList.add("thinking-anim");
    this._thinkingInterval = setInterval(() => {
      dots = (dots + 1) % 4;
      this.elements.status.textContent = "Thinking" + ".".repeat(dots);
    }, 400);
  },

  _stopThinkingAnimation() {
    if (this._thinkingInterval) {
      clearInterval(this._thinkingInterval);
      this._thinkingInterval = null;
    }
    this.elements.status.classList.remove("thinking-anim");
  },

  /**
   * Convert a full markdown response into clean speakable text.
   * Tables become brief summaries, code blocks are skipped, formatting is stripped.
   */
  makeSpokenText(text) {
    if (!text) return "";

    // Remove code blocks entirely (not speakable)
    text = text.replace(/```[\s\S]*?```/g, " (see code in chat) ");

    // Convert markdown tables to spoken summary
    // Detect table blocks: consecutive lines starting/ending with |
    const lines = text.split("\n");
    const output = [];
    let tableRows = [];

    const flushTable = () => {
      if (tableRows.length < 2) {
        output.push(...tableRows);
        tableRows = [];
        return;
      }
      // Parse header and data rows
      const dataRows = tableRows.filter(r => !/^[\s|:-]+$/.test(r.replace(/\|/g, "").trim() || "-"));
      const cells = dataRows.map(r =>
        r.replace(/^\||\|$/g, "").split("|").map(c => c.trim()).filter(Boolean)
      );
      if (cells.length > 1) {
        // Brief: just say how many results, skip reading rows
        const rowCount = cells.length - 1;
        output.push(`I found ${rowCount} results — check the table in chat for details.`);
      }
      tableRows = [];
    };

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
        tableRows.push(trimmed);
      } else {
        if (tableRows.length > 0) flushTable();
        output.push(line);
      }
    }
    if (tableRows.length > 0) flushTable();

    text = output.join("\n");

    // Strip remaining markdown formatting
    text = text
      .replace(/\*\*(.*?)\*\*/g, "$1")       // bold
      .replace(/\*(.*?)\*/g, "$1")            // italic
      .replace(/~~(.*?)~~/g, "$1")            // strikethrough
      .replace(/#{1,6}\s+/g, "")              // headings
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1") // links → just text
      .replace(/^[-*+]\s+/gm, "")            // bullet points
      .replace(/^\d+\.\s+/gm, "")            // numbered lists
      .replace(/^>\s?/gm, "")                // blockquotes
      .replace(/`([^`]+)`/g, "$1")           // inline code
      .replace(/---+/g, "")                  // horizontal rules
      .replace(/\n{3,}/g, "\n\n")            // collapse whitespace
      .trim();

    // Cap at 250 chars — Edge TTS is reliable under this, times out above
    if (text.length > 250) {
      // Cut at sentence boundary
      const cutoff = text.lastIndexOf(".", 230);
      text = text.slice(0, cutoff > 100 ? cutoff + 1 : 230) + " See chat for more.";
    }

    return text;
  },

  setOrbState(state) {
    const orb = this.elements.orb;
    if (!orb) return;
    orb.classList.remove("idle", "listening", "processing", "speaking");
    orb.classList.add(state);
  },
};
