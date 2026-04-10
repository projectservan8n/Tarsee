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

# Install Playwright + Chromium
RUN npx playwright install chromium --with-deps

# Stage 2: Runtime with Playwright (Chromium) + faster-whisper (STT)
FROM node:22-bookworm-slim

# System deps: Playwright browser deps + Python for faster-whisper + ffmpeg
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    tini \
    ca-certificates \
    gosu \
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
    # Audio conversion for STT
    ffmpeg \
    # Python for faster-whisper
    python3 \
    python3-pip \
  && rm -rf /var/lib/apt/lists/*

# Install faster-whisper (CTranslate2 backend — 4x faster than OpenAI whisper)
RUN pip3 install --no-cache-dir --break-system-packages faster-whisper

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

# Entrypoint runs as root to fix /data permissions, then drops to node user
ENTRYPOINT ["tini", "--", "/app/entrypoint.sh"]
