<p align="center">
  <img src="Tarsee.png" alt="Tarsee" width="120">
</p>

<h1 align="center">Tarsee</h1>

<p align="center"><strong>Your personal Claude Code agent, running 24/7 in the cloud.</strong></p>

<p align="center">Talk to Claude from anywhere — web, Telegram, Discord, WhatsApp, email, or voice. It remembers everything, runs tools, and schedules tasks. Uses your Claude Max subscription. No API keys needed.</p>

> **Tarsee is built for Claude Max subscribers.** It runs a persistent Claude Code agent that uses your subscription for every message. Pro subscribers will hit usage limits quickly — Max (especially 5x) is strongly recommended for daily use.

<p align="center">
  <a href="https://railway.com/deploy/tarsee?referralCode=sIH3US&utm_medium=integration&utm_source=template&utm_campaign=generic"><img src="https://railway.com/button.svg" alt="Deploy on Railway"></a>
</p>

---

## Why Tarsee?

I was using [OpenClaw](https://github.com/openclaw/openclaw) to run Claude Code 24/7. It worked — until Anthropic changed their billing so OAuth tokens used through these wrappers started counting against your subscription usage. That's fine, but the resource overhead was heavy for what I needed.

I just wanted Claude Code running 24/7 that I could talk to from my phone. So I wrapped the Claude Code SDK directly and built a lightweight frontend. No build step, no TypeScript compile, no framework overhead.

Haven't looked into Claude Cowork yet, but if you love Claude Code and want it always on from any device, this is it.

### How Tarsee Compares

Being honest — some of these projects are massive with huge communities. Tarsee is small and focused. Here's where it fits:

| | Tarsee | [OpenClaw](https://github.com/openclaw/openclaw) | [NanoClaw](https://github.com/qwibitai/nanoclaw) | [PicoClaw](https://github.com/sipeed/picoclaw) | [Nanobot](https://github.com/HKUDS/nanobot) |
|---|--------|----------|----------|----------|---------|
| **Stars** | New | 353K | 27K | 28K | 39K |
| **Language** | Node.js | Node.js + TypeScript | TypeScript | Go | Python |
| **Frontend** | Vanilla HTML/CSS/JS | React + Primer UI | React | Go Web UI + TUI | Python CLI |
| **Build step** | None | TypeScript + Vite | TypeScript | Go compile | pip install |
| **RAM** | ~200-400MB | Higher (full React stack) | Moderate | <10MB | Low |
| **Channels** | Web, Telegram, Discord, Voice | 24+ (WhatsApp, Slack, Signal, etc.) | WhatsApp, Telegram, Discord, Slack | 18+ (Telegram, Discord, WeChat, etc.) | 12+ (Telegram, Discord, WhatsApp, etc.) |
| **Voice** | Yes (faster-whisper + Edge TTS) | Yes (wake word, ElevenLabs) | No | No | Telegram/WeChat voice |
| **Mobile** | PWA + iOS PIN pad | Native iOS/Android apps | Via messaging apps | Android APK | Via messaging apps |
| **Memory** | Persistent + deep search | Session-based with group isolation | SQLite + per-group files | JSONL memory store | Token-based memory |
| **Auth** | Claude subscription (OAuth) | OAuth + API keys | API keys | API keys + OAuth | API keys + OAuth |
| **LLM support** | Claude only | Claude only | Claude only | 30+ providers | Multi-provider |
| **Self-host cost** | ~$2-10/mo Railway | Higher (more resources) | Moderate | ~$10/mo (runs on anything) | Low |

### Why choose Tarsee?

- **You want simplicity** — no build step, no TypeScript, no framework. Just Node.js serving HTML.
- **You want Claude specifically** — Tarsee wraps Claude Code SDK directly. Not multi-provider, not trying to be everything.
- **You want it cheap** — runs on $2-10/mo Railway. No API costs with Claude Max.
- **You want voice + mobile** — PWA with local speech-to-text, hold-to-talk, iOS PIN pad login.
- **You want memory** — persistent memory across sessions with deep semantic search.
- **You want browser automation** — stealth Playwright with captcha solving built in.

### Why choose something else?

- **You need 20+ channels** — OpenClaw or PicoClaw support way more platforms.
- **You need native mobile apps** — OpenClaw has actual iOS/Android apps.
- **You need multi-provider** — PicoClaw supports 30+ LLMs. Tarsee is Claude-only.
- **You need minimal resources** — PicoClaw runs on <10MB RAM. Tarsee needs ~200MB.
- **You want a massive community** — OpenClaw has 353K stars and thousands of contributors.

Tarsee is a Claude Code wrapper — not a fork, not a rewrite. It uses `@anthropic-ai/claude-agent-sdk` directly, so you get the exact same Claude Code experience with all built-in tools (Read, Write, Edit, Bash, Grep, Glob) plus Tarsee's own tools on top.

---

## Quick Start (Railway)

1. Click **Deploy on Railway** above
2. **Change the `SETUP_PASSWORD`** — this is your 4-digit PIN to access the web UI. Everything else is pre-configured.
3. Deploy — open the URL, log in with your PIN
4. The setup wizard will guide you through connecting your Claude account:
   - Click **"Open Tarsee's Terminal"** — this opens a terminal on the server (not your local machine)
   - Click inside the terminal, then type `claude login`
   - A login link will appear — **highlight it and right-click → Copy** (Ctrl+C won't work in the terminal)
   - Open the link in your browser and authenticate with your Claude Max account
   - Come back and click **"I'm connected"** — done!

That's it. Credentials are stored on the Railway volume and auto-refresh. No env vars to manage. Claude Code CLI auto-updates on every restart.

### Authenticating with Claude

You need an active [Claude Max](https://claude.ai) subscription with Claude Code enabled. **Max is strongly recommended** — Pro will hit usage limits with a persistent agent.

Credentials are saved to the Railway volume at `/data/tarsee/.claude-code-home/.credentials.json` and persist across restarts, redeploys, and image rebuilds. The SDK auto-refreshes tokens — you only need to log in once. If you ever get logged out, just run `claude login` again from the terminal (icon in topbar).

> **Why not an env var?** OAuth refresh tokens are single-use. If you set credentials as an env var, every redeploy overwrites the SDK's refreshed token with the stale original, causing auth failures. Logging in directly on the server avoids this entirely.

### Staying Updated

If you deployed from the Railway template, your instance is a snapshot — it won't auto-update. To get the latest features:

1. Go to your Railway service → **Settings → Source**
2. Connect it to `projectservan8n/Tarsee` on GitHub
3. Every push to main will auto-deploy to your instance
4. Your data on `/data` is safe — the volume persists across redeploys

---

## What You Get

### Chat Everywhere
- **Web UI** — Full chat with markdown rendering, code blocks, tables, file attachments, image paste, drag-and-drop, multi-file upload. PWA — save to homescreen on iOS/Android.
- **Telegram** — Text, photos, PDFs, voice messages, video notes. Group @mention support, inline buttons, forwarded message detection.
- **Discord** — Text, images, PDFs, voice messages. Always-online bot with presence status.
- **Email** — Real-time over IMAP IDLE + SMTP. Mention keyword (default `@tarsee`) gates replies; CC/BCC/forwards are absorbed as context without an outbound. Works with any mailbox you own (Gmail, Outlook, iCloud, Zoho, FastMail, Yahoo, self-hosted).
- **WhatsApp** — Text, images, PDFs, voice notes (Whisper-transcribed), and documents via [WHAPI Cloud](https://whapi.cloud) (free tier OK). Direct messages only. Per-channel webhook secret in URL, auto-generated on first enable.
- **Attachment save-to-disk** — every image, PDF, voice note, and document sent via Discord, Telegram, email, WhatsApp, or web lands in `workspace/uploads/` so Claude can read, transform, and reference it across turns (not just in the message it arrived on).
- **Cross-device sync** — all devices update in real-time via WebSocket. See tool calls, text streaming, and typing indicators across devices.
- **Session recap** — resume a conversation idle >30 min and a dismissible "Last time" card summarizes the last few exchanges before the first new message. Zero AI cost (extractive summary).
- **Web Push notifications** — iOS/Android/desktop push via VAPID when cron jobs finish, webhooks fire, or Claude proactively pings you via the `tarsee_push_notification` MCP tool. Opt-in from Settings > Appearance.
- **All channels share** the same AI, memory, and tools.

### Voice Mode
- **Hold-to-talk or tap-to-toggle** — full-screen conversational UI with waveform visualization.
- **Live tool status** — shows "Reading file...", "Running command...", "Calculating..." instead of generic "Thinking..."
- **Spacebar shortcut** — hold space to talk, Space+C to cancel.
- **Drag to cancel** — slide away from the orb or mic button to discard recording.
- **Local speech-to-text** — faster-whisper (CTranslate2, 4x faster than OpenAI whisper). Configurable models: tiny.en / base.en / small.en. No API key. Runs on CPU.
- **Free text-to-speech** — Microsoft Edge TTS with 19 voices, 3 retries, markdown stripping. No API key, no rate limits.
- **Smart TTS** — tables and code shown visually, spoken response is a clean conversational summary.

- **Multilingual speech-to-text** — the bare `tiny`/`base`/`small` Whisper checkpoints auto-detect the spoken language; the `.en` variants are English-only and will return garbage for other languages. Switch in Settings > Voice.

### Canvas / Artifacts
- **Live HTML/CSS/JS** — Ask for a dashboard, chart, calculator, or mini-app → renders as an interactive iframe right in chat.
- **Canvas gallery** — browse all your canvases at `/canvas/`.
- **Persistent** — Canvases are saved to the volume and accessible at `/canvas/<id>/`.

### Tools & Automation
- **20+ MCP tools** — send messages, schedule tasks, remember facts, search the web, create canvases, manage files, encrypted vault, calculator, browser, push notifications, email threads, and more.
- **Calculator** — precise math tool so Claude never hallucinates numbers. Arithmetic, percentages, Math.* functions.
- **Stealth browser** — Playwright with anti-detection (real fingerprints, no webdriver flag). Navigate, fill forms, screenshot, scroll, wait, run JS.
- **Captcha solver** — auto-detect and solve reCAPTCHA, hCaptcha, Cloudflare Turnstile via 2Captcha or Capsolver API.
- **Proactive briefings** — `/briefing on` schedules a daily morning summary pushed to all channels.
- **Auto model routing** — `/auto on` picks haiku/sonnet/opus based on message complexity.
- **Deep memory search** — AI reads all memories semantically when keyword search fails.
- **Cron scheduler** — recurring AI tasks or direct tool actions. One-time reminders auto-delete.
- **Web terminal** — browser-based shell access via xterm.js.
- **File manager** — browse, edit, and create workspace files from the UI.
- **REST API** — `/api/v1/message` endpoint for iOS Shortcuts, scripts, and automations.
- **Skills** — modular instruction packs with credentials and configs. Claude reads them automatically when relevant. Ships with `/ultrareview` (3-agent parallel branch review — correctness / architecture / UX-a11y) and `/fewer-permission-prompts` (proposes a tool-allowlist patch from your audit log) preinstalled.
- **`/checkpoint` — cross-restart handoff** — manual AI-synthesized `CHECKPOINT.md` before a known redeploy, plus an activity-gated auto-checkpoint every 6h as a safety net. On the next boot, the checkpoint is injected into the system prompt so work picks up mid-thought instead of starting cold.
- **Retention** — daily 03:00 sweep prunes conversations idle >14 days and checkpoint archives older than 30 days (or >50 files). Keeps the most recent thread per channel so Discord/Telegram/email session continuity never breaks. One-line summaries of pruned conversations append to `memory/archived-conversations.md` so nothing vanishes without a record. Configurable via `retention.*` settings or `/retention` command.

### Models
- **Alias-first model registry** — the default is the bare `opus` alias, which Claude Code resolves to the newest Opus at request time. Pinned ids (`claude-opus-5`, `claude-sonnet-5`, `claude-opus-4-8`, …) remain selectable when you need a frozen, reproducible model. This replaced a hardcoded pin that had silently fallen two releases behind: the registry named Opus 4.7 as the default long after Opus 4.8 and Opus 5 shipped, so every session ran on an outdated model until someone edited the file. Aliases make that class of bug impossible.
- **Tiers** — `opus`, `sonnet`, `haiku` and `fable` are all available as always-latest aliases, and `/model <name>` accepts either an alias or a pinned id.

### Search & Analytics
- **Live context meter** — the session bar shows a real-time prompt-token fill % against the active model's context window (1M for Opus/Sonnet, 200K for Haiku). Counts cache reads and cache writes too — that's the actual prompt size hitting the model. Bar turns yellow at 75%, red and pulsing at 90%, with a dismissible banner above the composer. At 95% Tarsee writes a mechanical snapshot to `CHECKPOINT.md` automatically; if a turn still trips "prompt is too long", the snapshot is written from the catch path and a recovery card is shown in chat with a one-click "Start fresh session" button. The next boot reads that checkpoint as the handoff so you pick up mid-thought.
- **Token usage chart** — daily/weekly visual bar chart with model breakdown in Settings > Usage.
- **Token Health** (Settings > Token Health) — a per-conversation view of how full each context window actually is, alongside the Claude session transcript (`.jsonl`) size, which is the real driver of bloat-hangs. Fill is measured point-in-time (the most recent turn's prompt size, counting cache reads and cache writes), not a running total of every token the chat ever spent — the lifetime figure is reported separately so the two can't be confused. Conversations whose transcript passes `TARSEE_SESSION_JSONL_MAX_MB` are flagged `resets next turn`, and the provider enforces that same cap by refusing to resume, so the flag reflects real behaviour rather than predicting it. Conversations with no recorded telemetry are labelled `est.` rather than shown as if measured. All channels (Telegram, Discord, WhatsApp, email, web) now record token usage — previously only web chat did, so channel conversations had no data at all.
- **Audit log** — timestamped log of all tool executions, logins, and settings changes.
- **QR code** — scan from desktop to instantly open Tarsee on your phone.
- **Typing indicator** — see when you're typing on another device in real-time.
- **Todo rendering** — Claude's task lists render as styled checklists with progress indicators.

### Memory & Identity
- **Workspace files** — SOUL.md (personality), MEMORY.md (knowledge), USER.md (user info), IDENTITY.md.
- **Auto-memory** — Claude saves important facts as you chat. Memories persist across sessions.
- **Daily logs** — timestamped notes auto-appended to `memory/YYYY-MM-DD.md`.
- **Checkpoints** — `CHECKPOINT.md` on the volume survives redeploys. Read once on the next boot, then archived to `memory/checkpoints/<timestamp>.md` for grep-able history.

### Appearance & Controls
- **Themes** — `warm-charcoal` (default, terracotta accent), `noir` (pure black OLED-friendly), `solarized-light` (daylight), `jarvis-blue` (cyan accent). Switch from Settings > Appearance or via `/theme <name>`. Plugin-shipped themes are loaded from `ui.themes.plugin` automatically.
- **Effort slider** — 6-notch touch-native slider (auto / low / medium / high / max / xhigh) for setting Claude's thinking effort. Long-press the effort toggle on the composer to open; `/effort` opens it via keyboard. `xhigh` (Ultra) is available on Opus 4.7.

---

## How It Works

```
You (web / telegram / discord / email / voice / iOS push)
  |
  v
Tarsee Server (Railway)
  |
  +-- Claude Code Agent SDK (subscription auth, auto-updates)
  |     +-- Built-in: Read, Write, Edit, Bash, Grep, Glob
  |     +-- MCP tools: send_message, schedule_task, remember,
  |         create_canvas, calculator, browser, web_search,
  |         push_notification, send_email_thread, configure_email, etc.
  |
  +-- Voice:      faster-whisper STT + Edge TTS
  +-- Browser:    Playwright (stealth) + captcha solving
  +-- Workspace:  SOUL.md, MEMORY.md, USER.md, CHECKPOINT.md
  +-- SQLite:     conversations, settings, vault, bot_memory, push_subs
  +-- Channels:   Telegram, Discord, Email (IMAP IDLE + SMTP)
  +-- Continuity: /checkpoint + 6h auto-checkpoint + session recap card
  +-- Retention:  daily 03:00 sweep (14d convs, 30d/50-file checkpoints)
  +-- Push:       VAPID + service worker — cron/webhook/tool fires
```

---

## Channel Setup

Configure in **Settings > Channels** after deploying. Channels auto-start when you save the token.

| Channel | How to get token | Features |
|---------|-----------------|----------|
| Telegram | [@BotFather](https://t.me/BotFather) | Text, photos, PDFs, voice, video notes, inline buttons, groups |
| Discord | [Developer Portal](https://discord.com/developers) | Text, images, PDFs, voice messages, reactions, presence |
| Email | IMAP + SMTP (any provider — see below) | Real-time mail, `@mention` gate, CC/BCC context absorb, threaded replies |
| WhatsApp | [WHAPI Cloud](https://panel.whapi.cloud) | Text, images, PDFs, voice notes (Whisper-transcribed), documents. DMs only. |

**Discord:** Enable **Message Content Intent** in Bot settings. Invite with Send Messages, Read Messages, Add Reactions permissions.

**WhatsApp:** Tarsee uses [WHAPI Cloud](https://whapi.cloud) as the WhatsApp gateway (free tier is enough for personal use). Setup:

1. Sign up at [panel.whapi.cloud](https://panel.whapi.cloud), create a channel, scan the QR code with the WhatsApp account you want Tarsee to use.
2. Copy the **Bearer token** from the channel's Token tab.
3. In Tarsee → `Settings > Channels > WhatsApp`, paste the token, check Enable, click Save. A **webhook URL** appears.
4. Copy that URL into WHAPI dashboard → `Settings > Webhooks`, select event `messages`, save.
5. Send a WhatsApp message to your bot's number — Tarsee replies via Claude.

Direct messages only; group messages are silently ignored. Voice notes are transcribed locally via faster-whisper. Images and PDFs go to Claude vision. Other documents (DOCX, XLSX, ZIP, TXT, CSV, etc.) are saved to `workspace/uploads/` and Claude can `Read` them with the file tool.

---

### Email channel

Tarsee can live in any mailbox you own and reply in real-time. Inbound mail where the body contains `@tarsee` (configurable) triggers a reply; everything else is absorbed silently so Claude remembers the thread and can answer questions about it later. CC'd, BCC'd, and forwarded mail never triggers an outbound reply.

**Setup (two paths — pick one):**

1. **Settings UI** — open `Settings > Channels > Email`, click a provider preset (Gmail / Outlook / iCloud / Zoho / FastMail / Yahoo), paste your email + app password, save.
2. **Chat** — tell Tarsee in conversation: *"Set up email. Mailbox `tarsee@example.com`, Gmail app password `xxxx-xxxx-xxxx-xxxx`, only allow `you@example.com`."* Tarsee calls the `tarsee_configure_email_channel` MCP tool and the channel starts immediately.

Both paths write to the same `channel.email` record. The Settings UI renders whatever's configured regardless of which path set it.

**App passwords** (most providers require one instead of your login password):

| Provider | App-password page | IMAP / SMTP |
|---|---|---|
| Gmail | [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) | `imap.gmail.com:993` / `smtp.gmail.com:465` |
| Outlook / 365 | [account.microsoft.com/security](https://account.microsoft.com/security) → App passwords | `outlook.office365.com:993` / `smtp.office365.com:587` |
| iCloud | [account.apple.com](https://account.apple.com) → Sign-In and Security → App-Specific Passwords | `imap.mail.me.com:993` / `smtp.mail.me.com:587` |
| Zoho | Zoho Mail → Settings → Mail Accounts → IMAP Access | `imap.zoho.com:993` / `smtp.zoho.com:465` |
| FastMail | [fastmail.com](https://fastmail.com) → Settings → Passwords & Security | `imap.fastmail.com:993` / `smtp.fastmail.com:465` |
| Yahoo | [login.yahoo.com/account/security](https://login.yahoo.com/account/security) → Generate app password | `imap.mail.yahoo.com:993` / `smtp.mail.yahoo.com:465` |

Self-hosted IMAP/SMTP works too — pick `Custom` and fill in your host/port.

**Mention keyword** — defaults to `@tarsee`. Change it in Settings to `@jarvis`, `@bot`, or whatever alias you want. The leading `@` is part of what you type so it's obvious what you're setting.

**Reply-all** — opt-in only. Include `[reply-all]` in the subject (or type `@tarsee reply-all` in the body) and Tarsee will reply to everyone in To + CC. Default is reply-to-sender only.

**Sender allowlist** — strongly recommended. Only emails from listed addresses get processed. Leave empty for dev mode (not safe for production mailboxes). Newsletters and auto-reply loops are always dropped regardless (RFC 3834 `Auto-Submitted` / `Precedence` / `List-Id` headers).

**Troubleshooting:**
- **"Authentication failed"** — you probably pasted your login password. Most providers require an app-specific password (usually 16 characters with hyphens). See the table above.
- **"IDLE disconnected"** — harmless. IMAP servers close IDLE after ~29 minutes; Tarsee reconnects automatically.
- **Gmail "less secure apps"** — not relevant anymore. Use an app password and keep 2FA on.
- **Outlook modern auth** — enterprise tenants may require OAuth instead of app passwords. If your admin disabled basic auth, ask them to allow it for this mailbox or use a different provider.
- **Reply arrived but wasn't threaded** — verify your mail client shows `In-Reply-To` and `References` headers. Some bespoke clients strip them.

---

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/model opus\|sonnet\|haiku` | Switch AI model |
| `/think low\|medium\|high\|max\|xhigh` | Set thinking effort for the session (xhigh on Opus 4.7) |
| `/effort` | Open the 6-notch effort slider (touch-native) |
| `/theme [name]` | List or switch themes: warm-charcoal, noir, solarized-light, jarvis-blue |
| `/auto [on\|off]` | Toggle auto model routing (haiku/sonnet/opus by complexity) |
| `/briefing [on\|off\|time]` | Morning briefing — run now, schedule daily, or set time |
| `/send telegram\|discord\|email\|web` | Forward conversation context to another channel |
| `/fork [from #N]` | Branch conversation — copy history into new session |
| `/play [name\|list\|save\|delete]` | Run or manage playbooks (multi-step AI workflows) |
| `/email [check\|summary\|draft]` | Check inbox, summarize, or draft emails (CLI helpers — see also the email channel for real-time chat) |
| `/webhook [list\|add\|remove]` | Manage webhook triggers (external events → AI) |
| `/files [search term]` | List or search workspace files |
| `/status` | Full dashboard (uptime, tokens, messages, channels) |
| `/clear` | New conversation |
| `/cron` | Manage scheduled tasks |
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
| **AI Provider** | Model selection, API config |
| **Channels** | Telegram, Discord, WhatsApp (WHAPI), Email (IMAP + SMTP with provider presets, mention keyword, reply-all marker, allowlist) |
| **Appearance** | Theme switcher (4 built-in + plugin themes) + Web Push enable/disable/test |
| **Automation** | Cron jobs, webhooks, retention settings |
| **Voice** | TTS engine (Edge TTS / ElevenLabs), STT model, voice selection. Pick `tiny.en`/`base.en`/`small.en` for English-only, or `tiny`/`base`/`small` for **multilingual** transcription with language auto-detect (needed for Tagalog, Taglish and other non-English voice notes — the `.en` checkpoints cannot transcribe them at all). |
| **Skills** | Create, edit, delete instruction packs (includes preinstalled `/ultrareview` + `/fewer-permission-prompts`) |
| **Memories** | View and manage stored memories |
| **Security** | Security audit, tool permissions, captcha solver config |
| **Canvas** | Gallery of AI-generated interactive UIs |
| **Usage** | Token usage chart, daily/weekly stats, model breakdown |
| **Token Health** | Per-conversation context-window fill, Claude transcript (.jsonl) size, and which sessions will reset on their next turn |
| **Audit Log** | All tool executions, logins, settings changes |

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SETUP_PASSWORD` | Yes | — | 4-digit PIN for the web UI |
| `ENCRYPTION_KEY` | Yes | — | AES-256 key. `openssl rand -hex 32` |
| `NODE_ENV` | Yes | — | Set to `production` |
| `CLAUDE_DEFAULT_MODEL` | No | `opus` | Default model for new sessions. Defaults to the **`opus` alias**, which Claude Code resolves to the newest Opus at request time — so a new Anthropic release is picked up with no code change. Set a pinned id (e.g. `claude-opus-5`) if you need a frozen model, or `sonnet` / `haiku` for a cheaper default. |
| `ELEVENLABS_API_KEY` | No | — | Premium TTS voices (Edge TTS is free) |
| `TARSEE_CHANNEL_IDLE_ABORT_MS` | No | `1200000` (20 min) | Abandon a turn after this long with no stream event. Keep finite. |
| `TARSEE_SESSION_JSONL_MAX_MB` | No | `8` | Transcript size cap. Past it, the next turn starts a fresh Claude session instead of resuming the bloat. |
| `TARSEE_MODEL_CONTEXT_TOKENS` | No | from model registry | Override the context window assumed by Token Health. |
| `TARSEE_SESSION_MAX_AGE_DAYS` | No | `30` | Login session lifetime. Sessions persist to SQLite and survive redeploys. |
| `TARSEE_CSRF_MAX_AGE_HOURS` | No | `24` | CSRF token lifetime. |
| `TARSEE_CHANNEL_HEALTH_MS` | No | `60000` | How often the watchdog probes for a wedged Telegram poller. |
| `TARSEE_CLEAR_SESSIONS_ON_BOOT` | No | off | Set `1` to restore the old behaviour of wiping every Claude session id on boot. |

> **Note:** Claude credentials are NOT set via env var. Run `claude login` in the web terminal after deploying. See [Authenticating with Claude](#authenticating-with-claude).

---

## Self-Hosting with Docker

```bash
docker build -t tarsee .

docker run -d \
  --name tarsee \
  -p 8080:8080 \
  -v tarsee-data:/data \
  -e NODE_ENV=production \
  -e SETUP_PASSWORD=your-password \
  -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  tarsee
```

After starting, open the web terminal and run `claude login` to authenticate.

Requirements: Docker, Claude Max subscription (Pro will work but will hit limits quickly).

---

## Security

- AES-256-GCM encrypted credential vault
- Timing-safe authentication
- CSRF protection on all mutations
- Content Security Policy headers
- Rate limiting (10 auth attempts/min/IP)
- Path traversal protection
- OAuth auto-refresh (tokens never stored in plain text)
- Session isolation per conversation
- Audit log for all tool executions and logins

---

## Contributing

Tarsee is open source. PRs welcome.

```
src/
  server.js                    # Express + HTTP server
  ai/
    providers/claude-code.js   # Agent SDK wrapper
    tarsee-mcp.js              # 20+ MCP tools
  lib/
    tools.js, commands.js      # Tool registry + chat commands
    cron.js                    # Scheduler
    canvas.js                  # Canvas/artifact server
    security-audit.js          # Security checks
  channels/
    telegram.js, discord.js    # Bot integrations
    websocket.js               # Web UI real-time + cross-device sync
  voice/
    stt-handler.js             # faster-whisper STT
    edge-tts-engine.js         # Free TTS (19 voices)
  routes/
    chat.js                    # Chat API + SSE streaming
    external-api.js            # REST API (/api/v1/)
    analytics.js               # Token usage stats
  public/                      # Web UI (vanilla HTML/CSS/JS, PWA)
```

---

## License

MIT
