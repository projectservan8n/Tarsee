#!/bin/sh
# Tarsee entrypoint — fix /data permissions then start as node user

# If /data exists (Railway volume), ensure node user can write to it
if [ -d /data ]; then
  mkdir -p /data/tarsee/data /data/tarsee/workspace/skills /data/tarsee/workspace/memory
  chown -R node:node /data/tarsee
fi

# Drop to node user and start the app
exec su-exec node node src/server.js
