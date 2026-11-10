/**
 * Call: a hands-free voice call with the AI, on Tarsee's own speech stack.
 *
 *   microphone ─▶ voice detection in this page ─▶ 16 kHz WAV ─▶ speech-to-text (Settings > Voice: faster-whisper on
 *   the server, or the OpenAI Whisper API when that is chosen) ─▶ a turn in the "Calls with <name>" chat (its own AI
 *   and model, or the default AI) ─▶ text-to-speech (Settings > Voice) ─▶ speaker
 *
 * Talk over it to interrupt. Say "stop" to cancel what it is doing (the chat's Stop). Mute, the clock, and a bar over
 * the composer while the call window is put away. The screen stays on during a call. Hang up while it is still working
 * and the answer goes where Settings > Voice > Calls says (Off: it stays in the call's chat).
 * The server's side: routes/voice-call.js and lib/voice-call.js.
 */
const CALL_CHANNEL = "call:default";
// The deep ask: that one turn runs on the call AI's top model, when it has one (POST /api/call/start's "deep").
const CALL_DEEP_ASK = /\b(think (hard|deeply|carefully|it through)|deep[- ]?dive|be thorough|thoroughly|take your time|(the )?(best|smartest|strongest) model)\b/i;
const CALL_STOP = /^(?:(?:stop|cancel|never ?mind|hold on|wait|forget it)[\s.,!]*)+$/i;
// What whisper makes up from a breath or room noise.
const CALL_JUNK = /^(\[.*\]|\(.*\)|[♪♫\s]+|thank you\.?|thanks for watching.*|you\.?|bye\.?|\.+)$/i;
const CALL_GREETING = "Hi, I'm here.";

const CALL_MONTHS = { Jan: "January", Feb: "February", Mar: "March", Apr: "April", Jun: "June", Jul: "July", Aug: "August", Sep: "September", Oct: "October", Nov: "November", Dec: "December" };

// Voice detection, in milliseconds (the microphone's frames are about 43 ms each, at any sample rate).
const CALL_VAD = {
  prerollMs: 430,       // kept from before speech was detected
  startMs: 130,         // this long over the threshold starts an utterance
  startBargeMs: 260,    // while the call is speaking: its own voice can leak into the microphone
  endSilenceMs: 850,    // this much quiet ends it
  maxUtteranceMs: 40_000,
  minVoicedMs: 250,     // shorter is a cough or a click
};

