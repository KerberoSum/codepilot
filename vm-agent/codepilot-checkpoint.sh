#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="${CODEPILOT_CHECKPOINT_DIR:-/var/lib/codepilot-checkpoints}"
REPO="${CODEPILOT_REPO:-/home/ubuntu/codepilot}"
KEEP="${CODEPILOT_CHECKPOINT_KEEP:-12}"

die(){ echo "codepilot-checkpoint: $*" >&2; exit 1; }
need_root(){ [ "$(id -u)" -eq 0 ] || die "run as root (sudo)"; }
now_iso(){ date -u +%Y-%m-%dT%H:%M:%SZ; }

safe_label(){
  printf '%s' "${1:-checkpoint}" | tr ' /:' '---' | tr -cd 'A-Za-z0-9._-' | cut -c1-48
}

git_repo(){
  runuser -u ubuntu -- git -C "$REPO" "$@"
}

agent_liveness(){
  curl -fsS --connect-timeout 1 --max-time 3 http://127.0.0.1:8765/healthz >/dev/null 2>&1 \
    || curl -fsS --connect-timeout 2 --max-time 6 http://127.0.0.1:8765/health >/dev/null 2>&1
}

health_check(){
  agent_liveness || return 1
  curl -fsS --connect-timeout 2 --max-time 5 http://127.0.0.1:8770/health >/dev/null 2>&1 || return 1
  systemctl is-active --quiet codepilot-agent.service || return 1
  systemctl is-active --quiet codepilot-desktop-relay.service || return 1
  systemctl is-active --quiet codepilot-tunnel.service || return 1
  systemctl is-active --quiet codepilot-watchdog.timer || return 1
  [ -S /tmp/.X11-unix/X1 ] || return 1
}

