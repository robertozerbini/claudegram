# ---- build stage ----
FROM node:20-bookworm-slim AS build
WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Prune dev dependencies so only runtime deps are copied forward
RUN npm prune --omit=dev

# ---- runtime stage ----
FROM node:20-bookworm-slim
WORKDIR /app

# System binaries used by /extract, /vreddit, voice, etc.
#   ffmpeg/ffprobe -> Reddit & media audio/video
#   yt-dlp         -> /extract (YouTube/TikTok/Instagram)
#   python3        -> yt-dlp runtime + optional groq_transcribe.py
#   git            -> Claude agent cloning/working in repos
#   gosu           -> drop from root to the unprivileged `node` user at startup
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip git ca-certificates gosu \
    && pip3 install --break-system-packages --no-cache-dir yt-dlp \
    && rm -rf /var/lib/apt/lists/*

# Persisted state lives under $HOME:
#   $HOME/.claudegram/sessions.json  -> session history
#   $HOME (WORKSPACE_DIR default)    -> cloned projects Claude works in
# Mount a volume at /data on Fly so both survive restarts.
ENV HOME=/data
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# Ensure the home/workspace dir exists even before a volume is attached.
# `node` (uid 1000) ships with the base image; own /data so the app can write
# before any volume is mounted.
RUN mkdir -p /data && chown node:node /data

# entrypoint runs as root to chown the mounted volume, then drops to `node`.
# Claude Code rejects bypassPermissions as root, so the app must not run as root.
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "dist/index.js"]