const Call = {
  state: "idle", // idle | connecting | listening | thinking | speaking | ended | error
  convId: null,
  deep: null,           // { model, label }: the call AI's top model, for "think hard"
  ctx: null, stream: null, node: null, audio: null,
  frameMs: 42.7, floor: 0.004, hot: 0, capturing: false, frames: [], preroll: [], voiced: 0, quiet: 0,
  muted: false,
  turns: [],            // { text, started, reply, spoken, streaming, done, error, stopped, cued }
  speechQueue: [], playing: false, speechGen: 0, bargeIns: 0, ttsTrouble: false, misses: 0,
  startedAt: 0, clockTimer: null, tickTimer: null, wakeLock: null,

  init() {
    document.getElementById("callBtn")?.addEventListener("click", () => {
      if (this.isOn()) this.show();
      else this.start();
    });
    // The call from the chat: a bar over the composer while the call window is put away (the clock, what it is
    // doing, Show, Mute, End), so a call can go on while you read and type.
    this.el("callBar")?.addEventListener("click", (e) => {
      const b = e.target.closest("[data-call]");
      if (!b) return;
      if (b.dataset.call === "show") this.show();
      else if (b.dataset.call === "mute") this.toggleMute();
      else if (b.dataset.call === "end") this.end();
      else if (b.dataset.call === "chat") this.openChat();
    });
    document.addEventListener("visibilitychange", () => {
      // The screen lock is let go while the page is hidden: take it again on the way back.
      if (document.visibilityState === "visible" && this.isOn() && !this.wakeLock) this.keepScreenOn();
    });
    this.initSettings();
    this.paintButton();
  },

  name() { return (typeof Chat !== "undefined" && Chat.botName) || "Tarsee"; },
  isOn() { return ["connecting", "listening", "thinking", "speaking"].includes(this.state); },
  el(id) { return document.getElementById(id); },
  working() { return this.turns.some((t) => !t.done && !t.stopped); },

  // ── The bar over the composer ──────────────────────────────────────
  /** Shown while a call is on and its window is put away. */
  renderBar() {
    const bar = this.el("callBar");
    if (!bar) return;
    const overlay = this.el("callOverlay");
    const show = this.isOn() && (!overlay || overlay.hidden);
    bar.hidden = !show;
    if (!show) return;
    if (!bar.firstChild) {
      bar.innerHTML = '<span class="call-bar-dot" aria-hidden="true"></span>'
        + '<button type="button" class="call-bar-btn call-bar-chat" data-call="chat" title="Open the call\'s chat"><span class="call-bar-title"></span></button>'
        + '<span class="call-bar-clock"></span><span class="call-bar-now" aria-live="polite"></span>'
        + '<button type="button" class="call-bar-btn" data-call="show">Show</button>'
        + '<button type="button" class="call-bar-btn" data-call="mute" aria-pressed="false">Mute</button>'
        + '<button type="button" class="call-bar-btn is-end" data-call="end">End</button>';
    }
    bar.dataset.state = this.state;
    bar.querySelector(".call-bar-title").textContent = `Call with ${this.name()}`;
    bar.querySelector(".call-bar-clock").textContent = this.clockText();
    bar.querySelector(".call-bar-now").textContent = this.nowText();
    const mute = bar.querySelector('[data-call="mute"]');
    mute.textContent = this.muted ? "Unmute" : "Mute";
    mute.setAttribute("aria-pressed", String(this.muted));
  },

  /** What the call is doing now, in plain words: listening, speaking, or what the AI is working on. */
  nowText() {
    if (this.state === "connecting") return "Connecting";
    if (this.state === "speaking") return `${this.name()} is speaking`;
    if (this.working()) {
      const act = (typeof Live !== "undefined" && this.convId) ? Live.activity?.get(this.convId) : null;
      return act?.lastStepLabel ? `Working: ${act.lastStepLabel}` : `${this.name()} is working`;
    }
    return this.muted ? "Muted" : "Listening";
  },

  clockText() {
    const s = Math.max(0, Math.floor((Date.now() - (this.startedAt || Date.now())) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  },

  // ── The call window ────────────────────────────────────────────────
  ensureOverlay() {
    if (this.el("callOverlay")) return;
    const o = document.createElement("div");
    o.id = "callOverlay";
    o.className = "call-overlay";
    o.setAttribute("role", "dialog");
    o.setAttribute("aria-modal", "true");
    o.setAttribute("aria-labelledby", "callTitle");
    o.hidden = true;
    o.innerHTML = `
      <div class="call-card">
        <div class="call-head">
          <div class="call-head-text">
            <div class="call-title" id="callTitle"></div>
            <div class="call-status" id="callStatus" aria-live="polite">Connecting…</div>
          </div>
          <button type="button" class="call-icon-btn" id="callMinimize" aria-label="Put the call away (it goes on, with a bar over the message box)" title="Put away"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.5 8h9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg></button>
        </div>
        <div class="call-orb" id="callOrb" aria-hidden="true"></div>
        <div class="call-clock" id="callClock">0:00</div>
        <div class="call-now" id="callNow" hidden></div>
        <div class="call-problem" id="callProblem" role="alert" hidden>
          <div class="call-problem-text" id="callProblemText"></div>
          <div class="call-problem-detail" id="callProblemDetail"></div>
          <button type="button" class="call-btn" id="callProblemFix">Open Settings → Voice</button>
        </div>
        <div class="call-section-label">Transcript</div>
        <div class="call-transcript" id="callTranscript" role="log" aria-live="polite"></div>
        <div class="call-hint" id="callHint"></div>
        <div class="call-actions">
          <button type="button" class="call-btn" id="callMute" aria-pressed="false">Mute</button>
          <button type="button" class="call-btn" id="callOpenChat" hidden>Open the call's chat</button>
          <button type="button" class="call-btn call-end" id="callEnd">End call</button>
        </div>
      </div>`;
    document.body.appendChild(o);
    this.el("callMinimize").addEventListener("click", () => (this.isOn() ? this.hide() : this.close()));
    this.el("callMute").addEventListener("click", () => this.toggleMute());
    this.el("callEnd").addEventListener("click", () => (this.isOn() ? this.end() : this.close()));
    this.el("callOpenChat").addEventListener("click", () => this.openChat());
    this.el("callProblemFix").addEventListener("click", () => this.openVoiceSettings());
    o.addEventListener("keydown", (e) => { if (e.key === "Escape") (this.isOn() ? this.hide() : this.close()); });
  },

  show() {
    this.ensureOverlay();
    this.el("callOverlay").hidden = false;
    this.el("callEnd").focus();
    this.renderBar();
  },
  hide() {
    const o = this.el("callOverlay");
    if (o) o.hidden = true;
    this.paintButton();
    this.renderBar();
    if (this.isOn()) this.el("callBtn")?.focus();
  },
  close() { this.hide(); if (!this.isOn()) this.state = "idle"; this.paintButton(); this.renderBar(); },

  setStatus(text) { const s = this.el("callStatus"); if (s) s.textContent = text; },

  setState(state) {
    this.state = state;
    const o = this.el("callOverlay");
    o?.classList.toggle("speaking", state === "speaking");
    o?.classList.toggle("listening", state === "listening");
    o?.classList.toggle("thinking", state === "thinking");
    const label = {
      connecting: "Connecting…",
      listening: this.muted ? "Muted" : "Listening",
      thinking: `${this.name()} is working`,
      speaking: `${this.name()} is speaking`,
    }[state];
    if (label) this.setStatus(label);
    this.paintButton();
    this.renderBar();
  },

  /** The topbar's button: "Call <name>", or that a call is on. */
  paintButton() {
    const b = this.el("callBtn");
    if (!b) return;
    const on = this.isOn();
    b.classList.toggle("on-call", on);
    b.title = on ? `On a call with ${this.name()} (open it)` : `Call ${this.name()}`;
    b.setAttribute("aria-label", b.title);
    const title = this.el("callTitle");
    if (title) title.textContent = `Call ${this.name()}`;
  },

  paintHint() {
    const h = this.el("callHint");
    if (!h) return;
    const name = this.name();
    h.textContent = `Talk any time. Talk over ${name} to interrupt, or say "stop" to stop what it's doing.`
      + (this.deep ? ` Say "think hard" to have ${this.deep.label} take it.` : "");
  },

  /** A line in the transcript: who, and the words as plain text. */
  addLine(who, text) {
    const clean = String(text || "").trim();
    const box = this.el("callTranscript");
    if (!clean || !box) return;
    const line = document.createElement("div");
    line.className = `call-line ${who === "you" ? "you" : "bot"}`;
    const w = document.createElement("strong");
    w.textContent = `${who === "you" ? "You" : this.name()}: `;
    line.appendChild(w);
    line.appendChild(document.createTextNode(clean));
    box.appendChild(line);
    box.scrollTop = box.scrollHeight;
  },

  /** Something the call can't get past (no speech-to-text) or that you should know (no voice): said plainly. */
  showProblem(text, detail = "", { fix = true, at = "stt" } = {}) {
    this.ensureOverlay();
    this.problemAt = at;
    this.el("callProblemText").textContent = text;
    this.el("callProblemDetail").textContent = detail || "";
    this.el("callProblemDetail").hidden = !detail;
    this.el("callProblemFix").hidden = !fix;
    this.el("callProblem").hidden = false;
    this.show();
  },

  /** Settings → Voice: at speech-to-text (the same place dictation sends you), or at the voice for a voice problem. */
  async openVoiceSettings() {
    this.hide();
    await SpeechToText.openSettings();
    if (this.problemAt === "voice") document.getElementById("settingsVoiceEngine")?.closest(".settings-section")?.scrollIntoView?.({ block: "start" });
  },

  openChat() {
    if (!this.convId || typeof Chat === "undefined") return;
    this.hide();
    if (!this.isOn() && this.el("callOverlay")) this.close();
    Chat.openChat(this.convId);
  },

  // ── Start / end ────────────────────────────────────────────────────
  async start() {
    this.ensureOverlay();
    this.turns = [];
    this.speechQueue = [];
    this.speechGen++;
    this.ttsTrouble = false;
    this.misses = 0;
    this.muted = false;
    this.convId = null;
    this.deep = null;
    this.el("callTranscript").innerHTML = "";
    this.el("callProblem").hidden = true;
    this.el("callOpenChat").hidden = true;
    this.el("callNow").hidden = true;
    this.el("callClock").textContent = "0:00";
    this.el("callEnd").textContent = "End call";
    this.el("callMute").textContent = "Mute";
    this.el("callMute").setAttribute("aria-pressed", "false");
    this.el("callOverlay").classList.remove("ended");
    this.paintButton();
    this.paintHint();
    this.show();
    this.setState("connecting");
    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") {
      this.failStart(window.isSecureContext === false
        ? "The microphone only works when Tarsee is opened over https (or on this computer). Open it that way and call again."
        : "This browser can't use the microphone for a call. Try a current Chrome, Edge, Safari or Firefox.");
      return;
    }
    // Phones only allow sound that starts inside the tap: open the audio and unlock the player before anything is
    // awaited.
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.ctx.resume?.();
      this.audio = new Audio();
      this.audio.playsInline = true;
      this.audio.src = URL.createObjectURL(this.silentWav());
      this.audio.play().catch(() => {});
    } catch { /* checked below */ }
    try {
      // The phone or the browser asks for the microphone here.
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
      if (this.state !== "connecting") { this.teardownAudio(); return; }   // hung up while it was asked
      await this.ctx.audioWorklet.addModule("/js/call-capture-worklet.js");
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.node = new AudioWorkletNode(this.ctx, "call-capture");
      this.node.port.onmessage = (e) => this.onFrame(e.data);
      const sink = this.ctx.createGain();
      sink.gain.value = 0; // keeps the graph running without playing the microphone back
      src.connect(this.node);
      this.node.connect(sink);
      sink.connect(this.ctx.destination);
      this.floor = 0.004; this.hot = 0; this.capturing = false; this.frames = []; this.preroll = [];

      // The call's chat, the deep ask, and the voice's model loading while it says hello.
      const info = await API.json("/api/call/start", { method: "POST", body: {} });
      if (this.state !== "connecting") { this.teardownAudio(); return; }
      this.convId = info?.conversationId || null;
      this.deep = info?.deep?.model ? info.deep : null;
      this.paintHint();
      if (info?.created && typeof Chat !== "undefined") Chat.loadChannels?.();

      this.startedAt = Date.now();
      this.setState("listening");
      clearInterval(this.clockTimer);
      this.clockTimer = setInterval(() => this.paintClock(), 1000);
      clearInterval(this.tickTimer);
      this.tickTimer = setInterval(() => this.tick(), 1000);
      this.keepScreenOn();
      this.say(CALL_GREETING);
    } catch (err) {
      const blocked = /Permission|NotAllowed|denied|SecurityError/i.test(`${err?.name} ${err?.message}`);
      const noMic = /NotFound|DevicesNotFound|OverconstrainedError/i.test(`${err?.name}`);
      this.failStart(blocked ? "Microphone access was blocked. Allow it for this site (in the browser's address bar or the phone's settings) and try again."
        : noMic ? "No microphone was found. Plug one in or allow one, and call again."
          : `Couldn't start the call: ${err?.message || "something went wrong"}`);
    }
  },

  failStart(message) {
    this.teardownAudio();
    this.state = "error";
    this.paintButton();
    this.renderBar();
    this.setStatus(message);
    this.el("callEnd").textContent = "Close";
    this.el("callOverlay")?.classList.add("ended");
  },

  /** The screen stays on during a call (phones dim and lock it otherwise). */
  keepScreenOn() {
    navigator.wakeLock?.request?.("screen").then((lock) => {
      if (!this.isOn()) { lock.release?.(); return; }
      this.wakeLock = lock;
      lock.addEventListener?.("release", () => { if (this.wakeLock === lock) this.wakeLock = null; });
    }).catch(() => {});
  },

  async end() {
    if (!this.isOn()) return;
    const working = this.working();
    this.teardownAudio();
    this.state = "ended";
    this.paintButton();
    this.renderBar();
    clearInterval(this.clockTimer);
    clearInterval(this.tickTimer);
    const lock = this.wakeLock;
    this.wakeLock = null;
    try { await lock?.release?.(); } catch { /* ignore */ }
    const o = this.el("callOverlay");
    o?.classList.remove("speaking", "listening", "thinking", "hearing");
    o?.classList.add("ended");
    this.el("callEnd").textContent = "Close";
    this.el("callNow").hidden = true;
    this.el("callOpenChat").hidden = !this.convId;
    const name = this.name();
    if (working && this.convId) {
      this.setStatus(`Call ended. ${name} is still working…`);
      let r = null;
      try { r = await API.json("/api/call/handoff", { method: "POST", body: { conversationId: this.convId } }); } catch { r = null; }
      this.setStatus(r?.ok && r.label
        ? `Call ended. ${name} is still working and will send the answer to ${r.label}.`
        : `Call ended. ${name} is still working; the answer will be in the call's chat.`);
    } else {
      this.setStatus("Call ended.");
    }
  },

  teardownAudio() {
    this.speechGen++;
    this.speechQueue = [];
    this.playing = false;
    this.capturing = false;
    try { this.audio?.pause(); } catch { /* ignore */ }
    try { if (this.node?.port) this.node.port.onmessage = null; } catch { /* ignore */ }
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
    try { this.ctx?.close(); } catch { /* ignore */ }
    this.stream = null; this.node = null; this.ctx = null;
  },

  toggleMute() {
    this.muted = !this.muted;
    try { this.stream?.getAudioTracks().forEach((t) => { t.enabled = !this.muted; }); } catch { /* ignore */ }
    if (this.muted) { this.capturing = false; this.frames = []; this.el("callOverlay")?.classList.remove("hearing"); }
    const b = this.el("callMute");
    if (b) {
      b.textContent = this.muted ? "Unmute" : "Mute";
      b.setAttribute("aria-pressed", String(this.muted));
    }
    if (this.state === "listening") this.setState("listening");
    this.renderBar();
  },

  paintClock() {
    const c = this.el("callClock");
    if (c) c.textContent = this.clockText();
    this.renderBar();
  },

  /** Once a second: what the AI is doing (in plain words, never the raw command), and one "on it" for a long one. */
  tick() {
    const running = this.turns.find((t) => !t.done && !t.stopped);
    const now = this.el("callNow");
    if (!running) { if (now) now.hidden = true; return; }
    const act = (typeof Live !== "undefined" && this.convId) ? Live.activity?.get(this.convId) : null;
    const secs = Math.round((Date.now() - running.started) / 1000);
    if (now) {
      now.hidden = false;
      now.textContent = `${act?.lastStepLabel ? act.lastStepLabel : "Thinking"} · ${secs}s`;
    }
    if (!running.cued && secs >= 8 && !this.playing && !this.capturing) {
      running.cued = true;
      this.say("On it, give me a minute.");
    }
  },

  // ── Listening ──────────────────────────────────────────────────────
  onFrame(f) {
    if (!this.ctx || !this.isOn() || this.state === "connecting") return;
    this.frameMs = (f.length / this.ctx.sampleRate) * 1000;
    const frames = (ms) => Math.max(1, Math.round(ms / this.frameMs));
    let sum = 0;
    for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
    const rms = Math.sqrt(sum / f.length);
    this.preroll.push(f);
    if (this.preroll.length > frames(CALL_VAD.prerollMs)) this.preroll.shift();
    if (this.muted) return;
    const talking = this.playing; // its own voice can leak into the microphone
    const thr = Math.max(this.floor * (talking ? 5 : 3), talking ? 0.035 : 0.012);
    if (!this.capturing) {
      if (rms > thr) {
        if (++this.hot >= frames(talking ? CALL_VAD.startBargeMs : CALL_VAD.startMs)) this.beginUtterance();
      } else {
        this.hot = 0;
        this.floor = this.floor * 0.97 + Math.min(rms, 0.05) * 0.03;
      }
      return;
    }
    this.frames.push(f);
    if (rms > thr * 0.7) { this.voiced++; this.quiet = 0; } else { this.quiet++; }
    const dur = this.frames.length * this.frameMs;
    if ((this.quiet * this.frameMs >= CALL_VAD.endSilenceMs && dur > 300) || dur > CALL_VAD.maxUtteranceMs) this.endUtterance();
  },

  beginUtterance() {
    this.capturing = true;
    this.voiced = this.hot;
    this.hot = 0;
    this.quiet = 0;
    this.frames = this.preroll.slice();
    if (this.playing) this.bargeIn();
    this.el("callOverlay")?.classList.add("hearing");
  },

  endUtterance() {
    this.capturing = false;
    this.el("callOverlay")?.classList.remove("hearing");
    const frames = this.frames;
    this.frames = [];
    if (this.voiced * this.frameMs < CALL_VAD.minVoicedMs) return;
    this.transcribe(frames);
  },

  async transcribe(frames) {
    const wav = this.encodeWav(frames, this.ctx?.sampleRate || 48000);
    // The same speech-to-text, and the same words for what went wrong, as the message box's microphone (js/voice.js).
    const result = await SpeechToText.transcribe(new Blob([wav], { type: "audio/wav" }), "utterance.wav");
    if (!this.isOn()) return;
    if (!result.ok) {
      console.warn("[call] transcription failed:", result.kind, result.reason);
      const info = SpeechToText.explain(result, { call: { name: this.name() } });
      // Nothing can turn speech into words here: say so, and how to fix it, rather than missing every word.
      if (result.kind === "not-set-up") { this.end(); this.showProblem(info.title, info.reason, { fix: info.settings }); return; }
      this.addLine("bot", `(${info.title})`);
      // Once can be a bad clip; twice in a row, the reason is shown (the call goes on).
      if (++this.misses >= 2) this.showProblem(info.title, info.reason, { fix: info.settings });
      return;
    }
    this.misses = 0;
    const text = result.text;
    if (!text || CALL_JUNK.test(text)) return;
    this.addLine("you", text);
    if (CALL_STOP.test(text)) { this.stopEverything(); return; }
    this.earcon();
    this.ask(text);
  },

  /** "Stop": quiet now, and stop what it is doing (the chat's Stop). */
  stopEverything() {
    this.bargeIn();
    const running = this.turns.filter((t) => !t.done && !t.stopped);
    if (!running.length || !this.convId) return;
    for (const t of running) t.stopped = true;
    this.addLine("bot", "(Stopped.)");
    API.json("/api/chat/stop", { method: "POST", body: { conversationId: this.convId } }).catch(() => {});
    this.afterSpeech();
  },

  // ── Asking ─────────────────────────────────────────────────────────
  ask(text) {
    const deep = !!(this.deep && CALL_DEEP_ASK.test(text));
    const turn = { text, started: Date.now(), reply: "", spoken: 0, streaming: null, done: false, error: null, stopped: false, cued: false };
    this.turns.push(turn);
    if (!this.playing) this.setState("thinking");
    const opts = { independent: true, clientMsgId: (typeof Live !== "undefined" && Live.newId) ? Live.newId() : undefined };
    if (deep) opts.model = this.deep.model;
    API.sendMessage(
      this.convId,
      `[call] ${text}`,
      (content, event) => {
        if (event) {
          if (event.type === "model_selected" && typeof event.streaming === "boolean") turn.streaming = event.streaming;
          return;
        }
        if (!content) return;
        turn.reply += content;
        // An AI that sends a whole message at a time (the Codex engine): each one is said when it comes.
        if (turn.streaming === false) this.speakPart(turn);
      },
      (data) => {
        if (data?.type === "conversation") { if (data.conversationId) this.convId = data.conversationId; return; }
        if (turn.done) return;
        turn.done = true;
        if (data?.stopReason === "stopped") turn.stopped = true;
        this.onReply(turn);
      },
      (error) => {
        if (turn.done) return;
        turn.done = true;
        turn.error = error;
        this.onReply(turn);
      },
      CALL_CHANNEL,
      undefined,
      undefined,
      opts,
    );
  },

  onReply(turn) {
    if (!this.isOn()) return;
    if (turn.stopped) { if (!this.playing) this.afterSpeech(); return; }
    if (turn.error) {
      this.addLine("bot", `(That failed: ${turn.error})`);
      this.say("Sorry, that one failed. Want me to try again?");
      return;
    }
    if (!this.speakPart(turn) && !this.playing) this.afterSpeech();
  },

  /** Say what of the reply hasn't been said yet. Returns whether there was anything. */
  speakPart(turn) {
    const fresh = turn.reply.slice(turn.spoken);
    turn.spoken = turn.reply.length;
    if (turn.stopped || !this.isOn()) return false;
    const raw = this.cleanReply(fresh);
    if (!raw) return false;
    const shown = this.plainText(raw);
    this.addLine("bot", shown.length > 600 ? `${shown.slice(0, 600)}…` : shown);
    this.say(this.speakable(raw) || shown);
    return true;
  },

  /** The reply without the markers the server takes out of saved replies. */
  cleanReply(text) {
    return String(text || "").split("|||PERSONALITY_COMPLETE|||")[0].replace(/\[REMEMBER:\s*.+?\]/gi, "").trim();
  },

  /** The reply as the transcript shows it: the words, without the chat's formatting marks. */
  plainText(text) {
    return String(text || "")
      .replace(/```[\s\S]*?```/g, "(code in the chat)")
      .replace(/\*\*(.*?)\*\*|__(.*?)__/g, "$1$2")
      .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,!?]|$)/g, "$1$2")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\s*\n+\s*/g, " ")
      .trim();
  },

  /**
   * The last line of defence before the voice: the AI is told to talk like a person on calls, but anything
   * chat-shaped that slips through becomes plain speech.
   */
  speakable(text) {
    let t = String(text || "");
    t = t.replace(/```[\s\S]*?```/g, " I put the code in the chat. ");
    // Tables: their rows aren't read out.
    t = t.split("\n").filter((l) => !/^\s*\|.*\|\s*$/.test(l)).join("\n");
    // Bullets and numbered items become sentences of their own.
    t = t.replace(/^\s*(?:[-*+•]|\d+[.)])\s+(.*)$/gm, (_, item) => item.trim().replace(/[.:;,]?$/, "."));
    t = t
      .replace(/^#{1,6}\s+(.*)$/gm, "$1.")                // headings
      .replace(/\*\*(.*?)\*\*|__(.*?)__/g, "$1$2")         // bold
      .replace(/(^|\s)[*_]([^*_\n]+)[*_](?=\s|[.,!?]|$)/g, "$1$2") // italics
      .replace(/~~(.*?)~~/g, "$1")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")             // [text](address) -> text
      .replace(/https?:\/\/\S+|www\.\S+/g, "the link")      // bare addresses
      .replace(/(?:~|\/Users|\/home|\/data|\/private|\/opt|\/etc|\/tmp|\/var)\/\S+|\b[A-Z]:\\\S+/g, "the file") // file paths
      .replace(/^>\s?/gm, "")
      .replace(/-{3,}|_{3,}/g, " ");
    t = t
      .replace(/\s*&\s*/g, " and ")
      .replace(/(\d)\s*%/g, "$1 percent")
      .replace(/\s*(?:->|→|=>)\s*/g, " to ")
      .replace(/(\w)\/(\w)/g, "$1 or $2")
      .replace(/~(\d)/g, "about $1")
      .replace(/(\d+(?:\.\d+)?)k\b/gi, "$1 thousand")
      .replace(/\babout about\b/gi, "about")
      // "29 Sep" and "Sep 29" read as dates (never touches a name such as Jan)
      .replace(/\b(\d{1,2})\s+(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\b\.?/g, (_, d, m) => `${d} ${CALL_MONTHS[m.slice(0, 3)]}`)
      .replace(/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.?\s+(\d{1,2})\b/g, (_, m, d) => `${CALL_MONTHS[m.slice(0, 3)]} ${d}`)
      .replace(/@(\w)/g, "$1")
      .replace(/[“”"]/g, "")                     // curly and straight double quotes
      .replace(/[‘’]/g, "'")                      // curly apostrophes become plain ones
      .replace(/\s*[—–]\s*/g, ", ")                // dashes as pauses
      .replace(/…/g, ".")
      .replace(/[#*_|<>{}[\]^=]/g, " ")
      .replace(/\p{Extended_Pictographic}|️/gu, "");
    // Lines become sentences; the punctuation left is tidied.
    t = t.split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l) => (/[.!?:]$/.test(l) ? l : `${l}.`)).join(" ");
    t = t.replace(/\(\s*/g, ", ").replace(/\s*\)/g, ",").replace(/\s+([.,!?;:])/g, "$1").replace(/([,;:])\1+/g, "$1")
      .replace(/,\s*([.!?])/g, "$1").replace(/\.{2,}/g, ".").replace(/\s{2,}/g, " ").trim();
    // A call's answer should be short; the chat has all of it.
    if (t.length > 900) {
      const cut = t.lastIndexOf(". ", 850);
      t = `${t.slice(0, cut > 300 ? cut + 1 : 850)} The rest is in the chat.`;
    }
    return t;
  },

  // ── Speaking ───────────────────────────────────────────────────────
  say(text) {
    const t = String(text || "").trim();
    if (!t || !this.ctx) return;
    const gen = this.speechGen;
    // Every sentence is asked for now: the next one is ready while this one plays.
    for (const c of this.chunks(t, 180)) this.speechQueue.push({ gen, url: this.fetchTts(c) });
    if (!this.playing) this.playNext();
  },

  /** Sentences, joined up to about maxLen characters a piece. */
  chunks(text, maxLen) {
    const sentences = text.match(/[^.!?]+[.!?]+\s*/g) || [text];
    const rest = text.slice(sentences.join("").length);
    if (rest.trim()) sentences.push(rest);
    const out = [];
    let current = "";
    for (const s of sentences) {
      if ((current + s).length > maxLen && current) { out.push(current.trim()); current = s; } else current += s;
    }
    if (current.trim()) out.push(current.trim());
    return out.length ? out : [text];
  },

  async fetchTts(text) {
    try {
      const csrf = API.getCsrfToken() || await API.refreshCsrf?.();
      const r = await fetch("/api/voice/tts-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(csrf ? { "X-CSRF-Token": csrf } : {}) },
        credentials: "same-origin",
        body: JSON.stringify({ text }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        this.voiceTrouble(j.error);
        return null;
      }
      const blob = await r.blob();
      return blob.size > 100 ? URL.createObjectURL(blob) : null;
    } catch (err) {
      this.voiceTrouble(err?.message);
      return null;
    }
  },

  /** The voice can't speak: once a call, say so, and that the answers show as text. */
  voiceTrouble(detail) {
    if (this.ttsTrouble || !this.isOn()) return;
    this.ttsTrouble = true;
    console.warn("[call] the voice failed:", detail);
    this.showProblem(`The voice isn't working, so ${this.name()}'s answers show here as text. Check the voice in Settings > Voice.`, detail || "", { at: "voice" });
  },

  async playNext() {
    const item = this.speechQueue.shift();
    if (!item || item.gen !== this.speechGen || !this.audio) { this.playing = false; this.afterSpeech(); return; }
    this.playing = true;
    this.setState("speaking");
    const url = await item.url;
    if (item.gen !== this.speechGen || !this.audio) { if (url) URL.revokeObjectURL(url); return; }
    if (!url) { this.playNext(); return; }
    await new Promise((resolve) => {
      this.audio.onended = resolve;
      this.audio.onerror = resolve;
      this.audio.onpause = () => { if (item.gen !== this.speechGen) resolve(); };
      this.audio.src = url;
      this.audio.play().catch(resolve);
    });
    URL.revokeObjectURL(url);
    if (item.gen !== this.speechGen) return;
    this.playNext();
  },

  /** The person started talking (or said "stop"): the voice stops mid-sentence and listens. */
  bargeIn() {
    if (this.playing) this.bargeIns++;
    this.speechGen++;
    this.speechQueue = [];
    this.playing = false;
    try { this.audio?.pause(); } catch { /* ignore */ }
    this.afterSpeech();
  },

  afterSpeech() {
    if (!this.isOn()) return;
    this.setState(this.working() ? "thinking" : "listening");
  },

  /** A soft blip: "heard you". */
  earcon() {
    try {
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.0001, this.ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.06, this.ctx.currentTime + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + 0.12);
      o.connect(g); g.connect(this.ctx.destination);
      o.start(); o.stop(this.ctx.currentTime + 0.13);
    } catch { /* ignore */ }
  },

  // ── Settings > Voice > Calls ───────────────────────────────────────
  /** "Send the answer to": loaded whenever the Voice tab is shown, saved when changed. */
  initSettings() {
    const select = this.el("callHandoffChannel");
    if (!select) return;
    select.addEventListener("change", async () => {
      const channel = select.value || null;
      try {
        await API.json("/api/call/settings", { method: "PUT", body: { channel } });
        if (typeof App !== "undefined") App.showToast?.(channel ? `A call's answer goes to ${select.selectedOptions[0]?.textContent || channel} after you hang up.` : "A call's answer stays in the call's chat.", "success");
      } catch (err) {
        if (typeof App !== "undefined") App.showToast?.(err.message, "error");
        this.loadSettings();
      }
    });
    // Loaded when the Voice tab is shown: when it becomes the tab, or when Settings opens on it.
    const panel = document.querySelector('.settings-tab-panel[data-tab="voice"]');
    const page = document.getElementById("settingsPage");
    if (panel && typeof MutationObserver !== "undefined") {
      const showing = () => panel.classList.contains("active") && (!page || page.classList.contains("open"));
      let was = showing();
      const check = () => {
        const now = showing();
        if (now && !was) this.loadSettings();
        was = now;
      };
      const watch = new MutationObserver(check);
      watch.observe(panel, { attributes: true, attributeFilter: ["class"] });
      if (page) watch.observe(page, { attributes: true, attributeFilter: ["class"] });
    }
  },

  async loadSettings() {
    const select = this.el("callHandoffChannel");
    if (!select) return;
    document.querySelectorAll(".call-bot-name").forEach((n) => { n.textContent = this.name(); });
    let data;
    try { data = await API.json("/api/call/settings"); } catch { return; }
    select.innerHTML = "";
    const off = document.createElement("option");
    off.value = "";
    off.textContent = "Off (it stays in the call's chat)";
    select.appendChild(off);
    for (const c of data?.choices || []) {
      const o = document.createElement("option");
      o.value = c.id;
      o.textContent = c.connected ? c.label : `${c.label} (not connected now)`;
      select.appendChild(o);
    }
    select.value = data?.channel || "";
    const none = this.el("callHandoffNone");
    if (none) none.hidden = (data?.choices || []).some((c) => c.connected);
  },

  // ── Audio helpers ──────────────────────────────────────────────────
  /** Frames at the device's rate → a 16 kHz mono 16-bit WAV (what whisper takes as it is). */
  encodeWav(frames, rate) {
    let total = 0;
    for (const f of frames) total += f.length;
    const all = new Float32Array(total);
    let o = 0;
    for (const f of frames) { all.set(f, o); o += f.length; }
    const ratio = rate / 16000;
    const n = Math.floor(total / ratio);
    const view = new DataView(new ArrayBuffer(44 + n * 2));
    const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    str(0, "RIFF"); view.setUint32(4, 36 + n * 2, true); str(8, "WAVE"); str(12, "fmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    str(36, "data"); view.setUint32(40, n * 2, true);
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * ratio), b = Math.min(total, Math.floor((i + 1) * ratio));
      let s = 0;
      for (let j = a; j < b; j++) s += all[j];
      const v = Math.max(-1, Math.min(1, s / Math.max(1, b - a)));
      view.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    return view.buffer;
  },

  silentWav() {
    const view = new DataView(new ArrayBuffer(44 + 1600));
    const str = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    str(0, "RIFF"); view.setUint32(4, 36 + 1600, true); str(8, "WAVE"); str(12, "fmt ");
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, 8000, true); view.setUint32(28, 16000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    str(36, "data"); view.setUint32(40, 1600, true);
    return new Blob([view.buffer], { type: "audio/wav" });
  },
};
