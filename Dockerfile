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

# Download Piper TTS binary
RUN apt-get update && apt-get install -y --no-install-recommends wget \
  && wget -q https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_linux_x86_64.tar.gz \
  && tar -xzf piper_linux_x86_64.tar.gz \
  && rm piper_linux_x86_64.tar.gz \
  && rm -rf /var/lib/apt/lists/*

# Stage 2: Runtime with Piper TTS + Playwright (Chromium)
FROM node:22-bookworm-slim

# System deps: Playwright browser deps + gosu for entrypoint
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
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# Copy Piper binary + libs from builder
COPY --from=builder /app/piper /opt/piper
ENV PATH="/opt/piper:${PATH}"

# Copy dependencies from builder (includes node_modules + Playwright browsers)
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /root/.cache/ms-playwright /home/node/.cache/ms-playwright
COPY package.json ./
COPY src ./src
COPY entrypoint.sh ./entrypoint.sh

# Fix permissions
RUN chown -R node:node /home/node/.cache \
  && chmod +x /app/entrypoint.sh

# Tell Playwright where browsers are
ENV PLAYWRIGHT_BROWSERS_PATH=/home/node/.cache/ms-playwright

EXPOSE 3000

# Entrypoint runs as root to fix /data permissions, then drops to node user
ENTRYPOINT ["tini", "--", "/app/entrypoint.sh"]
