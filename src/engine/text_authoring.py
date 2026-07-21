"""Add Text — author a NEW text object on a page (Phase 9.A2).

The counterpart to the editing path: instead of rewriting existing runs,
this APPENDS a fresh text object. It reuses 7.4's subset-embed
(`build_fallback_font` → Type0/Identity-H + ToUnicode), so the authored
text is searchable AND re-editable by the shipped 7.2/7.5 editors with no
special case — the next `list_text_runs`/`list_text_paragraphs` sees it as
an ordinary editable run.

Pure authoring: no content-stream surgery of existing content. The new
drawing is wrapped in `q … Q` so it can't inherit or leak graphics state,
and positioned in USER space at the page's top level (identity ctm — no
inversion needed, unlike the paragraph emitter's in-context rewrite).
A2-tail: `rotate` wraps that same block in one 90°-step rotation frame
(`cm`) mapping the local layout onto the drawn box; rotate=0 emits the
frame-less shipped bytes.
A2-tail-2: `bold`/`italic` compose the A3b style into the same fallback
ladder (both face seats), and `measure_text_box` reports the identical
layout without writing — ONE shared `_layout_box` pass for both ops (the
walker-agreement discipline), so the card's fit indicator can never
disagree with the commit.
"""

from pathlib import Path
from typing import NamedTuple

import pikepdf
from pikepdf import ContentStreamInstruction as _CSI
from pikepdf import Dictionary, Name, Operator, String

from engine.font_fallback import (
    build_fallback_font,
    resolve_fallback_font,
    style_key,
    synthetic_family_font,
)
from engine.page_images import _save

_LEADING_EM = 1.2
_MAX_SIZE = 1638.0


def _fresh_font_name(fonts) -> str:
    taken = {str(k) for k in fonts.keys()} if fonts is not None else set()
    i = 0
    while True:
        name = f"/AddTxt{i}"
        if name not in taken:
            return name
        i += 1


def _wrap(words, width_1000, size: float, max_width: float) -> list[str]:
    """Greedy fill at `max_width` (user units). A single over-wide word
    still gets its own line (never dropped).

    9.K1: the candidate line is measured AS A WHOLE STRING rather than as a
    sum of word widths plus spaces. With kerning on, a per-word sum would
    miss the pairs that straddle the spaces, so the wrap could disagree with
    what is actually drawn — and measurement agreeing with drawing is the
    property this shares with `measure_text_box`."""
    lines: list[str] = []
    cur: list[str] = []
    for word in words:
        candidate = " ".join(cur + [word])
        if cur and width_1000(candidate) / 1000.0 * size > max_width:
            lines.append(" ".join(cur))
            cur = [word]
        else:
            cur.append(word)
    if cur:
        lines.append(" ".join(cur))
    return lines


def _show_instruction(line: str, encode, pairs, csi, Array) -> object:
    """The show op for one line: a plain `Tj`, or a `TJ` array carrying the
    face's pair kerning (9.K1).

    Sign discipline, stated where it is emitted: a number in a `TJ` array
    moves the next glyph LEFT by `n/1000 x size`, and kern values are
    negative when a pair should tighten, so the emitted number is the
    NEGATION of the kern (`tj_offset`). A line whose pairs all happen to be
    zero falls back to `Tj`, so a face with no kerning (Liberation Mono) and
    `kern=False` produce byte-identical output to the shipped path."""
    from engine.font_kerning import tj_offset

    if not pairs or len(line) < 2:
        return csi([String(encode(line))], "Tj")
    parts: list = []
    chunk = ""
    for i, ch in enumerate(line):
        chunk += ch
        if i + 1 < len(line):
            k = pairs.get((ch, line[i + 1]), 0.0)
            if k:
                parts.append(String(encode(chunk)))
                parts.append(round(tj_offset(k), 3))
                chunk = ""
    if chunk:
        parts.append(String(encode(chunk)))
    if len(parts) < 2:  # nothing actually kerned on this line
        return csi([String(encode(line))], "Tj")
    return csi([Array(parts)], "TJ")


class _BoxLayout(NamedTuple):
    """Everything the fit-vs-commit agreement depends on, produced ONCE by
    `_layout_box`. `add_text_box` additionally emits + shift-up + saves;
    `measure_text_box` reads only `lines`/`leading`/`l_h`."""
    lines: list
    body: str
    leading: float
    sz: float
    rot: int
    l_left: float
    l_right: float
    l_top: float
    l_w: float
    l_h: float
    frame: list  # None for rotate=0
    left: float
    right: float
    top: float
    bottom: float
    font_dict: object
    encode: object
    width_1000: object
    # 9.K1: the face's pair kerning ({} when kern=False, or when the face has
    # none — Liberation Mono genuinely has none, so a monospace box simply
    # never kerns with no special case).
    kern_pairs: dict


