#!/bin/sh
# Tarsee entrypoint — fix /data permissions then start as node user

# If /data exists (Railway volume), ensure node user can write to it
if [ -d /data ]; then
  mkdir -p /data/tarsee/data /data/tarsee/workspace/skills /data/tarsee/workspace/memory
  # Seed default workspace files if they don't exist
  for f in CLAUDE.md SOUL.md MEMORY.md IDENTITY.md USER.md TOOLS.md AGENTS.md; do
    if [ ! -f "/data/tarsee/workspace/$f" ] && [ -f "/app/src/workspace-defaults/$f" ]; then
      cp "/app/src/workspace-defaults/$f" "/data/tarsee/workspace/$f"
    fi
  done
  chown -R node:node /data/tarsee
fi

# Persist Claude Code credentials on Railway volume across restarts.
# After `claude login` in the web terminal, credentials are stored in
# /home/node/.claude → symlinked to /data/tarsee/.claude-code-home.
if [ -d /data ]; then
  mkdir -p /data/tarsee/.claude-code-home
  chown node:node /data/tarsee/.claude-code-home
  # Remove any existing directory (from base image) and symlink to volume
  rm -rf /home/node/.claude
  ln -sf /data/tarsee/.claude-code-home /home/node/.claude
fi

# Claude Code credentials live on the volume at /data/tarsee/.claude-code-home/.credentials.json
# (symlinked to ~/.claude). The SDK auto-refreshes tokens and writes them back to disk.
# To authenticate: open the web terminal and run `claude login`.
# No env var needed — credentials persist on the volume across restarts/redeploys.
CRED_FILE="/data/tarsee/.claude-code-home/.credentials.json"
if [ -f "$CRED_FILE" ]; then
  echo "[entrypoint] Claude credentials found on volume"
else
  echo "[entrypoint] No credentials found — open the web terminal and run: claude login"
fi

# Ensure claude CLI is in PATH for web terminal sessions
if [ -f /usr/local/bin/claude ]; then
  grep -q 'claude' /home/node/.bashrc 2>/dev/null || \
    echo 'export PATH="/usr/local/bin:$PATH"' >> /home/node/.bashrc
  chown node:node /home/node/.bashrc
fi

# Auto-update Claude Code CLI on boot (non-blocking, 60s timeout)
CURRENT_VERSION=$(claude --version 2>/dev/null | head -1 || echo "unknown")
echo "[entrypoint] Claude Code: $CURRENT_VERSION — checking for updates..."
npm install -g @anthropic-ai/claude-code@latest --prefer-online 2>/dev/null &
UPDATE_PID=$!
# Wait up to 60s for update, then move on
( sleep 60 && kill $UPDATE_PID 2>/dev/null ) &
TIMER_PID=$!
wait $UPDATE_PID 2>/dev/null
kill $TIMER_PID 2>/dev/null
NEW_VERSION=$(claude --version 2>/dev/null | head -1 || echo "unknown")
if [ "$CURRENT_VERSION" != "$NEW_VERSION" ]; then
  echo "[entrypoint] Claude Code updated: $CURRENT_VERSION → $NEW_VERSION"
else
  echo "[entrypoint] Claude Code: $NEW_VERSION (latest)"
fi

# Auto-generate ENCRYPTION_KEY if not set (persist on volume)
if [ -z "$ENCRYPTION_KEY" ] && [ -d /data ]; then
  KEY_FILE="/data/tarsee/.encryption-key"
  if [ -f "$KEY_FILE" ]; then
    export ENCRYPTION_KEY=$(cat "$KEY_FILE")
    echo "[entrypoint] Loaded ENCRYPTION_KEY from volume"
  else
    export ENCRYPTION_KEY=$(openssl rand -hex 32)
    echo "$ENCRYPTION_KEY" > "$KEY_FILE"
    chmod 600 "$KEY_FILE"
    chown node:node "$KEY_FILE"
    echo "[entrypoint] Generated ENCRYPTION_KEY (saved to volume)"
  fi
fi

# Drop to node user and start the app
exec gosu node node src/server.js
