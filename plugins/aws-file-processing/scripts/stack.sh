#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${ORCH_PORT:-8080}"
ORCH_LOG=".orchestrator.log"
ORCH_PID=".orchestrator.pid"

WS_PORT="${WORKSPACE_PORT:-8081}"
WS_LOG=".workspace.log"
WS_PID=".workspace.pid"

usage() {
  cat >&2 <<'TXT'
usage: stack.sh {up|down|status|logs|workers <n>}

  up [--all-docker]   LocalStack + workers in Docker, orchestrator NATIVELY on
                      this machine, so upload_file can read the paths you name.
                      Pass --all-docker to run the orchestrator in a container
                      too — then upload_file is not offered and the
                      create_upload_url + upload.mjs pair is the only way in.
                      The workspace MCP server (scyne-workspace, :8081) is
                      always started natively alongside it — it fronts the Scyne
                      stack on the HOST (orchestrator :3100, chatbot :4000),
                      which is not in Compose either way.
TXT
  exit 1
}

# --- the native orchestrator ------------------------------------------------
# It runs on the host for one reason: a container's filesystem is the image's,
# so `upload_file({path: "/Users/you/contract.pdf"})` would resolve to nothing
# there. LocalStack and the workers stay containerised — neither ever touches a
# path the caller named.

orch_is_ours() {
  curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"service":"aws-files"'
}

orch_running() { [ -f "$ORCH_PID" ] && kill -0 "$(cat "$ORCH_PID")" 2>/dev/null; }

orch_start() {
  # Deliberately NOT "is anything answering on :8080" — the containerised
  # orchestrator answers /health identically and would make this a no-op,
  # leaving a server that cannot see the caller's disk while the script
  # reported a native one. Only a live pid of OUR OWN counts.
  if orch_running; then echo "orchestrator already running natively (pid $(cat "$ORCH_PID"))"; return 0; fi
  : > "$ORCH_LOG"
  # Explicitly WITHOUT S3_PUBLIC_ENDPOINT: that variable exists so a presigned
  # URL minted INSIDE Compose is signed against the host LocalStack is published
  # on, and here the minting process IS the host. The config defaults already
  # point at 127.0.0.1:4566, which is where Compose publishes LocalStack.
  ORCH_PORT="$PORT" ./node_modules/.bin/tsx src/orchestrator/server.ts >> "$ORCH_LOG" 2>&1 &
  echo $! > "$ORCH_PID"
}

orch_stop() {
  [ -f "$ORCH_PID" ] && { kill "$(cat "$ORCH_PID")" 2>/dev/null || true; rm -f "$ORCH_PID"; }
  # tsx re-execs, so the recorded pid can be a parent whose child still holds
  # the port. Clear the listener too — but only once /health has identified it
  # as ours, so this never reaches for an unrelated process on :8080.
  if orch_is_ours; then
    for pid in $(lsof -ti "tcp:$PORT" 2>/dev/null || true); do kill "$pid" 2>/dev/null || true; done
  fi
  return 0
}


# --- the workspace MCP server ------------------------------------------------
# A front door to the Scyne stack (orchestrator :3100, chatbot :4000), so it is
# only useful when those are up. It is started anyway: /health answers without a
# credential and every tool names what it could not reach, which is a far better
# failure than a server that refused to start.

ws_is_ours() {
  curl -fsS "http://127.0.0.1:$WS_PORT/health" 2>/dev/null | grep -q '"service":"scyne-workspace"'
}

ws_running() { [ -f "$WS_PID" ] && kill -0 "$(cat "$WS_PID")" 2>/dev/null; }

ws_start() {
  if ws_running; then echo "workspace server already running (pid $(cat "$WS_PID"))"; return 0; fi
  : > "$WS_LOG"
  WORKSPACE_PORT="$WS_PORT" ./node_modules/.bin/tsx src/workspace/server.ts >> "$WS_LOG" 2>&1 &
  echo $! > "$WS_PID"
}