def _layout_box(pdf, text, rect, size, font_path, family, rotate, bold, italic, kern=True) -> _BoxLayout:
    """The ONE layout pass shared by `add_text_box` and `measure_text_box`
    — validation, box geometry (incl. the A2-tail rotation transposition),
    face resolution (family + A3b bold/italic style), subset-font build,
    and the greedy wrap. Single-sourced on purpose: the card's live fit
    indicator runs the SAME code the commit runs, so they can never
    disagree (the walker-agreement discipline applied to authoring)."""
    body = str(text)
    words = body.split()
    if not words:
        raise ValueError("no text to add")
    try:
        x0, y0, x1, y1 = (float(v) for v in rect)
    except (TypeError, ValueError):
        raise ValueError("rect must be [x0, y0, x1, y1]") from None
    # Strict on purpose (size/rect coerce; this refuses "90"/True): 90°
    # steps only is the A2-tail contract, and rotate is the one parameter
    # where a silently-coerced wrong value flips the whole geometry.
    if isinstance(rotate, bool) or not isinstance(rotate, (int, float)) or rotate not in (0, 90, 180, 270):
        raise ValueError(f"rotate must be 0, 90, 180, or 270 (got {rotate!r})")
    # Strict booleans (A2-tail-2): checked as bool, NOT truthiness — bool is
    # an int subclass, so a real True/False passes while bold=1 / italic="y"
    # refuse (a coerced style would silently pick the wrong face).
    if not isinstance(bold, bool):
        raise ValueError(f"bold must be true or false (got {bold!r})")
    if not isinstance(italic, bool):
        raise ValueError(f"italic must be true or false (got {italic!r})")
    rot = int(rotate)
    left, right = min(x0, x1), max(x0, x1)
    top, bottom = max(y0, y1), min(y0, y1)
    box_w = max(right - left, 1.0)

    # A2-tail: the block lays out LOCALLY exactly like rotate=0 in a
    # [0, 0, l_w, l_h] box whose l_w is the drawn dimension ALONG the
    # reading direction (90/270 read along the drawn HEIGHT), then ONE
    # rotation frame `q <cos sin -sin cos tx ty> cm … Q` maps local onto
    # the drawn box. The anchor is the corner the local ORIGIN lands on —
    # rotating the box CCW carries its bottom-left there: 90 ⇒ bottom-right
    # (local +x runs UP the page, +y LEFT), 180 ⇒ top-right, 270 ⇒ top-left
    # (+x DOWN, +y RIGHT). rotate=0 keeps the shipped device-space path
    # byte-for-byte (no frame).
    if rot in (90, 270):
        l_w, l_h = max(top - bottom, 1.0), right - left
    else:
        l_w, l_h = box_w, top - bottom
    if rot == 0:
        l_left, l_right, l_top = left, right, top
        frame = None
    else:
        l_left, l_right, l_top = 0.0, l_w, l_h
        frame = {
            90: [0, 1, -1, 0, round(right, 4), round(bottom, 4)],
            180: [-1, 0, 0, -1, round(right, 4), round(top, 4)],
            270: [0, -1, 1, 0, round(left, 4), round(top, 4)],
        }[rot]

    sz = max(1.0, min(_MAX_SIZE, float(size) if size else 12.0))
    leading = sz * _LEADING_EM

    # A2-tail-2: compose the A3b style into the SAME resolve ladder (both
    # face seats). style_key(False, False) == "regular" == the shipped
    # default, so the no-style path stays byte-identical.
    sk = style_key(bold, italic)
    if family in ("serif", "mono", "sans"):
        face = resolve_fallback_font(str(font_path), synthetic_family_font(family), style=sk)
    else:
        face = resolve_fallback_font(str(font_path), None, style=sk)

    # Chars actually DRAWN — control whitespace is structural (the line
    # breaks handled just below), never a glyph, so it stays out of the
    # embedded subset.
    unique = "".join(sorted(set(body) - {"\n", "\r", "\t"}))
    font_dict, encode, width_1000 = build_fallback_font(pdf, face, unique)

    # 9.K1: pair kerning from the resolved face. Wrapping, centring and
    # justification all read `width_1000`, so folding the kern INTO it is what
    # keeps measurement and drawing in agreement — the same property
    # `measure_text_box` depends on by sharing this pass.
    if not isinstance(kern, bool):
        raise ValueError(f"kern must be true or false (got {kern!r})")
    pairs: dict = {}
    if kern:
        from engine.font_kerning import kern_pairs as _kern_pairs, kerned_width

        pairs = _kern_pairs(str(face))
        if pairs:
            _base_width = width_1000

            def width_1000(t, _b=_base_width, _p=pairs):  # noqa: F811
                return _b(t) + kerned_width(_p, t)

    # Honour the user's line breaks as HARD breaks (the entry control is a
    # textarea), then greedy-wrap each segment to the box width. A blank
    # line stays a blank line; leading/trailing blanks are trimmed.
    lines: list[str] = []
    for segment in body.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        seg_words = segment.split()
        if not seg_words:
            lines.append("")
            continue
        lines.extend(_wrap(seg_words, width_1000, sz, l_w))
    while lines and lines[0] == "":
        lines.pop(0)
    while lines and lines[-1] == "":
        lines.pop()

    return _BoxLayout(
        lines=lines, body=body, leading=leading, sz=sz, rot=rot,
        l_left=l_left, l_right=l_right, l_top=l_top, l_w=l_w, l_h=l_h,
        frame=frame, left=left, right=right, top=top, bottom=bottom,
        font_dict=font_dict, encode=encode, width_1000=width_1000,
        kern_pairs=pairs,
    )


