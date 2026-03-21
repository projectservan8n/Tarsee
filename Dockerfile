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

# Stage 2: Runtime with Python for Coqui TTS
FROM node:22-bookworm-slim

RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    tini \
    ca-certificates \
    python3 \
    python3-pip \
    python3-venv \
    libsndfile1 \
    ffmpeg \
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

# Copy dependencies from builder
COPY --from=builder /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Create data directory
RUN mkdir -p /data && chown -R node:node /data

USER node

EXPOSE 3000

ENTRYPOINT ["tini", "--"]
CMD ["node", "src/server.js"]
