#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo bash vm-agent/reload-agent.sh" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
install -m 0644 "$SCRIPT_DIR/agent_server.py" /srv/codepilot-agent/agent_server.py
systemctl restart codepilot-agent

for attempt in $(seq 1 10); do
  if curl -fsS --connect-timeout 2 --max-time 4 http://127.0.0.1:8765/health >/dev/null 2>&1; then
    echo "CodePilot VM Agent restarted successfully."
    systemctl --no-pager --full status codepilot-agent | sed -n '1,8p'
    exit 0
  fi
  sleep 1
done

echo "VM Agent did not become healthy after restart." >&2
exit 1
