#!/usr/bin/env bash
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: sudo bash vm-agent/install-checkpoint.sh" >&2; exit 1; }
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
install -m 0755 "$SCRIPT_DIR/codepilot-checkpoint.sh" /usr/local/sbin/codepilot-checkpoint
cat >/etc/systemd/system/codepilot-checkpoint.service <<'UNIT'
[Unit]
Description=Create a safe CodePilot configuration checkpoint
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/codepilot-checkpoint create scheduled
Nice=10
IOSchedulingClass=best-effort
IOSchedulingPriority=7
UNIT

cat >/etc/systemd/system/codepilot-checkpoint.timer <<'UNIT'
[Unit]
Description=Create rolling CodePilot checkpoints

[Timer]
OnBootSec=10min
OnUnitActiveSec=12h
AccuracySec=10min
Persistent=true
Unit=codepilot-checkpoint.service

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
/usr/local/sbin/codepilot-checkpoint create install-baseline
systemctl enable --now codepilot-checkpoint.timer
echo "CodePilot Safety Net installed."
systemctl --no-pager --full status codepilot-checkpoint.timer | sed -n '1,10p'
/usr/local/sbin/codepilot-checkpoint list | head -12
