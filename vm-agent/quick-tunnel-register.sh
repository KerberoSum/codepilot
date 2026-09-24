#!/usr/bin/env bash
set -euo pipefail

: "${CODEPILOT_WORKER_URL:?Set CODEPILOT_WORKER_URL}"
: "${VM_AGENT_REGISTRATION_SECRET:?Set VM_AGENT_REGISTRATION_SECRET}"

LOG="${QUICK_TUNNEL_LOG:-/var/log/codepilot-quick-tunnel.log}"
LOCAL_URL="${LOCAL_AGENT_URL:-http://127.0.0.1:8765}"

rm -f "$LOG"
cloudflared tunnel --url "$LOCAL_URL" >"$LOG" 2>&1 &
PID=$!

cleanup(){ kill "$PID" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

for _ in $(seq 1 60); do
  URL=$(grep -o 'https://[^ ]*trycloudflare.com' "$LOG" | tail -1 || true)
  if [ -n "$URL" ]; then
    curl -fsS -X POST "${CODEPILOT_WORKER_URL%/}/vm-agent/register"       -H "Authorization: Bearer $VM_AGENT_REGISTRATION_SECRET"       -H "Content-Type: application/json"       -d "{\"url\":\"$URL\"}" >/dev/null
    echo "Registered VM tunnel: $URL"
    wait "$PID"
    exit $?
  fi
  sleep 1
done

echo "Quick Tunnel URL was not found in time" >&2
cat "$LOG" >&2
exit 1
