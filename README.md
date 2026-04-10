<p align="center">
  <img src="Tarsee.png" alt="Tarsee" width="120">
</p>

<h1 align="center">Tarsee</h1>

<p align="center"><strong>Your personal Claude Code agent, running 24/7 in the cloud.</strong></p>

<p align="center">Talk to Claude from anywhere — web, Telegram, Discord, or voice. It remembers everything, runs tools, and schedules tasks. Uses your Claude Max/Pro subscription. No API keys needed.</p>

<p align="center">
  <a href="https://railway.com/deploy/O2Ux8R?referralCode=sIH3US&utm_medium=integration&utm_source=template&utm_campaign=generic"><img src="https://railway.com/button.svg" alt="Deploy on Railway"></a>
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
| **Voice** | Yes (whisper.cpp + Edge TTS) | Yes (wake word, ElevenLabs) | No | No | Telegram/WeChat voice |
| **Mobile** | PWA + iOS PIN pad | Native iOS/Android apps | Via messaging apps | Android APK | Via messaging apps |
| **Memory** | Persistent + deep search | Session-based with group isolation | SQLite + per-group files | JSONL memory store | Token-based memory |
| **Auth** | Claude subscription (OAuth) | OAuth + API keys | API keys | API keys + OAuth | API keys + OAuth |
| **LLM support** | Claude only | Claude only | Claude only | 30+ providers | Multi-provider |
| **Self-host cost** | ~$2-10/mo Railway | Higher (more resources) | Moderate | ~$10/mo (runs on anything) | Low |

### Why choose Tarsee?

- **You want simplicity** — no build step, no TypeScript, no framework. Just Node.js serving HTML.
- **You want Claude specifically** — Tarsee wraps Claude Code SDK directly. Not multi-provider, not trying to be everything.
- **You want it cheap** — runs on $16/mo Railway with 2GB RAM. No API costs if you have Claude Max/Pro.
- **You want voice + mobile** — PWA with local speech-to-text, hold-to-talk, iOS PIN pad login.
- **You want memory** — persistent memory across sessions with deep semantic search.

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
2. Set these environment variables:

   | Variable | Required | Description |
   |----------|----------|-------------|
   | `SETUP_PASSWORD` | Yes | 4-digit PIN for the web UI (mobile uses an iOS-style keypad) |
   | `ENCRYPTION_KEY` | Yes | `openssl rand -hex 32` |
   | `NODE_ENV` | Yes | `production` |

3. Add a **Volume** mounted at `/data`
4. Deploy — open the URL, log in with your password
5. Open **Terminal** (icon in topbar) and run `claude login`
6. Follow the browser auth flow — done!

That's it. Credentials are stored on the volume and auto-refresh. No env vars to manage. Claude Code CLI auto-updates on every restart.

### Authenticating with Claude

