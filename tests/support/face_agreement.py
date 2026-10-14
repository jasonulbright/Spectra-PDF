"""What `text_box_appearance` refuses, per character, for a face folder with
chosen files hidden.

Reads `{font_path, scenarios: [{family, bold, italic, hidden}]}` on stdin.
Writes `{samples, answers: [{faces, refused}]}`: `samples` holds characters of
every script a table face holds and characters no face holds; `refused` is
parallel to it."""

import json
import os
import sys

sys.path.insert(0, "src")

from fontTools.unicodedata import script  # noqa: E402

from engine import font_fallback as ff  # noqa: E402
from engine.text_box import _MAX_BLOCKS, text_box_appearance  # noqa: E402

PER_SCRIPT = 8
# Scripts no table face holds, white space that is not the space, a
# variation selector, a private use character.
OUTSIDE = "नกᠠ\U0001f600 \u0001︀\U000f0000ܐ߁കက"


def samples_of(font_path: str) -> list:
    names = sorted({name for table in (*ff._FACE_FILES.values(), ff._CJK_FACES, *ff._RTL_FACES.values()) for name in table.values()})
    by_script: dict = {}
    for name in names:
        for point in ff.face_glyph_names(os.path.join(font_path, name)):
            if 0xD800 <= point <= 0xDFFF:
                continue
            by_script.setdefault(script(chr(point)), set()).add(point)
    out: list = []
    for key in sorted(by_script):
        points = sorted(by_script[key])
        step = max(1, len(points) // PER_SCRIPT)
        out.extend(chr(point) for point in sorted({*points[::step][:PER_SCRIPT], points[-1]}))
    return out + [ch for ch in OUTSIDE if ch not in out]


def main() -> None:
    request = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    font_path = request["font_path"]
    samples = samples_of(font_path)
    isfile, listdir = os.path.isfile, os.listdir
    answers = []
    for scenario in request["scenarios"]:
        hidden = set(scenario["hidden"])
        os.path.isfile = lambda path, hidden=hidden: os.path.basename(str(path)) not in hidden and isfile(path)
        os.listdir = lambda path, hidden=hidden: [name for name in listdir(path) if name not in hidden]
        try:
            refused: list = []
            faces: list = []
            for start in range(0, len(samples), _MAX_BLOCKS):
                blocks = [
                    {"text": ch, "family": scenario["family"], "bold": scenario["bold"], "italic": scenario["italic"]}
                    for ch in samples[start:start + _MAX_BLOCKS]
                ]
                answer = text_box_appearance(blocks, font_path, False, True)
                faces = answer["faces"]
                refused.extend("refused" in block for block in answer["blocks"])
        finally:
            os.path.isfile, os.listdir = isfile, listdir
        answers.append({"faces": faces, "refused": refused})
    sys.stdout.buffer.write(json.dumps({"samples": samples, "answers": answers}).encode("utf-8"))


if __name__ == "__main__":
    main()
