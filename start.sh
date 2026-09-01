#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HOST="${OCCUPANCY_EDITOR_HOST:-0.0.0.0}"
PORT="${OCCUPANCY_EDITOR_PORT:-8080}"

cd "$SCRIPT_DIR"

if [[ "${1:-}" == "--dev" ]]; then
  if ! command -v npm >/dev/null 2>&1; then
    printf '%s\n' '开发模式需要 npm。' >&2
    exit 1
  fi

  python3 serve.py --host 127.0.0.1 --port 8081 &
  API_PID=$!

  cleanup() {
    kill "$API_PID" 2>/dev/null || true
    wait "$API_PID" 2>/dev/null || true
  }
  trap cleanup EXIT INT TERM

  npm run dev -- --host "$HOST" --port "$PORT"
  exit $?
fi

if [[ ! -d "$SCRIPT_DIR/dist" ]]; then
  if ! command -v npm >/dev/null 2>&1; then
    printf '%s\n' '未找到 dist/，首次启动需要 npm 执行构建。' >&2
    exit 1
  fi
  npm run build
fi

exec python3 serve.py --host "$HOST" --port "$PORT"
