"""Recover review counts locally without exporting prompt text.

Keep config resolution and prose filtering aligned with src/config.ts,
src/claude-reviewer.ts, src/text.ts, and extractText in src/review.ts.
"""
from collections import Counter
from datetime import datetime
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


# Reviewers name categories freely ("word_choice", "grammar and spelling"); fold them into a
# fixed set. A name mentioning several types counts as the one it names first.
CATEGORIES = ("spelling", "grammar", "prepositions", "articles", "punctuation", "idiom", "word_order", "other")
CATEGORY_KEYWORDS = (
    ("word order", "word_order"), ("order", "word_order"),
    ("spell", "spelling"), ("typo", "spelling"),
    ("preposition", "prepositions"),
    ("article", "articles"), ("determiner", "articles"),
    ("punctuation", "punctuation"), ("capitali", "punctuation"), ("spacing", "punctuation"),
    ("formatting", "punctuation"), ("comma", "punctuation"), ("hyphen", "punctuation"),
    ("idiom", "idiom"), ("word choice", "idiom"), ("collocation", "idiom"), ("usage", "idiom"),
    ("vocabulary", "idiom"), ("wording", "idiom"),
    ("grammar", "grammar"), ("agreement", "grammar"), ("tense", "grammar"), ("verb", "grammar"),
    ("plural", "grammar"), ("pronoun", "grammar"),
)


def error_category(name):
    """Map a reviewer's category name onto CATEGORIES."""
    text = re.sub(r"[-_\s]+", " ", name.lower()) if isinstance(name, str) else ""
    found = [(text.find(word), -len(word), category) for word, category in CATEGORY_KEYWORDS if word in text]
    return min(found)[2] if found else "other"


def prepare_text(text):
    """Reconstruct filtered prose without imposing today's input-length limit."""
    stripped = text.strip(JS_SPACE)
    if not stripped or stripped.startswith(("!", "/")):
        return None
    prose = QUOTE.sub("", FENCE.sub("\n", text)).strip(JS_SPACE)
    outside_context = URL.sub(" ", INLINE_CODE.sub(" ", prose))
    if not re.search(r"[a-zA-Z]{2}", outside_context) or ACKNOWLEDGMENT.fullmatch(prose):
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




class JsonlFollower:
    """Parse a JSONL file incrementally: each poll reads only the bytes appended since the last.

    A trailing row without its newline may still be being written, so it is held back
    until the newline arrives (with final=True it is parsed or reported instead). A
    replaced or truncated file is reread from the start and reported as a reset.
    """

    def __init__(self, path):
        self.path = Path(path)
        self.forget()

    def forget(self):
        self.identity = None
        self.signature = None
        self.offset = 0
        self.rows = 0  # Newline-terminated rows consumed, for 1-based error messages.
        self.pending = b""
        self.failure = None

    def poll(self, final=False):
        """Return (reset, records). Raises OSError, or ValueError for an invalid row."""
        status = os.stat(self.path)
        identity = (status.st_dev, status.st_ino)
        reset = self.identity is not None and (identity != self.identity or status.st_size < self.offset)
        if reset:
            self.forget()
        signature = (identity, status.st_size, status.st_mtime_ns)
        if signature == self.signature:
            if self.failure:
                raise ValueError(self.failure)
            return False, []
        with open(self.path, "rb") as stream:
            stream.seek(self.offset)
            chunk = stream.read()
        lines = (self.pending + chunk).split(b"\n")
        tail = lines.pop()
        records = []
        for index, line in enumerate(lines):
            try:
                record = parse_row(line)
            except ValueError:
                # Keep the offset so a fix is reread, but skip rereading an unchanged file.
                # Never include a source-text excerpt in diagnostics.
                self.identity, self.signature = identity, signature
                self.failure = f"Invalid JSON row {self.rows + index + 1} in {self.path}"
                raise ValueError(self.failure) from None
            if record is not None:
                records.append(record)
        if final and tail:
            try:
                record = parse_row(tail)
                if record is not None:
                    records.append(record)
                tail = b""
            except ValueError:
                print(f"Ignored an incomplete final row in {self.path}", file=sys.stderr)
        self.identity, self.signature, self.failure = identity, signature, None
        self.offset += len(chunk)
        self.rows += len(lines)
        self.pending = tail
        return reset, records


