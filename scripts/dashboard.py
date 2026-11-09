"""Serve a live local dashboard of errors per page; no original prompts are exported.

The server follows Pi's and Claude's feedback logs (and the linked transcripts) by
polling file metadata and parsing only appended rows, then pushes aggregate snapshots
to open pages over Server-Sent Events. Only the Python standard library is required.
"""
import argparse
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import sys
import threading
import time
from urllib.parse import urlsplit
import webbrowser
from zoneinfo import ZoneInfo

from review_character_counts import CATEGORIES, ReviewCounts

PAGE = Path(__file__).resolve().with_name("dashboard.html")
HOSTS = ("pi", "claude")


def local_zone():
    """The system timezone, by IANA name when it can be found (for DST-correct days)."""
    tz = os.environ.get("TZ", "").lstrip(":")
    for name in (tz, tz.partition("zoneinfo/")[2], os.path.realpath("/etc/localtime").partition("zoneinfo/")[2]):
        try:
            if name:
                return ZoneInfo(name), name
        except (KeyError, ValueError):
            pass
    zone = datetime.now().astimezone().tzinfo
    return zone, zone.tzname(None) or "local time"


def empty_bucket():
    return {"reviews": 0, "characters": 0, "errors": 0, "categories": dict.fromkeys(CATEGORIES, 0)}


def daily_rows(reviews, zone):
    """One row per calendar day from the first to the last review, including empty days."""
    buckets = defaultdict(lambda: {host: empty_bucket() for host in HOSTS})
    for review in reviews:
        stamp = datetime.fromisoformat(review["timestamp"].replace("Z", "+00:00"))
        bucket = buckets[stamp.astimezone(zone).date()][review["host"]]
        bucket["reviews"] += 1
        bucket["characters"] += review["characters"]
        bucket["errors"] += review["errors"]
        for category, count in review.get("categories", {}).items():
            bucket["categories"][category] += count
    if not buckets:
        return []
    first, last = min(buckets), max(buckets)
    rows = []
    for offset in range((last - first).days + 1):
        day = first + timedelta(days=offset)
        by_host = buckets.get(day) or {host: empty_bucket() for host in HOSTS}
        row = {
            "date": day.isoformat(),
            "reviewed_prompts": sum(b["reviews"] for b in by_host.values()),
            "reviewed_characters": sum(b["characters"] for b in by_host.values()),
            "errors": sum(b["errors"] for b in by_host.values()),
            "categories": {c: sum(b["categories"][c] for b in by_host.values()) for c in CATEGORIES},
        }
        for host in HOSTS:
            row[f"{host}_reviewed_prompts"] = by_host[host]["reviews"]
            row[f"{host}_reviewed_characters"] = by_host[host]["characters"]
            row[f"{host}_errors"] = by_host[host]["errors"]
            row[f"{host}_categories"] = by_host[host]["categories"]
        rows.append(row)
    return rows


def build_snapshot(counts, zone, zone_name):
    recovered = counts.snapshot()
    reasons = defaultdict(int)
    for review in recovered["excluded"]:
        reasons[review["reason"]] += 1
    return {
        "updated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "today": datetime.now(zone).date().isoformat(),
        "timezone": zone_name,
        "categories": list(CATEGORIES),
        "days": daily_rows(recovered["reviews"], zone),
        "excluded_reviews": len(recovered["excluded"]),
        "exclusions_by_reason": dict(sorted(reasons.items())),
        "sources": [{"host": host, "path": str(path), "found": bool(counts.found[host])}
                    for host, path in counts.sources.items()],
        "errors": counts.errors(),
    }


class Feed:
    """Polls the logs on one thread and wakes every waiting page when the counts change."""

    def __init__(self, counts, zone, zone_name, interval):
        self.counts, self.zone, self.zone_name, self.interval = counts, zone, zone_name, interval
        self.changed = threading.Condition()
        self.version = 0
        self.snapshot = None
        self.payload = b""
        self.refresh()

    def refresh(self):
        changed = self.counts.poll()
        # Also refresh at midnight, so "last N days" ranges move on without new reviews.
        today = datetime.now(self.zone).date().isoformat()
        if not changed and self.snapshot is not None and self.snapshot["today"] == today:
            return
        snapshot = build_snapshot(self.counts, self.zone, self.zone_name)
        with self.changed:
            self.version += 1
            self.snapshot = snapshot
            self.payload = json.dumps({**snapshot, "version": self.version}, separators=(",", ":")).encode()
            self.changed.notify_all()

    def run(self):
        while True:
            time.sleep(self.interval)
            try:
                self.refresh()
            except Exception as error:  # Keep serving the last snapshot.
                print(f"Dashboard refresh failed: {error!r}", file=sys.stderr)

    def wait(self, seen, timeout):
        with self.changed:
            self.changed.wait_for(lambda: self.version != seen, timeout)
            return self.version, self.payload


