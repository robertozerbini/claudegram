#!/bin/sh
set -e

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
