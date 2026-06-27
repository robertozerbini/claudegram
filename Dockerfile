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
#   python3-venv   -> lets the agent create per-project venvs (`python3 -m venv`)
RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg python3 python3-pip python3-venv git ca-certificates gosu \
    && pip3 install --break-system-packages --no-cache-dir yt-dlp \
    && rm -rf /var/lib/apt/lists/*

# Persisted state lives under $HOME:
#   $HOME/.claudegram/sessions.json  -> session history
#   $HOME (WORKSPACE_DIR default)    -> cloned projects Claude works in
# Mount a volume at /data on Fly so both survive restarts.
ENV HOME=/data
ENV NODE_ENV=production

# Let the unprivileged `node` agent install libraries when developing apps.
# It can't write to root-owned /usr/local, so point npm's global prefix and
# pip's targets at the writable, volume-persisted $HOME (/data). Installs then
# survive restarts. PIP_BREAK_SYSTEM_PACKAGES lifts the PEP 668 block so
# `pip3 install --user <pkg>` and `python3 -m venv` both work; we deliberately
# do NOT set PIP_USER=1 globally, which would break pip inside venvs.
ENV NPM_CONFIG_PREFIX=/data/.npm-global
ENV PATH=/data/.npm-global/bin:$PATH
ENV PIP_BREAK_SYSTEM_PACKAGES=1

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
