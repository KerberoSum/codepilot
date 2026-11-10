#!/usr/bin/env bash
# Deploy Unicode/Traditional Chinese input support for CodePilot Remote Screen.
# Run from a real VM SSH terminal: sudo bash /home/ubuntu/codepilot/vm-agent/deploy-remote-unicode-input.sh
set -Eeuo pipefail
umask 077
[ "$(id -u)" = "0" ] || { echo "Run this script with sudo from SSH."; exit 1; }
src="/home/ubuntu/codepilot/vm-agent/desktop_relay.py"
dest="/usr/local/lib/codepilot-desktop-relay.py"
tests="/home/ubuntu/codepilot/vm-agent"
service="codepilot-desktop-relay.service"
backup="/var/backups/codepilot-remote-unicode-$(date -u +%Y%m%dT%H%M%SZ)"
[ -f "$src" ] && [ -f "$dest" ] || { echo "ERROR: Unicode source or running relay missing"; exit 1; }
systemctl is-active --quiet "$service" || { echo "ERROR: Desktop relay service is not active"; exit 1; }
curl -fsS --max-time 6 -o /dev/null http://127.0.0.1:8770/health
python3 -m py_compile "$src"
python3 -m unittest discover -s "$tests" -p 'test_unicode_desktop_input.py' -q
install -d -m 0700 "$backup"
cp -p "$dest" "$backup/codepilot-desktop-relay.py.before"
echo "Backed up original desktop relay at $backup"
rollback() {
  echo "Deployment failed. Restoring original desktop relay."
  cp -p "$backup/codepilot-desktop-relay.py.before" "$dest" || true
  systemctl restart "$service" || true
}
trap rollback ERR
install -o root -g root -m 0644 "$src" "$dest"
python3 -m py_compile "$dest"
systemctl restart "$service"
healthy=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if systemctl is-active --quiet "$service" && curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:8770/health; then
    healthy=1; break
  fi
  sleep 1
done
[ "$healthy" = "1" ] || { echo "ERROR: Desktop relay health check failed"; false; }
curl -fsS --max-time 6 -o /dev/null http://127.0.0.1:8765/health
trap - ERR
echo "PASS: Traditional Chinese/Unicode desktop relay deployed and healthy."
echo "CodePilot Agent remains running. Backup: $backup"
