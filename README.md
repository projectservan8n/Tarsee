# Tarsee

**Headless Claude Code Agent** — runs Claude 24/7 on a server with persistent memory, multi-agent teams, voice mode, and channel integrations.

Uses your Claude Max/Pro subscription. No API keys needed.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/tarsee)

---

## What is Tarsee?

Tarsee wraps Claude Code as a headless AI agent that you can talk to from anywhere — web, Telegram, Discord, or voice. It remembers everything, runs scripts, schedules tasks, and manages its own identity through workspace files.

Think of it as your personal AI that lives on a server and is always available.

---

## Deploy on Railway (Recommended)

1. Click the **Deploy on Railway** button above
2. Add a **Volume** mounted at `/data`
3. Set these environment variables:

   | Variable | Required | Description |
   |----------|----------|-------------|
   | `SETUP_PASSWORD` | Yes | Password for the web UI |
   | `ENCRYPTION_KEY` | Yes | Run `openssl rand -hex 32` to generate |
   | `CLAUDE_OAUTH_CREDENTIALS` | Yes | Your Claude subscription credentials (see below) |
   | `NODE_ENV` | Yes | Set to `production` |

4. Deploy and open the URL

### Getting Claude Credentials

On your local machine where Claude Code is installed:

```bash
# macOS
security find-generic-password -s "Claude Code-credentials" -w

# Linux
cat ~/.claude/.credentials.json
```

Copy the JSON output into `CLAUDE_OAUTH_CREDENTIALS`. Tarsee auto-refreshes the token — you only do this once.

---

## Features

### Core
- **Claude Code Agent** — Full Claude Opus 4.6 with 1M context, running headlessly via the Agent SDK. Subscription auth, no API costs.
- **Persistent Memory** — SOUL.md (personality), MEMORY.md (knowledge), USER.md (user info), IDENTITY.md, AGENTS.md. Claude reads these every session.
- **Session Persistence** — Conversations resume where you left off. 2-hour idle timeout with auto-reset.
- **Encrypted Vault** — AES-256-GCM for API keys and secrets.

### Multi-Agent Team
- **Agent Registry** — Orchestrator (Opus), Coder (Opus), Researcher (Sonnet), Writer (Sonnet), Quick (Haiku).
- **Agent Workspaces** — Each agent has its own persistent memory and workspace at `/data/tarsee/agents/{id}/`.
- **Nicknames** — Refer to agents by name in chat (e.g. "Hey Luis, write a script...").
- **Agent Dashboard** — View team status, running tasks, and manage agent definitions.

### Channels
- **Web UI** — Chat, voice mode, terminal, console, file manager, settings. PWA with iOS/Android save-to-homescreen.
- **Telegram** — Text, photos, PDFs, voice messages, video notes. Group @mention support, inline buttons, forwarded message detection.
- **Discord** — Text, images, PDFs, voice messages. Thread support, rate limit handling, presence/activity status.
- **All channels share** the same AI, memory, tools, and conversation history.

### Voice
- **Voice Mode** — Full-screen conversational UI with hold-to-talk, tap-to-toggle, and drag-to-cancel.
- **Chat Mic Button** — Hold to record, release to send. Drag left to cancel (Telegram-style). Shows timer + "slide to cancel" hint.
- **Local STT** — whisper.cpp with tiny.en model (~75MB). No API key needed. Runs on CPU.
- **Free TTS** — Microsoft Edge TTS. No API key, no rate limits, good quality.
- **ElevenLabs TTS** — Optional upgrade for premium voices with conversational emotions.

### Tools & Automation
- **Scheduled Tasks** — Cron jobs with direct actions or AI prompts. One-time reminders auto-delete.
- **Built-in Skills** — Activated via `/skill-name` commands in chat.
- **Native Image/PDF Support** — Send images or PDFs on any channel. Passed natively to Claude via the API.
- **File Manager** — Browse, view, edit, and create workspace files from the web UI.
- **Web Terminal** — Browser-based terminal with xterm.js for server access.

---

## How It Works

