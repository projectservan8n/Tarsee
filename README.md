# OpusClaw

AI Gateway & Chat Platform with voice mode, multi-provider support, real-time server console, and channel integrations (Discord, Telegram, Slack).

Built with Node.js 22+, Express 5, SQLite, and a zero-build vanilla WebUI.

---

## Features

- **Multi-Provider AI Router** — Anthropic (Claude), OpenAI, Google Gemini, OpenRouter, and any OpenAI-compatible endpoint. Streaming responses via SSE and WebSocket.
- **WebUI** — Clean, responsive chat interface. Conversation history, markdown rendering, code highlighting.
- **Real-Time Server Console** — Live server logs streamed to the browser via WebSocket. Run debug commands directly from the UI.
- **Voice Mode** — Browser-side STT (Web Speech API) + server-side TTS (Coqui XTTS v2 with voice cloning).
- **Channel Integrations** — Discord, Telegram, Slack bots that share the same AI router and conversation storage.
- **Credential Security** — AES-256-GCM encryption at rest for all stored API keys and tokens. Full audit log for credential access.
- **Chat Commands** — `/help`, `/model`, `/provider`, `/status`, `/clear`, and more across all channels.
- **REST + WebSocket API** — For external integrations and automation.

---

## Quick Start (Local Development)

```bash
# Prerequisites: Node.js 22+
npm install
npm run dev
```

Open `http://localhost:3000` in your browser. No password is required in development mode.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `PORT` | No | Server port (default: `3000`) |
| `SETUP_PASSWORD` | Recommended | Password for WebUI login |
| `ENCRYPTION_KEY` | **Production** | AES-256 encryption key for stored credentials. Generate with `openssl rand -hex 32`. **Required in production.** |
| `ANTHROPIC_API_KEY` | No | Anthropic API key (alternative to setting via WebUI) |
| `OPENAI_API_KEY` | No | OpenAI API key |
| `GEMINI_API_KEY` | No | Google Gemini API key |
| `OPENROUTER_API_KEY` | No | OpenRouter API key |
| `OPUSCLAW_STATE_DIR` | No | State directory (default: `~/.opusclaw`) |
| `OPUSCLAW_DATA_DIR` | No | Data directory (default: `<state>/data`) |
| `OPUSCLAW_WORKSPACE_DIR` | No | Workspace directory (default: `<state>/workspace`) |
| `OPUSCLAW_API_TOKEN` | No | Fixed API token for WS/REST auth (auto-generated if not set) |

API keys can also be configured via the WebUI Settings panel. They are encrypted at rest when `ENCRYPTION_KEY` is set.

---

## Deploy on Railway