def add_text_box(
    file: str,
    output: str,
    page: int,
    rect: list,
    text: str,
    size: float = 12.0,
    color: list | None = None,
    font_path: str = "",
    align: str = "left",
    family: str | None = None,
    rotate: int = 0,
    bold: bool = False,
    italic: bool = False,
    kern: bool = True,
) -> dict:
    """Author a new text box on `page`.

    `rect` is [x0, y0, x1, y1] in USER-space PDF points (bottom-left
    origin). `text` is placed from the top of the box, wrapping at its
    width; explicit newlines are honoured as hard breaks. `size` (points,
    clamped), `color` an [r,g,b] 0-1 (default black), `font_path` the
    bundled fonts dir (or a face), `family` serif/sans/mono (default sans),
    `bold`/`italic` (A2-tail-2) pick the styled face from the same bundle.
    `rotate` (0/90/180/270, CCW) turns the WHOLE block within the box —
    at 90/270 it lays out along the box's HEIGHT (reading bottom-to-top /
    top-to-bottom), at 180 upside-down. Text that would overflow the page
    BOTTOM is shifted up to stay visible (never a success that renders off
    the sheet). The authored run is a normal Type0+ToUnicode object —
    editable and searchable afterward (rotated: on the run surface, the
    standing rotated-text boundary)."""
    if color is None:
        rgb = (0.0, 0.0, 0.0)
    else:
        try:
            rgb = tuple(max(0.0, min(1.0, float(c))) for c in color)[:3]
        except (TypeError, ValueError):
            rgb = (0.0, 0.0, 0.0)
        if len(rgb) != 3:
            rgb = (0.0, 0.0, 0.0)

    input_path = Path(file)
    output_path = Path(output)
    pdf = pikepdf.open(file)
    try:
        # Input-shape validation (text/rect/rotate/style) runs FIRST, before
        # the page-range check — the pre-refactor precedence (a doubly-invalid
        # call surfaces the input error, not the page error).
        lay = _layout_box(pdf, text, rect, size, font_path, family, rotate, bold, italic, kern)
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]

        body, lines, leading, sz, rot = lay.body, lay.lines, lay.leading, lay.sz, lay.rot
        l_left, l_right, l_top, l_w = lay.l_left, lay.l_right, lay.l_top, lay.l_w
        left, right, top, bottom = lay.left, lay.right, lay.top, lay.bottom
        frame = lay.frame
        font_dict, encode, width_1000 = lay.font_dict, lay.encode, lay.width_1000

        res = p.obj.get("/Resources")
        if res is None:
            res = Dictionary()
            p.obj["/Resources"] = res
        fonts = res.get("/Font")
        if fonts is None:
            fonts = Dictionary()
            res["/Font"] = fonts
        fname = _fresh_font_name(fonts)
        fonts[Name(fname)] = font_dict

        def csi(operands, op):
            return _CSI(operands, Operator(op))

        instrs = [
            csi([], "q"),
            csi([], "BT"),
            csi([Name(fname), sz], "Tf"),
            csi(list(rgb), "rg"),
        ]
        y_top = l_top - sz  # first baseline: one em below the (local) box top
        # Keep the block on the VISIBLE page. The box's own bottom is only a
        # hint — text may overflow it downward like any text box — but text off
        # the sheet is silently invisible, so if the last baseline would fall
        # below the page (cropbox: viewers clip to it; mediabox as fallback),
        # shift the whole block UP, capped so the first line never rises above
        # the page top. A block taller than the page still overflows at the
        # bottom (genuinely too much text) but keeps its top visible — never a
        # success that renders nothing. Rotated: the SAME rule in LOCAL space —
        # the frame is a rigid 90°-step turn, so the page box's preimage is an
        # axis-aligned local rect and its local-y band substitutes for
        # [lly, ury]; local "down" is wherever overflow marches off the sheet
        # (90: out the page's RIGHT edge, 180: the TOP, 270: the LEFT).
        # Overflow past the drawn box itself stays permitted, like rotate=0.
        try:
            vbox = [float(v) for v in p.cropbox]
        except Exception:
            try:
                vbox = [float(v) for v in p.mediabox]
            except Exception:
                vbox = None
        if vbox is None:
            page_lly, page_ury = 0.0, l_top + sz
        elif rot == 90:
            page_lly, page_ury = right - vbox[2], right - vbox[0]
        elif rot == 180:
            page_lly, page_ury = top - vbox[3], top - vbox[1]
        elif rot == 270:
            page_lly, page_ury = vbox[0] - left, vbox[2] - left
        else:
            page_lly, page_ury = vbox[1], vbox[3]
        last_baseline = y_top - (len(lines) - 1) * leading
        if last_baseline < page_lly:
            y_top = min(page_ury - sz, y_top + (page_lly - last_baseline))
        for i, line in enumerate(lines):
            if not line:
                continue  # blank line: y still advances via `i`
            line_w = width_1000(line) / 1000.0 * sz
            if align == "center":
                lx = l_left + (l_w - line_w) / 2
            elif align == "right":
                lx = l_right - line_w
            else:
                lx = l_left
            ly = y_top - i * leading
            instrs.append(csi([1, 0, 0, 1, round(lx, 4), round(ly, 4)], "Tm"))
            # 9.K1: a TJ array carrying the face's pair kerning; falls back to
            # the shipped Tj when nothing kerns (kern=False, or a face like
            # Liberation Mono that has no pairs at all).
            instrs.append(_show_instruction(line, encode, lay.kern_pairs, csi, pikepdf.Array))
        instrs.append(csi([], "ET"))
        instrs.append(csi([], "Q"))
        if frame is not None:
            instrs = [csi([], "q"), csi(frame, "cm")] + instrs + [csi([], "Q")]

        content = pikepdf.unparse_content_stream(instrs)
        # Shield the EXISTING content in its own q/Q envelope before appending
        # our object. Our object is already q/Q-wrapped, but that only saves
        # whatever CTM is live when it starts — a page whose prior content left
        # a dangling `cm`/`q` (unbalanced) would transform our text by it.
        # Wrapping the original restores the page-initial CTM after its Q, which
        # is the user space our rect/Tm coordinates are expressed in. This is
        # what pikepdf's add_overlay does implicitly; contents_add does not.
        p.contents_add(b"q\n", prepend=True)
        p.contents_add(b"\nQ\n" + content, prepend=False)

        _save(pdf, input_path, output_path)
        return {
            "output": str(output_path),
            "page": int(page),
            "lines": len(lines),
            "chars": len(body),
        }
    finally:
        try:
            pdf.close()
        except Exception:
            pass


