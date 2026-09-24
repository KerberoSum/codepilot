import asyncio
import json
import os
import secrets
import subprocess
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, Header, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

app = FastAPI(title="CodePilot VM Agent", version="2.0")

SECRET = os.environ.get("CODEPILOT_AGENT_SECRET", "")
GOOSE_BIN = os.environ.get("GOOSE_BIN", "/usr/local/bin/goose")
WORKSPACE = Path(os.environ.get("CODEPILOT_WORKSPACE", "/srv/codepilot-workspace")).resolve()
MAX_TURNS = int(os.environ.get("CODEPILOT_MAX_TURNS", "12"))
TASK_TIMEOUT = int(os.environ.get("CODEPILOT_TASK_TIMEOUT", "300"))
task_lock = asyncio.Lock()

if not SECRET:
    raise RuntimeError("CODEPILOT_AGENT_SECRET is required")

WORKSPACE.mkdir(parents=True, exist_ok=True)

class TaskRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=8000)
    mode: Literal["read", "workspace"] = "read"

def require_auth(authorization: str | None):
    prefix = "Bearer "
    token = authorization[len(prefix):] if authorization and authorization.startswith(prefix) else ""
    if not token or not secrets.compare_digest(token, SECRET):
        raise HTTPException(status_code=401, detail="Unauthorized")

def policy_prompt(req: TaskRequest) -> str:
    if req.mode == "read":
        rules = """MODE: READ ONLY.
You may inspect system information, files, directories, processes, logs, networking, and git status/log/diff.
Do not create, edit, move, rename, or delete files. Do not install software. Do not use sudo.
Do not change services, users, passwords, firewall, networking, OCI configuration, mounts, packages, or system settings.
If the request requires a modification, explain that read mode cannot perform it."""
    else:
        rules = f"""MODE: WORKSPACE.
You may inspect the VM and may create, edit, move, rename, and delete files ONLY inside {WORKSPACE}.
You may run git commands only for repositories inside that workspace.
Do not use sudo. Do not install packages or change services, users, passwords, firewall, networking, OCI configuration, mounts, or system settings.
Never modify anything outside the workspace."""
    return rules + "\n\nUSER TASK:\n" + req.prompt

def goose_command(full_prompt: str) -> list[str]:
    return [
        GOOSE_BIN, "run",
        "--text", full_prompt,
        "--no-session",
        "--quiet",
        "--output-format", "json",
        "--max-turns", str(MAX_TURNS),
        "--no-profile",
        "--with-builtin", "developer",
    ]

def extract_result(payload: dict) -> str:
    if isinstance(payload.get("result"), str):
        return payload["result"]
    messages = payload.get("messages")
    if isinstance(messages, list):
        for msg in reversed(messages):
            if isinstance(msg, dict) and msg.get("role") == "assistant":
                content = msg.get("content")
                if isinstance(content, str):
                    return content
                if isinstance(content, list):
                    parts = []
                    for item in content:
                        if isinstance(item, dict) and isinstance(item.get("text"), str):
                            parts.append(item["text"])
                    if parts:
                        return "\n".join(parts)
    return payload.get("text") or "(No text response)"

def normalize(payload: dict) -> dict:
    usage = payload.get("usage") or {}
    total = usage.get("total_tokens", payload.get("total_tokens"))
    inp = usage.get("input_tokens", payload.get("input_tokens"))
    out = usage.get("output_tokens", payload.get("output_tokens"))
    return {
        "ok": True,
        "result": extract_result(payload),
        "tokens": {"total": total, "input": inp, "output": out},
        "status": "completed",
    }

async def execute(req: TaskRequest) -> dict:
    if task_lock.locked():
        raise HTTPException(status_code=429, detail="Another VM task is already running")
    async with task_lock:
        full_prompt = policy_prompt(req)
        try:
            proc = await asyncio.create_subprocess_exec(
                *goose_command(full_prompt),
                cwd=str(WORKSPACE),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=os.environ.copy(),
            )
            stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=TASK_TIMEOUT)
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except Exception:
                pass
            raise HTTPException(status_code=504, detail="VM task timed out")
        if proc.returncode != 0:
            detail = stderr.decode("utf-8", "replace")[-1500:] or "Goose failed"
            raise HTTPException(status_code=502, detail=detail)
        try:
            payload = json.loads(stdout.decode("utf-8"))
        except Exception:
            raise HTTPException(status_code=502, detail="Goose returned invalid JSON")
        return normalize(payload)

@app.get("/health")
async def health():
    return {"ok": True, "version": 2, "workspace": str(WORKSPACE)}

@app.post("/agent/task")
async def task(req: TaskRequest, authorization: str | None = Header(default=None)):
    require_auth(authorization)
    return await execute(req)

@app.post("/agent/task/stream")
async def task_stream(req: TaskRequest, authorization: str | None = Header(default=None)):
    require_auth(authorization)

    async def events():
        yield "event: status\ndata: " + json.dumps({"stage": "queued"}) + "\n\n"
        if task_lock.locked():
            yield "event: status\ndata: " + json.dumps({"stage": "waiting"}) + "\n\n"
        yield "event: status\ndata: " + json.dumps({"stage": "goose_running"}) + "\n\n"
        try:
            result = await execute(req)
            yield "event: status\ndata: " + json.dumps({"stage": "completed"}) + "\n\n"
            yield "event: result\ndata: " + json.dumps(result) + "\n\n"
        except HTTPException as exc:
            yield "event: status\ndata: " + json.dumps({"stage": "failed"}) + "\n\n"
            yield "event: result\ndata: " + json.dumps({"ok": False, "error": str(exc.detail), "status": "failed"}) + "\n\n"

    return StreamingResponse(events(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})
