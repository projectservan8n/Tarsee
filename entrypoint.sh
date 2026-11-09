#!/bin/sh
# Tarsee entrypoint: fix /data permissions, set up each AI's sign-in folder, then start as the node user.
#
# The functions come first and the start-up (main) runs last, only when this file is run (tini runs
# /app/entrypoint.sh). Sourcing it (`. entrypoint.sh`, as test/deploy-image.test.js does) only defines them.

# The AI providers' sign-in folders, one per provider and engine, on the volume and owner-only (mode 700), so one
# provider's sign-in can never load in a turn meant for another (src/ai/engine-env.js homeFor, rule R1):
#   .claude-code-home   the Claude plan (`claude auth login` in the Terminal); <user home>/.claude links here
#   .claude-home-<id>   Anthropic, DeepSeek and OpenRouter on Claude Code (their keys come from Settings or Railway)
#   .codex-home         the ChatGPT plan (Codex's own sign-in); <user home>/.codex links here, and CODEX_HOME
#   .codex-home-keys    every Codex turn on an API key (OpenAI, OpenRouter, DeepSeek, Local AI); never a sign-in
# Each Codex home gets a config.toml with Tarsee's settings (seed_codex_config). No key or token is written to any
# file here: keys stay in Settings (encrypted) or Railway variables, and only a turn's own process sees one.
# usage: setup_provider_homes <state dir> <user home> [owner, e.g. node:node; empty leaves ownership as it is]
PROVIDER_HOMES=".claude-code-home .claude-home-anthropic .claude-home-deepseek .claude-home-openrouter .codex-home .codex-home-keys"

setup_provider_homes() {
  _state=$1
  _home=$2
  _owner=$3
  if [ -z "$_state" ] || [ -z "$_home" ]; then
    echo "[entrypoint] setup_provider_homes needs the state folder and the user's home folder" >&2
    return 2
  fi
  for _d in $PROVIDER_HOMES; do
    mkdir -p "$_state/$_d" || return 1
    chmod 700 "$_state/$_d"
  done
  seed_codex_config "$_state/.codex-home/config.toml" chatgpt || return 1
  seed_codex_config "$_state/.codex-home-keys/config.toml" api || return 1
  # The Terminal's `claude` and `codex` keep their sign-in in these default folders: point them at the plan homes
  # on the volume, so a sign-in made there survives a redeploy and is the one turns use.
  rm -rf "$_home/.claude" "$_home/.codex"
  ln -s "$_state/.claude-code-home" "$_home/.claude"
  ln -s "$_state/.codex-home" "$_home/.codex"
  if [ -n "$_owner" ]; then
    for _d in $PROVIDER_HOMES; do
      chown -R "$_owner" "$_state/$_d"
    done
  fi
}

# carry_plan_home <volume> <state dir>: earlier versions kept the Claude plan's sign-in in
# <volume>/tarsee/.claude-code-home whatever TARSEE_STATE_DIR said; this one keeps it in <state dir>/.claude-code-home
# (where ~/.claude now points). When those are two folders, move the old one's sign-in and chat history into the new
# one, so an install with its own TARSEE_STATE_DIR stays signed in and its chats still resume. A plan home that is
# already signed in is left alone, and nothing in it is replaced: a file both have stays in the old folder. A state
# folder off the volume gets nothing (the sign-in would be lost on the next redeploy), only a line saying where the
# sign-in is. Once moved there is nothing left to move, so later boots do nothing.
carry_plan_home() {
  _vol=$1
  _state=$2
  _old="$_vol/tarsee/.claude-code-home"
  _new="$_state/.claude-code-home"
  [ -f "$_old/.credentials.json" ] || return 0
  [ "$_old" -ef "$_new" ] && return 0
  [ -f "$_new/.credentials.json" ] && return 0
  mkdir -p "$_new" || return 1
  _vol_real=$(cd "$_vol" && pwd -P) || return 1
  _state_real=$(cd "$_state" && pwd -P) || return 1
  case "$_state_real/" in
    "$_vol_real"/*) ;;
    *)
      echo "[entrypoint] Claude Code: the Claude plan sign-in is in $_old. TARSEE_STATE_DIR ($_state) is not on the volume, so it was not moved there; set TARSEE_STATE_DIR to a folder in $_vol to use it."
      return 0
      ;;
  esac
  move_missing "$_old" "$_new"
  if [ ! -f "$_new/.credentials.json" ]; then
    echo "[entrypoint] warning: could not move the Claude plan sign-in from $_old to $_new"
    return 1
  fi
  echo "[entrypoint] Claude Code: moved the Claude plan sign-in and chat history from $_old to $_new"
  if [ -e "$_old" ]; then
    echo "[entrypoint] Claude Code: files $_new already had are kept, and the old copies of them stay in $_old"
  fi
}

# move_missing <from> <to>: move into <to> everything in <from> that <to> doesn't have, going into the folders both have.
# What both have stays in <from>, and a folder left empty is removed. A subshell, so each level keeps its own names.
move_missing() (
  for _e in "$1"/* "$1"/.[!.]* "$1"/..?*; do
    [ -e "$_e" ] || [ -L "$_e" ] || continue
    _t="$2/${_e##*/}"
    if [ ! -e "$_t" ] && [ ! -L "$_t" ]; then
      mv "$_e" "$_t"
    elif [ -d "$_e" ] && [ ! -L "$_e" ] && [ -d "$_t" ] && [ ! -L "$_t" ]; then
      move_missing "$_e" "$_t"
    fi
  done
  rmdir "$1" 2>/dev/null
  return 0
)

