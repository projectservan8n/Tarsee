/**
 * Voice mode module.
 * Handles speech-to-text (via Web Speech API) and text-to-speech.
 */
const Voice = {
  isListening: false,
  recognition: null,
  isSupported: false,

  elements: {},

  init() {
    this.elements = {
      panel: document.getElementById("voicePanel"),
      visualizer: document.getElementById("voiceVisualizer"),
      status: document.getElementById("voiceStatus"),
      transcript: document.getElementById("voiceTranscript"),
      micBtn: document.getElementById("voiceMicBtn"),
      closeBtn: document.getElementById("voiceClose"),
      modeBtn: document.getElementById("voiceModeBtn"),
      audio: document.getElementById("voiceAudio"),
      stopAudioBtn: document.getElementById("voiceStopAudioBtn"),
      voiceInputBtn: document.getElementById("voiceInputBtn"),
    };

    // Check Web Speech API support
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.isSupported = !!SpeechRecognition;

    if (this.isSupported) {
      this.recognition = new SpeechRecognition();
      this.recognition.continuous = false;
      this.recognition.interimResults = true;
      this.recognition.lang = "en-US";

      this.recognition.onresult = (event) => {
        let transcript = "";
        let isFinal = false;

        for (let i = event.resultIndex; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
          if (event.results[i].isFinal) isFinal = true;
        }

        this.elements.transcript.textContent = transcript;

        if (isFinal) {
          this.stopListening();
          this.handleTranscript(transcript);
        }
      };

      this.recognition.onerror = (event) => {
        console.error("Speech recognition error:", event.error);
        this.stopListening();
        if (event.error === "not-allowed") {
          this.elements.status.textContent = "Microphone access denied";
        } else {
          this.elements.status.textContent = "Error: " + event.error;
        }
      };

      this.recognition.onend = () => {
        if (this.isListening) {
          this.stopListening();
        }
      };
    }

    // Event listeners
    this.elements.modeBtn.addEventListener("click", () => this.open());
    this.elements.closeBtn.addEventListener("click", () => this.close());
    this.elements.micBtn.addEventListener("click", () => this.toggleListening());
    this.elements.stopAudioBtn.addEventListener("click", () => this.stopAudio());

    // Voice input button in chat input
    this.elements.voiceInputBtn.addEventListener("click", () => {
      if (this.isSupported) {
        this.quickListen();
      } else {
        App.showToast("Speech recognition not supported in this browser", "error");
      }
    });
  },

  open() {
    this.elements.panel.classList.add("active");
    if (!this.isSupported) {
      this.elements.status.textContent = "Speech recognition not supported in this browser";
    }
  },

  close() {
    this.stopListening();
    this.stopAudio();
    this.elements.panel.classList.remove("active");
  },

  toggleListening() {
    if (this.isListening) {
      this.stopListening();
    } else {
      this.startListening();
    }
  },

  startListening() {
    if (!this.isSupported || this.isListening) return;

    this.isListening = true;
    this.elements.micBtn.classList.add("active");
    this.elements.visualizer.classList.add("listening");
    this.elements.status.textContent = "Listening...";
    this.elements.transcript.textContent = "";

    try {
      this.recognition.start();
    } catch (err) {
      console.error("Failed to start recognition:", err);
      this.stopListening();
    }
  },

  stopListening() {
    this.isListening = false;
    this.elements.micBtn.classList.remove("active");
    this.elements.visualizer.classList.remove("listening");

    try {
      this.recognition?.stop();
    } catch {
      // already stopped
    }
  },

  /**
   * Quick listen from the chat input (not full voice mode).
   */
  quickListen() {
    if (this.isListening) {
      this.stopListening();
      return;
    }

    this.isListening = true;
    this.elements.voiceInputBtn.classList.add("voice-active");

    const onResult = (event) => {
      let transcript = "";
      let isFinal = false;

      for (let i = event.resultIndex; i < event.results.length; i++) {
        transcript += event.results[i][0].transcript;
        if (event.results[i].isFinal) isFinal = true;
      }

      if (isFinal) {
        const input = document.getElementById("messageInput");
        input.value += (input.value ? " " : "") + transcript;
        input.dispatchEvent(new Event("input"));
        cleanup();
      }
    };

    const onEnd = () => cleanup();
    const onError = () => cleanup();

    const cleanup = () => {
      this.isListening = false;
      this.elements.voiceInputBtn.classList.remove("voice-active");
      this.recognition.removeEventListener("result", onResult);
      this.recognition.removeEventListener("end", onEnd);
      this.recognition.removeEventListener("error", onError);
    };

    this.recognition.addEventListener("result", onResult);
    this.recognition.addEventListener("end", onEnd);
    this.recognition.addEventListener("error", onError);

    try {
      this.recognition.start();
    } catch {
      cleanup();
    }
  },

  /**
   * Handle a completed transcript — send to AI and play TTS.
   */
  async handleTranscript(text) {
    if (!text?.trim()) return;

    this.elements.status.textContent = "Thinking...";
    this.elements.visualizer.classList.remove("listening");

    // Send as chat message
    let fullResponse = "";

    try {
      await API.sendMessage(
        Chat.currentConversationId,
        text,
        (content) => {
          fullResponse += content;
          this.elements.transcript.textContent = fullResponse.slice(0, 200) + (fullResponse.length > 200 ? "..." : "");
        },
        async (data) => {
          if (data?.conversationId) {
            Chat.currentConversationId = data.conversationId;
          }
          Chat.loadConversations();

          // Try TTS
          this.elements.status.textContent = "Speaking...";
          this.elements.visualizer.classList.add("speaking");

          try {
            const audioBlob = await API.tts(fullResponse);
            const audioUrl = URL.createObjectURL(audioBlob);
            this.elements.audio.src = audioUrl;
            this.elements.stopAudioBtn.style.display = "";
            await this.elements.audio.play();
            this.elements.audio.onended = () => {
              this.elements.visualizer.classList.remove("speaking");
              this.elements.status.textContent = "Press the mic to start";
              this.elements.stopAudioBtn.style.display = "none";
              URL.revokeObjectURL(audioUrl);
            };
          } catch {
            // TTS not available — just show text
            this.elements.visualizer.classList.remove("speaking");
            this.elements.status.textContent = "Response ready (TTS not configured)";
          }
        },
        (error) => {
          this.elements.status.textContent = "Error: " + error;
        }
      );
    } catch (err) {
      this.elements.status.textContent = "Error: " + err.message;
    }
  },

  stopAudio() {
    this.elements.audio.pause();
    this.elements.audio.currentTime = 0;
    this.elements.visualizer.classList.remove("speaking");
    this.elements.stopAudioBtn.style.display = "none";
    this.elements.status.textContent = "Press the mic to start";
  },
};
