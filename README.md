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
   | `SETUP_PASSWORD` | Yes | Password for the web UI |
   | `ENCRYPTION_KEY` | Yes | `openssl rand -hex 32` |
   | `CLAUDE_OAUTH_CREDENTIALS` | Yes | Your Claude subscription credentials ([how to get](#getting-claude-credentials)) |
   | `NODE_ENV` | Yes | `production` |

3. Add a **Volume** mounted at `/data`
4. Deploy — open the URL, log in, start chatting

That's it. Claude Code auto-updates on every restart. OAuth tokens auto-refresh. Everything persists on the volume.

### Getting Claude Credentials

You need an active [Claude Max or Pro](https://claude.ai) subscription with Claude Code enabled.

**macOS:**
```bash
security find-generic-password -s "Claude Code-credentials" -w
```

**Linux:**
```bash
cat ~/.claude/.credentials.json
```

Copy the full JSON output into the `CLAUDE_OAUTH_CREDENTIALS` environment variable. Tarsee auto-refreshes the token — you only do this once.

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

### Multi-Agent Team
- **5 agents** — Orchestrator (Opus), Coder (Opus), Researcher (Sonnet), Writer (Sonnet), Quick (Haiku).
- **Persistent workspaces** — each agent has its own memory at `/data/tarsee/agents/{id}/`.
- **Nicknames** — "Hey Luis, write a script..." routes to the right agent.
- **Parallel work** — spawn multiple agents to research, code, and write simultaneously.

### Tools & Automation
- **30+ MCP tools** — send messages, schedule tasks, remember facts, search the web, manage files, spawn agents, encrypted vault, and more.
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
  +-- Agent Team (Coder, Researcher, Writer, Quick)
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
| `SETUP_PASSWORD` | Yes | — | Web UI login password |
| `ENCRYPTION_KEY` | Yes | — | AES-256 key. `openssl rand -hex 32` |
| `CLAUDE_OAUTH_CREDENTIALS` | Yes | — | Claude subscription credentials JSON |
| `NODE_ENV` | Yes | — | Set to `production` |
| `CLAUDE_DEFAULT_MODEL` | No | `claude-sonnet-4-6` | Default model for new sessions |
| `ELEVENLABS_API_KEY` | No | — | Premium TTS voices (Edge TTS is free) |

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
  -e CLAUDE_OAUTH_CREDENTIALS='{"claudeAiOauth":{...}}' \
  tarsee
```

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
    agent-registry.js          # Multi-agent system
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
