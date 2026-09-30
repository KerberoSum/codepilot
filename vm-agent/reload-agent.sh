#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo bash vm-agent/reload-agent.sh" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="/srv/codepilot-agent"
GOOSE_CFG="$AGENT_DIR/.config/goose"

install -m 0644 "$SCRIPT_DIR/agent_server.py" "$AGENT_DIR/agent_server.py"

# Ubuntu 24.04 may block Bubblewrap user namespaces through AppArmor.
# Give only /usr/bin/bwrap the userns permission Goose needs.
install -m 0644 "$SCRIPT_DIR/codepilot-bwrap.apparmor" /etc/apparmor.d/codepilot-bwrap
apparmor_parser -r -K /etc/apparmor.d/codepilot-bwrap

# If OAuth was completed in the normal Ubuntu desktop session, import the
# cached token into the service account without exposing its contents.
for provider in chatgpt_codex gemini_oauth; do
  src="/home/ubuntu/.config/goose/$provider/tokens.json"
  dst="$GOOSE_CFG/$provider/tokens.json"
  if [ -s "$src" ]; then
    install -d -m 0700 -o codepilot-agent -g codepilot-agent "$GOOSE_CFG/$provider"
    install -m 0600 -o codepilot-agent -g codepilot-agent "$src" "$dst"
    echo "Imported Goose OAuth token: $provider"
  fi
done

systemctl restart codepilot-agent

# Verify Bubblewrap under the service account, then verify the API.
if ! runuser -u codepilot-agent -- /usr/bin/bwrap --ro-bind / / --proc /proc --dev /dev /bin/true; then
  echo "Warning: Bubblewrap sandbox verification still failed." >&2
fi

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
