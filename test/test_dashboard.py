"""Node-free dashboard tests: python3 -m unittest discover -s test -p 'test_dashboard*.py'."""
import contextlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from review_character_counts import (JsonlFollower, ReviewCounts, configured_log_path, extract_text,
                                     prepare_text, read_jsonl, recover_counts)


class TextTests(unittest.TestCase):
    def test_filters(self):
        for text in ["", "Thanks!", "/feedback on", " !ls", "```ts\nconst value = 1;\n```",
                     "> quoted document", "`someFunction()`", "https://example.org",
                     "``release`candidate``", "`dev` / `main`", "```inline``` ",
                     "https://example.org.", "https://example.org http://example.net",
                     "`dev` https://example.org", "`https://example.org`", "<https://example.org>"]:
            with self.subTest(text=text):
                self.assertIsNone(prepare_text(text))
        cases = {
            "Anything needs adressing?\n```ts\nconst a = 1\n```": "Anything needs adressing?",
            "You can commit, push to `dev` and restart the services.": "You can commit, push to `dev` and restart the services.",
            "Push to ``release`candidate`` and restart.": "Push to ``release`candidate`` and restart.",
            "\ufeffSome prose.\ufeff": "Some prose.",
            "\u0085Some prose.\u0085": "\u0085Some prose.\u0085",
            "Some prose.\n> Quoted text\nMore prose.": "Some prose.\n\nMore prose.",
            "Some prose.\r\n> Quoted text\r\nMore prose.": "Some prose.\r\r\nMore prose.",
            "Some prose.\n~~~~py\ncode\n~~~~\nMore prose.": "Some prose.\n\nMore prose.",
            "See https://example.org and http://example.net.": "See https://example.org and http://example.net.",
            "Open (https://example.org/path). Then continue.": "Open (https://example.org/path). Then continue.",
            "See [the document](https://example.org/doc). Also, check `dev`.": "See [the document](https://example.org/doc). Also, check `dev`.",
            "Update the section: https://docs.example.org/edit?tab=t.0#heading=h.example. Also, create an issue.": "Update the section: https://docs.example.org/edit?tab=t.0#heading=h.example. Also, create an issue.",
            "Emoji 😀 and café.": "Emoji 😀 and café.",
        }
        for text, expected in cases.items():
            with self.subTest(text=text):
                self.assertEqual(prepare_text(text), expected)
        self.assertEqual(prepare_text("a" * 100001), "a" * 100001)

    def test_extract_text(self):
        self.assertEqual(extract_text("hello"), "hello")
        self.assertEqual(extract_text(None), "")
        self.assertEqual(extract_text([None, "ignored", {"type": "image"},
                                      {"type": "text", "text": "Hello"},
                                      {"type": "text", "text": 42},
                                      {"type": "text", "text": "world 😀"}]), "Hello\nworld 😀")


class FileTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        env = patch.dict(os.environ, {"HOME": str(self.root), "PI_CODING_AGENT_DIR": "",
                                    "PI_CORRECTIVE_FEEDBACK_CONFIG": "",
                                    "CLAUDE_CORRECTIVE_FEEDBACK_CONFIG": ""})
        env.start()
        self.addCleanup(env.stop)

    def write_rows(self, name, rows):
        path = self.root / name
        path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")
        return path

    def record(self, identifier="review", **overrides):
        return {"id": identifier, "timestamp": "2026-01-01T12:00:00Z", "model": "test-model",
                "sessionPath": str(self.root / "session.jsonl"), "userMessageId": "message",
                "corrections": [], **overrides}

    def test_config_paths(self):
        self.assertEqual(configured_log_path("pi"), self.root / ".pi/agent/corrective-feedback/feedback.jsonl")
        self.assertEqual(configured_log_path("claude"), self.root / ".pi/agent/corrective-feedback/claude-feedback.jsonl")
        with patch.dict(os.environ, {"PI_CODING_AGENT_DIR": "~/custom"}):
            self.assertEqual(configured_log_path("pi"), self.root / "custom/corrective-feedback/feedback.jsonl")
        for host in ("pi", "claude"):
            config = self.root / f"{host}.json"
            with patch.dict(os.environ, {f"{host.upper()}_CORRECTIVE_FEEDBACK_CONFIG": str(config)}):
                for value, expected in [("logs/reviews.jsonl", self.root / "logs/reviews.jsonl"),
                                        ("~/reviews.jsonl", self.root / "reviews.jsonl"),
                                        (str(self.root / "absolute.jsonl"), self.root / "absolute.jsonl")]:
                    config.write_text(json.dumps({"logPath": value}))
                    self.assertEqual(configured_log_path(host), expected)
                config.write_text('{"logPath": null}')
                with self.assertRaisesRegex(ValueError, "logPath"):
                    configured_log_path(host)
                config.write_text('[]')
                with self.assertRaisesRegex(ValueError, "object"):
                    configured_log_path(host)

    def test_jsonl_errors_do_not_expose_prose(self):
        path = self.root / "partial.jsonl"
        path.write_text('{}\n{"secret prompt"')
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.assertEqual(read_jsonl(path), [{}])
        self.assertNotIn("secret prompt", stderr.getvalue())
        path.write_text('{}\n{"secret prompt"\n')
        with self.assertRaisesRegex(ValueError, "Invalid JSON row 2") as error:
            read_jsonl(path)
        self.assertNotIn("secret prompt", str(error.exception))

    def test_recovery_and_exclusions(self):
        text = "Anything needs adressing? 😀\n```py\nsecret_code()\n```"
        self.write_rows("session.jsonl", [
            {"id": "message", "message": {"role": "user", "content": text}},
            {"uuid": "claude-message", "message": {"role": "user", "content": [{"type": "text", "text": "All good."}]}},
            {"id": "ack", "message": {"role": "user", "content": "Thanks!"}},
        ])
        pi = self.write_rows("pi.jsonl", [
            self.record(corrections=[{"kind": "error", "original": "adressing"},
                                     {"kind": "suggestion", "original": "Anything"}]),
            self.record("no-path", sessionPath=None),
            self.record("missing-file", sessionPath=str(self.root / "missing.jsonl")),
            self.record("missing-message", userMessageId="absent"),
            self.record("ack", userMessageId="ack"),
            self.record("mismatch", corrections=[{"kind": "error", "original": "absent"}]),
        ])
        claude = self.write_rows("claude.jsonl", [self.record(userMessageId="claude-message")])
        snapshot = recover_counts(pi, claude)
        self.assertEqual([r["errors"] for r in snapshot["reviews"]], [1, 0])
        self.assertEqual([r["characters"] for r in snapshot["reviews"]], [len("Anything needs adressing? 😀"), 9])
        self.assertEqual(snapshot["reviews"][0]["rawCharacters"], len(text))
        self.assertEqual([r["reason"] for r in snapshot["excluded"]], [
            "no transcript path", "transcript missing", "user message not found",
            "reviewed prose could not be reconstructed", "correction excerpts do not match reconstructed prose"])
        self.assertNotIn("adressing", json.dumps(snapshot))
        self.assertNotIn("secret_code", json.dumps(snapshot))

    def test_missing_logs_and_duplicate_ids(self):
        missing = self.root / "missing.jsonl"
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(recover_counts(missing, missing), {"reviews": [], "excluded": []})
        log = self.write_rows("pi.jsonl", [self.record(), self.record()])
        with self.assertRaisesRegex(ValueError, "Duplicate review ID"):
            recover_counts(log, missing)
        self.write_rows("session.jsonl", [
            {"id": "message", "message": {"role": "user", "content": "Some prose."}},
            {"id": "message", "message": {"role": "user", "content": "Some prose."}},
        ])
        log = self.write_rows("pi.jsonl", [self.record()])
        with contextlib.redirect_stderr(io.StringIO()):
            snapshot = recover_counts(log, missing)
        self.assertEqual(snapshot["excluded"][0]["reason"], "duplicate user-message ID")

    def test_follower_reads_appended_rows_once(self):
        path = self.root / "log.jsonl"
        path.write_bytes(b'{"n": 1}\n{"n": ')
        follower = JsonlFollower(path)
        self.assertEqual(follower.poll(), (False, [{"n": 1}]))
        self.assertEqual(follower.poll(), (False, []))
        with path.open("ab") as stream:
            stream.write('2, "s": "😀"}\r\n\n{"n": 3}\n'.encode())
        self.assertEqual(follower.poll(), (False, [{"n": 2, "s": "😀"}, {"n": 3}]))
        self.assertEqual(follower.offset, path.stat().st_size)
        path.write_text('{"n": 4}\n')  # Truncated in place: reread from the start.
        self.assertEqual(follower.poll(), (True, [{"n": 4}]))
        replacement = self.root / "replacement.jsonl"
        replacement.write_text('{"n": 4}\n{"n": 5}\n')
        os.replace(replacement, path)
        self.assertEqual(follower.poll(), (True, [{"n": 4}, {"n": 5}]))
        with path.open("a") as stream:
            stream.write('{"secret prompt"\n')
        for _ in range(2):
            with self.assertRaisesRegex(ValueError, "Invalid JSON row 3") as error:
                follower.poll()
            self.assertNotIn("secret prompt", str(error.exception))

    def test_live_counts_follow_logs_and_late_transcript_rows(self):
        session = self.write_rows("session.jsonl", [])
        log = self.write_rows("pi.jsonl", [self.record(corrections=[{"kind": "error", "original": "Some"}])])
        counts = ReviewCounts(log, self.root / "missing.jsonl")
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertTrue(counts.poll())
        self.assertEqual(counts.snapshot()["excluded"][0]["reason"], "user message not found")
        self.assertFalse(counts.poll())
        with session.open("a") as stream:
            stream.write(json.dumps({"id": "message", "message": {"role": "user", "content": "Some prose."}}) + "\n")
            stream.write(json.dumps({"id": "later", "message": {"role": "user", "content": "More prose here."}}) + "\n")
        self.assertTrue(counts.poll())
        self.assertEqual(counts.snapshot(), {"reviews": [{"host": "pi", "timestamp": "2026-01-01T12:00:00Z",
            "model": "test-model", "errors": 1, "characters": 11, "rawCharacters": 11}], "excluded": []})
        with log.open("a") as stream:
            stream.write(json.dumps(self.record("second", userMessageId="later")) + "\n")
            stream.write(json.dumps(self.record("second")) + "\n")
        self.assertTrue(counts.poll())
        self.assertEqual([r["characters"] for r in counts.snapshot()["reviews"]], [11, 16])
        self.assertEqual(counts.errors(), ["Duplicate review ID in the pi feedback log"])
        self.assertFalse(counts.poll())
        session.unlink()
        self.assertTrue(counts.poll())
        self.assertEqual({r["reason"] for r in counts.snapshot()["excluded"]}, {"transcript missing"})

    def test_dashboard_streams_updates_without_node_on_path(self):
        self.write_rows("session.jsonl", [
            {"id": "message", "message": {"role": "user", "content": "Some prose 😀."}},
        ])
        pi = self.write_rows("pi.jsonl", [self.record(
            corrections=[{"kind": "error", "original": "Some"}, {"kind": "suggestion", "original": "prose"}])])
        claude = self.write_rows("claude.jsonl", [self.record(timestamp="2026-01-03T12:00:00Z")])
        server = subprocess.Popen([
            sys.executable, str(ROOT / "scripts/dashboard.py"), "--pi-log", str(pi), "--claude-log", str(claude),
            "--timezone", "UTC", "--port", "0", "--interval", "0.05",
        ], cwd=self.root, env={**os.environ, "PATH": ""}, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        self.addCleanup(server.stderr.close)
        self.addCleanup(server.stdout.close)
        self.addCleanup(server.wait, 10)
        self.addCleanup(server.terminate)
        line = server.stdout.readline()
        self.assertIn("Dashboard: http://localhost:", line, server.stderr.read() if not line else line)
        url = line.split()[1]

        with urllib.request.urlopen(url, timeout=10) as response:
            self.assertIn("EventSource", response.read().decode())
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(urllib.request.Request(url, headers={"Host": "attacker.example"}), timeout=10)
        self.assertEqual(error.exception.code, 403)

        def next_event(stream):
            for raw in stream:
                if raw.startswith(b"data: "):
                    return json.loads(raw[6:])
            self.fail("event stream closed")

        with urllib.request.urlopen(url + "events", timeout=10) as stream:
            snapshot = next_event(stream)
            days = snapshot["days"]
            self.assertEqual([d["date"] for d in days], ["2026-01-01", "2026-01-02", "2026-01-03"])
            self.assertEqual([d["reviewed_prompts"] for d in days], [1, 0, 1])
            self.assertEqual(days[0]["pi_reviewed_prompts"], 1)
            self.assertEqual(days[2]["claude_reviewed_prompts"], 1)
            self.assertEqual(sum(d["reviewed_characters"] for d in days), 2 * len("Some prose 😀."))
            self.assertEqual(sum(d["errors"] for d in days), 1)
            self.assertEqual(snapshot["excluded_reviews"], 0)
            self.assertEqual(snapshot["timezone"], "UTC")
            self.assertRegex(snapshot["today"], r"^\d{4}-\d{2}-\d{2}$")
            with claude.open("a") as log:
                log.write(json.dumps(self.record("new", timestamp="2026-01-04T12:00:00Z",
                    corrections=[{"kind": "error", "original": "prose"}])) + "\n")
            snapshot = next_event(stream)
        self.assertEqual(snapshot["days"][-1]["date"], "2026-01-04")
        self.assertEqual(snapshot["days"][-1]["claude_errors"], 1)
        self.assertEqual(sum(d["reviewed_prompts"] for d in snapshot["days"]), 3)
        self.assertEqual(snapshot["errors"], [])
        self.assertNotIn("Some prose", json.dumps(snapshot))


if __name__ == "__main__":
    unittest.main()
