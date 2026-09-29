"""Opt-in Unix TUI smoke test. Uses subscription quota and the pi executable on PATH."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="feedback-tui-") as tmp:
    config = Path(tmp) / "config.json"
    log = Path(tmp) / "feedback.jsonl"
    config.write_text(json.dumps({"logPath": str(log)}))
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 140, 0, 0))
    env = dict(os.environ, TERM="xterm-256color", PI_CORRECTIVE_FEEDBACK_CONFIG=str(config))
    proc = subprocess.Popen([
        "pi", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
        "--no-tools", "--no-session", "--no-approve", "--model", "openai-codex/gpt-6-luna",
        "--thinking", "low", "--system-prompt", "Reply only OK. Do not correct the user.",
        "-e", str(root / "index.ts"), "--tui-mode", "regular",
    ], stdin=slave, stdout=slave, stderr=slave, env=env, cwd=root, start_new_session=True)
    os.close(slave)
    output = bytearray()

    def drain(seconds):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            if select.select([master], [], [], 0.1)[0]:
                try:
                    output.extend(os.read(master, 65536))
                except OSError:
                    break

    try:
        drain(4)
        os.write(master, b"Please reply only OK. Anything needs adressing?\r")
        deadline = time.monotonic() + 70
        while time.monotonic() < deadline:
            drain(0.5)
            if log.exists() and b"Correction:" in output:
                break
            if proc.poll() is not None:
                raise RuntimeError("Pi exited before feedback appeared")
        if not log.exists():
            print(output.decode(errors="replace")[-10000:])
            raise RuntimeError("No feedback log appeared")
        records = [json.loads(line) for line in log.read_text().splitlines()]
        assert records[0]["userMessageId"], "Missing source ID"
        assert any("addressing" in c["corrected"] for c in records[0]["corrections"]), records
        assert b"Correction:" in output, "Widget not found in terminal output"
        print(json.dumps({"realTuiSmoke": "passed", "recordCount": len(records), "widgetRendered": True}))
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
        os.close(master)