You need an active [Claude Max or Pro](https://claude.ai) subscription with Claude Code enabled.

**Run this in the Tarsee web terminal:**
```bash
claude login
```

This opens a browser auth flow. Once you authenticate, credentials are saved to the Railway volume at `/data/tarsee/.claude-code-home/.credentials.json` and persist across restarts, redeploys, and image rebuilds.

The SDK auto-refreshes tokens — you only need to log in once. If you ever get logged out, just run `claude login` again from the terminal.

> **Why not an env var?** OAuth refresh tokens are single-use. If you set credentials as an env var, every redeploy overwrites the SDK's refreshed token with the stale original, causing auth failures. Logging in directly on the server avoids this entirely.

---

## What You Get

### Chat Everywhere
- **Web UI** — Full chat with markdown rendering, code blocks, tables, file attachments, image paste, session management. PWA — save to homescreen on iOS/Android.
- **Telegram** — Text, photos, PDFs, voice messages, video notes. Group @mention support, inline buttons, forwarded message detection.
- **Discord** — Text, images, PDFs, voice messages. Always-online bot with presence status.
- **All channels share** the same AI, memory, and tools.

### Voice Mode
- **Hold-to-talk or tap-to-toggle** — full-screen conversational UI with waveform visualization.
- **Spacebar shortcut** — hold space to talk, Space+C to cancel.
- **Drag to cancel** — slide away from the orb or mic button to discard recording.
- **Local speech-to-text** — whisper.cpp (tiny.en, ~75MB). No API key. Runs on CPU.
- **Free text-to-speech** — Microsoft Edge TTS. No API key, no rate limits.
- **Smart TTS** — tables and code shown visually, spoken response is a clean conversational summary.

### Canvas / Artifacts
- **Live HTML/CSS/JS** — Ask for a dashboard, chart, calculator, or mini-app → renders as an interactive iframe right in chat.
- **Sandboxed** — Each canvas runs in a sandboxed iframe with its own URL.
- **Persistent** — Canvases are saved to the volume and accessible at `/canvas/<id>/`.

### Tools & Automation
- **15+ MCP tools** — send messages, schedule tasks, remember facts, search the web, create canvases, manage files, encrypted vault, and more.
- **Proactive briefings** — `/briefing on` schedules a daily morning summary pushed to all channels.
- **Auto model routing** — `/auto on` picks haiku/sonnet/opus based on message complexity.
- **Deep memory search** — AI reads all memories semantically when keyword search fails.
- **Cron scheduler** — recurring AI tasks or direct tool actions. One-time reminders auto-delete.
- **Web terminal** — browser-based shell access via xterm.js.
- **File manager** — browse, edit, and create workspace files from the UI.
- **REST API** — `/api/v1/message` endpoint for iOS Shortcuts, scripts, and automations.

### Search & Analytics
- **Full-text search** — FTS5 search across all conversations from the sidebar.
- **Token usage chart** — daily/weekly visual graph with model breakdown in Settings > Usage.
- **Audit log** — timestamped log of all tool executions, logins, and settings changes.
- **QR code** — scan from desktop to instantly open Tarsee on your phone.
- **Typing indicator** — see when you're typing on another device in real-time.

### Memory & Identity
- **Workspace files** — SOUL.md (personality), MEMORY.md (knowledge), USER.md (user info), IDENTITY.md.
- **Auto-memory** — Claude saves important facts as you chat. Memories persist across sessions.
- **Daily logs** — timestamped notes auto-appended to `memory/YYYY-MM-DD.md`.

---

## How It Works

```
You (web / telegram / discord / voice)
  |
  v
Tarsee Server (Railway)
  |
  +-- Claude Code Agent SDK (subscription auth, auto-updates)
  |     +-- Built-in: Read, Write, Edit, Bash, Grep, Glob
  |     +-- MCP tools: send_message, schedule_task, remember,
  |         create_canvas, web_fetch, web_search, etc.
  |
  +-- Voice: whisper.cpp STT + Edge TTS
  +-- Workspace: SOUL.md, MEMORY.md, USER.md
  +-- SQLite: conversations, settings, vault
  +-- Channels: Telegram, Discord (always online)
```

---

## Channel Setup

Configure in **Settings > Channels** after deploying. Channels auto-start when you save the token.

| Channel | How to get token | Features |
|---------|-----------------|----------|
| Telegram | [@BotFather](https://t.me/BotFather) | Text, photos, PDFs, voice, video notes, inline buttons, groups |
| Discord | [Developer Portal](https://discord.com/developers) | Text, images, PDFs, voice messages, reactions, presence |

**Discord:** Enable **Message Content Intent** in Bot settings. Invite with Send Messages, Read Messages, Add Reactions permissions.

---

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/model opus\|sonnet\|haiku` | Switch AI model |
| `/think low\|medium\|high\|max` | Set thinking effort for the session |
| `/auto [on\|off]` | Toggle auto model routing (haiku/sonnet/opus by complexity) |
| `/briefing [on\|off\|time]` | Morning briefing — run now, schedule daily, or set time |
| `/send telegram\|discord\|web` | Forward conversation context to another channel |
| `/fork [from #N]` | Branch conversation — copy history into new session |
| `/play [name\|list\|save\|delete]` | Run or manage playbooks (multi-step AI workflows) |
| `/email [check\|summary\|draft]` | Check inbox, summarize, or draft emails |
| `/webhook [list\|add\|remove]` | Manage webhook triggers (external events → AI) |
| `/files [search term]` | List or search workspace files |
| `/status` | Full dashboard (uptime, tokens, messages, channels) |
| `/clear` | New conversation |
| `/cron` | Manage scheduled tasks |
| `/remember [fact]` | Save to memory |
| `/doctor [fix]` | Diagnostics + auto-repair |
| `/export` | Export conversation |

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SETUP_PASSWORD` | Yes | — | 4-digit PIN for the web UI |
| `ENCRYPTION_KEY` | Yes | — | AES-256 key. `openssl rand -hex 32` |
| `NODE_ENV` | Yes | — | Set to `production` |
| `CLAUDE_DEFAULT_MODEL` | No | `claude-sonnet-4-6` | Default model for new sessions |
| `ELEVENLABS_API_KEY` | No | — | Premium TTS voices (Edge TTS is free) |

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

Requirements: Docker, Claude Max/Pro subscription.

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

---

## Contributing

Tarsee is open source. PRs welcome.

```
src/
  server.js                    # Express + HTTP server
  ai/
    providers/claude-code.js   # Agent SDK wrapper
    tarsee-mcp.js              # 15+ MCP tools
  lib/
    tools.js, commands.js      # Tool registry + chat commands
    cron.js                    # Scheduler
    oauth-refresh.js           # Token auto-refresh
  channels/
    telegram.js, discord.js    # Bot integrations
    websocket.js               # Web UI real-time
  voice/
    stt-handler.js             # whisper.cpp STT
    edge-tts-engine.js         # Free TTS
  public/                      # Web UI (vanilla HTML/CSS/JS, PWA)
```

---

## License

MIT
