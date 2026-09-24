#!/usr/bin/env bash
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer with sudo." >&2
  exit 1
fi

AGENT_HOME="/srv/codepilot-agent"
WORKSPACE="/srv/codepilot-workspace"
TRAILBLAZE_DIR="$AGENT_HOME/.trailblaze"

if ! id codepilot-agent >/dev/null 2>&1; then
  echo "The codepilot-agent service user does not exist." >&2
  exit 1
fi

apt-get update
apt-get install -y curl ca-certificates openjdk-17-jre-headless

mkdir -p "$TRAILBLAZE_DIR" "$WORKSPACE"
chown -R codepilot-agent:codepilot-agent "$AGENT_HOME" "$WORKSPACE"

echo "Installing Trailblaze for the CodePilot service user..."
sudo -u codepilot-agent env HOME="$AGENT_HOME" TRAILBLAZE_DIR="$TRAILBLAZE_DIR" TRAILBLAZE_SKIP_BUN_INSTALL=1 \
  bash -c 'curl -fsSL https://raw.githubusercontent.com/block/trailblaze/main/install.sh | bash'

ln -sf "$TRAILBLAZE_DIR/bin/trailblaze" /usr/local/bin/trailblaze

echo "Installing the bundled Trailblaze agent skill in the worker workspace..."
sudo -u codepilot-agent env HOME="$AGENT_HOME" PATH="$TRAILBLAZE_DIR/bin:/usr/local/bin:/usr/bin:/bin" \
  bash -c 'cd /srv/codepilot-workspace && trailblaze skill install --agent goose || true'

echo "Checking Trailblaze and its web device..."
sudo -u codepilot-agent env HOME="$AGENT_HOME" PATH="$TRAILBLAZE_DIR/bin:/usr/local/bin:/usr/bin:/bin" \
  trailblaze --version
sudo -u codepilot-agent env HOME="$AGENT_HOME" PATH="$TRAILBLAZE_DIR/bin:/usr/local/bin:/usr/bin:/bin" \
  bash -c 'cd /srv/codepilot-workspace && trailblaze device list || true'

systemctl restart codepilot-agent

echo
echo "Remote Worker browser tools installed."
echo "Verify with: curl -s http://127.0.0.1:8765/health"
