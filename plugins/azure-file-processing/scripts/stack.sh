#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${ORCH_PORT:-8080}"
ORCH_LOG=".orchestrator.log"
ORCH_PID=".orchestrator.pid"

usage() {
  cat >&2 <<'TXT'
usage: stack.sh {up|down|status|logs|workers <n>}

  up [--all-docker]   Azurite + workers in Docker, orchestrator NATIVELY on this
                      machine, so upload_file can read the paths you name. Pass
                      --all-docker to run the orchestrator in a container too —
                      then upload_file is not offered and the create_upload_url
                      + upload.mjs pair is the only way in.
TXT
  exit 1
}

# --- the native orchestrator ------------------------------------------------
# It runs on the host for one reason: a container's filesystem is the image's,
# so `upload_file({path: "/Users/you/contract.pdf"})` would resolve to nothing
# there. Azurite and the workers stay containerised — neither ever touches a
# path the caller named.

orch_is_ours() {
  curl -fsS "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"service":"azure-files"'
}

orch_running() { [ -f "$ORCH_PID" ] && kill -0 "$(cat "$ORCH_PID")" 2>/dev/null; }

orch_start() {
  # Deliberately NOT "is anything answering on :8080" — the containerised
  # orchestrator answers /health identically and would make this a no-op,
  # leaving a server that cannot see the caller's disk while the script
  # reported a native one. Only a live pid of OUR OWN counts.
  if orch_running; then echo "orchestrator already running natively (pid $(cat "$ORCH_PID"))"; return 0; fi
  : > "$ORCH_LOG"
  # Explicitly WITHOUT SAS_PUBLIC_BLOB_ENDPOINT: that variable exists to
  # rewrite a SAS minted inside Compose so the host can use it, and here the
  # minting process IS the host. The config defaults already point at
  # 127.0.0.1:10000, which is where Compose publishes Azurite.
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

wait_healthy() {
  printf 'waiting for the orchestrator'
  for _ in $(seq 1 60); do
    if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then
      echo; echo "ready:  MCP at http://127.0.0.1:$PORT/mcp"; return 0
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
      docker compose up -d --build azurite worker
      # `up azurite worker` does not stop an orchestrator container left from a
      # previous --all-docker run, and that container answers /health on the
      # same port — so the native server would either fail to bind or, worse,
      # sit behind a container that silently cannot see the caller's files.
      docker compose rm -sf orchestrator >/dev/null 2>&1 || true
      [ -d node_modules ] || npm install
      orch_start
      echo "orchestrator: native (pid $(cat "$ORCH_PID" 2>/dev/null || echo unknown)), logging to $ORCH_LOG"
    fi
    wait_healthy
    ;;
  down)
    orch_stop
    docker compose down -v
    rm -f "$ORCH_LOG"
    ;;
  logs)
    if [ -f "$ORCH_LOG" ]; then
      tail -n 50 -f "$ORCH_LOG" & TAIL_PID=$!
      trap 'kill "$TAIL_PID" 2>/dev/null || true' EXIT
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
    ;;
  *) usage ;;
esac
