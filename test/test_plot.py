"""Node-free plotting tests: python3 -m unittest discover -s test -p 'test_plot*.py'."""
import contextlib
import csv
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from review_character_counts import configured_log_path, extract_text, prepare_text, read_jsonl, recover_counts


class TextTests(unittest.TestCase):
    def test_filters(self):
        for text in ["", "Thanks!", "/feedback on", " !ls", "```ts\nconst value = 1;\n```",
                     "> quoted document", "`someFunction()`", "https://example.org",
                     "``release`candidate``", "`dev` / `main`", "```inline``` "]:
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
            "See https://example.org and http://example.net.": "See   and",
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

    @unittest.skipUnless(importlib.util.find_spec("matplotlib"), "Matplotlib not installed")
    def test_plot_without_node_on_path(self):
        self.write_rows("session.jsonl", [
            {"id": "message", "message": {"role": "user", "content": "Some prose 😀."}},
        ])
        pi = self.write_rows("pi.jsonl", [self.record(
            corrections=[{"kind": "error", "original": "Some"}, {"kind": "suggestion", "original": "prose"}])])
        claude = self.write_rows("claude.jsonl", [self.record(timestamp="2026-01-03T12:00:00Z")])
        out = self.root / "plots"
        result = subprocess.run([
            sys.executable, str(ROOT / "scripts/update-plot.py"), "--pi-log", str(pi),
            "--claude-log", str(claude), "--timezone", "UTC", "--output-dir", str(out),
        ], cwd=self.root, env={**os.environ, "PATH": "", "MPLCONFIGDIR": str(self.root / "mpl")},
            capture_output=True, text=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr)
        summary = json.loads(result.stdout)
        self.assertEqual(summary["reviews"], 2)
        self.assertEqual(summary["reviewed_characters"], 2 * len("Some prose 😀."))
        self.assertEqual(summary["errors"], 1)
        self.assertEqual(summary["excluded_reviews"], 0)
        for path in summary["output_files"]:
            self.assertGreater(Path(path).stat().st_size, 0)
        with (out / "daily-errors-per-1000-characters.csv").open() as stream:
            rows = list(csv.DictReader(stream))
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[1]["errors_per_1000_characters"], "")
        self.assertEqual(rows[0]["pi_reviewed_prompts"], "1")
        self.assertEqual(rows[2]["claude_reviewed_prompts"], "1")


if __name__ == "__main__":
    unittest.main()
