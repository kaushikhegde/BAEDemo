#!/bin/sh
set -e

SEED=/seed
WS="${WORKSPACE_PATH:-/workspace}"

# First-boot seeding: copy the baked workspace into an empty volume. Marker file
# keeps it idempotent and avoids a slow recursive chown on every restart.
if [ ! -f "$WS/.seeded" ]; then
  echo "[paperclip-ext] seeding workspace at $WS"
  mkdir -p "$WS"
  cp -rn "$SEED/scripts"            "$WS/scripts"            2>/dev/null || true
  cp -rn "$SEED/agent-instructions" "$WS/agent-instructions" 2>/dev/null || true
  cp -rn "$SEED/examples"           "$WS/examples"           2>/dev/null || true
  cp -rn "$SEED/projects"           "$WS/projects"           2>/dev/null || true
  cp -n  "$SEED/.mcp.json"          "$WS/.mcp.json"          2>/dev/null || true
  mkdir -p "$WS/projects" "$WS/outputs" "$WS/generated-apps" "$WS/.bootstrap"
  [ -f "$WS/generated-apps/registry.json" ] || echo '{}' > "$WS/generated-apps/registry.json"
  touch "$WS/.seeded"
  # Match the runtime UID/GID the base entrypoint will switch to.
  chown -R "${USER_UID:-1000}:${USER_GID:-1000}" "$WS"
fi

# local_trusted forces the Paperclip server to bind loopback (127.0.0.1:3100) and
# grants implicit admin to every request unconditionally. To reach it from other
# containers / published ports without switching to authenticated mode, run a
# loopback forwarder: it listens on all interfaces and proxies to 127.0.0.1, so
# inbound requests still arrive at the server over loopback.
PROXY_PORT="${PAPERCLIP_PROXY_PORT:-8300}"
SERVER_PORT="${PORT:-3100}"
echo "[paperclip-ext] starting socat forwarder 0.0.0.0:${PROXY_PORT} -> 127.0.0.1:${SERVER_PORT}"
socat TCP-LISTEN:${PROXY_PORT},fork,reuseaddr TCP:127.0.0.1:${SERVER_PORT} &

# Hand off to the base image entrypoint (UID/GID remap, then gosu node "$@").
exec docker-entrypoint.sh "$@"
