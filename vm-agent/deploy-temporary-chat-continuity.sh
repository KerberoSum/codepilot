#!/usr/bin/env bash
# Deploy tested ChatGPT Temporary Chat continuity to the CodePilot VM Agent.
# Execute via SSH: sudo bash /home/ubuntu/codepilot/vm-agent/deploy-temporary-chat-continuity.sh
set -Eeuo pipefail
umask 077
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo from the VM's SSH terminal."; exit 1; }
src="/home/ubuntu/codepilot/vm-agent"
dest="/srv/codepilot-agent"
svc="codepilot-agent.service"
backup="/var/backups/codepilot-temp-chat-$(date -u +%Y%m%dT%H%M%SZ)"
for file in agent_server.py chatgpt_desktop_bridge.py; do
  [ -f "$src/$file" ] && [ -f "$dest/$file" ] || { echo "ERROR: missing $file"; exit 1; }
done
systemctl is-active --quiet "$svc" || { echo "ERROR: CodePilot Agent is not healthy"; exit 1; }
curl -fsS --max-time 12 -o /dev/null http://127.0.0.1:8765/health
if pgrep -f '^/usr/bin/python3 /srv/codepilot-agent/chatgpt_desktop_bridge.py --timeout' >/dev/null; then
  echo "ERROR: ChatGPT Desktop is processing an active request; retry when idle."
  exit 1
fi
python3 -m unittest discover -s "$src" -p 'test_chatgpt_desktop_bridge.py' -q
python3 -m py_compile "$src/agent_server.py" "$src/chatgpt_desktop_bridge.py"
install -d -m 0700 "$backup"
cp -p "$dest/agent_server.py" "$backup/agent_server.py"
cp -p "$dest/chatgpt_desktop_bridge.py" "$backup/chatgpt_desktop_bridge.py"
echo "Previous VM Agent files backed up at $backup"
restore() {
  echo "ERROR: restoring the previous VM Agent files."
  cp -p "$backup/agent_server.py" "$dest/agent_server.py" || true
  cp -p "$backup/chatgpt_desktop_bridge.py" "$dest/chatgpt_desktop_bridge.py" || true
  systemctl restart "$svc" || true
}
trap restore ERR
install -o root -g root -m 0644 "$src/agent_server.py" "$dest/agent_server.py"
install -o root -g root -m 0644 "$src/chatgpt_desktop_bridge.py" "$dest/chatgpt_desktop_bridge.py"
python3 -m py_compile "$dest/agent_server.py" "$dest/chatgpt_desktop_bridge.py"
systemctl restart "$svc"
healthy=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if systemctl is-active --quiet "$svc" && curl -fsS --max-time 3 -o /dev/null http://127.0.0.1:8765/health; then
    healthy=1
    break
  fi
  sleep 2
done
[ "$healthy" -eq 1 ] || { echo "ERROR: CodePilot health check did not pass."; false; }
trap - ERR
echo "PASS: ChatGPT Desktop bridge continuity deployed; CodePilot Agent healthy."
echo "Backup: $backup"