def parse_row(line):
    text = line.decode("utf-8")
    return json.loads(text) if text.strip(JS_SPACE) else None


def read_jsonl(path):
    # Split on LF only, preserving CRLF inside rows, as Node's readFile(..., 'utf8') did.
    return JsonlFollower(path).poll(final=True)[1]


class Transcript:
    """User-message texts of one session transcript, keyed by message ID."""

    def __init__(self, path):
        self.follower = JsonlFollower(path)
        self.texts = {}
        self.reason = "transcript not read"
        self.reviews = []

    def poll(self, final):
        """Return "all" when every linked review must be re-resolved, "grew", or None."""
        before = self.reason
        try:
            reset, rows = self.follower.poll(final)
        except FileNotFoundError:
            self.follower.forget()
            self.texts, self.reason = {}, "transcript missing"
            return "all" if before != self.reason else None
        except ValueError as error:
            self.reason = str(error)
            return "all" if before != self.reason else None
        except OSError:
            self.follower.forget()
            self.texts, self.reason = {}, "transcript unreadable"
            return "all" if before != self.reason else None
        if reset or before in ("transcript not read", "transcript missing", "transcript unreadable"):
            self.texts, self.reason = {}, None
        elif before is not None and before != "duplicate user-message ID":
            self.reason = None  # A previously invalid row has been fixed.
        grew = False
        for row in rows:
            message = row.get("message")
            if not isinstance(message, dict) or message.get("role") != "user":
                continue
            message_id = row.get("uuid")
            if message_id is None:
                message_id = row.get("id")
            if message_id:
                if message_id in self.texts:
                    self.reason = "duplicate user-message ID"
                # Keep only the text: tool results and images are not needed.
                self.texts[message_id] = extract_text(message.get("content"))
                grew = True
        return "all" if reset or before != self.reason else "grew" if grew else None


class Review:
    __slots__ = ("host", "timestamp", "stamp", "model", "errors", "categories", "session_path", "message_id",
                 "originals", "characters", "raw_characters", "reason")


