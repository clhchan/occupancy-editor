#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
HOST="${OCCUPANCY_EDITOR_HOST:-0.0.0.0}"
PORT="${OCCUPANCY_EDITOR_PORT:-8080}"

cd "$SCRIPT_DIR"

dev=false
install_mode=--prefer-offline
for arg in "$@"; do
  case "$arg" in
    --dev) dev=true ;;
    --offline) install_mode=--offline; export npm_config_offline=true ;;
    -h|--help)
      printf '%s\n' '用法: ./start.sh [--dev] [--offline]'
      exit 0
      ;;
    *) printf '未知参数: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' '启动地图编辑器需要 Python 3。' >&2
  exit 1
fi

if [[ "$dev" == false ]] && python3 serve.py --check-dist; then
  exec python3 serve.py --host "$HOST" --port "$PORT"
fi

nvm_dir="${NVM_DIR:-${HOME:-}/.nvm}"
if ! command -v npm >/dev/null 2>&1 && [[ -s "$nvm_dir/nvm.sh" ]]; then
  source "$nvm_dir/nvm.sh" --no-use
  nvm use --silent default || true
fi
if ! command -v npm >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) < 18 ? 1 : 0)'; then
  printf '%s\n' '源码构建和开发模式需要 Node.js 18+ 和 npm；离线运行请使用发行版中完整的 dist/。' >&2
  exit 1
fi
if [[ ! -x node_modules/.bin/tsc || ! -x node_modules/.bin/vite ]]; then
  if ! npm ci --include=dev --no-audit --no-fund "$install_mode"; then
    printf '%s\n' '安装依赖失败。请检查网络；离线时请提供当前平台的完整 npm 缓存，或使用发行版的 dist/。' >&2
    exit 1
  fi
fi

if [[ "$dev" == true ]]; then
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

npm run build
python3 serve.py --check-dist

exec python3 serve.py --host "$HOST" --port "$PORT"
