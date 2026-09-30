#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo bash vm-agent/fix-provider-auth.sh" >&2
  exit 1
fi

AGENT_HOME=/srv/codepilot-agent
GOOSE_SRC=/home/ubuntu/.config/goose/secrets.yaml
CURSOR_BIN="$AGENT_HOME/.local/bin/cursor-agent"

echo "[1/3] Checking OpenRouter credential..."
if [ ! -s "$GOOSE_SRC" ]; then
  echo "No Ubuntu Goose secrets file found." >&2
  exit 1
fi
if ! grep -q '^OPENROUTER_API_KEY:' "$GOOSE_SRC"; then
  echo "OPENROUTER_API_KEY was not found in $GOOSE_SRC" >&2
  exit 1
fi
echo "OpenRouter credential found; reload-agent.sh will merge it safely."

echo
echo "[2/3] Cursor login..."
echo "A Cursor login URL will appear below."
echo "Open it in the VM browser and approve the login, then return here."
runuser -u codepilot-agent -- env HOME="$AGENT_HOME" NO_OPEN_BROWSER=1 "$CURSOR_BIN" login

echo
echo "Verifying Cursor authentication..."
runuser -u codepilot-agent -- env HOME="$AGENT_HOME" "$CURSOR_BIN" status

echo
echo "[3/3] Reloading CodePilot Agent with the latest provider config..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
bash "$SCRIPT_DIR/reload-agent.sh"
echo
echo "Provider authentication setup complete."
