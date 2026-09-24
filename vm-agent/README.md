# CodePilot Remote Worker v3.1

CodePilot's VM Agent can now operate as a small remote worker rather than only a one-shot task runner.

## Core capabilities

- persistent VM Agent chat sessions stored in Cloudflare D1, with new/open/rename/delete controls like Workspace chat
- Read-only and Workspace permission modes
- optional public-web access per chat message or mission
- background Missions that continue on the VM after the browser disconnects
- a third CodePilot **Terminal** page for authenticated shell commands through the existing Worker/tunnel path
- one-work-item-at-a-time execution to protect the 2-OCPU VM
- persistent mission history in `/srv/codepilot-agent/missions.json`
- mission cancellation for queued/running work
- capability discovery for the CodePilot UI
- Trailblaze-based headless web/browser automation when installed
- automatic Quick Tunnel URL registration
- Worker-hosted OpenRouter model gateway so the real OpenRouter key does not need to live in the agent service config

## Remote Worker model

Use **chat** for quick interactive requests.

Use **Queue mission** for work that may take longer. The browser only submits the mission; Goose runs it on the VM. You can leave the Agent page and later return to see whether it is queued, running, completed, failed, cancelled, or interrupted.

Execution concurrency stays at one Goose work item at a time by design. Chat requests now wait behind an active task instead of immediately failing with a busy error. The Agent UI can also stop the current work item.

## Web/browser access

CodePilot exposes a **Web access** toggle. When enabled, the VM prompt allows public-web research.

For interactive or JavaScript-heavy pages the worker prefers Trailblaze, which can drive a Playwright-compatible Chromium browser headlessly. Goose can use Trailblaze through the shell and its bundled agent skill.

Install the browser tooling on the VM after deploying this version:

```bash
cd ~/codepilot && git pull && sudo bash vm-agent/install-web-tools.sh
```

Trailblaze's upstream installer requires Java 17+. The included setup script installs the Java runtime, installs Trailblaze under the dedicated agent home, exposes it at `/usr/local/bin/trailblaze`, installs the Goose-compatible Trailblaze skill in the worker workspace, probes the web device, and restarts `codepilot-agent`.

Web access is intentionally read-oriented by default. The policy tells the agent not to enter credentials, submit forms, send messages, make purchases, upload files, or change external accounts without explicit user approval.

## VM deployment

The systemd service runs as the dedicated `codepilot-agent` user with:

- home: `/srv/codepilot-agent`
- workspace: `/srv/codepilot-workspace`
- API: `127.0.0.1:8765`
- environment file: `/etc/codepilot-agent.env`

After pulling this version, the easiest upgrade is one command:

```bash
sudo bash vm-agent/upgrade-v3.sh
```

It installs the v3 server/unit, refreshes the Quick Tunnel helper, installs browser tooling, restarts the services, and prints a local health check. Use `--skip-browser` only if you intentionally do not want Trailblaze installed.

The health response should report version 3.1.

## Worker endpoints

The Cloudflare Worker keeps VM credentials away from browser JavaScript and proxies:

- `GET /vm-agent/health`
- `GET /vm-agent/capabilities`
- `GET /vm-agent/status`
- `DELETE /vm-agent/task/current`
- `POST /vm-agent/terminal`
- `GET/POST /vm-agent/chats`
- `GET/PATCH/DELETE /vm-agent/chats/:id`
- `POST /vm-agent/chats/:id/messages`
- `POST /vm-agent/task`
- `POST /vm-agent/task/stream`
- `GET /vm-agent/missions`
- `POST /vm-agent/missions`
- `GET /vm-agent/missions/:id`
- `DELETE /vm-agent/missions/:id`

The model gateway remains:

- `POST /vm-llm/v1/chat/completions`

## Required Worker secrets

Keep:

- `VM_AGENT_SECRET`
- `VM_AGENT_REGISTRATION_SECRET`
- `VM_MODEL_GATEWAY_SECRET`
- `OPENROUTER_API_KEY`

Do not expose these values in frontend code.

## Safety boundaries

Read mode cannot modify files or system state. Workspace mode may only modify files below `/srv/codepilot-workspace`. Neither mode may use sudo, install packages, change services, users, firewall/network configuration, mounts, or OCI settings through an ordinary task.

Browser content is treated as untrusted input. External side-effect actions are not automatically authorized simply because Web access is enabled.

## Browser terminal

The CodePilot Terminal does **not** expose port 22 or send SSH credentials to the browser. Browser requests stay inside the existing authenticated CodePilot Worker → Quick Tunnel → VM Agent path. Commands execute as the dedicated `codepilot-agent` service account.

It preserves the working directory between commands and supports ordinary shell commands, file editing through non-interactive commands, Git, diagnostics, and scripts. It intentionally does not provide root/sudo access or full-screen interactive TTY programs in this first version. Systemd hardening remains in force, so protected system paths are read-only while the CodePilot workspace and agent data directories remain writable.
