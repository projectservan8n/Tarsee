/**
 * How to set up each AI, with no page: Settings → AI (js/settings.js) and the setup wizard's "Choose your AI"
 * (js/setup.js) both draw from this, so the two never disagree. test/provider-guides-core.test.js checks it in Node
 * against the provider registry (src/ai/provider-registry.js) and the cards on index.html.
 *
 *   PROVIDERS     the AIs in the order they are offered (the two plans first): id (the registry's public id), name,
 *                 kind ("plan" | "key" | "local"), the card it fills on the AI tab, what it takes and what it costs (one
 *                 line each), the steps, the tips for when it doesn't work, and for a key provider where its key
 *                 comes from and what one looks like
 *   TERMS_NOTE    plan sign-in or API key, in plain words
 *   WIZARD        the setup wizard's three choices: the two plans, then "My own API key" and the providers it offers
 *   get(id)       one of them
 *   guideHtml(id, { open, wizard })  its steps, cost and tips as HTML (a <details> the page can open and close); the
 *                 steps name Settings → AI's buttons, or with wizard the setup wizard's (Test and save, Next)
 *   statusLine(card)  a provider card from GET /api/ai/providers as words and a tone ("ok", "bad", "wait", "off")
 *   stateWord(state), toneOf(state)  a provider state (src/ai/provider-status.js) as a short word and a tone
 *   testLine(result)  a Test answer (POST /api/ai/test/:id) as words and a tone
 *
 * The steps are static, trusted text written here (HTML allowed); nothing a person types goes through them. They
 * were checked against each provider's own pages (2026-11). Never name a ChatGPT model here: what a ChatGPT account
 * can use depends on its plan, and the model list comes from the signed-in account.
 * Loaded by index.html as a plain script (window.ProviderGuides) and by the tests as a module (globalThis.ProviderGuides).
 */
