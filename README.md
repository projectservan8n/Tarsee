# Tarsee 🐒

**AI Gateway & Agent Platform** — with real tool calling, persistent memory, voice cloning, self-healing, and multi-channel integrations.

Named after the Philippine Tarsier. *Sees everything, forgets nothing.*

Built with Node.js 22+, Express 5, SQLite, and a zero-build vanilla WebUI.

---

## Features

- **Real Tool Calling** — Native Anthropic `tool_use` / OpenAI function calling. The AI can read/write files, run shell commands, fetch URLs, and manage its own memory. Up to 15 tool rounds per message.
- **Multi-Provider AI Router** — Anthropic (Claude), OpenAI, Google Gemini, OpenRouter, and any OpenAI-compatible endpoint. Streaming responses via SSE and WebSocket.
- **Persistent Memory** — Workspace files (SOUL.md, MEMORY.md, USER.md, etc.) injected into every conversation. AI remembers across restarts.
- **Self-Healing** — `/doctor` command runs 8 diagnostic checks (DB integrity, disk, memory, provider, volume, error trends). Auto-repair with `/doctor fix`.
- **Voice Mode** — Browser STT (Web Speech API) + TTS via Coqui XTTS v2 (offline voice cloning) or ElevenLabs (cloud).
- **Channel Integrations** — Discord, Telegram, Slack bots sharing the same AI router and memory.
- **Browser Automation** — Playwright (Chromium) installed for complex web tasks.
- **WebUI** — Dark theme, amber/gold accent. Chat, settings, real-time console, command palette.
- **40+ Commands** — Chat (`/help`, `/doctor`, `/restart`, `/config`, `/usage`, etc.) + console (`system.info`, `db.stats`, `doctor`, `restart`, etc.)
- **Credential Security** — AES-256-GCM encryption at rest. Full audit log. CSRF + timing-safe auth.
- **Skills System** — 49 built-in skills + custom skill creation.

---

## Quick Start (Local)

```bash
# Prerequisites: Node.js 22+
npm install
npm run dev
```

Open `http://localhost:3000`. No password required in dev mode.

---

## Deploy on Railway

