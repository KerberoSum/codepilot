#!/usr/bin/env bash
set -uo pipefail
STATE_DIR=/var/lib/codepilot-watchdog
STATUS_FILE="$STATE_DIR/status.json"
EVENT_FILE="$STATE_DIR/events.log"
mkdir -p "$STATE_DIR"
chmod 0755 "$STATE_DIR"

now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }
log_event() {
  printf '%s %s\n' "$(now_iso)" "$*" >>"$EVENT_FILE"
  tail -n 300 "$EVENT_FILE" >"$EVENT_FILE.tmp" 2>/dev/null || true
  mv "$EVENT_FILE.tmp" "$EVENT_FILE" 2>/dev/null || true
}

agent_health(){
  curl -fsS --connect-timeout 1 --max-time 3 http://127.0.0.1:8765/healthz >/dev/null 2>&1 \
    || curl -fsS --connect-timeout 2 --max-time 6 http://127.0.0.1:8765/health >/dev/null 2>&1
}

repairs=()
agent_ok=false
display_ok=false
relay_ok=false
tunnel_ok=false
chatgpt_ok=false
disk_ok=true

if agent_health; then
  agent_ok=true
else
  log_event "agent health failed; restarting codepilot-agent.service"
  if systemctl restart codepilot-agent.service >/dev/null 2>&1; then
    sleep 3
    if agent_health; then
      agent_ok=true
      repairs+=("agent restarted")
    fi
  fi
fi

if [ -S /tmp/.X11-unix/X1 ] \
  && pgrep -u ubuntu -f 'Xtigervnc.*:1' >/dev/null 2>&1 \
  && pgrep -u ubuntu -x xfce4-session >/dev/null 2>&1; then
  display_ok=true
else
  log_event "desktop display missing; restarting tigervnc-desktop.service"
  if systemctl restart tigervnc-desktop.service >/dev/null 2>&1; then
    sleep 5
    if [ -S /tmp/.X11-unix/X1 ] \
      && pgrep -u ubuntu -f 'Xtigervnc.*:1' >/dev/null 2>&1 \
      && pgrep -u ubuntu -x xfce4-session >/dev/null 2>&1; then
      display_ok=true
      repairs+=("desktop restarted")
    fi
  fi
fi

if $display_ok; then
  if curl -fsS --connect-timeout 2 --max-time 5 http://127.0.0.1:8770/health >/dev/null 2>&1; then
    relay_ok=true
  else
    log_event "desktop relay health failed; restarting codepilot-desktop-relay.service"
    if systemctl restart codepilot-desktop-relay.service >/dev/null 2>&1; then
      sleep 2
      if curl -fsS --connect-timeout 2 --max-time 5 http://127.0.0.1:8770/health >/dev/null 2>&1; then
        relay_ok=true
        repairs+=("desktop relay restarted")
      fi
    fi
  fi
else
  relay_ok=false
fi

if systemctl is-active --quiet codepilot-tunnel.service; then
  tunnel_ok=true
else
  log_event "worker tunnel inactive; restarting codepilot-tunnel.service"
  if systemctl restart codepilot-tunnel.service >/dev/null 2>&1; then
    sleep 3
    if systemctl is-active --quiet codepilot-tunnel.service; then
      tunnel_ok=true
      repairs+=("worker tunnel restarted")
    fi
  fi
fi

if $display_ok; then
  if pgrep -u ubuntu -f '^/usr/lib/chatgpt/ChatGPT( |$)' >/dev/null 2>&1; then
    chatgpt_ok=true
  else
    log_event "ChatGPT Desktop missing; launching it on display :1"
    runuser -u ubuntu -- sh -lc \
      'export HOME=/home/ubuntu DISPLAY=:1 XAUTHORITY=/home/ubuntu/.Xauthority; nohup /home/ubuntu/bin/chatgpt-vm >/tmp/codepilot-watchdog-chatgpt.log 2>&1 &' \
      >/dev/null 2>&1 || true
    sleep 5
    if pgrep -u ubuntu -f '^/usr/lib/chatgpt/ChatGPT( |$)' >/dev/null 2>&1; then
      chatgpt_ok=true
      repairs+=("ChatGPT Desktop launched")
    fi
  fi
else
  chatgpt_ok=false
fi

disk_pct="$(df -P / | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
if [ -z "$disk_pct" ]; then disk_pct=0; fi
if [ "$disk_pct" -ge 90 ] 2>/dev/null; then
  disk_ok=false
  log_event "disk usage warning: ${disk_pct}%"
fi

healthy=true
for value in "$agent_ok" "$display_ok" "$relay_ok" "$tunnel_ok" "$chatgpt_ok" "$disk_ok"; do
  if [ "$value" != "true" ]; then healthy=false; fi
done

repairs_json="$(printf '%s\n' "${repairs[@]-}" | python3 -c 'import json,sys; print(json.dumps([x.strip() for x in sys.stdin if x.strip()]))')"
export CP_WATCHDOG_HEALTHY="$healthy"
export CP_WATCHDOG_AGENT="$agent_ok"
export CP_WATCHDOG_DISPLAY="$display_ok"
export CP_WATCHDOG_RELAY="$relay_ok"
export CP_WATCHDOG_TUNNEL="$tunnel_ok"
export CP_WATCHDOG_CHATGPT="$chatgpt_ok"
export CP_WATCHDOG_DISK="$disk_ok"
export CP_WATCHDOG_DISK_PCT="$disk_pct"
export CP_WATCHDOG_REPAIRS="$repairs_json"
export CP_WATCHDOG_NOW="$(now_iso)"

python3 - "$STATUS_FILE" <<'PY'
import json, os, pathlib, sys, tempfile
path = pathlib.Path(sys.argv[1])
payload = {
    "healthy": os.environ.get("CP_WATCHDOG_HEALTHY") == "true",
    "checked_at": os.environ.get("CP_WATCHDOG_NOW"),
    "components": {
        "agent": os.environ.get("CP_WATCHDOG_AGENT") == "true",
        "desktop": os.environ.get("CP_WATCHDOG_DISPLAY") == "true",
        "desktop_relay": os.environ.get("CP_WATCHDOG_RELAY") == "true",
        "worker_tunnel": os.environ.get("CP_WATCHDOG_TUNNEL") == "true",
        "chatgpt_desktop": os.environ.get("CP_WATCHDOG_CHATGPT") == "true",
        "disk": os.environ.get("CP_WATCHDOG_DISK") == "true",
    },
    "disk_percent": int(os.environ.get("CP_WATCHDOG_DISK_PCT") or 0),
    "repairs": json.loads(os.environ.get("CP_WATCHDOG_REPAIRS") or "[]"),
}
fd, tmp = tempfile.mkstemp(prefix="watchdog-", suffix=".json", dir=str(path.parent))
with os.fdopen(fd, "w", encoding="utf-8") as f:
    json.dump(payload, f, separators=(",", ":"))
    f.write("\n")
os.chmod(tmp, 0o644)
os.replace(tmp, path)
PY

if [ "${#repairs[@]}" -gt 0 ]; then
  log_event "repair complete: ${repairs[*]}"
fi

$healthy
