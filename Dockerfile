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
COPY package.json ./
RUN npm install --omit=dev

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

# Install faster-whisper (STT) + piper-tts (ultra-fast local TTS)
RUN pip3 install --no-cache-dir --break-system-packages faster-whisper piper-tts

ENV NODE_ENV=production
WORKDIR /app

# Install Claude Code CLI globally (Agent SDK spawns this binary)
RUN npm install -g @anthropic-ai/claude-code && npm cache clean --force \
  && claude --version

# Install Railway CLI
RUN curl -fsSL https://railway.com/install.sh | sh

# Copy dependencies from builder (includes node_modules + Playwright browsers)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /root/.cache/ms-playwright /home/node/.cache/ms-playwright
COPY package.json ./
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