1. **Create a new project** on [Railway](https://railway.app) and connect this repository.
2. **Add a Volume** — mount at `/data` (this stores SQLite database, settings, and workspace files).
3. **Set environment variables** in the Railway dashboard:

   ```
   SETUP_PASSWORD=<your-strong-password>
   ENCRYPTION_KEY=<openssl rand -hex 32 output>
   NODE_ENV=production
   ```

4. **Deploy** — Railway auto-detects the Dockerfile and builds.
5. **Open the public URL** and log in with your `SETUP_PASSWORD`.
6. **Configure an AI provider** in Settings (paste your API key, select model).

The `railway.toml` is pre-configured with health checks and the required volume mount.

---

## Deploy with Docker Compose (Self-Hosted)

```bash
# Generate an encryption key
export ENCRYPTION_KEY=$(openssl rand -hex 32)
export SETUP_PASSWORD=your-password-here

# Start
docker compose up -d

# View logs
docker compose logs -f
```

The `docker-compose.yml` creates a persistent volume for all data.

---

## Deploy with Docker

```bash
docker build -t opusclaw .

docker run -d \
  --name opusclaw \
  -p 3000:3000 \
  -v opusclaw-data:/data \
  -e NODE_ENV=production \
  -e SETUP_PASSWORD=your-password \
  -e ENCRYPTION_KEY=$(openssl rand -hex 32) \
  opusclaw
```

---

## Configuration via WebUI

Once running, open the WebUI and go to **Settings**:

### AI Provider
1. Select a provider (Anthropic, OpenAI, Gemini, OpenRouter, or Custom)
2. Paste your API key
3. Choose a model (e.g., `claude-sonnet-4-5-20250929`, `gpt-4o`, `gemini-2.5-flash`)
4. Click **Save Provider**

### Channel Integrations
- **Discord**: Paste your bot token. The bot starts automatically and responds in all channels it has access to.
- **Telegram**: Paste your bot token from @BotFather.
- **Slack**: Paste both the Bot Token (`xoxb-...`) and App Token (`xapp-...`). Uses Socket Mode.

### Voice Mode
- TTS uses Coqui XTTS v2 (included in Docker image)
- Upload a 6-30 second audio sample to clone a voice
- Voice mode button in the top bar activates browser-side speech recognition

---

## Server Console

Click the **Console** button in the top bar to open the real-time server console. Features:

- Live server log streaming (log, warn, error levels)
- Run debug commands: `system.info`, `db.stats`, `channels.status`, `logs.recent`, `disk.usage`, and more
- Command history (arrow keys), tab completion
- Type `help` for all available commands

---

## API Reference

All endpoints require authentication. Use either session cookies (WebUI) or Bearer token (API).

### Chat
- `POST /api/chat/send` — Send a message, get SSE stream response
- `GET /api/chat/conversations` — List conversations
- `GET /api/chat/conversations/:id/messages` — Get messages
- `DELETE /api/chat/conversations/:id` — Delete conversation

### WebSocket
Connect to `/ws?token=<api-token>` for real-time chat and console streaming.

### Voice
- `POST /api/voice/tts` — Text-to-speech
- `POST /api/voice/clone` — Clone voice from audio sample
- `GET /api/voice/voices` — List available voices

### Settings
- `GET /api/settings` — Get all settings (secrets masked)
- `POST /api/settings` — Update settings

### Admin
- `GET /api/admin/status` — System status
- `GET /api/admin/audit` — Credential access audit log
- `POST /api/admin/channels/:type/restart` — Restart a channel
- `POST /api/admin/channels/:type/stop` — Stop a channel

### Debug
- `GET /api/debug/commands` — List debug commands
- `POST /api/debug/run` — Execute a debug command

---

## Testing

```bash
npm test
```

Runs all tests using Node.js built-in test runner.

---

## Project Structure

```
src/
  server.js              # Express + HTTP server entrypoint
  config/
    env.js               # Environment config resolution
    constants.js         # Provider definitions, limits
  middleware/
    auth.js              # Session auth, timing-safe compare, rate limiting
    security.js          # CSP, CSRF, security headers
    error-handler.js     # Global error handler
  ai/
    router.js            # Multi-provider AI router (streaming)
    providers/           # Anthropic, OpenAI, Gemini, OpenRouter, Custom
  voice/
    tts-interface.js     # Abstract TTS engine interface
    coqui-engine.js      # Coqui XTTS v2 integration
    engine-registry.js   # Engine lifecycle management
  channels/
    manager.js           # Start/stop/configure all channels
    websocket.js         # WebSocket chat + console streaming
    discord.js           # Discord bot
    telegram.js          # Telegram bot
    slack.js             # Slack bot
  routes/
    chat.js              # Chat API (REST + SSE)
    settings.js          # Settings CRUD
    admin.js             # System status, audit log
    debug.js             # Debug console commands
    voice.js             # TTS, voice cloning
    files.js             # File manager API
    backup.js            # Backup/export
  db/
    sqlite.js            # SQLite init + migrations
    conversations.js     # Conversation & message CRUD
    settings.js          # Encrypted settings store
    audit.js             # Credential audit log
  lib/
    vault.js             # AES-256-GCM credential encryption
    log-capture.js       # Console log ring buffer + WS broadcast
    commands.js          # Chat command processor
    redact.js            # Secret redaction
    safe-path.js         # Path traversal protection
  public/                # Static WebUI (vanilla HTML/CSS/JS)
    index.html
    css/
    js/
test/                    # Unit tests
```

---

## Security

- **Credential encryption**: AES-256-GCM with unique IVs, PBKDF2 key derivation
- **Audit logging**: All credential reads, writes, and deletes are logged
- **Timing-safe auth**: `crypto.timingSafeEqual` for all comparisons
- **Rate limiting**: 10 auth attempts per minute per IP
- **CSRF protection**: Double-submit cookie on all state-changing endpoints
- **Security headers**: CSP, X-Content-Type-Options, X-Frame-Options, Referrer-Policy
- **Path traversal protection**: All file operations restricted to allowed roots
- **Production enforcement**: Server refuses to start without `ENCRYPTION_KEY` in production

---

## License

Proprietary. All rights reserved.
