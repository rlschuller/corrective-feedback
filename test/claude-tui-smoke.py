"""Unix Claude Code TUI smoke; no model quota is used.

--real-worker-status checks real worker startup with Node absent from PATH,
then exits without submitting a prompt. Requires Pi's managed Node and login.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import shutil
import signal
import struct
import subprocess
import tempfile
import termios
import time
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--real-worker-status", action="store_true")
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
claude = shutil.which("claude")
if not claude:
    raise SystemExit("Claude Code is not on PATH")
with tempfile.TemporaryDirectory(prefix="feedback-claude-tui-") as tmp:
    tmp = Path(tmp)
    # Isolate keybindings/settings/trust state; copy only the existing login files.
    config = tmp / "claude-config"
    config.mkdir()
    original_config = Path(os.environ.get("CLAUDE_CONFIG_DIR", str(Path.home() / ".claude")))
    for source, target in [
        (original_config / ".credentials.json", config / ".credentials.json"),
        (original_config / ".claude.json" if "CLAUDE_CONFIG_DIR" in os.environ else Path.home() / ".claude.json", config / ".claude.json"),
    ]:
        if source.exists():
            shutil.copyfile(source, target)
            target.chmod(0o600)
    shutil.copyfile(root / "claude-keybindings.example.json", config / "keybindings.json")
    mock_plugin = tmp / "mock-main"
    (mock_plugin / ".claude-plugin").mkdir(parents=True)
    (mock_plugin / "hooks").mkdir()
    (mock_plugin / ".claude-plugin/plugin.json").write_text(json.dumps({"name": "feedback-smoke-main", "version": "0.1.0"}))
    (mock_plugin / "hooks/hooks.json").write_text('{"modules":["./register.js"]}')
    (mock_plugin / "hooks/register.js").write_text("""
let presses = 0;
export function register(on) {
  on('ui.press', {element:'feedback-toggle'}, async ($, e, next) => {
    const before = await $.prompt.read();
    const result = await next(e);
    const after = await $.prompt.read();
    if (before.text !== after.text || before.cursor !== after.cursor) throw Error('Toggle changed draft');
    $.ui.log('SMOKE_CTRL_N ' + (++presses) + ':' + JSON.stringify(after));
    return result;
  });
  on('turn.step', async function* ($, e) {
    await $.clock.sleep(5000);
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
s={{'enabled':True,'provider':'openai-codex','model':'gpt-6.1-sol','maxInputChars':12000,'timeoutMs':1000,'configPath':'/tmp/smoke-config.json','logPath':'/tmp/smoke-feedback.jsonl'}}
print(json.dumps({{'status':s,'lines':['Correction: “adressing” → “addressing”','  Use a double d.'] if r['action']=='review' else []}}))
""")
    fake_node.chmod(0o700)
    debug = tmp / "debug.log"
    session_id = str(uuid.uuid4())
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
    env = dict(os.environ, TERM="xterm-256color", CLAUDE_CORRECTIVE_FEEDBACK_NODE=str(fake_node), CLAUDE_CODE_NO_FLICKER="0", CLAUDE_CONFIG_DIR=str(config))
    if args.real_worker_status:
        env.pop("CLAUDE_CORRECTIVE_FEEDBACK_NODE", None)
        # Use only basic system commands; exclude Pi's Node and stale versioned paths.
        # Symlinks also keep this check meaningful on hosts with /usr/bin/node.
        bin_dir = tmp / "bin"
        bin_dir.mkdir()
        for command in ("sh", "bash", "uname", "git", "stty", "tty", "which"):
            executable = shutil.which(command)
            if executable:
                (bin_dir / command).symlink_to(executable)
        env["PATH"] = str(bin_dir)
        assert shutil.which("node", path=env["PATH"]) is None
    proc = subprocess.Popen([
        claude, "--plugin-dir", str(root), "--plugin-dir", str(mock_plugin),
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

    def toggle(expected_press, draft, visible=None):
        drain(0.3)
        start = len(output)
        os.write(master, b"\x0e")
        deadline = time.monotonic() + 5
        marker = "SMOKE_CTRL_N " + str(expected_press) + ":"
        while time.monotonic() < deadline:
            drain(0.1)
            if marker in debug.read_text():
                break
        drain(0.3)
        record = next(line for line in debug.read_text().splitlines() if marker in line)
        # Debug logging may quote/escape the UI log string.
        assert '"text":' + json.dumps(draft) in record.replace('\\"', '"'), record
        redraw = output[start:]
        if visible is True:
            assert b"Correction:" in redraw, redraw.decode(errors="replace")
        elif visible is False:
            assert b"Correction:" not in redraw, redraw.decode(errors="replace")

    rows = []
    try:
        drain(2)
        # The only workspace being trusted is this generated temporary directory.
        if b"trust this folder" in output or b"Quick" in output:
            os.write(master, b"\x1b[B\r")
        if args.real_worker_status:
            drain(5)
            os.write(master, b"/feedback status\r")
            deadline = time.monotonic() + 35
            while time.monotonic() < deadline:
                drain(0.2)
                debug_text = debug.read_text() if debug.exists() else ""
                if "English feedback: on" in debug_text:
                    break
                if "English feedback disabled:" in debug_text:
                    raise RuntimeError("Real worker startup failed: " + debug_text[-5000:])
            assert "English feedback: on" in debug_text, output.decode(errors="replace")[-5000:]
            assert "English feedback disabled:" not in debug_text
            print(json.dumps({"claudeWorkerStartup": "passed", "nodeOnPath": False, "quotaUsed": False}))
            raise SystemExit(0)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            drain(0.2)
            if requests.exists():
                break
        if not requests.exists():
            raise RuntimeError("Mod did not initialize: " + output.decode(errors="replace")[-5000:])
        drain(2)
        toggle(1, "") # Empty prompt: silent no-op, reviews remain enabled by default.
        assert b"Toggle English feedback" not in output, "Shortcut added a visible status row"
        os.write(master, b"Anything needs adressing before we start?\r")
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            drain(0.1)
            if b"Correction:" in output:
                break
        assert b"SMOKE_MAIN_OK" not in output, "Feedback waited for the main turn"
        toggle(2, "", False)
        toggle(3, "", True)
        os.write(master, b"Draft remains intact")
        drain(0.5)
        toggle(4, "Draft remains intact", False)
        toggle(5, "Draft remains intact", True)
        # Ordinary Backspace still edits the draft, rather than toggling feedback.
        os.write(master, b"\x7f")
        drain(0.5)
        toggle(6, "Draft remains intac", False)
        toggle(7, "Draft remains intac", True)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline and b"SMOKE_MAIN_OK" not in output:
            drain(0.2)
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
        assert "Toggle changed draft" not in debug.read_text()
        print(json.dumps({"claudeTuiSmoke": "passed", "quotaUsed": False, "displayedDuringMainTurn": True, "persistedUserId": True, "ctrlNToggle": True, "draftPreserved": True, "backspacePreserved": True}))
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
