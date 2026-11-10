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

It started as Claude only. It now runs on two engines, Claude Code and OpenAI's Codex, so the same agent, with the same tools, memory and channels, works on a Claude or ChatGPT plan, an Anthropic, OpenAI, OpenRouter or DeepSeek key, or a model on your own machine.

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
- **You want voice + mobile** — PWA with hands-free voice calls on local speech-to-text, iOS PIN pad login.
- **You want memory** — persistent memory across sessions, and a deep search that reads all of it when a keyword search finds nothing.
- **You want browser automation** — stealth Playwright, with captcha solving through your own 2Captcha or Capsolver key.

### Why choose something else?

- **You need 20+ channels** — OpenClaw or PicoClaw support way more platforms.
- **You need native mobile apps** — OpenClaw has actual iOS/Android apps.
- **You need a provider Tarsee doesn't connect to directly** — PicoClaw supports 30+ LLM providers natively. Tarsee connects seven ways (two plans, four kinds of API key and local models); others, such as Gemini, go through OpenRouter.
- **You need minimal resources** — PicoClaw runs on <10MB RAM. Tarsee needs about 500 MB.
- **You want a massive community** — OpenClaw has 353K stars and thousands of contributors.

Tarsee wraps the vendors' own agents — not a fork, not a rewrite. Two engines run every AI:

