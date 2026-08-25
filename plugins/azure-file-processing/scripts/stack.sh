#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

usage() { echo "usage: stack.sh {up|down|status|logs|workers <n>}"; exit 1; }

case "${1:-}" in
  up)
    docker compose up -d --build
    printf 'waiting for the orchestrator'
    for _ in $(seq 1 60); do
      if curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then
        echo; echo "ready:  MCP at http://127.0.0.1:8080/mcp"; exit 0
      fi
      printf '.'; sleep 1
    done
    echo; echo "orchestrator did not become healthy; try: ./scripts/stack.sh logs" >&2
    exit 1
    ;;
  down)   docker compose down -v ;;
  logs)   docker compose logs -f --tail=100 ;;
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
    echo "--- health ---"
    curl -fsS http://127.0.0.1:8080/health || echo "orchestrator unreachable"
    ;;
  *) usage ;;
esac