class ReviewCounts:
    """Recover per-review character counts and keep them current as the logs grow.

    Each poll stats the feedback logs and linked transcripts and parses only appended rows,
    so following long-running sessions stays cheap. Reviews whose transcript row is not
    available yet are resolved again once that transcript changes.
    """

    def __init__(self, pi_log=None, claude_log=None):
        self.sources = {"pi": Path(pi_log) if pi_log is not None else configured_log_path("pi"),
                        "claude": Path(claude_log) if claude_log is not None else configured_log_path("claude")}
        self.logs = {host: JsonlFollower(path) for host, path in self.sources.items()}
        self.found = {host: None for host in self.sources}
        self.reviews = {host: [] for host in self.sources}
        self.ids = {host: set() for host in self.sources}
        self.problems = {host: [] for host in self.sources}  # Persist until the log is replaced.
        self.log_errors = {host: None for host in self.sources}
        self.transcripts = {}

    def poll(self, final=False):
        """Read new rows; return whether the recovered counts may have changed."""
        self.final = final
        changed = False
        added = []
        for host, follower in self.logs.items():
            try:
                reset, records = follower.poll(final)
                found, error = True, None
            except FileNotFoundError:
                follower.forget()
                reset, records, found, error = bool(self.reviews[host] or self.problems[host]), [], False, None
            except OSError:
                reset, records, found, error = False, [], True, f"Feedback log unreadable: {self.sources[host]}"
            except ValueError as failure:
                reset, records, found, error = False, [], True, str(failure)
            if found is False and self.found[host] is not False:
                print(f"Feedback log not found; skipping {host}: {self.sources[host]}", file=sys.stderr)
            changed |= found != self.found[host] or error != self.log_errors[host]
            self.found[host], self.log_errors[host] = found, error
            if reset:
                self._drop(host)
                changed = True
            for record in records:
                review = self._review(host, record)
                if review:
                    self.reviews[host].append(review)
                    added.append(review)
                changed = True
        for transcript in self.transcripts.values():
            update = transcript.poll(final)
            if update:
                changed = True
                for review in transcript.reviews:
                    if update == "all" or review.reason == "user message not found":
                        self._resolve(review)
        for review in added:
            self._resolve(review)
        return changed

    def _drop(self, host):
        for review in self.reviews[host]:
            if review.session_path:
                self.transcripts[review.session_path].reviews.remove(review)
        self.reviews[host], self.ids[host], self.problems[host] = [], set(), []

    def _review(self, host, record):
        try:
            unique = record["id"]
            if unique in self.ids[host]:
                self.problems[host].append(f"Duplicate review ID in the {host} feedback log")
                return None
            review = Review()
            review.host, review.timestamp, review.model = host, record["timestamp"], record.get("model")
            review.stamp = datetime.fromisoformat(review.timestamp.replace("Z", "+00:00"))
            if review.stamp.tzinfo is None:
                raise ValueError
            corrections = record["corrections"]
            review.errors = sum(c["kind"] == "error" for c in corrections)
            review.categories = dict(Counter(error_category(c.get("category")) for c in corrections if c["kind"] == "error"))
            review.originals = [c["original"] for c in corrections]
            review.session_path = record.get("sessionPath")
            review.message_id = record.get("userMessageId")
        except (AttributeError, KeyError, TypeError, ValueError):
            self.problems[host].append(f"Malformed review row in the {host} feedback log")
            return None
        self.ids[host].add(unique)
        review.characters = review.raw_characters = review.reason = None
        if review.session_path:
            transcript = self.transcripts.get(review.session_path)
            if transcript is None:
                transcript = self.transcripts[review.session_path] = Transcript(review.session_path)
                transcript.poll(self.final)  # Read it now so this poll can resolve the review.
            transcript.reviews.append(review)
        return review

    def _resolve(self, review):
        review.characters = review.raw_characters = None
        if not review.session_path:
            review.reason = "no transcript path"
            return
        transcript = self.transcripts[review.session_path]
        text = transcript.texts.get(review.message_id)
        prose = None
        if transcript.reason:
            review.reason = transcript.reason
        elif text is None:
            review.reason = "user message not found"
        elif not (prose := prepare_text(text)):
            review.reason = "reviewed prose could not be reconstructed"
        elif any(original not in prose for original in review.originals):
            review.reason = "correction excerpts do not match reconstructed prose"
        else:
            # Python len counts Unicode code points, not UTF-16 code units.
            review.reason, review.characters, review.raw_characters = None, len(prose), len(text)

    def errors(self):
        return [error for host in self.sources
                for error in ([self.log_errors[host]] if self.log_errors[host] else []) + self.problems[host]]

    def snapshot(self):
        reviews, excluded = [], []
        for host in self.sources:
            for review in self.reviews[host]:
                item = {"host": host, "timestamp": review.timestamp, "model": review.model, "errors": review.errors,
                        "categories": review.categories}
                if review.reason:
                    excluded.append({**item, "reason": review.reason})
                else:
                    reviews.append({**item, "characters": review.characters, "rawCharacters": review.raw_characters})
        return {"reviews": reviews, "excluded": excluded}


def recover_counts(pi_log=None, claude_log=None):
    counts = ReviewCounts(pi_log, claude_log)
    counts.poll(final=True)
    errors = counts.errors()
    if errors:
        raise ValueError(errors[0])
    return counts.snapshot()
