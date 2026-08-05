"""O8 slice E — the MRC text-verification gate.

A compression setting is allowed to be lossy. It is NOT allowed to quietly
destroy the text the user came for — and MRC's failure mode when it goes wrong
is exactly that: the stencil is where every glyph lives, so a segmentation that
misjudges a page does not produce a visibly broken document, it produces a
plausible-looking one whose words have changed. `mrc_verify_text` is the switch
that refuses to ship such a page.

Three things here were decided rather than assumed, and each is the reason the
obvious shape would have been wrong:

1. **The comparison is made against the LAYERS THAT WERE ENCODED, not against
   an idealised composite.** `reconstruct_page` decodes the very `bg`/`fg`
   bytes about to be embedded and composites them through the very stencil
   that was verified — so JPEG blocking, JPEG2000 rate loss and the
   downsample/upsample round trip are all inside the measurement. A
   reconstruction built from the pre-encode arrays would grade a page on
   quality it is not going to ship.

2. **The revert happens BEFORE the surgery, never after it.** The pass builds
   the layers, reconstructs, recognises, compares — and only then rewrites the
   page. A page that fails is a page nothing was done to: there is no undo
   path to get wrong, and the output carries the ORIGINAL scan for that page.

3. **`SequenceMatcher` is used with `autojunk=False` over a normalised word
   list, and never positionally** (§ 1.6 rule 4). The autojunk heuristic
   discards any token appearing in more than 1% of a sequence longer than 200
   — on a page of prose that is most words — and it scored a CORRECT page at
   7/713 during recon. A positional `zip` misaligns completely after one
   inserted word.
"""

from __future__ import annotations

import difflib
import io
import re
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

from .recognize import recognize_image

#: Words are compared case-folded and whitespace-split. Nothing else is
#: normalised: stripping punctuation would hide a comma-for-period
#: substitution, which is the scanner substitution class this gate is for.
_WORD_RE = re.compile(r"\S+")


def normalize_words(text: str) -> list[str]:
    return _WORD_RE.findall((text or "").lower())


def text_similarity(before: str, after: str) -> tuple[float, str]:
    """(ratio, first divergence) over normalised word lists.

    A source page with NO recognisable text scores 1.0 — there is nothing to
    lose, and a scan with no text layer is the ordinary case for this feature
    (MRC does not create one; § 9 boundary 3). Scoring it 0 would revert every
    page of a wordless scan, which is the opposite of what the gate is for.
    """
    a = normalize_words(before)
    b = normalize_words(after)
    if not a:
        return 1.0, ""
    matcher = difflib.SequenceMatcher(None, a, b, autojunk=False)
    ratio = matcher.ratio()
    first = ""
    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag != "equal":
            first = f"{tag}: {a[i1:i2][:6]} -> {b[j1:j2][:6]}"
            break
    return ratio, first


def reconstruct_page(
    bg_bytes: bytes,
    fg_bytes: bytes,
    ink: np.ndarray,
    size: tuple[int, int],
) -> Image.Image:
    """What a viewer will draw: background, then foreground through the stencil.

    `size` is (width, height) at the SOURCE resolution — the stencil's own —
    because that is the resolution the text survives at and therefore the
    resolution the comparison has to be made at. Both layers are decoded from
    the bytes that are about to be embedded (see the module docstring); the
    upsample is bilinear, matching what a renderer does with a scaled image.
    """
    width, height = size
    background = Image.open(io.BytesIO(bg_bytes)).convert("RGB")
    foreground = Image.open(io.BytesIO(fg_bytes)).convert("RGB")
    bg_full = np.asarray(
        background if background.size == (width, height)
        else background.resize((width, height), Image.BILINEAR),
        dtype=np.uint8,
    )
    if foreground.size == (1, 1):
        # The common case — one ink. A 1x1 resized bilinearly is the same flat
        # colour, but going through the resize costs a full-page allocation
        # for nothing.
        fg_full = np.asarray(foreground, dtype=np.uint8).reshape(1, 1, 3)
    else:
        fg_full = np.asarray(
            foreground.resize((width, height), Image.BILINEAR), dtype=np.uint8
        )
    return Image.fromarray(np.where(ink[:, :, None], fg_full, bg_full).astype(np.uint8))


def recognize_page_image(
    image: Image.Image, lang: str, tesseract_path: str
) -> str:
    """Plain text of one page raster, through the app's ONE recognizer."""
    with tempfile.TemporaryDirectory(prefix="spectrapdf_mrcverify_") as work:
        png = Path(work) / "page.png"
        image.save(png, format="PNG")
        return recognize_image(str(png), lang=lang, tesseract_path=tesseract_path)["text"]


def compare_page(
    source: Image.Image,
    output: Image.Image,
    lang: str,
    tesseract_path: str,
) -> tuple[float, str]:
    """Recognise both rasters and score the output against the source."""
    before = recognize_page_image(source, lang, tesseract_path)
    after = recognize_page_image(output, lang, tesseract_path)
    return text_similarity(before, after)
