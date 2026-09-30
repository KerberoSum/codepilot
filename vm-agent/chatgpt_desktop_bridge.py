#!/usr/bin/env python3
import argparse
import base64
import hashlib
import json
import os
import re
import socket
import struct
import sys
import time
import urllib.parse
import urllib.request

CDP_LIST_URL = os.environ.get("CHATGPT_DESKTOP_CDP_LIST", "http://127.0.0.1:9223/json/list")
TARGET_URL = "app://-/index.html"
WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


class WebSocket:
    def __init__(self, url: str, timeout: float = 10.0):
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
    by_id = {node.get("nodeId"): node for node in all_nodes}

    def render(node):
        if not node:
            return ""
        node_role = role(node)
        node_name = name(node)
        if node_role == "InlineTextBox":
            return ""
        if node_role == "StaticText":
            return node_name
        children = [by_id.get(cid) for cid in node.get("childIds") or []]
        inner = "".join(render(child) for child in children if child)
        low = node_role.lower()

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
            text = inner.strip()
            return ("- " + text.replace("\n\n", "\n  ") + "\n") if text else ""
        if low == "list":
            return inner.rstrip() + "\n\n" if inner.strip() else ""
        if low in {"code", "pre"}:
            text = inner.strip() or node_name.strip()
            return ("~~~\n" + text + "\n~~~\n\n") if text else ""
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


def wait_for_answer(cdp: CDP, timeout: float):
    deadline = time.monotonic() + timeout
    previous = ""
    stable = 0
    latest = ""
    while time.monotonic() < deadline:
        nodes, all_nodes = visible_nodes(cdp)
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
            has_copy = any(label == "copy" for label in button_names)
            has_latest = any(role(n) == "StaticText" and name(n) == "Latest response" for n in nodes)
            has_send = any(label == "send" for label in button_names)
            if stable >= 2 and not stopping and (has_copy or has_latest or has_send):
                return answer
        time.sleep(0.65)
    if latest:
        return latest
    raise RuntimeError("Timed out waiting for ChatGPT Desktop reply")


def run(prompt: str, timeout: float):
    target = main_target()
    cdp = CDP(target["webSocketDebuggerUrl"])
    try:
        cdp.call("Accessibility.enable")
        cdp.call("DOM.enable")
        start_clean_temporary_chat(cdp)
        send_prompt(cdp, prompt)
        return wait_for_answer(cdp, timeout)
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
        prompt = sys.stdin.read()
        if not prompt.strip():
            raise RuntimeError("No prompt was provided on stdin")
        result = run(prompt, args.timeout)
        print(json.dumps({
            "ok": True,
            "result": result,
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