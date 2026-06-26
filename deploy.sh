#!/usr/bin/env bash
# Deploy Claudegram to Fly.io.
# Builds remotely (no local Docker needed). Idempotent: safe to re-run.
#
# Usage:
#   ./deploy.sh                 # interactive: prompts for any missing secret
#   TELEGRAM_BOT_TOKEN=... ALLOWED_USER_IDS=... ANTHROPIC_API_KEY=... ./deploy.sh
set -euo pipefail

APP="claudegram"
REGION="lax"
VOLUME="claudegram_data"
VOLUME_SIZE="3" # GB

cd "$(dirname "$0")"

command -v fly >/dev/null || { echo "❌ flyctl not installed. https://fly.io/docs/flyctl/install/"; exit 1; }
fly auth whoami >/dev/null 2>&1 || { echo "❌ Not logged in. Run: fly auth login"; exit 1; }

# 1. Create the app if it doesn't exist (keep our fly.toml).
if ! fly status -a "$APP" >/dev/null 2>&1; then
  echo "▶ Creating app '$APP'…"
  fly apps create "$APP"
fi

# 2. Create the persistent volume if absent.
if ! fly volumes list -a "$APP" 2>/dev/null | grep -q "$VOLUME"; then
  echo "▶ Creating ${VOLUME_SIZE}GB volume '$VOLUME' in $REGION…"
  fly volumes create "$VOLUME" --size "$VOLUME_SIZE" --region "$REGION" -a "$APP" --yes
fi

# 3. Set secrets. Use env vars if provided, otherwise prompt.
prompt_secret() {
  local name="$1" hidden="${2:-}" val="${!1:-}"
  if [ -z "$val" ]; then
    if [ -n "$hidden" ]; then read -rsp "  $name: " val; echo; else read -rp "  $name: " val; fi
  fi
  printf '%s' "$val"
}

echo "▶ Configuring secrets (leave blank to keep existing)…"
EXISTING=$(fly secrets list -a "$APP" 2>/dev/null | awk 'NR>1{print $1}')
ARGS=()
for s in TELEGRAM_BOT_TOKEN ALLOWED_USER_IDS ANTHROPIC_API_KEY DANGEROUS_MODE; do
  cur="${!s:-}"
  if [ -z "$cur" ] && grep -qx "$s" <<<"$EXISTING"; then
    echo "  $s: (already set, skipping)"
    continue
  fi
  case "$s" in
    TELEGRAM_BOT_TOKEN|ANTHROPIC_API_KEY) v=$(prompt_secret "$s" hidden) ;;
    DANGEROUS_MODE) v="${cur:-true}" ;;  # default true: no way to tap "approve" from Telegram
    *)              v=$(prompt_secret "$s") ;;
  esac
  [ -n "$v" ] && ARGS+=("$s=$v")
done
if [ ${#ARGS[@]} -gt 0 ]; then
  fly secrets set "${ARGS[@]}" -a "$APP" --stage  # stage now, apply on deploy
fi

# 4. Deploy (remote build).
echo "▶ Deploying…"
fly deploy -a "$APP" --remote-only

echo "✅ Done. Tail logs with:  fly logs -a $APP"
