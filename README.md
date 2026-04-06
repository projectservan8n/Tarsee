# Tarsee

**Headless Claude Code Agent** — runs Claude 24/7 on a server with persistent memory, channel integrations, scheduled tasks, and 42 built-in skills.

Uses your Claude Max/Pro subscription. No API keys needed.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/tarsee)

---

## What is Tarsee?

Tarsee wraps Claude Code as a headless AI agent that you can talk to from anywhere — web, Telegram, Discord, or Slack. It remembers everything, runs scripts, schedules tasks, and manages its own identity through workspace files.

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

- **Claude Code Agent** — Full Claude Opus 4.6 with 1M context, running headlessly via the Agent SDK. Subscription auth, no API key costs.
- **Persistent Memory** — SOUL.md (personality), MEMORY.md (knowledge), USER.md (user info). Claude reads these every session.
- **Channel Integrations** — Telegram, Discord, Slack, WhatsApp, Signal, LINE. Same AI, same memory, everywhere.
- **Scheduled Tasks** — Cron jobs with direct actions (instant notifications) or AI prompts (complex tasks). One-time reminders auto-delete.
- **42 Built-in Skills** — Google Workspace, GitHub, weather, web search, and more via `/skill-name` commands.
- **Image Analysis** — Send images on any channel. Claude reads them via the workspace.
- **Voice Mode** — ElevenLabs TTS in the web UI.
- **Web Terminal** — Browser-based terminal for server access.
- **Self-Healing** — `/doctor` runs diagnostics and auto-repairs.
- **Encrypted Vault** — AES-256-GCM for API keys and secrets.

---

## How It Works

```
You (web/telegram/discord/slack)
  |
  v
Tarsee Server (Railway)
  |
  ├── Claude Code Agent SDK (subscription auth)
  │     ├── Built-in tools: Read, Write, Edit, Bash, Grep, Glob
  │     └── Tarsee MCP tools: send_message, schedule_task, remember, etc.
  |
  ├── Workspace: SOUL.md, MEMORY.md, USER.md, scripts/
  ├── SQLite: conversations, settings, encrypted vault
  └── Channels: Telegram, Discord, Slack, WhatsApp, Signal, LINE
```

Every message goes through Claude Code with full tool access. Claude can read/write files, run commands, send messages to your channels, schedule reminders, and learn new skills.

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
| `CLAUDE_DEFAULT_MODEL` | No | Default: `claude-opus-4-6` |
| `ELEVENLABS_API_KEY` | No | ElevenLabs TTS (optional) |
| `TARSEE_STATE_DIR` | No | Auto-detected on Railway (`/data/tarsee`) |

---

## Deploy with Docker

```bash
docker build -t tarsee .

docker run -d \
  --name tarsee \
  -p 3000:3000 \
  -v tarsee-data:/data \
  -e NODE_ENV=production \
  -e SETUP_PASSWORD=your-password \
  -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  -e CLAUDE_OAUTH_CREDENTIALS='{"claudeAiOauth":{"accessToken":"...","refreshToken":"...","expiresAt":...}}' \
  tarsee
```

---

## Channel Setup

Configure channels in **Settings > Channels** after deploying:

| Channel | Token needed |
|---------|-------------|
| Telegram | Bot token from [@BotFather](https://t.me/BotFather) |
| Discord | Bot token from [Discord Developer Portal](https://discord.com/developers) |
| Slack | Bot token + App token (Socket Mode) |

All channels share the same AI, memory, and tools.

---

## Project Structure

```
src/
  server.js              # Express + HTTP server
  ai/
    router.js            # Claude Code router
    providers/claude-code.js  # Agent SDK wrapper + MCP tools
    tarsee-mcp.js        # Tarsee MCP server (send_message, schedule_task, etc.)
  lib/
    tools.js             # Tool registry (read, write, exec, web_fetch, etc.)
    commands.js          # Chat commands (/help, /model, /cron, etc.)
    cron.js              # Cron scheduler with direct actions
    oauth-refresh.js     # Auto-refresh subscription token
  channels/
    telegram.js, discord.js, slack.js, websocket.js
  skills/                # 42 built-in skills
  public/                # Web UI
  db/                    # SQLite (conversations, settings, vault)
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