# seed_codex_config <config.toml> <chatgpt|api>: the settings Tarsee wants in a Codex home's config.toml, and nothing
# secret: keep the sign-in in this folder's auth.json (never an OS keyring), don't check for updates, and take only
# this home's kind of sign-in (the plan home a ChatGPT sign-in, the keys home an API key). What Codex wrote there
# itself (a model chosen in the Terminal, project trust) stays. A setting already at the top level is set to
# Tarsee's value where it is; a missing one goes at the top, because a line added at the end could land inside a
# [table]. Codex's guard (src/ai/engine-env.js CODEX_CONFIG_ALLOWED) allows exactly these.
seed_codex_config() {
  _file=$1
  _method=$2
  if [ ! -f "$_file" ]; then
    echo "# Set by Tarsee on every boot. Never put a key or token in this file." > "$_file" || return 1
  fi
  _tmp="$_file.tarsee-tmp"
  awk -v method="$_method" '
    BEGIN {
      n = split("cli_auth_credentials_store check_for_update_on_startup forced_login_method", order, " ")
      want["cli_auth_credentials_store"] = "cli_auth_credentials_store = \"file\""
      want["check_for_update_on_startup"] = "check_for_update_on_startup = false"
      want["forced_login_method"] = "forced_login_method = \"" method "\""
    }
    { line[NR] = $0 }
    /^[ \t]*\[/ { table = 1 }
    !table {
      for (i = 1; i <= n; i++) {
        k = order[i]
        if ($0 ~ ("^[ \t]*[\"\047]?" k "[\"\047]?[ \t]*=")) { line[NR] = want[k]; seen[k] = 1 }
      }
    }
    END {
      top = 0
      while (top < NR && line[top + 1] ~ /^[ \t]*#/) top++
      for (i = 1; i <= top; i++) print line[i]
      for (i = 1; i <= n; i++) if (!(order[i] in seen)) print want[order[i]]
      for (i = top + 1; i <= NR; i++) print line[i]
    }
  ' "$_file" > "$_tmp" || { rm -f "$_tmp"; return 1; }
  if cmp -s "$_tmp" "$_file"; then rm -f "$_tmp"; else mv "$_tmp" "$_file" || return 1; fi
  chmod 600 "$_file"
}

# report_sign_ins <state dir>: one line per engine on whether its plan sign-in is there, and a warning when an API-key
# folder holds a sign-in (Tarsee refuses turns there until it's removed). API keys are reported by Settings > AI,
# which knows where each one comes from. Never prints a token.
report_sign_ins() {
  _state=$1
  if [ -f "$_state/.claude-code-home/.credentials.json" ]; then
    echo "[entrypoint] Claude Code: Claude plan signed in (on the volume)"
  elif [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    echo "[entrypoint] Claude Code: Claude plan signs in with the CLAUDE_CODE_OAUTH_TOKEN variable"
  elif [ -n "${CLAUDE_CODE_OAUTH_REFRESH_TOKEN:-}" ]; then
    echo "[entrypoint] Claude Code: Claude plan signs in with the CLAUDE_CODE_OAUTH_REFRESH_TOKEN variable"
  else
    echo "[entrypoint] Claude Code: no Claude plan sign-in (to use the Claude plan, run claude auth login in Tarsee's Terminal)"
  fi
  if [ -f "$_state/.codex-home/auth.json" ]; then
    echo "[entrypoint] Codex: ChatGPT plan signed in (on the volume)"
  else
    echo "[entrypoint] Codex: no ChatGPT plan sign-in (to use the ChatGPT plan, sign in from Settings > AI, or run codex login --device-auth in Tarsee's Terminal)"
  fi
  for _d in "$_state"/.claude-home-*; do
    if [ -f "$_d/.credentials.json" ]; then
      echo "[entrypoint] warning: $_d holds a Claude plan sign-in (.credentials.json). Tarsee runs no turns there until it is removed."
    fi
  done
  if [ -f "$_state/.codex-home-keys/auth.json" ]; then
    echo "[entrypoint] warning: $_state/.codex-home-keys holds a sign-in (auth.json). Tarsee runs no Codex turns on an API key until it is removed."
  fi
}

main() {
  STATE_DIR="${TARSEE_STATE_DIR:-/data/tarsee}"

  # If /data exists (Railway volume), ensure node user can write to it
  if [ -d /data ]; then
    # The server (src/config/env.js) uses this same folder, so the sign-in folders, CODEX_HOME and the workspace set up
    # here are the ones it reads. Without a volume it keeps its own ~/.tarsee. gosu keeps the environment.
    export TARSEE_STATE_DIR="$STATE_DIR"
    mkdir -p /data/tarsee/data /data/tarsee/workspace/skills /data/tarsee/workspace/memory "$STATE_DIR"
    # Seed default workspace files if they don't exist
    for f in CLAUDE.md SOUL.md MEMORY.md IDENTITY.md USER.md TOOLS.md AGENTS.md; do
      if [ ! -f "/data/tarsee/workspace/$f" ] && [ -f "/app/src/workspace-defaults/$f" ]; then
        cp "/app/src/workspace-defaults/$f" "/data/tarsee/workspace/$f"
      fi
    done
    chown -R node:node /data/tarsee
    chown node:node "$STATE_DIR"

    # Each AI's sign-in folder on the volume, so sign-ins persist across restarts and redeploys. An install whose
    # TARSEE_STATE_DIR isn't /data/tarsee first gets its Claude plan sign-in from where earlier versions kept it.
    carry_plan_home /data "$STATE_DIR"
    setup_provider_homes "$STATE_DIR" /home/node node:node
    report_sign_ins "$STATE_DIR"
  fi

  # Ensure claude CLI is in PATH for web terminal sessions
  if [ -f /usr/local/bin/claude ]; then
    grep -q 'claude' /home/node/.bashrc 2>/dev/null || \
      echo 'export PATH="/usr/local/bin:$PATH"' >> /home/node/.bashrc
    chown node:node /home/node/.bashrc
  fi

  # The two engines. Chat turns run the Agent SDK's bundled Claude Code (the image pins the Terminal's to the same
  # version) and the Codex that @openai/codex-sdk installed (the Terminal's `codex` is that same copy).
  ENGINE_VERSION=$(node -p "require('/app/node_modules/@anthropic-ai/claude-agent-sdk/package.json').claudeCodeVersion" 2>/dev/null || echo "unknown")
  CODEX_VERSION=$(codex --version 2>/dev/null | head -1)
  echo "[entrypoint] Codex: ${CODEX_VERSION:-not found}"

  # Optional Claude Code CLI auto-update on boot.
  # Set TARSEE_AUTO_UPDATE_CLI=1 to opt in. Off by default so boots are
  # deterministic + fast (~60s saved): the image installs the version pinned in
  # the Dockerfile (CLAUDE_CODE_VERSION), and a rebuild keeps it. An update made
  # here lives in the container only, so it is redone on every boot.
  CURRENT_VERSION=$(claude --version 2>/dev/null | head -1 || echo "unknown")
  if [ "${TARSEE_AUTO_UPDATE_CLI:-0}" = "1" ]; then
    echo "[entrypoint] Claude Code: $CURRENT_VERSION — checking for updates..."
    npm install -g @anthropic-ai/claude-code@latest --prefer-online 2>/dev/null &
    UPDATE_PID=$!
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
    if [ "${NEW_VERSION%% *}" != "$ENGINE_VERSION" ]; then
      echo "[entrypoint] warning: the Terminal's Claude Code (${NEW_VERSION%% *}) is not the version chat turns run ($ENGINE_VERSION, the Agent SDK's own)"
    fi
  else
    echo "[entrypoint] Claude Code: $CURRENT_VERSION, chat turns $ENGINE_VERSION (auto-update off; TARSEE_AUTO_UPDATE_CLI=1 to enable)"
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

  # The ChatGPT plan's folder for everything the server starts, the Terminal's `codex` included (each chat turn
  # still sets its own; src/ai/engine-env.js). gosu keeps the environment.
  if [ -d "$STATE_DIR/.codex-home" ]; then
    export CODEX_HOME="$STATE_DIR/.codex-home"
  fi

  # Drop to node user and start the app
  exec gosu node node src/server.js
}

# Run only when executed, not when sourced.
case "${0##*/}" in
  entrypoint.sh) main "$@" ;;
esac
