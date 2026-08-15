"""Colour contrast of drawn text against what is painted under it.

The question a contrast checker has to answer is not "what colour is this
text" — that is one operand — but "what is it painted ON". That is a question
about paint order, which `sanitize_content`'s event walk already answers for
the hidden-text detectors: `backdrop_under` returns the last cover containing
a run together with whether the walk TRUSTS the answer.

Two rules follow, and both are the difference between a checker people believe
and one they turn off:

1. **An untrusted backdrop is never a failure.** A run over an image, a
   shading or a general path may be perfectly legible; the walk cannot say.
   Those runs are reported for review with their measured ink colour and no
   ratio, never as a fail.
2. **The threshold is a function of the run's own size and weight.** WCAG 2.1
   SC 1.4.3 puts large text at 3:1 and everything else at 4.5:1, and large
   means 18 pt, or 14 pt when the face is bold. Applying the small-text
   threshold to a 24 pt heading is the false failure this check would be
   deleted over.

Runs that paint no glyph (invisible render modes) and runs whose text is
whitespace are not contrast questions and are skipped — `sanitize_content`
owns the first as its own finding class.
"""

from __future__ import annotations

from engine.sanitize_content import (
    FILL_MODES,
    backdrop_under,
    off_ocg_set,
    page_events,
)

# WCAG 2.1 SC 1.4.3.
NORMAL_RATIO = 4.5
LARGE_RATIO = 3.0
# "Large scale" in points: 18 pt, or 14 pt bold.
LARGE_PT = 18.0
LARGE_BOLD_PT = 14.0

# Weight names a /BaseFont spells when the face is bold or heavier. Matched
# case-insensitively against the whole name, which is where a subset prefix
# (ABCDEF+Helvetica-Bold) and a family suffix both live.
_BOLD_TOKENS = ("bold", "black", "heavy", "ultra", "semibold", "demibold")


def _channel(value: float) -> float:
    c = min(max(float(value), 0.0), 1.0)
    return c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4


def relative_luminance(rgb) -> float:
    """WCAG relative luminance of an sRGB triple in 0..1."""
    r, g, b = (_channel(v) for v in rgb[:3])
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast_ratio(a, b) -> float:
    """The WCAG contrast ratio of two sRGB triples, always >= 1."""
    la, lb = relative_luminance(a), relative_luminance(b)
    lighter, darker = (la, lb) if la >= lb else (lb, la)
    return (lighter + 0.05) / (darker + 0.05)


def is_bold(base_font: str) -> bool:
    name = str(base_font or "").lower()
    return any(token in name for token in _BOLD_TOKENS)


def required_ratio(size: float, base_font: str) -> float:
    try:
        pt = float(size)
    except (TypeError, ValueError):
        pt = 0.0
    if pt >= LARGE_PT or (pt >= LARGE_BOLD_PT and is_bold(base_font)):
        return LARGE_RATIO
    return NORMAL_RATIO


def page_contrast(pdf, page, page_no: int, off_set: set) -> list:
    """Every drawn text run on one page as a contrast measurement.

    Each entry: {page, index, text, rect, ink, background, ratio, required,
    status}. `status` is "pass", "fail" or "review"; a review entry carries
    `background=None` and `ratio=None` because the walk could not resolve what
    the run sits on.
    """
    an = page_events(pdf, page, off_set)
    out: list = []
    for position, event in enumerate(an.events):
        if event.kind != "text":
            continue
        info = event.payload
        if info["empty"] or info["off_layer"]:
            continue
        if info["mode"] not in FILL_MODES:
            continue
        ink = info["rgb"]
        required = required_ratio(info["size"], info["font"])
        if ink is None:
            # A pattern or an unresolvable colour space: the ink itself is not
            # a measurement.
            out.append(
                _entry(page_no, info, event.rect, None, None, None, required, "review")
            )
            continue
        background, trusted = backdrop_under(an.events, position, event.rect)
        if not trusted:
            out.append(
                _entry(page_no, info, event.rect, ink, None, None, required, "review")
            )
            continue
        ratio = contrast_ratio(ink, background)
        status = "pass" if ratio + 1e-9 >= required else "fail"
        out.append(
            _entry(page_no, info, event.rect, ink, background, ratio, required, status)
        )
    return out


def _entry(page_no, info, rect, ink, background, ratio, required, status) -> dict:
    return {
        "page": page_no,
        "index": info["index"],
        "text": info["text"],
        "rect": [round(float(v), 2) for v in rect],
        "size": round(float(info["size"]), 2),
        "ink": [round(float(v), 4) for v in ink] if ink is not None else None,
        "background": (
            [round(float(v), 4) for v in background] if background is not None else None
        ),
        "ratio": round(float(ratio), 2) if ratio is not None else None,
        "required": required,
        "status": status,
    }


def document_contrast(pdf) -> tuple:
    """(measurements, unreadable pages) over every page.

    A page whose content stream will not parse is NAMED rather than counted as
    clean — "could not read" is never reported as "nothing found".
    """
    off_set = off_ocg_set(pdf)
    out: list = []
    unreadable: list = []
    for i, page in enumerate(pdf.pages):
        try:
            out.extend(page_contrast(pdf, page, i + 1, off_set))
        except Exception as exc:
            unreadable.append({"page": i + 1, "reason": str(exc)})
    return out, unreadable