prune_old(){
  local keep="${1:-$KEEP}"
  mapfile -t dirs < <(find "$STATE_DIR" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' 2>/dev/null | sort -nr | awk '{print $2}')
  local i
  for ((i=keep; i<${#dirs[@]}; i++)); do
    rm -rf -- "${dirs[$i]}"
  done
}

create_checkpoint(){
  need_root
  local label="${1:-manual}"
  local id_only="${2:-}"
  mkdir -p "$STATE_DIR"
  chmod 0700 "$STATE_DIR"
  [ -d "$REPO/.git" ] || die "repo not found: $REPO"

  exec 9>"$STATE_DIR/.lock"
  flock -w 60 9 || die "another checkpoint operation is still running"

  local stamp id dir
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  id="$stamp-$(safe_label "$label")-$(printf '%04x' "$((RANDOM & 65535))")"
  dir="$STATE_DIR/$id"
  mkdir -m 0700 "$dir"

  local repo_items=()
  for item in frontend vm-agent worker/src wrangler.jsonc package.json migrations .github README.md SECURITY_SETUP.txt V2_3_NOTES.txt; do
    [ -e "$REPO/$item" ] && repo_items+=("$item")
  done
  tar -C "$REPO" -czf "$dir/repo-code.tar.gz" "${repo_items[@]}"
  git_repo diff --binary HEAD >"$dir/repo-working.patch" || true
  git_repo status --porcelain=v1 >"$dir/repo-status.txt" || true
  git_repo rev-parse HEAD >"$dir/repo-head.txt" 2>/dev/null || true
  git_repo rev-parse origin/main >"$dir/origin-head.txt" 2>/dev/null || true

  local system_candidates=(
    /srv/codepilot-agent/agent_server.py
    /srv/codepilot-agent/chatgpt_desktop_bridge.py
    /usr/local/lib/codepilot-desktop-relay.py
    /usr/local/sbin/codepilot-watchdog
    /usr/local/sbin/codepilot-checkpoint
    /etc/systemd/system/codepilot-agent.service
    /etc/systemd/system/codepilot-desktop-relay.service
    /etc/systemd/system/codepilot-tunnel.service
    /etc/systemd/system/codepilot-watchdog.service
    /etc/systemd/system/codepilot-watchdog.timer
    /etc/systemd/system/codepilot-checkpoint.service
    /etc/systemd/system/codepilot-checkpoint.timer
    /etc/systemd/system/tigervnc-desktop.service
    /home/ubuntu/.vnc/xstartup
    /home/ubuntu/bin/chatgpt-vm
  )
  local system_items=() p
  for p in "${system_candidates[@]}"; do
    [ -e "$p" ] && system_items+=("${p#/}")
  done
  if [ "${#system_items[@]}" -gt 0 ]; then
    tar -C / -czf "$dir/system-files.tar.gz" "${system_items[@]}"
  else
    tar -czf "$dir/system-files.tar.gz" --files-from /dev/null
  fi

  local healthy=false attempt
  for attempt in 1 2 3; do
    if health_check; then healthy=true; break; fi
    sleep 1
  done
  export CP_ID="$id" CP_LABEL="$label" CP_CREATED="$(now_iso)" CP_HEALTHY="$healthy" CP_DIR="$dir"
  export CP_REPO_HEAD="$(cat "$dir/repo-head.txt" 2>/dev/null || true)"
  export CP_ORIGIN_HEAD="$(cat "$dir/origin-head.txt" 2>/dev/null || true)"
  python3 - <<'PY'
import json, os
from pathlib import Path
d=Path(os.environ["CP_DIR"])
payload={
  "id": os.environ["CP_ID"],
  "label": os.environ["CP_LABEL"],
  "created_at": os.environ["CP_CREATED"],
  "healthy_at_creation": os.environ["CP_HEALTHY"] == "true",
  "repo_head": os.environ.get("CP_REPO_HEAD","").strip(),
  "origin_head": os.environ.get("CP_ORIGIN_HEAD","").strip(),
  "contains_secret_files": False,
  "storage": "root-only",
  "exclusions": [
    "browser profiles","downloads","*.env/environment files","OAuth/token files",
    "Goose secrets","Grok/Cursor auth","ChatGPT/Codex auth"
  ],
}
(d/"manifest.json").write_text(json.dumps(payload,indent=2)+"\n",encoding="utf-8")
PY
  chmod -R go-rwx "$dir"
  prune_old "$KEEP"
  if [ "$id_only" = "--id-only" ]; then
    printf '%s\n' "$id"
  else
    echo "Created checkpoint: $id (healthy=$healthy)"
  fi
}

list_checkpoints(){
  need_root
  mkdir -p "$STATE_DIR"
  python3 - "$STATE_DIR" <<'PY'
import json, pathlib, sys
root=pathlib.Path(sys.argv[1])
rows=[]
for p in root.iterdir() if root.exists() else []:
    if not p.is_dir(): continue
    try: m=json.loads((p/"manifest.json").read_text())
    except Exception: m={"id":p.name,"label":"?","created_at":"?","healthy_at_creation":False}
    size=sum(x.stat().st_size for x in p.rglob("*") if x.is_file())
    rows.append((m.get("created_at",""),m,size))
for _,m,size in sorted(rows,reverse=True):
    print(f'{m.get("id","?")}  {size/1024:.1f} KiB  healthy={m.get("healthy_at_creation",False)}  {m.get("label","")}')
PY
}

show_checkpoint(){
  need_root
  local id="${1:-}"
  [ -n "$id" ] || die "checkpoint id required"
  [ -r "$STATE_DIR/$id/manifest.json" ] || die "checkpoint not found: $id"
  cat "$STATE_DIR/$id/manifest.json"
  echo "--- repo status at checkpoint ---"
  cat "$STATE_DIR/$id/repo-status.txt" 2>/dev/null || true
}

restore_files(){
  local id="$1"
  local dir="$STATE_DIR/$id"
  [ -d "$dir" ] || die "checkpoint not found: $id"
  [ -r "$dir/repo-code.tar.gz" ] || die "repo archive missing: $id"
  [ -r "$dir/system-files.tar.gz" ] || die "system archive missing: $id"

  tar -C "$REPO" -xzf "$dir/repo-code.tar.gz"
  tar -C / -xzf "$dir/system-files.tar.gz"
  systemctl daemon-reload
  systemctl try-restart codepilot-desktop-relay.service >/dev/null 2>&1 || true
  systemctl try-restart codepilot-watchdog.timer >/dev/null 2>&1 || true
  systemctl restart codepilot-agent.service >/dev/null 2>&1 || true
}

wait_healthy(){
  local i
  for i in $(seq 1 12); do
    if health_check; then return 0; fi
    sleep 1
  done
  return 1
}

restore_checkpoint(){
  need_root
  local id="${1:-}" approval="${2:-}"
  [ -n "$id" ] || die "checkpoint id required"
  [ "$approval" = "--yes" ] || die "restore is destructive; rerun with: restore $id --yes"
  [ -d "$STATE_DIR/$id" ] || die "checkpoint not found: $id"

  local safety old_keep
  old_keep="$KEEP"
  KEEP=9999
  safety="$(create_checkpoint "pre-rollback-$id" --id-only)"
  KEEP="$old_keep"
  echo "Safety checkpoint before rollback: $safety"
  echo "Restoring checkpoint: $id"
  restore_files "$id"
  if wait_healthy; then
    echo "Rollback healthy: $id"
    return 0
  fi

  echo "Rollback health check failed; automatically restoring pre-rollback state: $safety" >&2
  restore_files "$safety"
  if wait_healthy; then
    echo "Pre-rollback state restored successfully." >&2
    return 2
  fi
  echo "CRITICAL: automatic recovery also failed; manual intervention required." >&2
  return 3
}

case "${1:-}" in
  create) create_checkpoint "${2:-manual}" "${3:-}" ;;
  list) list_checkpoints ;;
  show) show_checkpoint "${2:-}" ;;
  restore) restore_checkpoint "${2:-}" "${3:-}" ;;
  prune) need_root; prune_old "${2:-$KEEP}"; echo "Checkpoint retention applied." ;;
  health) need_root; if health_check; then echo healthy; else echo unhealthy; exit 1; fi ;;
  *)
    cat <<'USAGE'
Usage:
  codepilot-checkpoint create [label] [--id-only]
  codepilot-checkpoint list
  codepilot-checkpoint show <id>
  codepilot-checkpoint restore <id> --yes
  codepilot-checkpoint prune [keep]
  codepilot-checkpoint health
USAGE
    ;;
esac