```
You (web / telegram / discord / voice)
  │
  ▼
Tarsee Server (Railway)
  │
  ├── Claude Code Agent SDK (subscription auth)
  │     ├── Built-in tools: Read, Write, Edit, Bash, Grep, Glob
  │     └── Tarsee MCP tools: send_message, schedule_task, remember,
  │         spawn_agent, web_fetch, web_search, etc.
  │
  ├── Agent Team
  │     ├── Orchestrator (Opus) — routes tasks
  │     ├── Coder (Opus) — code, debugging, architecture
  │     ├── Researcher (Sonnet) — web research, docs
  │     ├── Writer (Sonnet) — content, emails, docs
  │     └── Quick (Haiku) — simple lookups, formatting
  │
  ├── Workspace: SOUL.md, MEMORY.md, USER.md, IDENTITY.md
  ├── Voice: whisper.cpp STT + Edge TTS (free, no API key)
  ├── SQLite: conversations, settings, agent tasks, encrypted vault
  └── Channels: Telegram, Discord (always online)
```

---

## Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/model opus\|sonnet\|haiku` | Switch AI model |
| `/clear` | New conversation |
| `/status` | System status |
| `/soul` | Show personality |
| `/skills` | List skills |
| `/cron` | Manage scheduled tasks |
| `/remember [fact]` | Save to memory |
| `/doctor [fix]` | Diagnostics + auto-repair |
| `/export` | Export conversation |

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SETUP_PASSWORD` | Yes | Web UI login password |
| `ENCRYPTION_KEY` | Yes | AES-256 key for secrets. `openssl rand -hex 32` |
| `CLAUDE_OAUTH_CREDENTIALS` | Yes | Claude subscription credentials JSON |
| `NODE_ENV` | Yes | Set to `production` |
| `CLAUDE_DEFAULT_MODEL` | No | Default: `claude-sonnet-4-6` |
| `ELEVENLABS_API_KEY` | No | ElevenLabs TTS (optional, Edge TTS is free) |
| `TARSEE_STATE_DIR` | No | Auto-detected on Railway (`/data/tarsee`) |

---

## Deploy with Docker

```bash
docker build -t tarsee .

docker run -d \
  --name tarsee \
  -p 8080:8080 \
  -v tarsee-data:/data \
  -e NODE_ENV=production \
  -e SETUP_PASSWORD=your-password \
  -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  -e CLAUDE_OAUTH_CREDENTIALS='{"claudeAiOauth":{"accessToken":"...","refreshToken":"...","expiresAt":...}}' \
  tarsee
```

---

## Channel Setup

Configure channels in **Settings > Channels** after deploying. Channels auto-start when you save the token.

| Channel | Token needed | Voice messages |
|---------|-------------|----------------|
| Telegram | Bot token from [@BotFather](https://t.me/BotFather) | Yes (voice + video notes) |
| Discord | Bot token from [Discord Developer Portal](https://discord.com/developers) | Yes (audio attachments) |

Both channels support: text, images, PDFs, voice messages (transcribed via whisper.cpp), inline buttons (Telegram), reactions, and tool use.

**Discord setup:** Enable "Message Content Intent" in Bot settings. Invite with Send Messages, Read Messages, Add Reactions permissions.

---

## Project Structure

```
src/
  server.js                    # Express + HTTP server
  ai/
    router.js                  # Claude Code router
    providers/claude-code.js   # Agent SDK wrapper + native image support
    tarsee-mcp.js              # MCP server (30+ tools)
  lib/
    tools.js                   # Tool registry
    commands.js                # Chat commands (/help, /model, /cron, etc.)
    cron.js                    # Cron scheduler with direct actions
    oauth-refresh.js           # Auto-refresh subscription token
    agent-registry.js          # Multi-agent definitions + workspaces
    subagents.js               # Background agent spawning + persistence
  channels/
    telegram.js                # Telegram bot (text, images, voice, PDFs)
    discord.js                 # Discord bot (text, images, voice, PDFs)
    websocket.js               # Web UI real-time communication
    manager.js                 # Channel lifecycle management
  voice/
    stt-handler.js             # whisper.cpp local STT
    edge-tts-engine.js         # Microsoft Edge TTS (free)
    tts-interface.js           # TTS engine interface
  public/                      # Web UI (vanilla HTML/CSS/JS, PWA)
  db/                          # SQLite (conversations, settings, vault)
```

---

## Security

- AES-256-GCM credential encryption
- Timing-safe authentication
- CSRF protection
- Content Security Policy headers
- Rate limiting (10 auth attempts/min/IP)
- Path traversal protection
- OAuth token auto-refresh

---

## License

MIT
