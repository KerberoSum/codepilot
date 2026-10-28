#!/usr/bin/env python3
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import struct
import sys
import time
import urllib.parse
import urllib.request

CDP_LIST_URL = os.environ.get("CHATGPT_DESKTOP_CDP_LIST", "http://127.0.0.1:9223/json/list")
TARGET_URL = "app://-/index.html"
SESSION_STATE_PATH = Path(os.environ.get("CODEPILOT_CHATGPT_TEMP_STATE", "/srv/codepilot-agent/chatgpt-temp-session.json"))
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class WebSocket:
    def __init__(self, url: str, timeout: float = 35.0):
        parsed = urllib.parse.urlparse(url)
        if parsed.scheme != "ws":
            raise RuntimeError("Only local ws:// DevTools targets are supported")
        self.host = parsed.hostname or "127.0.0.1"
        self.port = parsed.port or 80
        self.path = parsed.path or "/"
        if parsed.query:
            self.path += "?" + parsed.query
        self.sock = socket.create_connection((self.host, self.port), timeout=timeout)
        self.sock.settimeout(timeout)
        self.buf = bytearray()
        self._handshake()

    def _handshake(self):
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET {self.path} HTTP/1.1\r\n"
            f"Host: {self.host}:{self.port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        ).encode("ascii")
        self.sock.sendall(request)
        data = bytearray()
        while b"\r\n\r\n" not in data:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("DevTools WebSocket closed during handshake")
            data.extend(chunk)
            if len(data) > 65536:
                raise RuntimeError("DevTools WebSocket handshake was too large")
        head, rest = bytes(data).split(b"\r\n\r\n", 1)
        lines = head.decode("latin1").split("\r\n")
        if not lines or " 101 " not in (" " + lines[0] + " "):
            raise RuntimeError("DevTools WebSocket handshake failed: " + (lines[0] if lines else "unknown response"))
        headers = {}
        for line in lines[1:]:
            if ":" in line:
                k, v = line.split(":", 1)
                headers[k.strip().lower()] = v.strip()
        expected = base64.b64encode(hashlib.sha1((key + WS_GUID).encode("ascii")).digest()).decode("ascii")
        if headers.get("sec-websocket-accept") != expected:
            raise RuntimeError("DevTools WebSocket accept key did not match")
        self.buf.extend(rest)

    def _recv_exact(self, n: int) -> bytes:
        while len(self.buf) < n:
            chunk = self.sock.recv(max(4096, n - len(self.buf)))
            if not chunk:
                raise RuntimeError("DevTools WebSocket closed")
            self.buf.extend(chunk)
        out = bytes(self.buf[:n])
        del self.buf[:n]
        return out

    def _send_frame(self, opcode: int, payload: bytes):
        first = 0x80 | (opcode & 0x0F)
        length = len(payload)
        mask = os.urandom(4)
        if length < 126:
            header = bytes([first, 0x80 | length])
        elif length <= 0xFFFF:
            header = bytes([first, 0x80 | 126]) + struct.pack("!H", length)
        else:
            header = bytes([first, 0x80 | 127]) + struct.pack("!Q", length)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
        self.sock.sendall(header + mask + masked)

    def send_text(self, text: str):
        self._send_frame(0x1, text.encode("utf-8"))

    def recv_text(self) -> str:
        chunks = []
        started = False
        while True:
            b1, b2 = self._recv_exact(2)
            fin = bool(b1 & 0x80)
            opcode = b1 & 0x0F
            masked = bool(b2 & 0x80)
            length = b2 & 0x7F
            if length == 126:
                length = struct.unpack("!H", self._recv_exact(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self._recv_exact(8))[0]
            mask = self._recv_exact(4) if masked else None
            payload = self._recv_exact(length)
            if mask:
                payload = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
            if opcode == 0x8:
                raise RuntimeError("DevTools WebSocket closed")
            if opcode == 0x9:
                self._send_frame(0xA, payload)
                continue
            if opcode == 0xA:
                continue
            if opcode == 0x1:
                chunks = [payload]
                started = True
            elif opcode == 0x0 and started:
                chunks.append(payload)
            else:
                continue
            if fin:
                return b"".join(chunks).decode("utf-8", "replace")

    def close(self):
        try:
            self._send_frame(0x8, b"")
        except Exception:
            pass
        try:
            self.sock.close()
        except Exception:
            pass


class CDP:
    def __init__(self, ws_url: str):
        self.ws = WebSocket(ws_url)
        self.seq = 0

    def call(self, method: str, params=None):
        self.seq += 1
        request_id = self.seq
        self.ws.send_text(json.dumps({"id": request_id, "method": method, "params": params or {}}))
        while True:
            message = json.loads(self.ws.recv_text())
            if message.get("id") != request_id:
                continue
            if "error" in message:
                raise RuntimeError(f"CDP {method} failed: {message['error']}")
            return message.get("result") or {}

    def close(self):
        self.ws.close()


def main_target():
    with urllib.request.urlopen(CDP_LIST_URL, timeout=3) as response:
        targets = json.loads(response.read().decode("utf-8"))
    for target in targets:
        if target.get("type") == "page" and target.get("url") == TARGET_URL and target.get("webSocketDebuggerUrl"):
            return target
    raise RuntimeError("ChatGPT Desktop main Chat window is not available on 127.0.0.1:9223")


def visible_nodes(cdp: CDP):
    tree = cdp.call("Accessibility.getFullAXTree")
    return [node for node in tree.get("nodes", []) if not node.get("ignored")], tree.get("nodes", [])


def role(node):
    return ((node.get("role") or {}).get("value") or "")


def name(node):
    return str((node.get("name") or {}).get("value") or "")


def prop(node, prop_name):
    for item in node.get("properties") or []:
        if item.get("name") == prop_name:
            return (item.get("value") or {}).get("value")
    return None


def node_center(cdp: CDP, node):
    backend = node.get("backendDOMNodeId")
    if not backend:
        raise RuntimeError("Accessibility node has no DOM backing node")
    model = cdp.call("DOM.getBoxModel", {"backendNodeId": backend}).get("model") or {}
    quad = model.get("border") or model.get("content")
    if not quad or len(quad) < 8:
        raise RuntimeError("Could not locate ChatGPT control on screen")
    xs = quad[0::2]
    ys = quad[1::2]
    return (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2


def click_node(cdp: CDP, node):
    x, y = node_center(cdp, node)
    cdp.call("Input.dispatchMouseEvent", {"type": "mousePressed", "x": x, "y": y, "button": "left", "clickCount": 1})
    cdp.call("Input.dispatchMouseEvent", {"type": "mouseReleased", "x": x, "y": y, "button": "left", "clickCount": 1})


def choose_topmost(cdp: CDP, nodes):
    located = []
    for node in nodes:
        try:
            x, y = node_center(cdp, node)
            located.append((y, x, node))
        except Exception:
            pass
    if not located:
        return None
    located.sort(key=lambda item: (item[0], item[1]))
    return located[0][2]


def find_button(nodes, exact=None, prefix=None):
    matches = []
    for node in nodes:
        if role(node) != "button" or not node.get("backendDOMNodeId"):
            continue
        label = name(node)
        if exact is not None and label == exact:
            matches.append(node)
        elif prefix is not None and label.startswith(prefix):
            matches.append(node)
    return matches


def wait_for(cdp: CDP, predicate, timeout=8.0, interval=0.2):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        nodes, all_nodes = visible_nodes(cdp)
        value = predicate(nodes, all_nodes)
        if value:
            return value
        time.sleep(interval)
    return None


def ensure_chatgpt_mode(cdp: CDP):
    nodes, _ = visible_nodes(cdp)
    open_chatgpt_item = next(
        (n for n in nodes if role(n) == "menuitem" and name(n).startswith("ChatGPT ") and n.get("backendDOMNodeId")),
        None,
    )
    if open_chatgpt_item:
        click_node(cdp, open_chatgpt_item)
        time.sleep(0.4)
        nodes, _ = visible_nodes(cdp)

    mode_button = next((n for n in nodes if role(n) == "button" and name(n).startswith("Switch mode, current mode:")), None)
    if mode_button and "current mode: ChatGPT" in name(mode_button):
        return
    if not mode_button:
        raise RuntimeError("ChatGPT Desktop mode switch is unavailable")
    click_node(cdp, mode_button)

    item = wait_for(
        cdp,
        lambda ns, _: next(
            (n for n in ns if role(n) == "menuitem" and name(n).startswith("ChatGPT ") and n.get("backendDOMNodeId")),
            None,
        ),
        timeout=3.0,
    )
    if not item:
        raise RuntimeError("Could not open the ChatGPT/Codex mode menu")
    click_node(cdp, item)
    ok = wait_for(
        cdp,
        lambda ns, _: any(role(n) == "button" and "Switch mode, current mode: ChatGPT" in name(n) for n in ns),
        timeout=5.0,
    )
    if not ok:
        raise RuntimeError("Could not switch ChatGPT Desktop back to ChatGPT mode")


def ensure_chat_tab(cdp: CDP):
    nodes, _ = visible_nodes(cdp)
    chat = next((n for n in nodes if role(n) == "button" and name(n) == "Chat"), None)
    if not chat:
        return
    if prop(chat, "pressed") is True or str(prop(chat, "pressed")).lower() == "true":
        return
    click_node(cdp, chat)
    time.sleep(0.6)


def start_clean_temporary_chat(cdp: CDP):
    ensure_chatgpt_mode(cdp)

    nodes, _ = visible_nodes(cdp)
    new_button = choose_topmost(cdp, find_button(nodes, exact="New chat"))
    if not new_button:
        raise RuntimeError("ChatGPT Desktop New chat button is unavailable")
    click_node(cdp, new_button)

    ready = wait_for(
        cdp,
        lambda ns, _: any(role(n) == "textbox" and name(n) == "Ask ChatGPT" for n in ns),
        timeout=6.0,
    )
    if not ready:
        raise RuntimeError("ChatGPT Desktop did not open a new chat")

    ensure_chat_tab(cdp)
    nodes, _ = visible_nodes(cdp)
    if any(role(n) == "button" and name(n) == "Turn off temporary chat" for n in nodes):
        return

    temp_button = next(iter(find_button(nodes, exact="Temporary chat")), None)
    if not temp_button:
        raise RuntimeError("ChatGPT Desktop Temporary chat control is unavailable")
    click_node(cdp, temp_button)

    continue_button = wait_for(
        cdp,
        lambda ns, _: next(iter(find_button(ns, exact="Continue")), None),
        timeout=2.5,
    )
    if continue_button:
        click_node(cdp, continue_button)

    ok = wait_for(
        cdp,
        lambda ns, _: (
            any(role(n) == "button" and name(n) == "Turn off temporary chat" for n in ns)
            and any(role(n) == "textbox" and name(n) == "Ask ChatGPT" for n in ns)
        ),
        timeout=6.0,
    )
    if not ok:
        raise RuntimeError("ChatGPT Desktop could not enter Temporary chat")

def read_session_state():
    """Persist only thread identity and response digest, never full chat content."""
    try:
        data = json.loads(SESSION_STATE_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def answer_digest(answer: str) -> str:
    return hashlib.sha256(answer.strip().encode("utf-8")).hexdigest()


def can_resume_temporary_chat(cdp: CDP, target: dict, chat_id: str, state: dict) -> bool:
    """A temporary chat has no reliable history URL; verify the visible last reply."""
    if not chat_id or state.get("chat_id") != chat_id or state.get("target_id") != target.get("id"):
        return False
    expected = state.get("last_answer_digest")
    if not isinstance(expected, str) or len(expected) != 64:
        return False
    try:
        nodes, all_nodes = visible_nodes(cdp)
        if not any(role(n) == "button" and name(n) == "Turn off temporary chat" for n in nodes):
            return False
        if any(role(n) == "button" and name(n).lower().startswith("stop generating") for n in nodes):
            return False
        previous = latest_answer(all_nodes)
        return bool(previous) and answer_digest(previous) == expected
    except Exception:
        return False


def save_session_state(chat_id: str, target: dict, answer: str):
    if not chat_id:
        return
    SESSION_STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    state = {
        "chat_id": chat_id,
        "target_id": target.get("id"),
        "last_answer_digest": answer_digest(answer),
    }
    pending = SESSION_STATE_PATH.with_suffix(".tmp")
    try:
        with pending.open("w", encoding="utf-8") as output:
            os.chmod(pending, 0o600)
            json.dump(state, output, ensure_ascii=False)
        pending.replace(SESSION_STATE_PATH)
    finally:
        pending.unlink(missing_ok=True)


def focus_composer(cdp: CDP):
    nodes, _ = visible_nodes(cdp)
    textbox = next(
        (n for n in nodes if role(n) == "textbox" and name(n) == "Ask ChatGPT" and n.get("backendDOMNodeId")),
        None,
    )
    if not textbox:
        raise RuntimeError("ChatGPT Desktop composer is unavailable")
    cdp.call("DOM.focus", {"backendNodeId": textbox["backendDOMNodeId"]})
    cdp.call("Input.dispatchKeyEvent", {"type": "keyDown", "key": "a", "code": "KeyA", "windowsVirtualKeyCode": 65, "nativeVirtualKeyCode": 65, "modifiers": 2})
    cdp.call("Input.dispatchKeyEvent", {"type": "keyUp", "key": "a", "code": "KeyA", "windowsVirtualKeyCode": 65, "nativeVirtualKeyCode": 65, "modifiers": 2})
    cdp.call("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Backspace", "code": "Backspace", "windowsVirtualKeyCode": 8, "nativeVirtualKeyCode": 8})
    cdp.call("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Backspace", "code": "Backspace", "windowsVirtualKeyCode": 8, "nativeVirtualKeyCode": 8})


def send_prompt(cdp: CDP, prompt: str):
    focus_composer(cdp)
    cdp.call("Input.insertText", {"text": prompt})
    cdp.call("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13})
    cdp.call("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Enter", "code": "Enter", "windowsVirtualKeyCode": 13, "nativeVirtualKeyCode": 13})


def subtree_plain_text(all_nodes, root_id):
    """Serialize ChatGPT's accessibility tree to readable Markdown.

    In the desktop UI, inline <code> elements have AX role 'code' too.
    The old bridge fenced *every* AX code node, corrupting inline values,
    table cells and code samples with dozens of stray '~~~' sequences.
    This serializer uses each node's AX parent to distinguish them and
    handles native accessible tables as Markdown tables.
    """
    by_id = {node.get("nodeId"): node for node in all_nodes}

    def children_of(node):
        return [by_id[cid] for cid in node.get("childIds") or [] if cid in by_id]

    def descendants(node, target):
        """Find table/row descendants while not crossing into nested tables."""
        found = []
        for child in children_of(node):
            low = role(child).lower()
            if low == target:
                found.append(child)
            elif low != "table" and low not in {"row", "cell", "columnheader", "rowheader"}:
                found.extend(descendants(child, target))
        return found

    def inline_code(text):
        value = text.strip()
        longest = max((len(m.group()) for m in re.finditer(r"`+", value)), default=0)
        tick = "`" * (longest + 1)
        padded = " " if value.startswith("`") or value.endswith("`") else ""
        return tick + padded + value + padded + tick

    def render(node):
        if not node:
            return ""
        node_role = role(node)
        node_name = name(node)
        low = node_role.lower()
        if low == "inlinetextbox":
            return ""
        if low == "statictext":
            return node_name

        children = children_of(node)
        if low == "table":
            rows = []
            for row in descendants(node, "row"):
                cells = []
                headers = []
                for cell in children_of(row):
                    candidates = [cell] if role(cell).lower() in {"columnheader", "rowheader", "cell"} else (
                        descendants(cell, "columnheader") + descendants(cell, "rowheader") + descendants(cell, "cell")
                    )
                    for candidate in candidates:
                        text = render(candidate).strip()
                        text = re.sub(r"\s*\n+\s*", "<br>", text)
                        cells.append(text.replace("|", r"\|"))
                        headers.append(role(candidate).lower() in {"columnheader", "rowheader"})
                if cells:
                    rows.append((cells, all(headers)))
            if rows and rows[0][0]:
                count = len(rows[0][0])
                rows = [(cells, hdr) for cells, hdr in rows if len(cells) == count]
                if rows:
                    output = ["| " + " | ".join(rows[0][0]) + " |",
                              "| " + " | ".join(["---"] * count) + " |"]
                    output.extend("| " + " | ".join(cells) + " |" for cells, _ in rows[1:])
                    return "\n\n" + "\n".join(output) + "\n\n"

        inner = "".join(render(child) for child in children)
        if low == "paragraph":
            return inner.strip() + "\n\n" if inner.strip() else ""
        if low == "heading":
            level = prop(node, "level")
            try:
                level = max(1, min(6, int(level)))
            except Exception:
                level = 2
            text = inner.strip() or node_name.strip()
            return ("#" * level + " " + text + "\n\n") if text else ""
        if low == "listitem":
            marker = next((name(c).strip() for c in children if role(c).lower() == "listmarker"), "")
            bullet = marker if re.match(r"^\d+[.)]$", marker) else "-"
            text = "".join(render(child) for child in children if role(child).lower() != "listmarker").strip()
            return (bullet + " " + text.replace("\n\n", "\n  ") + "\n") if text else ""
        if low == "list":
            return inner.rstrip() + "\n\n" if inner.strip() else ""
        if low == "code":
            text = inner.strip() or node_name.strip()
            if not text:
                return ""
            parent = by_id.get(node.get("parentId"))
            # Normal inline code is a child of an AX paragraph (including
            # table cell paragraphs). Actual code panes have a generic parent.
            if parent and role(parent).lower() in {"paragraph", "cell", "columnheader", "rowheader", "heading", "listitem", "link"}:
                return inline_code(text)
            fence = "~" * max(3, 1 + max((len(m.group()) for m in re.finditer(r"~{3,}", text)), default=0))
            return "\n\n" + fence + "\n" + text + "\n" + fence + "\n\n"
        if low == "pre":
            text = inner.strip() or node_name.strip()
            return ("\n\n~~~\n" + text + "\n~~~\n\n") if text else ""
        if low == "blockquote":
            text = inner.strip()
            return "\n".join("> " + line for line in text.splitlines()) + "\n\n" if text else ""
        if low in {"linebreak", "separator"}:
            return "\n"
        if not children and node_name and low == "link":
            return node_name
        return inner

    text = render(by_id.get(root_id)).strip()
    return re.sub(r"\n{3,}", "\n\n", text)


def latest_answer(all_nodes):
    by_id = {node.get("nodeId"): node for node in all_nodes}
    visible = [node for node in all_nodes if not node.get("ignored")]
    markers = [node for node in visible if role(node) == "StaticText" and name(node) == "ChatGPT said:"]
    if not markers:
        return ""
    marker = markers[-1]
    heading = by_id.get(marker.get("parentId"))
    holder = by_id.get(heading.get("parentId")) if heading else None
    if not holder:
        return ""
    answer_root = next(
        (by_id.get(cid) for cid in holder.get("childIds") or [] if cid != heading.get("nodeId")),
        None,
    )
    if not answer_root:
        return ""
    return subtree_plain_text(all_nodes, answer_root.get("nodeId"))


def assistant_reply_count(all_nodes):
    return sum(
        1 for node in all_nodes
        if not node.get("ignored") and role(node) == "StaticText" and name(node) == "ChatGPT said:"
    )


def wait_for_answer(cdp: CDP, timeout: float, baseline_reply_count: int = 0):
    deadline = time.monotonic() + timeout
    previous = ""
    stable = 0
    latest = ""
    still_generating = False
    while time.monotonic() < deadline:
        nodes, all_nodes = visible_nodes(cdp)
        # Continued chats already have a complete previous assistant reply.
        # Ignore it until the next assistant turn appears, otherwise the
        # bridge would instantly return the old answer as the new response.
        if assistant_reply_count(all_nodes) <= baseline_reply_count:
            time.sleep(0.65)
            continue
        answer = latest_answer(all_nodes)
        if answer:
            latest = answer
            if answer == previous:
                stable += 1
            else:
                stable = 0
                previous = answer
            button_names = [name(n).lower() for n in nodes if role(n) == "button"]
            stopping = any(label.startswith("stop") or "stop generating" in label for label in button_names)
            still_generating = stopping
            has_copy = any(label == "copy" for label in button_names)
            has_latest = any(role(n) == "StaticText" and name(n) == "Latest response" for n in nodes)
            has_send = any(label == "send" for label in button_names)
            if stable >= 2 and not stopping and (has_copy or has_latest or has_send):
                return answer
        time.sleep(0.65)
    if latest and not still_generating:
        return latest
    raise RuntimeError(
        f"ChatGPT Desktop did not finish within {int(timeout // 60)} minutes; "
        "the desktop application may still be generating a reply."
    )


def run(first_prompt: str, continuation_prompt: str, timeout: float, chat_id: str = ""):
    target = main_target()
    cdp = CDP(target["webSocketDebuggerUrl"])
    try:
        cdp.call("Accessibility.enable")
        cdp.call("DOM.enable")
        state = read_session_state()
        continued = can_resume_temporary_chat(cdp, target, chat_id, state)
        if not continued:
            start_clean_temporary_chat(cdp)
        # A continued chat already contains the earlier messages. A recovered
        # chat instead gets the context reconstructed by CodePilot.
        _, before_nodes = visible_nodes(cdp)
        baseline_reply_count = assistant_reply_count(before_nodes)
        send_prompt(cdp, continuation_prompt if continued else first_prompt)
        answer = wait_for_answer(cdp, timeout, baseline_reply_count)
        try:
            save_session_state(chat_id, target, answer)
        except OSError as exc:
            # A read-only or full state directory should not discard a valid
            # ChatGPT response. The next request can rebuild from saved history.
            print(f"ChatGPT Desktop session state could not be saved: {exc}", file=sys.stderr)
        return answer, ("continued" if continued else "recovered" if chat_id and state.get("chat_id") == chat_id else "new")
    finally:
        cdp.close()


def check():
    target = main_target()
    cdp = CDP(target["webSocketDebuggerUrl"])
    try:
        cdp.call("Accessibility.enable")
        nodes, _ = visible_nodes(cdp)
        mode = next((name(n) for n in nodes if role(n) == "button" and name(n).startswith("Switch mode, current mode:")), None)
        return {"ok": True, "target": target.get("url"), "mode": mode}
    finally:
        cdp.close()


def main():
    parser = argparse.ArgumentParser(description="CodePilot bridge to normal ChatGPT Desktop Chat")
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--timeout", type=float, default=180.0)
    args = parser.parse_args()
    try:
        if args.check:
            print(json.dumps(check(), ensure_ascii=False))
            return 0
        raw_prompt = sys.stdin.read()
        if not raw_prompt.strip():
            raise RuntimeError("No prompt was provided on stdin")
        # Structured input preserves both context recovery and lightweight
        # follow-ups. Plain-text stdin remains supported for older callers.
        try:
            request = json.loads(raw_prompt)
        except ValueError:
            request = None
        if isinstance(request, dict) and "first_prompt" in request and "continuation_prompt" in request:
            first_prompt = str(request["first_prompt"])
            continuation_prompt = str(request["continuation_prompt"])
            chat_id = str(request.get("chat_id") or "")[:128]
        else:
            first_prompt = continuation_prompt = raw_prompt
            chat_id = ""
        if not first_prompt.strip() or not continuation_prompt.strip():
            raise RuntimeError("A ChatGPT Desktop prompt is empty")
        result, conversation_mode = run(first_prompt, continuation_prompt, args.timeout, chat_id)
        print(json.dumps({
            "ok": True,
            "result": result,
            "conversation": {"mode": conversation_mode, "temporary": True},
            "tokens": {"total": None, "input": None, "output": None},
            "cost_usd": None,
            "inference": {"provider": "chatgpt_desktop", "requestedModel": "ChatGPT Desktop · Chat"},
            "status": "completed",
        }, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(f"ChatGPT Desktop bridge error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())