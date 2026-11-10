<p align="center">
  <img src="Tarsee.png" alt="Tarsee" width="120">
</p>

<h1 align="center">Tarsee</h1>

<p align="center"><strong>Your personal AI agent, running 24/7 in the cloud.</strong></p>

<p align="center">Talk to it from anywhere — web, Telegram, Discord, WhatsApp, Slack, email, or voice. It remembers everything, runs tools, and schedules tasks. Run it on your Claude or ChatGPT plan, on your own API key (Anthropic, OpenAI, OpenRouter or DeepSeek), or free on a model you run yourself.</p>

> **Choose your AI.** Tarsee works on seven kinds of AI account, and you can switch at any time, even for a single chat. An agent that works all day uses a lot: on a plan, a bigger plan lasts much longer; on an API key, set a spending limit at the provider. See [Choose your AI](#choose-your-ai).

<p align="center">
  <a href="https://railway.com/deploy/tarsee?referralCode=sIH3US&utm_medium=integration&utm_source=template&utm_campaign=generic"><img src="https://railway.com/button.svg" alt="Deploy on Railway"></a>
</p>

---

## Why Tarsee?

I was using [OpenClaw](https://github.com/openclaw/openclaw) to run Claude Code 24/7. It worked — until Anthropic changed their billing so OAuth tokens used through these wrappers started counting against your subscription usage. That's fine, but the resource overhead was heavy for what I needed.

I just wanted Claude Code running 24/7 that I could talk to from my phone. So I wrapped the Claude Code SDK directly and built a lightweight frontend. No build step, no TypeScript compile, no framework overhead.

Haven't looked into Claude Cowork yet, but if you love Claude Code and want it always on from any device, this is it.

It started as Claude only. It now also runs on OpenAI's Codex, so the same agent, with the same tools, memory and channels, works on a ChatGPT plan, an OpenAI, OpenRouter or DeepSeek key, or a model on your own machine.

### How Tarsee Compares

Being honest — some of these projects are massive with huge communities. Tarsee is small and focused. Here's where it fits:

| | Tarsee | [OpenClaw](https://github.com/openclaw/openclaw) | [NanoClaw](https://github.com/qwibitai/nanoclaw) | [PicoClaw](https://github.com/sipeed/picoclaw) | [Nanobot](https://github.com/HKUDS/nanobot) |
|---|--------|----------|----------|----------|---------|
| **Stars** | New | 353K | 27K | 28K | 39K |
| **Language** | Node.js | Node.js + TypeScript | TypeScript | Go | Python |
| **Frontend** | Vanilla HTML/CSS/JS | React + Primer UI | React | Go Web UI + TUI | Python CLI |
| **Build step** | None | TypeScript + Vite | TypeScript | Go compile | pip install |
| **RAM** | about 500 MB | Higher (full React stack) | Moderate | <10MB | Low |
| **Channels** | Web, Telegram, Discord, WhatsApp, Slack, Email, Voice | 24+ (WhatsApp, Slack, Signal, etc.) | WhatsApp, Telegram, Discord, Slack | 18+ (Telegram, Discord, WeChat, etc.) | 12+ (Telegram, Discord, WhatsApp, etc.) |
| **Voice** | Yes (faster-whisper + local Phonon TTS) | Yes (wake word, ElevenLabs) | No | No | Telegram/WeChat voice |
| **Mobile** | PWA + iOS PIN pad | Native iOS/Android apps | Via messaging apps | Android APK | Via messaging apps |
| **Memory** | Persistent + deep search | Session-based with group isolation | SQLite + per-group files | JSONL memory store | Token-based memory |
| **Auth** | Claude or ChatGPT plan sign-in, or API keys | OAuth + API keys | API keys | API keys + OAuth | API keys + OAuth |
| **LLM support** | Claude, OpenAI, DeepSeek, hundreds more through OpenRouter, local models | Claude only | Claude only | 30+ providers | Multi-provider |
| **Self-host cost** | about $6/mo Railway (measured) | Higher (more resources) | Moderate | ~$10/mo (runs on anything) | Low |

### Why choose Tarsee?

- **You want simplicity** — no build step, no TypeScript, no framework. Just Node.js serving HTML.
- **You want a real coding agent behind it** — Tarsee runs the vendors' own agents directly (Claude Code and OpenAI's Codex), not a homemade loop, with your choice of AI behind them.
- **You want it cheap** — Railway runs about $6/mo for one person's everyday use (measured, Sept 2026). A Claude or ChatGPT plan you already pay for adds no per-message cost; DeepSeek or a free OpenRouter model costs cents or nothing.
- **You want voice + mobile** — PWA with local speech-to-text, hold-to-talk, iOS PIN pad login.
- **You want memory** — persistent memory across sessions with deep semantic search.
- **You want browser automation** — stealth Playwright with captcha solving built in.

### Why choose something else?

- **You need 20+ channels** — OpenClaw or PicoClaw support way more platforms.
- **You need native mobile apps** — OpenClaw has actual iOS/Android apps.
- **You need a provider Tarsee doesn't connect to directly** — PicoClaw supports 30+ LLM providers natively. Tarsee connects seven ways (two plans, four kinds of API key and local models); others, such as Gemini, go through OpenRouter.
- **You need minimal resources** — PicoClaw runs on <10MB RAM. Tarsee needs about 500 MB.
- **You want a massive community** — OpenClaw has 353K stars and thousands of contributors.

Tarsee wraps the vendors' own agents — not a fork, not a rewrite. Claude models (and DeepSeek's, and OpenRouter's Claude models) run on `@anthropic-ai/claude-agent-sdk`, Claude Code; OpenAI's and local models run on `@openai/codex-sdk`, Codex. Either way you get that agent's own file and shell tools plus Tarsee's own tools on top. Tarsee picks the engine for each AI: you only choose the AI.

---

## Quick Start (Railway)

1. Click **Deploy on Railway** above
2. **Change the `SETUP_PASSWORD`** — this is your 4-digit PIN to access the web UI. Everything else is pre-configured.
3. Deploy — open the URL, log in with your PIN
4. The setup wizard asks you to **Choose your AI**: **My Claude plan**, **My ChatGPT plan**, or **My own API key**. Follow the steps it shows (they are also in [docs/providers.md](docs/providers.md)):
   - **A plan:** sign in once. For Claude, open **Tarsee's Terminal** (a terminal on the server, not your own computer), type `claude auth login` and open the link it prints. For ChatGPT, click **Sign in with ChatGPT** and type the one-time code it shows at the link.
   - **An API key:** paste it in, click **Test**, then **Use this AI**.
5. Voice works right away: on first boot Tarsee downloads its local voice (Phonon, about 72 MB) to the volume in the background, and Edge TTS speaks in the meantime.

That's it. Sign-ins are kept on the Railway volume and survive restarts and redeploys; keys are stored encrypted in Tarsee's database. To set it up without the wizard, use Railway variables instead (see [Choose your AI](#choose-your-ai)).

The image pins both agents: the Claude Code CLI at the version the Agent SDK bundles (`CLAUDE_CODE_VERSION`, 2.1.319, in the Dockerfile; the build stops if the two differ) and Codex at the `@openai/codex-sdk` version in package.json. Neither updates itself, and a rebuild keeps them. Set `TARSEE_AUTO_UPDATE_CLI=1` to install the latest Claude Code CLI on every boot instead. The Claude model list comes with that CLI, so newly released Claude models show up after a version bump; ChatGPT's list comes from your account.

### Staying Updated

If you deployed from the Railway template, your instance is a snapshot — it won't auto-update. To get the latest features:

1. Go to your Railway service → **Settings → Source**
2. Connect it to `projectservan8n/Tarsee` on GitHub
3. Every push to main will auto-deploy to your instance
4. Your data on `/data` is safe — the volume persists across redeploys

---

## Choose your AI

Tarsee runs on any of these seven, and you can connect several at once. Pick the default in the setup wizard or in **Settings > AI**; each chat can pick its own from the model menu under the message box, and `/model` switches from any channel. Tarsee picks the engine for each one by itself (Claude Code or Codex): you only choose the AI.

| AI | What you need | What it costs | Good to know |
|---|---|---|---|
| **Claude plan** | A paid Claude plan (Pro, Max or a Team seat). Sign in once: `claude auth login` in Tarsee's Terminal, or set the Railway variable `CLAUDE_CODE_OAUTH_TOKEN` to the token `claude setup-token` prints | No per-message cost: it uses your plan's limits | Pro runs out quickly with an agent; Max lasts much longer. For your own use |
| **ChatGPT plan** | A ChatGPT account, Free included. In ChatGPT's Settings → Security, under App security, turn on **Enable device code sign-in for Codex**, then click **Sign in with ChatGPT** in Settings > AI and type the one-time code (or run `codex login --device-auth` in the Terminal) | No per-message cost: it uses your plan's Codex limits. Free plans get a smaller model with limited use | The model list shows only what your account can use. Replies arrive a message at a time. For your own use |
| **Anthropic API key** | `ANTHROPIC_API_KEY` from the Claude Console | Pay per use, billed by Anthropic | Set a spend limit in the Console |
| **OpenAI API key** | `OPENAI_API_KEY` from the OpenAI Platform | Pay per use, billed by OpenAI | Give the project a monthly budget with a hard limit. Replies arrive a message at a time |
| **OpenRouter** | `OPENROUTER_API_KEY` from openrouter.ai | Pay per use at each model's price; models marked Free cost nothing | Hundreds of models with one key. Claude and OpenAI models work straight away; any other needs one click on **Verify** first. Give the key a credit limit |
| **DeepSeek** | `DEEPSEEK_API_KEY` from platform.deepseek.com | Pay per use from a balance you top up: the cheapest per message | DeepSeek Flash for everyday use; DeepSeek Pro thinks harder but can't see pictures |
| **Local AI** | `TARSEE_LOCAL_AI_URL`: the address of your Ollama or LM Studio server (and `TARSEE_LOCAL_AI_KEY`, only if it asks for one) | Free: it runs on your own hardware | Verify a model before you rely on it: small models use tools poorly. On Railway, run it as another service on the private network |

Each one's full setup, the same steps the app shows, is in **[docs/providers.md](docs/providers.md)**.

**Where keys go.** Paste a key into its card in **Settings > AI**, where it is stored encrypted and only its last 4 characters are ever shown again, or set it as a Railway variable (your service > Variables). Keys belong in one of those two places and never in files: not in the repository, not in `.env.example`, not in a chat message. Each key is only ever sent to its own provider, and a key set as a variable never changes which AI answers by itself. Set `ENCRYPTION_KEY` before you save a key in Settings. The commands the agent runs don't get an AI's key in their environment, but on a Linux server they run as the same user as Tarsee, so they can still read the key from Tarsee's processes or its data folder: give every key a spending limit at its provider, which is the real guard ([details](docs/providers.md#tools-on-every-ai)).

**Plan or API key?** Signing in with a Claude or ChatGPT plan is for your own personal use, under Anthropic's and OpenAI's terms. If other people talk to this Tarsee (a team, customers, a shared channel), use an API key.

### API keys only

**Settings > AI** has a switch, **Only use API keys**. With it on, Tarsee never uses a Claude or ChatGPT plan sign-in: every message is billed to an API key. The Railway variable `TARSEE_KEYS_ONLY=1` locks it on, so it can't be switched off from the dashboard.

### Set it up with Railway variables only

Set `TARSEE_AI_PROVIDER` to `claude`, `anthropic`, `chatgpt`, `openai`, `openrouter`, `deepseek` or `local`, plus that AI's key (or `TARSEE_LOCAL_AI_URL`, or `CLAUDE_CODE_OAUTH_TOKEN` for the Claude plan), and once that AI is ready the setup wizard is skipped. `TARSEE_AI_MODEL` picks its model (empty: that AI's default; for Local AI, the first model its server lists, so set it to pin one). A choice made later in Settings > AI wins over these.

### Keeping the cost down

- **A spending limit at the provider** is the surest cap: a credit limit on the OpenRouter key, a small DeepSeek top-up, a project budget with a hard limit at OpenAI, a spend limit in the Claude Console. Each guide in [docs/providers.md](docs/providers.md) shows where.
- **Monthly spending cap** (Settings > AI, optional): counts what the API-key AIs cost this month and stops using them at the cap until next month.
- **Backup** (Settings > AI, optional): when the default AI is out of credit, signed out or down, Tarsee answers with the backup you picked, and says so.
- Background work (crons, the heartbeat) runs on the chosen AI's smaller model with a spend ceiling per job. The Usage page shows what each AI cost: exact where the provider reports it, marked "est." where Tarsee works it out, and "Included in plan" for the plans.

---

## What You Get

### Chat Everywhere
- **Web UI** — A calm chat in the style of claude.ai: every chat has its own address (`/chat/<id>`, `/chat/new`) with Back/Forward and shareable links, a plain sidebar grouped by where each chat lives (Web, Telegram, Discord, WhatsApp, Email, Slack, and Background for crons and the heartbeat while they run), search, and a rename / fresh session / delete menu on each chat. Markdown, code blocks, tables, file attachments, image paste, drag-and-drop, multi-file upload. PWA — save to homescreen on iOS/Android.
- **Tool steps that stay out of the way** — while the agent works, one quiet line in the answer's place ("Working · 3 steps · Reading README.md · 84.2k tokens · 41 tk/s", with Stop); once it answers, the steps fold into "Used 12 tools" above the reply, each opening to its input and output. The line opens even before the first step: to a summary of what the model is thinking (for messages sent from the dashboard; it costs the answer about 3 seconds, so Telegram, Discord, email and voice replies do without), an API error it is retrying, or compacting.
- **Queued, not cancelled** — a message sent while a reply is running shows as "Queued · after the reply above" (no timer) and becomes the working line when its turn begins. Its own Stop takes just that message out of the queue.
- **Problems in plain words** — instead of a "401 / Failed to authenticate" error arriving as the reply, the chat says what happened and what to do, the same on every channel: the Claude sign-in expired (run `claude auth login` in the Terminal, the `>_` button, on phones too), the ChatGPT sign-in expired (sign in again from Settings > AI), the balance is empty or a key's limit is reached (with where to top up).
- **Telegram** — Text, photos, PDFs, voice messages, video notes. Group @mention support, inline buttons, forwarded message detection.
- **Discord** — Text, images, PDFs, voice messages. Always-online bot with presence status.
- **Email** — Real-time over IMAP IDLE + SMTP. Mention keyword (default `@tarsee`) gates replies; CC/BCC/forwards are absorbed as context without an outbound. Works with any mailbox that allows IMAP + SMTP with an app password (Gmail, iCloud, Zoho, FastMail, Yahoo, self-hosted; not Outlook.com or Microsoft 365).
- **WhatsApp** — Text, images, PDFs, voice notes (Whisper-transcribed), and documents via [WHAPI Cloud](https://whapi.cloud) (free tier OK). Direct messages only. Per-channel webhook secret in URL, auto-generated on first enable.
- **Slack** — DMs, and channels by @mention. Every reply goes in a thread and each thread is its own conversation; a thread Tarsee is in needs no more mentions, and a mention in someone else's thread reads the thread first. Replies stream with Slack's native AI streaming, a live card for each tool it runs, and Slack's stop button; where a workspace has no native streaming, replies are posted and edited instead. Markdown renders as written (tables and code included). Images, PDFs, voice clips (Whisper-transcribed) and any other file in; files out as real uploads. `/tarsee` for questions and commands. Socket Mode, so no public URL; the app is made from a manifest Settings copies for you.
- **Attachment save-to-disk** — every image, PDF, voice note, and document sent via Discord, Telegram, email, WhatsApp, Slack, or web lands in `workspace/uploads/` so the AI can read, transform, and reference it across turns (not just in the message it arrived on).
- **Live on every device** — one durable timeline per conversation (messages, turn start/end and every tool step) that every channel feeds and every device follows over WebSocket. A device that sleeps or reconnects catches up from the last event it saw, even across a restart, and a Telegram, Discord, WhatsApp, Slack or email turn can be watched (and stopped) live from the dashboard. Sends are optimistic and never lost; a message sent while a reply is running queues behind it instead of cancelling it.
- **Session recap** — resume a conversation idle >30 min and a dismissible "Last time" card summarizes the last few exchanges before the first new message. Zero AI cost (extractive summary).
- **Web Push notifications** — iOS/Android/desktop push via VAPID when cron jobs finish, webhooks fire, or the agent proactively pings you via the `tarsee_push_notification` tool. Opt-in from Settings > Appearance.
- **All channels share** the same AI, memory, and tools.

### Voice Mode
- **Hold-to-talk or tap-to-toggle** — full-screen conversational UI with waveform visualization.
- **Live tool status** — shows "Reading file...", "Running command...", "Calculating..." instead of generic "Thinking..."
- **Spacebar shortcut** — hold space to talk, Space+C to cancel.
- **Drag to cancel** — slide away from the orb or mic button to discard recording.
- **Local speech-to-text** — faster-whisper (CTranslate2, 4x faster than OpenAI whisper). Configurable models: tiny.en / base.en / small.en. No API key. Runs on CPU.
- **Local text-to-speech by default** — [Phonon](https://huggingface.co/gradium/phonon-31m-en), Gradium's open 31M model, runs on the server's CPU through one warm worker: no API key, no per-character cost, 25 English voices (Toby by default) and a speed setting. Peso amounts ("₱2,500", "PHP 2,500") are read as pesos; reading a bare "P2,500" that way is an opt-in setting.
- **Downloads itself** — the model and voices (about 70 MB) go to the data volume, not the image. On first boot Tarsee fetches them in the background from pinned Hugging Face revisions, checking the weights' sha256; Settings > Voice shows the progress and has an **Install Phonon** button (and Retry if it fails). Turn the automatic download off with `TARSEE_PHONON_AUTO_INSTALL=0`, or run `node src/voice/phonon-install.js` from a terminal.
- **Free fallback** — Microsoft Edge TTS (19 voices, 3 retries, markdown stripping, no API key) speaks while Phonon downloads, and for any sentence Phonon fails; after three failures in a row Phonon is skipped for five minutes. Tarsee never falls back to a paid engine on its own: ElevenLabs and Piper are used only when you pick them (or Auto) in Settings > Voice. An install that already has an ElevenLabs key but never saved an engine keeps ElevenLabs; pick Phonon in Settings > Voice to switch.
- **Smart TTS** — tables and code shown visually, spoken response is a clean conversational summary.

- **Multilingual speech-to-text** — the bare `tiny`/`base`/`small` Whisper checkpoints auto-detect the spoken language; the `.en` variants are English-only and will return garbage for other languages. Switch in Settings > Voice.

### Canvas / Artifacts
- **Live HTML/CSS/JS** — Ask for a dashboard, chart, calculator, or mini-app → renders as an interactive iframe right in chat.
- **Canvas gallery** — browse all your canvases at `/canvas/`.
- **Persistent** — Canvases are saved to the volume and accessible at `/canvas/<id>/`.

### Tools & Automation
- **20+ MCP tools** — send messages, schedule tasks, remember facts, search the web, create canvases, manage files, encrypted vault, calculator, browser, push notifications, email threads, and more.
- **Calculator** — precise math tool so the AI never hallucinates numbers. Arithmetic, percentages, Math.* functions.
- **Sends files** — ask for a report, an export or a picture on Telegram, Discord, WhatsApp or Slack and `tarsee_send_file` sends it as a real attachment to that chat (Telegram up to 50 MB, Discord 25 MB, WhatsApp 16 MB, Slack 100 MB; on Slack into the same thread). Email files go as attachments through `tarsee_send_email_thread`.
- **Files in the dashboard chat** — every file the agent sends and every file people send in shows on the message it came with, in any chat: a picture or video as a tile, a PDF with its first page, a sound as a waveform player. A click opens it in the viewer (pictures zoom, PDFs show their pages, CSV as a table, text and code as text), with Download always there. Kept copies live in the workspace's `uploads` folder for 30 days.
- **Keys by name** — the vault's keys are in the agent's environment, so its scripts read `OPENAI_API_KEY` and the like by name and a key never goes into a command. Not when `get_key` is denied in Tool Permissions; `TARSEE_AGENT_ENV_KEYS` limits or turns it off.
- **Discord admin** — `tarsee_discord_admin` lists, makes and edits Discord channels (public, private for listed people and roles, or copying another channel's access) and makes webhooks, using Tarsee's own logged-in bot, so the agent never needs the bot token in a command. Every change needs the owner's go, passed as `approved_by` and written to the server's audit log. A new webhook's URL goes straight into the vault under a key name and comes back masked. Nothing in the tool deletes.
- **Stealth browser** — Playwright with anti-detection (real fingerprints, no webdriver flag). Navigate, fill forms, screenshot, scroll, wait, run JS.
- **Captcha solver** — auto-detect and solve reCAPTCHA, hCaptcha, Cloudflare Turnstile via 2Captcha or Capsolver API.
- **Proactive briefings** — `/briefing on` schedules a daily morning summary pushed to all channels.
- **Auto model routing** — `/auto on` picks your AI's small, everyday or top model (haiku/sonnet/opus on Claude) based on message complexity.
- **Deep memory search** — AI reads all memories semantically when keyword search fails.
- **Cron scheduler** — recurring AI tasks or direct tool actions. One-time reminders auto-delete. Tarsee never runs the AI on its own unless you set the job up: a task the AI schedules in a chat is saved paused, and runs only once you switch it on in Settings > Automation > Scheduled tasks or with `/cron on <id>`. A scheduled run, the heartbeat and BOOT.md can't schedule more tasks, a task that asks the AI runs at most once every 15 minutes, and a run still going when its next time comes is skipped. On a chat platform, `/cron`, `/briefing` and `/webhook` answer only the owner: someone whose own user ID (on WhatsApp, their number) is on that platform's allowlist.
- **Railway tool** — `tarsee_railway` lists your Railway projects, services and variable names, sets a variable and redeploys a service, with an account or workspace token from the vault (`RAILWAY_API_TOKEN`). A secret goes in by vault key name (`from_key`), so it never passes through a chat or a command; values are never read back. Changes need someone's go (`approved_by`), and nothing in it deletes. On Railway, leaving out the project means Tarsee's own service, and redeploying that restarts Tarsee.
- **Web terminal** — browser-based shell access via xterm.js.
- **File manager** — browse, edit, and create workspace files from the UI.
- **REST API** — `/api/v1/message` endpoint for iOS Shortcuts, scripts, and automations.
- **Skills** — modular instruction packs with credentials and configs. The agent reads them automatically when relevant. Ships with `/ultrareview` (3-agent parallel branch review — correctness / architecture / UX-a11y) and `/fewer-permission-prompts` (proposes a tool-allowlist patch from your audit log) preinstalled.
- **`/checkpoint` — cross-restart handoff** — manual AI-synthesized `CHECKPOINT.md` before a known redeploy, plus an activity-gated auto-checkpoint every 6h as a safety net. On the next boot, the checkpoint is injected into the system prompt so work picks up mid-thought instead of starting cold.
- **Retention** — daily 03:00 sweep prunes conversations idle >14 days and checkpoint archives older than 30 days (or >50 files). Keeps the most recent thread per channel so Discord/Telegram/email session continuity never breaks. One-line summaries of pruned conversations append to `memory/archived-conversations.md` so nothing vanishes without a record. Configurable via `retention.*` settings or `/retention` command.

### Cost Controls
- **Cheap floor for unattended work** — cron jobs, the 30-minute heartbeat and the boot checklist run on the AI's small model by default (the Haiku alias on Claude), not the interactive model. Raise a specific one with the `cron.defaultModel`, `heartbeat.model` or `boot.model` setting, or per job with `job.model`: each takes a tier word (haiku, sonnet, opus), a model of the default AI (for example `deepseek-v4-pro` on the DeepSeek key) or a `provider:model` ref. A name the default AI doesn't offer, or a Local AI or OpenRouter model that hasn't been verified, is logged and the small model runs instead. A zero-token keyword heuristic escalates a cron job to Sonnet or Opus when its prompt clearly warrants it.
- **Hard ceilings** — every background turn carries a wall-clock timeout, a turn cap well below the interactive limit, and a spend ceiling (enforced by the engine where it can, otherwise by Tarsee from the live usage). A job stopped by one is reported as failed, not as a successful empty run. On an AI whose cost is only known once the job has finished (an OpenAI key, or OpenRouter's GPT models), a finished job that went over its spend ceiling keeps its reply and is marked "over its spending limit" in its post, its status and its notification; it is not run again.
- **No duplicate boot spend** — BOOT.md runs once per build, keyed to the commit and a hash of the file. A crash-looping container no longer pays for a model turn on every restart.
- **One turn at a time per conversation** — a second message queues instead of starting a concurrent turn against the same session.
- **Automatic fallback** — an overloaded Claude model steps down a tier rather than failing the turn, and an optional **Backup** AI (Settings > AI) answers when the default one is out of credit, signed out or down.
- **Spending you can see and cap** — the Usage page shows each AI's spend (exact where the provider reports it, "est." otherwise, "Included in plan" for the plans), Settings > AI shows OpenRouter's and DeepSeek's balance, and an optional **Monthly spending cap** stops the API-key AIs at a limit you set.

### Security
- **Tool Permissions are enforced** — Settings > Tool Permissions gates real execution at the single point every tool call passes through. Setting a tool to `always_deny` stops it, tells the model not to work around it, and records the attempt in the audit log. This covers Tarsee's own tools on every AI; the engines' built-in shell and file editing are not gated, on any AI.
- **Credentials encrypted at rest** — bot tokens, IMAP/SMTP passwords and webhook secrets are encrypted field-by-field inside channel configs, and are never returned to the browser (the API reports `hasToken` / `hasPassword` instead).
- **SSRF protection** — the fetch and browser tools refuse loopback, RFC1918 and link-local targets, including the `169.254.169.254` cloud metadata endpoint.
- **Scoped file access** — the file manager is confined to the workspace and cannot reach the AI sign-ins, encryption key, API token or database.
- **Credentials kept apart** — each AI's sign-in and key lives in its own folder and only reaches its own turns, and a key is only ever sent to its own provider's address. A key set as a variable never changes which AI answers or how you are billed: only your choice in Settings > AI (or `TARSEE_AI_PROVIDER`) does.
- **Isolated canvases** — model-authored pages require a login and run in a sandboxed null origin, so a prompt-injected canvas cannot reach Tarsee's API or storage.

### Models
- **Every ready AI in one picker** — the composer's picker lists the models of each AI that is ready, the default AI first; each chat keeps its own pick, and switching AI mid-chat carries the recent conversation over. `/model <provider> [model]` does the same from any channel.
- **Each AI's own models** — Claude (plan or key): Claude Code's catalog, below. ChatGPT plan: only the models your account can use, read from the account. OpenAI key: the models your key can use. OpenRouter: Recommended, Verified by you, and All models (Free ones marked). DeepSeek: DeepSeek Flash and DeepSeek Pro. Local AI: whatever your server has.
- **Verify** — a model with no tested path yet (most OpenRouter makers, every Local AI model) gets a one-click **Verify** in Settings > AI: a few short test turns that check it can reply, use Tarsee's tools and the shell, and pick up where it left off. The picker lists it once it passes.
- **Sonnet at Medium by default on Claude** — the Claude default is the `sonnet` alias at Medium effort (`ai.defaultEffort` changes the effort; Settings or `/model` the model).
- **Always the newest model** — the Agent SDK runs its own bundled Claude Code, which would take a bare alias (`opus`, `sonnet`, `haiku`, `fable`) to the newest model *it* knew when it was built, several releases behind. Tarsee reads Claude Code's current model catalog (from the installed `claude`, or the copy the CLI cached for your account) and turns an alias into the newest exact model id before every turn. Pinned ids (`claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-8`, …) remain selectable when you need a frozen, reproducible model.
- **Tiers** — `fable`, `opus`, `sonnet` and `haiku` are all available as always-latest aliases, in capability-descending order, and `/model <name>` accepts either an alias or a pinned id. Fable is the top tier: `/model fable` tracks the newest Fable release, and `claude-fable-5-1` is selectable as a frozen pin.
- **Automatic fallback on Claude** — every turn ships a `--fallback-model` ladder one tier below whatever you chose, so an overloaded Fable turn degrades to Opus instead of failing.

### Search & Analytics
- **Context kept lean** — ported from TarseeMacOS, where they were measured on long jobs: the chat's context is summarized at 180k tokens (`TARSEE_COMPACT_WINDOW`), a long Bash output or tool result goes to a file the agent can read (`TARSEE_BASH_OUTPUT_MAX_CHARS`, `TARSEE_TOOL_RESULT_MAX_CHARS`), each quick memory is one line of at most 300 characters and each skill a short description in the system prompt, a workspace file may be 12 KB there (a longer one is cut and the cut is logged), and `MEMORY.md` is never inlined or read whole: the agent greps it for what a task needs.
- **Live context meter** — the session bar shows a real-time prompt-token fill % against the window Claude Code works in: the auto-compact window (180k by default, `TARSEE_COMPACT_WINDOW`), or the model's own (1M for Opus/Sonnet, 200K for Haiku) when that is smaller or compaction is off. Near the top Claude Code summarizes the older part and the chat carries on. Counts cache reads and cache writes too — that's the actual prompt size hitting the model. Bar turns yellow at 75%, red and pulsing at 90%, with a dismissible banner above the composer. At 95% (reached when compaction is off) Tarsee writes a mechanical snapshot to `CHECKPOINT.md` automatically; if a turn still trips "prompt is too long", the snapshot is written from the catch path and a recovery card is shown in chat with a one-click "Start fresh session" button. The next boot reads that checkpoint as the handoff so you pick up mid-thought.
- **Usage page** (`/usage`, from the sidebar) — every model call's tokens (input, cache read, cache write, output), read from Claude Code's own session transcripts: today, the last 5 hours and 7 days, a 14-day and 24-hour chart, tokens by model, channel and chat, output and total tokens per second, and each job (a chat's turns until it sits idle 45 minutes; each cron run on its own) with its turns, which you can rename, merge and split. Each reply gets a quiet line with its turn's tokens, speed and time, and a chat's menu shows its running total. Days are counted in `TARSEE_TIMEZONE`.
- **Token Health** (Settings > Token Health) — a per-conversation view of how full each context window actually is, alongside the Claude session transcript (`.jsonl`) size, which is the real driver of bloat-hangs. Fill is measured point-in-time (the most recent turn's prompt size, counting cache reads and cache writes), not a running total of every token the chat ever spent — the lifetime figure is reported separately so the two can't be confused. Conversations whose transcript passes `TARSEE_SESSION_JSONL_MAX_MB` are flagged `resets next turn`, and the provider enforces that same cap by refusing to resume, so the flag reflects real behaviour rather than predicting it. Conversations with no recorded telemetry are labelled `est.` rather than shown as if measured. All channels (Telegram, Discord, WhatsApp, Slack, email, web) now record token usage — previously only web chat did, so channel conversations had no data at all.
- **Audit log** — timestamped log of all tool executions, logins, and settings changes.
- **QR code** — scan from desktop to instantly open Tarsee on your phone.
- **Typing indicator** — see when you're typing on another device in real-time.
- **Todo rendering** — the agent's task lists render as styled checklists with progress indicators.

### Memory & Identity
- **Workspace files** — SOUL.md (personality), MEMORY.md (knowledge), USER.md (user info), IDENTITY.md.
- **Auto-memory** — the agent saves important facts as you chat. Memories persist across sessions.
- **Daily logs** — timestamped notes auto-appended to `memory/YYYY-MM-DD.md`.
- **Checkpoints** — `CHECKPOINT.md` on the volume survives redeploys. Read once on the next boot, then archived to `memory/checkpoints/<timestamp>.md` for grep-able history.

### Appearance & Controls
- **Themes** — `warm-charcoal` (default, terracotta accent), `noir` (pure black OLED-friendly), `solarized-light` (daylight), `jarvis-blue` (cyan accent). Switch from Settings > Appearance or via `/theme <name>`. Plugin-shipped themes are loaded from `ui.themes.plugin` automatically.
- **Model and effort picker** — the button beside Send ("Sonnet 5.5 · Medium") opens a picker like Claude Code's: a group for each ready AI with its models (number keys pick the ones on top), Effort (Low, Medium, High, Extra, Max, as far as that model goes) and search. Claude's list is Claude Code's own model catalog and ChatGPT's comes from your account, so new models appear with no code change. Each chat keeps its own pick; `/effort` opens the Effort list.
- **Your own icon** — Settings > Appearance takes a PNG, JPG, WebP or SVG, crops it square, and serves it as the favicon, tab, home-screen and app icon.
- **Own dialogs** — every confirmation is the dashboard's own dialog, never the browser's `confirm()` / `prompt()`.

---

## How It Works

```
You (web / telegram / discord / whatsapp / slack / email / voice / iOS push)
  |
  v
Tarsee Server (Railway)
  |
  +-- One turn layer: picks the AI and its engine, Stop, queue, live view,
  |   sessions, the handoff when a chat switches AI, budgets, the backup AI
  |     |
  |     +-- Claude Code (Agent SDK; CLI pinned in the Dockerfile)
  |     |     Claude plan, Anthropic key, DeepSeek, OpenRouter's Claude models
  |     |     Built-in: Read, Write, Edit, Bash, Grep, Glob
  |     |
  |     +-- Codex (@openai/codex-sdk, pinned)
  |           ChatGPT plan, OpenAI key, Local AI, OpenRouter's OpenAI models
  |           Built-in: shell, apply_patch, todo list
  |
  |   Tarsee's own tools on both (in process on Claude Code, over a
  |   private loopback endpoint on Codex): send_message, send_file,
  |   schedule_task, remember, create_canvas, calculator, browser,
  |   web_search, pdf_read, push_notification, send_email_thread, etc.
  |
  +-- Voice:      faster-whisper STT + Phonon TTS (Edge TTS fallback)
  +-- Browser:    Playwright (stealth) + captcha solving
  +-- Workspace:  SOUL.md, MEMORY.md, USER.md, CHECKPOINT.md
  +-- SQLite:     conversations, settings, vault, bot_memory, push_subs
  +-- Channels:   Telegram, Discord, WhatsApp, Slack (Socket Mode), Email (IMAP IDLE + SMTP)
  +-- Continuity: /checkpoint + 6h auto-checkpoint + session recap card
  +-- Retention:  daily 03:00 sweep (14d convs, 30d/50-file checkpoints)
  +-- Push:       VAPID + service worker — cron/webhook/tool fires
```

---

## Channel Setup

Configure in **Settings > Channels** after deploying (the setup wizard's last step takes you there too). Each platform has its own section with step-by-step instructions and a status line: save a token and it connects at once, then says *Connected as …* or, if something's wrong, what to fix.

| Channel | How to get token | Features |
|---------|-----------------|----------|
| Telegram | [@BotFather](https://t.me/BotFather) | Text, photos, PDFs, voice, video notes, inline buttons, groups |
| Discord | [Developer Portal](https://discord.com/developers) | Text, images, PDFs, voice messages, reactions, presence |
| Email | IMAP + SMTP (any provider — see below) | Real-time mail, `@mention` gate, CC/BCC context absorb, threaded replies |
| WhatsApp | [WHAPI Cloud](https://panel.whapi.cloud) | Text, images, PDFs, voice notes (Whisper-transcribed), documents. DMs only. |
| Slack | [api.slack.com/apps](https://api.slack.com/apps?new_app=1), from Tarsee's manifest | DMs and @mentions, a thread per conversation, native streaming with tool cards, files both ways, voice clips, `/tarsee` |

**Telegram:** send [@BotFather](https://t.me/BotFather) `/newbot`, pick a name and a username ending in `bot`, and paste the token it gives you. In groups the bot answers @mentions and replies to it; to have it read every group message (mention mode off), also send BotFather `/setprivacy` → Disable, then remove and re-add the bot to the group. A chat ID for the allowlist shows in the Console (`[telegram] … chat <id>`) when someone messages the bot.

**Discord:** In the [Developer Portal](https://discord.com/developers/applications): **New Application** → **Bot** → **Reset Token** and copy it; on the same page turn on **Message Content Intent** and save. Paste the token in Tarsee; once it says *Connected*, an **Add the bot to a server** button appears with the permissions it needs (View Channels, Send Messages, Send Messages in Threads, Read Message History, Attach Files, Embed Links, Add Reactions). For `tarsee_discord_admin`, also give the bot's role Manage Channels, Manage Roles (to set who can see a channel) and Manage Webhooks; without them the tool says which permission is missing and changes nothing.

**WhatsApp:** Tarsee uses [WHAPI Cloud](https://whapi.cloud) as the WhatsApp gateway (free tier is enough for personal use). Setup:

1. Sign up at [panel.whapi.cloud](https://panel.whapi.cloud/register); a free trial channel is made for you. Scan its QR code from the WhatsApp account you want Tarsee to use (WhatsApp → Linked devices → Link a device).
2. Once it's connected, copy the channel's **API token**.
3. In Tarsee → `Settings > Channels > WhatsApp`, paste the token and click Save. A **webhook URL** appears.
4. In WHAPI, open the channel's **Settings** (top right): paste that URL in the webhooks block, set **Mode** to **Body** (the other modes change the URL), turn on the `messages` event with `POST`, and save. **Check webhook** tests it.
5. From another phone, send a WhatsApp message to the linked number — Tarsee replies.

The webhook URL has to be public (a Railway domain works; `localhost` needs a tunnel). WHAPI's free sandbox covers 5 different people a month and 150 messages a day, and WhatsApp unlinks the device if the phone doesn't open WhatsApp for 14 days.

Direct messages only; group messages are silently ignored. Voice notes are transcribed locally via faster-whisper. Images and PDFs go to the AI (a PDF as its text for an AI that can't open PDFs). Other documents (DOCX, XLSX, ZIP, TXT, CSV, etc.) are saved to `workspace/uploads/` and the agent can open them with its file tools.

**Slack:** Tarsee connects with Socket Mode (it opens the connection to Slack), so there is no request URL to set up. The app comes from [`src/channels/slack-app-manifest.yml`](src/channels/slack-app-manifest.yml), which has every scope and event the bot uses.

1. In Tarsee → `Settings > Channels > Slack`, click **Copy app manifest**.
2. At [api.slack.com/apps](https://api.slack.com/apps?new_app=1): **Create an App → Paste a manifest → Continue**, open the **YAML** tab, replace what's there with the manifest, pick your workspace, **Next → Create**.
3. **Install App → Install to *your workspace* → Allow**, then copy the **Bot User OAuth Token** (`xoxb-…`). (Some workspaces need an admin to approve new apps first.)
4. **Basic Information → App-Level Tokens → Generate Token and Scopes**: any name, **Add Scope** `connections:write`, **Generate**, copy the token (`xapp-…`).
5. Back in Tarsee, paste both tokens and click Save. The section says ✓ *Connected as @tarsee in your workspace* once the bot is in.
6. DM the app (Apps → Tarsee), or add it to a channel (**Add people or agents**, or `/invite @Tarsee`) and @mention it there.

How it behaves: DMs are always answered; in channels and group DMs it answers an @mention (Settings > Bot Behavior can make it answer everything) and follows up without one in a thread it is already in. Mentioned in a thread it wasn't part of, it reads the thread's first message and latest 40 first, with anyone from another workspace, other bots and people not on the allowlist marked as such. `@Tarsee /stop` in a thread stops the reply running there. Each reply goes in a thread, and each thread is its own conversation in the sidebar. Replies stream with Slack's native streaming and a task card per tool; Slack ends one streamed message after 10 minutes or 12,000 characters, so a long reply carries on in the next message of the thread. If the workspace can't stream natively (Slack keeps some AI features for paid plans), replies are posted and edited instead, the way Discord's are. `/tarsee <a question>` starts a thread of its own and answers there; `/tarsee help` and `/tarsee status` (one word) or `/tarsee /model opus` (written with its slash) run a command privately; a command about one conversation (`/clear`, `/export`, `/think`) goes in its thread as `@Tarsee /clear`. Allowlist (Settings > Channels > Allowlist) takes member IDs (`U…`) and channel IDs (`C…`); people from another workspace (Slack Connect) are only answered when their own member ID is listed. Files up to 100 MB each way.

---

### Email channel

Tarsee can live in any mailbox you own and reply in real-time. Inbound mail where the body contains `@tarsee` (configurable) triggers a reply; everything else is absorbed silently so Claude remembers the thread and can answer questions about it later. CC'd, BCC'd, and forwarded mail never triggers an outbound reply.

**Setup (two paths — pick one):**

1. **Settings UI** — open `Settings > Channels > Email`, click your provider (it fills in the servers and says where to make the app password), paste your email + app password, save.
2. **Chat** — tell Tarsee in conversation: *"Set up email. Mailbox `tarsee@example.com`, Gmail app password `xxxx-xxxx-xxxx-xxxx`, only allow `you@example.com`."* Tarsee calls the `tarsee_configure_email_channel` MCP tool and the channel starts immediately.

Both paths write to the same `channel.email` record. The Settings UI renders whatever's configured regardless of which path set it.

**App passwords** (most providers require one instead of your login password):

| Provider | App-password page | IMAP / SMTP |
|---|---|---|
| Gmail | [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) | `imap.gmail.com:993` / `smtp.gmail.com:465` |
| iCloud | [account.apple.com](https://account.apple.com) → Sign-In and Security → App-Specific Passwords | `imap.mail.me.com:993` / `smtp.mail.me.com:587` |
| Zoho | Zoho Mail → Settings → Mail Accounts → IMAP Access; with two-factor on, [accounts.zoho.com](https://accounts.zoho.com) → Security → App Passwords. New free accounts get no IMAP. | `imap.zoho.com:993` / `smtp.zoho.com:465` (paid, own domain: `imappro` / `smtppro`) |
| FastMail | Settings → Privacy & Security → Manage app passwords and access → New app password (not on the Basic plan) | `imap.fastmail.com:993` / `smtp.fastmail.com:465` |
| Yahoo | [login.yahoo.com/account/security](https://login.yahoo.com/account/security) → Create app password | `imap.mail.yahoo.com:993` / `smtp.mail.yahoo.com:465` |

**Outlook.com, Hotmail and Microsoft 365 don't work:** Microsoft turned off app-password logins for IMAP (Outlook.com in September 2024, every Microsoft 365 tenant since), and requires its own OAuth sign-in instead. Use a mailbox from another provider for Tarsee.

Self-hosted IMAP/SMTP works too — pick `Custom` and fill in your host/port.

**Mention keyword** — defaults to `@tarsee`. Change it in Settings to `@jarvis`, `@bot`, or whatever alias you want. The leading `@` is part of what you type so it's obvious what you're setting.

**Reply-all** — opt-in only. Include `[reply-all]` in the subject (or type `@tarsee reply-all` in the body) and Tarsee will reply to everyone in To + CC. Default is reply-to-sender only.

**Sender allowlist** — strongly recommended. Only emails from listed addresses get processed. Leave empty for dev mode (not safe for production mailboxes). Newsletters and auto-reply loops are always dropped regardless (RFC 3834 `Auto-Submitted` / `Precedence` / `List-Id` headers).

**Troubleshooting:**
- **"Authentication failed"** — you probably pasted your login password. Most providers require an app-specific password (usually 16 characters with hyphens). See the table above.
- **"IDLE disconnected"** — harmless. IMAP servers close IDLE after ~29 minutes; Tarsee reconnects automatically.
- **Gmail "less secure apps"** — not relevant anymore. Use an app password and keep 2FA on.
- **Reply arrived but wasn't threaded** — verify your mail client shows `In-Reply-To` and `References` headers. Some bespoke clients strip them.

---

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/model [provider] [model]` | Switch AI or model: `/model deepseek`, `/model openrouter`, `/model opus` (an alias tracks the latest), a pinned id like `claude-fable-5-1`, or a ref like `deepseek:deepseek-flash`. `/model` alone lists what each ready AI offers |
| `/think low\|medium\|high\|xhigh\|max` | Set thinking effort for the session (ascending cost; `xhigh` sits between high and max; Medium is the default) |
| `/effort` | Open the composer picker's Effort list |
| `/theme [name]` | List or switch themes: warm-charcoal, noir, solarized-light, jarvis-blue |
| `/auto [on\|off]` | Toggle auto model routing (your AI's small, everyday or top model by complexity) |
| `/briefing [on\|off\|time]` | Morning briefing — run now, schedule daily, or set time |
| `/send telegram\|discord\|whatsapp\|slack\|web` | Forward conversation context to another channel |
| `/fork [from #N]` | Branch conversation — copy history into new session |
| `/play [name\|list\|save\|delete]` | Run or manage playbooks (multi-step AI workflows) |
| `/email [check\|summary\|draft]` | Check inbox, summarize, or draft emails (CLI helpers — see also the email channel for real-time chat) |
| `/webhook [list\|add\|remove]` | Manage webhook triggers (external events → AI) |
| `/files [search term]` | List or search workspace files |
| `/status` | Full dashboard (uptime, the AI in use and whether it's ready, tokens, messages, channels) |
| `/clear` | New conversation |
| `/cron [list\|add\|on\|off\|run\|remove]` | Manage scheduled tasks: `/cron on <id>` switches one on (a task the AI made waits for this), `/cron off <id>` pauses it |
| `/remember [fact]` | Save to memory |
| `/doctor [fix]` | Diagnostics + auto-repair |
| `/export` | Export conversation |
| `/checkpoint [list\|show]` | Write CHECKPOINT.md for the next boot — manual handoff (auto fires every 6h too) |
| `/retention [run]` | Preview or run the daily retention sweep on demand |
| `/ultrareview` | 3-agent parallel review of the current git branch (correctness / architecture / UX-a11y) |
| `/fewer-prompts` | Propose a tool-allowlist patch from your audit log to reduce permission prompts |

---

## Settings

| Tab | What's there |
|-----|-------------|
| **Identity** | Bot name (set via IDENTITY.md) |
| **Workspace** | SOUL.md, USER.md, MEMORY.md editors |
| **AI** | Choose your AI: a card per AI with its step-by-step setup, its key or sign-in, **Test** (with the balance where the provider has one) and **Verify**; the default AI, **Only use API keys**, the backup AI and the monthly spending cap |
| **Channels** | Telegram, Discord, WhatsApp (WHAPI), Slack (Socket Mode, native streaming), Email (IMAP + SMTP with provider presets, mention keyword, reply-all marker, allowlist) |
| **Appearance** | Theme switcher (4 built-in + plugin themes) + Web Push enable/disable/test |
| **Automation** | Scheduled tasks (each one's state, who made it, its whole prompt, Switch on / Pause), webhooks, retention settings |
| **Voice** | TTS engine (Phonon by default, Edge TTS, ElevenLabs, Piper, Auto), Install Phonon button with download progress, Phonon voice, speed and bare-"P" peso option, STT model, voice selection. Pick `tiny.en`/`base.en`/`small.en` for English-only, or `tiny`/`base`/`small` for **multilingual** transcription with language auto-detect (needed for Tagalog, Taglish and other non-English voice notes — the `.en` checkpoints cannot transcribe them at all). |
| **Skills** | Create, edit, delete instruction packs (includes preinstalled `/ultrareview` + `/fewer-permission-prompts`) |
| **Memories** | View and manage stored memories |
| **Security** | Security audit, tool permissions, captcha solver config |
| **Canvas** | Gallery of AI-generated interactive UIs |
| **Token Health** | Per-conversation context-window fill, transcript (.jsonl) size, and which sessions will reset on their next turn |
| **Audit Log** | All tool executions, logins, settings changes |

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SETUP_PASSWORD` | Yes | — | 4-digit PIN for the web UI. **Required in production** — the server refuses to boot without it, because nobody could log in and the web terminal would be exposed. |
| `ENCRYPTION_KEY` | Yes | made on the volume | AES-256 key for everything Tarsee stores encrypted: keys saved in Settings > AI, channel tokens, the vault. Make one with `openssl rand -hex 32` and set it before you save any key in Settings; keep the same one for good. Without it, one is made and kept on the volume next to the data it protects. |
| `NODE_ENV` | Yes | — | Set to `production` |
| `TARSEE_STATE_DIR` | No | `/data/tarsee` with a volume at `/data`, else `~/.tarsee` | The folder Tarsee keeps everything in: each AI's sign-in, and its database (with the keys saved in Settings > AI) and workspace unless `TARSEE_DATA_DIR` or `TARSEE_WORKSPACE_DIR` name other folders. With a volume, keep it inside `/data`, or it is lost on the next redeploy. Changing it later moves nothing: each sign-in, database and workspace stays in the folder it was made in, so set it back to find them again. The one exception is the upgrade from a version before multi-provider support, which kept the Claude plan sign-in in `/data/tarsee` whatever this said: if this names another folder in `/data`, the first boot moves that Claude plan sign-in and its chat history into it, one way, and nothing else. If that folder is already signed in, the old sign-in is renamed `.credentials.json.superseded` instead and is not used. |
| `TARSEE_AI_PROVIDER` | No | `claude` | The default AI when Settings > AI hasn't chosen one: `claude`, `anthropic`, `chatgpt`, `openai`, `openrouter`, `deepseek` or `local`. With that AI's key it skips the setup wizard. See [Choose your AI](#choose-your-ai). |
| `TARSEE_AI_MODEL` | No | that AI's default | The default AI's model when Settings hasn't chosen one (for example `sonnet`, or `deepseek-flash`). Empty means that AI's default; for Local AI, the first model its server lists (set it to pin one). |
| `TARSEE_KEYS_ONLY` | No | off | Set `1` to lock **Only use API keys** on: no Claude or ChatGPT plan sign-in is ever used. For a Tarsee other people talk to. |
| `ANTHROPIC_API_KEY` | No | — | Anthropic API key (`sk-ant-api…`), for **Anthropic API key**: Claude, billed per use. The Claude plan ignores it. A key saved in Settings > AI wins over this. |
| `OPENAI_API_KEY` | No | — | OpenAI API key, for **OpenAI API key**, billed per use. Voice uses it only if you pick Whisper API in Settings > Voice. |
| `OPENROUTER_API_KEY` | No | — | OpenRouter key (`sk-or-v1-…`), for hundreds of models with one key. Give the key a credit limit. |
| `DEEPSEEK_API_KEY` | No | — | DeepSeek API key, the cheapest per message, spent from a balance you top up. |
| `TARSEE_LOCAL_AI_URL` | No | — | Local AI: your Ollama or LM Studio server, e.g. `http://localhost:11434/v1`, or on Railway `http://ollama.railway.internal:11434/v1`. |
| `TARSEE_LOCAL_AI_KEY` | No | — | Local AI's key, only if your server asks for one. Only ever sent to `TARSEE_LOCAL_AI_URL`. |
| `CLAUDE_CODE_OAUTH_TOKEN` | No | — | The Claude plan without the Terminal: the token `claude setup-token` prints (it lasts a year). Only the Claude plan ever sees it. |
| `CLAUDE_DEFAULT_MODEL` | No | `sonnet` | The Claude plan's and Anthropic key's default model when Settings has none. Defaults to the **`sonnet` alias**, which Tarsee resolves to the newest Sonnet in Claude Code's catalog before each turn. That catalog comes with the Claude Code version the image pins (`CLAUDE_CODE_VERSION` in the Dockerfile), so a model released later arrives when that version is bumped and redeployed, or on every boot with `TARSEE_AUTO_UPDATE_CLI=1`; the list Claude Code saves for your account when you use `claude` in the web terminal counts too, when it is newer. Set `opus` for the most capable default, a pinned id (e.g. `claude-opus-5`) if you need a frozen model, or `haiku` for a cheaper one. |
| `ELEVENLABS_API_KEY` | No | — | Premium TTS voices. Used when ElevenLabs (or Auto) is picked in Settings > Voice, or when the key is set and no engine was ever saved; otherwise the default engine, Phonon, and its fallback, Edge TTS, are free. |
| `VAPID_SUBJECT` | No | your Railway `https://` address, else `mailto:admin@example.com` | The contact Web Push services are given for your server's notifications: a `mailto:` or `https:` URL, e.g. `mailto:you@yourdomain.com`. Apple's push service turns away subjects that aren't a real mailto/https address. |
| `RAILWAY_API_TOKEN` | No | — | A Railway account or workspace token for the `tarsee_railway` tool (Railway: Account Settings > Tokens; a project token will not do). Better kept in the vault: tell Tarsee to save it with `tarsee_set_key` as `RAILWAY_API_TOKEN`, which is read first. Railway does not set this one for you. |
| `TARSEE_AGENT_ENV_KEYS` | No | every vault key | Which vault keys go into the agent's environment: a comma-separated list of names, or `off` for none. By default every key named in capitals, except Claude's, Anthropic's and Codex's own (login, billing and host) and names that change how programs run (`PATH`, `NODE_*`, proxies and the like). None while `get_key` is denied in Tool Permissions. |
| `TARSEE_AUTO_UPDATE_CLI` | No | off | Set `1` to install the latest Claude Code CLI on every boot (adds up to ~60s to each boot). Chat turns keep running the Agent SDK's own copy, so the Terminal's `claude` and the turns then differ (the boot log says so). Off, the image keeps the version pinned in the Dockerfile (`CLAUDE_CODE_VERSION`). |
| `TARSEE_PHONON_AUTO_INSTALL` | No | on | Set `0` to stop Tarsee downloading Phonon's model in the background on boot when Phonon is the voice engine. The Install Phonon button in Settings > Voice still works. |
| `TARSEE_PHONON_DIR` | No | `<data dir>/tts/phonon` | Where Phonon's model, voices and (if needed) Python venv live. On Railway that is `/data/tarsee/data/tts/phonon`, on the volume. |
| `TARSEE_PHONON_PYTHON` | No | `python3` | Python interpreter with the `ptts` package for Phonon's worker. Without it Tarsee uses `python3`, or a private venv it creates under `TARSEE_PHONON_DIR` when `python3` lacks `ptts`. |
| `TARSEE_PHONON_THREADS` | No | up to 4 | CPU threads for Phonon's worker. |
| `TARSEE_CHANNEL_IDLE_ABORT_MS` | No | `1200000` (20 min) | Abandon a turn after this long with no stream event. Keep finite. |
| `TARSEE_COMPACT_WINDOW` | No | `180000` | Context size (tokens) at which Claude Code summarizes the older part of a chat and carries on. Every model call re-reads the whole context, so a smaller window means fewer cached tokens per call (measured: about a quarter fewer than at 300k). Accepts `250000`, `150k`, or `off` for the CLI's own (the model's full window); the CLI holds it to 100k–1M. A `CLAUDE_CODE_AUTO_COMPACT_WINDOW` you set yourself is kept when this is unset. The context meter and Token Health measure against this window. |
| `TARSEE_TOOL_RESULT_MAX_CHARS` | No | `12000` | A tool result (Tarsee's own `tarsee_*` tools and any other MCP tool) longer than about this many characters is saved to a file by Claude Code, and the agent gets the path and how to read it. Passed as `MAX_MCP_OUTPUT_TOKENS` (characters ÷ 4; Claude Code's own default is 25000 tokens); a `MAX_MCP_OUTPUT_TOKENS` you set yourself is kept when this is unset. |
| `TARSEE_BASH_OUTPUT_MAX_CHARS` | No | `8000` | A Bash output longer than this is saved to a file by Claude Code, and the agent gets a short preview plus the path (Claude Code's own default is 30000). Sets `BASH_MAX_OUTPUT_LENGTH` for each turn; a `BASH_MAX_OUTPUT_LENGTH` you set yourself is kept when this is unset. |
| `TARSEE_SESSION_JSONL_MAX_MB` | No | `8` | Transcript size cap. Past it, the next turn starts a fresh session instead of resuming the bloat. |
| `TARSEE_MODEL_CONTEXT_TOKENS` | No | from model registry | Override the context window assumed by Token Health. |
| `TARSEE_SESSION_MAX_AGE_DAYS` | No | `30` | Login session lifetime. Sessions persist to SQLite and survive redeploys. |
| `TARSEE_CSRF_MAX_AGE_HOURS` | No | `24` | CSRF token lifetime. |
| `TARSEE_CHANNEL_HEALTH_MS` | No | `60000` | How often the watchdog probes for a wedged Telegram poller. |
| `TARSEE_CLEAR_SESSIONS_ON_BOOT` | No | off | Set `1` to restore the old behaviour of wiping every chat's session id on boot. |
| `TARSEE_TIMEZONE` | No | host zone | IANA zone the agent reasons in for "today", "tomorrow at 9", and cron schedules (e.g. `Europe/Berlin`). Railway containers run UTC, so set this or your 8am reminders fire at 8am UTC. An unrecognised zone falls back to UTC with a warning. The Usage page counts its days in this zone too. |
| `TARSEE_USAGE_BACKFILL_DAYS` | No | `14` | How far back the Usage page's first read of the Claude session transcripts goes. Later reads only take what each transcript gained. |
| `TARSEE_USAGE_RETENTION_DAYS` | No | `90` | Token usage rows older than this are deleted. |

> **Note:** The plans' sign-ins aren't variables (apart from the optional `CLAUDE_CODE_OAUTH_TOKEN`): the Claude plan signs in from the Terminal and the ChatGPT plan from Settings > AI, and both stay on the volume. API keys go in Settings > AI or in these variables, never in a file. See [Choose your AI](#choose-your-ai).

---

## Self-Hosting with Docker

```bash
docker build -t tarsee .

# Make an encryption key once and keep it: Tarsee needs the same one every time it starts.
export ENCRYPTION_KEY="$(openssl rand -hex 32)"
echo "$ENCRYPTION_KEY"   # save this somewhere safe

docker run -d \
  --name tarsee \
  -p 3000:3000 \
  -v tarsee-data:/data \
  -e NODE_ENV=production \
  -e SETUP_PASSWORD=your-4-digit-pin \
  -e ENCRYPTION_KEY \
  tarsee
```

Tarsee listens on port 3000 (`PORT`). Open http://localhost:3000, log in with your PIN, and the setup wizard asks you to [choose your AI](#choose-your-ai). A plan signs in from the wizard (the Claude plan through Tarsee's Terminal), and a key is pasted into Settings > AI.

Everything Tarsee keeps (its database with the keys saved in Settings > AI, each AI's sign-in, and the workspace) is in the `tarsee-data` volume, in `/data/tarsee` inside the container, so a rebuild or a new container still has it.

To give Tarsee a key as a variable instead, put it in a `.env` file that you never commit (`.env.example` lists every name, with what each one is for) and add `--env-file .env` to `docker run`, so the key never appears in a command. `docker-compose.yml` reads the same `.env` file.

Requirements: Docker, and one of the seven AIs in [Choose your AI](#choose-your-ai).

---

## Security

- AES-256-GCM encrypted credential vault
- Chat files are served only from the workspace's `uploads` folder (real path checked), and never as a page that can run: HTML and scripts open as plain text
- Timing-safe authentication
- CSRF protection on all mutations
- Content Security Policy headers
- Rate limiting (10 auth attempts/min/IP)
- Path traversal protection
- Each AI's sign-in in its own owner-only folder on the volume, and API keys stored encrypted, shown only by their last 4 characters and only ever sent to their own provider (Tarsee never handles the Claude or ChatGPT sign-in tokens itself)
- Session isolation per conversation
- Audit log for all tool executions and logins

---

## Contributing

Tarsee is open source. PRs welcome.

```
src/
  server.js                    # Express + HTTP server
  ai/
    provider-registry.js       # The seven AIs: models, prices, which engine runs what
    turn.js                    # One turn on any AI: Stop, queue, sessions, handoff, budgets, backup
    engine-env.js              # Each AI's credentials, kept apart (one home and environment per AI)
    providers/claude-code.js   # Claude Code engine (Agent SDK)
    providers/codex.js         # Codex engine (@openai/codex-sdk)
    mcp-http.js                # Tarsee's tools for Codex, on a private loopback endpoint
    codex-device-login.js      # ChatGPT sign-in with a one-time code
    verify-model.js            # One-click Verify for a model
    tarsee-mcp.js              # 20+ MCP tools
  lib/
    tools.js, commands.js      # Tool registry + chat commands
    cron.js                    # Scheduler
    canvas.js                  # Canvas/artifact server
    security-audit.js          # Security checks
  channels/
    telegram.js, discord.js    # Bot integrations
    whatsapp.js, slack.js      # (slack-app-manifest.yml: the Slack app)
    websocket.js               # Web UI real-time + cross-device sync
  voice/
    stt-handler.js             # faster-whisper STT
    phonon-engine.js           # Default TTS: local Phonon model, warm Python worker
    phonon-install.js          # Downloads Phonon (pinned, sha256-checked) to the volume
    engine-registry.js         # Picks the engine; Edge TTS backs Phonon up
    edge-tts-engine.js         # Free TTS (19 voices), the fallback
  routes/
    chat.js                    # Chat API + SSE streaming
    ai.js                      # Settings > AI: cards, keys, Test, Verify, sign-in
    external-api.js            # REST API (/api/v1/)
    analytics.js               # Usage page API (lib/token-usage.js reads the transcripts)
  public/                      # Web UI (vanilla HTML/CSS/JS, PWA)
```

Run `npm test` and `npm run lint` before a PR. The tests need no AI keys: every provider is checked against local fake servers. The Codex tests use the `codex` binary pinned in `package.json`. `TARSEE_CODEX_BIN` points the tests (and Tarsee) at another copy; on Windows it must name `codex.exe` itself, not a `.cmd` launcher, which Node can't start without a shell (a turn is refused and says so).

---

## License

MIT

Text-to-speech by [Phonon](https://huggingface.co/gradium/phonon-31m-en) from [Gradium](https://huggingface.co/gradium): the [ptts](https://github.com/gradium-ai/xn-ptts) runtime (MIT or Apache-2.0), the `phonon-31m-en` weights and the [phonon-voices](https://huggingface.co/gradium/phonon-voices) catalog (Apache-2.0). They are downloaded at runtime and are not part of this repository.
