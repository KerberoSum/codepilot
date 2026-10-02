#!/usr/bin/env python3
import ctypes
import io
import json
import os
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from PIL import Image

HOST = "127.0.0.1"
PORT = int(os.environ.get("CODEPILOT_DESKTOP_RELAY_PORT", "8770"))
DISPLAY = os.environ.get("DISPLAY", ":1")
XAUTHORITY = os.environ.get("XAUTHORITY", "/home/ubuntu/.Xauthority")
ENV = {**os.environ, "DISPLAY": DISPLAY, "XAUTHORITY": XAUTHORITY}
capture_lock = threading.Lock()

X11 = ctypes.CDLL("libX11.so.6")
XTST = ctypes.CDLL("libXtst.so.6")
X11.XOpenDisplay.restype = ctypes.c_void_p
X11.XCloseDisplay.argtypes = [ctypes.c_void_p]
X11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
X11.XDefaultRootWindow.restype = ctypes.c_ulong
X11.XDisplayWidth.argtypes = [ctypes.c_void_p, ctypes.c_int]
X11.XDisplayHeight.argtypes = [ctypes.c_void_p, ctypes.c_int]
X11.XDisplayKeycodes.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)]
X11.XGetKeyboardMapping.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
X11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
X11.XFree.argtypes = [ctypes.c_void_p]
XTST.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
XTST.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
X11.XWarpPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_int, ctypes.c_int]
X11.XFlush.argtypes = [ctypes.c_void_p]

SPECIAL = {
    "Enter": 0xff0d, "Backspace": 0xff08, "Tab": 0xff09, "Escape": 0xff1b,
    "ArrowLeft": 0xff51, "ArrowUp": 0xff52, "ArrowRight": 0xff53, "ArrowDown": 0xff54,
    "Delete": 0xffff, "Home": 0xff50, "End": 0xff57, "PageUp": 0xff55, "PageDown": 0xff56,
    "Shift": 0xffe1, "Control": 0xffe3, "Alt": 0xffe9, "Meta": 0xffeb,
}

def open_display():
    d = X11.XOpenDisplay(DISPLAY.encode())
    if not d:
        raise RuntimeError(f"Cannot open X display {DISPLAY}")
    return d

def display_size(d):
    return X11.XDisplayWidth(d, 0), X11.XDisplayHeight(d, 0)

def fake_key(d, keysym, down=True):
    code = X11.XKeysymToKeycode(d, keysym)
    if not code:
        raise RuntimeError(f"No keycode for keysym {keysym}")
    XTST.XTestFakeKeyEvent(d, code, 1 if down else 0, 0)

def tap_key(d, keysym):
    fake_key(d, keysym, True)
    fake_key(d, keysym, False)

def type_ascii(d, text):
    shift_sym = 0xffe1
    # X keyboard layout mapping is used for common ASCII. Characters not present are skipped.
    min_code = ctypes.c_int()
    max_code = ctypes.c_int()
    X11.XDisplayKeycodes(d, ctypes.byref(min_code), ctypes.byref(max_code))
    per = ctypes.c_int()
    X11.XGetKeyboardMapping.restype = ctypes.POINTER(ctypes.c_ulong)
    arr = X11.XGetKeyboardMapping(d, min_code.value, max_code.value - min_code.value + 1, ctypes.byref(per))
    mapping = {}
    try:
        for code in range(min_code.value, max_code.value + 1):
            base = (code - min_code.value) * per.value
            for level in range(per.value):
                sym = arr[base + level]
                if sym and sym not in mapping:
                    mapping[sym] = (code, level)
    finally:
        X11.XFree(arr)
    shift_code = X11.XKeysymToKeycode(d, shift_sym)
    for ch in text:
        item = mapping.get(ord(ch))
        if not item:
            continue
        code, level = item
        shifted = (level % 2) == 1
        if shifted:
            XTST.XTestFakeKeyEvent(d, shift_code, 1, 0)
        XTST.XTestFakeKeyEvent(d, code, 1, 0)
        XTST.XTestFakeKeyEvent(d, code, 0, 0)
        if shifted:
            XTST.XTestFakeKeyEvent(d, shift_code, 0, 0)

