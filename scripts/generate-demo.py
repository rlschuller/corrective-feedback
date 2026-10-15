"""Render the README demo GIF. Synthetic text only; no host/model calls.

Requires Pillow and DejaVu Sans Mono (regular and bold). Run from any directory.
"""
import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
WIDTH, HEIGHT = 880, 372
BG = "#0c1220"
PANEL = "#131d2e"
BORDER = "#2b3a52"
TEXT = "#e8eef8"
MUTED = "#6f7f99"
BLUE = "#5599ff"
HOSTS = (("Pi", "#b3a1ff"), ("Claude Code", "#e8b18c"))
PROMPT = "Please fix teh failing test."
ANSWER = ("I'll inspect the failing test.", "Then I'll check the assertion.")
DRAFT = "Also check the edge cases."
CORRECTION = ("Correction: “teh” → “the”", "  Swap the last two letters.")


def render(fonts, host, typed="", sent=False, answer=("", ""), correction=False,
           draft="", key=False):
    image = Image.new("RGB", (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(image)

    def text(x, y, value, color=TEXT, font="body"):
        draw.text((x, y), value, font=fonts[font], fill=color)

    left, right = 24, WIDTH - 24
    draw.rounded_rectangle((left, 24, right, HEIGHT - 24), radius=14, fill=PANEL,
                           outline=BORDER, width=2)
    # Host tabs: the active one is filled and colored.
    x = left + 16
    for i, (name, color) in enumerate(HOSTS):
        width = draw.textlength(name, font=fonts["bold"]) + 28
        if i == host:
            draw.rounded_rectangle((x, 36, x + width, 66), radius=8, fill=BORDER)
        text(x + 14, 40, name, color if i == host else MUTED, "bold")
        x += width + 8
    draw.line((left + 1, 78, right - 1, 78), fill=BORDER)

    if sent:
        text(left + 20, 98, "> " + PROMPT)
        text(left + 20, 142, answer[0])
        text(left + 20, 170, answer[1])
    if correction:
        text(left + 20, 220, CORRECTION[0], BLUE)
        text(left + 20, 248, CORRECTION[1], BLUE)

    accent = HOSTS[host][1]
    draw.line((left + 20, 290, right - 20, 290), fill=BORDER)
    entry = draft if sent else typed
    text(left + 20, 306, "> " + entry)
    cursor = left + 20 + draw.textlength("> " + entry, font=fonts["body"])
    draw.rectangle((cursor + 2, 307, cursor + 11, 327), fill=accent)
    if key:
        draw.rounded_rectangle((right - 104, 300, right - 20, 332), radius=7, fill=BLUE)
        text(right - 92, 305, "Ctrl+N", BG, "bold")
    return image


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--font-dir", type=Path, default=Path("/usr/share/fonts/truetype/dejavu"))
    args = parser.parse_args()
    try:
        fonts = {
            name: ImageFont.truetype(str(args.font_dir / filename), 18)
            for name, filename in (("body", "DejaVuSansMono.ttf"),
                                   ("bold", "DejaVuSansMono-Bold.ttf"))
        }
    except OSError:
        parser.error("DejaVu Sans Mono fonts not found; pass --font-dir with regular and bold TTF files")

    frames, durations = [], []

    def add(duration, **state):
        frames.append(render(fonts, **state))
        durations.append(duration)

    # One step at a time, once per host: prompt, answer, correction, draft,
    # then Ctrl+N hides and recalls the correction while the draft stays.
    for host in range(len(HOSTS)):
        add(700, host=host)
        for n in range(2, len(PROMPT), 2):
            add(70, host=host, typed=PROMPT[:n])
        add(500, host=host, typed=PROMPT)
        for n in range(0, len(ANSWER[0]), 3):
            add(70, host=host, sent=True, answer=(ANSWER[0][:n], ""))
        for n in range(0, len(ANSWER[1]) + 1, 3):
            add(70, host=host, sent=True, answer=(ANSWER[0], ANSWER[1][:n]))
        done = dict(host=host, sent=True, answer=ANSWER)
        add(600, **done)
        add(2000, **done, correction=True)
        for n in range(2, len(DRAFT), 2):
            add(70, **done, correction=True, draft=DRAFT[:n])
        done["draft"] = DRAFT
        add(900, **done, correction=True)
        add(350, **done, key=True)
        add(1300, **done)
        add(350, **done, key=True, correction=True)
        add(2200, **done, correction=True)

    output = ROOT / "docs" / "assets"
    output.mkdir(parents=True, exist_ok=True)
    frames[-1].save(output / "demo.png")
    # One shared palette prevents color flicker; every frame is opaque.
    # Build it from both hosts' frames so each accent color is included.
    sample = Image.new("RGB", (WIDTH, HEIGHT * 4))
    for i, frame in enumerate((frames[len(frames) // 2 - 3], frames[len(frames) // 2 - 1],
                               frames[-3], frames[-1])):
        sample.paste(frame, (0, HEIGHT * i))
    palette = sample.quantize(colors=96)
    indexed = [frame.quantize(palette=palette, dither=0) for frame in frames]
    indexed[0].save(output / "demo.gif", save_all=True, append_images=indexed[1:],
                    duration=durations, loop=0, optimize=False, disposal=1)
    print(f"Wrote {len(frames)} frames ({sum(durations) / 1000:.1f}s) to {output}")


if __name__ == "__main__":
    main()
