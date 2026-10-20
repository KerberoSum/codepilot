#!/usr/bin/env bash
set -euo pipefail
# One-time privileged deployment of CodePilot's extended ChatGPT Desktop timeout.
# No credentials, chats, missions, browser profiles or clipboard data are touched.
if [[ "$EUID" -ne 0 ]]; then
  echo "Run this script with: sudo bash /home/ubuntu/codepilot/vm-agent/deploy-desktop-chat-timeout.sh" >&2
  exit 1
fi
repo=/home/ubuntu/codepilot/vm-agent
dest=/srv/codepilot-agent
test -f "$repo/agent_server.py"
test -f "$repo/chatgpt_desktop_bridge.py"
test -f "$dest/agent_server.py"
test -f "$dest/chatgpt_desktop_bridge.py"
python3 - "$repo" "$dest" <<'PY'
import hashlib, pathlib, sys, json
repo,dest=[pathlib.Path(p) for p in sys.argv[1:]]
expected={
  'agent_server.py': {'29715d03a43d3b729647bb1c4dd3e528a187772e648795b3d6f02f0228dd199d'},
  'chatgpt_desktop_bridge.py': {'4eb408c3fd788910a77ad292f5a434736af4c4875a83f5433aebbf8a12a81c7a'},
}
for filename,versions in expected.items():
    data=(dest/filename).read_bytes()
    sha=hashlib.sha256(data).hexdigest()
    new=(repo/filename).read_bytes()
    if sha not in versions and data != new:
        # An earlier deployment may have retained max_length=4 in the live server.
        if filename!='agent_server.py' or data != new.replace(
            b'keys: list[str] = Field(default_factory=list)',
            b'keys: list[str] = Field(default_factory=list, max_length=4)'):
            raise SystemExit(f'{filename} differs from verified version; refusing to overwrite it.')
state=dest/'missions.json'
if state.is_file():
    missions=json.loads(state.read_text(encoding='utf-8'))
    if any(isinstance(m,dict) and m.get('status') in ('running','cancelling') for m in missions):
        raise SystemExit('A VM queued command is running. Wait until it finishes before updating.')
print('Verified existing CodePilot installation and checked for running missions.')
PY
backup="$dest/backup-desktop-chat-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$backup"
cp -p "$dest/agent_server.py" "$dest/chatgpt_desktop_bridge.py" "$backup/"
python3 - "$repo" "$dest" <<'PY'
from pathlib import Path
import sys, py_compile
repo,dest=[Path(p) for p in sys.argv[1:]]
source=(repo/'agent_server.py').read_text()
# Keep the deployed server's tighter X11 chord validation from the previous fix.
source=source.replace(
    'keys: list[str] = Field(default_factory=list)',
    'keys: list[str] = Field(default_factory=list, max_length=4)'
)
(dest/'agent_server.py').write_text(source)
(dest/'chatgpt_desktop_bridge.py').write_bytes((repo/'chatgpt_desktop_bridge.py').read_bytes())
for filename in ('agent_server.py','chatgpt_desktop_bridge.py'):
    py_compile.compile(str(dest/filename),doraise=True)
print('Updated bridge and VM Agent server (retained existing X11 chord validation).')
PY
chown root:root "$dest/agent_server.py" "$dest/chatgpt_desktop_bridge.py"
chmod 644 "$dest/agent_server.py" "$dest/chatgpt_desktop_bridge.py"
systemctl restart codepilot-agent
systemctl is-active --quiet codepilot-agent
echo "CodePilot VM Agent restarted with 30-minute ChatGPT Desktop timeout."
echo "Original files backed up at $backup"
