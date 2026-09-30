#!/usr/bin/env bash
set -euo pipefail
export HOME=/home/ubuntu
export DISPLAY=:1
export XAUTHORITY=/home/ubuntu/.Xauthority

XFCE_PID="$(pgrep -u ubuntu -x xfce4-session | head -1 || true)"
if [ -n "$XFCE_PID" ] && [ -r "/proc/$XFCE_PID/environ" ]; then
  while IFS= read -r line; do
    case "$line" in
      DBUS_SESSION_BUS_ADDRESS=*|XDG_CURRENT_DESKTOP=*|DESKTOP_SESSION=*|XDG_SESSION_TYPE=*|XDG_RUNTIME_DIR=*)
        export "$line"
        ;;
    esac
  done < <(tr '\0' '\n' <"/proc/$XFCE_PID/environ")
fi

export BROWSER=/usr/bin/chromium-browser
exec /usr/bin/chatgpt --remote-debugging-address=127.0.0.1 --remote-debugging-port=9223 --force-renderer-accessibility "$@"