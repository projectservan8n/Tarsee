#!/bin/sh
# Tarsee entrypoint — fix /data permissions then start as node user

# If /data exists (Railway volume), ensure node user can write to it
if [ -d /data ]; then
  mkdir -p /data/tarsee/data /data/tarsee/workspace/skills /data/tarsee/workspace/memory
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
# Set CLAUDE_OAUTH_CREDENTIALS in Railway with the JSON from:
#   security find-generic-password -s "Claude Code-credentials" -w
if [ -n "$CLAUDE_OAUTH_CREDENTIALS" ]; then
  mkdir -p /home/node/.claude
  echo "$CLAUDE_OAUTH_CREDENTIALS" > /home/node/.claude/.credentials.json
  chmod 600 /home/node/.claude/.credentials.json
  chown -R node:node /home/node/.claude
  echo "[entrypoint] Claude Code credentials written from env var"
fi

# Ensure claude CLI is in PATH for web terminal sessions
if [ -f /usr/local/bin/claude ]; then
  grep -q 'claude' /home/node/.bashrc 2>/dev/null || \
    echo 'export PATH="/usr/local/bin:$PATH"' >> /home/node/.bashrc
  chown node:node /home/node/.bashrc
fi

# Drop to node user and start the app
exec gosu node node src/server.js
