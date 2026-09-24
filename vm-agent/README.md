# CodePilot VM Agent v2

This directory contains the VM-side upgrade that pairs with the CodePilot VM Agent v2 Worker/frontend.

## What it adds

- task history/status support in the frontend
- SSE task status endpoint with non-streaming compatibility
- one-task-at-a-time concurrency protection
- prompt length and timeout limits
- a dedicated unprivileged service account deployment pattern
- systemd hardening
- automatic Quick Tunnel URL registration, so a restarted random trycloudflare.com URL can update CodePilot automatically
- a CodePilot model-gateway endpoint in the Worker, so the OpenRouter key can remain in Cloudflare rather than being exposed to browser code

## Required Cloudflare Worker secrets

Keep the existing:
- `VM_AGENT_SECRET`

Add:
- `VM_AGENT_REGISTRATION_SECRET` — a separate random token used only by the VM to register its current Quick Tunnel URL.
- `VM_MODEL_GATEWAY_SECRET` — a separate random token for VM-to-Worker model gateway authentication.

`OPENROUTER_API_KEY` remains stored in the Worker.

## VM deployment outline

The service is intended to run as a dedicated `codepilot-agent` user. Copy the Goose binary to `/usr/local/bin/goose`, deploy `agent_server.py` under `/srv/codepilot-agent`, create `/srv/codepilot-workspace`, install FastAPI/Uvicorn for the service's Python environment, and install the provided systemd unit.

Store runtime secrets in `/etc/codepilot-agent.env` with mode 600 instead of embedding them directly in the unit file.

For the auto-registering Quick Tunnel, set `CODEPILOT_WORKER_URL` and `VM_AGENT_REGISTRATION_SECRET` in its environment and run `quick-tunnel-register.sh` under a systemd service.

## Model gateway

The Worker now exposes an OpenAI-compatible endpoint:

`POST /vm-llm/v1/chat/completions`

It accepts a Bearer token matching `VM_MODEL_GATEWAY_SECRET` and proxies the request to OpenRouter using the Worker's `OPENROUTER_API_KEY`.

Before removing the direct OpenRouter key from Goose, verify your installed Goose release can be configured for a custom OpenAI-compatible endpoint. Keep the current direct OpenRouter configuration until that migration is tested.
