# Tarsee

**Your personal Claude Code agent, running 24/7 in the cloud.**

Talk to Claude from anywhere — web, Telegram, Discord, or voice. It remembers everything, runs tools, schedules tasks, and manages a team of AI agents. Uses your Claude Max/Pro subscription. No API keys needed.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/tarsee)

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

### Tools & Automation
- **12+ MCP tools** — send messages, schedule tasks, remember facts, search the web, manage files, encrypted vault, and more.
- **Cron scheduler** — recurring AI tasks or direct tool actions. One-time reminders auto-delete.
- **Web terminal** — browser-based shell access via xterm.js.
- **File manager** — browse, edit, and create workspace files from the UI.

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
  |         spawn_agent, web_fetch, web_search, etc.
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
| `/fork [from #N]` | Branch conversation — copy history into new session |
| `/clear` | New conversation |
| `/status` | System status |
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
    tarsee-mcp.js              # 30+ MCP tools
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
