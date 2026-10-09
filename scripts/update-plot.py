"""Plot aggregate error density; no original prompts are exported."""
import argparse
import csv
import json
import subprocess
import sys
from collections import defaultdict
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

try:
    import matplotlib
except ImportError:
    raise SystemExit("Plotting requires matplotlib in your Python 3 environment.")
matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description="Refresh daily errors per 1,000 reviewed characters from local Pi/Claude logs.")
parser.add_argument("--output-dir", type=Path, default=root / "plots")
parser.add_argument("--timezone", default="America/Sao_Paulo")
parser.add_argument("--node", default="node", help="Node.js 22.19+ executable")
parser.add_argument("--pi-log", type=Path, help="Override Pi's configured feedback log")
parser.add_argument("--claude-log", type=Path, help="Override Claude's configured feedback log")
args = parser.parse_args()
zone = ZoneInfo(args.timezone)
try:
    recovered = subprocess.run([
        args.node, "--experimental-strip-types", str(root / "scripts/review-character-counts.mjs"),
        str(args.pi_log.expanduser().resolve()) if args.pi_log else "",
        str(args.claude_log.expanduser().resolve()) if args.claude_log else "",
    ], capture_output=True, text=True)
except FileNotFoundError:
    raise SystemExit(f"Node executable not found: {args.node}")
if recovered.stderr:
    print(recovered.stderr, file=sys.stderr, end="")
if recovered.returncode:
    raise SystemExit(recovered.returncode)
snapshot = json.loads(recovered.stdout)
buckets = defaultdict(lambda: {host: {"reviews": 0, "characters": 0, "errors": 0} for host in ("pi", "claude")})
for review in snapshot["reviews"]:
    stamp = datetime.fromisoformat(review["timestamp"].replace("Z", "+00:00"))
    if stamp.tzinfo is None:
        raise ValueError("A review timestamp has no timezone")
    day = stamp.astimezone(zone).date()
    b = buckets[day][review["host"]]
    assert review["characters"] > 0
    b["reviews"] += 1
    b["characters"] += review["characters"]
    b["errors"] += review["errors"]
if not buckets:
    raise ValueError("No reviews with recoverable character counts")
first, last = min(buckets), max(buckets)
days = [first + timedelta(days=i) for i in range((last - first).days + 1)]
rows = []
for day in days:
    by_host = buckets[day]
    characters = sum(b["characters"] for b in by_host.values())
    errors = sum(b["errors"] for b in by_host.values())
    row = {
        "date": day.isoformat(),
        "reviewed_prompts": sum(b["reviews"] for b in by_host.values()),
        "reviewed_characters": characters, "errors": errors,
        "errors_per_1000_characters": 1000 * errors / characters if characters else "",
    }
    for host in ("pi", "claude"):
        row[f"{host}_reviewed_prompts"] = by_host[host]["reviews"]
        row[f"{host}_reviewed_characters"] = by_host[host]["characters"]
        row[f"{host}_errors"] = by_host[host]["errors"]
    rows.append(row)

n_reviews = sum(r["reviewed_prompts"] for r in rows)
n_characters = sum(r["reviewed_characters"] for r in rows)
n_errors = sum(r["errors"] for r in rows)
mean = 1000 * n_errors / n_characters
assert n_reviews == len(snapshot["reviews"])
assert n_characters == sum(r["characters"] for r in snapshot["reviews"])
assert n_errors == sum(r["errors"] for r in snapshot["reviews"])

output_dir = args.output_dir.expanduser().resolve()
output_dir.mkdir(parents=True, exist_ok=True)
base = output_dir / "daily-errors-per-1000-characters"
with base.with_suffix(".csv").open("w", newline="") as f:
    writer = csv.DictWriter(f, fieldnames=list(rows[0]))
    writer.writeheader()
    writer.writerows(rows)

