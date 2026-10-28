#!/usr/bin/env python3
"""Offline tests for CodePilot's Temporary Chat continuity and safe recovery."""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import chatgpt_desktop_bridge as bridge

REAL_WAIT_FOR_ANSWER = bridge.wait_for_answer


class FakeCDP:
    def __init__(self, url):
        self.url = url
        self.closed = False
        self.methods = []

    def call(self, method, params=None):
        self.methods.append(method)
        return {}

    def close(self):
        self.closed = True


class ContinuityTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state_file = Path(self.temp.name) / "session.json"
        self.addCleanup(patch.stopall)
        patch.object(bridge, "SESSION_STATE_PATH", self.state_file).start()
        patch.object(bridge, "CDP", FakeCDP).start()
        patch.object(bridge, "main_target", lambda: {"id": self.target_id, "webSocketDebuggerUrl": "ws://127.0.0.1:9223/devtools/page/demo"}).start()
        patch.object(bridge, "start_clean_temporary_chat", self.start_chat).start()
        patch.object(bridge, "send_prompt", self.send).start()
        patch.object(bridge, "wait_for_answer", self.answer).start()
        patch.object(bridge, "visible_nodes", self.visible).start()
        patch.object(bridge, "latest_answer", lambda _: self.visible_answer).start()
        self.target_id = "desktop-target-1"
        self.visible_answer = ""
        self.temporary_on = True
        self.new_chats = 0
        self.sent_prompts = []
        self.next_answer = "First assistant reply"

    def visible(self, cdp):
        if self.temporary_on:
            return ([{"role": {"value": "button"}, "name": {"value": "Turn off temporary chat"}}], [])
        return ([], [])

    def start_chat(self, cdp):
        self.new_chats += 1
        self.visible_answer = ""
        self.temporary_on = True

    def send(self, cdp, prompt):
        self.sent_prompts.append(prompt)

    def answer(self, cdp, timeout, baseline_reply_count=0):
        self.visible_answer = self.next_answer
        return self.next_answer

    def ask(self, chat_id="chat-one", first="Context: previous user messages", followup="New question"):
        return bridge.run(first, followup, 30.0, chat_id)

    def test_first_request_starts_new_chat(self):
        reply, mode = self.ask()
        self.assertEqual((reply, mode), ("First assistant reply", "new"))
        self.assertEqual(self.new_chats, 1)
        self.assertEqual(self.sent_prompts[-1], "Context: previous user messages")
        self.assertEqual(self.state_file.stat().st_mode & 0o777, 0o600)
        state = json.loads(self.state_file.read_text())
        self.assertEqual(state["chat_id"], "chat-one")
        self.assertNotIn("First assistant reply", self.state_file.read_text())

    def test_followup_reuses_same_temporary_chat(self):
        self.ask()
        self.next_answer = "Second reply"
        reply, mode = self.ask(followup="Followup only")
        self.assertEqual((reply, mode), ("Second reply", "continued"))
        self.assertEqual(self.new_chats, 1)
        self.assertEqual(self.sent_prompts[-1], "Followup only")

    def test_switching_codepilot_chats_starts_new_chat(self):
        self.ask()
        self.next_answer = "Other chat reply"
        _, mode = self.ask(chat_id="chat-two", first="Other chat context")
        self.assertEqual(mode, "new")
        self.assertEqual(self.new_chats, 2)
        self.assertEqual(self.sent_prompts[-1], "Other chat context")

    def test_returning_to_old_chat_recovers_with_context(self):
        self.ask()
        self.ask(chat_id="chat-two", first="Other chat context")
        _, mode = self.ask(chat_id="chat-one", first="Full recovered context")
        self.assertEqual(mode, "new")
        self.assertEqual(self.sent_prompts[-1], "Full recovered context")
        self.assertEqual(self.new_chats, 3)

    def test_manually_switched_desktop_chat_rebuilds_context(self):
        self.ask()
        self.visible_answer = "Unrelated manual conversation"
        _, mode = self.ask(first="Recovery with history")
        self.assertEqual(mode, "recovered")
        self.assertEqual(self.new_chats, 2)
        self.assertEqual(self.sent_prompts[-1], "Recovery with history")

    def test_desktop_restart_rebuilds_context(self):
        self.ask()
        self.target_id = "fresh-desktop-target"
        _, mode = self.ask(first="Context after app restart")
        self.assertEqual(mode, "recovered")
        self.assertEqual(self.sent_prompts[-1], "Context after app restart")

    def test_temporary_mode_off_rebuilds_context(self):
        self.ask()
        self.temporary_on = False
        _, mode = self.ask(first="Recover after temp off")
        self.assertEqual(mode, "recovered")
        self.assertEqual(self.sent_prompts[-1], "Recover after temp off")

    def test_corrupt_state_starts_fresh(self):
        self.state_file.write_text("{invalid")
        _, mode = self.ask()
        self.assertEqual(mode, "new")
        self.assertEqual(self.new_chats, 1)


    def test_wait_ignores_previous_assistant_reply(self):
        button = [{"role": {"value": "button"}, "name": {"value": "Copy"}}]
        marker = {"role": {"value": "StaticText"}, "name": {"value": "ChatGPT said:"}}
        old = [marker]
        new = [marker, marker]
        frames = [(button, old)] + [(button, new)] * 4
        with patch.object(bridge, "visible_nodes", side_effect=frames), \
             patch.object(bridge, "latest_answer", return_value="Same answer"), \
             patch.object(bridge.time, "sleep", return_value=None):
            # Even if two successive replies have the exact same words,
            # a new assistant turn should be identified by its marker count.
            text = REAL_WAIT_FOR_ANSWER(FakeCDP("ws://unused"), 5.0, baseline_reply_count=1)
            self.assertEqual(text, "Same answer")


if __name__ == "__main__":
    unittest.main()
