"""Render an illustrative README demo. Synthetic text only; no host/model calls.

Requires Pillow and DejaVu Sans Mono (regular and bold). Run from any directory.
"""
import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
WIDTH, HEIGHT = 1120, 590
BG = "#0c1220"
PANEL = "#131d2e"
BORDER = "#2b3a52"
TEXT = "#e8eef8"
MUTED = "#a2b1c9"
BLUE = "#5599ff"
PROMPT = "Please fix teh failing test."
DRAFT = "Also check the edge cases."
ANSWER = "I'll inspect the failing test."
FOLLOWUP = "Then I'll check the assertion."
CAPTIONS = (
    "Write naturally. Keep your coding workflow.",
    "Your agent responds. English feedback runs separately.",
    "Corrections appear without interrupting the answer.",
    "Keep drafting your next message.",
    "Hide feedback. Your draft stays intact.",
    "Recall the correction. Carry on coding.",
)


def render(fonts, stage, typed="", answer="", followup="", draft=""):
    image = Image.new("RGB", (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(image)

    def text(x, y, value, color=TEXT, font="body"):
        draw.text((x, y), value, font=fonts[font], fill=color)

    text(32, 22, "English feedback, outside the conversation", font="title")
    text(32, 65, "Two hosts. One independent reviewer.", MUTED)
    for x, host, accent in ((32, "Pi", "#b3a1ff"), (576, "Claude Code", "#e8b18c")):
        right = x + 512
        draw.rounded_rectangle((x, 113, right, 452), radius=14, fill=PANEL, outline=BORDER, width=2)
        draw.ellipse((x + 20, 135, x + 28, 143), fill=accent)
        text(x + 42, 126, host, accent, "bold")
        draw.line((x + 1, 164, right - 1, 164), fill=BORDER)
        if stage:
            text(x + 20, 186, "> " + PROMPT)
            text(x + 20, 235, answer)
            text(x + 20, 264, followup)
        if stage in (2, 3, 5):
            text(x + 20, 322, "Correction: “teh” → “the”", BLUE)
            text(x + 20, 350, "  Swap the last two letters.", BLUE)
        draw.line((x + 20, 397, right - 20, 397), fill=BORDER)
        entry = typed if stage == 0 else draft
        text(x + 20, 412, "> " + entry)
        cursor = x + 20 + draw.textlength("> " + entry, font=fonts["body"])
        draw.rectangle((cursor + 2, 413, cursor + 11, 433), fill=accent)

    text(32, 478, CAPTIONS[stage], font="bold")
    if stage in (4, 5):
        draw.rounded_rectangle((932, 472, 1088, 510), radius=8, fill=BORDER)
        text(960, 480, "Ctrl+N", font="bold")
    for i in range(len(CAPTIONS)):
        left = 32 + 22 * i
        draw.ellipse((left, 525, left + 8, 533), fill=BLUE if i == stage else BORDER)
    text(32, 553, "Illustrated demo · synthetic text · not a terminal recording", MUTED, "small")
    return image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--font-dir", type=Path, default=Path("/usr/share/fonts/truetype/dejavu"))
    args = parser.parse_args()
    try:
        fonts = {
            name: ImageFont.truetype(str(args.font_dir / filename), size)
            for name, filename, size in (
                ("body", "DejaVuSansMono.ttf", 18),
                ("bold", "DejaVuSansMono-Bold.ttf", 18),
                ("title", "DejaVuSansMono-Bold.ttf", 28),
                ("small", "DejaVuSansMono.ttf", 14),
            )
        }
    except OSError:
        parser.error("DejaVu Sans Mono fonts not found; pass --font-dir with regular and bold TTF files")

    frames, durations = [], []

    def add(stage, duration=100, **state):
        frames.append(render(fonts, stage, **state))
        durations.append(duration)

    add(0, 700)
    for n in range(2, len(PROMPT), 2):
        add(0, typed=PROMPT[:n])
    add(0, 500, typed=PROMPT)
    for n in range(0, len(ANSWER), 3):
        add(1, answer=ANSWER[:n])
    add(1, 700, answer=ANSWER)
    for n in range(0, len(FOLLOWUP), 3):
        add(2, answer=ANSWER, followup=FOLLOWUP[:n])
    add(2, 2000, answer=ANSWER, followup=FOLLOWUP)
    for n in range(2, len(DRAFT), 2):
        add(3, answer=ANSWER, followup=FOLLOWUP, draft=DRAFT[:n])
    for stage, duration in ((3, 1200), (4, 2000), (5, 2500)):
        add(stage, duration, answer=ANSWER, followup=FOLLOWUP, draft=DRAFT)

    output = ROOT / "docs" / "assets"
    output.mkdir(parents=True, exist_ok=True)
    frames[-1].save(output / "demo.png")
    # One shared palette prevents color flicker; every frame is opaque.
    palette = frames[-1].quantize(colors=96)
    indexed = [frame.quantize(palette=palette, dither=0) for frame in frames]
    indexed[0].save(output / "demo.gif", save_all=True, append_images=indexed[1:],
                    duration=durations, loop=0, optimize=False, disposal=1)
    print(f"Wrote {len(frames)} frames ({sum(durations) / 1000:.1f}s) to {output}")


if __name__ == "__main__":
    main()
