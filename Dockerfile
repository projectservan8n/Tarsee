# OpusClaw — Multi-stage Docker build
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

# Stage 2: Runtime with Python (Coqui TTS) + Playwright (Chromium)
FROM node:22-bookworm-slim

# System deps: TTS audio libs + Playwright browser deps + misc
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    tini \
    ca-certificates \
    python3 \
    python3-pip \
    python3-venv \
    libsndfile1 \
    ffmpeg \
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
  && rm -rf /var/lib/apt/lists/*

# Install Coqui TTS in a venv (avoids PEP 668 issues)
RUN python3 -m venv /opt/tts-venv \
  && /opt/tts-venv/bin/pip install --no-cache-dir TTS \
  && ln -s /opt/tts-venv/bin/python3 /usr/local/bin/python3-tts

# Make the venv python3 the default for the TTS server
ENV PATH="/opt/tts-venv/bin:${PATH}"
ENV COQUI_TOS_AGREED=1

ENV NODE_ENV=production
WORKDIR /app

# Copy dependencies from builder (includes node_modules + Playwright browsers)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /root/.cache/ms-playwright /home/node/.cache/ms-playwright
COPY package.json ./
COPY src ./src

# Fix Playwright browser permissions for node user
RUN chown -R node:node /home/node/.cache

# Create data directories with correct ownership for node user
RUN mkdir -p /data/tarsee/data /data/tarsee/workspace/skills /data/tarsee/workspace/memory \
  && chown -R node:node /data

USER node

# Tell Playwright where browsers are
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright

EXPOSE 3000

ENTRYPOINT ["tini", "--"]
CMD ["node", "src/server.js"]