plt.rcParams.update({"font.size": 11, "axes.spines.top": False, "axes.spines.right": False})
fig, (ax, volume) = plt.subplots(2, 1, figsize=(11, 6.5), sharex=True,
    gridspec_kw={"height_ratios": [3, 1], "hspace": 0.12})
fig.subplots_adjust(left=0.09, right=0.98, top=0.88, bottom=0.19)
fig.text(0.09, 0.94, "Daily errors per 1,000 reviewed characters", fontsize=18, weight="bold")
x = [datetime.combine(day, datetime.min.time()) for day in days]
y = [r["errors_per_1000_characters"] if r["reviewed_characters"] else float("nan") for r in rows]
ax.plot(x, y, color="#2563eb", marker="o", markersize=7, linewidth=2.4)
for date, value in zip(x, y):
    if value == value:
        ax.annotate(f"{value:.2f}", (date, value), xytext=(0, 10), textcoords="offset points",
            ha="center", color="#1e40af", fontsize=10)
ax.axhline(mean, color="#94a3b8", linestyle="--", linewidth=1.2, label=f"Overall rate: {mean:.2f}")
ax.set_ylabel("Errors / 1,000 characters")
ax.set_ylim(0, max(1, max(value for value in y if value == value) * 1.2))
ax.set_axisbelow(True)
ax.grid(axis="y", color="#eeeeee")
ax.legend(loc="lower left", frameon=False)
volume.bar(x, [r["reviewed_characters"] / 1000 for r in rows], width=0.65, color="#bfdbfe")
for date, row in zip(x, rows):
    value = row["reviewed_characters"] / 1000
    volume.annotate(f"{value:.1f}", (date, value), xytext=(0, 2), textcoords="offset points",
        ha="center", color="#475569", fontsize=9)
volume.set_ylim(0, max(r["reviewed_characters"] / 1000 for r in rows) * 1.3)
volume.set_ylabel("Reviewed\ncharacters (k)")
volume.set_axisbelow(True)
volume.grid(axis="y", color="#eeeeee")
volume.xaxis.set_major_locator(mdates.DayLocator() if len(days) <= 14 else mdates.AutoDateLocator(minticks=6, maxticks=14))
volume.xaxis.set_major_formatter(mdates.DateFormatter("%b %d"))
years = str(first.year) if first.year == last.year else f"{first.year}–{last.year}"
volume.set_xlabel(f"Date ({years} · {args.timezone})")
pi_reviews = sum(r["pi_reviewed_prompts"] for r in rows)
claude_reviews = sum(r["claude_reviewed_prompts"] for r in rows)
fig.text(0.09, 0.059,
    f"{n_reviews} reviews (Pi: {pi_reviews}; Claude: {claude_reviews}); {n_characters:,} reviewed characters. "
    "Zero-error reviews included; suggestions excluded.", fontsize=8.5, color="#64748b")
fig.text(0.09, 0.037,
    "Characters: filtered prose, including spaces/newlines (Unicode code points). Rates = 1,000 × errors / characters.",
    fontsize=8.5, color="#64748b")
fig.text(0.09, 0.015,
    f"Review timestamps in local time; latest day may be incomplete. Reviewer models vary. Missing-length reviews excluded: {len(snapshot['excluded'])}.",
    fontsize=8.5, color="#64748b")
fig.savefig(base.with_suffix(".png"), dpi=180, facecolor="white")
fig.savefig(base.with_suffix(".svg"), facecolor="white")
plt.close(fig)
print(json.dumps({"reviews": n_reviews, "reviewed_characters": n_characters, "errors": n_errors,
    "overall_errors_per_1000_characters": mean, "excluded_reviews": len(snapshot["excluded"]),
    "through": last.isoformat(), "timezone": args.timezone,
    "exclusions_by_reason": dict((reason, sum(r["reason"] == reason for r in snapshot["excluded"]))
        for reason in sorted({r["reason"] for r in snapshot["excluded"]})),
    "output_files": [str(base.with_suffix(suffix)) for suffix in (".png", ".svg", ".csv")],
}, indent=2))
