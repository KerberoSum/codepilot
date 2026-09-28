#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo: sudo bash vm-agent/install-ai-relays.sh" >&2
  exit 1
fi

AGENT_DIR="/srv/codepilot-agent"
AGENT_BIN="$AGENT_DIR/bin"
SOURCE_USER="${SUDO_USER:-ubuntu}"
SOURCE_HOME="$(getent passwd "$SOURCE_USER" | cut -d: -f6)"

install -d -o codepilot-agent -g codepilot-agent "$AGENT_BIN"

CODEX_SRC="$(find "$SOURCE_HOME/.nvm/versions/node" -type f -path '*/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex' 2>/dev/null | sort | tail -1)"
RG_SRC="$(find "$SOURCE_HOME/.nvm/versions/node" -type f -path '*/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/codex-path/rg' 2>/dev/null | sort | tail -1)"
CODEX_HOST_SRC="$(find "$SOURCE_HOME/.nvm/versions/node" -type f -path '*/@openai/codex-linux-arm64/vendor/aarch64-unknown-linux-musl/bin/codex-code-mode-host' 2>/dev/null | sort | tail -1)"
GROK_SRC="$SOURCE_HOME/.grok/bin/grok"

[ -n "$CODEX_SRC" ] || { echo "Codex ARM64 binary not found under $SOURCE_HOME" >&2; exit 1; }
[ -x "$GROK_SRC" ] || { echo "Grok binary not found at $GROK_SRC" >&2; exit 1; }

install -m 0755 -o codepilot-agent -g codepilot-agent "$CODEX_SRC" "$AGENT_BIN/codex"
[ -n "$RG_SRC" ] && install -m 0755 -o codepilot-agent -g codepilot-agent "$RG_SRC" "$AGENT_BIN/rg"
[ -n "$CODEX_HOST_SRC" ] && install -m 0755 -o codepilot-agent -g codepilot-agent "$CODEX_HOST_SRC" "$AGENT_BIN/codex-code-mode-host"
install -m 0755 -o codepilot-agent -g codepilot-agent "$GROK_SRC" "$AGENT_BIN/grok"

runuser -u codepilot-agent -- env HOME="$AGENT_DIR" "$AGENT_BIN/codex" --version
runuser -u codepilot-agent -- env HOME="$AGENT_DIR" "$AGENT_BIN/grok" --version
echo "AI relay binaries installed for codepilot-agent."