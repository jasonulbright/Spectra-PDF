"""The score image the Audiveris capability probe recognizes.

Drawn here, so no third-party score enters the repository. The PNG is checked
in beside this script and compiled into the Rust binary
(`src-tauri/src/audiveris.rs`), so the probe needs no resource folder.

    .venv/Scripts/python.exe tests/fixtures/make_omr_probe.py

One five-line staff at 20 pixels between lines (the spacing Audiveris reads
best), a 4/4 time signature, three bars of quarter notes and a final double
bar. No clef: Audiveris recognizes the notes without one and reports the
missing clef as a warning only.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent
TARGET = HERE / "omr-probe-score.png"
FONT = HERE.parent.parent / "resources" / "fonts" / "LiberationSerif-Bold.ttf"

INTERLINE = 20
MEASURES = 3
STEPS = (4, 3, 2, 1, 2, 3, 4, 5, 3, 3, 2, 2)


def draw() -> Image.Image:
    """The probe score as an 8-bit gray image."""
    left = 60
    top = 110
    bottom = top + 4 * INTERLINE
    right = left + 80 + MEASURES * 380
    image = Image.new("L", (right + 60, 300), 255)
    pen = ImageDraw.Draw(image)
    for line in range(5):
        y = top + line * INTERLINE
        pen.rectangle([left, y - 1, right, y + 1], fill=0)
    pen.rectangle([left, top - 1, left + 2, bottom + 1], fill=0)
    font = ImageFont.truetype(str(FONT), 54)
    x = left + 20
    pen.text((x, top - 8), "4", font=font, fill=0)
    pen.text((x, top + 2 * INTERLINE - 8), "4", font=font, fill=0)
    x += 60
    for measure in range(MEASURES):
        for beat in range(4):
            cx = x + 40 + beat * 85
            cy = bottom - STEPS[measure * 4 + beat] * INTERLINE // 2
            pen.ellipse([cx - 13, cy - 9, cx + 13, cy + 9], fill=0)
            if cy > top + 2 * INTERLINE:
                pen.rectangle([cx + 10, cy - 70, cx + 12, cy], fill=0)
            else:
                pen.rectangle([cx - 13, cy, cx - 11, cy + 70], fill=0)
        x += 380
        if measure == MEASURES - 1:
            pen.rectangle([x - 12, top - 1, x - 10, bottom + 1], fill=0)
            pen.rectangle([x - 6, top - 1, x + 1, bottom + 1], fill=0)
        else:
            pen.rectangle([x - 1, top - 1, x + 1, bottom + 1], fill=0)
    return image


def main() -> None:
    draw().save(TARGET, dpi=(300, 300), optimize=True)
    print(f"wrote {TARGET.name}")


if __name__ == "__main__":
    main()