def measure_text_box(
    file: str,
    page: int,
    rect: list,
    text: str,
    size: float = 12.0,
    font_path: str = "",
    align: str = "left",
    family: str | None = None,
    rotate: int = 0,
    bold: bool = False,
    italic: bool = False,
    kern: bool = True,
) -> dict:
    """A2-tail-2: report how `text` would lay out in the box WITHOUT
    writing — the card's live fit indicator. Runs the exact `_layout_box`
    pass `add_text_box` runs (same wrap width, size clamp, family/style/
    rotate transposition, and 9.K1 kerning), so `fits` can never disagree
    with the commit.

    `text_height` = one leading per wrapped line (the block's extent down
    from the box top); `box_height` = the box dimension ACROSS the reading
    direction (l_h — the drawn height at 0/180, the drawn width at 90/270).
    `fits` is text_height <= box_height. Overflow is NOT an error — the box
    is a guide, not a clip; the card warns, the commit still proceeds."""
    pdf = pikepdf.open(file)
    try:
        # Same precedence as add_text_box: input-shape checks (inside
        # _layout_box) before the page range.
        lay = _layout_box(pdf, text, rect, size, font_path, family, rotate, bold, italic, kern)
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        # Round BEFORE comparing so the verdict matches the reported numbers
        # and float noise can't flip an exact boundary (14*1.2 and a box's
        # subtracted height land on different last-bit values otherwise).
        text_height = round(len(lay.lines) * lay.leading, 4)
        box_height = round(lay.l_h, 4)
        return {
            "lines": len(lay.lines),
            "text_height": text_height,
            "box_height": box_height,
            "fits": text_height <= box_height,
        }
    finally:
        try:
            pdf.close()
        except Exception:
            pass
