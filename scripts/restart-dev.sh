#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

LOG_FILE="${TMPDIR:-/tmp}/qizi-shell-dev.log"
ELECTRON_BIN="${ROOT}/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

pkill -f "${ROOT}/node_modules/electron/dist/Electron.app" 2>/dev/null || true
sleep 0.6

nohup npm start >>"$LOG_FILE" 2>&1 &
disown 2>/dev/null || true

for _ in 1 2 3 4 5 6 8 10; do
  sleep 0.5
  if pgrep -f "${ELECTRON_BIN} \\." >/dev/null 2>&1; then
    echo "QiziShell started (log: ${LOG_FILE})"
    exit 0
  fi
done

echo "QiziShell failed to start. Last log lines:" >&2
tail -n 20 "$LOG_FILE" >&2 || true
exit 1
