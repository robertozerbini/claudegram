#!/bin/sh
set -e

# The bundled `github` plugin's MCP server reads GITHUB_PERSONAL_ACCESS_TOKEN,
# but claudegram already ships a GITHUB_TOKEN secret. Bridge it so the plugin
# authenticates without a second secret. (No-op if neither is set.)
if [ -z "${GITHUB_PERSONAL_ACCESS_TOKEN:-}" ] && [ -n "${GITHUB_TOKEN:-}" ]; then
  export GITHUB_PERSONAL_ACCESS_TOKEN="$GITHUB_TOKEN"
fi

# Claude Code refuses --dangerously-skip-permissions (DANGEROUS_MODE ->
# bypassPermissions) when running as root. We start as root only to fix
# ownership of the freshly-attached /data volume, then drop to the
# unprivileged `node` user before exec'ing the app.
if [ "$(id -u)" = "0" ]; then
  # The Fly volume is root-owned on first attach. Only chown when ownership
  # is actually wrong, so we don't re-stamp large cloned repo trees on every boot.
  if [ "$(stat -c '%u' /data)" != "$(id -u node)" ]; then
    chown -R node:node /data
  fi
  exec gosu node "$@"
fi

exec "$@"
