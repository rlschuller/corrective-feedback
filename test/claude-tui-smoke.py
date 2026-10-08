"""Unix Claude Code TUI smoke. Both model paths are stubbed; no model quota is used."""
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
import uuid

root = Path(__file__).resolve().parents[1]
with tempfile.TemporaryDirectory(prefix="feedback-claude-tui-") as tmp:
    tmp = Path(tmp)
    mock_plugin = tmp / "mock-main"
    (mock_plugin / ".claude-plugin").mkdir(parents=True)
    (mock_plugin / "hooks").mkdir()
    (mock_plugin / ".claude-plugin/plugin.json").write_text(json.dumps({"name": "feedback-smoke-main", "version": "0.1.0"}))
    (mock_plugin / "hooks/hooks.json").write_text('{"modules":["./register.js"]}')
    (mock_plugin / "hooks/register.js").write_text("""
export function register(on) {
  on('turn.step', async function* ($, e) {
    await $.clock.sleep(2500);
    yield {kind:'text',index:0,text:'SMOKE_MAIN_OK'};
    yield {kind:'stop',stopReason:'end_turn',usage:null};
    return {turnId:e.turnId,index:e.index,answer:'SMOKE_MAIN_OK',toolUses:[],stopReason:'end_turn',usage:null};
  });
}
""")
    requests = tmp / "requests.jsonl"
    fake_node = tmp / "fake-node"
    fake_node.write_text("#!/usr/bin/env python3\n" + f"""
import json,sys
r=json.load(sys.stdin)
with open({str(requests)!r},'a') as f: f.write(json.dumps(r)+'\\n')
s={{'enabled':True,'provider':'openai-codex','model':'gpt-6-sol','maxInputChars':12000,'timeoutMs':1000,'configPath':'/tmp/smoke-config.json','logPath':'/tmp/smoke-feedback.jsonl'}}
print(json.dumps({{'status':s,'lines':['Correction: “adressing” → “addressing”','  Use a double d.'] if r['action']=='review' else []}}))
""")
    fake_node.chmod(0o700)
    debug = tmp / "debug.log"
    session_id = str(uuid.uuid4())
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    env = dict(os.environ, TERM="xterm-256color", CLAUDE_CORRECTIVE_FEEDBACK_NODE=str(fake_node), CLAUDE_CODE_NO_FLICKER="0")
    proc = subprocess.Popen([
        "claude", "--plugin-dir", str(root), "--plugin-dir", str(mock_plugin),
        "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
        "--session-id", session_id, "--debug-file", str(debug),
    ], stdin=slave, stdout=slave, stderr=slave, env=env, cwd=tmp, start_new_session=True)
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

    rows = []
    try:
        drain(2)
        # The only workspace being trusted is this generated temporary directory.
        if b"trust this folder" in output or b"Quick" in output:
            os.write(master, b"\x1b[B\r")
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            drain(0.2)
            if requests.exists():
                break
        if not requests.exists():
            raise RuntimeError("Mod did not initialize: " + output.decode(errors="replace")[-5000:])
        drain(2)
        os.write(master, b"Anything needs adressing before we start?\r")
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            drain(0.2)
            if b"Correction:" in output and b"SMOKE_MAIN_OK" in output:
                break
        rows = [json.loads(line) for line in requests.read_text().splitlines()]
        reviews = [r for r in rows if r["action"] == "review"]
        assert len(reviews) == 1, (rows, output.decode(errors="replace")[-5000:])
        assert reviews[0]["sessionId"] == session_id, reviews
        assert reviews[0]["userMessageId"], reviews
        assert reviews[0]["sessionPath"], reviews
        assert b"Correction:" in output, output.decode(errors="replace")[-5000:]
        assert b"addressing" in output
        assert output.index(b"Correction:") < output.index(b"SMOKE_MAIN_OK"), "Feedback waited for the main turn"
        transcript_path = Path(reviews[0]["sessionPath"])
        if transcript_path.exists():
            transcript = transcript_path.read_text()
            assert '"uuid":"' + reviews[0]["userMessageId"] + '"' in transcript
            assert "Correction:" not in transcript, "Feedback leaked into conversation history"
        assert "ANTHROPIC_API_ERROR" not in debug.read_text()
        print(json.dumps({"claudeTuiSmoke": "passed", "quotaUsed": False, "displayedDuringMainTurn": True, "persistedUserId": True}))
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(proc.pid, signal.SIGKILL)
                proc.wait()
        os.close(master)
        # Remove only this smoke run's uniquely named transcript, not other sessions.
        for r in rows:
            if r.get("sessionPath"):
                path = Path(r["sessionPath"])
                if path.name == session_id + ".jsonl":
                    path.unlink(missing_ok=True)
