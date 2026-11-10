# Tarsee — Multi-stage Docker build
# Stage 1: Build native modules (better-sqlite3)
FROM node:22-bookworm AS builder

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# Copy the lockfile too and use `npm ci`, not `npm install`. With package.json
# alone, every rebuild re-resolves the semver ranges — @anthropic-ai/claude-agent-sdk
# floats on ^0.3.x — so an image rebuilt from an unchanged commit could ship a
# different dependency tree and break a deploy with no code change. `npm ci`
# installs exactly the locked tree, so a given commit always builds the same image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Install Playwright + Chromium (binary only — runtime libs are installed
# in the runtime stage; --with-deps here would just apt-install hundreds
# of MB into the builder image that gets discarded).
RUN npx playwright install chromium

# Stage 2: Runtime with Playwright (Chromium) + faster-whisper (STT)
FROM node:22-bookworm-slim

# System deps: Playwright browser deps + Python for faster-whisper.
# ffmpeg is installed separately as a static binary below — the apt
# `ffmpeg` package on Bookworm pulls in ~200 transitive packages
# (libllvm15, libicu72, Mesa, SDL2, PulseAudio, libpython3.11-stdlib,
# libpocketsphinx, etc.) that Tarsee never uses. Static binary saves
# ~25–28 minutes of build time and several hundred MB of image size.
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    tini \
    ca-certificates \
    curl \
    gosu \
    xz-utils \
    # Playwright/Chromium dependencies
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libxkbcommon0 \
    libatspi2.0-0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libwayland-client0 \
    # pdftotext: the text of a PDF for an AI that can't open PDFs itself
    # (src/ai/media.js), and the tarsee_pdf_read tool
    poppler-utils \
    # Python for faster-whisper
    python3 \
    python3-pip \
  && rm -rf /var/lib/apt/lists/*

# Static ffmpeg + ffprobe (johnvansickle.com builds — self-contained,
# zero transitive deps). Used by whisper STT preprocessing
# (16 kHz mono WAV resample) and the video-frames skill.
RUN curl -fsSL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz \
      -o /tmp/ffmpeg.tar.xz \
  && tar -xJf /tmp/ffmpeg.tar.xz -C /tmp \
  && mv /tmp/ffmpeg-*-amd64-static/ffmpeg /usr/local/bin/ffmpeg \
  && mv /tmp/ffmpeg-*-amd64-static/ffprobe /usr/local/bin/ffprobe \
  && chmod +x /usr/local/bin/ffmpeg /usr/local/bin/ffprobe \
  && rm -rf /tmp/ffmpeg*

# Install faster-whisper (STT) + piper-tts (ultra-fast local TTS) + ptts, the
# runtime of Phonon, the default TTS engine (pinned; an abi3 wheel for x86_64
# and aarch64 whose only dependency is numpy, about 20 MB). Phonon's model and
# voices are not baked in: they are downloaded to the data volume on first boot
# (src/voice/phonon-install.js). faster-whisper is pinned to the version
# Settings > Voice installs where there is no Docker (src/voice/stt-install.js
# FASTER_WHISPER_VERSION; test/deploy-image.test.js keeps the two the same).
RUN pip3 install --no-cache-dir --break-system-packages faster-whisper==1.2.1 piper-tts ptts==0.4.2

# The default speech-to-text model (base.en, about 148 MB) is part of the image,
# so speech-to-text works on the first try after a deploy, with no setup. It
# lives outside /data on purpose: Railway mounts the volume at /data, which
# would hide anything the image put there. Models downloaded later from
# Settings > Voice go to the volume (/data/tarsee/data/whisper-models) and
# survive redeploys. The download is the same one Settings makes (the official
# Systran/faster-whisper-base.en on Hugging Face, at a pinned revision, every
# file checked against its size and published hash). Only the two files the
# download needs are copied in, so a change elsewhere in src/ doesn't download
# the model again.
ENV TARSEE_WHISPER_BUNDLED_DIR=/opt/tarsee/whisper-models
COPY src/voice/whisper-models.js src/voice/install-common.js /opt/tarsee/stt-build/
RUN set -e; \
  cd /opt/tarsee/stt-build; \
  echo '{"type":"module"}' > package.json; \
  node whisper-models.js download base.en "$TARSEE_WHISPER_BUNDLED_DIR"; \
  cd /; \
  rm -rf /opt/tarsee/stt-build
# The check: a real WAV goes through the worker's own decode() (src/voice/stt_worker.py), as every recording does,
# and the model, loaded offline, transcribes it; a failure stops the build. A blank array would skip the decoder,
# and the decoder is what broke when PyAV dropped an option faster-whisper's own decoder still passes. The worker
# comes in after the download, so changing it doesn't download the model again.
COPY src/voice/stt_worker.py /opt/tarsee/stt-check/
RUN set -e; \
  HF_HUB_OFFLINE=1 python3 -I -c "import sys, wave, math, struct; sys.path.insert(0, '/opt/tarsee/stt-check'); from stt_worker import decode; from faster_whisper import WhisperModel; f = '/tmp/tarsee-stt-check.wav'; w = wave.open(f, 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(16000); w.writeframes(b''.join(struct.pack('<h', int(8000 * math.sin(2 * math.pi * 440 * n / 16000))) for n in range(16000))); w.close(); m = WhisperModel(sys.argv[1], device='cpu', compute_type='int8'); s, i = m.transcribe(decode(f), language='en'); list(s); assert i.duration > 0.9, i.duration; print('faster-whisper decodes a WAV and transcribes with', sys.argv[1])" "$TARSEE_WHISPER_BUNDLED_DIR/base.en"; \
  rm -rf /opt/tarsee/stt-check /tmp/tarsee-stt-check.wav

ENV NODE_ENV=production
WORKDIR /app

# Claude Code CLI, installed globally at a pinned version so every build (and
# every redeploy) gets the same one. This is the `claude` you sign in with from
# the web terminal (`claude auth login`), and the model picker reads its list of
# models. Chat turns run on the Agent SDK's own bundled copy, and the two are
# kept the same version: CLAUDE_CODE_VERSION is the `claudeCodeVersion` of the
# @anthropic-ai/claude-agent-sdk pinned in package.json, and the build stops
# below if they differ. To move it: bump the SDK, set this to its
# claudeCodeVersion and rebuild. TARSEE_AUTO_UPDATE_CLI=1 installs the latest
# on every boot instead (entrypoint.sh warns that the two then differ).
ARG CLAUDE_CODE_VERSION=2.1.319
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force \
  && claude --version

# Install Railway CLI
# Pipe to `bash`, not `sh`. /bin/sh on bookworm-slim is dash, and the
# Railway installer uses bashisms (`${var/x/y}`) that dash rejects with
# "Bad substitution" — the binary actually installs but the post-install
# step fails with exit code 2, killing the whole build.
RUN curl -fsSL https://railway.com/install.sh | bash

# Copy dependencies from builder (includes node_modules + Playwright browsers)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /root/.cache/ms-playwright /home/node/.cache/ms-playwright
COPY package.json ./

# The Terminal's claude and the Agent SDK's bundled Claude Code (the one chat
# turns run) must be the same version: stop the build if either isn't the pin.
RUN set -e; \
  cli="$(claude --version 2>/dev/null | awk 'NR==1{print $1}')"; \
  sdk="$(node -p "require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').claudeCodeVersion")"; \
  echo "Claude Code: Terminal ${cli:-missing}, Agent SDK ${sdk}, pin ${CLAUDE_CODE_VERSION}"; \
  if [ "$cli" != "$CLAUDE_CODE_VERSION" ] || [ "$sdk" != "$CLAUDE_CODE_VERSION" ]; then \
    echo "Claude Code versions differ: set CLAUDE_CODE_VERSION to the Agent SDK's claudeCodeVersion (${sdk})" >&2; \
    exit 1; \
  fi

# Codex, for the ChatGPT plan and the AIs that run on it (OpenAI, Local AI and
# some OpenRouter models). Turns run the copy @openai/codex-sdk installed; the
# Terminal's `codex` (`codex login --device-auth`) is that same copy, so a
# sign-in made there is the one turns use.
RUN chmod 755 /app/node_modules/@openai/codex/bin/codex.js \
  && ln -sf /app/node_modules/@openai/codex/bin/codex.js /usr/local/bin/codex

# Stop the build unless that codex is the version package.json pins the SDK to.
RUN set -e; \
  got="$(codex --version 2>/dev/null | awk 'NR==1{print $NF}')"; \
  want="$(node -p "require('./package.json').dependencies['@openai/codex-sdk']")"; \
  echo "Codex: ${got:-missing}, pin ${want}"; \
  if [ "$got" != "$want" ]; then \
    echo "Codex is ${got:-missing}, not the @openai/codex-sdk pin ${want}" >&2; \
    exit 1; \
  fi

# pdftotext answers (poppler-utils, installed above).
RUN pdftotext -v 2>&1 | grep -q '^pdftotext version'

COPY src ./src
COPY entrypoint.sh ./entrypoint.sh

# Bake commit hash into image for version tracking
ARG RAILWAY_GIT_COMMIT_SHA=""
ENV TARSEE_COMMIT_SHA=${RAILWAY_GIT_COMMIT_SHA}

# Fix permissions
RUN chown -R node:node /home/node/.cache \
  && chmod +x /app/entrypoint.sh

# Tell Playwright where browsers are
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright

EXPOSE 3000

# Container-level healthcheck so Docker/Compose/Swarm can detect a wedged
# process even when Railway's HTTP check is not used. /healthz is the
# fast-path endpoint that never blocks on downstream calls.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:3000/healthz',r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

# Entrypoint runs as root to fix /data permissions, then drops to node user
ENTRYPOINT ["tini", "--", "/app/entrypoint.sh"]
