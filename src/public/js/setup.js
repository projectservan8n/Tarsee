/**
 * First-time setup wizard.
 * Step 1: Choose your AI (a Claude or ChatGPT plan, or an API key: js/provider-guides-core.js, /api/ai)
 * Step 2: Choose skills to install
 * Step 3: Personality interview OR skip
 * Step 4: Channel setup (Telegram, Discord, Slack, WhatsApp, email: js/channel-guides-core.js)
 *
 * Progress bar shows current step throughout.
 */
const Setup = {
  isSetupConversation: false,
  setupConversationId: null,
  personalityBuffer: "",
  currentStep: 1,
  totalSteps: 4,

  // Skills recommended by default for new users
  DEFAULT_SKILLS: ["weather", "github", "gog", "summarize", "nano-pdf", "session-logs", "frontend-design", "gsap-core", "gsap-scrolltrigger"],

  /** Render the progress bar HTML */
  _progressBar(step) {
    const steps = ["Your AI", "Skills", "Personality", "Channels"];
    return `<div style="display:flex;gap:4px;margin-bottom:20px;padding:0 4px">${steps.map((label, i) => {
      const num = i + 1;
      const done = num < step;
      const active = num === step;
      const bg = done ? "var(--success)" : active ? "var(--accent)" : "var(--border)";
      const color = done || active ? "var(--text-inverse)" : "var(--text-muted)";
      return `<div style="flex:1;text-align:center">
        <div style="height:4px;border-radius:2px;background:${bg};margin-bottom:6px"></div>
        <span style="font-size:10px;color:${done || active ? 'var(--text)' : 'var(--text-muted)'};font-weight:${active ? '600' : '400'}">${label}</span>
      </div>`;
    }).join("")}</div>`;
  },

  // --- Step 1: Choose your AI ---
  //
  // Who will talk to this Tarsee, then three big choices: My Claude plan, My ChatGPT plan, or My own API key (then
  // which provider). The chosen one's steps (js/provider-guides-core.js) and its live status sit right under it, and
  // Next is enabled only once that AI is Ready. Nothing is saved but what the person does here: a key they paste and
  // test, a sign-in they finish, "Only use API keys" if they leave it ticked, and the chosen AI as the default.
  // Everything goes through /api/ai (src/routes/ai.js), like Settings → AI.

  _ai: null,             // GET /api/ai/providers
  _aiChoice: null,       // "claude" | "chatgpt" | "key"
  _aiProvider: null,     // the provider being set up
  _aiShared: false,      // "Other people too"
  _aiAutoTicked: false,  // "Only use API keys" was ticked by choosing "Other people too"
  _aiLine: {},           // provider id → the last Test or sign-in answer ({ text, tone })
  _aiModels: {},         // provider id → its usable models
  _aiNotes: {},          // provider id → what its model list says about itself (GET /api/ai/models' note), or null
  _aiLoginCtl: null,
  _aiLoginView: null,

  _esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  },

  /** Step 1: Choose your AI */
  show(_status) {
    this.currentStep = 1;
    document.getElementById("loginScreen").style.display = "none";
    document.getElementById("appScreen").style.display = "none";
    const wizard = document.getElementById("setupWizard");
    wizard.style.display = "flex";

    document.getElementById("setupContent").innerHTML = `
      ${this._progressBar(1)}
      <div class="setup-card-header">
        <div class="logo-large"><img src="/icon-192.png" alt="Tarsee" style="width:100%;height:100%;object-fit:cover;border-radius:inherit"></div>
        <h2>Welcome to Tarsee</h2>
        <p>Your personal AI agent. First, the AI that will answer you.</p>
      </div>
      <div class="setup-card-body setup-ai" id="setupAi">
        <h3 class="setup-ai-title">Choose your AI</h3>
        <fieldset class="setup-ai-who">
          <legend>Who will talk to this Tarsee?</legend>
          <label class="setup-ai-radio"><input type="radio" name="setupWho" value="me" checked><span>Just me</span></label>
          <label class="setup-ai-radio"><input type="radio" name="setupWho" value="others"><span>Other people too (a team, customers)</span></label>
        </fieldset>
        <div id="setupAiEnv"></div>
        <div class="setup-ai-choices" id="setupAiChoices"></div>
        <div class="setup-ai-panel" id="setupAiPanel" aria-live="polite"></div>
        <label class="checkbox-label setup-ai-keysonly"><input type="checkbox" id="setupKeysOnly"><span>Only use API keys</span></label>
        <div class="setup-ai-note" id="setupKeysOnlyNote">Plan sign-ins (Claude, ChatGPT) stay off, so every message is billed to an API key. Right for a Tarsee other people talk to.</div>
        <div class="setup-ai-note" id="setupAiTerms"></div>
        <div id="setupError" class="setup-error" role="alert" hidden></div>
        <button type="button" class="btn btn-primary btn-block" id="setupAiNext" disabled>Next</button>
        <p class="setup-ai-later">You can add more AIs any time in Settings → AI.</p>
      </div>
    `;

    const root = document.getElementById("setupAi");
    const terms = document.getElementById("setupAiTerms");
    if (terms && window.ProviderGuides) terms.innerHTML = window.ProviderGuides.TERMS_NOTE;
    root.addEventListener("click", (ev) => this._aiClick(ev));
    root.addEventListener("change", (ev) => this._aiChange(ev));
    document.getElementById("setupAiNext").addEventListener("click", () => this._aiNext());
    // Back from the Terminal or ChatGPT's page: read the status again, so it turns Ready by itself.
    if (!this._aiVisibilityHook) {
      this._aiVisibilityHook = () => {
        if (!document.hidden && this.currentStep === 1 && document.getElementById("setupAi")) this._aiLoad();
      };
      document.addEventListener("visibilitychange", this._aiVisibilityHook);
    }
    this._aiLoad();
  },

  /** Read every provider's state (GET /api/ai/providers) and draw the step again. */
  async _aiLoad() {
    try {
      this._ai = await API.json("/api/ai/providers");
    } catch (err) {
      const panel = document.getElementById("setupAiPanel");
      if (panel) {
        panel.innerHTML = `<div class="ai-test-result" data-tone="bad">✗ Couldn't read Tarsee's AI settings: ${this._esc(err.message)}</div>` +
          `<button type="button" class="btn btn-sm" data-setup="retry">Try again</button>`;
      }
      return;
    }
    const k = this._ai.keysOnly || {};
    const box = document.getElementById("setupKeysOnly");
    if (box && (k.locked || (k.on && !box.dataset.touched))) box.checked = true;
    if (box) box.disabled = !!k.locked;
    this._aiDraw();
    if (this._aiProvider && this._aiCard(this._aiProvider)?.ready) this._aiLoadModels(this._aiProvider);
  },

  _aiCard(id) {
    return (this._ai?.providers || []).find((c) => c.id === id) || null;
  },

  _aiShipped(id) {
    return !!this._aiCard(id)?.shipped;
  },

  _aiKeysOnly() {
    return !!document.getElementById("setupKeysOnly")?.checked;
  },

  _aiDraw() {
    const G = window.ProviderGuides;
    if (!G || !this._ai) return;
    const esc = (s) => this._esc(s);
    // With no API-key AI switched on in this version, "Only use API keys" would leave nothing to choose: neither it
    // nor the who-question (whose "Other people too" ticks it) is offered. Already on, it still shows, so it can be
    // unticked (never silently).
    const keyIds = G.WIZARD.keys.filter((id) => this._aiShipped(id));
    const k = this._ai.keysOnly || {};
    const who = document.querySelector("#setupAi .setup-ai-who");
    if (who) who.hidden = !keyIds.length;
    const offerKeysOnly = keyIds.length > 0 || !!k.on || !!k.locked;
    for (const el of [document.querySelector("#setupAi .setup-ai-keysonly"), document.getElementById("setupKeysOnlyNote")]) {
      if (el) el.hidden = !offerKeysOnly;
    }
    const note = document.getElementById("setupKeysOnlyNote");
    if (note && k.locked) {
      note.textContent = "Locked on by the Railway variable TARSEE_KEYS_ONLY=1: plan sign-ins stay off." +
        (keyIds.length ? "" : " No API-key AI is switched on in this version of Tarsee, so remove that variable to use your plan.");
    }
    const keysOnly = this._aiKeysOnly();
    if (keysOnly && (this._aiChoice === "claude" || this._aiChoice === "chatgpt")) { this._aiChoice = null; this._aiProvider = null; }

    // Railway variables already connect an AI: say so, and offer it.
    const env = (this._ai.providers || []).filter((c) => c.shipped && c.ready && String(c.keySource || "").startsWith("env:") && !(keysOnly && c.kind === "subscription"));
    const envEl = document.getElementById("setupAiEnv");
    if (envEl) {
      envEl.innerHTML = env.length
        ? `<div class="setup-ai-env">Connected through Railway variables: ${env.map((c) => `${esc(G.get(c.id)?.shortName || c.label)} (${esc(c.keySource.slice(4))})`).join(", ")}.` +
          `<div class="setup-ai-env-actions">${env.map((c) => `<button type="button" class="btn btn-sm" data-setup="use-env" data-provider="${c.id}">Use ${esc(G.get(c.id)?.shortName || c.label)}</button>`).join("")}</div></div>`
        : "";
    }

    // The three choices (only the ones this version switches on).
    const choices = [];
    const terms = { claude: "Anthropic's", chatgpt: "OpenAI's" };
    for (const id of G.WIZARD.plans) {
      if (!this._aiShipped(id)) continue;
      const p = G.get(id);
      const title = id === "claude" ? "My Claude plan" : "My ChatGPT plan";
      const off = keysOnly ? `<span class="setup-ai-choice-warn">Off while "Only use API keys" is ticked</span>`
        : this._aiShared ? `<span class="setup-ai-choice-warn">Not for shared use under ${terms[id]} terms</span>` : "";
      choices.push(`<button type="button" class="setup-ai-choice" data-setup="choice" data-choice="${id}" aria-pressed="${this._aiChoice === id}"${keysOnly ? " disabled" : ""}>` +
        `<strong>${title}</strong><span>${esc(p.pitch)}</span>${off}</button>`);
    }
    if (keyIds.length) {
      choices.push(`<button type="button" class="setup-ai-choice" data-setup="choice" data-choice="key" aria-pressed="${this._aiChoice === "key"}">` +
        `<strong>My own API key</strong><span>${esc(keyIds.map((id) => G.get(id).shortName).join(", "))}. You pay per use.</span></button>`);
    }
    const choicesEl = document.getElementById("setupAiChoices");
    if (choicesEl) choicesEl.innerHTML = choices.join("");

    this._aiDrawPanel();
    const next = document.getElementById("setupAiNext");
    const card = this._aiCard(this._aiProvider);
    if (next) {
      next.disabled = !(card && card.ready && !(keysOnly && card.kind === "subscription"));
      next.textContent = card?.ready ? `Next: use ${G.get(card.id)?.shortName || card.label}` : "Next";
    }
  },

  /** The chosen AI: its status, steps and controls. */
  _aiDrawPanel() {
    const G = window.ProviderGuides;
    const panel = document.getElementById("setupAiPanel");
    if (!panel) return;
    const esc = (s) => this._esc(s);
    const typed = {};
    panel.querySelectorAll("[data-keep]").forEach((el) => { if (el.value !== el.defaultValue) typed[el.dataset.keep] = el.value; });

    let html = "";
    if (this._aiChoice === "key") {
      const ids = G.WIZARD.keys.filter((id) => this._aiShipped(id));
      html += `<div class="setup-ai-providers">${ids.map((id) => {
        const p = G.get(id);
        const c = this._aiCard(id);
        const ready = c?.ready ? ` <span class="ai-badge" data-kind="ok">Ready</span>` : "";
        return `<button type="button" class="setup-ai-provider" data-setup="provider" data-provider="${id}" aria-pressed="${this._aiProvider === id}"><strong>${esc(p.shortName)}${ready}</strong><span>${esc(p.pitch)}</span></button>`;
      }).join("")}</div>`;
    }
    const id = this._aiProvider;
    const c = this._aiCard(id);
    const p = G.get(id);
    if (id && c && p) {
      const { text, tone } = G.statusLine(c, { modelLabel: this._aiModelLabel(id, c.model) });
      html += `<div class="setup-ai-status" data-tone="${tone}">${tone === "ok" ? "✓ " : tone === "bad" ? "✗ " : ""}${esc(text)}</div>`;
      html += G.guideHtml(id, { open: !c.ready, wizard: true });
      html += this._aiControlsHtml(c, p);
      const line = this._aiLine[id];
      html += `<div class="ai-test-result" data-tone="${line?.tone || "off"}">${line ? esc(line.text) : ""}</div>`;
      if (c.ready) html += this._aiModelHtml(c);
    }
    panel.innerHTML = html;
    for (const [name, value] of Object.entries(typed)) {
      const el = panel.querySelector(`[data-keep="${name}"]`);
      if (el) el.value = value;
    }
    if (id === "chatgpt") Settings.renderChatgptLogin(document.getElementById("setupDevice"), this._aiLoginView);
  },

  _aiControlsHtml(c, p) {
    const esc = (s) => this._esc(s);
    if (c.id === "claude") {
      return `<div class="ai-actions">` +
        `<a class="btn btn-sm" href="/terminal.html" target="_blank" rel="noopener noreferrer">Open the Terminal ↗</a>` +
        `<button type="button" class="setup-copy-chip" data-copy="${p.command}" aria-label="Copy the command ${p.command}"><span class="setup-copy-cmd">${p.command}</span><span class="setup-copy-label">Copy</span></button>` +
        `<button type="button" class="btn btn-sm btn-primary" data-setup="test">Check</button></div>` +
        `<div class="setup-ai-note">Or set the Railway variable <code>CLAUDE_CODE_OAUTH_TOKEN</code> (from <code>claude setup-token</code>), then click Check.</div>`;
    }
    if (c.id === "chatgpt") {
      if (c.ready) return `<div class="ai-actions"><button type="button" class="btn btn-sm" data-setup="test">Check</button></div>`;
      return `<div class="ai-actions"><button type="button" class="btn btn-sm btn-primary" data-setup="chatgpt-login">Sign in with ChatGPT</button></div>` +
        `<div class="ai-device" id="setupDevice" hidden></div>`;
    }
    if (c.id === "local") {
      const presets = p.presets.map((x) => `<button type="button" class="btn btn-sm btn-ghost" data-setup="preset" data-url="${x.url}">${x.name}</button>`).join("");
      return `<label class="ai-label" for="setupLocalUrl">Server address</label>` +
        `<div class="ai-presets">Fill in: ${presets}</div>` +
        `<input type="url" id="setupLocalUrl" class="ai-input" data-keep="url" value="${esc(c.settings?.baseUrl || "")}" placeholder="http://localhost:11434/v1" autocomplete="off" spellcheck="false" autocapitalize="off">` +
        `<form class="ai-key-form" autocomplete="off" data-no-submit><label class="ai-label" for="setupKey">Key, only if your server asks for one</label>` +
        `<input type="password" id="setupKey" class="ai-input" data-keep="key" placeholder="${esc(p.keyPlaceholder)}" autocomplete="off" spellcheck="false" autocapitalize="off"></form>` +
        `<div class="ai-actions"><button type="button" class="btn btn-sm btn-primary" data-setup="save-local">Save and test</button></div>`;
    }
    const where = c.keySource ? `<div class="ai-keysource">Key: ${esc(c.keySourceText || c.keySource)}${c.keyHint ? ` <code>${esc(c.keyHint)}</code>` : ""}</div>` : "";
    // A key Tarsee already has (saved, or a Railway variable) is tested as it is: Test sends no key (POST {}).
    const test = c.keySource ? `<button type="button" class="btn btn-sm" data-setup="test">Test</button>` : "";
    return where +
      `<form class="ai-key-form" autocomplete="off" data-no-submit><label class="ai-label" for="setupKey">${c.keySource ? "Replace the key" : `Paste your ${esc(p.shortName)} key`}</label>` +
      `<div class="ai-inline"><input type="password" id="setupKey" class="ai-input" data-keep="key" placeholder="${esc(p.keyPlaceholder)}" autocomplete="off" spellcheck="false" autocapitalize="off">` +
      `<button type="button" class="btn btn-sm btn-primary" data-setup="test-save">Test and save</button></div></form>` +
      `<div class="ai-actions">${test}<a class="btn btn-sm btn-ghost" href="${p.getKeyUrl}" target="_blank" rel="noopener noreferrer">Get a key ↗</a></div>`;
  },

  _aiModelLabel(id, model) {
    const m = (this._aiModels[id] || []).find((x) => x.id === model);
    if (m?.label && m.label !== m.id) return m.label;
    if (model && /^(fable|opus|sonnet|haiku)(\[1m\])?$/i.test(model)) return model[0].toUpperCase() + model.slice(1);
    return model || null;
  },

  _aiModelHtml(c) {
    const esc = (s) => this._esc(s);
    const models = this._aiModels[c.id];
    const opts = [];
    if (c.id === "chatgpt") opts.push({ value: "", label: "Your account's default" });
    // (confirmed: false is a model the provider's own list leaves out for this key, so a turn on it would be refused)
    for (const m of models || []) opts.push({ value: m.id, label: [m.label && m.label !== m.id ? m.label : m.id, m.free ? "Free" : "", m.confirmed === false ? "Not listed for this key" : ""].filter(Boolean).join(" · ") });
    if (c.model && !opts.some((o) => o.value === c.model)) opts.unshift({ value: c.model, label: this._aiModelLabel(c.id, c.model) });
    if (!opts.length) opts.push({ value: "", label: models ? "Its default model" : "Loading…" });
    const more = c.id === "openrouter" ? `<div class="setup-ai-note">Any other OpenRouter model can be verified and chosen later in Settings → AI.</div>` : "";
    const note = this._aiNotes[c.id] ? `<div class="setup-ai-note">${esc(this._aiNotes[c.id])}</div>` : "";
    return `<label class="ai-label" for="setupAiModel">Model</label>` +
      `<select id="setupAiModel" class="ai-input">${opts.map((o) => `<option value="${esc(o.value)}"${o.value === (c.model || "") ? " selected" : ""}>${esc(o.label)}</option>`).join("")}</select>${note}${more}`;
  },

  async _aiLoadModels(id) {
    if (this._aiModels[id]) return;
    try {
      const r = await API.json(`/api/ai/models/${encodeURIComponent(id)}`);
      this._aiModels[id] = (r.models || []).filter((m) => !m.needsVerification);
      this._aiNotes[id] = typeof r.note === "string" && r.note.trim() ? r.note : null;
    } catch {
      this._aiModels[id] = [];
      this._aiNotes[id] = null;
    }
    if (this._aiProvider === id) this._aiDrawPanel();
  },

  _aiSetError(text) {
    const el = document.getElementById("setupError");
    if (!el) return;
    el.textContent = text || "";
    el.hidden = !text;
  },

  _aiChange(ev) {
    const t = ev.target;
    if (t.name === "setupWho") {
      this._aiShared = t.value === "others";
      const box = document.getElementById("setupKeysOnly");
      if (box && !box.disabled) {
        if (this._aiShared && !box.checked) { box.checked = true; this._aiAutoTicked = true; }
        else if (!this._aiShared && this._aiAutoTicked) { box.checked = !!this._ai?.keysOnly?.on; this._aiAutoTicked = false; }
      }
      this._aiDraw();
    } else if (t.id === "setupKeysOnly") {
      t.dataset.touched = "1";
      this._aiAutoTicked = false;
      this._aiDraw();
    }
  },

  _aiClick(ev) {
    const copy = ev.target.closest("[data-copy]");
    if (copy) { Settings.copyText(copy); return; }
    if (ev.target.closest('[data-ai-action="chatgpt-cancel"]')) { this._aiCancelLogin(); return; }
    const btn = ev.target.closest("[data-setup]");
    if (!btn) return;
    this._aiSetError("");
    switch (btn.dataset.setup) {
      case "retry": this._aiLoad(); break;
      case "choice": {
        const choice = btn.dataset.choice;
        this._aiChoice = choice;
        this._aiProvider = choice === "key" ? (this._aiCard(this._aiProvider)?.kind !== "subscription" ? this._aiProvider : null) : choice;
        this._aiDraw();
        if (this._aiProvider && this._aiCard(this._aiProvider)?.ready) this._aiLoadModels(this._aiProvider);
        break;
      }
      case "provider":
      case "use-env": {
        const id = btn.dataset.provider;
        this._aiChoice = this._aiCard(id)?.kind === "subscription" ? id : "key";
        this._aiProvider = id;
        this._aiDraw();
        if (this._aiCard(id)?.ready) this._aiLoadModels(id);
        break;
      }
      case "test": this._aiTest(this._aiProvider, btn); break;
      case "test-save": this._aiTestSave(this._aiProvider, btn); break;
      case "save-local": this._aiSaveLocal(btn); break;
      case "preset": {
        const input = document.getElementById("setupLocalUrl");
        if (input) { input.value = btn.dataset.url; input.focus(); }
        break;
      }
      case "chatgpt-login": this._aiChatgptLogin(); break;
    }
  },

  _aiBusy(btn, text) {
    if (!btn) return () => {};
    const was = btn.textContent;
    btn.disabled = true;
    btn.setAttribute("aria-busy", "true");
    btn.textContent = text;
    return () => { btn.disabled = false; btn.removeAttribute("aria-busy"); btn.textContent = was; };
  },

  /** Test (Check, on the plans): what's saved or signed in now. */
  async _aiTest(id, btn) {
    const done = this._aiBusy(btn, this._aiCard(id)?.kind === "subscription" ? "Checking…" : "Testing…");
    try {
      const r = await API.json(`/api/ai/test/${id}`, { method: "POST", body: {} });
      this._aiLine[id] = window.ProviderGuides.testLine(r);
    } catch (err) {
      this._aiLine[id] = { text: `✗ ${err.message}`, tone: "bad" };
    }
    done();
    await this._aiLoad();
  },

  /** A pasted key: tested first, saved only once the provider took it (POST /api/ai/test, then PUT /api/ai/keys). */
  async _aiTestSave(id, btn) {
    const input = document.getElementById("setupKey");
    const key = input?.value.trim() || "";
    if (!key) { this._aiLine[id] = { text: "Paste a key first.", tone: "bad" }; this._aiDrawPanel(); return; }
    const done = this._aiBusy(btn, "Testing…");
    let r;
    try {
      r = await API.json(`/api/ai/test/${id}`, { method: "POST", body: { apiKey: key } });
    } catch (err) {
      r = { ok: false, message: err.message };
    }
    this._aiLine[id] = window.ProviderGuides.testLine(r);
    // A key the provider took is saved, even with an empty balance (topping up is the next step).
    if (r.ok || r.state === "out-of-credit") {
      try {
        await API.json(`/api/ai/keys/${id}`, { method: "PUT", body: { apiKey: key } });
        input.value = "";
        this._aiLine[id] = { text: `${this._aiLine[id].text} · Saved.`, tone: this._aiLine[id].tone };
      } catch (err) {
        this._aiLine[id] = { text: `✗ ${err.message}`, tone: "bad" };
      }
    }
    done();
    delete this._aiModels[id];
    delete this._aiNotes[id];
    await this._aiLoad();
  },

  /** Local AI: its address (and a key if typed), then a Test that lists its models. */
  async _aiSaveLocal(btn) {
    const url = document.getElementById("setupLocalUrl")?.value.trim() || "";
    const key = document.getElementById("setupKey")?.value.trim() || "";
    if (!url) { this._aiLine.local = { text: "Type your server's address first, or click Ollama or LM Studio.", tone: "bad" }; this._aiDrawPanel(); return; }
    const done = this._aiBusy(btn, "Saving…");
    try {
      await API.json("/api/ai/providers/local", { method: "PUT", body: { baseUrl: url } });
      if (key) await API.json("/api/ai/keys/local", { method: "PUT", body: { apiKey: key } });
      const urlEl = document.getElementById("setupLocalUrl");
      if (urlEl) urlEl.defaultValue = url;
      const keyEl = document.getElementById("setupKey");
      if (keyEl) keyEl.value = "";
      const r = await API.json("/api/ai/test/local", { method: "POST", body: {} });
      this._aiLine.local = window.ProviderGuides.testLine(r);
    } catch (err) {
      this._aiLine.local = { text: `✗ ${err.message}`, tone: "bad" };
    }
    done();
    delete this._aiModels.local;
    delete this._aiNotes.local;
    await this._aiLoad();
  },

  _aiChatgptLogin() {
    this._aiLoginCtl?.cancel?.();
    this._aiLine.chatgpt = null;
    // (render runs once before startChatgptLogin returns, so ctl is still null then)
    let ctl = null;
    ctl = Settings.startChatgptLogin(async (v) => {
      if (ctl && this._aiLoginCtl !== ctl && v.state !== "cancelled") return;
      this._aiLoginView = v;
      Settings.renderChatgptLogin(document.getElementById("setupDevice"), v);
      if (v.state === "done") {
        this._aiLoginView = null;
        this._aiLine.chatgpt = { text: `✓ Signed in to ChatGPT${v.account ? ` as ${v.account}` : ""}.`, tone: "ok" };
        await this._aiLoad();
      }
    });
    this._aiLoginCtl = ctl;
  },

  _aiCancelLogin() {
    const ctl = this._aiLoginCtl;
    this._aiLoginCtl = null;
    this._aiLoginView = null;
    ctl?.cancel();
  },

  /** Next: "Only use API keys" as ticked, the chosen AI (and model) as the default, then the skills step. */
  async _aiNext() {
    const id = this._aiProvider;
    const card = this._aiCard(id);
    if (!card?.ready) return;
    const btn = document.getElementById("setupAiNext");
    const done = this._aiBusy(btn, "Saving…");
    try {
      const want = this._aiKeysOnly();
      const k = this._ai?.keysOnly || {};
      if (!k.locked && want !== !!k.on) await API.json("/api/ai/keys-only", { method: "PUT", body: { on: want } });
      const model = document.getElementById("setupAiModel")?.value || undefined;
      await API.json("/api/ai/active", { method: "PUT", body: { provider: id, model } });
    } catch (err) {
      this._aiSetError(err.message);
      done();
      return;
    }
    if (this._aiLoginCtl) this._aiCancelLogin();
    this.showSkillPicker();
  },

  /** Step 2: Skill picker */
  async showSkillPicker() {
    this.currentStep = 2;
    const wizard = document.getElementById("setupWizard");
    wizard.style.display = "flex";

    let skills = [];
    try { const data = await API.json("/api/skills"); skills = data.skills || []; } catch {}

    const skillCards = skills.map(s => {
      const recommended = this.DEFAULT_SKILLS.includes(s.name);
      const checked = recommended ? "checked" : "";
      const badge = recommended ? ' <span style="font-size:9px;color:var(--accent);font-weight:600">RECOMMENDED</span>' : "";
      return `<label style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;background:var(--bg-input);border-radius:8px;cursor:pointer;border:1px solid ${recommended ? 'var(--accent-glow)' : 'var(--border)'}">
        <input type="checkbox" name="skill" value="${s.name}" ${checked} style="margin-top:3px;accent-color:var(--accent)">
        <div>
          <strong style="font-size:13px">${s.name}</strong>${badge}
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${s.description || "No description"}</div>
        </div>
      </label>`;
    }).join("");

    document.getElementById("setupContent").innerHTML = `
      ${this._progressBar(2)}
      <div class="setup-card-header">
        <h2>Choose Your Skills</h2>
        <p style="color:var(--text-muted);font-size:13px">Skills give your agent specialized abilities. Recommended ones are pre-selected. Change anytime in Settings.</p>
      </div>
      <div class="setup-card-body">
        <div style="display:flex;gap:8px;margin-bottom:12px">
          <button class="btn btn-sm btn-ghost" id="setupSkillsAll">Select All</button>
          <button class="btn btn-sm btn-ghost" id="setupSkillsNone">Deselect All</button>
        </div>
        <div id="setupSkillsList" style="display:flex;flex-direction:column;gap:6px;max-height:300px;overflow-y:auto;padding-right:4px">
          ${skillCards}
        </div>
        <button class="btn btn-primary" id="setupSkillsSave" style="width:100%;padding:12px;font-size:14px;margin-top:16px">Install & Continue →</button>
      </div>
    `;

    document.getElementById("setupSkillsAll").addEventListener("click", () => {
      document.querySelectorAll('#setupSkillsList input[type="checkbox"]').forEach(cb => cb.checked = true);
    });
    document.getElementById("setupSkillsNone").addEventListener("click", () => {
      document.querySelectorAll('#setupSkillsList input[type="checkbox"]').forEach(cb => cb.checked = false);
    });

    document.getElementById("setupSkillsSave").addEventListener("click", async () => {
      const install = [];
      document.querySelectorAll('#setupSkillsList input[type="checkbox"]:checked').forEach(cb => install.push(cb.value));
      const btn = document.getElementById("setupSkillsSave");
      btn.disabled = true;
      btn.textContent = `Installing ${install.length} skills...`;
      try { await API.json("/api/skills/setup", { method: "POST", body: { install } }); } catch {}
      this.showPersonalityStep();
    });
  },

  /** Step 3: Personality interview OR skip */
  showPersonalityStep() {
    this.currentStep = 3;
    document.getElementById("setupContent").innerHTML = `
      ${this._progressBar(3)}
      <div class="setup-card-header">
        <h2>Set Up Personality</h2>
        <p style="color:var(--text-muted);font-size:13px">Have a quick chat to teach your agent who you are and how you like to communicate.</p>
      </div>
      <div class="setup-card-body">
        <div style="background:var(--bg-input);border-radius:8px;padding:16px;margin-bottom:16px">
          <p style="font-size:13px;color:var(--text-secondary);margin:0">The agent will ask you:</p>
          <ul style="font-size:13px;color:var(--text-muted);margin:8px 0 0 0;padding-left:20px">
            <li>What to call itself</li>
            <li>Your communication style</li>
            <li>What you'll use it for</li>
            <li>Personality preferences</li>
          </ul>
        </div>
        <button class="btn btn-primary" id="setupStartInterview" style="width:100%;padding:12px;font-size:14px;margin-bottom:10px">Start Personality Chat →</button>
        <button class="btn btn-ghost" id="setupSkipInterview" style="width:100%;padding:10px;font-size:13px;color:var(--text-muted)">Skip and use the defaults</button>
      </div>
    `;

    document.getElementById("setupStartInterview").addEventListener("click", async () => {
      await API.json("/api/settings/general", { method: "POST", body: { key: "setup.completed", value: "true" } }).catch(() => {});
      App.bootApp();
      this.startPersonalityInterview();
    });

    document.getElementById("setupSkipInterview").addEventListener("click", async () => {
      await API.json("/api/settings/general", { method: "POST", body: { key: "setup.completed", value: "true" } }).catch(() => {});
      App.bootApp();
      this.showChannelSetup();
    });
  },

  /** Step 4: Channel setup (optional) */
  showChannelSetup() {
    this.currentStep = 4;

    // A card per platform (js/channel-guides-core.js): its name and what it takes. Clicking one opens Settings on
    // that platform's section with its steps unfolded.
    const platforms = window.ChannelGuides?.PLATFORMS || [];
    const cards = platforms.map((p) => `
          <button type="button" class="setup-channel-card" data-channel="${p.id}" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px;background:var(--bg-input);border-radius:8px;color:var(--text);border:1px solid var(--border);text-align:left;cursor:pointer;width:100%;font:inherit">
            <div>
              <strong>${p.name}</strong>
              <div style="font-size:11px;color:var(--text-muted);margin-top:2px">${p.needs}</div>
            </div>
            <span style="font-size:12px;color:var(--accent);white-space:nowrap">Set up →</span>
          </button>`).join("");

    const overlay = document.createElement("div");
    overlay.id = "setupChannelOverlay";
    overlay.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.6);z-index:300;display:flex;align-items:center;justify-content:center;padding:20px;overflow-y:auto";
    overlay.innerHTML = `
      <div style="background:var(--bg-elevated);border-radius:12px;padding:24px;max-width:460px;width:100%;border:1px solid var(--border);margin:auto">
        ${this._progressBar(4)}
        <h2 style="font-size:18px;margin-bottom:4px">Connect Channels</h2>
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">Optional: talk to Tarsee from the apps you already use. Pick one and Settings shows you each step; you can add more any time in Settings → Channels.</p>

        <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:20px">${cards}
        </div>

        <div style="display:flex;gap:8px">
          <button class="btn btn-ghost" id="setupChannelSettings" style="flex:1;padding:10px">Open Settings</button>
          <button class="btn btn-primary" id="setupChannelDone" style="flex:1;padding:10px">Skip, start chatting</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    const openChannels = (id) => {
      overlay.remove();
      Settings.open();
      Settings.switchTab("channels");
      if (id) setTimeout(() => Settings.focusChannel(id), 150);
    };
    overlay.querySelectorAll(".setup-channel-card").forEach((card) => {
      card.addEventListener("click", () => openChannels(card.dataset.channel));
    });
    document.getElementById("setupChannelSettings").addEventListener("click", () => openChannels(null));

    document.getElementById("setupChannelDone").addEventListener("click", () => {
      overlay.remove();
      this.showWelcomeTour();
    });
  },

  /** Welcome tour — highlight key UI elements */
  showWelcomeTour() {
    const tips = [
      { selector: "#voiceModeBtn", text: "Hold to talk: voice mode with speech-to-text", pos: "below" },
      { selector: "#consoleToggleBtn", text: "Server console: see what your agent is doing", pos: "below" },
      { selector: "#settingsBtn", text: "Settings: configure everything", pos: "above" },
      { selector: ".channel-list", text: "Your channels: web, Telegram, Discord, WhatsApp, Slack, email", pos: "right" },
    ];

    let currentTip = 0;

    const showTip = () => {
      // Remove previous
      document.getElementById("welcomeTip")?.remove();

      if (currentTip >= tips.length) {
        // Tour done — send sample message
        this.sendSampleMessage();
        return;
      }

      const tip = tips[currentTip];
      const el = document.querySelector(tip.selector);
      if (!el) { currentTip++; showTip(); return; }

      const rect = el.getBoundingClientRect();
      const overlay = document.createElement("div");
      overlay.id = "welcomeTip";
      overlay.style.cssText = "position:fixed;inset:0;z-index:400;pointer-events:none";

      const tipEl = document.createElement("div");
      tipEl.style.cssText = `position:absolute;background:var(--accent);color:white;padding:10px 16px;border-radius:8px;font-size:13px;max-width:250px;pointer-events:auto;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,0.3)`;

      if (tip.pos === "below") {
        tipEl.style.top = (rect.bottom + 8) + "px";
        tipEl.style.left = Math.max(8, rect.left - 40) + "px";
      } else if (tip.pos === "above") {
        tipEl.style.bottom = (window.innerHeight - rect.top + 8) + "px";
        tipEl.style.left = Math.max(8, rect.left) + "px";
      } else {
        tipEl.style.top = rect.top + "px";
        tipEl.style.left = (rect.right + 8) + "px";
      }

      tipEl.innerHTML = `${tip.text}<div style="font-size:10px;margin-top:4px;opacity:0.7">Tap to continue (${currentTip + 1}/${tips.length})</div>`;
      tipEl.addEventListener("click", () => { currentTip++; showTip(); });

      overlay.appendChild(tipEl);
      document.body.appendChild(overlay);

      // Auto-advance after 4s
      setTimeout(() => { if (document.getElementById("welcomeTip")) { currentTip++; showTip(); } }, 4000);
    };

    showTip();
  },

  /** Send a sample first message so the UI isn't empty */
  sendSampleMessage() {
    setTimeout(() => {
      if (Chat.elements?.messageInput) {
        Chat.elements.messageInput.value = "Hey! I just finished setting you up. What can you do?";
        Chat.send();
      }
    }, 500);
  },

  /** Start the personality interview as the first conversation */
  async startPersonalityInterview() {
    this.isSetupConversation = true;
    this.personalityBuffer = "";

    let bootstrapContent = "";
    try {
      const bsData = await API.json("/api/settings/workspace-file?name=BOOTSTRAP.md");
      if (bsData.content && bsData.content.trim().length > 10) bootstrapContent = bsData.content;
    } catch {}

    const systemPrompt = bootstrapContent
      ? `${INTERVIEW_SYSTEM_PROMPT}\n\n--- BOOTSTRAP CONTEXT ---\n${bootstrapContent}`
      : INTERVIEW_SYSTEM_PROMPT;

    try {
      const conv = await API.createConversation({ title: "Getting to know you", systemPrompt });
      this.setupConversationId = conv.id;
      Chat.openChannel("web:default", conv.id);
      setTimeout(() => {
        Chat.elements.messageInput.value = "Hey! I just set you up. Let's get to know each other.";
        Chat.send();
      }, 500);
    } catch (err) {
      console.error("[setup] Failed to start interview:", err);
      App.showToast("Setup chat failed: configure personality in Settings", "error");
      this.isSetupConversation = false;
      this.showChannelSetup();
    }
  },

  handleStreamingText(fullText) {
    if (!this.isSetupConversation) return;
    this.personalityBuffer = fullText;
  },

  async handleStreamComplete(fullText) {
    if (!this.isSetupConversation) return;

    const marker = "|||PERSONALITY_COMPLETE|||";
    const markerIdx = fullText.indexOf(marker);
    if (markerIdx === -1) return;

    const jsonStr = fullText.slice(markerIdx + marker.length).trim();
    let identity = {};
    try {
      const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (jsonMatch) identity = JSON.parse(jsonMatch[0]);
    } catch {}

    const botName = identity.name || "Tarsee";
    const systemPrompt = identity.systemPrompt || identity.personality || "";

    try {
      await API.json("/api/settings/general", { method: "POST", body: { key: "identity.name", value: botName } });

      if (systemPrompt) {
        await API.json("/api/settings/workspace-file", { method: "PUT", body: { name: "SOUL.md", content: `# Soul & Personality\n\n${systemPrompt}\n` } });
        await API.json("/api/settings/general", { method: "POST", body: { key: "identity.systemPrompt", value: systemPrompt } });
      }

      if (identity.preferences && Array.isArray(identity.preferences)) {
        const prefLines = identity.preferences.map(p => `- ${p}`).join("\n");
        await API.json("/api/settings/workspace-file", { method: "PUT", body: { name: "USER.md", content: `# About the User\n\n${prefLines}\n` } });
      }

      try { await API.json("/api/settings/bootstrap", { method: "DELETE" }); } catch {}

      App.showToast(`Setup complete! I'm ${botName} now.`, "success");
      if (Chat.setBotName) Chat.setBotName(botName);
      if (this.setupConversationId) {
        await API.updateConversation(this.setupConversationId, { title: `Hello from ${botName}` });
        Chat.loadChannels();
      }
    } catch (err) {
      console.error("[setup] Failed to save identity:", err);
    }

    this.isSetupConversation = false;
    this.setupConversationId = null;

    // After interview, show channel setup
    this.showChannelSetup();
  },
};

const INTERVIEW_SYSTEM_PROMPT = `You are being set up for the first time by your new owner. Your job is to have a warm, brief conversation (3-5 exchanges) to learn who they want you to be.

Discover:
1. What they want to call you (suggest fun names, or let them pick)
2. Their preferred communication style (formal/casual/technical/friendly/witty)
3. What they'll mainly use you for (coding, business, creative writing, general assistant, etc.)
4. Any personality traits they want (humor level, emoji usage, verbosity, directness)

Guidelines:
- Be warm, curious, and conversational — not a boring questionnaire
- Keep it natural. Don't ask all questions at once. One or two per message.
- After 3-5 exchanges, summarize what you learned and ask for confirmation
- When the user confirms (says yes, sounds good, perfect, etc.), output EXACTLY this on its own line:

|||PERSONALITY_COMPLETE|||

Followed by a JSON block with the extracted config:
\`\`\`json
{
  "name": "the bot name they chose",
  "systemPrompt": "A system prompt paragraph that captures the full personality. Write it as instructions to yourself.",
  "preferences": ["preference 1", "preference 2"]
}
\`\`\`

Start by greeting them warmly and asking what they'd like to call you.`;
