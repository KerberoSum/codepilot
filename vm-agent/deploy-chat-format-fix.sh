#!/usr/bin/env bash
set -euo pipefail
# Install the corrected ChatGPT Desktop response extractor.
# Only the bridge file is replaced; the VM Agent service and chat history stay running.
if [[ ${EUID} -ne 0 ]]; then
  echo "Use: sudo bash /home/ubuntu/codepilot/vm-agent/deploy-chat-format-fix.sh" >&2
  exit 1
fi
source=/home/ubuntu/codepilot/vm-agent/chatgpt_desktop_bridge.py
target=/srv/codepilot-agent/chatgpt_desktop_bridge.py
test -f "$source" && test -f "$target"
current="$(sha256sum "$target" | cut -d' ' -f1)"
allowed="abb44634f064a11e538802d4230ee46f55d5411e4d78e701f4597a4e2e5342b1"
next="$(sha256sum "$source" | cut -d' ' -f1)"
if [[ "$current" == "$next" ]]; then echo "The corrected bridge is already installed."; exit 0; fi
if [[ "$current" != "$allowed" ]]; then
  echo "Installed bridge differs from verified version; refused to overwrite." >&2
  exit 1
fi
# A running ChatGPT Desktop request should be allowed to finish unchanged.
if pgrep -f '/srv/codepilot-agent/chatgpt_desktop_bridge.py --timeout' >/dev/null; then
  echo "ChatGPT Desktop reply is currently running. Try after it finishes." >&2
  exit 1
fi
python3 -m py_compile "$source"
backup="/srv/codepilot-agent/chatgpt_desktop_bridge.py.backup-$(date -u +%Y%m%dT%H%M%SZ)"
cp -p "$target" "$backup"
install -o root -g root -m 0644 "$source" "$target"
python3 -m py_compile "$target"
echo "ChatGPT Desktop extraction updated successfully."
echo "Backup: $backup"
echo "No service restart needed. New temporary chats use the corrected formatting."
