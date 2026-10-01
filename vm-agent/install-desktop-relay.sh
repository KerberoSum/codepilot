#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo bash vm-agent/install-desktop-relay.sh" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

install -m 0644 "$SCRIPT_DIR/desktop_relay.py" /usr/local/lib/codepilot-desktop-relay.py

cat >/etc/systemd/system/codepilot-desktop-relay.service <<'UNIT'
[Unit]
Description=CodePilot native desktop screenshot/input relay
After=network.target
Wants=network.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
Environment=DISPLAY=:1
Environment=XAUTHORITY=/home/ubuntu/.Xauthority
Environment=CODEPILOT_DESKTOP_RELAY_PORT=8770
Environment=CODEPILOT_DESKTOP_MAX_WIDTH=1280
Environment=CODEPILOT_DESKTOP_JPEG_QUALITY=58
ExecStart=/usr/bin/python3 /usr/local/lib/codepilot-desktop-relay.py
Restart=always
RestartSec=3
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=read-only

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now codepilot-desktop-relay.service

for attempt in $(seq 1 10); do
  if curl -fsS --connect-timeout 1 --max-time 3 http://127.0.0.1:8770/health >/dev/null 2>&1; then
    echo "CodePilot desktop relay is healthy."
    systemctl --no-pager --full status codepilot-desktop-relay.service | sed -n '1,9p'
    exit 0
  fi
  sleep 1
done

echo "Desktop relay did not become healthy." >&2
systemctl --no-pager --full status codepilot-desktop-relay.service >&2 || true
exit 1