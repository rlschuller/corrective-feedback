"""Recover review counts locally without exporting prompt text.

Keep config resolution and prose filtering aligned with src/config.ts,
src/claude-reviewer.ts, src/text.ts, and extractText in src/review.ts.
"""
import json
import os
from pathlib import Path
import re
import sys


# ECMAScript whitespace and line boundaries differ from Python's defaults.
JS_SPACE = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
SPACE = f"[{JS_SPACE}]"
LINE_START = r"(?<![^\n\r\u2028\u2029])"
LINE_END = r"(?=[\n\r\u2028\u2029]|\Z)"
FENCE = re.compile(LINE_START + SPACE + r"*(`{3,}|~{3,})[^\n]*\n[\s\S]*?" + LINE_START + SPACE + r"*\1[^\n]*(?:\n|\Z)")
QUOTE = re.compile(LINE_START + SPACE + r"*>[^\n\r\u2028\u2029]*" + LINE_END)
URL = re.compile(r"https?://[^" + JS_SPACE + r"]+")
INLINE_CODE = re.compile(r"(?<!`)(`+)(?!`)[^\n]*?(?<!`)\1(?!`)")
ACKNOWLEDGMENT = re.compile(r"(?:yes|no|ok(?:ay)?|thanks|thank you|sure|got it|hold on)[.!" + JS_SPACE + r"]*", re.IGNORECASE | re.ASCII)


def prepare_text(text):
    """Reconstruct filtered prose without imposing today's input-length limit."""
    stripped = text.strip(JS_SPACE)
    if not stripped or stripped.startswith(("!", "/")):
        return None
    prose = URL.sub(" ", QUOTE.sub("", FENCE.sub("\n", text))).strip(JS_SPACE)
    outside_inline_code = INLINE_CODE.sub(" ", prose)
    if not re.search(r"[a-zA-Z]{2}", outside_inline_code) or ACKNOWLEDGMENT.fullmatch(prose):
        return None
    return prose


def extract_text(content):
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    return "\n".join(part["text"] for part in content
                     if isinstance(part, dict) and part.get("type") == "text"
                     and isinstance(part.get("text"), str))


def expand_home(path):
    # Like the extension, expand ~/ but not ~otheruser/.
    if path == "~":
        return str(Path.home())
    if path.startswith("~/"):
        return os.path.join(str(Path.home()), path[2:])
    return path


def configured_log_path(host):
    agent_dir = expand_home(os.environ.get("PI_CODING_AGENT_DIR") or str(Path.home() / ".pi/agent"))
    filename = "corrective-feedback.json" if host == "pi" else "claude-corrective-feedback.json"
    config_path = Path(os.path.abspath(expand_home(
        os.environ.get(f"{host.upper()}_CORRECTIVE_FEEDBACK_CONFIG") or os.path.join(agent_dir, filename))))
    try:
        value = json.loads(config_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        value = {}
    except json.JSONDecodeError:
        raise ValueError(f"Invalid JSON configuration: {config_path}") from None
    if not isinstance(value, dict):
        raise ValueError("Configuration must be an object")
    # Only logPath affects plotting; reviewer/model settings are not used here.
    default_name = "feedback.jsonl" if host == "pi" else "claude-feedback.jsonl"
    log_path = value.get("logPath", str(config_path.parent / "corrective-feedback" / default_name))
    if not isinstance(log_path, str) or not log_path.strip(JS_SPACE):
        raise ValueError("logPath must be a nonempty string")
    return Path(os.path.abspath(config_path.parent / expand_home(log_path)))


def read_jsonl(path):
    # Preserve CRLF inside the file just as Node's readFile(..., 'utf8') did.
    with open(path, encoding="utf-8", newline="") as stream:
        raw = stream.read()
    lines = raw.split("\n")
    records = []
    for index, line in enumerate(lines):
        if not line.strip(JS_SPACE):
            continue
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            if index == len(lines) - 1 and not raw.endswith("\n"):
                print(f"Ignored an incomplete final row in {path}", file=sys.stderr)
                continue
            # Never include a source-text excerpt in diagnostics.
            raise ValueError(f"Invalid JSON row {index + 1} in {path}") from None
    return records


def recover_counts(pi_log=None, claude_log=None):
    indexes = {}
    reviews = []
    excluded = []
    seen = set()
    sources = [("pi", pi_log if pi_log is not None else configured_log_path("pi")),
               ("claude", claude_log if claude_log is not None else configured_log_path("claude"))]
    for host, path in sources:
        try:
            records = read_jsonl(path)
        except FileNotFoundError:
            print(f"Feedback log not found; skipping {host}: {path}", file=sys.stderr)
            continue
        for record in records:
            unique = (host, record["id"])
            if unique in seen:
                raise ValueError("Duplicate review ID")
            seen.add(unique)
            reason = None
            try:
                session_path = record.get("sessionPath")
                if not session_path:
                    raise ValueError("no transcript path")
                if session_path not in indexes:
                    index = {}
                    for row in read_jsonl(session_path):
                        message = row.get("message")
                        if not isinstance(message, dict) or message.get("role") != "user":
                            continue
                        message_id = row.get("uuid")
                        if message_id is None:
                            message_id = row.get("id")
                        if message_id:
                            if message_id in index:
                                raise ValueError("duplicate user-message ID")
                            index[message_id] = message
                    indexes[session_path] = index
                message = indexes[session_path].get(record.get("userMessageId"))
                if message is None:
                    raise ValueError("user message not found")
                text = extract_text(message.get("content"))
                prose = prepare_text(text)
                if not prose:
                    raise ValueError("reviewed prose could not be reconstructed")
                if any(c["original"] not in prose for c in record["corrections"]):
                    raise ValueError("correction excerpts do not match reconstructed prose")
            except FileNotFoundError:
                reason = "transcript missing"
            except ValueError as error:
                reason = str(error)
            except OSError:
                reason = "transcript unreadable"
            item = {"host": host, "timestamp": record["timestamp"], "model": record["model"],
                    "errors": sum(c["kind"] == "error" for c in record["corrections"])}
            if reason:
                excluded.append({**item, "reason": reason})
            else:
                # Python len counts Unicode code points, not UTF-16 code units.
                reviews.append({**item, "characters": len(prose), "rawCharacters": len(text)})
    return {"reviews": reviews, "excluded": excluded}
