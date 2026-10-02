#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo bash vm-agent/reload-agent.sh" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AGENT_DIR="/srv/codepilot-agent"
GOOSE_CFG="$AGENT_DIR/.config/goose"

checkpoint_id=""
if [ -x /usr/local/sbin/codepilot-checkpoint ]; then
  checkpoint_id="$(/usr/local/sbin/codepilot-checkpoint create pre-agent-reload --id-only 2>/dev/null || true)"
  [ -n "$checkpoint_id" ] && echo "Safety checkpoint: $checkpoint_id"
fi

install -m 0644 "$SCRIPT_DIR/agent_server.py" "$AGENT_DIR/agent_server.py"
install -m 0644 "$SCRIPT_DIR/chatgpt_desktop_bridge.py" "$AGENT_DIR/chatgpt_desktop_bridge.py"
install -m 0644 "$SCRIPT_DIR/desktop_relay.py" /usr/local/lib/codepilot-desktop-relay.py
install -m 0755 -o ubuntu -g ubuntu "$SCRIPT_DIR/chatgpt-vm-launcher.sh" /home/ubuntu/bin/chatgpt-vm
if [ -f "$SCRIPT_DIR/codepilot-watchdog.sh" ]; then
  install -m 0755 "$SCRIPT_DIR/codepilot-watchdog.sh" /usr/local/sbin/codepilot-watchdog
fi

if systemctl list-unit-files codepilot-desktop-relay.service --no-legend 2>/dev/null | grep -q '^codepilot-desktop-relay.service'; then
  systemctl restart codepilot-desktop-relay.service
fi
if systemctl list-unit-files codepilot-watchdog.timer --no-legend 2>/dev/null | grep -q '^codepilot-watchdog.timer'; then
  systemctl restart codepilot-watchdog.timer
fi

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

# Import only the OpenRouter credential from the Ubuntu desktop Goose profile.
# Keep any other service-account Goose secrets intact.
ubuntu_goose_secrets="/home/ubuntu/.config/goose/secrets.yaml"
service_goose_secrets="$GOOSE_CFG/secrets.yaml"
if [ -s "$ubuntu_goose_secrets" ]; then
  openrouter_line="$(grep -m1 '^OPENROUTER_API_KEY:' "$ubuntu_goose_secrets" || true)"
  if [ -n "$openrouter_line" ]; then
    temp_secrets="$(mktemp)"
    if [ -f "$service_goose_secrets" ]; then
      grep -v '^OPENROUTER_API_KEY:' "$service_goose_secrets" > "$temp_secrets" || true
    fi
    printf '%s\n' "$openrouter_line" >> "$temp_secrets"
    install -m 0600 -o codepilot-agent -g codepilot-agent "$temp_secrets" "$service_goose_secrets"
    rm -f "$temp_secrets"
    echo "Imported Goose secret: OPENROUTER_API_KEY"
  fi
fi

systemctl restart codepilot-agent

# Verify Bubblewrap under the service account, then verify the API.
if ! runuser -u codepilot-agent -- /usr/bin/bwrap --ro-bind / / --proc /proc --dev /dev /bin/true; then
  echo "Warning: Bubblewrap sandbox verification still failed." >&2
fi

for attempt in $(seq 1 10); do
  if curl -fsS --connect-timeout 1 --max-time 3 http://127.0.0.1:8765/healthz >/dev/null 2>&1; then
    if [ ! -x /usr/local/sbin/codepilot-checkpoint ] || /usr/local/sbin/codepilot-checkpoint health >/dev/null 2>&1; then
      echo "CodePilot VM Agent restarted successfully."
      systemctl --no-pager --full status codepilot-agent | sed -n '1,8p'
      exit 0
    fi
  fi
  sleep 1
done

echo "VM Agent did not become healthy after restart." >&2
if [ -n "$checkpoint_id" ] && [ -x /usr/local/sbin/codepilot-checkpoint ]; then
  echo "Automatic rollback to $checkpoint_id ..." >&2
  if /usr/local/sbin/codepilot-checkpoint restore "$checkpoint_id" --yes; then
    echo "Automatic rollback completed." >&2
  else
    echo "Automatic rollback needs attention; inspect checkpoint status." >&2
  fi
fi
exit 1