def capture_jpeg(max_width=None, quality=None):
    max_width = max(480, min(1440, int(max_width or os.environ.get("CODEPILOT_DESKTOP_MAX_WIDTH", "1280"))))
    quality = max(30, min(82, int(quality or os.environ.get("CODEPILOT_DESKTOP_JPEG_QUALITY", "58"))))
    with capture_lock:
        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
            path = f.name
        try:
            subprocess.run(
                ["/usr/bin/xfce4-screenshooter", "-f", "-s", path],
                env=ENV,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,
                timeout=8,
            )
            with Image.open(path) as im:
                im = im.convert("RGB")
                source_w, source_h = im.size
                if im.width > max_width:
                    ratio = max_width / im.width
                    im = im.resize((max_width, max(1, int(im.height * ratio))))
                out = io.BytesIO()
                im.save(out, format="JPEG", quality=quality, optimize=True)
                return out.getvalue(), source_w, source_h
        finally:
            try:
                Path(path).unlink()
            except OSError:
                pass

def handle_input(data):
    kind = str(data.get("type", ""))
    d = open_display()
    root = X11.XDefaultRootWindow(d)
    width, height = display_size(d)
    try:
        if kind in {"move", "mouse_down", "mouse_up", "click", "double_click"}:
            nx = max(0.0, min(1.0, float(data.get("x", 0))))
            ny = max(0.0, min(1.0, float(data.get("y", 0))))
            x = min(width - 1, max(0, round(nx * (width - 1))))
            y = min(height - 1, max(0, round(ny * (height - 1))))
            X11.XWarpPointer(d, 0, root, 0, 0, 0, 0, x, y)
            button = int(data.get("button", 1))
            if kind == "mouse_down":
                XTST.XTestFakeButtonEvent(d, button, 1, 0)
            elif kind == "mouse_up":
                XTST.XTestFakeButtonEvent(d, button, 0, 0)
            elif kind == "click":
                XTST.XTestFakeButtonEvent(d, button, 1, 0)
                XTST.XTestFakeButtonEvent(d, button, 0, 0)
            elif kind == "double_click":
                for index in range(2):
                    XTST.XTestFakeButtonEvent(d, button, 1, 0)
                    XTST.XTestFakeButtonEvent(d, button, 0, 0)
                    X11.XFlush(d)
                    if index == 0:
                        time.sleep(0.08)
        elif kind == "wheel":
            delta = float(data.get("deltaY", 0))
            button = 5 if delta > 0 else 4
            count = max(1, min(6, int(abs(delta) / 60) or 1))
            for _ in range(count):
                XTST.XTestFakeButtonEvent(d, button, 1, 0)
                XTST.XTestFakeButtonEvent(d, button, 0, 0)
        elif kind == "text":
            type_ascii(d, str(data.get("text", ""))[:500])
        elif kind == "key":
            key = str(data.get("key", ""))
            keysym = SPECIAL.get(key)
            if keysym:
                tap_key(d, keysym)
        elif kind == "chord":
            keys = [str(k) for k in data.get("keys", [])][:4]
            syms = [SPECIAL.get(k) or (ord(k) if len(k) == 1 else None) for k in keys]
            syms = [s for s in syms if s]
            for sym in syms:
                fake_key(d, sym, True)
            for sym in reversed(syms):
                fake_key(d, sym, False)
        else:
            raise ValueError("Unsupported input type")
        X11.XFlush(d)
        return {"ok": True, "width": width, "height": height}
    finally:
        X11.XCloseDisplay(d)

class Handler(BaseHTTPRequestHandler):
    server_version = "CodePilotDesktopRelay/1.0"

    def log_message(self, fmt, *args):
        return

    def _json(self, status, payload):
        raw = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/health"):
            try:
                d = open_display()
                w, h = display_size(d)
                X11.XCloseDisplay(d)
                self._json(200, {"ok": True, "display": DISPLAY, "width": w, "height": h})
            except Exception as e:
                self._json(503, {"ok": False, "error": str(e)})
            return
        if parsed.path.startswith("/frame"):
            try:
                query = parse_qs(parsed.query)
                quality = query.get("quality", [None])[0]
                max_width = query.get("max_width", [None])[0]
                raw, w, h = capture_jpeg(max_width=max_width, quality=quality)
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(raw)))
                self.send_header("Cache-Control", "no-store, max-age=0")
                self.send_header("X-CodePilot-Width", str(w))
                self.send_header("X-CodePilot-Height", str(h))
                self.end_headers()
                self.wfile.write(raw)
            except Exception as e:
                self._json(503, {"ok": False, "error": str(e)})
            return
        self._json(404, {"ok": False, "error": "Not found"})

    def do_POST(self):
        if not self.path.startswith("/input"):
            self._json(404, {"ok": False, "error": "Not found"})
            return
        try:
            length = min(int(self.headers.get("Content-Length", "0") or "0"), 65536)
            data = json.loads(self.rfile.read(length) or b"{}")
            self._json(200, handle_input(data))
        except Exception as e:
            self._json(400, {"ok": False, "error": str(e)})

if __name__ == "__main__":
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.serve_forever()