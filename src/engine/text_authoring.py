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
"""

from pathlib import Path

import pikepdf
from pikepdf import ContentStreamInstruction as _CSI
from pikepdf import Dictionary, Name, Operator, String

from engine.font_fallback import build_fallback_font, resolve_fallback_font, synthetic_family_font
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
    still gets its own line (never dropped)."""
    space_w = width_1000(" ") / 1000.0 * size
    lines: list[str] = []
    cur: list[str] = []
    cur_w = 0.0
    for word in words:
        ww = width_1000(word) / 1000.0 * size
        add = ww + (space_w if cur else 0.0)
        if cur and cur_w + add > max_width:
            lines.append(" ".join(cur))
            cur, cur_w = [word], ww
        else:
            cur.append(word)
            cur_w += add
    if cur:
        lines.append(" ".join(cur))
    return lines


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
) -> dict:
    """Author a new text box on `page`.

    `rect` is [x0, y0, x1, y1] in USER-space PDF points (bottom-left
    origin). `text` is placed from the top of the box, wrapping at its
    width; explicit newlines are honoured as hard breaks. `size` (points,
    clamped), `color` an [r,g,b] 0-1 (default black), `font_path` the
    bundled fonts dir (or a face), `family` serif/sans/mono (default sans).
    Text that would overflow the page BOTTOM is shifted up to stay visible
    (never a success that renders off the sheet). The authored run is a
    normal Type0+ToUnicode object — editable and searchable afterward."""
    body = str(text)
    words = body.split()
    if not words:
        raise ValueError("no text to add")
    try:
        x0, y0, x1, y1 = (float(v) for v in rect)
    except (TypeError, ValueError):
        raise ValueError("rect must be [x0, y0, x1, y1]") from None
    left, right = min(x0, x1), max(x0, x1)
    top, bottom = max(y0, y1), min(y0, y1)
    box_w = max(right - left, 1.0)

    sz = max(1.0, min(_MAX_SIZE, float(size) if size else 12.0))
    leading = sz * _LEADING_EM
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
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]

        # A face matching the requested family (B1); no original font to
        # match against, so `family` drives it (sans default).
        if family in ("serif", "mono", "sans"):
            face = resolve_fallback_font(str(font_path), synthetic_family_font(family))
        else:
            face = resolve_fallback_font(str(font_path), None)

        # Chars actually DRAWN — control whitespace is structural (the line
        # breaks handled just below), never a glyph, so it stays out of the
        # embedded subset.
        unique = "".join(sorted(set(body) - {"\n", "\r", "\t"}))
        font_dict, encode, width_1000 = build_fallback_font(pdf, face, unique)

        # Honour the user's line breaks as HARD breaks (the entry control is a
        # textarea), then greedy-wrap each segment to the box width. A blank
        # line stays a blank line; leading/trailing blanks are trimmed.
        lines: list[str] = []
        for segment in body.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
            seg_words = segment.split()
            if not seg_words:
                lines.append("")
                continue
            lines.extend(_wrap(seg_words, width_1000, sz, box_w))
        while lines and lines[0] == "":
            lines.pop(0)
        while lines and lines[-1] == "":
            lines.pop()

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
        y_top = top - sz  # first baseline: one em below the box top
        # Keep the block on the VISIBLE page. The box's own bottom is only a
        # hint — text may overflow it downward like any text box — but text off
        # the sheet is silently invisible, so if the last baseline would fall
        # below the page (cropbox: viewers clip to it; mediabox as fallback),
        # shift the whole block UP, capped so the first line never rises above
        # the page top. A block taller than the page still overflows at the
        # bottom (genuinely too much text) but keeps its top visible — never a
        # success that renders nothing.
        try:
            vbox = [float(v) for v in p.cropbox]
        except Exception:
            try:
                vbox = [float(v) for v in p.mediabox]
            except Exception:
                vbox = [0.0, 0.0, 0.0, top + sz]
        page_lly, page_ury = vbox[1], vbox[3]
        last_baseline = y_top - (len(lines) - 1) * leading
        if last_baseline < page_lly:
            y_top = min(page_ury - sz, y_top + (page_lly - last_baseline))
        for i, line in enumerate(lines):
            if not line:
                continue  # blank line: y still advances via `i`
            line_w = width_1000(line) / 1000.0 * sz
            if align == "center":
                lx = left + (box_w - line_w) / 2
            elif align == "right":
                lx = right - line_w
            else:
                lx = left
            ly = y_top - i * leading
            instrs.append(csi([1, 0, 0, 1, round(lx, 4), round(ly, 4)], "Tm"))
            instrs.append(csi([String(encode(line))], "Tj"))
        instrs.append(csi([], "ET"))
        instrs.append(csi([], "Q"))

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
