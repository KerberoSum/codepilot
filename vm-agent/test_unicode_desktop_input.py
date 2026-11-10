#!/usr/bin/env python3
"""Focused Unicode injection tests (no clipboard or GUI changes)."""
import pathlib
import sys
import types
import unittest
from unittest.mock import patch

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import desktop_relay as relay

class Result:
    def __init__(self, stdout=b"", returncode=0):
        self.stdout=stdout
        self.returncode=returncode

class UnicodeInputTests(unittest.TestCase):
    def test_traditional_chinese_is_pasted_and_clipboard_restored(self):
        calls=[]
        def fake_run(args, **kwargs):
            calls.append((args, kwargs))
            return Result(stdout=b"original clipboard")
        actions=[]
        with patch.object(relay.subprocess,"run",side_effect=fake_run), \
             patch.object(relay,"fake_key",side_effect=lambda *a:actions.append(("fake",a[1],a[2]))), \
             patch.object(relay,"tap_key",side_effect=lambda *a:actions.append(("tap",a[1]))), \
             patch.object(relay.X11,"XFlush"), \
             patch.object(relay.time,"sleep"):
            relay.type_unicode(123, "繁體中文，香港")
        self.assertEqual(calls[0][0][-1],"-o")
        clipboard_writes = [args["input"] for command, args in calls if "-i" in command]
        self.assertEqual(clipboard_writes,[
            "繁體中文，香港".encode("utf-8"), b"original clipboard",
        ])
        self.assertEqual(actions,[("fake",relay.SPECIAL["Control"],True),("tap",ord("v")),("fake",relay.SPECIAL["Control"],False)])

    def test_terminal_paste_uses_control_shift_v(self):
        events=[]
        def fake_run(args, **kwargs):
            return Result(stdout=b"old")
        with patch.object(relay.subprocess, "run", side_effect=fake_run), \
             patch.object(relay,"active_terminal_window", return_value=True), \
             patch.object(relay,"fake_key", side_effect=lambda *a:events.append(("fake",a[1],a[2]))), \
             patch.object(relay,"tap_key", side_effect=lambda *a:events.append(("tap",a[1]))), \
             patch.object(relay.X11,"XFlush"), patch.object(relay.time,"sleep"):
            relay.type_unicode(123,"測試")
        self.assertEqual(events,[
            ("fake",relay.SPECIAL["Control"],True),
            ("fake",relay.SPECIAL["Shift"],True),
            ("tap",ord("v")),
            ("fake",relay.SPECIAL["Shift"],False),
            ("fake",relay.SPECIAL["Control"],False),
        ])

    def test_unreadable_clipboard_is_cleared_after_paste(self):
        calls=[]
        def fake_run(args,**kwargs):
            calls.append((args,kwargs))
            if "-o" in args:return Result(returncode=1)
            return Result()
        with patch.object(relay.subprocess,"run",side_effect=fake_run), \
             patch.object(relay,"fake_key"),patch.object(relay,"tap_key"), \
             patch.object(relay.X11,"XFlush"),patch.object(relay.time,"sleep"):
            relay.type_unicode(123,"你好")
        self.assertEqual(calls[-1][1]["input"],b"")

    def test_empty_text_does_not_touch_clipboard(self):
        with patch.object(relay.subprocess,"run") as run:
            relay.type_unicode(123,"")
            run.assert_not_called()

    def test_ascii_uses_original_keyboard_path(self):
        with patch.object(relay,"open_display",return_value=42), \
             patch.object(relay.X11,"XDefaultRootWindow",return_value=1), \
             patch.object(relay,"display_size",return_value=(1440,900)), \
             patch.object(relay,"type_ascii") as ascii_type, \
             patch.object(relay,"type_unicode") as unicode_type, \
             patch.object(relay.X11,"XFlush"),patch.object(relay.X11,"XCloseDisplay"):
            relay.handle_input({"type":"text","text":"Hello!"})
            ascii_type.assert_called_once_with(42,"Hello!")
            unicode_type.assert_not_called()

    def test_chinese_is_routed_to_unicode(self):
        with patch.object(relay,"open_display",return_value=42), \
             patch.object(relay.X11,"XDefaultRootWindow",return_value=1), \
             patch.object(relay,"display_size",return_value=(1440,900)), \
             patch.object(relay,"type_ascii") as ascii_type, \
             patch.object(relay,"type_unicode") as unicode_type, \
             patch.object(relay.X11,"XFlush"),patch.object(relay.X11,"XCloseDisplay"):
            relay.handle_input({"type":"text","text":"臺灣繁體、abc。"})
            unicode_type.assert_called_once_with(42,"臺灣繁體、abc。")
            ascii_type.assert_not_called()

if __name__=="__main__":
    unittest.main()
