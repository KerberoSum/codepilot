#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo bash vm-agent/install-watchdog.sh" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ -x /usr/local/sbin/codepilot-checkpoint ]; then
  checkpoint_id="$(/usr/local/sbin/codepilot-checkpoint create pre-watchdog-install --id-only 2>/dev/null || true)"
  [ -n "$checkpoint_id" ] && echo "Safety checkpoint: $checkpoint_id"
fi
install -m 0755 "$SCRIPT_DIR/codepilot-watchdog.sh" /usr/local/sbin/codepilot-watchdog

cat >/etc/systemd/system/codepilot-watchdog.service <<'UNIT'
[Unit]
Description=CodePilot self-healing watchdog
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/codepilot-watchdog
TimeoutStartSec=35
UNIT

cat >/etc/systemd/system/codepilot-watchdog.timer <<'UNIT'
[Unit]
Description=Run CodePilot self-healing watchdog

[Timer]
OnBootSec=40
OnUnitActiveSec=45
AccuracySec=5
Persistent=true
Unit=codepilot-watchdog.service

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now codepilot-watchdog.timer
systemctl start codepilot-watchdog.service || true

echo "CodePilot watchdog installed."
systemctl --no-pager --full status codepilot-watchdog.timer | sed -n '1,10p'
[ -r /var/lib/codepilot-watchdog/status.json ] && cat /var/lib/codepilot-watchdog/status.json || true
