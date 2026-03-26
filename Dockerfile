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

# Build whisper.cpp from source (no pre-built Linux binaries available)
RUN apt-get update && apt-get install -y --no-install-recommends git cmake \
  && git clone --depth 1 --branch v1.8.4 https://github.com/ggerganov/whisper.cpp.git /tmp/whisper \
  && cd /tmp/whisper \
  && cmake -B build -DCMAKE_BUILD_TYPE=Release \
  && cmake --build build -j$(nproc) --target whisper-cli \
  && mkdir -p /app/whisper-bin \
  && cp build/bin/whisper-cli /app/whisper-bin/ \
  && (cp build/src/libwhisper.so* /app/whisper-bin/ 2>/dev/null; true) \
  && ls -la /app/whisper-bin/ \
  && rm -rf /tmp/whisper /var/lib/apt/lists/*

# Stage 2: Runtime with Playwright (Chromium)
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
    # Audio conversion for whisper.cpp STT
    ffmpeg \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
WORKDIR /app

# Copy whisper.cpp binary from builder
COPY --from=builder /app/whisper-bin /opt/whisper

ENV PATH="/opt/whisper:${PATH}"

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