ws_stop() {
  [ -f "$WS_PID" ] && { kill "$(cat "$WS_PID")" 2>/dev/null || true; rm -f "$WS_PID"; }
  # Same reasoning as orch_stop: tsx re-execs, so the recorded pid can be a
  # parent whose child still holds the port. Only clear a listener /health has
  # identified as ours.
  if ws_is_ours; then
    for pid in $(lsof -ti "tcp:$WS_PORT" 2>/dev/null || true); do kill "$pid" 2>/dev/null || true; done
  fi
  return 0
}

wait_healthy() {
  printf 'waiting for the orchestrator'
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      echo
      echo "ready:  file plane      MCP at http://127.0.0.1:$PORT/mcp"
      echo "        workspace plane MCP at http://127.0.0.1:$WS_PORT/mcp"
      return 0
    fi
    printf '.'; sleep 1
  done
  echo
  echo "orchestrator did not become healthy; try: ./scripts/stack.sh logs" >&2
  return 1
}

case "${1:-}" in
  up)
    if [ "${2:-}" = "--all-docker" ]; then
      # A native orchestrator holds host :8080, and the container would fail to
      # bind it — stop ours before compose tries.
      orch_stop
      docker compose up -d --build
      echo "orchestrator: in Docker — upload_file is NOT offered on this stack"
    else
      docker compose up -d --build localstack worker
      # `up localstack worker` does not stop an orchestrator container left from
      # a previous --all-docker run, and that container answers /health on the
      # same port — so the native server would either fail to bind or, worse,
      # sit behind a container that silently cannot see the caller's files.
      docker compose rm -sf orchestrator >/dev/null 2>&1 || true
      [ -d node_modules ] || npm install
      orch_start
      echo "orchestrator: native (pid $(cat "$ORCH_PID" 2>/dev/null || echo unknown)), logging to $ORCH_LOG"
    fi
    wait_healthy
    # Native either way — even under --all-docker — because it reaches
    # 127.0.0.1:3100 and 127.0.0.1:4000, neither of which is in Compose.
    ws_start
    echo "workspace server: native (pid $(cat "$WS_PID" 2>/dev/null || echo unknown)), logging to $WS_LOG"
    ;;
  down)
    orch_stop
    ws_stop
    docker compose down -v
    rm -f "$ORCH_LOG" "$WS_LOG"
    ;;
  logs)
    TAIL_PIDS=()
    if [ -f "$ORCH_LOG" ]; then
      tail -n 50 -f "$ORCH_LOG" & TAIL_PIDS+=("$!")
    fi
    if [ -f "$WS_LOG" ]; then
      tail -n 50 -f "$WS_LOG" & TAIL_PIDS+=("$!")
    fi
    if [ "${#TAIL_PIDS[@]}" -gt 0 ]; then
      trap 'for p in "${TAIL_PIDS[@]}"; do kill "$p" 2>/dev/null || true; done' EXIT
    fi
    docker compose logs -f --tail=100
    ;;
  workers)
    # 0 before `npm run test:integration` (those tests drive one turn in-process
    # and a live worker would steal the message); 3 before `npm run test:acceptance`.
    n="${2:-2}"
    docker compose up -d --scale worker="$n" --no-recreate worker 2>/dev/null || true
    [ "$n" = "0" ] && docker compose stop worker >/dev/null 2>&1 || true
    docker compose ps worker
    ;;
  status)
    docker compose ps
    echo "--- orchestrator ---"
    if orch_is_ours; then
      echo "native or containerised, answering on :$PORT"
    else
      echo "not answering on :$PORT"
    fi
    echo "--- health ---"
    curl -fsS "http://127.0.0.1:$PORT/health" || echo "orchestrator unreachable"
    echo
    echo "--- workspace server ---"
    curl -fsS "http://127.0.0.1:$WS_PORT/health" || echo "workspace server unreachable"
    ;;
  *) usage ;;
esac
