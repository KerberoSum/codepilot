#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo bash vm-agent/install-remote-desktop-proxy.sh" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

install -m 0755 "$SCRIPT_DIR/register-guac-tunnel.sh" /usr/local/bin/codepilot-register-guac

cat >/etc/systemd/system/codepilot-remote-register.service <<'UNIT'
[Unit]
Description=Register Guacamole tunnel with CodePilot Worker
After=network-online.target cloudflared-guac.service
Wants=network-online.target

[Service]
Type=oneshot
User=ubuntu
EnvironmentFile=/etc/codepilot-tunnel.env
ExecStart=/usr/local/bin/codepilot-register-guac
UNIT

cat >/etc/systemd/system/codepilot-remote-register.timer <<'UNIT'
[Unit]
Description=Refresh CodePilot Guacamole tunnel registration

[Timer]
OnBootSec=30
OnUnitActiveSec=60
AccuracySec=10
Unit=codepilot-remote-register.service

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now codepilot-remote-register.timer
systemctl start codepilot-remote-register.service

echo "CodePilot remote-desktop tunnel registration enabled."