def is_loopback(host):
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return host == "localhost"


def make_handler(feed, bind_host):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        server_version = "CorrectiveFeedback"

        def log_message(self, *args):
            pass

        def send(self, status, body=b"", content_type="text/plain; charset=utf-8", headers=()):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            for header in headers:
                self.send_header(*header)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)

        def do_HEAD(self):
            self.do_GET()

        def do_GET(self):
            # Refuse other Host names so a DNS-rebinding page cannot read the statistics.
            hostname = urlsplit("//" + (self.headers.get("Host") or "")).hostname or ""
            if is_loopback(bind_host) and not is_loopback(hostname):
                return self.send(HTTPStatus.FORBIDDEN, b"Forbidden host\n")
            path = urlsplit(self.path).path
            if path == "/":
                return self.send(HTTPStatus.OK, PAGE.read_bytes(), "text/html; charset=utf-8", [
                    ("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; "
                     "style-src 'unsafe-inline'; connect-src 'self'; img-src data:; form-action 'none'")])
            if path == "/api/snapshot":
                return self.send(HTTPStatus.OK, feed.wait(-1, 0)[1], "application/json")
            if path == "/events":
                return self.stream()
            self.send(HTTPStatus.NOT_FOUND, b"Not found\n")

        def stream(self):
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            if self.command == "HEAD":
                return
            seen = None
            try:
                while True:
                    version, payload = feed.wait(seen, 15)
                    if version == seen:
                        self.wfile.write(b": keep-alive\n\n")  # Also detects closed pages.
                    else:
                        self.wfile.write(b"retry: 2000\ndata: " + payload + b"\n\n")
                        seen = version
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, TimeoutError):
                pass

    return Handler


def main():
    parser = argparse.ArgumentParser(description="Serve a live dashboard of errors per page of reviewed prose from local Pi/Claude logs.")
    parser.add_argument("--host", default="127.0.0.1", help="Address to listen on (default: 127.0.0.1, this computer only)")
    parser.add_argument("--port", type=int, default=8766, help="Port to listen on; 0 picks a free port (default: 8765)")
    parser.add_argument("--interval", type=float, default=1.0, help="Seconds between checks for new log rows (default: 1)")
    parser.add_argument("--timezone", help="IANA timezone for daily buckets (default: the system's local timezone)")
    parser.add_argument("--pi-log", type=Path, help="Override Pi's configured feedback log")
    parser.add_argument("--claude-log", type=Path, help="Override Claude's configured feedback log")
    parser.add_argument("--open", action="store_true", help="Open the dashboard in a web browser")
    args = parser.parse_args()
    if args.interval <= 0:
        parser.error("--interval must be positive")

    try:
        zone, zone_name = (ZoneInfo(args.timezone), args.timezone) if args.timezone else local_zone()
        counts = ReviewCounts(
            args.pi_log.expanduser().resolve() if args.pi_log else None,
            args.claude_log.expanduser().resolve() if args.claude_log else None,
        )
    except (OSError, ValueError, KeyError) as error:
        raise SystemExit(str(error)) from None
    feed = Feed(counts, zone, zone_name, args.interval)
    threading.Thread(target=feed.run, daemon=True).start()
    try:
        server = ThreadingHTTPServer((args.host, args.port), make_handler(feed, args.host))
    except OSError as error:
        raise SystemExit(f"Cannot listen on {args.host}:{args.port}: {error}") from None
    server.daemon_threads = True
    host = server.server_address[0]
    url = f"http://{'localhost' if is_loopback(host) else host}:{server.server_address[1]}/"
    print(f"Dashboard: {url} (Ctrl+C to stop)", flush=True)
    if args.open:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