(function () {
  "use strict";

  const link = (href, text) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

  const PROVIDERS = [
    {
      id: "claude",
      name: "Claude plan",
      shortName: "Claude plan",
      kind: "plan",
      section: "claudeAiCard",
      command: "claude auth login",
      pitch: "Uses your Claude subscription. No per-message cost.",
      needs: "Your paid Claude plan (Pro, Max or a Team seat) and one sign-in from Tarsee's Terminal. About 2 minutes.",
      cost: "No cost per message: it uses your Claude plan's usage limits.",
      steps: [
        "Open <strong>Tarsee's Terminal</strong> (the <code>&gt;_</code> button at the top of the dashboard, or <strong>Open the Terminal</strong> below). It runs on the server where Tarsee lives, not on your own computer.",
        "Click inside it, type <code>claude auth login</code> and press Enter.",
        "A link appears. Open it in your browser, sign in with your Claude account and approve. If the page shows a code instead, copy it and paste it back into the Terminal. (To copy from the Terminal, select the text and right-click → Copy: Ctrl+C doesn't copy there.)",
        "When the Terminal says <em>Login successful</em>, come back here and click <strong>Check</strong>. The status turns to <em>Ready</em>.",
      ],
      tips: [
        "No Terminal, or it won't open? On any computer with Claude Code, run <code>claude setup-token</code>, sign in, and put the token it prints in the Railway variable <code>CLAUDE_CODE_OAUTH_TOKEN</code>. It lasts a year.",
        "If the Terminal doesn't know <code>auth</code>, type <code>claude</code>, press Enter, then type <code>/login</code>.",
        "If Tarsee says the sign-in expired, run <code>claude auth login</code> again.",
        `Pro works, but an agent uses its limits quickly; Max lasts much longer. Your usage is at ${link("https://claude.ai/settings/usage", "claude.ai/settings/usage")}.`,
        "A plan is for your own use. If other people talk to this Tarsee, use an Anthropic API key instead.",
      ],
    },
    {
      id: "chatgpt",
      name: "ChatGPT plan",
      shortName: "ChatGPT plan",
      kind: "plan",
      section: "chatgptAiCard",
      command: "codex login --device-auth",
      pitch: "Uses your ChatGPT account, Free included. No per-message cost.",
      needs: "Your ChatGPT account (any plan, Free included) and a one-time code. About 3 minutes.",
      cost: "No cost per message: it uses your ChatGPT plan's Codex limits. Free plans get a smaller model with limited use.",
      steps: [
        `In ChatGPT, open ${link("https://chatgpt.com/#settings/Security", "Settings → Security")} and, under <strong>App security</strong>, turn on <strong>Enable device code sign-in for Codex</strong> (the switch also names Excel, PowerPoint and Word). (In a work or school workspace, an admin turns it on in the workspace's permissions.)`,
        "Back here, click <strong>Sign in with ChatGPT</strong>. Tarsee shows a link and a one-time code.",
        "Open the link, sign in to ChatGPT and type the code. It works for 15 minutes.",
        "Keep this page open: it notices by itself when you're signed in, and the status turns to <em>Ready</em>.",
        "Pick a model (the list shows only the ones your account can use) and click <strong>Use this AI</strong>.",
      ],
      tips: [
        "If ChatGPT says device code sign-in isn't allowed, check the <strong>Enable device code sign-in for Codex</strong> switch from step 1: it has to be on before you click Sign in.",
        `Free plans run a smaller model with limited use; when you reach the limit, Tarsee says when it resets. Paid plans last much longer (${link("https://chatgpt.com/pricing", "chatgpt.com/pricing")}).`,
        "You can also sign in from Tarsee's Terminal: run <code>codex login --device-auth</code> and follow the same steps.",
        "Replies from ChatGPT appear a message at a time, not word by word.",
        "A plan is for your own use. If other people talk to this Tarsee, use an OpenAI API key instead.",
      ],
    },
    {
      id: "anthropic",
      name: "Anthropic API key",
      shortName: "Anthropic",
      kind: "key",
      section: "anthropicAiCard",
      pitch: "Claude, billed per use by Anthropic.",
      getKeyUrl: "https://platform.claude.com/settings/keys",
      keyPlaceholder: "sk-ant-api03-…",
      needs: "An API key from the Claude Console, with some prepaid credit. About 5 minutes.",
      cost: "Pay per use, billed by Anthropic. Set a spending limit so a busy day can't surprise you.",
      steps: [
        `Sign in to the ${link("https://platform.claude.com/", "Claude Console")}. It's separate from a Claude plan, and billed separately.`,
        `Add credit on the ${link("https://platform.claude.com/settings/billing", "Billing")} page. On the same page, under <strong>Spend limits</strong>, click <strong>Set limit</strong> (or <strong>Adjust limit</strong>) and choose a small monthly amount.`,
        `Open ${link("https://platform.claude.com/settings/keys", "API keys")} and click <strong>Create key</strong>. Name it <em>Tarsee</em>, link it to yourself, and choose a <strong>workspace</strong> for it (Default is fine). Copy the key: it starts with <code>sk-ant-</code>, and the Console shows it only once.`,
        "Paste it in the key box below and click <strong>Save key</strong>, then <strong>Test</strong>.",
        "Pick a model and click <strong>Use this AI</strong>.",
      ],
      tips: [
        "A key that starts with <code>sk-ant-oat</code> is a Claude plan sign-in token, not an API key. It belongs in the Railway variable <code>CLAUDE_CODE_OAUTH_TOKEN</code> (the Claude plan card).",
        "If Test says the key needs a workspace, create a new key and choose a workspace for it in step 3, then save that one instead.",
        "If Test says the credit has run out, add some on the Billing page. If it says you've reached your limit, raise it there.",
        "Instead of saving the key here, you can set it as the Railway variable <code>ANTHROPIC_API_KEY</code>.",
        "On a Linux server a command the agent runs can still read this key from the engine's process, so give the key a spending limit.",
      ],
    },
    {
      id: "openai",
      name: "OpenAI API key",
      shortName: "OpenAI",
      kind: "key",
      section: "openaiAiCard",
      pitch: "OpenAI's models, billed per use.",
      getKeyUrl: "https://platform.openai.com/api-keys",
      keyPlaceholder: "sk-proj-…",
      needs: "An API key from the OpenAI Platform, in a project with a budget, and some prepaid credit. About 5 minutes.",
      cost: "Pay per use, billed by OpenAI. Give the project a monthly budget with a hard limit.",
      steps: [
        `Sign in to the ${link("https://platform.openai.com/", "OpenAI Platform")} and add credit under ${link("https://platform.openai.com/settings/organization/billing/overview", "Billing")}.`,
        `Open your ${link("https://platform.openai.com/settings/", "project's settings")} → <strong>Limits</strong>. Under <strong>Spend</strong>, click <strong>Edit spend limit</strong>, enter a small monthly amount, turn on <strong>Enforce a hard limit</strong> and click <strong>Save</strong>.`,
        `Open ${link("https://platform.openai.com/api-keys", "API keys")}, click <strong>Create new secret key</strong>, choose that project, and copy the key. It starts with <code>sk-proj-</code>, and it's shown only once.`,
        "Paste it in the key box below and click <strong>Save key</strong>, then <strong>Test</strong>.",
        "Pick a model and click <strong>Use this AI</strong>.",
      ],
      tips: [
        "If Test says the project is over its budget, raise the spend limit from step 2, or add credit.",
        "The same key also does voice transcription, but only if you choose Whisper API in Settings → Voice.",
        "Replies appear a message at a time, not word by word.",
        "Instead of saving the key here, you can set it as the Railway variable <code>OPENAI_API_KEY</code>.",
        "On a Linux server a command the agent runs can still read this key from the engine's process, so give the key a spending limit.",
      ],
    },
    {
      id: "openrouter",
      name: "OpenRouter",
      shortName: "OpenRouter",
      kind: "key",
      section: "openrouterAiCard",
      pitch: "Hundreds of models with one key; some are free.",
      getKeyUrl: "https://openrouter.ai/settings/keys",
      keyPlaceholder: "sk-or-v1-…",
      needs: "One OpenRouter key for hundreds of models, with a few dollars of credit. About 5 minutes.",
      cost: "Pay per use at each model's price; models marked Free cost nothing. A credit limit on the key caps what it can spend.",
      steps: [
        `Sign in at ${link("https://openrouter.ai/", "openrouter.ai")} and add a few dollars on the ${link("https://openrouter.ai/settings/credits", "Credits")} page.`,
        `Open ${link("https://openrouter.ai/settings/keys", "Keys")} and create a key named <em>Tarsee</em>. Give it a <strong>credit limit</strong> (say $5), so this key can never spend more than that.`,
        "Copy the key (it starts with <code>sk-or-v1-</code>, and it's shown only once). Paste it in the key box below, click <strong>Save key</strong>, then <strong>Test</strong>. Test shows how much of the limit is left.",
        "Pick a model and click <strong>Use this AI</strong>. Claude and OpenAI models work straight away. Any other model: find it in the list and click <strong>Verify</strong> first, a short check that costs a few cents.",
      ],
      tips: [
        "Free models allow about 50 requests a day, or 1,000 a day once you've bought at least $10 of credit.",
        `If Test says the limit is used up, raise the key's limit on the ${link("https://openrouter.ai/settings/keys", "Keys")} page.`,
        "For DeepSeek's models, connecting DeepSeek directly is cheaper and steadier than going through OpenRouter.",
        "Instead of saving the key here, you can set it as the Railway variable <code>OPENROUTER_API_KEY</code>.",
        "On a Linux server a command the agent runs can still read this key from the engine's process, so give the key a spending limit.",
      ],
    },
    {
      id: "deepseek",
      name: "DeepSeek",
      shortName: "DeepSeek",
      kind: "key",
      section: "deepseekAiCard",
      pitch: "The cheapest per message; a small top-up lasts a long time.",
      getKeyUrl: "https://platform.deepseek.com/api_keys",
      keyPlaceholder: "sk-…",
      needs: "A DeepSeek API key and a small top-up (a couple of dollars goes a long way). About 5 minutes.",
      cost: "Pay per use from your prepaid balance, the cheapest of these. Tarsee shows the balance left.",
      steps: [
        `Sign up or sign in at ${link("https://platform.deepseek.com/", "platform.deepseek.com")}.`,
        `Add a small amount on the ${link("https://platform.deepseek.com/top_up", "Top up")} page. DeepSeek only spends what you've topped up, so that is your limit.`,
        `Open ${link("https://platform.deepseek.com/api_keys", "API keys")}, create a key named <em>Tarsee</em> and copy it (it's shown only once).`,
        "Paste it in the key box below, click <strong>Save key</strong>, then <strong>Test</strong>. Test shows your balance.",
        "Pick a model (DeepSeek Flash for everyday use; DeepSeek Pro thinks harder but can't see pictures) and click <strong>Use this AI</strong>.",
      ],
      tips: [
        "If Test says the balance is empty, top up again.",
        "DeepSeek can't open PDFs itself: Tarsee takes the text out of them first.",
        "Instead of saving the key here, you can set it as the Railway variable <code>DEEPSEEK_API_KEY</code>.",
        "On a Linux server a command the agent runs can still read this key from the engine's process, so give the key a spending limit.",
      ],
    },
    {
      id: "local",
      name: "Local AI",
      shortName: "Local AI",
      kind: "local",
      section: "localAiCard",
      pitch: "Free, on a machine you run (Ollama, LM Studio or llama.cpp).",
      keyPlaceholder: "Only if your server asks for one",
      presets: [
        { name: "Ollama", url: "http://localhost:11434/v1" },
        { name: "LM Studio", url: "http://localhost:1234/v1" },
        { name: "llama.cpp", url: "http://localhost:9931/v1" },
      ],
      presetNote: "llama.cpp's older builds and its Docker image use port 8080 instead: <code>http://localhost:8080/v1</code>.",
      needs: "A machine you run with Ollama, LM Studio or llama.cpp (or any server that speaks OpenAI's Responses API), that Tarsee can reach.",
      cost: "Free: it runs on your own hardware. Small models use tools poorly, so pick a capable one.",
      steps: [
        `Install ${link("https://ollama.com/download", "Ollama")}, ${link("https://lmstudio.ai/", "LM Studio")} or ${link("https://github.com/ggml-org/llama.cpp/releases", "llama.cpp")} on the machine that will run the AI: Ollama 0.13.3 or newer, LM Studio 0.3.29 or newer, or llama.cpp build b11768 (v0.8.0) or newer (older ones don't speak the Responses API that Tarsee uses, or can mix up tool calls). llama.cpp on Windows: <code>winget install ggml.llamacpp</code> (for an NVIDIA card, its releases page also has a <em>win-cuda</em> zip: unzip its <em>cudart</em> zip into the same folder). On a Mac or Linux: <code>brew install llama.cpp</code>. <code>llama-server --version</code> shows the build.`,
        "Download a model. Ollama: in a terminal, run <code>ollama pull qwen3</code> (or another model). LM Studio: search for a model in the app and download it. llama.cpp downloads one the first time it starts (next step).",
        "Start its server. Ollama runs one by itself. LM Studio: start the local server in the app's Developer section, or run <code>lms server start</code>, and load the model with a context length of 32768 or more. llama.cpp: run <code>llama-server -hf unsloth/Qwen3.5-9B-GGUF:Q4_K_M --alias qwen3.5-9b -c 65536</code>. The first start downloads about 6 GB. <code>-c</code> is how much it can read at once: Tarsee needs at least 32768. <code>--alias</code> gives the model a short name.",
        "Put the server's address in the box below (click <strong>Ollama</strong>, <strong>LM Studio</strong> or <strong>llama.cpp</strong> to fill in the usual one), click <strong>Save</strong>, then <strong>Test</strong>. Test lists the models it has, and how much it can read at once.",
        "Pick a model and click <strong>Use this AI</strong>: that model is used at once. To use another of your server's models from a chat's model menu, click <strong>Verify</strong> on its row first (it checks that the model can use Tarsee's tools, which is worth doing for small models).",
      ],
      tips: [
        "<code>localhost</code> means the machine Tarsee itself runs on. If Tarsee is on Railway, run the AI as another Railway service and use its private address (like <code>http://ollama.railway.internal:11434/v1</code>), or a public address protected by a key.",
        "Ollama only answers the machine it runs on. To reach it from another machine, start it with <code>OLLAMA_HOST=0.0.0.0</code>. llama.cpp is the same: add <code>--host 0.0.0.0</code>.",
        "llama.cpp's older builds and its Docker image use port 8080, not 9931: the address is then <code>http://localhost:8080/v1</code>.",
        "If you start llama-server with <code>--api-key</code>, paste the same key in the key box.",
        "Always give <code>-hf</code> the file's size after the colon (like <code>:Q4_K_M</code>): without it, llama-server may pick another file from the same page, such as a small helper model. Give <code>--alias</code> a short name of your own, not an OpenAI model's name.",
        "If Test says there is too little room (under 32768 tokens): start llama-server with <code>-c 65536</code>, load the model in LM Studio with a longer context length, or set <code>OLLAMA_CONTEXT_LENGTH=65536</code> where Ollama runs.",
        "If your server asks for a key, paste it in the key box. Tarsee sends it only to this address.",
        "Replies appear a message at a time, not word by word.",
        "Instead of setting it here, you can use the Railway variables <code>TARSEE_LOCAL_AI_URL</code> and, if needed, <code>TARSEE_LOCAL_AI_KEY</code>.",
        "On a Linux server a command the agent runs can still read this key, if your server uses one, from the engine's process, so use a key made only for Tarsee.",
      ],
    },
  ];

  /** Plan sign-in or API key: the providers' terms, in plain words. */
  const TERMS_NOTE =
    "<strong>Plan or API key?</strong> Signing in with a Claude or ChatGPT plan is for your own personal use, under " +
    `${link("https://www.anthropic.com/legal/consumer-terms", "Anthropic's")} and ${link("https://openai.com/policies/terms-of-use", "OpenAI's")} terms. ` +
    "If other people talk to this Tarsee (a team, customers, a shared channel), use an API key, and switch on " +
    "<strong>Only use API keys</strong> so Tarsee never uses a plan sign-in.";

  /** The setup wizard's three choices. */
  const WIZARD = Object.freeze({
    plans: Object.freeze(["claude", "chatgpt"]),
    keys: Object.freeze(["anthropic", "openai", "openrouter", "deepseek", "local"]),
  });

  const byId = new Map(PROVIDERS.map((p) => [p.id, p]));
  const get = (id) => byId.get(id === "claude-code" ? "claude" : id) || null;

  /**
   * Settings → AI's button names as the setup wizard (js/setup.js) has them: one "Test and save" for a key, "Save
   * and test" for Local AI, and Next in place of Use this AI. The wizard has no Verify and no OpenRouter list, and
   * the dashboard's >_ button is out of sight behind it. (Written "click the … button" where a plain "click Test…"
   * would read as the Test button Settings has.)
   */
  const WIZARD_WORDING = [
    [/click <strong>Save key<\/strong>, then <strong>Test<\/strong>(\. Test (?=shows))?/g, (_, more) => `click the <strong>Test and save</strong> button${more ? ", which " : ""}`],
    [/click <strong>Save<\/strong>, then <strong>Test<\/strong>(\. Test (?=lists))?/g, (_, more) => `click <strong>Save and test</strong>${more ? ", which " : ""}`],
    [/ Any other model: find it in the list and click <strong>Verify<\/strong> first, a short check that costs a few cents\./g, " Any other model can be verified and chosen later in Settings → AI."],
    [/ To use another of your server's models from a chat's model menu, click <strong>Verify<\/strong> on its row first \(it checks that the model can use Tarsee's tools, which is worth doing for small models\)\./g, " Later, Verify in Settings → AI lets a chat switch to your server's other models (it checks that each one can use Tarsee's tools, which is worth doing for small models)."],
    [/click <strong>Use this AI<\/strong>/g, "click <strong>Next</strong>"],
    [/ \(the <code>&gt;_<\/code> button at the top of the dashboard, or <strong>Open the Terminal<\/strong> below\)/g, " (click <strong>Open the Terminal</strong> below)"],
  ];
  const wizardWords = (s) => WIZARD_WORDING.reduce((t, [re, to]) => t.replace(re, to), s);

  /**
   * The steps, what it costs, and the tips as a <details> (open: shown unfolded, for an AI that isn't ready; wizard:
   * the steps name the setup wizard's buttons).
   */
  function guideHtml(id, { open = false, wizard = false } = {}) {
    const p = get(id);
    if (!p) return "";
    const steps = p.steps.map((s) => `<li>${wizard ? wizardWords(s) : s}</li>`).join("");
    const tips = p.tips.length
      ? `<div class="channel-guide-tips"><strong>If it doesn't work</strong><ul>${p.tips.map((t) => `<li>${t}</li>`).join("")}</ul></div>`
      : "";
    return `<details class="channel-guide ai-guide" data-ai-guide="${p.id}"${open ? " open" : ""}>` +
      `<summary>How to set up ${p.name}</summary>` +
      `<p class="ai-guide-cost"><strong>What it costs:</strong> ${p.cost}</p>` +
      `<ol class="channel-guide-steps">${steps}</ol>${tips}</details>`;
  }

  const STATE_WORDS = {
    ready: "Ready",
    "needs-key": "Needs a key",
    "needs-sign-in": "Needs sign-in",
    "sign-in-expired": "Sign-in expired",
    "out-of-credit": "Out of credit",
    "blocked-keys-only": "Off (API keys only)",
    "needs-setup": "Needs setup",
    error: "Needs attention",
  };
  const STATE_TONES = {
    ready: "ok",
    "sign-in-expired": "bad",
    "out-of-credit": "bad",
    error: "bad",
    "needs-key": "off",
    "needs-sign-in": "off",
    "needs-setup": "off",
    "blocked-keys-only": "off",
  };

  /** A provider state as a short word (chips, the header). */
  const stateWord = (state) => STATE_WORDS[state] || "Checking…";
  /** A provider state as a tone: "ok", "bad", "off", or "wait" while unknown. */
  const toneOf = (state) => STATE_TONES[state] || "wait";

  /**
   * A provider card (GET /api/ai/providers → providers[]) as words and a tone. Ready: what it uses (modelLabel, else
   * the model id; ChatGPT with no model yet uses the account's default), who is signed in, and the balance. Not ready:
   * what's wrong and what to do.
   */
  function statusLine(card, { modelLabel } = {}) {
    if (!card || !card.state) return { text: "Checking…", tone: "wait" };
    if (card.state === "ready") {
      const model = modelLabel || card.model || (card.id === "chatgpt" ? "your account's default model" : "its default model");
      const who = card.account ? `signed in as ${card.account}, ` : "";
      const balance = card.balance?.text ? ` · ${card.balance.text}` : "";
      return { text: `Ready, ${who}using ${model}${balance}`, tone: "ok" };
    }
    if (card.state === "blocked-keys-only") return { text: "Off: \"Only use API keys\" is on", tone: "off" };
    const text = [card.detail, card.fix].filter(Boolean).join(" ") || stateWord(card.state);
    return { text, tone: toneOf(card.state) };
  }

  /** A Test answer (POST /api/ai/test/:id: {ok, state?, message}) as words and a tone. */
  function testLine(r) {
    if (!r) return { text: "", tone: "off" };
    if (r.ok) return { text: `✓ ${r.message || "It works."}`, tone: "ok" };
    if (r.state === "needs-key" || r.state === "needs-setup" || r.state === "needs-sign-in") return { text: r.message || stateWord(r.state), tone: "off" };
    return { text: `✗ ${r.message || "It didn't work."}`, tone: "bad" };
  }

  globalThis.ProviderGuides = Object.freeze({ PROVIDERS, TERMS_NOTE, WIZARD, get, guideHtml, statusLine, stateWord, toneOf, testLine });
})();
