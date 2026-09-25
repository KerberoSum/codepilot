#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo bash vm-agent/upgrade-v3.sh" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="/srv/codepilot-agent"
WORKSPACE="/srv/codepilot-workspace"

if ! id codepilot-agent >/dev/null 2>&1; then
  echo "codepilot-agent user is missing; complete the v2 service-user setup first." >&2
  exit 1
fi

install -d -o codepilot-agent -g codepilot-agent "$AGENT_DIR" "$WORKSPACE"
install -m 0644 "$SCRIPT_DIR/agent_server.py" "$AGENT_DIR/agent_server.py"
install -m 0644 "$SCRIPT_DIR/codepilot-agent.service" /etc/systemd/system/codepilot-agent.service
install -m 0755 "$SCRIPT_DIR/quick-tunnel-register.sh" /usr/local/bin/codepilot-quick-tunnel

systemctl daemon-reload
systemctl restart codepilot-agent

if systemctl list-unit-files codepilot-tunnel.service >/dev/null 2>&1; then
  systemctl restart codepilot-tunnel || true
fi

if [ "${1:-}" != "--skip-browser" ]; then
  bash "$SCRIPT_DIR/install-web-tools.sh"
fi

echo
echo "CodePilot Remote Worker v3 upgrade complete."
echo "Agent:"
systemctl --no-pager --full status codepilot-agent | sed -n '1,8p'
echo
echo "Health:"

HEALTH_URL="http://127.0.0.1:8765/health"
HEALTH_OK=0
for attempt in $(seq 1 10); do
  if HEALTH_JSON="$(curl -fsS --connect-timeout 2 --max-time 5 "$HEALTH_URL" 2>/dev/null)"; then
    echo "$HEALTH_JSON"
    HEALTH_OK=1
    break
  fi
  if [ "$attempt" -lt 10 ]; then
    echo "Waiting for Remote Worker API... ($attempt/10)"
    sleep 2
  fi
done

if [ "$HEALTH_OK" -ne 1 ]; then
  echo "Remote Worker API did not become healthy after 10 attempts." >&2
  curl -fsS --connect-timeout 2 --max-time 5 "$HEALTH_URL" >/dev/null
  exit 1
fi

echo
