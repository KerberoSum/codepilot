#!/usr/bin/env bash
set -euo pipefail

: "${CODEPILOT_WORKER_URL:?Set CODEPILOT_WORKER_URL}"
: "${VM_AGENT_REGISTRATION_SECRET:?Set VM_AGENT_REGISTRATION_SECRET}"

LOG="${QUICK_TUNNEL_LOG:-${HOME:-/tmp}/codepilot-quick-tunnel.log}"
LOCAL_URL="${LOCAL_AGENT_URL:-http://127.0.0.1:8765}"
MAX_ATTEMPTS="${QUICK_TUNNEL_ATTEMPTS:-4}"
URL_WAIT_SECONDS="${QUICK_TUNNEL_URL_WAIT_SECONDS:-30}"
PID=""

cleanup() {
  if [ -n "${PID:-}" ] && kill -0 "$PID" 2>/dev/null; then
    kill "$PID" 2>/dev/null || true
    wait "$PID" 2>/dev/null || true
  fi
  PID=""
}

on_signal() {
  cleanup
  exit 0
}

trap cleanup EXIT
trap on_signal INT TERM

register_url() {
  local url="$1"
  local delay=1
  local attempt

  for attempt in $(seq 1 5); do
    if curl -fsS --connect-timeout 5 --max-time 20 \
      -X POST "${CODEPILOT_WORKER_URL%/}/vm-agent/register" \
      -H "Authorization: Bearer $VM_AGENT_REGISTRATION_SECRET" \
      -H "Content-Type: application/json" \
      -d "{\"url\":\"$url\"}" >/dev/null; then
      return 0
    fi

    if [ "$attempt" -lt 5 ]; then
      echo "VM tunnel registration attempt $attempt failed; retrying in ${delay}s..." >&2
      sleep "$delay"
      delay=$((delay * 2))
    fi
  done

  return 1
}

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  : >"$LOG"
  cloudflared tunnel --url "$LOCAL_URL" >"$LOG" 2>&1 &
  PID=$!
  URL=""

  for _ in $(seq 1 "$URL_WAIT_SECONDS"); do
    if ! kill -0 "$PID" 2>/dev/null; then
      break
    fi

    URL="$(grep -o 'https://[^ ]*trycloudflare.com' "$LOG" | tail -1 || true)"
    if [ -n "$URL" ]; then
      if register_url "$URL"; then
        echo "Registered VM tunnel: $URL"
        wait "$PID"
        RC=$?
        PID=""
        exit "$RC"
      fi
      echo "Could not register VM tunnel URL after retries: $URL" >&2
      break
    fi

    sleep 1
  done

  if [ -z "$URL" ]; then
    echo "Quick Tunnel URL was not found on attempt $attempt/$MAX_ATTEMPTS." >&2
  fi

  cleanup

  if [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
    delay=$((1 << (attempt - 1)))
    if [ "$delay" -gt 30 ]; then delay=30; fi
    jitter=$((RANDOM % 2))
    delay=$((delay + jitter))
    echo "Retrying Quick Tunnel in ${delay}s..." >&2
    sleep "$delay"
  fi
done

echo "Quick Tunnel failed after $MAX_ATTEMPTS attempts." >&2
tail -80 "$LOG" >&2 || true
exit 1
