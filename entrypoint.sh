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

# Write Claude Code credentials from env var (subscription auth, no API key).
# Set CLAUDE_OAUTH_CREDENTIALS in Railway with the JSON from your local machine.
# IMPORTANT: Only write if no credentials file exists on the volume yet.
# The SDK refreshes tokens automatically and writes updated tokens to disk.
# Overwriting on every boot would clobber the SDK's refreshed tokens with the
# stale env var copy, causing auth failures after the first refresh cycle.
if [ -n "$CLAUDE_OAUTH_CREDENTIALS" ]; then
  CRED_DIR="${CLAUDE_CONFIG_DIR:-/home/node/.claude}"
  CRED_FILE="$CRED_DIR/.credentials.json"
  mkdir -p "$CRED_DIR"

  if [ ! -f "$CRED_FILE" ]; then
    # First boot or volume wiped — seed from env var
    echo "$CLAUDE_OAUTH_CREDENTIALS" > "$CRED_FILE"
    chmod 600 "$CRED_FILE"
    echo "[entrypoint] Credentials seeded from env var (first boot)"
  else
    echo "[entrypoint] Credentials file exists on volume — preserving SDK-refreshed tokens"
  fi

  chown -R node:node "$CRED_DIR"

  # Also ensure ~/.claude points to the right place (some SDK paths check HOME)
  if [ "$CRED_DIR" != "/home/node/.claude" ] && [ ! -f /home/node/.claude/.credentials.json ]; then
    mkdir -p /home/node/.claude
    cp "$CRED_FILE" /home/node/.claude/.credentials.json
    chmod 600 /home/node/.claude/.credentials.json
    chown -R node:node /home/node/.claude
  fi
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

# Drop to node user and start the app
exec gosu node node src/server.js
