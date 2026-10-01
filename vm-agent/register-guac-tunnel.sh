#!/usr/bin/env bash
set -euo pipefail

: "${CODEPILOT_WORKER_URL:?Set CODEPILOT_WORKER_URL}"
: "${VM_AGENT_REGISTRATION_SECRET:?Set VM_AGENT_REGISTRATION_SECRET}"

URL="$(journalctl -u cloudflared-guac.service --no-pager -o cat 2>/dev/null \
  | grep -o 'https://[^ ]*trycloudflare.com' \
  | tail -1 || true)"

if [ -z "$URL" ]; then
  echo "Guacamole quick-tunnel URL is not available yet." >&2
  exit 1
fi

curl -fsS --connect-timeout 5 --max-time 20 \
  -X POST "${CODEPILOT_WORKER_URL%/}/remote-desktop/register" \
  -H "Authorization: Bearer $VM_AGENT_REGISTRATION_SECRET" \
  -H "Content-Type: application/json" \
  -d "{\"url\":\"$URL\"}" >/dev/null

echo "Registered Guacamole tunnel: $URL"