- **Claude Code** (`@anthropic-ai/claude-agent-sdk`) runs the Claude plan, the Anthropic key, DeepSeek (through DeepSeek's Anthropic-style endpoint) and OpenRouter's Claude models.
- **Codex** (`@openai/codex-sdk`) runs the ChatGPT plan, the OpenAI key, Local AI and OpenRouter's OpenAI models.
- Any other OpenRouter model runs on whichever engine passed **Verify** for it (see [Models](#models)).

Either way you get that agent's own file and shell tools plus Tarsee's own tools on top. Tarsee picks the engine for each AI: you only choose the AI.

---

## Quick Start (Railway)

1. Click **Deploy on Railway** above. The template adds the volume at `/data` that Tarsee needs (Railway refuses the deploy without it, and without it nothing survives a redeploy).
2. Set two variables:
   - **`SETUP_PASSWORD`**: the PIN you sign in with. The phone's PIN pad takes 4 digits; any other password works too, through its **Use password instead** link.
   - **`ENCRYPTION_KEY`**: the output of `openssl rand -hex 32`. Set it now, before you save any key, and keep it for good. If you don't, the image makes one and saves it on the same volume as your data (`/data/tarsee/.encryption-key`), and once a key is saved, Settings > AI and the security audit warn you about it. To fix that later, set `ENCRYPTION_KEY` to **that file's value**, then delete the file: a new key would make every saved key unreadable.
3. Deploy, open the URL, and sign in.
4. The setup wizard first asks **Who will talk to this Tarsee?** Answering **Other people too** ticks **Only use API keys** and marks the plans as not for shared use (see [Plan or API key?](#choose-your-ai)). An AI already connected through Railway variables is offered with its own **Use** button (for example **Use DeepSeek**).
5. **Choose your AI**: **My Claude plan**, **My ChatGPT plan**, or **My own API key**. Follow the steps it shows (they are also in [docs/providers.md](docs/providers.md)):
   - **Claude plan:** click **Open the Terminal** (Tarsee's Terminal, a shell on the server, not your own computer), run `claude auth login`, open the link it prints, then click **Check**.
   - **ChatGPT plan:** first, in ChatGPT's Settings → Security, under App security, turn on **Enable device code sign-in for Codex** (in a work or school workspace, an admin turns it on). Without it the sign-in fails. Then click **Sign in with ChatGPT** and type the one-time code at the link it shows (the code lasts 15 minutes). Clicking it again right after a failed try always starts a new sign-in, and the new one's code, or the reason it failed, stays on screen. Clicking it while a code still waits ends that code on the server first, then shows a new one. **Cancel** clears the box at once and ends that sign-in on the server too, except while it is still starting and the server then takes more than 10 seconds to answer: a code the server does get then waits there until it runs out (15 minutes), and the next **Sign in with ChatGPT** shows that same code. Settings > AI works the same way. If a start gets no answer from the server (a connection that stalls, say after a laptop wakes), clicking again waits at most 10 seconds for it, then starts a new sign-in and shows its code. A start with no answer in 40 seconds stops by itself and says to click Sign in with ChatGPT again. One case still needs a reload: when what stalls is the page asking the server for a fresh security token (it asks once its own is a day old, as after a laptop has slept), no sign-in can start, each click ends with "Tarsee didn't answer in 40 seconds", and nothing else the page sends (a chat message, a save) goes out either, until you reload the page.
   - **An API key** (Anthropic, OpenAI, OpenRouter or DeepSeek): paste it and click **Test and save**. The key is saved only if the provider accepts it.
   - **Local AI** isn't offered on Railway, which has no GPUs, unless the Railway variable `TARSEE_LOCAL_AI_URL` holds the address of a model server you run (another Railway service, or your own machine behind a key): set it on Tarsee's service and redeploy, and Local AI appears ([how](docs/providers.md#local-ai-on-railway)). On your own hardware (Docker or `npm start`) it is under **My own API key**: type your server's address (or click Ollama, LM Studio or llama.cpp to fill it in) and click **Save and test**.
   - Pick a model and click **Next** (once that AI is ready it names it, like "Next: use DeepSeek"). If the model list is open when what the step shows changes (a **Test**'s answer comes in, say), a model you then pick from that list is lost, and Next saves the one shown before: open the list again and pick it.
6. Then come **Skills**, **Personality** and **Channels**. Skills has no skip: the recommended skills come ticked, and **Install & Continue** installs whatever is ticked (click **Deselect All** first to install none). Personality has **Skip and use the defaults**, and Channels **Skip, start chatting**. Setup never sends a message by itself: the personality chat starts, and sends its opening message (a paid turn on an API key), only when you click **Start Personality Chat**, and the short tour at the end leaves a suggested first message in the box for you to send.
7. Voice works right away: on first boot Tarsee downloads its local voice (Phonon, about 72 MB) to the volume in the background, and Edge TTS speaks in the meantime.

That's it. Sign-ins are kept on the Railway volume and survive restarts and redeploys; keys are stored encrypted in Tarsee's database. To set it up without the wizard, use Railway variables instead (see [Choose your AI](#choose-your-ai)).

The image pins both agents: the Claude Code CLI at the version the Agent SDK bundles (`CLAUDE_CODE_VERSION`, 2.1.319, in the Dockerfile; the build stops if the two differ) and Codex at the `@openai/codex-sdk` version in package.json. Neither updates itself, and a rebuild keeps them. New Claude models still show up without a version bump: Tarsee also reads the model list Claude Code saves for the signed-in account, and uses whichever list is newer. ChatGPT's list comes from your account. `TARSEE_AUTO_UPDATE_CLI=1` installs the latest `claude` on every boot, but only for Tarsee's Terminal (and the model list read from it): chat turns keep running the Agent SDK's own copy, and the boot log warns that the two differ.

### Staying Updated

If you deployed from the Railway template, your instance is a snapshot — it won't update by itself. To follow new versions:

1. Fork `projectservan8n/Tarsee` on GitHub.
2. In your Railway service → **Settings → Source**, connect your fork.
3. To take a new version, click **Sync fork** on GitHub. Railway redeploys when a push changes what goes into the image (`src/`, `package.json`, `package-lock.json`, `Dockerfile`, `.dockerignore`, `entrypoint.sh` or `railway.toml`); a push that only touches docs, tests or CI doesn't redeploy.
4. Your data on `/data` is safe — the volume persists across redeploys.

Running it with Docker instead? See [Updating](#updating) under Self-Hosting with Docker.

---

## Choose your AI

Tarsee runs on any of these seven, and you can connect several at once. Pick the default AI in the setup wizard or in **Settings > AI**; each chat can pick its own from the model menu under the message box. `/model` changes the default AI from any channel. Tarsee picks the engine for each one by itself (Claude Code or Codex): you only choose the AI.

| AI | What you need | What it costs | Good to know |
|---|---|---|---|
| **Claude plan** | A paid Claude plan (Pro, Max or a Team seat). Sign in once: `claude auth login` in Tarsee's Terminal, or set the Railway variable `CLAUDE_CODE_OAUTH_TOKEN` to the token `claude setup-token` prints | No per-message cost: it uses your plan's limits | Pro runs out quickly with an agent; Max lasts much longer. For your own use |
| **ChatGPT plan** | A ChatGPT account, Free included. In ChatGPT's Settings → Security, under App security, turn on **Enable device code sign-in for Codex**, then click **Sign in with ChatGPT** in Settings > AI and type the one-time code (or run `codex login --device-auth` in Tarsee's Terminal) | No per-message cost: it uses your plan's Codex limits. Free plans get a smaller model with limited use | The model list shows only what your account can use. Replies arrive a message at a time. No variable can set it up: it needs the sign-in. For your own use |
| **Anthropic API key** | `ANTHROPIC_API_KEY` from the Claude Console | Pay per use, billed by Anthropic | Set a spend limit in the Console |
| **OpenAI API key** | `OPENAI_API_KEY` from the OpenAI Platform | Pay per use, billed by OpenAI | Give the project a monthly budget with a hard limit. Replies arrive a message at a time |
| **OpenRouter** | `OPENROUTER_API_KEY` from openrouter.ai | Pay per use at each model's price; models marked Free cost nothing | Hundreds of models with one key. Claude and OpenAI models work straight away; any other needs one click on **Verify** first. OpenAI models reply a message at a time. Give the key a credit limit |
| **DeepSeek** | `DEEPSEEK_API_KEY` from platform.deepseek.com | Pay per use from a balance you top up: the cheapest per message. The listed rates are peak ones (01:00-04:00 and 06:00-10:00 UTC, Monday to Friday); other hours cost half. Tarsee's figure is an estimate (est.) | DeepSeek Flash for everyday use; DeepSeek Pro thinks harder but can't see pictures |
| **Local AI** | `TARSEE_LOCAL_AI_URL`: the address of your Ollama, LM Studio or llama.cpp server (and `TARSEE_LOCAL_AI_KEY`, only if it asks for one). Ollama 0.13.3+, LM Studio 0.3.29+ or llama.cpp b11768+ | Free: it runs on your own hardware | The model needs at least 32,768 tokens of context. The model chosen on its card runs at once; Verify the server's other models before a chat can pick them (small models use tools poorly). Replies arrive a message at a time. On Railway (no GPUs) it is offered only once `TARSEE_LOCAL_AI_URL` is set: run the server as another service on the private network, or on your own machine behind a key ([how](docs/providers.md#local-ai-on-railway)) |

Each one's full setup, the same steps the app shows, is in **[docs/providers.md](docs/providers.md)**. For Local AI (server versions, the llama.cpp address `http://localhost:9931/v1`, context size, and the bridge that hands your server Tarsee's tools), see [docs/providers.md#local-ai](docs/providers.md#local-ai).

**Where keys go.** Paste a key into its card in **Settings > AI**, where it is stored encrypted and only its last 4 characters are ever shown again, or set it as a Railway variable (your service > Variables). Keys belong in one of those two places and never in files: not in the repository, not in `.env.example`, not in a chat message. Each key is only ever sent to its own provider, and a key set as a variable never changes which AI answers by itself. Set `ENCRYPTION_KEY` before you save a key in Settings. The commands the agent runs don't get an AI's key in their environment, but they run as the same user as Tarsee, so they can still read the key: on a Linux server from Tarsee's and the engine's processes, and from Tarsee's data folder, where saved keys sit next to what unlocks them. Give every key a spending limit at its provider, which is the real guard ([details](docs/providers.md#tools-on-every-ai)).

**Plan or API key?** Signing in with a Claude or ChatGPT plan is for your own personal use, under Anthropic's and OpenAI's terms. If other people talk to this Tarsee (a team, customers, a shared channel), use an API key.

**Settings files that point elsewhere.** Tarsee won't run an AI's turns while a Claude `settings.json` or a Codex `config.toml` or `.env` could send its key or traffic somewhere else. Settings > AI then shows a banner with a one-click **Remove these entries** or **Set this file aside**.

### API keys only

**Settings > AI** has a switch, **Only use API keys**. With it on, Tarsee never uses a Claude or ChatGPT plan sign-in: every message is billed to an API key. Answering **Other people too** in the setup wizard ticks it for you. The Railway variable `TARSEE_KEYS_ONLY=1` locks it on, so it can't be switched off from the dashboard.

### Set it up with Railway variables only

Set `TARSEE_AI_PROVIDER` and that AI's key variable, and once that AI is ready the setup wizard is skipped (Tarsee still asks once whether to start the personality chat; nothing is sent until you choose). For the Claude plan, `CLAUDE_CODE_OAUTH_TOKEN` alone is enough. The ChatGPT plan has no variable, because it needs a sign-in: with `TARSEE_AI_PROVIDER` set to `chatgpt` the wizard still opens until someone signs in to ChatGPT (in the wizard or Settings > AI), and is skipped once that sign-in is on the volume. The variables and how they combine: [docs/providers.md](docs/providers.md#set-up-with-railway-variables-only).

### Keeping the cost down

- **A spending limit at the provider** is the surest cap: a credit limit on the OpenRouter key, a small DeepSeek top-up, a project budget with a hard limit at OpenAI, a spend limit in the Claude Console. Each guide in [docs/providers.md](docs/providers.md) shows where.
- **Monthly spending cap** (Settings > AI, optional): adds up what the API-key AIs cost this calendar month (in `TARSEE_TIMEZONE`), and Local AI too once you set a price on its card. It uses Tarsee's own figures, some of them estimates. Settings > AI shows this month's spend next to the cap. At the cap those AIs stop until next month, the message suggests switching the chat to a plan, and the backup is not used.
- **Backup** (Settings > AI, optional): when any chat's AI can't answer (out of credit, signed out, busy or rate-limited, a plan's usage limit included, down, or the model isn't available), Tarsee answers with the backup you picked, and says so. It steps in only before the failing AI has said anything, and only once per turn. It is never used when you press Stop, when a spending limit stops a turn, or at the monthly cap. Only ready AIs can be picked.
- **Background work** (scheduled tasks, webhooks, the heartbeat, BOOT.md) runs on the default AI, not on a chat's AI, using that AI's background model: the **Background jobs use** choice on its card in Settings > AI, else its smallest tier. The ChatGPT plan and Local AI have no smaller tier, so their default model runs unless you pick one. Each job stops at $0.50, at 2 minutes (3 for BOOT.md) and at 12 turns.
- **The Usage page** shows what each AI cost: exact where the provider reports it, marked "est." where Tarsee works it out, "Included in plan" for the plans, "Free" for Local AI, and "Cost not known" where there is no price.

---

## What You Get

### Chat Everywhere
- **Web UI** — A calm chat in the style of claude.ai: every chat has its own address (`/chat/<id>`, `/chat/new`) with Back/Forward and shareable links, a plain sidebar grouped by where each chat lives (Web, Telegram, Discord, WhatsApp, Email, Slack, Calls, and Background for crons and the heartbeat while they run), search, and a rename / fresh session / delete menu on each chat. Markdown, code blocks, tables, file attachments, image paste, drag-and-drop, multi-file upload. PWA — save to homescreen on iOS/Android.
- **The default AI, at a glance** — the top bar's **Default:** chip (the AI and its model, such as "Default: DeepSeek · DeepSeek Flash") shows the AI new chats and scheduled tasks use, in that AI's color, with a green or red dot for whether it is ready. Click it to open Settings > AI. When the default AI can't answer, a banner under the top bar says why, with **Open Settings → AI**.
- **Tool steps that stay out of the way** — while the agent works, one quiet line in the answer's place ("Working · 3 steps · Reading README.md · 84.2k tokens · 41 tk/s", with Stop); once it answers, the steps fold into "Used 12 tools" above the reply, each opening to its input and output. The line opens even before the first step: to a summary of what the model is thinking (for messages sent from the dashboard; it costs the answer about 3 seconds, so Telegram, Discord, email and voice-call replies do without), an API error it is retrying, or compacting.
- **Queued, not cancelled** — a message sent while a reply is running shows as "Queued · after the reply above" (no timer) and becomes the working line when its turn begins. Its own Stop takes just that message out of the queue.
- **Max effort for one message** — start a dashboard message with `!!` or `!think ` and that one message runs at Max effort.
- **Problems in plain words** — instead of a "401 / Failed to authenticate" error arriving as the reply, the chat says what happened and what to do, the same on every channel: the Claude sign-in expired (run `claude auth login` in the Terminal, the `>_` button, on phones too), the ChatGPT sign-in expired (sign in again from Settings > AI), the balance is empty or a key's limit is reached (with where to top up).
- **Telegram** — Text, photos, PDFs, voice messages, video notes. Group @mention support, inline buttons, forwarded message detection.
- **Discord** — Text, images, PDFs, voice messages. Always-online bot with presence status.
- **Email** — Real-time over IMAP IDLE + SMTP. A mention keyword (default `@tarsee`) gates replies: mail without it is absorbed as context, with no reply. Works with any mailbox that allows IMAP + SMTP with an app password (Gmail, iCloud, Zoho, FastMail, Yahoo, self-hosted; not Outlook.com or Microsoft 365).
- **WhatsApp** — Text, images, PDFs, voice notes (transcribed by the speech-to-text in Settings > Voice), and documents via [WHAPI Cloud](https://whapi.cloud) (free tier OK). Direct messages only. Per-channel webhook secret in URL, auto-generated on first enable.
- **Slack** — DMs, and channels by @mention. Every reply goes in a thread and each thread is its own conversation; a thread Tarsee is in needs no more mentions, and a mention in someone else's thread reads the thread first. Replies stream with Slack's native AI streaming, a live card for each tool it runs, and Slack's stop button; where a workspace has no native streaming, replies are posted and edited instead. Markdown renders as written (tables and code included). Images, PDFs, voice clips (transcribed) and any other file in; files out as real uploads. `/tarsee` for questions and commands. Socket Mode, so no public URL; the app is made from a manifest Settings copies for you.
- **Attachment save-to-disk** — every image, PDF, voice note, and document sent via Discord, Telegram, email, WhatsApp, Slack, or web lands in `workspace/uploads/` so the AI can read, transform, and reference it across turns (not just in the message it arrived on).
- **Live on every device** — one durable timeline per conversation (messages, turn start/end and every tool step) that every channel feeds and every device follows over WebSocket. A device that sleeps or reconnects catches up from the last event it saw, even across a restart, and a Telegram, Discord, WhatsApp, Slack or email turn can be watched (and stopped) live from the dashboard. Sends are optimistic and never lost; a message sent while a reply is running queues behind it instead of cancelling it. Timeline events are kept 14 days (`TARSEE_EVENT_RETENTION_DAYS`).
- **Session recap** — resume a conversation idle >30 min and a dismissible "Last time" card summarizes the last few exchanges before the first new message. Zero AI cost (extractive summary).
- **Web Push notifications** — iOS/Android/desktop push via VAPID when a scheduled task's timed run finishes, goes over its spending limit or fails for the last time, and when the agent pings you with the `tarsee_push_notification` tool. A webhook run, `/cron run` and `/briefing`'s run-now send no push. Opt-in from Settings > Appearance.
- **All channels share** the same memory and tools. Each conversation, channel conversations included, answers with its own AI and model if one was picked for it in the dashboard, and otherwise with the default AI.

### Voice Calls
- **Call your assistant** — the phone icon in the top bar ("Call Tarsee", or your bot's own name: see [Your bot's name](#memory--identity)). Talk hands-free: it hears when you start and stop, answers out loud, and keeps listening. Works on a phone (it asks for the microphone, and keeps the screen on during the call) and on a computer. The microphone (calls and dictation) works only when Tarsee is opened over **https** or on the same computer (`localhost`): a self-hosted Tarsee opened at `http://<LAN address>:3000` can't call or dictate.
- **A real turn every time** — each thing you say goes to the "Calls with Tarsee" chat (with your bot's name) as an ordinary message, so it is answered by that chat's own AI and model (or your default AI), with every tool, and the whole call is there to read afterwards. Say "think hard" or "take your time" and that one question goes to the AI's top model, when it has one. On an AI that replies a message at a time (the ChatGPT plan, the OpenAI key, Local AI, and OpenRouter models that run on Codex), each message is spoken as it comes.
- **Talk over it** to interrupt; say **"stop"** to stop what it's doing (the chat's Stop). It works when that is the whole thing you say, and so do cancel, never mind, hold on, wait and forget it. Mute, a clock, and what it's working on, in plain words. After 8 seconds of work it says "On it, give me a minute." A long answer is spoken up to about 900 characters, then "The rest is in the chat." If the voice fails, answers show as text in the call; two failed transcriptions in a row show the reason.
- **Put the call away** and keep going: a bar over the message box has the clock, Mute, Show and End, so you can read and type while you talk.
- **Hang up while it works** — choose a channel in Settings > Voice > Calls ("Send the answer to": your connected Telegram, Discord, Slack or WhatsApp). The answer goes to the chat on that channel with the latest message, which may be a group or another person, so check which chat that is. It works only if that channel has had at least one chat and is connected when you hang up, and only for answers that arrive within 30 minutes of the hang-up. Each starts with "From our call:" and is cut at 3,500 characters. Starting a new call cancels it. Off by default: then it stays in the call's chat.
- **Your own speech stack, nothing paid unless you chose it** — it hears you through the speech-to-text in Settings > Voice and speaks with the voice set there. If speech-to-text isn't set up, the call ends and shows why, with an **Open Settings → Voice** button.
- **Dictation** — the microphone in the message box turns what you say into text in the box, where you can check it and press send (it never sends by itself). Hold it to record and let go to stop, or tap to start and tap again to stop; slide left to cancel. If speech-to-text isn't set up or fails, a note above the box says why, with **Try again** and a button to Settings > Voice.
- **Speech-to-text everywhere** — the same Settings > Voice speech-to-text turns calls, dictation, the dashboard's audio and voice messages from channels (Telegram voice messages and video notes, Discord, WhatsApp and Slack voice clips) into text. When it isn't set up, the channel replies saying what to set up. **Where speech becomes text** offers faster-whisper on this server (the default: free, and the recordings stay on the server) or the OpenAI Whisper API (paid, about $0.006 a minute, with an OpenAI key; when it fails, local faster-whisper takes over).
- **Local speech-to-text** — faster-whisper, run on the server's CPU, with no API key. Models: `tiny.en` (about 78 MB), `base.en` (about 148 MB) and `small.en` (about 486 MB) understand English only; `tiny`, `base` and `small` (the same sizes) understand many languages and find the language by themselves. One worker keeps the model loaded while it is in use, and stops after 10 idle minutes to give its memory back, so the next recording after a pause takes a few seconds longer.
- **Models download when you pick them** — choosing a model in Settings > Voice starts its download (each with a progress bar, from the official Systran models on Hugging Face, at pinned revisions, every file's size and hash checked, onto the volume so they survive redeploys). Until it finishes, the closest model already on disk does the transcribing; with no model at all, a request says so ("Tarsee is downloading small.en now: try again in a minute"). Delete removes only downloaded copies.
- **Works out of the box with Docker** — the image ships faster-whisper and the `base.en` model, outside the `/data` volume (so it is never hidden, and Delete can't remove it). At build time a test WAV goes through Tarsee's own decoder (PyAV, no ffmpeg needed) and `base.en` transcribes it offline; if that fails, the build stops.
- **One-click install without Docker** — on Windows, macOS or Linux, Settings > Voice > Speech-to-text has an **Install faster-whisper** button, with progress. It uses a Python from 3.9 to 3.14 that has the `venv` module (on Debian/Ubuntu, `python3-venv`); a newer one, or one without `venv`, is skipped, and Tarsee downloads its own CPython 3.12 ([python-build-standalone](https://github.com/astral-sh/python-build-standalone), pinned, sha256-checked, about 45 MB) into its state folder. Then it installs the pinned faster-whisper from pypi.org into its own folder (about 100 MB of packages, ready-made builds only), plus `base.en` when no model is on disk. It can't install on a 32-bit computer or on musl Linux such as Alpine. Phonon's install uses the same Python.
- **Local text-to-speech by default** — [Phonon](https://huggingface.co/gradium/phonon-31m-en), Gradium's open 31M model, speaks everything that speaks (calls, read-aloud, voice replies on channels). It runs on the server's CPU through one warm worker: no API key, no per-character cost, 25 English voices (Toby by default) and a speed setting. Peso amounts ("₱2,500", "PHP 2,500") are read as pesos; reading a bare "P2,500" that way is an opt-in setting.
- **Downloads itself** — the model and voices (about 72 MB) go to the data volume, not the image. On first boot Tarsee fetches them in the background from pinned Hugging Face revisions, checking the weights' sha256; Settings > Voice shows the progress and has an **Install Phonon** button (and Retry if it fails). The download at boot never downloads Python: on a computer with no usable Python (outside Docker) it fails, Edge TTS keeps speaking, and the **Install Phonon** / **Retry** button downloads Tarsee's own Python first. Turn the automatic download off with `TARSEE_PHONON_AUTO_INSTALL=0`. You can also run `node src/voice/phonon-install.js` from a terminal; a running Tarsee then uses Phonon after a restart, or once Settings > Voice is saved.
- **Free fallback** — Microsoft Edge TTS (19 voices, 3 tries a sentence, markdown stripping, no API key) speaks while Phonon downloads, and for any sentence Phonon fails; after three failures in a row Phonon is skipped for five minutes. Edge TTS is Microsoft's online service, not local: while it speaks, the reply's text goes to Microsoft. Each try's time limit fits the sentence: 8 seconds plus 20 ms a character, and never more than 30 seconds. A short sentence that stalls is tried again quickly, and a long reply has time to finish. A connection that drops partway through is noticed at once, and the next try starts. Edge TTS keeps each sentence's audio in the system's temp folder only while making it, the same on Windows, macOS and Linux. A try that fails leaves no audio file there either, however late the file is made. The server's background threads open it, and they can all be busy reading files, looking up addresses or compressing, even for longer than the try's time limit. Tarsee removes the file once Edge TTS has finished writing it, and the next try waits up to 2 seconds for that. For 2 minutes after a failed try, Tarsee also looks for the file and removes it as soon as it appears. When Edge TTS starts, and now and then after a try fails, Tarsee removes its own leftover audio files from the temp folder, such as those of a crash or a restart in the middle of a sentence. It removes only files named the way it names them (`tarsee-edge-tts-`, a random id, `.mp3`) that haven't been written to for 5 minutes, and nothing else. A leftover it can't remove (another user's, in a shared Linux `/tmp`) is tried again every minute for as long as Tarsee runs. And a leftover whose last-written time is more than about 25 days ahead of the server's clock (left while the clock was ahead, or dated ahead by someone else using the same `/tmp`) sets Tarsee looking through the temp folder about every millisecond, with a warning in the log each time, until that file is deleted. Both go for Piper's leftovers too. If Edge TTS fails a sentence too, nothing else is tried and that sentence isn't spoken (on a call, the answer shows as text). Piper (free, local, once it has voices) stands in only at start, when neither Phonon nor Edge TTS can load.
- **Nothing paid on its own** — ElevenLabs speaks only when you pick it, or Auto, in Settings > Voice; a saved ElevenLabs key alone never picks it. **Auto** tries Phonon (once installed), then Piper, then ElevenLabs, then Edge TTS, so with an ElevenLabs key and Phonon not installed yet, Auto uses paid ElevenLabs before free Edge TTS. **Disabled** in that list doesn't turn speech off: Tarsee takes it as an engine that can't start and speaks with the first free one that can (Phonon once installed, then Piper with voices, then Edge TTS).
- **Piper** — the Docker image ships the `piper` program, but no voices: upload `.onnx` + `.onnx.json` pairs (from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices)) in Settings > Voice > Piper Voice Models. With none uploaded, Piper isn't available. Piper works on Windows, macOS and Linux: Tarsee finds the `piper` program (`piper.exe` on Windows) on the PATH, runs it without holding up the server, and keeps each sentence's audio in the system's temp folder only while making it. A stopped Piper that takes longer than 2 seconds to go has its file removed once it has gone. When Piper starts, and now and then after a sentence fails, Tarsee removes its own leftover Piper audio files from the temp folder (`tarsee-piper-`, a random id, `.wav`, not written to for 5 minutes), and nothing else. Piper runs one sentence at a time, in the order they were asked for, and each run gets 15 seconds from when it starts. A call asks for every piece of an answer at once, and the pieces wait their turn instead of slowing each other down, so the first one is heard first, even on a server with one CPU. That line is one for the whole server, and a piece in it can't be called off: after you cut in or hang up, the old answer's pieces still waiting are made before the first piece of the next answer. If Piper hangs, each run is stopped after its 15 seconds, so the fifth piece of an answer waits more than a minute (a piece that fails shows as text on the call). Deleting a Piper voice whose name has a `/`, `\` or `:` in it answers 400 and deletes nothing.
- **Speech that sounds like speech** — on a call the AI is told every word is spoken, and anything chat-shaped that slips through (lists, links, code, symbols) becomes plain sentences before the voice reads it; the chat keeps the full answer.

### Canvas / Artifacts
- **Live HTML/CSS/JS** — Ask for a dashboard, chart, calculator, or mini-app → renders as an interactive iframe right in chat. The embed's "…" menu has Copy link and Download file. A link in a reply to `/canvas/<id>/` or `/diagram/<id>/` becomes that embed. A `/diagram/` link counts only as a bare path or with Tarsee's own address in front, and only where a link starts (not after another address's `#`, `?`, `=`, `&` or `,`); another site's `/diagram/` link stays a link, whole, also when it is written as an HTML `<a>` tag (it keeps the tag's words). A `/canvas/` link to the same path on another site still shows Tarsee's own canvas with that id, or "not found".
- **Canvas gallery** — browse all your canvases and diagrams at `/canvas/`, or in Settings > Canvas.
- **Persistent** — Canvases are saved in the workspace's `canvas` folder on the volume and opened at `/canvas/<id>/`. Making one with the same title overwrites it.
- **Sandboxed** — viewing a canvas needs a sign-in, and its scripts run in a sandboxed null origin. A canvas can load scripts and styles only from `cdn.jsdelivr.net` and `cdn.tailwindcss.com`, and fonts from Google Fonts, and can make no other network calls (Tarsee's own API included), so it can't fetch live data.
- **Diagrams** — `tarsee_create_diagram` draws a clickable flowchart in the chat. A diagram is kept as data on the volume (`<data dir>/diagrams/<id>.json`; making one with the same title overwrites it), and Tarsee draws its page itself at `/diagram/<id>/`, where only Tarsee's own script runs. So only Tarsee's own diagram can put words in your message box; a canvas never can, whatever it is called. A click on a node (or Enter or Space on it) puts words in the message box at the caret, added to anything you were typing: the question the diagram gave that node, or else "Tell me more about: …" with the node's label. Nothing is sent until you press Send, and files waiting in the box stay there. Hover over a node to see what it will add (screen readers read it too). The words go in on one line, as the node shows them: blank lines, runs of spaces and characters that look blank but aren't spaces (such as U+3164 or U+2800) become single spaces, and at most 4 accent marks stack on a letter. The box scrolls to show them, from their first line when they don't all fit, and when your message starts with `/` its first line always stays in view. A key held down on a node, or pressed twice quickly, can't send them: for a second after a diagram puts words in the box, Enter there doesn't send (a click or typing in the box ends that wait). The words are the AI's and can be a command, such as `/cron on <id>`. When the message you send starts with `/` and any of a diagram's words are still in it, Tarsee asks first ("Run this command from a diagram?"). It shows the whole command, Cancel is the default, and **Run it** counts only after a second. A diagram's question that isn't a command sends at once, as your own words, and so does a command you typed yourself, except right after you sent a diagram's command: a command you then type or paste yourself into the emptied box is asked about too, until you reload the page or send a message that isn't a command. And when the browser puts the box's words back by itself (you went to another page and came Back, or it restored its tabs), Tarsee no longer knows which of them a diagram put there, so a command among them is sent without the question (see [Known limits](#known-limits)).

### Tools & Automation
- **20+ MCP tools** — send messages, schedule tasks, remember facts, search the web, create canvases and diagrams, manage files, encrypted vault, calculator, browser, PDFs, push notifications, email threads, and more.
- **Calculator** — a math tool so the AI never hallucinates numbers: arithmetic and `Math.*` functions. `%` is the remainder, not a percentage, so "15% of 200" is written `200 * 0.15`. Powers are `**` (`^` is refused). It works the sum out with a parser of its own and runs nothing as code: anything else, such as names, text or code, is refused.
- **Sends files** — ask for a report, an export or a picture on Telegram, Discord, WhatsApp, Slack or the dashboard and `tarsee_send_file` sends it as a real attachment to that chat (Telegram up to 50 MB, Discord 25 MB, WhatsApp 16 MB, Slack 100 MB, the dashboard 50 MB; on Slack into the same thread). Email files go as attachments through `tarsee_send_email_thread`.
- **Files in the dashboard chat** — every file the agent sends and every file people send in shows on the message it came with, in any chat: a picture or video as a tile, a PDF with its first page, a sound as a waveform player. A click opens it in the viewer (pictures zoom, PDFs show their pages, CSV as a table, text and code as text), with Download always there. Kept copies live in the workspace's `uploads` folder for 30 days.
- **Keys by name** — the vault's keys are in the agent's environment, so its scripts read `OPENAI_API_KEY` and the like by name and a key never goes into a command. Not when `get_key` is denied in Tool Permissions; `TARSEE_AGENT_ENV_KEYS` limits or turns it off.
- **Discord admin** — `tarsee_discord_admin` lists, makes and edits Discord channels (public, private for listed people and roles, or copying another channel's access) and makes webhooks, using Tarsee's own logged-in bot, so the agent never needs the bot token in a command. Every change needs the owner's go, which the AI passes as `approved_by` and Tarsee writes to the server's audit log; it is free text the AI writes itself, so Tarsee checks only that it isn't empty. A new webhook's URL goes straight into the vault under a key name and comes back masked. Nothing in the tool deletes.
- **Stealth browser** — Playwright with anti-detection (real fingerprints, no webdriver flag). Navigate, fill forms, screenshot, scroll, wait, run JS.
- **Captcha solver** — auto-detect and solve reCAPTCHA, hCaptcha, Cloudflare Turnstile. It needs a paid 2Captcha or Capsolver API key, set in Settings > Security.
- **Morning briefing** — `/briefing on` (owner only) saves a scheduled task that runs every day at 8:00 in `TARSEE_TIMEZONE` (`/briefing time <0-23>` changes the hour). Each run is an AI turn asked to send the briefing with `send_message` to the web chat, and to Telegram if it is set up. `/briefing` with nothing after it runs one right away, which is a paid turn.
- **Auto model routing** — `/auto on` picks your default AI's small, everyday or top model (haiku/sonnet/opus on Claude) by how complex a message looks. It applies only to messages sent from the dashboard's chat, and is skipped in a chat that has its own model.
- **Deep memory search** — when a keyword search finds nothing, `tarsee_search_memories_deep` gives the agent everything at once: up to 500 saved memories, the whole `MEMORY.md`, the last 30 daily logs, `memory/summaries.md` and `USER.md`.
- **Scheduled tasks** — recurring AI tasks or direct tool actions; one-time reminders delete themselves. They run in `TARSEE_TIMEZONE` and post their results to the task's chat (the dashboard's Web Chat unless the task names another).
  - **The AI's tasks start paused.** A task the AI schedules in a chat is saved paused and runs only once you switch it on, in Settings > Automation > Scheduled tasks (which needs your signed-in dashboard) or with `/cron on <id>` from your own chat (the dashboard's while you are signed in, or yours on a channel: see [Commands](#commands)). Tasks you add yourself (the Settings form, `/cron add`) are on at once; one added through the settings API with only the API token is saved paused, as if the AI had made it.
  - **No tasks from background runs.** Background turns (a scheduled run, a webhook, the heartbeat, BOOT.md, `/cron run`, `/briefing`'s run-now) can't schedule tasks.
  - **At most once every 15 minutes.** A task that asks the AI needs a 5-part schedule (minute hour day month weekday; a seconds part is refused) and runs at most once every 15 minutes; tasks saved before this version keep the schedules they had. Tasks that run a tool directly, with no AI, aren't held to this.
  - **Never two at once.** A run still going when its next time comes is skipped. `/cron run <id>` runs any task right away, even a paused or waiting one.
  - **Failures.** A failed timed run is tried again after 5 seconds and again after 10 (each try is another paid turn). Once 5 tries in a row have failed, the task stops running (Settings says so); pause it, then switch it on, to try again. The counts reset when Tarsee restarts.
  - **Owner only.** On a chat platform, `/cron`, `/briefing` and `/webhook` answer only the owner (see [Commands](#commands)).
- **Webhooks** — `/webhook add <id> <prompt>` (owner only) makes a hook. It fires with `POST /api/webhooks/<id>` and the header `Authorization: Bearer <API token>` (a token in the URL is refused); only hooks that were made fire (any other id gets 404). An id is letters, digits, `_` and `-`, up to 64 characters. The prompt can use `{{payload}}`, `{{json}}` and `{{hookId}}`; with no prompt, a generic "analyze this event" prompt is used. The call answers 202 and the AI runs in the background, as background work (see [Keeping the cost down](#keeping-the-cost-down)), and posts its answer to the dashboard's Web Chat. `/webhook list` prints the API token.
- **What the AI sets up waits for your OK** — scheduled tasks, the heartbeat (HEARTBEAT.md, every 30 minutes) and the startup checklist (BOOT.md, once per deploy) that the AI sets up don't run, or spend anything, until you say so. HEARTBEAT.md and BOOT.md run only text you typed in their editors in Settings > Automation, or OK'd there. When something else changes one (most likely the AI, with its file tools in a chat), Settings > Automation shows the new text under "Changed outside Settings, waiting for your OK", with a **Let it run** button (for BOOT.md, **Run at each restart**). Only your own signed-in dashboard can give that OK: the API token can't. When the AI writes HEARTBEAT.md or BOOT.md with Tarsee's own write tool, it is told the file waits for your OK and to tell you so. HEARTBEAT.md text that waits is left out of every chat's system prompt, and a note in its place says no heartbeat check runs until you click **Let it run**, so the AI learns of the wait even after a change made with its engine's own file or shell tools. The first time this version starts, the HEARTBEAT.md and BOOT.md already there count as OK'd, so an existing install runs exactly as before. This stops the AI starting paid work on its own in the normal course of a chat, but it isn't a locked door: the AI's shell runs as the same user as Tarsee, so the database where your OK is kept is not out of its reach. A spending limit on each key at its provider is the real guard.
- **Heartbeat** — every 30 minutes (the first 30 minutes after start), one at a time, and skipped while the default AI isn't ready. Its answer goes only to today's daily log and `memory/heartbeat-state.json`, never to a chat, and a reply of `HEARTBEAT_OK` is dropped. To be told something, have HEARTBEAT.md ask the AI to message you with `tarsee_send_message`.
- **Railway tool** — `tarsee_railway` lists your Railway projects, services and variable names, sets a variable and redeploys a service, with an account or workspace token from the vault (`RAILWAY_API_TOKEN`). A secret goes in by vault key name (`from_key`), so it never passes through a chat or a command; values are never read back. Changes need someone's go (`approved_by`, free text the AI writes, recorded but not checked), and nothing in it deletes. On Railway, leaving out the project means Tarsee's own service, and redeploying that restarts Tarsee.
- **Web terminal** — the `>_` button: a full shell on the server (xterm.js), running as Tarsee's own user. It opens with your sign-in or the API token.
- **File manager** — the Files button in the top bar: browse, edit, and create workspace files.
- **REST API** — `/api/v1/message` for iOS Shortcuts, scripts, and automations, with the API token (Settings > Memories > API Token, Reveal or Copy).
- **Skills** — modular instruction packs with credentials and configs. The agent reads them automatically when relevant. Ships with two preinstalled: `ultrareview`, run with `/ultrareview` (3-agent parallel branch review — correctness / architecture / UX-a11y), and `fewer-permission-prompts`, run with `/fewer-prompts` (proposes a tool-allowlist patch from your audit log).
- **`/checkpoint` — handoff to the next session** — a manual AI-written `CHECKPOINT.md` before a known redeploy, plus an activity-gated auto-checkpoint every 6h as a safety net. The first turn that starts a fresh session reads it and archives it, whatever that turn is: a new chat, but also a scheduled task, a webhook, the heartbeat or BOOT.md, so the next 30-minute heartbeat may take it before your next chat does.
- **Retention** — a daily sweep at 03:00 on the server's own clock (UTC on Railway; `retention.schedule_hour` changes it) deletes conversations idle >14 days, checkpoint archives older than 30 days (or past 50 files), Codex's records of threads untouched for 30 days, and the leftover settings of deleted chats. It keeps the most recent thread per channel so Discord/Telegram/email session continuity never breaks. One-line summaries of pruned conversations append to `memory/archived-conversations.md` so nothing vanishes without a record. The `retention.*` settings have no screen: set them with `POST /api/settings/general`. `/retention` previews the sweep, and `/retention run` runs it now.

### Cost Controls
- **Cheap floor for unattended work** — scheduled tasks, webhooks, the 30-minute heartbeat and the boot checklist run on the default AI's background model, not the interactive one: the **Background jobs use** choice on that AI's card (`ai.<id>.backgroundModel`), else its smallest tier (the Haiku alias on Claude). The ChatGPT plan and Local AI have no smaller tier, so their default model runs (for ChatGPT, the account's default; for Local AI, the model chosen on its card) unless you pick a background model. Raise a specific one with the `cron.defaultModel`, `heartbeat.model` or `boot.model` setting, or per job with `job.model`: each takes a tier word (haiku, sonnet, opus), a model of the default AI (for example `deepseek-v4-pro` on the DeepSeek key) or a `provider:model` ref. A name the default AI doesn't offer, or a Local AI or OpenRouter model that hasn't been verified, is logged and the background model runs instead. A zero-token keyword check moves a scheduled task up to the AI's everyday (sonnet) or top (opus) tier when its prompt clearly needs it.
- **Hard ceilings** — every background turn stops at $0.50, at 2 minutes of wall-clock time (3 for BOOT.md) and at 12 turns (enforced by the engine where it can, otherwise by Tarsee from the live usage). A job stopped by one is reported as failed, not as a successful empty run (and a timed scheduled run is tried again). On an AI whose cost is only known once the job has finished (an OpenAI key, or OpenRouter's GPT models), a finished job that went over its spend ceiling keeps its reply and is marked "over its spending limit" in its post, its status and its notification; it is not run again.
- **No duplicate boot spend** — BOOT.md runs once per build and version of the file: a plain restart of the same build skips it. On Railway each new commit runs it once; elsewhere the build id is empty (unless the Docker build was given one), so it runs once per version of the file. The marker is written before the run, so a failed run isn't tried again.
- **One turn at a time per conversation** — a second message queues instead of starting a concurrent turn against the same session.
- **Automatic fallback** — an overloaded Claude model steps down the tiers rather than failing the turn, DeepSeek Pro falls back to DeepSeek Flash, and an optional **Backup** AI (Settings > AI) answers when a chat's AI can't (see [Keeping the cost down](#keeping-the-cost-down)).
- **Spending you can see and cap** — the Usage page shows each AI's spend (exact where the provider reports it, "est." otherwise, "Included in plan" for the plans), Settings > AI shows OpenRouter's and DeepSeek's balance and this month's spend, and an optional **Monthly spending cap** stops the API-key AIs at a limit you set.

### Security
- **Tool Permissions are enforced** — Settings > Security > Tool Permissions gives each of Tarsee's own tools **Allow**, **Warn** or **Deny**, checked at the single point every tool call passes through. Warn lets the tool run and records every use in the Console and the Audit Log. Deny stops it, tells the model not to work around it, and records the attempt. This covers Tarsee's own tools on every AI; the engines' built-in shell and file editing are not gated, on any AI.
- **Credentials encrypted at rest** — bot tokens, IMAP/SMTP passwords and webhook secrets are encrypted field-by-field inside channel configs, and are never returned to the browser (the API reports `hasToken` / `hasPassword` instead).
- **Secrets redacted in tool calls** — Settings > Security > Privacy, **Redact secrets in tool calls** (on by default), removes API keys, tokens and connection strings from tool calls and their output before they show in the chat or are saved.
- **Address checks** — the fetch and browser tools refuse loopback, private and link-local host names and raw IP addresses as typed in the URL (the `169.254.169.254` cloud metadata address included), some risky domain endings (such as `.zip`, `.xyz`, `.top`, `.tk`), look-alike login names and subdomains over 30 characters; a list of trusted domains always passes, and an optional Google Safe Browsing key (setting `google.safe_browsing_key`) adds a lookup. Only `pdf_read` also checks what a name resolves to and every redirect. A name that resolves to a private address, a redirect, and the agent's own shell aren't checked, so treat this as a guard against mistakes, not a wall.
- **Scoped file access** — the file manager is confined to the workspace and cannot reach the AI sign-ins, encryption key, API token or database.
- **Credentials kept apart** — each AI's sign-in and key lives in its own folder and only reaches its own turns, and a key is only ever sent to its own provider's address. A key set as a variable never changes which AI answers or how you are billed: only your choice in Settings > AI (or `TARSEE_AI_PROVIDER`) does.
- **Isolated canvases** — model-authored pages require a login and run in a sandboxed null origin, so a prompt-injected canvas cannot reach Tarsee's API or storage.
- What the agent itself can reach is in [Known limits](#known-limits).

### Models
- **Every ready AI in one picker** — the composer's picker lists the models of each AI that is ready, the default AI first. Each chat keeps its own pick, and switching AI mid-chat carries the recent conversation over. `/model <provider> [model]` changes the **default** AI and model from any channel (new chats, scheduled tasks and every chat without its own pick follow it), and a chat that had its own pick goes back to following the default; a chat's own pick is made only in the dashboard's picker.
- **A color for each AI** — the Claude plan, the Anthropic key, the ChatGPT plan, the OpenAI key, OpenRouter, DeepSeek and Local AI each have their own color. The model button beside Send has a dot in the color of the AI the chat runs on, the top bar's Default chip uses the default AI's color, and the picker's headings use them too.
- **Each AI's own models** — Claude (plan or key): Claude Code's catalog, below. ChatGPT plan: only the models your account can use, read from the account. OpenAI key: Tarsee's own list of OpenAI models, narrowed to what your key lists; the key's other chat models sit under a collapsed **All models** and need Verify, and a newer model id can be typed on the OpenAI card ("A model that isn't in this list") and verified. OpenRouter: Recommended, Verified by you, and All models (Free ones marked). DeepSeek: DeepSeek Flash and DeepSeek Pro. Local AI: your server's chat models (embedding models are left out); the one chosen on its card and the ones you verified can be picked, the rest sit under **All models** until verified.
- **Verify** — a model with no tested path yet gets a one-click **Verify** in Settings > AI: most OpenRouter models from makers other than Anthropic and OpenAI, an OpenAI key's models that aren't in Tarsee's list, and Local AI's models other than the one chosen on its card (that one runs at once, as do `TARSEE_AI_MODEL` while Local AI is the default AI, the server's first chat model when neither names one, and Local AI's background model). Verify runs four short test turns: a reply, one of Tarsee's tools, the shell, and picking up where it left off. It tries Claude Code first, then Codex, and records the engine that passed: that model then runs on that engine. It costs a few cents on a paid AI, nothing on Local AI, and is limited to a few checks a minute and an hour. The picker lists the model once it passes.
- **Sonnet at Medium by default on Claude** — the Claude default is the `sonnet` alias at Medium effort (`ai.defaultEffort` changes the effort; Settings or `/model` the model).
- **Always the newest model** — the Agent SDK runs its own bundled Claude Code, which would take a bare alias (`opus`, `sonnet`, `haiku`, `fable`) to the newest model *it* knew when it was built, several releases behind. Tarsee reads Claude Code's current model catalog (from the installed `claude`, or the copy the CLI cached for your account, whichever is newer) and turns an alias into the newest exact model id before every turn. Pinned ids (`claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-8`, …) remain selectable when you need a frozen, reproducible model.
- **Tiers** — `fable`, `opus`, `sonnet` and `haiku`, in capability-descending order, mean each AI's own models, and `/model <name>`, `/auto` and the scheduled-task tier check use them. On Claude they are always-latest aliases: Fable is the top tier, `/model fable` tracks the newest Fable release, and `claude-fable-5-1` is selectable as a frozen pin. On DeepSeek, fable and opus are DeepSeek Pro, sonnet and haiku DeepSeek Flash. On the OpenAI key they are Tarsee's top, everyday and small OpenAI models. On OpenRouter they are the newest Claude Opus, Sonnet and Haiku (`~anthropic/claude-opus-latest` and so on), unless your default OpenRouter model is from another maker: then they stay with that maker's models. On Local AI every tier is the model chosen on its card. OpenRouter's and Local AI's tiers can be set by hand (`tiers` in `PUT /api/ai/providers/<id>`; there is no screen for it). The ChatGPT plan has no tiers.
- **Automatic fallback when overloaded** — every Claude turn ships a `--fallback-model` ladder of every tier below the one you chose (Fable > Opus > Sonnet > Haiku, each the newest of its tier), so an overloaded Fable turn degrades to Opus instead of failing. DeepSeek Pro falls back to DeepSeek Flash. OpenRouter gets no ladder, because it fails over between its own hosts.
- **Pictures and PDFs** — only Claude models on Claude Code (the Claude plan, the Anthropic key, OpenRouter's Claude models) read a PDF themselves. On every other AI, Tarsee puts the PDF's text in the message (whole pages, up to about 30,000 characters), and the agent can read the rest with `tarsee_pdf_read`. A model that can't see pictures gets the picture's file path instead. Voice notes always arrive as their transcript.

### Search & Analytics
- **Context kept lean** — the chat's context is summarized at 180k tokens (`TARSEE_COMPACT_WINDOW`), a long Bash output or tool result goes to a file the agent can read (`TARSEE_BASH_OUTPUT_MAX_CHARS`, `TARSEE_TOOL_RESULT_MAX_CHARS`), each quick memory is one line of at most 300 characters and each skill a short description in the system prompt, a workspace file may be 12 KB there (a longer one is cut and the cut is logged), and `MEMORY.md` is never inlined in the system prompt: the agent greps it for what a task needs (the deep memory search can return it whole).
- **Live context meter** — the session bar shows how full the context is: the last model call's prompt (cache reads and cache writes included), not the turn's calls added up. It measures against that AI's model window (from Tarsee's model list, the ChatGPT account, or for Local AI, your server), capped by the compaction window (180k by default, `TARSEE_COMPACT_WINDOW`), on every AI. Near the top the engine summarizes the older part and the chat carries on (Codex at the smaller of that window and 85% of the model's context). Bar turns yellow at 75%, red and pulsing at 90%, with a dismissible banner above the composer. For chats sent from the dashboard, at 95% Tarsee writes a mechanical snapshot to `CHECKPOINT.md` automatically; if a turn still trips "prompt is too long", the snapshot is written from the catch path and a recovery card is shown in chat with a one-click "Start fresh session" button.
- **Usage page** (`/usage`, from the sidebar; the `/usage` chat command is `/status`) — tokens (input, cache read, cache write, output) and spend per period ("$0.42 est." or "Included in plan"): today, the last 5 hours and 7 days, a 14-day and 24-hour chart, tokens by model, channel and chat, a **By AI provider** panel with tokens and spend, output and total tokens per second, and each job (a chat's turns until it sits idle 45 minutes; each cron run on its own) with its turns and spend, which you can rename, merge and split. Once more than one AI has done work, a filter shows one AI at a time. On AIs that run on Claude Code, every model call is read from Claude Code's own session transcripts; Codex AIs (the ChatGPT plan, the OpenAI key, Local AI, OpenRouter models on Codex) report a turn's usage once, when it ends. Each reply gets a quiet line with its turn's tokens, speed and time (and "· $0.01 est." when it was billed per use), and a chat's menu shows "This chat's usage" and its running total. Days are counted in `TARSEE_TIMEZONE`. Every channel records usage.
- **Token Health** (Settings > Token Health) — a per-conversation view of how full each context window is, alongside the Claude session transcript (`.jsonl`) size, which is the real driver of bloat-hangs. Fill is the last reply's recorded prompt tokens, not a running total of every token the chat ever spent (the lifetime figure is reported separately). That recorded figure adds up every model call of the turn, so after a turn with many tool steps Token Health can read higher than the live meter. Conversations whose transcript passes `TARSEE_SESSION_JSONL_MAX_MB` are flagged `resets next turn`: past that cap Tarsee starts a fresh session and hands it the recent conversation. Conversations with no recorded telemetry are labelled `est.` rather than shown as if measured.
- **Audit log** — timestamped log of logins and failed logins, credential saves and deletes, the brand icon, every denied or Warn tool call on every channel, and every tool call made from the dashboard's own chat. Other settings changes (Tool Permissions, webhooks, retention) and tool calls on other channels are not logged.
- **QR code** — scan from desktop to instantly open Tarsee on your phone.
- **Typing indicator** — see when you're typing on another device in real-time.
- **Todo rendering** — the agent's task lists render as styled checklists with progress indicators.

### Memory & Identity
- **Workspace files** — SOUL.md (personality), IDENTITY.md (name, emoji, creature, vibe), USER.md (about you), AGENTS.md (the rules, including who may give the go for Discord and Railway changes), TOOLS.md, MEMORY.md (knowledge), HEARTBEAT.md, BOOT.md, and BOOTSTRAP.md (the first-run interview). AGENTS.md, SOUL.md, IDENTITY.md, USER.md and TOOLS.md go into every system prompt, each up to 12 KB. HEARTBEAT.md goes in too, but only once you have OK'd its text (or while it holds just the default heading and comments): text that waits for your OK, or can't be checked against it, is replaced by a short note. MEMORY.md is only pointed to; BOOT.md runs at startup, and BOOTSTRAP.md feeds the personality chat.
- **Your bot's name** — a setting of its own (Tarsee until something sets it). The personality chat at setup sets it, and so does the AI when it writes IDENTITY.md with a `**Name:**` line through Tarsee's own write tool (tell it "change your name to …"). Editing IDENTITY.md yourself in Settings > Identity, or the AI changing it with its engine's own file or shell tools, doesn't rename the bot.
- **Auto-memory** — the agent saves important facts as you chat, with `tarsee_remember` or `[REMEMBER: …]` markers in its replies (saved to the database and MEMORY.md), and is reminded to every 10 messages. Memories persist across sessions.
- **Summaries** — `memory/summaries.md` holds short summaries, taken from the chat's own text with no AI call, of chats idle 2+ hours with 5+ messages, and of each chat at `/clear`.
- **Daily logs** — timestamped notes auto-appended to `memory/YYYY-MM-DD.md` (named by the UTC date). The last 2 KB of today's log goes into every prompt.
- **Checkpoints** — `CHECKPOINT.md` on the volume survives redeploys. The first fresh-session turn of any kind reads it once and archives it to `memory/checkpoints/<timestamp>.md` for grep-able history.

### Appearance & Controls
- **Themes** — `warm-charcoal` (default, terracotta accent), `noir` (pure black OLED-friendly), `solarized-light` (daylight), `jarvis-blue` (cyan accent). Switch from Settings > Appearance, or with `/theme <name>` in the dashboard's chat. The theme is saved per device.
- **Model and effort picker** — the button beside Send ("Sonnet 5.5 · Medium") opens a picker like Claude Code's: a group for each ready AI with its models (number keys pick the ones on top), Effort (Low, Medium, High, Extra, Max, as far as that model goes) and search. Each AI's heading says how it is paid ("Plan · no cost per message", "Your key · pay per use", "Free · your own machine"); each model row shows its context size, whether it sees images, badges (Plan, Free, an estimated cost tier, Verified) and "Replies appear a message at a time" on Codex models. Models that still need Verify are listed but can't be picked. When the chat's AI is no longer ready, a warning on top says so (for example "DeepSeek not connected, using default"). Claude's list is Claude Code's own model catalog and ChatGPT's comes from your account, so new models appear with no code change. Each chat keeps its own pick; `/effort` opens the Effort list.
- **Your own icon** — Settings > Appearance takes a PNG, JPG, WebP or SVG (up to 10 MB), crops it square, and serves it as the favicon, tab, home-screen and app icon.
- **Own dialogs** — every confirmation is the dashboard's own dialog, never the browser's `confirm()` / `prompt()`.

---

## How It Works

```
You (web / telegram / discord / whatsapp / slack / email / voice / iOS push)
  |
  v
Tarsee Server (Railway, Docker, or your own computer)
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
  |           Local AI goes through the Local AI bridge (127.0.0.1): it turns
  |           Codex's grouped tools into plain functions your server can use,
  |           and adds your server's key itself
  |
  |   Tarsee's own tools on both (in process on Claude Code, over a
  |   private loopback endpoint on Codex): send_message, send_file,
  |   schedule_task, remember, create_canvas, calculator, browser,
  |   web_search, pdf_read, push_notification, send_email_thread, etc.
  |
  +-- Voice:      calls in the browser: faster-whisper STT + Phonon TTS (Edge TTS fallback)
  +-- Browser:    Playwright (stealth) + captcha solving
  +-- Workspace:  SOUL.md, IDENTITY.md, USER.md, AGENTS.md, TOOLS.md, MEMORY.md,
  |               HEARTBEAT.md, BOOT.md, CHECKPOINT.md
  +-- SQLite:     conversations, messages, settings (push subscriptions too),
  |               bot_memory, sign-in sessions (hashed), audit_log, usage
  +-- Vault:      encrypted file (data/vault.json)
  +-- Channels:   Telegram, Discord, WhatsApp, Slack (Socket Mode), Email (IMAP IDLE + SMTP)
  +-- Continuity: /checkpoint + 6h auto-checkpoint + session recap card
  +-- Retention:  daily 03:00 sweep, server clock (14d convs, 30d/50-file checkpoints)
  +-- Push:       VAPID + service worker: scheduled-task runs, push_notification tool
```

---

## Channel Setup

Configure in **Settings > Channels** after deploying (the setup wizard's last step takes you there too). Each platform has its own section with step-by-step instructions and a status line: save a token and it connects at once, then says *Connected as …* or, if something's wrong, what to fix. The same tab has the **Allowlist** (Telegram chat IDs, Discord channel and user IDs, WhatsApp numbers, Slack member and channel IDs; empty lets everyone in) and **Bot Behavior** (whether Discord, Telegram and Slack need an @mention; `/mention` sets the same).

| Channel | How to get token | Features |
|---------|-----------------|----------|
| Telegram | [@BotFather](https://t.me/BotFather) | Text, photos, PDFs, voice, video notes, inline buttons, groups |
| Discord | [Developer Portal](https://discord.com/developers) | Text, images, PDFs, voice messages, reactions, presence |
| Email | IMAP + SMTP (any provider — see below) | Real-time mail, `@mention` gate, mail without it absorbed as context, threaded replies |
| WhatsApp | [WHAPI Cloud](https://panel.whapi.cloud) | Text, images, PDFs, voice notes (transcribed), documents. DMs only. |
| Slack | [api.slack.com/apps](https://api.slack.com/apps?new_app=1), from Tarsee's manifest | DMs and @mentions, a thread per conversation, native streaming with tool cards, files both ways, voice clips, `/tarsee` |

**Telegram:** send [@BotFather](https://t.me/BotFather) `/newbot`, pick a name and a username ending in `bot`, and paste the token it gives you. In groups the bot answers @mentions and replies to it; to have it read every group message (mention mode off, in Settings > Channels > Bot Behavior or with `/mention off telegram`), also send BotFather `/setprivacy` → Disable, then remove and re-add the bot to the group. A chat ID for the allowlist shows in the Console (`[telegram] … chat <id>`) when someone messages the bot. Tarsee puts its commands in Telegram's own command menu. Messages are handled one at a time, in the order they came, across all chats: one sent while a reply is being written waits its turn, even in another chat. Only `/stop`, `/help` and `/version` are answered at once. An album's photos go to the AI together and get one reply, however long they take to download from Telegram. If Telegram's file server answers a photo's or file's download with an error, Tarsee doesn't notice: the error page goes to the AI as the photo or file (a file is saved with the error page as its contents), and the chat isn't told the download failed. A voice message's or video note's error page goes to the speech-to-text in place of the recording. When the channel is switched off or restarted, every message whose reply hasn't started yet is dropped: one still waiting its turn, a photo, file or album still downloading, a voice message or video note still being turned into text, and one waiting behind another reply in its chat. From then on the bot says and shows nothing more in any chat: no AI answer, no "Couldn't understand" or "Failed to process …" note, and no "typing". A file still downloading isn't saved, and a voice message or video note still downloading isn't turned into text (one already being turned into text finishes, and its words are dropped). A message already saved to its chat stays in the chat's history, unanswered, and the Console names the chat each dropped message came from. Only a reply already being written finishes, without "typing". A message waiting behind another reply was already told it is queued ("⏳ Still working on your last message — yours is next." or "⏳ Queued (N ahead).") before the stop. Its "Queued" line stays in the dashboard until the reply ahead of it ends, and until then a message from that chat after a restart still counts it as ahead ("⏳ Queued (2 ahead)." with one reply ahead). Taken out of the queue with the Stop on its "Queued" line in the dashboard, a waiting message never runs and stops showing as typing. A photo or file from a chat not on the allowlist isn't downloaded. After a restart, a new message from another chat can be answered while that last reply finishes.

**Discord:** In the [Developer Portal](https://discord.com/developers/applications): **New Application** → **Bot** → **Reset Token** and copy it; on the same page turn on **Message Content Intent** and save. Paste the token in Tarsee; once it says *Connected*, an **Add the bot to a server** button appears with the permissions it needs (View Channels, Send Messages, Send Messages in Threads, Read Message History, Attach Files, Embed Links, Add Reactions). For `tarsee_discord_admin`, also give the bot's role Manage Channels, Manage Roles (to set who can see a channel) and Manage Webhooks; without them the tool says which permission is missing and changes nothing.

**WhatsApp:** Tarsee uses [WHAPI Cloud](https://whapi.cloud) as the WhatsApp gateway (free tier is enough for personal use). Setup:

1. Sign up at [panel.whapi.cloud](https://panel.whapi.cloud/register); a free trial channel is made for you. Scan its QR code from the WhatsApp account you want Tarsee to use (WhatsApp → Linked devices → Link a device).
2. Once it's connected, copy the channel's **API token**.
3. In Tarsee → `Settings > Channels > WhatsApp`, paste the token and click Save. A **webhook URL** appears.
4. In WHAPI, open the channel's **Settings** (top right): paste that URL in the webhooks block, set **Mode** to **Body** (the other modes change the URL), turn on the `messages` event with `POST`, and save. **Check webhook** tests it.
5. From another phone, send a WhatsApp message to the linked number — Tarsee replies.

The webhook URL has to be public (a Railway domain works; `localhost` needs a tunnel). WHAPI's free sandbox covers 5 different people a month and 150 messages a day, and WhatsApp unlinks the device if the phone doesn't open WhatsApp for 14 days.

Direct messages only; group messages are silently ignored. Voice notes are transcribed by the speech-to-text in Settings > Voice. Images and PDFs go to the AI (a PDF as its text for an AI that can't open PDFs). Other documents (DOCX, XLSX, ZIP, TXT, CSV, etc.) are saved to `workspace/uploads/` and the agent can open them with its file tools.

**Slack:** Tarsee connects with Socket Mode (it opens the connection to Slack), so there is no request URL to set up. The app comes from [`src/channels/slack-app-manifest.yml`](src/channels/slack-app-manifest.yml), which has every scope and event the bot uses.

1. In Tarsee → `Settings > Channels > Slack`, click **Copy app manifest**.
2. At [api.slack.com/apps](https://api.slack.com/apps?new_app=1): **Create an App → Paste a manifest → Continue**, open the **YAML** tab, replace what's there with the manifest, pick your workspace, **Next → Create**.
3. **Install App → Install to *your workspace* → Allow**, then copy the **Bot User OAuth Token** (`xoxb-…`). (Some workspaces need an admin to approve new apps first.)
4. **Basic Information → App-Level Tokens → Generate Token and Scopes**: any name, **Add Scope** `connections:write`, **Generate**, copy the token (`xapp-…`).
5. Back in Tarsee, paste both tokens and click Save. The section says ✓ *Connected as @tarsee in your workspace* once the bot is in.
6. DM the app (Apps → Tarsee), or add it to a channel (**Add people or agents**, or `/invite @Tarsee`) and @mention it there.

How it behaves: DMs are always answered; in channels and group DMs it answers an @mention (Settings > Channels > Bot Behavior, or `/mention off slack`, can make it answer everything) and follows up without one in a thread it is already in. Mentioned in a thread it wasn't part of, it reads the thread's first message and latest 40 first, with anyone from another workspace, other bots and people not on the allowlist marked as such. `@Tarsee /stop` in a thread stops the reply running there. Each reply goes in a thread, and each thread is its own conversation in the sidebar. Replies stream with Slack's native streaming and a task card per tool; Slack ends one streamed message after 10 minutes or 12,000 characters, so a long reply carries on in the next message of the thread. If the workspace can't stream natively (Slack keeps some AI features for paid plans), replies are posted and edited instead, the way Discord's are. `/tarsee <a question>` starts a thread of its own and answers there; `/tarsee help` and `/tarsee status` (one word) or `/tarsee /model opus` (written with its slash) run a command privately; a command about one conversation (`/clear`, `/export`, `/think`) goes in its thread as `@Tarsee /clear`. Allowlist (Settings > Channels > Allowlist) takes member IDs (`U…`) and channel IDs (`C…`); people from another workspace (Slack Connect) are only answered when their own member ID is listed. Files up to 100 MB each way.

---

### Email channel

Tarsee can live in any mailbox you own and reply in real-time. Inbound mail whose body contains `@tarsee` (configurable), once quoted text is stripped, gets a reply, from whichever AI that conversation uses; everything else is absorbed silently so the AI remembers the thread and can answer questions about it later. That is the only rule: a CC'd, BCC'd or forwarded mail with the keyword gets a reply too.

**Setup (two paths — pick one):**

1. **Settings UI** — open `Settings > Channels > Email`, click your provider (it fills in the servers and says where to make the app password), paste your email + app password, save. You can also set a display name.
2. **Chat** — tell Tarsee in conversation: *"Set up email. Mailbox `tarsee@example.com`, only allow `you@example.com`."*, then add the app password in Settings > Channels > Email. Tarsee calls the `tarsee_configure_email_channel` MCP tool. Don't paste the password itself into a chat: a password typed in chat is kept in the conversation and sent to the AI provider.

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

**Mention keyword** — defaults to `@tarsee`. Change it in Settings to `@assistant`, `@bot`, or whatever alias you want. The leading `@` is part of what you type so it's obvious what you're setting.

**Reply-all** — opt-in only. Include `[reply-all]` in the subject (or type `@tarsee reply-all` in the body) and Tarsee will reply to everyone in To + CC. Default is reply-to-sender only.

**One mail at a time** — mail is handled one at a time, in the order it came, across all threads: one that arrives while a reply is being written waits its turn. Only `/stop`, `/help` and `/version` (at the start of the body, with the mention keyword) are answered at once. A command Tarsee answers itself (`/stop`, `/help`, `/clear`, ...) never goes to the AI, even when it fails: the mail back says it failed. If its answer can't be mailed (the mail server says "try again later", say), the mail stays unread and the same answer is mailed again within a minute, without running the command again; after 5 tries Tarsee gives up and marks the mail read. If the channel stops before then, the mail is handled from the start when the channel starts again, the command included. A command that hands the AI a job (`/checkpoint`, `/ultrareview`, `/email`, ...) goes to the AI on purpose, and an unknown command goes to it as an ordinary message. Mail still waiting when the channel stops stays unread and is handled when it starts again.

**Sender allowlist** — strongly recommended. Only emails from listed addresses get processed. Leave empty for dev mode (not safe for production mailboxes). Some mail is always dropped, never even absorbed: mail from Tarsee's own address, newsletters and auto-replies (RFC 3834 `Auto-Submitted` / `Precedence` headers, `List-Id`, `List-Unsubscribe`), and a sender's mail past 6 in 10 minutes. At most 5 attachments of 10 MB each are saved per mail, and the body is cut at 100 KB. Every mail is marked as read once handled.

**Troubleshooting:**
- **"The mail server refused the IMAP login for …"** (or SMTP) — you probably pasted your login password. Most providers require an app-specific password (usually 16 characters with hyphens). See the table above.
- **"[email] IMAP connection closed — reconnecting in 5s"** in the Console — harmless. Mail servers drop idle connections now and then; Tarsee reconnects after 5 seconds.
- **Gmail "less secure apps"** — not relevant anymore. Use an app password and keep 2FA on.
- **Reply arrived but wasn't threaded** — verify your mail client shows `In-Reply-To` and `References` headers. Some bespoke clients strip them.
- **No reply at all** — check that the body has the mention keyword, the sender is on the allowlist, and the mail isn't from a mailing list.

---

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/model [provider] [model]` | Show or change the **default** AI and model: `/model deepseek`, `/model openrouter`, `/model opus` (an alias tracks the latest), a pinned id like `claude-fable-5-1`, or a ref like `deepseek:deepseek-flash`. New chats, scheduled tasks and every chat without its own pick follow it; a chat that had its own pick goes back to the default. `/model` alone lists what each ready AI offers |
| `/think low\|medium\|high\|xhigh\|max` | Set thinking effort for the session (ascending cost; `xhigh` sits between high and max; Medium is the default) |
| `/effort [level]` | With a level, the same as `/think`. Without one: in the dashboard, opens the picker's Effort list; elsewhere, lists the levels |
| `/theme [name]` | List or switch themes: warm-charcoal, noir, solarized-light, jarvis-blue. Use it in the dashboard's chat (the theme is saved per device). Sent from Telegram, Discord, Slack, WhatsApp or email it changes nothing: it says to pick a theme on the dashboard (Settings > Appearance) and lists them |
| `/auto [on\|off]` | Toggle auto model routing for dashboard messages (your AI's small, everyday or top model by complexity) |
| `/mention [required\|off\|status] [discord\|telegram\|slack]` | Whether the bot needs an @mention on Discord, Telegram or Slack |
| `/briefing [on\|off\|time <0-23>]` | **Owner only.** On its own, runs a briefing now (a paid turn); `on` schedules one daily (8:00 by default), `time` sets the hour, `off` removes it |
| `/send telegram\|discord\|whatsapp\|slack\|web` | Forward conversation context to another channel |
| `/webhook [list\|add <id> <prompt>\|remove <id>]` | **Owner only.** Manage webhook triggers (see [Tools & Automation](#tools--automation)). Prints the API token |
| `/cron [list\|add\|on\|off\|run\|remove]` | **Owner only.** Scheduled tasks: `/cron add "0 9 * * *" <prompt>` adds one, switched on; `/cron on <id>` switches one on (a task the AI made waits for this); `/cron off <id>` pauses it; `/cron run <id>` runs one now, even a paused one (a paid turn) |
| `/status` (`/stats`, `/usage`) | Full dashboard (uptime, the AI in use and whether it's ready, tokens, messages, channels). The Usage page itself is in the sidebar |
| `/version` | Tarsee's version and commit, the default AI and model, the Claude Code and Codex versions, Node |
| `/clear` (`/new`) | Empty this chat: saves a short summary to `memory/summaries.md`, then deletes its messages and files for good and starts a fresh session. The chat itself stays |
| `/stop` | Stops the reply running in the chat you send it in, right away, whichever channel or device started it. Works in the dashboard's chat (there it also cancels what the dashboard sent that is waiting behind the reply, as the Stop button does), Telegram, Discord, WhatsApp, a Slack thread (`@Tarsee /stop`) and email (in the mail's thread, with `/stop` at the start of the body and the mention keyword). With nothing running it says so |
| `/remember [fact]` | Save to memory (database + MEMORY.md) |
| `/skills` | List the skills |
| `/voices` | Show the voice engine in use and its voices |
| `/doctor [fix]` | Diagnostics + auto-repair |
| `/export` | Export conversation as text |
| `/checkpoint [list\|show]` | Write CHECKPOINT.md, a handoff the next fresh session reads (auto fires every 6h too) |
| `/retention [preview\|run]` | Preview the retention sweep, or run it now (it deletes old conversations) |
| `/ultrareview` | 3-agent parallel review of the current git branch (correctness / architecture / UX-a11y) |
| `/fewer-prompts` | Propose a tool-allowlist patch from your audit log to reduce permission prompts |
| `/email [check\|gmail\|zoho\|summary\|draft]` | Hands the AI shell commands for Gmail through the `gog` CLI and Zoho through the `himalaya` CLI. Neither is in the image: it works only if you install and sign in to both yourself. Not the email channel |

**Who can use them.** Only `/cron`, `/briefing` and `/webhook` are owner-only. The owner is the dashboard's chat while you are signed in to it (the same commands sent with only the API token, from a script or the AI's shell, are refused), or, on Telegram, Discord, Slack or WhatsApp, someone whose own user ID (on WhatsApp, their number) is on that platform's allowlist. A listed group or channel doesn't make its members owners, an empty allowlist makes nobody the owner there, and email never counts, since a From address is easy to fake. Every other command, `/model` (which changes the default AI, and so the billing), `/clear`, `/retention run`, `/doctor fix`, `/mention`, `/auto` and `/think` included, works for anyone the channel lets in, so keep an allowlist on every channel.

**Where to type them.** In the dashboard, `/` opens the command palette. Telegram lists them in its own command menu (all but `/fewer-prompts`, whose hyphen Telegram doesn't allow). On Slack use `/tarsee <command>`, or `@Tarsee /command` in a thread. By email, the body must start with `/` and contain the mention keyword. An unknown command goes to the AI as an ordinary message.

---

## Settings

| Tab | What's there |
|-----|-------------|
| **Identity** | SOUL.md (personality) and IDENTITY.md (name, emoji, creature, vibe) editors. Saving IDENTITY.md here doesn't rename the bot: the AI does, when you ask it to (see [Your bot's name](#memory--identity)) |
| **Workspace** | AGENTS.md (rules), USER.md, TOOLS.md and MEMORY.md editors |
| **AI** | Choose your AI: a card per AI with its step-by-step setup, its key or sign-in, and **Test** (**Check** on the Claude and ChatGPT plans; with the balance where the provider has one). Each ready card has its Model menu, **Use this AI** (makes it the default), **Background jobs use** and **Remove key** (or **Sign out** for the ChatGPT plan). **Verify** is only where a model needs it: on OpenRouter's and Local AI's model rows, and in the OpenAI key's field for a model that isn't listed. Also: **Only use API keys**, the backup AI, the monthly spending cap with this month's spend, and banners for a settings file that points elsewhere or keys that aren't safely encrypted |
| **Channels** | Telegram, Discord, WhatsApp (WHAPI), Slack (Socket Mode, native streaming), Email (IMAP + SMTP with provider presets, display name, mention keyword, reply-all marker, allowlist); the Allowlist for each platform; Bot Behavior (mention mode for Discord, Telegram and Slack) |
| **Automation** | Session Reset (when chats start on a fresh session: Manual, only when you type `/new` or `/clear` or pick **Start a fresh session** in a chat's menu; Daily at an hour; or Idle after N minutes); Scheduled tasks (each one's state, who made it, its whole prompt, **Switch on** / **Pause** / **Delete**, and an Add task form); HEARTBEAT.md and BOOT.md (a change made outside Settings waits for your OK: **Let it run** / **Run at each restart**). Webhooks are managed with `/webhook`, and retention with `/retention` and the `retention.*` settings |
| **Voice** | Calls: where the answer goes if you hang up while it's working (Off, or a connected channel). TTS engine (Phonon by default, Auto, ElevenLabs, Piper, Edge TTS, and Disabled, which still speaks with a free engine), Install Phonon with download progress, Phonon voice, speed and bare-"P" peso option, the ElevenLabs key, default voice and available voices, Piper voice upload. Speech-to-text: where speech becomes text (this server, or the OpenAI Whisper API with its key), **Install faster-whisper** with progress, and the speech models, each with Download or Delete. The `.en` models understand English only; the others understand any language |
| **Skills** | Create, edit, delete instruction packs (includes the preinstalled `ultrareview` and `fewer-permission-prompts`, run with `/ultrareview` and `/fewer-prompts`) |
| **Memories** | View and manage stored memories; the **API Token** (Reveal, Copy) for the REST API, webhooks, the WebSocket and the `tarsee` CLI |
| **Security** | Security audit, Tool Permissions (Allow, Warn, Deny), Privacy (**Redact secrets in tool calls**, on by default), captcha solver (service and key) |
| **Canvas** | Gallery of AI-generated interactive UIs |
| **Audit Log** | Logins, credential changes, denied and Warn tool calls, and the dashboard chat's tool calls |
| **Token Health** | Per-conversation context-window fill, transcript (.jsonl) size, and which sessions will reset on their next turn |
| **Appearance** | Theme (4 built-in, saved per device), Tarsee's icon (upload, crop square, reset), Push Notifications (enable, disable, test) |

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SETUP_PASSWORD` | Yes | — | The PIN or password for the web UI (the phone's PIN pad takes 4 digits; any password works through **Use password instead**). In production (the Docker image, Railway) the server refuses to boot without it, because nobody could log in and the web terminal would be exposed. Run from source it boots, but every sign-in fails until it is set. |
| `ENCRYPTION_KEY` | Yes, in production | made on the volume by the Docker image | AES-256 key for everything Tarsee stores encrypted: keys saved in Settings > AI, channel tokens, the vault. Make one with `openssl rand -hex 32` and set it before you save any key in Settings; keep the same one for good. Without it, the Docker image (when `/data` exists) makes one and saves it at `/data/tarsee/.encryption-key`, next to the data it protects, and Settings warns once keys are saved there: then set this to **that file's value** (a new key makes the saved keys unreadable) and delete the file. Run from source with `NODE_ENV=production` and no key, the server refuses to start; in development it starts and stores saved keys in plain text, with a banner saying so. |
| `NODE_ENV` | No | `production` in the Docker image and on Railway, else `development` | Production makes the sign-in and CSRF cookies Secure (HTTPS only, or `localhost`) and refuses to boot without `SETUP_PASSWORD` and `ENCRYPTION_KEY`. |
| `PORT` | No | `3000` | The port the server listens on (`TARSEE_PORT` is an older name for it). In the Docker image keep it at 3000 and change the host side of `-p` instead. |
| `TARSEE_STATE_DIR` | No | `/data/tarsee` on Railway, and in the Docker image when a volume is at `/data`; else `~/.tarsee` | The folder Tarsee keeps everything in: each AI's sign-in (the Claude plan's is always `~/.claude`; the Docker image links that into `<state dir>/.claude-code-home`, so run from source the Claude plan uses your own computer's `claude` sign-in), the API token (`api.token`), and its database (with the keys saved in Settings > AI) and workspace unless `TARSEE_DATA_DIR` or `TARSEE_WORKSPACE_DIR` name other folders. With a volume, keep it inside `/data`, or it is lost on the next redeploy. Changing it later moves nothing: each sign-in, database and workspace stays in the folder it was made in, so set it back to find them again. The one exception is the upgrade from a version before multi-provider support, which kept the Claude plan sign-in in `/data/tarsee` whatever this said: if this names another folder in `/data`, the first boot moves that Claude plan sign-in and its chat history into it, one way, and nothing else. If that folder is already signed in, the old sign-in is renamed `.credentials.json.superseded` instead and is not used. |
| `TARSEE_WORKSPACE_DIR` | No | `<state dir>/workspace` | The workspace: SOUL.md, MEMORY.md, skills, uploads, canvases. `railway.toml` and `docker-compose.yml` set it to `/data/tarsee/workspace`. |
| `TARSEE_DATA_DIR` | No | `<state dir>/data` | Where the database (`tarsee.db`), the diagrams (`diagrams/`) and downloaded voice and speech models live. `railway.toml` and `docker-compose.yml` set it to `/data/tarsee/data`. |
| `CLAUDE_WORKSPACE_DIR` | No | the workspace | The folder the agent and the web Terminal start in. |
| `TARSEE_API_TOKEN` | No | made and saved as `<state dir>/api.token` | The token for the REST API (`/api/v1/message`), webhooks, the chat WebSocket, the web Terminal and the `tarsee` CLI. Shown in Settings > Memories > API Token. It can do nearly everything the signed-in dashboard can (see [Known limits](#known-limits)). |
| `TARSEE_AI_PROVIDER` | No | `claude` | The default AI when Settings > AI hasn't chosen one: `claude`, `anthropic`, `chatgpt`, `openai`, `openrouter`, `deepseek` or `local`. Once that AI is ready, it skips the setup wizard. For `chatgpt` the wizard still opens until someone signs in to ChatGPT, since no variable holds that sign-in. See [Choose your AI](#choose-your-ai). |
| `TARSEE_AI_MODEL` | No | that AI's default | The default AI's model when Settings hasn't chosen one (for example `sonnet`, or `deepseek-flash`). Empty means that AI's default; for Local AI, the first model its server lists that can chat (embedding models are left out), so set it to pin one. |
| `TARSEE_KEYS_ONLY` | No | off | Set `1` to lock **Only use API keys** on: no Claude or ChatGPT plan sign-in is ever used. For a Tarsee other people talk to. |
| `ANTHROPIC_API_KEY` | No | — | Anthropic API key (`sk-ant-api…`), for **Anthropic API key**: Claude, billed per use. The Claude plan ignores it. A key saved in Settings > AI wins over this. |
| `OPENAI_API_KEY` | No | — | OpenAI API key, for **OpenAI API key**, billed per use. Voice uses it only if you pick the OpenAI Whisper API in Settings > Voice. |
| `OPENROUTER_API_KEY` | No | — | OpenRouter key (`sk-or-v1-…`), for hundreds of models with one key. Give the key a credit limit. |
| `DEEPSEEK_API_KEY` | No | — | DeepSeek API key, the cheapest per message, spent from a balance you top up. |
| `TARSEE_LOCAL_AI_URL` | No | — | Local AI: your Ollama, LM Studio or llama.cpp server. On Railway, Local AI is offered only when this is set (or an address was saved in Settings before that rule came in). For example `http://localhost:11434/v1` (Ollama), `http://localhost:1234/v1` (LM Studio), `http://localhost:9931/v1` (llama.cpp; 8080 for older builds and its Docker image), or on Railway `http://ollama.railway.internal:11434/v1`. Inside Docker, `localhost` is the container: use `http://host.docker.internal:11434/v1` for a server on the host. |
| `TARSEE_LOCAL_AI_KEY` | No | — | Local AI's key, only if your server asks for one. Only ever sent to `TARSEE_LOCAL_AI_URL`. |
| `CLAUDE_CODE_OAUTH_TOKEN` | No | — | The Claude plan without the Terminal: the token `claude setup-token` prints (it lasts a year). Only the Claude plan ever sees it. |
| `CLAUDE_CODE_OAUTH_REFRESH_TOKEN` | No | — | Another way to sign the Claude plan in (a refresh-token login, with `CLAUDE_CODE_OAUTH_SCOPES` and `CLAUDE_CODE_OAUTH_CLIENT_ID`). Only the Claude plan ever sees it. |
| `CLAUDE_DEFAULT_MODEL` | No | `sonnet` | The Claude plan's and Anthropic key's default model when Settings has none. Defaults to the **`sonnet` alias**, which Tarsee resolves to the newest Sonnet in Claude Code's catalog before each turn. That catalog is the one the pinned Claude Code (`CLAUDE_CODE_VERSION` in the Dockerfile) carries, or the newer list Claude Code saves for your account when it is signed in, whichever is newer. Set `fable` for the most capable default (`opus` is the tier below it), a pinned id (e.g. `claude-opus-5`) if you need a frozen model, or `haiku` for a cheaper one. |
| `ELEVENLABS_API_KEY` | No | — | Premium TTS voices. Used only when ElevenLabs (or Auto) is picked in Settings > Voice; the key alone never turns it on. Otherwise the default engine, Phonon, and its fallback, Edge TTS, are free. |
| `VAPID_SUBJECT` | No | your Railway `https://` address, else `mailto:admin@example.com` | The contact Web Push services are given for your server's notifications: a `mailto:` or `https:` URL, e.g. `mailto:you@yourdomain.com`. Apple's push service turns away subjects that aren't a real mailto/https address. |
| `RAILWAY_API_TOKEN` | No | — | A Railway account or workspace token for the `tarsee_railway` tool (Railway: Account Settings > Tokens; a project token will not do). Better kept in the vault: tell Tarsee to save it with `tarsee_set_key` as `RAILWAY_API_TOKEN`, which is read first. Railway does not set this one for you. |
| `TARSEE_AGENT_ENV_KEYS` | No | every vault key | Which vault keys go into the agent's environment: a comma-separated list of names, or `off` for none. By default every key named in capitals, except Claude's, Anthropic's and Codex's own (login, billing and host) and names that change how programs run (`PATH`, `NODE_*`, proxies and the like). None while `get_key` is denied in Tool Permissions. |
| `TARSEE_AUTO_UPDATE_CLI` | No | off | Set `1` to install the latest Claude Code CLI on every boot (adds up to ~60s to each boot). It updates only the Terminal's `claude` (and the model list read from it): chat turns keep running the Agent SDK's own copy, so the two then differ (the boot log says so). Read only by the Docker image's `entrypoint.sh`, so it does nothing when you run from source. Off, the image keeps the version pinned in the Dockerfile (`CLAUDE_CODE_VERSION`). |
| `TARSEE_CODEX_BIN` | No | the `codex` that `@openai/codex-sdk` installs | Run another Codex program. On Windows it must name `codex.exe` itself, not a `.cmd` launcher (a turn is refused and says so). |
| `TARSEE_PHONON_AUTO_INSTALL` | No | on | Set `0` to stop Tarsee downloading Phonon's model in the background on boot when Phonon is the voice engine. The Install Phonon button in Settings > Voice still works. |
| `TARSEE_PHONON_DIR` | No | `<data dir>/tts/phonon` | Where Phonon's model, voices and (if needed) Python venv live. On Railway that is `/data/tarsee/data/tts/phonon`, on the volume. |
| `TARSEE_PHONON_PYTHON` | No | `python3` | Python interpreter with the `ptts` package for Phonon's worker. Without it Tarsee uses `python3`, or a private venv it creates under `TARSEE_PHONON_DIR` when `python3` lacks `ptts` (made from the same Python as speech-to-text: one found on the computer, or Tarsee's own). |
| `TARSEE_STT_PYTHON` | No | — | A Python with faster-whisper that you manage yourself, for speech-to-text. Without it Tarsee uses its own (Settings > Voice > Speech-to-text > Install faster-whisper, in `<state dir>/python`), or a Python on the computer that has faster-whisper (the Docker image's `python3`). |
| `TARSEE_WHISPER_BUNDLED_DIR` | No | set by the Docker image | Where the image keeps the speech-to-text models it ships (`/opt/tarsee/whisper-models`, outside the volume). Downloaded models go to `<data dir>/whisper-models` (on Railway, `/data/tarsee/data/whisper-models`, on the volume). |
| `TARSEE_PHONON_THREADS` | No | up to 4 | CPU threads for Phonon's worker. |
| `TARSEE_CHANNEL_IDLE_ABORT_MS` | No | `1200000` (20 min) | Abandon a turn after this long with no stream event. Keep finite. On Telegram, Discord and WhatsApp the time also runs while a message waits behind another reply in its chat, so one that waits this long is given up before its turn starts, and the chat is told the AI stopped responding. |
| `TARSEE_COMPACT_WINDOW` | No | `180000` | Context size (tokens) at which Claude Code summarizes the older part of a chat and carries on; Codex does at the smaller of this and 85% of the model's context. Every model call re-reads the whole context, so a smaller window means fewer cached tokens per call (measured: about a quarter fewer than at 300k). Accepts `250000`, `150k`, or `off` for the CLI's own (the model's full window); the CLI holds it to 100k–1M. A `CLAUDE_CODE_AUTO_COMPACT_WINDOW` you set yourself is kept when this is unset. The live context meter measures against this window on every AI; Token Health does on the AIs that run on Claude Code, and uses the model's own window on Codex AIs (the ChatGPT plan, the OpenAI key, Local AI, OpenRouter models on Codex). |
| `TARSEE_TOOL_RESULT_MAX_CHARS` | No | `12000` | A tool result (Tarsee's own `tarsee_*` tools and any other MCP tool) longer than about this many characters is saved to a file, and the agent gets the path and how to read it. On Claude Code, Claude Code saves it (passed as `MAX_MCP_OUTPUT_TOKENS`, characters ÷ 4; Claude Code's own default is 25000 tokens; a `MAX_MCP_OUTPUT_TOKENS` you set yourself is kept when this is unset). On Codex, Tarsee saves it to `<state dir>/tool-output/<turn>/` and deletes it after 7 days. A value under 1000 is ignored. |
| `TARSEE_BASH_OUTPUT_MAX_CHARS` | No | `8000` | A Bash output longer than this is saved to a file by Claude Code, and the agent gets a short preview plus the path (Claude Code's own default is 30000). Sets `BASH_MAX_OUTPUT_LENGTH` for each turn; a `BASH_MAX_OUTPUT_LENGTH` you set yourself is kept when this is unset. |
| `TARSEE_SESSION_JSONL_MAX_MB` | No | `8` | Transcript size cap. Past it, the next turn starts a fresh session (with the recent conversation handed over) instead of resuming the bloat. |
| `TARSEE_MODEL_CONTEXT_TOKENS` | No | from model registry | Override the context window assumed by Token Health. |
| `TARSEE_SESSION_MAX_AGE_DAYS` | No | `30` | Login session lifetime. Sessions persist to SQLite (each stored only as a hash) and survive redeploys. |
| `TARSEE_CSRF_MAX_AGE_HOURS` | No | `24` | CSRF token lifetime. |
| `TARSEE_CHANNEL_HEALTH_MS` | No | `60000` | How often the watchdog checks for a wedged Telegram poller and a Slack connection that is down. |
| `TARSEE_SLACK_DOWN_MS` | No | `180000` (3 min) | How long Slack's Socket Mode connection may be down before the watchdog restarts it. |
| `TARSEE_EVENT_RETENTION_DAYS` | No | `14` | How long the live timeline's events are kept. |
| `TARSEE_CLEAR_SESSIONS_ON_BOOT` | No | off | Set `1` to restore the old behaviour of wiping every chat's session id on boot. |
| `TARSEE_TIMEZONE` | No | host zone | IANA zone the agent reasons in for "today", "tomorrow at 9", and cron schedules (e.g. `Europe/Berlin`). Railway containers run UTC, so set this or your 8am reminders fire at 8am UTC. An unrecognised zone falls back to UTC with a warning. The Usage page counts its days, and the monthly spending cap its months, in this zone too. |
| `TARSEE_USAGE_BACKFILL_DAYS` | No | `14` | How far back the Usage page's first read of the Claude session transcripts goes. Later reads only take what each transcript gained. |
| `TARSEE_USAGE_RETENTION_DAYS` | No | `90` | Token usage rows older than this are deleted. |

> **Note:** The plans' sign-ins aren't variables (apart from the optional `CLAUDE_CODE_OAUTH_TOKEN` and `CLAUDE_CODE_OAUTH_REFRESH_TOKEN`): the Claude plan signs in from the Terminal and the ChatGPT plan from Settings > AI, and both stay on the volume. API keys go in Settings > AI or in these variables, never in a file. The captcha solver's key goes in Settings > Security, not in a variable. See [Choose your AI](#choose-your-ai).

---

## Self-Hosting with Docker

```bash
git clone https://github.com/projectservan8n/Tarsee.git
cd Tarsee
# The commit gives the build its id: /version shows it, and BOOT.md runs once per build.
docker build --build-arg RAILWAY_GIT_COMMIT_SHA="$(git rev-parse HEAD)" -t tarsee .

# Make an encryption key once and keep it: Tarsee needs the same one every time it starts.
export ENCRYPTION_KEY="$(openssl rand -hex 32)"
echo "$ENCRYPTION_KEY"   # save this somewhere safe

docker run -d \
  --name tarsee \
  -p 3000:3000 \
  -v tarsee-data:/data \
  -e SETUP_PASSWORD=your-4-digit-pin \
  -e ENCRYPTION_KEY \
  tarsee
```

Tarsee listens on port 3000 inside the container (its health check is fixed there): to use another port, change the host side, like `-p 4000:3000`. Open http://localhost:3000, log in with your PIN, and the setup wizard asks you to [choose your AI](#choose-your-ai). A plan signs in from the wizard (the Claude plan through Tarsee's Terminal), and a key is pasted into the wizard (tested, then saved) or Settings > AI.

The volume at `/data` is required, not optional. Everything Tarsee keeps (its database with the keys saved in Settings > AI, each AI's sign-in, and the workspace) is in the `tarsee-data` volume, in `/data/tarsee` inside the container, so a rebuild or a new container still has it. Without `-v …:/data` the image sets up no sign-in folders and makes no encryption key, and nothing survives the container.

**Opening it from another machine.** The image runs in production mode, so the sign-in cookie is Secure. Opened over plain http at a LAN or server address (not `localhost`), the sign-in won't stick, and calls and dictation can't use the microphone. Use `http://localhost:3000` on the same machine, an SSH tunnel, or an HTTPS reverse proxy (Tarsee already trusts one proxy in front of it). The server listens on every address, and the web Terminal is a shell behind your PIN, so don't expose port 3000 to the internet without HTTPS and a strong password.

**Variables.** To give Tarsee a key as a variable instead, put it in a `.env` file that you never commit and add `--env-file .env` to `docker run`, so the key never appears in a command. `.env.example` lists the AI variables and the main ones, with what each is for; the full list is the [table above](#environment-variables).

**Docker Compose.** Copy `.env.example` to `.env`, fill in `SETUP_PASSWORD` and `ENCRYPTION_KEY`, then run `docker compose up -d --build`. `docker-compose.yml` passes only the names in its `environment:` list into the container: add any other variable you set in `.env` (such as `TARSEE_TIMEZONE` or `ELEVENLABS_API_KEY`) to that list, or it never reaches Tarsee.

**Local AI on the same machine.** Inside the container `localhost` is the container itself, so use `http://host.docker.internal:11434/v1` for an Ollama on the host (on Linux, add `--add-host=host.docker.internal:host-gateway` to `docker run`).

**ARM computers** (Apple Silicon, ARM servers): the image's ffmpeg is an amd64-only build, so ffmpeg (the video-frames skill, and the ffmpeg check in the command-line tool's `tarsee doctor`) doesn't run there. Everything else installs for ARM.

### Updating

```bash
cd Tarsee
git pull
docker build --build-arg RAILWAY_GIT_COMMIT_SHA="$(git rev-parse HEAD)" -t tarsee .
docker rm -f tarsee
# then the same docker run as above: the same tarsee-data volume and the same ENCRYPTION_KEY
```

With Compose: `git pull`, then `docker compose up -d --build`.

Requirements: Docker, a volume at `/data`, and one of the seven AIs in [Choose your AI](#choose-your-ai).

---

## Run it from source

For development, or to run Tarsee on your own computer without Docker. You need Node 22 or newer.

```bash
git clone https://github.com/projectservan8n/Tarsee.git
cd Tarsee
npm ci
export SETUP_PASSWORD=1234                       # the PIN you will sign in with
export ENCRYPTION_KEY=your-saved-key             # make it once with: openssl rand -hex 32, then keep it
npm start                                        # or: npm run dev, which restarts on every change
```

Then open http://localhost:3000. (For PowerShell, see the example in [docs/live-testing.md](docs/live-testing.md).)

- Everything goes in `~/.tarsee`, unless `TARSEE_STATE_DIR` names another folder.
- Without `ENCRYPTION_KEY`, keys saved in Settings are stored in plain text (Settings > AI says so). Keep the same key every time.
- The Claude plan uses your own computer's `claude` sign-in (`~/.claude`): run `claude auth login` in a terminal (with the Claude Code CLI installed: `npm install -g @anthropic-ai/claude-code`).
- Sign in to the ChatGPT plan from Settings > AI. Run from source, `codex login` (in Tarsee's Terminal too) writes `~/.codex`, which Tarsee's turns don't use.
- On first start, Tarsee downloads Phonon (about 72 MB) when it finds a usable Python (3.9 to 3.14, with `venv`); otherwise **Install Phonon** in Settings > Voice downloads Tarsee's own Python first. `TARSEE_PHONON_AUTO_INSTALL=0` stops the automatic download. Speech-to-text: **Install faster-whisper** in Settings > Voice.
- The browser tool needs Chromium: `npx playwright install chromium`.
- The server listens on every address, and the web Terminal is a shell on your computer behind your PIN: use a strong password, and keep it off networks you don't trust.
- `node src/cli/index.js start|stop|status|doctor|chat|interactive|version` is the `tarsee` command-line tool (the `bin` in package.json). `chat` sends one message to a running Tarsee and needs `TARSEE_API_TOKEN` set to its API token.

---

## Security

- AES-256-GCM encrypted credential vault
- Chat files are served only from the workspace's `uploads` folder (real path checked), and never as a page that can run: HTML and scripts open as plain text
- Timing-safe authentication; sign-in sessions stored only as a hash
- CSRF protection on signed-in browser requests. Requests with the API token skip it, and the sign-in routes, webhooks, the WhatsApp webhook and `/api/v1` aren't behind it (they take the PIN, the API token or the webhook's secret)
- Content Security Policy headers
- A command a diagram put in the message box asks before it runs: Tarsee shows the whole command, with Cancel first (except after the browser has put the box's words back by itself: see [Known limits](#known-limits))
- Sign-in rate limiting: 5 attempts a minute per IP, then lockouts after failed PINs (30 s after 4 failures, 2 min after 6, 10 min after 8, 1 hour after 10)
- Path traversal protection
- Each AI's sign-in in its own owner-only folder on the volume, and API keys stored encrypted, shown only by their last 4 characters and only ever sent to their own provider (Tarsee never handles the Claude or ChatGPT sign-in tokens itself)
- Session isolation per conversation
- Audit log of logins, credential changes, denied and Warn tool calls on every channel, and every tool call from the dashboard's chat

### Known limits

Tarsee is a single-owner agent with a real shell. Know what the agent can reach:

- **The AI's shell runs as the same OS user as Tarsee.** It can read Tarsee's data folder: the database, `api.token`, each AI's sign-in, and in the Docker image the generated `/data/tarsee/.encryption-key`. On Linux it can also read keys from the engine's environment. Give every key a spending limit at its provider: that is the real guard.
- **After Back, a diagram's command can go out without the question.** A diagram's words are the AI's, and they can be one of your commands, which run as you from the signed-in dashboard: `/cron add` schedules a task that is on at once, `/cron on <id>` switches on a task the AI made that waits for your OK, and `/remember` saves an instruction to memory. Tarsee asks before it sends one, but only while it knows a diagram put the words in the box. When the browser puts the box's words back by itself (you went to another page and came Back, or it restored its tabs), Tarsee no longer knows, and a command among them is sent without the question. Read what is in the box before you send it.
- **The API token can do much of what the signed-in dashboard can**: run turns through `/api/v1/message` and the chat, send most chat commands, change Tool Permissions, and add and fire webhooks. Your signed-in dashboard is needed to switch a scheduled task on, to OK HEARTBEAT.md or BOOT.md, and for the owner's chat commands (`/cron`, `/briefing`, `/webhook`): sent with only the token, they are refused, and a task added with only the token is saved paused. Anything holding the token can do the rest, the AI's shell included, since it can read `api.token`. Sign-in sessions are stored only as a hash, so the shell can't copy one out of the database to act as your signed-in dashboard.
- **The web Terminal is a full shell** on the server as Tarsee's user, and it opens with your sign-in or the API token.
- **`approved_by`** on `tarsee_discord_admin` and `tarsee_railway` is free text the AI writes; Tarsee records it but can't confirm you said go.
- **Your OK for HEARTBEAT.md, BOOT.md and the AI's scheduled tasks** is kept in Tarsee's database, which the AI's shell can reach. It stops the AI starting paid work in the normal course of a chat, but it isn't a locked door.
- **The address checks** on the fetch and browser tools look only at the host name as typed (see [Security](#security) under What You Get).
- **Run from source without `ENCRYPTION_KEY`**, secrets are stored in plain text.

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
    local-bridge.js            # Local AI bridge: Codex's grouped tools as plain functions for your server
    codex-device-login.js      # ChatGPT sign-in with a one-time code
    verify-model.js            # One-click Verify for a model
    settings-guard.js          # Refuses turns while a settings file could redirect a key
    tarsee-mcp.js              # 20+ MCP tools
  lib/
    tools.js, commands.js      # Tool registry + chat commands
    cron.js                    # Scheduler
    automation-approval.js     # The owner's OK for HEARTBEAT.md and BOOT.md
    heartbeat.js               # The 30-minute heartbeat (HEARTBEAT.md)
    boot-runner.js             # The startup checklist (BOOT.md), once per build
    canvas.js                  # Canvas/artifact server, and the diagrams' pages (diagram-renderer.js)
    security-audit.js          # Security checks
  channels/
    telegram.js, discord.js    # Bot integrations
    whatsapp.js, slack.js      # (slack-app-manifest.yml: the Slack app)
    email.js                   # Email channel (IMAP IDLE + SMTP)
    websocket.js               # Web UI real-time + cross-device sync
  cli/                         # The tarsee command-line tool
  voice/
    stt-handler.js             # Speech-to-text: faster-whisper worker (stt_worker.py), or the OpenAI Whisper API
    stt-install.js             # Settings > Voice > Speech-to-text: status, Install faster-whisper, model downloads
    whisper-models.js          # The pinned Systran models (sizes, hashes); downloads and deletes them
    python-runtime.js          # Finds a Python, or downloads a standalone one, for faster-whisper and Phonon
    phonon-engine.js           # Default TTS: local Phonon model, warm Python worker
    phonon-install.js          # Downloads Phonon (pinned, sha256-checked) to the volume
    engine-registry.js         # Picks the engine; Edge TTS backs Phonon up
    edge-tts-engine.js         # Free TTS (19 voices), the fallback
  routes/
    chat.js                    # Chat API + SSE streaming
    voice.js                   # Settings > Voice, transcription and TTS streaming
    voice-call.js              # Voice calls: the call's chat, the hang-up handoff (lib/voice-call.js)
    ai.js                      # Settings > AI: cards, keys, Test, Verify, sign-in
    automation-approval.js     # Let it run / Run at each restart
    external-api.js            # REST API (/api/v1/)
    webhooks.js                # POST /api/webhooks/<id>
    analytics.js               # Usage page API (lib/token-usage.js reads the transcripts)
  public/                      # Web UI (vanilla HTML/CSS/JS, PWA)
test/                          # node --test; test/fixtures/ has the fake servers (fake-anthropic.js, fake-responses.js)
scripts/                       # End-to-end checks (scripts/e2e/) and smoke-backends.mjs
docs/                          # providers.md (each AI's setup), live-testing.md (real keys)
```

Run `npm test` and `npm run lint` (ESLint, no warnings allowed) before a PR. CI runs `npm ci`, `npm run lint` and `npm test` on Node 22 and 24 for every pull request and every push to main, without the browser download. The tests need no AI keys: every provider is checked against local fake servers. The Codex tests use the `codex` binary pinned in `package.json`; `TARSEE_CODEX_BIN` points the tests (and Tarsee) at another copy. Some tests skip unless the machine has what they need: Chromium, Chrome or Edge (the browser tests), Linux (the key-exposure tests), a POSIX `sh` (the image-build checks), the pinned `codex` binary, an installed Phonon, and `TARSEE_TEST_STT_PYTHON` plus `TARSEE_TEST_STT_MODEL` for the real faster-whisper test.

End-to-end checks (none has an npm script; run them with `node`):

- `scripts/e2e/ai-api-e2e.mjs`: every AI through the real server, against local fake providers.
- `scripts/e2e/ai-ui.e2e.mjs` and `scripts/e2e/ai-ui-railway.e2e.mjs`: the setup wizard and Settings > AI in Playwright's Chromium (they reach the real provider sites with fake keys).
- `scripts/e2e/live-smoke.mjs`: real keys against a running Tarsee; see [docs/live-testing.md](docs/live-testing.md). `scripts/e2e/live-smoke-fakes.mjs` proves it without keys.
- `scripts/e2e/upgrade-e2e.mjs`: the upgrade from main on the same state folder.
- `scripts/smoke-backends.mjs`: Verify's probe with real keys from the environment; run it on every engine bump.

---

## License

MIT

Text-to-speech by [Phonon](https://huggingface.co/gradium/phonon-31m-en) from [Gradium](https://huggingface.co/gradium): the [ptts](https://github.com/gradium-ai/xn-ptts) runtime (MIT or Apache-2.0), the `phonon-31m-en` weights and the [phonon-voices](https://huggingface.co/gradium/phonon-voices) catalog (Apache-2.0). They are downloaded at runtime and are not part of this repository.