1. **Create a project** on [Railway](https://railway.app) and connect this repo.
2. **Add a Volume** — mount at `/data`.
3. **Set environment variables:**

   ```
   SETUP_PASSWORD=<your-password>
   ENCRYPTION_KEY=<openssl rand -hex 32>
   NODE_ENV=production
   TARSEE_STATE_DIR=/data/tarsee
   TARSEE_WORKSPACE_DIR=/data/tarsee/workspace
   TARSEE_DATA_DIR=/data/tarsee/data
   ```

4. **Deploy** — Railway auto-detects the Dockerfile.
5. **Open the URL**, log in, configure an AI provider in Settings.

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
  tarsee
```

Or with Docker Compose:

```bash
export ENCRYPTION_KEY=$(openssl rand -hex 32)
export SETUP_PASSWORD=your-password
docker compose up -d
```

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: `3000`) |
| `SETUP_PASSWORD` | Recommended | Password for WebUI login |
| `ENCRYPTION_KEY` | **Production** | AES-256 key for stored credentials. `openssl rand -hex 32` |
| `ANTHROPIC_API_KEY` | No | Anthropic API key (or set via WebUI) |
| `OPENAI_API_KEY` | No | OpenAI API key |
| `GEMINI_API_KEY` | No | Google Gemini API key |
| `OPENROUTER_API_KEY` | No | OpenRouter API key |
| `ELEVENLABS_API_KEY` | No | ElevenLabs TTS API key |
| `TARSEE_STATE_DIR` | No | State directory (default: `~/.tarsee`, auto-detects `/data/tarsee` on Railway) |
| `TARSEE_DATA_DIR` | No | Data directory (default: `<state>/data`) |
| `TARSEE_WORKSPACE_DIR` | No | Workspace directory (default: `<state>/workspace`) |
| `TARSEE_API_TOKEN` | No | Fixed API token for WS/REST auth (auto-generated if not set) |

---

## AI Tools

The AI has access to real, server-executed tools:

| Tool | Description |
|------|-------------|
| `read_file` | Read workspace files (SOUL.md, MEMORY.md, etc.) |
| `write_file` | Update workspace files |
| `list_files` | List all workspace files with sizes |
| `remember` | Save facts to long-term memory (DB + MEMORY.md) |
| `daily_log` | Append timestamped notes to daily log |
| `exec` | Run shell commands (60s timeout, 50KB output cap) |
| `web_fetch` | Fetch URLs (GET/POST/PUT/DELETE) |
| `search_memories` | Search stored memories |

---

## Chat Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/doctor [fix]` | Run diagnostics, optionally auto-repair |
| `/restart` | Restart server |
| `/reload` | Force-reload workspace files and skills cache |
| `/config [key] [value]` | Show/get/set config |
| `/model [name]` | Show or switch AI model |
| `/provider [name]` | Show or switch provider |
| `/models` | List all providers |
| `/status` | System status |
| `/usage` | Token usage stats |
| `/whoami` | Identity and session info |
| `/context` | Show system prompt composition |
| `/debug` | Debug info |
| `/skills` | List available skills |
| `/remember [fact]` | Save to memory |
| `/forget` | List stored memories |
| `/compact` | Summarize older messages |
| `/export` | Export conversation |
| `/clear` / `/new` | New session |
| `/reset` | Fresh channel session |
| `/soul` | Show SOUL.md |
| `/identity` | Show IDENTITY.md |
| `/voices` | List TTS voices |
| `/heartbeat [run]` | Heartbeat status or manual trigger |
| `/boot` | Show boot checklist |
| `/cron [list\|add\|remove]` | Manage cron jobs |
| `/stop` | Stop current generation |

---

## Console Commands

Type in the server console (`tarsee>`):

`system.info`, `system.env`, `db.stats`, `db.vacuum`, `voice.status`, `channels.status`, `logs.recent`, `disk.usage`, `restart`, `config.list`, `config.get`, `provider.status`, `memory.stats`, `skills.list`, `workspace.files`, `sessions.list`, `cron.status`, `heartbeat.status`, `reload`, `doctor [fix]`

---

## Voice

- **Coqui XTTS v2** — Offline voice cloning from ~6s of audio. Included in Docker image (Python + TTS). Free, no API key.
- **ElevenLabs** — Cloud TTS with instant voice cloning. Set `ELEVENLABS_API_KEY` or configure in Settings > Voice.
- Auto-detected on startup (set engine to `auto` or pick explicitly).

---

## API Reference

All endpoints require auth (session cookie or Bearer token).

### Chat
- `POST /api/chat/send` — Send message, get SSE stream (includes tool_call/tool_result events)
- `GET /api/chat/conversations` — List conversations
- `GET /api/chat/conversations/:id/messages` — Get messages
- `DELETE /api/chat/conversations/:id` — Delete conversation

### WebSocket
Connect to `/ws?token=<api-token>` for real-time chat, tool events, and console streaming.

### Voice
- `POST /api/voice/tts` — Text-to-speech
- `POST /api/voice/clone` — Clone voice from audio sample
- `GET /api/voice/voices` — List voices

### Health
- `GET /healthz` — Basic health check
- `GET /healthz/deep` — Full diagnostics (returns 503 if errors)

### Settings / Admin / Debug
- `GET /api/settings` — All settings (secrets masked)
- `POST /api/settings` — Update settings
- `GET /api/admin/status` — System status
- `GET /api/admin/audit` — Credential audit log
- `POST /api/debug/run` — Execute console command

---

## Project Structure

```
src/
  server.js              # Express + HTTP server
  config/
    env.js               # Environment config
    constants.js         # Providers, limits
  ai/
    router.js            # Multi-provider AI router + tool passing
    providers/           # Anthropic, OpenAI, Gemini, OpenRouter, Custom
  lib/
    tools.js             # Tool registry + executor (read, write, exec, etc.)
    commands.js          # 30+ chat commands
    self-heal.js         # Diagnostics + auto-repair engine
    build-system-prompt.js # System prompt composer
    workspace-files.js   # Workspace file I/O with caching
    skills-engine.js     # Built-in + custom skills
    heartbeat.js         # Periodic health checks
    boot-runner.js       # Startup task runner
    cron.js              # Cron scheduler
    vault.js             # AES-256-GCM encryption
  voice/
    elevenlabs-engine.js # ElevenLabs cloud TTS
    coqui-engine.js      # Coqui XTTS v2 local TTS
    engine-registry.js   # Engine lifecycle
  channels/
    websocket.js         # WebSocket chat + console + tools
    discord.js           # Discord bot
    telegram.js          # Telegram bot
    slack.js             # Slack bot
  routes/                # REST API endpoints
  db/                    # SQLite, conversations, settings, memory
  middleware/            # Auth, CSRF, security headers, error handler
  public/               # Static WebUI (vanilla HTML/CSS/JS)
```

---

## Security

- **AES-256-GCM** credential encryption with unique IVs, PBKDF2 key derivation
- **Audit logging** for all credential operations
- **Timing-safe** auth with `crypto.timingSafeEqual`
- **Rate limiting**: 10 auth attempts/min/IP
- **CSRF**: Double-submit cookie pattern
- **Security headers**: CSP, X-Content-Type-Options, X-Frame-Options
- **Path traversal protection** on all file operations
- **Production enforcement**: Won't start without `ENCRYPTION_KEY`

---

## License

Proprietary. All rights reserved.
