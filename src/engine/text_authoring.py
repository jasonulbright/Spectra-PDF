"""Add Text — author a NEW text object on a page.

The counterpart to the editing path: instead of rewriting existing runs,
this APPENDS a fresh text object. It reuses the subset-embed
(`build_fallback_font` → Type0/Identity-H + ToUnicode), so the authored
text is searchable AND re-editable by the run and paragraph editors with no
special case — the next `list_text_runs`/`list_text_paragraphs` sees it as
an ordinary editable run.

Pure authoring: no content-stream surgery of existing content. The new
drawing is wrapped in `q … Q` so it can't inherit or leak graphics state,
and positioned in USER space at the page's top level (identity ctm — no
inversion needed, unlike the paragraph emitter's in-context rewrite).
`rotate` wraps that same block in one 90°-step rotation frame
(`cm`) mapping the local layout onto the drawn box; rotate=0 emits the
frame-less shipped bytes.
`bold`/`italic` compose the style into the same fallback
ladder (both face seats), and `measure_text_box` reports the identical
layout without writing — ONE shared `_layout_box` pass for both ops (the
walker-agreement discipline), so the card's fit indicator can never
disagree with the commit.
"""

import math
import os
from pathlib import Path
from typing import NamedTuple

import pikepdf
from pikepdf import ContentStreamInstruction as _CSI
from pikepdf import Dictionary, Name, Operator, String

from engine import bidi
from engine.font_fallback import (
    build_fallback_font,
    build_shaped_font,
    resolve_fallback_font,
    style_key,
    synthetic_family_font,
)
from engine.page_images import _save

# The orientation model, imported rather than restated. Authoring transposes
# INTO a writing frame and untransposes back out of it through exactly the
# maps the paragraph reflow uses, so the two cannot drift: a box authored in
# one frame is re-listed in the same one. `_column_direction_evidence` is the
# lister's own answer to "which way do these columns run", which is why an
# authored column can never come back reading the other way.
from engine.text_paragraphs import (
    COLUMNS_LTR,
    COLUMNS_RTL,
    HORIZONTAL,
    TCY_BASELINE_EM,
    VERTICAL_LR,
    VERTICAL_RL,
    _column_direction_evidence,
    _ORIENTATIONS,
    _t,
    _t_inv,
    breaks_between,
)

_LEADING_EM = 1.2
_MAX_SIZE = 1638.0

# The writing modes a caller may request. `vertical` derives its column
# direction from the text; the two explicit spellings are honoured only when
# the text agrees with them (see `_resolve_writing`).
_WRITING_MODES = (HORIZONTAL, "vertical", VERTICAL_RL, VERTICAL_LR)
_H_FRAME = _ORIENTATIONS[HORIZONTAL]

# The OpenType features we can honestly apply (small caps + stylistic
# alternates). "small_caps" expands to smcp+c2sc so mixed-case text becomes
# uniform small caps. Anything else is ignored (never a silent wrong result).
_SMALL_CAPS = ("smcp", "c2sc")


def _normalize_features(features) -> list:
    """A caller's feature request -> the concrete GSUB tags to apply. Accepts
    the convenience token "small_caps" (=> smcp+c2sc) and raw tags."""
    if not features:
        return []
    from engine.font_features import SUPPORTED

    out: list = []
    for f in features:
        f = str(f).strip().lower()
        if f in ("small_caps", "smallcaps"):
            out.extend(_SMALL_CAPS)
        elif f in SUPPORTED:
            out.append(f)
    # de-dup, preserve order
    seen, uniq = set(), []
    for f in out:
        if f not in seen:
            seen.add(f); uniq.append(f)
    return uniq



def _explicit_face(family, style_key_name: str):
    """An ABSOLUTE PATH family selector resolves to that installed
    face, bypassing the bundled ladder entirely: the ladder exists to pick a
    stand-in, and there is nothing to stand in for once the user has named
    the face. None for the three bundled family names (and for no family at
    all), which keeps every shipped path untouched.

    `system_fonts.resolve_face` is where the foundry's embedding permission
    is checked, so a licence-restricted font is refused BY NAME here rather
    than embedded and shipped."""
    if not isinstance(family, str):
        return None
    raw = family.strip()
    if raw.lower() in ("serif", "sans", "mono") or not raw:
        return None
    if not os.path.isabs(raw):
        raise ValueError("family must be serif, sans, mono, or an installed font file")
    from engine.system_fonts import resolve_face

    del style_key_name  # an explicit face carries its own weight and slant
    return resolve_face(raw)


def _resolve_writing(writing_mode, body: str) -> tuple:
    """(frame, columns, vertical) for the requested writing mode.

    The column DIRECTION is derived from the text by the same evidence the
    re-listing uses, and an explicit request is honoured only when the text
    agrees with it. Authoring `vertical-lr` CJK would otherwise produce a box
    that lists back as `vertical-rl` — its columns read in the opposite order
    to the one they were written in, with no error anywhere. Text carrying no
    evidence at all (digits, punctuation) takes the request, or right-to-left
    columns for a bare `vertical`, which is the shipped default."""
    if not isinstance(writing_mode, str) or writing_mode not in _WRITING_MODES:
        raise ValueError(
            "writing_mode must be horizontal, vertical, vertical-rl or vertical-lr "
            f"(got {writing_mode!r})"
        )
    if writing_mode == HORIZONTAL:
        return _H_FRAME, None, False
    evidence = _column_direction_evidence(body)
    if writing_mode == "vertical":
        columns = evidence or COLUMNS_RTL
    else:
        columns = COLUMNS_LTR if writing_mode == VERTICAL_LR else COLUMNS_RTL
        if evidence is not None and evidence != columns:
            if evidence == COLUMNS_LTR:
                raise ValueError(
                    "this text sets columns left to right — use vertical-lr"
                )
            raise ValueError(
                "this text sets columns right to left — use vertical-rl"
            )
    name = VERTICAL_LR if columns == COLUMNS_LTR else VERTICAL_RL
    return _ORIENTATIONS[name], columns, True


def _frame_rect(frame, x0: float, y0: float, x1: float, y1: float) -> tuple:
    """A rect's corners in the writing frame: (left, right, top, bottom).

    Boundary 1. The horizontal frame is the identity, so every number is the
    one the shipped layout computed."""
    xs: list[float] = []
    ys: list[float] = []
    for x, y in ((x0, y0), (x1, y0), (x0, y1), (x1, y1)):
        tx, ty = _t(frame, x, y)
        xs.append(tx)
        ys.append(ty)
    return min(xs), max(xs), max(ys), min(ys)


def _local_page_rect(vbox, rot, frame, left, right, top, bottom) -> tuple:
    """The visible page box expressed in the ROTATION frame's local space.

    The rotation frame is a rigid turn, so the page box's preimage is an
    axis-aligned local rect for every quarter turn; a free angle takes the
    inverse affine and the extent of the four mapped corners."""
    if rot == 0:
        return vbox[0], vbox[1], vbox[2], vbox[3]
    if rot == 90:
        return vbox[1] - bottom, right - vbox[2], vbox[3] - bottom, right - vbox[0]
    if rot == 180:
        return right - vbox[2], top - vbox[3], right - vbox[0], top - vbox[1]
    if rot == 270:
        return top - vbox[3], vbox[0] - left, top - vbox[1], vbox[2] - left
    a_f, b_f, c_f, d_f, e_f, f_f = (float(v) for v in frame)
    det = a_f * d_f - b_f * c_f
    inv_a, inv_c = d_f / det, -c_f / det
    inv_b, inv_d = -b_f / det, a_f / det
    inv_e = (c_f * f_f - d_f * e_f) / det
    inv_f = (b_f * e_f - a_f * f_f) / det
    corners = (
        (vbox[0], vbox[1]), (vbox[2], vbox[1]),
        (vbox[0], vbox[3]), (vbox[2], vbox[3]),
    )
    xs = [x * inv_a + y * inv_c + inv_e for x, y in corners]
    ys = [x * inv_b + y * inv_d + inv_f for x, y in corners]
    return min(xs), min(ys), max(xs), max(ys)


def _page_band(lay: "_BoxLayout", vbox, first_size: float) -> tuple:
    """The visible-page band along the layout's STACKING axis — the interval
    the shift-up rule keeps the block's baselines inside.

    Text off the sheet is silently invisible, so a block whose last baseline
    falls outside the page is shifted back, capped so the first never leaves
    the other end. In a writing frame the stacking axis is y′, which is the
    page's y for horizontal text and its x for a column; deriving the band
    from the frame gives every mode the same rule with no new case."""
    if vbox is None:
        return 0.0, lay.l_top + first_size
    lx0, ly0, lx1, ly1 = _local_page_rect(
        vbox, lay.rot, lay.frame, lay.left, lay.right, lay.top, lay.bottom
    )
    ys = [
        _t(lay.wframe, x, y)[1]
        for x, y in ((lx0, ly0), (lx1, ly0), (lx0, ly1), (lx1, ly1))
    ]
    return min(ys), max(ys)


def _vertical_face(font_path, family, style: str, body: str, columns: str) -> tuple:
    """(face, upright) for a vertical box — the shipped vertical ladder.

    `upright` says which of the two legal vertical representations this face
    takes: an /Identity-V embed of the font's own vertical forms (the CJK
    majority), or a HORIZONTAL shaped subset drawn under a quarter turn (the
    Mongolian family, whose faces state no vertical advance worth embedding
    as /W2). The bundled serif/sans/mono selectors have nothing honest to
    resolve to for a column and are ignored — an absence the card states
    rather than silently swallows."""
    if columns == COLUMNS_LTR:
        from engine.font_fallback import resolve_mongolian_font

        return resolve_mongolian_font(str(font_path), body, style=style), False
    explicit = _explicit_face(family, style)
    if explicit is not None:
        from engine.font_fallback import (
            face_has_vertical_metrics,
            face_shapes_vertically,
        )

        # Two independent absences, distinguishable in a bug report: the face
        # makes no vertical statement at all, or it has the machinery and not
        # that character's form.
        if not face_has_vertical_metrics(explicit):
            raise ValueError("that font has no vertical metrics — pick one that does")
        if not face_shapes_vertically(explicit, body):
            raise ValueError("that font has no vertical forms — pick one that does")
        return explicit, True
    from engine.font_fallback import resolve_vertical_font

    return resolve_vertical_font(str(font_path), body, style=style), True


def _fresh_font_name(fonts) -> str:
    taken = {str(k) for k in fonts.keys()} if fonts is not None else set()
    i = 0
    while True:
        name = f"/AddTxt{i}"
        if name not in taken:
            return name
        i += 1


def _units(segment: str) -> list[tuple[str, str]]:
    """One hard segment's wrap UNITS — `(text, joiner)`, where the joiner is
    the space that precedes the unit when it follows another on a line.

    Breaking only at spaces is wrong for a no-space script: a Japanese
    sentence is one "word", so it never wraps and runs straight off the
    page — true of horizontal authoring too, and fatal for a column, which
    is nothing but wrapping. The break opportunities come from
    `breaks_between`, the reflow's own kinsoku-aware rule, so a wrap the
    author sees and a wrap the editor would make are the same wrap.

    For space-separated text every unit is a whole word with a space joiner,
    which is the shipped `" ".join(words)` exactly."""
    out: list[tuple[str, str]] = []
    for wi, word in enumerate(segment.split()):
        start = 0
        for i in range(1, len(word)):
            if breaks_between(word[i - 1], word[i]):
                out.append((word[start:i], " " if (wi and start == 0) else ""))
                start = i
        out.append((word[start:], " " if (wi and start == 0) else ""))
    return out


def _wrap(units, width_1000, size: float, max_width: float) -> list[str]:
    """Greedy fill at `max_width` (user units). A single over-wide unit
    still gets its own line (never dropped).

    The candidate line is measured AS A WHOLE STRING rather than as a
    sum of unit widths plus spaces. With kerning on, a per-unit sum would
    miss the pairs that straddle the spaces, so the wrap could disagree with
    what is actually drawn — and measurement agreeing with drawing is the
    property this shares with `measure_text_box`."""
    lines: list[str] = []
    cur = ""
    for text, join in units:
        candidate = (cur + join + text) if cur else text
        if cur and width_1000(candidate) / 1000.0 * size > max_width:
            lines.append(cur)
            cur = text
        else:
            cur = candidate
    if cur:
        lines.append(cur)
    return lines


class _Bidi:
    """The right-to-left half of authoring, in one object.

    Authoring has the same two problems the paragraph reflow had, and takes
    the same two answers: text is TYPED in reading (logical) order but a PDF
    pen only draws left to right, so each wrapped line has to be permuted
    into visual order; and a viewer never shapes, so a cursively joining
    script has to be shaped here or it draws as disconnected stumps.

    What is NOT the same: authoring already owns its face (there is no
    document font to preserve) and already re-embeds a subset, so there is
    no substitution question — the only decision is which bundled face, and
    `resolve_fallback_font`'s text-driven step has already made it.

    Shaping is per WORD, because cursive joining never crosses a space; that
    is what lets the greedy wrap move words between lines without
    invalidating a glyph. A shaped word is then ONE atomic unit in the
    reorder (its glyphs are already visual, straight from the shaper) while
    everything else splits to single characters — which is exactly what a
    non-joining right-to-left script like Hebrew needs, since its letters
    mirror individually."""

    __slots__ = ("base_level", "runs", "glyph_encode", "glyph_width", "width_1000")

    def __init__(self, base_level: int, runs: dict, glyph_encode, glyph_width, width_1000):
        self.base_level = base_level
        self.runs = runs  # word -> ShapedRun
        self.glyph_encode = glyph_encode
        self.glyph_width = glyph_width
        self.width_1000 = width_1000

    def units(self, line: str) -> list:
        """One line's units in LOGICAL order: `("glyphs", word)` for a shaped
        word, `("text", ch)` per character otherwise."""
        out: list = []
        for i, token in enumerate(line.split(" ")):
            if i:
                out.append(("text", " "))
            if token in self.runs:
                out.append(("glyphs", token))
            else:
                out.extend(("text", ch) for ch in token)
        return out

    def unit_width(self, unit) -> float:
        kind, payload = unit
        if kind == "glyphs":
            # The shaper's positioned advance, which is what the emission
            # actually produces: the /W widths plus the TJ corrections the
            # piece builder writes sum to exactly this.
            return self.runs[payload].advance_1000
        return self.width_1000(payload)

    def line_width_1000(self, line: str) -> float:
        return sum(self.unit_width(u) for u in self.units(line))

    def pieces(self, line: str) -> list:
        """The line's units reordered into VISUAL order and merged into show
        pieces: `("text", str)` runs and `("glyphs", ShapedRun)` words."""
        units = self.units(line)
        ordered = bidi.reorder_to_visual(
            units, self.base_level, key=lambda u: (u[1][:1] or " ")
        )
        if len(ordered) != len(units):
            raise ValueError(
                "directional formatting characters cannot be laid out in a text box"
            )
        out: list = []
        for kind, payload in ordered:
            if kind == "text" and out and out[-1][0] == "text":
                out[-1] = ("text", out[-1][1] + payload)
            elif kind == "text":
                out.append(("text", payload))
            else:
                out.append(("glyphs", self.runs[payload]))
        return out


def _span_units(segments, styles) -> list:
    """One line's `(text, style)` segments as UNITS in logical order:
    `("glyphs", word, style)` for a shaped word, `("text", ch, style)` per
    character otherwise. Same rule as the whole-box path, carrying the style
    index through the reorder so a recoloured word stays recoloured."""
    out: list = []
    for text, st in segments:
        runs = styles[st].get("runs") or {}
        for i, token in enumerate(text.split(" ")):
            if i:
                out.append(("text", " ", st))
            if token and token in runs:
                out.append(("glyphs", token, st))
            else:
                out.extend(("text", ch, st) for ch in token)
    return out


def _span_pieces(segments, styles, base_level: int) -> list:
    """Those units reordered into VISUAL order and merged back into
    `(kind, payload, style)` show pieces."""
    units = _span_units(segments, styles)
    ordered = bidi.reorder_to_visual(
        units, base_level, key=lambda u: (u[1][:1] or " ")
    )
    if len(ordered) != len(units):
        raise ValueError(
            "directional formatting characters cannot be laid out in a text box"
        )
    out: list = []
    for kind, payload, st in ordered:
        if kind == "text" and out and out[-1][0] == "text" and out[-1][2] == st:
            out[-1] = ("text", out[-1][1] + payload, st)
        elif kind == "text":
            out.append(("text", payload, st))
        else:
            out.append(("glyphs", styles[st]["runs"][payload], st))
    return out


def _span_show(piece, style, csi, Array) -> list:
    """The instructions for ONE visual piece — a list, because a shaped
    word's vertical mark offsets need `Ts` between shows (see `_bidi_show`,
    which states the sign discipline this shares)."""
    kind, payload, _st = piece
    if kind == "text":
        return [_show_instruction(payload, style["encode"], style["kern_pairs"], csi, Array)]
    out: list = []
    parts: list = []
    rise = 0.0
    sz = style["size"]

    def flush() -> None:
        if not parts:
            return
        if len(parts) == 1 and not isinstance(parts[0], float):
            out.append(csi([parts[0]], "Tj"))
        else:
            out.append(csi([Array(list(parts))], "TJ"))
        parts.clear()

    def set_rise(v: float) -> None:
        nonlocal rise
        if abs(v - rise) <= 1e-9:
            return
        flush()
        out.append(csi([round(v, 4)], "Ts"))
        rise = v

    for (name, advance, x_off, y_off), (_n2, spells) in zip(
        payload.glyphs, payload.clusters
    ):
        set_rise(y_off / 1000.0 * sz)
        width = style["glyph_width"](name, spells)
        if x_off:
            parts.append(round(-x_off, 3))
        parts.append(String(style["glyph_encode"](name, spells)))
        trailing = x_off + width - advance
        if abs(trailing) > 1e-9:
            parts.append(round(trailing, 3))
    set_rise(0.0)
    flush()
    return out


def _prepare_bidi(face: str, body: str, pdf, unique: str, glyph_for):
    """(_Bidi | None, font_dict, encode, width_1000) for an authored box.

    None — and the shipped `build_fallback_font` output byte for byte — for
    a left-to-right box that needs no shaping, which is the overwhelming
    majority and the one the existing pins measure."""
    from engine import shaping

    rtl = bidi.has_strong_rtl(body)
    # Shaping is no longer an RTL-only question. A left-to-right box
    # needs it exactly when the shaper produces something the character path
    # cannot — a composed accent, a ligature — which is what
    # `shape_if_it_changes` answers; ordinary Latin returns None for every
    # word, `runs` stays empty, and the shipped `build_fallback_font` output
    # comes back byte for byte, which is why this can be unconditional.
    #
    # An OpenType feature request opts OUT: `glyph_for` is already a glyph
    # selection for the run, and honouring two of them is not defined. RTL
    # raises on the same collision below; left-to-right simply keeps the
    # feature path it had, because that path works.
    runs: dict = {}
    if glyph_for is None or rtl:
        for token in body.split():
            if token and token not in runs:
                run = shaping.shape_if_it_changes(face, token)
                if run is not None:
                    runs[token] = run
    if not runs and not rtl:
        # Nothing to shape and nothing to reorder: the shipped path exactly.
        return (None,) + build_fallback_font(pdf, face, unique, glyph_for=glyph_for)
    if not runs:
        # A non-joining right-to-left script (Hebrew): no shaping needed, but
        # the reorder still is.
        font_dict, encode, width_1000 = build_fallback_font(
            pdf, face, unique, glyph_for=glyph_for
        )
        return (
            _Bidi(bidi.paragraph_level(body), {}, None, None, width_1000),
            font_dict, encode, width_1000,
        )
    if glyph_for is not None:
        # A shaped script and an OpenType feature request are two different
        # glyph selections for one run; honouring both is not defined.
        raise ValueError("small caps and alternates do not apply to this script")
    font_dict, encode, width_1000, glyph_encode, glyph_width = build_shaped_font(
        pdf, face, unique, list(runs.values())
    )
    return (
        _Bidi(bidi.paragraph_level(body), runs, glyph_encode, glyph_width, width_1000),
        font_dict, encode, width_1000,
    )


def _bidi_show(pieces, encode, bd: "_Bidi", sz: float, csi, Array) -> list:
    """The instructions for one visual-ordered line — a LIST, because a
    vertical mark offset needs a `Ts` between shows.

    Text pieces encode through the subset's cmap; a shaped word writes its
    glyph ids directly. The shaper's horizontal mark offsets and its GPOS
    advance deltas become TJ numbers (a NEGATIVE number moves the pen right
    — the same sign discipline `_show_instruction` states), and its VERTICAL
    offsets become text rise, which a TJ array structurally cannot carry.
    Dropping them instead would leave a vowel mark sitting on the baseline
    rather than under its letter, so the show splits and `Ts` returns to 0
    before the line ends."""
    out: list = []
    parts: list = []
    rise = 0.0

    def flush() -> None:
        if not parts:
            return
        if len(parts) == 1 and not isinstance(parts[0], float):
            out.append(csi([parts[0]], "Tj"))
        else:
            out.append(csi([Array(list(parts))], "TJ"))
        parts.clear()

    def set_rise(v: float) -> None:
        nonlocal rise
        if abs(v - rise) <= 1e-9:
            return
        flush()
        out.append(csi([round(v, 4)], "Ts"))
        rise = v

    for kind, payload in pieces:
        if kind == "text":
            set_rise(0.0)
            parts.append(String(encode(payload)))
            continue
        for (name, advance, x_off, y_off), (_n2, spells) in zip(
            payload.glyphs, payload.clusters
        ):
            set_rise(y_off / 1000.0 * sz)
            width = bd.glyph_width(name, spells)
            if x_off:
                parts.append(round(-x_off, 3))
            parts.append(String(bd.glyph_encode(name, spells)))
            trailing = x_off + width - advance
            if abs(trailing) > 1e-9:
                parts.append(round(trailing, 3))
    set_rise(0.0)
    flush()
    return out


def _show_instruction(line: str, encode, pairs, csi, Array) -> object:
    """The show op for one line: a plain `Tj`, or a `TJ` array carrying the
    face's pair kerning.

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
    # The face's pair kerning ({} when kern=False, or when the face has
    # none — Liberation Mono genuinely has none, so a monospace box simply
    # never kerns with no special case).
    kern_pairs: dict
    # Per-span styling. None = the whole-box path (byte-identical to the
    # shipped output). Otherwise: `styled_lines` is a list of lines, each a
    # list of (text, style_index) segments; `styles` is one resolved entry
    # per distinct style combo: {size, rgb, font_dict, encode, width_1000,
    # kern_pairs}; `line_leadings` carries each line's own leading (1.2 ×
    # the largest size ON that line — the paragraph engine's rule).
    styled_lines: list | None = None
    styles: list | None = None
    line_leadings: list | None = None
    # The right-to-left half. None for every left-to-right box, which is
    # what keeps the shipped emission byte-identical.
    bidi: object | None = None
    # A FREE rotation angle in degrees (None on the shipped step path).
    # The frame already encodes it; `angle` exists so the shift-up band can
    # compute the page box's preimage under the free rotation.
    angle: float | None = None
    # The WRITING frame — the signed axis permutation the layout ran in.
    # Horizontal is the identity, which is why every horizontal number and
    # every horizontal byte is the shipped one.
    wframe: tuple = _H_FRAME
    # Which way a column set advances (`rtl`/`ltr`), None for horizontal.
    columns: str | None = None
    vertical: bool = False
    # Vertical only: an /Identity-V embed of the face's own vertical forms
    # (True) against a horizontal shaped subset turned a quarter (False).
    upright: bool = True
    # The linear part every ordinary show writes into its Tm. The identity
    # for horizontal text and for an upright column (the /Identity-V CMap
    # does the advancing); a quarter turn when the glyphs are horizontal
    # ones laid down a column.
    glyph_lin: tuple = (1, 0, 0, 1)
    # The column em a tate-chu-yoko block occupies, and is condensed across.
    tcy_em: float = 0.0


def _layout_box_spans(
    pdf, body, spans, sz, font_path, family, bold, italic, kern, features,
    alt_index, rot, l_left, l_right, l_top, l_w, l_h, frame,
    left, right, top, bottom, angle=None,
    wframe=_H_FRAME, columns=None, vertical=False,
) -> "_BoxLayout":
    """The per-span layout — one resolved style per distinct combo,
    per-char widths, greedy wrap over mixed-width words, per-line leading
    from the largest size on the line (the paragraph engine's rule), and
    lines as (text, style_index) segments for the emitter."""
    # Per-character style index. Style 0 is the box's own arguments; each
    # distinct (size, bold, italic, color, tcy) combo used by a span gets one
    # resolved entry, so N spans sharing a look share fonts and subsets.
    # `tcy` is part of the key because a tate-chu-yoko block draws in a
    # HORIZONTAL face inside a column that is otherwise vertical.
    char_style = [0] * len(body)
    base_combo = (round(sz, 3), bool(bold), bool(italic), None, False)
    combo_index: dict = {base_combo: 0}
    combos: list[tuple] = [base_combo]
    for span in spans:
        s_size = round(float(span.get("size", sz)), 3)
        s_bold = bool(span.get("bold", bold))
        s_italic = bool(span.get("italic", italic))
        s_color = tuple(span["color"]) if span.get("color") is not None else None
        s_tcy = bool(span.get("tcy", False))
        if s_tcy:
            _validate_tcy_span(body, span, vertical)
        key = (s_size, s_bold, s_italic, s_color, s_tcy)
        idx = combo_index.get(key)
        if idx is None:
            idx = len(combos)
            combo_index[key] = idx
            combos.append(key)
        for pos in range(span["start"], span["end"]):
            char_style[pos] = idx
    tcy_styles = {i for i, combo in enumerate(combos) if combo[4]}
    # The block occupies ONE em of the column, and is condensed across one
    # em of it — the typographic definition of the construct, and what keeps
    # the surrounding column's pitch right. The column's em is the box's own
    # size, not the block's.
    tcy_em = sz

    feats = _normalize_features(features)
    # Right-to-left per-span styling. A style boundary INSIDE a
    # cursively joining word is refused rather than drawn: the two halves
    # would embed in two different subsets and each would take its own
    # initial/final joining forms, so the word would visibly break at the
    # seam. Styling whole words — what the card's selection actually
    # produces — works. (The cross-style KERN gap is a hairline; this
    # one would be a hole in the middle of a word.)
    rtl = bidi.has_strong_rtl(body)
    if rtl:
        from engine import shaping

        for m in __import__("re").finditer(r"\S+", body):
            if not shaping.requires_shaping(m.group()):
                continue
            if len(set(char_style[m.start() : m.end()])) > 1:
                raise ValueError(
                    "a style change inside a joined word cannot be drawn — "
                    "style whole words in this script"
                )

    upright = True
    if vertical:
        if feats:
            raise ValueError("small caps and alternates do not apply to vertical text")
        # Which vertical REPRESENTATION this box takes is a property of the
        # text's script, not of a style, so it is answered once here and the
        # per-style resolution below only picks the face.
        upright = _vertical_face(
            font_path, family, style_key(bold, italic), body, columns
        )[1]

    def resolve_face(b: bool, i: bool, tcy: bool):
        skey = style_key(b, i)
        if vertical and not tcy:
            # One vertical face serves the whole column (T4's recorded
            # position — no vertical serif is vendored), so the style axes
            # resolve through the vertical ladder rather than the bundled
            # family map.
            return _vertical_face(font_path, family, skey, body, columns)[0]
        # A tate-chu-yoko block is HORIZONTAL text inside the column, so it
        # resolves the ordinary way even in a vertical box.
        explicit = _explicit_face(family, skey)
        if explicit is not None and not (vertical and tcy):
            return explicit
        if feats:
            from engine.font_fallback import resolve_feature_font

            return resolve_feature_font(str(font_path), style=skey)
        if family in ("serif", "mono", "sans") and not (vertical and tcy):
            return resolve_fallback_font(
                str(font_path), synthetic_family_font(family), style=skey, text=body,
                rtl_ok=rtl,
            )
        return resolve_fallback_font(
            str(font_path), None, style=skey, text=body, rtl_ok=rtl
        )

    # Chars per style (drawn chars only), then one subset font per style.
    drawn_by_style: dict[int, set] = {}
    for pos, ch in enumerate(body):
        if ch in ("\n", "\r", "\t"):
            continue
        drawn_by_style.setdefault(char_style[pos], set()).add(ch)

    styles: list[dict] = []
    for idx, (s_size, s_bold, s_italic, s_color, s_tcy) in enumerate(combos):
        # Every style that draws anything also draws the JOIN SPACE — the
        # wrap synthesizes inter-word spaces styled by the preceding word,
        # whose own body positions may never have contained one
        # (pin-caught: encode(' ') refused on a word-only span).
        style_chars = drawn_by_style.get(idx, set())
        if style_chars:
            style_chars = set(style_chars) | {" "}
        chars = "".join(sorted(style_chars))
        if not chars:
            styles.append({"size": s_size, "color": s_color, "font_dict": None,
                           "encode": None, "width_1000": None, "kern_pairs": {},
                           "runs": {}, "glyph_encode": None, "glyph_width": None,
                           "tcy": s_tcy})
            continue
        face = resolve_face(s_bold, s_italic, s_tcy)
        if vertical and upright and not s_tcy:
            # The column's own glyphs: the face's vertical forms under
            # /Identity-V, whose widths ARE the /W2 advances the wrap
            # measures the column's length with. Nothing shapes — vertical
            # text forms no cross-character ligatures — so this style skips
            # the shaping ladder entirely rather than embedding horizontal
            # glyph ids under a vertical CMap.
            from engine.font_fallback import build_vertical_font

            font_dict, encode, width_1000 = build_vertical_font(pdf, face, chars)
            styles.append({"size": s_size, "color": s_color, "font_dict": font_dict,
                           "encode": encode, "width_1000": width_1000, "kern_pairs": {},
                           "runs": {}, "glyph_encode": None, "glyph_width": None,
                           "tcy": False})
            continue
        glyph_for = None
        if feats:
            from fontTools.ttLib import TTFont as _TTFont

            from engine.font_features import resolve_glyphs

            _ff = _TTFont(str(face), fontNumber=0, lazy=True)
            try:
                names = resolve_glyphs(_ff, chars, feats, alt_index=int(alt_index or 0))
            finally:
                _ff.close()
            glyph_for = {ch: nm for ch, nm in zip(chars, names) if nm is not None}
        # The joining words drawn WHOLLY in this style (guaranteed
        # whole by the boundary refusal above), shaped against THIS style's
        # face so its glyphs land in THIS style's subset.
        runs: dict = {}
        glyph_encode = glyph_width = None
        # Left-to-right words shape here too, on the same selective
        # gate the box path uses — so an accent typed into a styled span
        # composes instead of standing beside its letter. `feats` opts out
        # (two glyph selections for one run are not defined; the refusal
        # below is the RTL half of the same rule).
        if not feats:
            from engine import shaping

            for m in __import__("re").finditer(r"\S+", body):
                word = m.group()
                if word in runs or char_style[m.start()] != idx:
                    continue
                # A shaped word is drawn WHOLLY in one style, so it may only
                # be shaped when the word IS one style. RTL already refuses a
                # mid-word style change outright (a joined word would break
                # visibly at the seam); left-to-right just declines to shape
                # it, because a ligature that does not form is not a defect.
                if len(set(char_style[m.start() : m.end()])) > 1:
                    continue
                run = shaping.shape_if_it_changes(face, word)
                if run is not None:
                    runs[word] = run
        if runs:
            if glyph_for is not None:
                raise ValueError("small caps and alternates do not apply to this script")
            font_dict, encode, width_1000, glyph_encode, glyph_width = build_shaped_font(
                pdf, face, chars, list(runs.values())
            )
        else:
            font_dict, encode, width_1000 = build_fallback_font(
                pdf, face, chars, glyph_for=glyph_for
            )
        pairs: dict = {}
        # A shaped run carries its own GPOS; kerning is per STYLE here, so
        # this must be a local — assigning `kern` would silently disable
        # kerning for every style built after the first shaped one.
        if kern and not runs:
            from engine.font_kerning import kern_pairs as _kern_pairs, kerned_width

            pairs = _kern_pairs(str(face))
            if pairs:
                _bw = width_1000

                def width_1000(t, _b=_bw, _p=pairs):
                    return _b(t) + kerned_width(_p, t)

        styles.append({"size": s_size, "color": s_color, "font_dict": font_dict,
                       "encode": encode, "width_1000": width_1000, "kern_pairs": pairs,
                       "runs": runs, "glyph_encode": glyph_encode,
                       "glyph_width": glyph_width, "tcy": s_tcy})

    if tcy_styles and any(st.get("runs") for st in styles):
        # A shaped run and an atomic block in one box is not a thing this
        # design expresses: the reorder walks per code and would take the
        # block apart. The construct is a column one anyway.
        raise ValueError(
            "a tate-chu-yoko block cannot share a box with a shaped script"
        )

    def seg_split(a: int, b: int) -> list[tuple[str, int]]:
        """[a,b) of body → (text, style) segments grouped by style."""
        out: list[tuple[str, int]] = []
        pos = a
        while pos < b:
            st = char_style[pos]
            end = pos + 1
            while end < b and char_style[end] == st:
                end += 1
            out.append((body[pos:end], st))
            pos = end
        return out

    def range_width(a: int, b: int) -> float:
        """Points width of body[a:b) under its styles (cross-style kern
        deliberately not attempted — an honest hairline).

        A SHAPED word measures by the shaper's positioned advance,
        which is exactly what the emitted glyph widths plus their TJ
        corrections sum to — the wrap and the drawing stay one number.

        A tate-chu-yoko block measures ONE COLUMN EM whatever it says: the
        block is condensed to fit that em, and the layout width is the pitch
        it consumes, never its natural advance. A two-digit year and a
        four-digit one take the same space in the column, which is the
        convention the construct exists to satisfy."""
        if char_style[a] in tcy_styles:
            return tcy_em
        w = 0.0
        for text, st in seg_split(a, b):
            s = styles[st]
            run = (s.get("runs") or {}).get(text)
            if run is not None:
                w += run.advance_1000 / 1000.0 * s["size"]
                continue
            if s["width_1000"] is None:
                continue
            w += s["width_1000"](text) / 1000.0 * s["size"]
        return w

    import re as _re

    styled_lines: list[list[tuple[str, int]]] = []
    line_leadings: list[float] = []
    plain_lines: list[str] = []
    offset = 0
    for hard in body.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        # `offset` tracks the hard-segment's start in the ORIGINAL body so
        # word ranges index char_style correctly. (\r\n normalization can
        # shift positions by the removed \r count — recompute via find.)
        start = body.find(hard, offset) if hard else offset
        # Wrap UNITS, not words: a break opportunity also falls at every
        # CJK boundary (`breaks_between`, kinsoku included) and at a
        # tate-chu-yoko span's edges, and a block is never split. `join`
        # marks the units a real space precedes — a CJK break introduces
        # none, so no space is invented in text that has none.
        units: list[tuple[int, int, bool]] = []
        for m in _re.finditer(r"\S+", hard):
            wa, wb = m.start() + start, m.end() + start
            seg = wa
            for pos in range(wa + 1, wb):
                if (
                    (char_style[pos] in tcy_styles) != (char_style[pos - 1] in tcy_styles)
                    or breaks_between(body[pos - 1], body[pos])
                ):
                    units.append((seg, pos, seg == wa))
                    seg = pos
            units.append((seg, wb, seg == wa))
        offset = (start if hard else offset) + len(hard) + 1
        if not units:
            styled_lines.append([])
            line_leadings.append(sz * _LEADING_EM)
            plain_lines.append("")
            continue
        cur: list[tuple[int, int, bool]] = []
        cur_w = 0.0
        space_w = lambda st: (styles[st]["width_1000"](" ") / 1000.0 * styles[st]["size"]  # noqa: E731
                              if styles[st]["width_1000"] is not None else 0.0)

        def join_style(pos: int) -> int:
            """The style a synthesized join space takes: the preceding
            character's, except a tate-chu-yoko one — the space belongs to
            the surrounding column, and drawing it as part of the block would
            put it inside the atomic unit."""
            st = char_style[pos]
            return 0 if st in tcy_styles else st

        def flush():
            if not cur:
                return
            segs: list[tuple[str, int]] = []
            for wi, (wa, wb, _j) in enumerate(cur):
                if wi > 0 and cur[wi][2]:
                    # The joining space takes the PRECEDING word's last style
                    # (the paragraph engine's trailing-space rule).
                    segs.append((" ", join_style(cur[wi - 1][1] - 1)))
                segs.extend(seg_split(wa, wb))
            # Merge adjacent same-style segments for compact emission.
            merged: list[tuple[str, int]] = []
            for text, st in segs:
                if merged and merged[-1][1] == st and st not in tcy_styles:
                    merged[-1] = (merged[-1][0] + text, st)
                else:
                    merged.append((text, st))
            styled_lines.append(merged)
            line_leadings.append(
                _LEADING_EM * max(styles[st]["size"] for _t, st in merged)
            )
            plain_lines.append("".join(t for t, _s in merged))

        for wa, wb, join in units:
            w_width = range_width(wa, wb)
            join_w = space_w(join_style(cur[-1][1] - 1)) if (cur and join) else 0.0
            if cur and cur_w + join_w + w_width > l_w:
                flush()
                cur = [(wa, wb, False)]
                cur_w = w_width
            else:
                cur_w += join_w + w_width
                cur.append((wa, wb, join))
        flush()
    while plain_lines and plain_lines[0] == "":
        plain_lines.pop(0)
        styled_lines.pop(0)
        line_leadings.pop(0)
    while plain_lines and plain_lines[-1] == "":
        plain_lines.pop()
        styled_lines.pop()
        line_leadings.pop()
    if not plain_lines:
        raise ValueError("no text to add")

    return _BoxLayout(
        lines=plain_lines, body=body, leading=sz * _LEADING_EM, sz=sz, rot=rot, angle=angle,
        l_left=l_left, l_right=l_right, l_top=l_top, l_w=l_w, l_h=l_h,
        frame=frame, left=left, right=right, top=top, bottom=bottom,
        font_dict=None, encode=None, width_1000=None, kern_pairs={},
        styled_lines=styled_lines, styles=styles, line_leadings=line_leadings,
        # The reorder is the identity for a left-to-right box, but the
        # SHAPED emission lives on the same branch — so a box that shaped
        # anything takes it too, at base level 0.
        bidi=(
            bidi.paragraph_level(body)
            if (rtl or any(st.get("runs") for st in styles))
            else None
        ),
        wframe=wframe, columns=columns, vertical=vertical, upright=upright,
        glyph_lin=(1, 0, 0, 1) if (not vertical or upright) else (0, -1, 1, 0),
        tcy_em=tcy_em,
    )


def _validated_spans(spans, body_len: int) -> list[dict]:
    """Normalize the caller's span list. Each span is
    {start, end, size?, color?, bold?, italic?} over the TEXT's character
    positions; spans must be in-range, non-overlapping and ascending (the
    paragraph editor's own contract). Missing style keys inherit the box-
    level arguments at layout time."""
    out: list[dict] = []
    prev_end = 0
    for raw in spans:
        try:
            start, end = int(raw["start"]), int(raw["end"])
        except (KeyError, TypeError, ValueError):
            raise ValueError("each span needs integer start and end") from None
        if not (0 <= start < end <= body_len):
            raise ValueError(f"span [{start},{end}) is out of range")
        if start < prev_end:
            raise ValueError("spans must be ascending and non-overlapping")
        prev_end = end
        span: dict = {"start": start, "end": end}
        if raw.get("size") is not None:
            s = float(raw["size"])
            if not (0.1 <= s <= _MAX_SIZE):
                raise ValueError("span size out of range")
            span["size"] = s
        if raw.get("color") is not None:
            c = [float(v) for v in raw["color"]]
            if len(c) != 3 or any(v < 0 or v > 1 for v in c):
                raise ValueError("span color must be [r,g,b] in 0..1")
            span["color"] = c
        for key in ("bold", "italic", "tcy"):
            if raw.get(key) is not None:
                if not isinstance(raw[key], bool):
                    raise ValueError(f"span {key} must be true or false")
                span[key] = raw[key]
        out.append(span)
    return out


def _validate_tcy_span(body: str, span: dict, vertical: bool) -> None:
    """What a tate-chu-yoko span must be to become an atomic block.

    The same evidence the re-listing's absorption demands, asked at
    creation: the construct is defined only INSIDE a column, its characters
    must not JOIN (a shaped run inside an atomic unit inside a column is not
    a thing this design expresses), and it holds no space — a block is one
    unit to the line breaker and a space inside it is a break opportunity
    the construct forbids."""
    from engine.shaping import requires_shaping

    if not vertical:
        raise ValueError(
            "tate-chu-yoko only applies inside a vertical column"
        )
    text = body[span["start"] : span["end"]]
    if any(ch.isspace() for ch in text):
        raise ValueError("a tate-chu-yoko block cannot contain spaces")
    if requires_shaping(text):
        raise ValueError("a tate-chu-yoko block cannot contain joining characters")


def _layout_box(pdf, text, rect, size, font_path, family, rotate, bold, italic, kern=True,
                features=None, alt_index=0, spans=None,
                writing_mode=HORIZONTAL) -> _BoxLayout:
    """The ONE layout pass shared by `add_text_box` and `measure_text_box`
    — validation, box geometry (incl. the rotation transposition),
    face resolution (family + bold/italic style), subset-font build,
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
    # Strict on purpose (size/rect coerce; this refuses "90"/True): rotate
    # is the one parameter where a silently-coerced wrong value flips the
    # whole geometry. The DOMAIN is any finite degree value; the strictness
    # is unchanged: booleans and strings still refuse. The four step
    # angles keep the contract byte-for-byte; anything else takes
    # the free-rotation frame below.
    if (
        isinstance(rotate, bool)
        or not isinstance(rotate, (int, float))
        or not math.isfinite(float(rotate))
    ):
        raise ValueError(f"rotate must be a number of degrees (got {rotate!r})")
    # Strict booleans: checked as bool, NOT truthiness — bool is
    # an int subclass, so a real True/False passes while bold=1 / italic="y"
    # refuse (a coerced style would silently pick the wrong face).
    if not isinstance(bold, bool):
        raise ValueError(f"bold must be true or false (got {bold!r})")
    if not isinstance(italic, bool):
        raise ValueError(f"italic must be true or false (got {italic!r})")
    # Validated HERE with its siblings, not later beside
    # the face work — input-shape checks run FIRST, so a bad `kern` reports
    # itself rather than surfacing whatever the font machinery hits on the way.
    if not isinstance(kern, bool):
        raise ValueError(f"kern must be true or false (got {kern!r})")
    wframe, columns, vertical = _resolve_writing(writing_mode, body)
    _ang = float(rotate) % 360.0
    if _ang in (0.0, 90.0, 180.0, 270.0):
        rot, angle = int(_ang), None  # the shipped step path, byte-identical
    else:
        rot, angle = None, _ang
    # A turn and a writing mode compose geometrically and produce a block no
    # orientation admits: composing the identity Tm with a quarter-turn cm
    # sends a vertical member's advance off the transposed frame's +x' axis,
    # so the re-listing refuses every combination and the column would author
    # fine and then be permanently uneditable. A vertical writing mode IS a
    # turned reading axis, which is what it exists for.
    if vertical and rot != 0:
        raise ValueError("a rotated box cannot also have a vertical writing mode")
    left, right = min(x0, x1), max(x0, x1)
    top, bottom = max(y0, y1), min(y0, y1)
    box_w = max(right - left, 1.0)

    # The block lays out LOCALLY exactly like rotate=0 in a
    # [0, 0, l_w, l_h] box whose l_w is the drawn dimension ALONG the
    # reading direction (90/270 read along the drawn HEIGHT), then ONE
    # rotation frame `q <cos sin -sin cos tx ty> cm … Q` maps local onto
    # the drawn box. The anchor is the corner the local ORIGIN lands on —
    # rotating the box CCW carries its bottom-left there: 90 ⇒ bottom-right
    # (local +x runs UP the page, +y LEFT), 180 ⇒ top-right, 270 ⇒ top-left
    # (+x DOWN, +y RIGHT). rotate=0 keeps the shipped device-space path
    # byte-for-byte (no frame).
    if rot in (90, 270):
        l_w0, l_h0 = max(top - bottom, 1.0), right - left
    else:
        l_w0, l_h0 = box_w, top - bottom
    if rot == 0:
        local = (left, bottom, right, top)
        frame = None
    elif rot is not None:
        local = (0.0, 0.0, l_w0, l_h0)
        frame = {
            90: [0, 1, -1, 0, round(right, 4), round(bottom, 4)],
            180: [-1, 0, 0, -1, round(right, 4), round(top, 4)],
            270: [0, -1, 1, 0, round(left, 4), round(top, 4)],
        }[rot]
    else:
        # The layout fills the drawn box's own dimensions and the frame turns
        # that box about its center. Layout, wrap, and measure
        # stay local and angle-blind; only this frame differs.
        local = (0.0, 0.0, l_w0, l_h0)
        theta = math.radians(angle)
        cos_t, sin_t = math.cos(theta), math.sin(theta)
        cx, cy = (left + right) / 2.0, (bottom + top) / 2.0
        frame = [
            round(cos_t, 6),
            round(sin_t, 6),
            round(-sin_t, 6),
            round(cos_t, 6),
            round(cx - (l_w0 / 2.0 * cos_t - l_h0 / 2.0 * sin_t), 4),
            round(cy - (l_w0 / 2.0 * sin_t + l_h0 / 2.0 * cos_t), 4),
        ]

    # BOUNDARY 1 — the drawn box enters the writing frame, and the layout
    # below reads only the transposed numbers. `l_w` is the extent along the
    # READING axis (a column's length), `l_h` the extent across it (how many
    # columns fit). The horizontal frame is the identity, so both are the
    # shipped quantities bit for bit.
    l_left, l_right, l_top, l_bottom = _frame_rect(wframe, *local)
    l_w = max(l_right - l_left, 1.0)
    l_h = l_top - l_bottom

    sz = max(1.0, min(_MAX_SIZE, float(size) if size else 12.0))
    leading = sz * _LEADING_EM

    if spans:
        # The per-span path builds its own styles/segments; the
        # whole-box path below stays byte-identical when spans is absent.
        return _layout_box_spans(
            pdf, body, _validated_spans(spans, len(body)), sz, font_path, family,
            bold, italic, kern, features, alt_index,
            rot, l_left, l_right, l_top, l_w, l_h, frame,
            left, right, top, bottom, angle, wframe, columns, vertical,
        )

    # Compose style into the same resolution ladder for both face slots.
    # style_key(False, False) == "regular" == the shipped
    # default, so the no-style path stays byte-identical.
    sk = style_key(bold, italic)
    # An OpenType feature request such as small caps or alternates forces the
    # bundled feature-bearing Libertinus Serif because Liberation carries none
    # of these features. The author explicitly requested the feature, and
    # this is the only bundled face that can do it. No feature => the shipped
    # Liberation path, byte-identical.
    feats = _normalize_features(features)
    upright = True
    if vertical:
        # `build_vertical_font` takes no feature request at all, so a feature
        # on a column would be a control that quietly did nothing.
        if feats:
            raise ValueError("small caps and alternates do not apply to vertical text")
        face, upright = _vertical_face(font_path, family, sk, body, columns)
    else:
        explicit = _explicit_face(family, sk)
        if explicit is not None:
            face = explicit
        elif feats:
            from engine.font_fallback import resolve_feature_font

            face = resolve_feature_font(str(font_path), style=sk)
        elif family in ("serif", "mono", "sans"):
            face = resolve_fallback_font(
                str(font_path), synthetic_family_font(family), style=sk, text=body,
                rtl_ok=True,
            )
        else:
            face = resolve_fallback_font(
                str(font_path), None, style=sk, text=body, rtl_ok=True
            )

    # Chars actually DRAWN — control whitespace is structural (the line
    # breaks handled just below), never a glyph, so it stays out of the
    # embedded subset.
    unique = "".join(sorted(set(body) - {"\n", "\r", "\t"}))
    # Resolve each char to its FEATURE-substituted glyph so the small
    # cap / alternate is what embeds and draws; ToUnicode keeps the plain
    # letter, so it stays searchable and re-editable.
    glyph_for = None
    if feats:
        from fontTools.ttLib import TTFont as _TTFont

        from engine.font_features import resolve_glyphs

        _ff = _TTFont(str(face), fontNumber=0, lazy=True)
        try:
            names = resolve_glyphs(_ff, unique, feats, alt_index=int(alt_index or 0))
        finally:
            _ff.close()
        glyph_for = {ch: nm for ch, nm in zip(unique, names) if nm is not None}
    if vertical and upright:
        # An upright column embeds the face's OWN vertical forms under
        # /Identity-V, and `width_1000` reports the /W2 advance — which is
        # the length the column runs, i.e. exactly the number the wrap
        # measures against in the transposed frame. Nothing shapes: vertical
        # text advances glyph by glyph and forms no cross-character
        # ligatures, so there is no run for the bidi/shaping ladder to hold.
        from engine.font_fallback import build_vertical_font

        bd = None
        font_dict, encode, width_1000 = build_vertical_font(pdf, face, unique)
        kern = False
    else:
        bd, font_dict, encode, width_1000 = _prepare_bidi(
            face, body, pdf, unique, glyph_for
        )
    if bd is not None:
        # Measure through the SAME units the emission draws — shaped
        # words by the shaper's positioned advance, everything else by the
        # subset's widths. Pair kerning is off in this direction: a shaped
        # run carries its own GPOS, and a pair straddling a shaped word and a
        # plain one is not a pair either side has an opinion about.
        width_1000 = bd.line_width_1000
        kern = False

    # Pair kerning from the resolved face. Wrapping, centring and
    # justification all read `width_1000`, so folding the kern INTO it is what
    # keeps measurement and drawing in agreement — the same property
    # `measure_text_box` depends on by sharing this pass.
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
        seg_units = _units(segment)
        if not seg_units:
            lines.append("")
            continue
        lines.extend(_wrap(seg_units, width_1000, sz, l_w))
    while lines and lines[0] == "":
        lines.pop(0)
    while lines and lines[-1] == "":
        lines.pop()

    return _BoxLayout(
        lines=lines, body=body, leading=leading, sz=sz, rot=rot, angle=angle,
        l_left=l_left, l_right=l_right, l_top=l_top, l_w=l_w, l_h=l_h,
        frame=frame, left=left, right=right, top=top, bottom=bottom,
        font_dict=font_dict, encode=encode, width_1000=width_1000,
        kern_pairs=pairs, bidi=bd,
        wframe=wframe, columns=columns, vertical=vertical, upright=upright,
        glyph_lin=(1, 0, 0, 1) if (not vertical or upright) else (0, -1, 1, 0),
        tcy_em=sz,
    )


def _emit_tcy(instrs, csi, piece, style, name, rgb, lay, cursor, baseline, seg_width):
    """Place ONE tate-chu-yoko block, and return the (font, colour) state it
    leaves behind.

    The block is UPRIGHT inside a column that is not: its linear part is the
    identity, so its advance runs along the column's block axis rather than
    down it, which is what makes it a block instead of a column member. Two
    numbers place it, both of them the ones `_absorb_tate_chu_yoko` reads
    back: it consumes one column em of the reading axis with its baseline
    `TCY_BASELINE_EM` into that em, and it is CENTRED across the column on
    the width it actually draws. `Tz` condenses it to one em across — a
    four-digit year and a two-digit one occupy the same column pitch — and
    returns to 100 immediately, because horizontal scaling is text state and
    would otherwise follow the column down the page."""
    text = piece[1]
    em = lay.tcy_em
    natural = seg_width(text, piece[2])
    h_scale = 1.0
    if em > 0.0 and natural > em:
        h_scale = em / natural
        natural = em
    # Which way the block advances in the frame: +y′ for right-to-left
    # columns, −y′ for left-to-right ones. Centring reads the sign rather
    # than assuming it.
    gy = _t(lay.wframe, 1.0, 0.0)[1]
    tx, ty = _t_inv(
        lay.wframe,
        cursor + TCY_BASELINE_EM * em,
        baseline - gy * natural / 2.0,
    )
    if h_scale != 1.0:
        instrs.append(csi([round(h_scale * 100.0, 4)], "Tz"))
    instrs.append(csi([1, 0, 0, 1, round(tx, 4), round(ty, 4)], "Tm"))
    instrs.append(csi([Name(name), style["size"]], "Tf"))
    want_rgb = tuple(style["color"]) if style["color"] is not None else tuple(rgb)
    instrs.append(csi(list(want_rgb), "rg"))
    instrs.extend(_span_show(piece, style, csi, pikepdf.Array))
    if h_scale != 1.0:
        instrs.append(csi([100], "Tz"))
    return (name, style["size"]), want_rgb


def _emit_spans_box(pdf, p, lay, rgb, align, fonts, y_top=None) -> dict:
    """emitter: per-style fonts registered once, per-line baselines from
    each line's OWN leading, per-segment Tf/rg (only on change), the same
    shift-up-to-visible rule, the same q/Q + rotation-frame envelope.

    An explicit `y_top` is the FIRST BASELINE in local space and suppresses
    the shift-up rule: the caller has already decided where the block sits
    and a rule that moves it would break the geometry drawn around it."""
    styles, styled_lines, leadings = lay.styles, lay.styled_lines, lay.line_leadings
    frame = lay.frame
    l_left, l_right, l_top, l_w = lay.l_left, lay.l_right, lay.l_top, lay.l_w

    def csi(operands, op):
        return _CSI(operands, Operator(op))

    names: dict[int, str] = {}
    for idx, s in enumerate(styles):
        if s["font_dict"] is None:
            continue
        nm = _fresh_font_name(fonts)
        fonts[Name(nm)] = s["font_dict"]
        names[idx] = nm

    def seg_width(text, st):
        s = styles[st]
        run = (s.get("runs") or {}).get(text)
        if run is not None:
            return run.advance_1000 / 1000.0 * s["size"]
        return (s["width_1000"](text) / 1000.0 * s["size"]) if s["width_1000"] else 0.0

    def piece_width(piece) -> float:
        kind, payload, st = piece
        if kind == "text":
            return seg_width(payload, st)
        return payload.advance_1000 / 1000.0 * styles[st]["size"]

    first_size = max((styles[st]["size"] for _t, st in styled_lines[0]), default=lay.sz) \
        if styled_lines and styled_lines[0] else lay.sz
    # Baselines: the first sits one max-em below the local top; each next
    # line advances by ITS OWN leading (mixed sizes = mixed leadings).
    baselines: list[float] = []
    y = (l_top - first_size) if y_top is None else float(y_top)
    for i, lead in enumerate(leadings):
        if i > 0:
            y -= lead
        baselines.append(y)

    # The visible-page shift-up rule, identical in spirit to the whole-box
    # path — computed on the LAST baseline with the same local-space
    # preimage bands.
    try:
        vbox = [float(v) for v in p.cropbox]
    except Exception:
        try:
            vbox = [float(v) for v in p.mediabox]
        except Exception:
            vbox = None
    page_lly, page_ury = _page_band(lay, vbox, first_size)
    if y_top is None and baselines and baselines[-1] < page_lly:
        shift = page_lly - baselines[-1]
        cap = page_ury - first_size
        shift = min(shift, max(0.0, cap - baselines[0]))
        baselines = [b + shift for b in baselines]

    instrs = [csi([], "q"), csi([], "BT")]
    cur_font: tuple | None = None
    cur_rgb: tuple | None = None
    for i, segments in enumerate(styled_lines):
        if not segments:
            continue
        # The line permutes into visual order HERE, after the wrap —
        # line breaks are a logical-order decision. Pieces carry their style
        # through the reorder, so a recoloured or resized word stays so.
        pieces = _span_pieces(segments, styles, lay.bidi) if lay.bidi is not None else None
        line_w = (
            sum(piece_width(p) for p in pieces) if pieces is not None
            else sum(seg_width(t, st) for t, st in segments)
        )
        if align == "center":
            lx = l_left + (l_w - line_w) / 2
        elif align == "right":
            lx = l_right - line_w
        else:
            lx = l_left
        emit = pieces if pieces is not None else [("text", t, st) for t, st in segments]
        # The pen walks the line itself, so an ordinary line emits ONE Tm and
        # lets the shows advance it — the shipped bytes. A tate-chu-yoko
        # block writes its OWN Tm (it is placed, not reached) and leaves the
        # pen somewhere the next piece cannot use, so the piece after one
        # re-anchors from the cursor the layout gives it.
        cursor = lx
        pen = False
        for piece in emit:
            st = piece[2]
            s = styles[st]
            if st not in names:
                continue  # whitespace-only style with no drawn chars
            if s.get("tcy"):
                cur_font, cur_rgb = _emit_tcy(
                    instrs, csi, piece, s, names[st], rgb, lay,
                    cursor, baselines[i], seg_width,
                )
                cursor += lay.tcy_em
                pen = False
                continue
            if not pen:
                tx, ty = _t_inv(lay.wframe, cursor, baselines[i])
                instrs.append(csi(list(lay.glyph_lin) + [round(tx, 4), round(ty, 4)], "Tm"))
                pen = True
            want_font = (names[st], s["size"])
            if want_font != cur_font:
                instrs.append(csi([Name(names[st]), s["size"]], "Tf"))
                cur_font = want_font
            want_rgb = tuple(s["color"]) if s["color"] is not None else tuple(rgb)
            if want_rgb != cur_rgb:
                instrs.append(csi(list(want_rgb), "rg"))
                cur_rgb = want_rgb
            instrs.extend(_span_show(piece, s, csi, pikepdf.Array))
            cursor += piece_width(piece)
    instrs.append(csi([], "ET"))
    instrs.append(csi([], "Q"))
    if frame is not None:
        instrs = [csi([], "q"), csi(frame, "cm")] + instrs + [csi([], "Q")]

    content = pikepdf.unparse_content_stream(instrs)
    p.contents_add(b"q\n", prepend=True)
    p.contents_add(b"\nQ\n" + content, prepend=False)
    return {
        "lines": len(lay.lines),
        "chars": len(lay.body),
        "text_height": round(sum(leadings), 4),
        "styles": len([s for s in styles if s["font_dict"] is not None]),
    }


def layout_text_box(
    pdf,
    rect: list,
    text: str,
    size: float = 12.0,
    font_path: str = "",
    family: str | None = None,
    rotate: int = 0,
    bold: bool = False,
    italic: bool = False,
    kern: bool = True,
    features: list | None = None,
    alt_index: int = 0,
    spans: list | None = None,
    writing_mode: str = HORIZONTAL,
) -> _BoxLayout:
    """One prepared layout against an ALREADY-OPEN Pdf, ready to emit.

    The same `_layout_box` pass `add_text_box` and `measure_text_box` run.
    Splitting it out lets a caller that authors many boxes into one document
    measure and draw from ONE pass — a second pass would re-embed the subset
    and could wrap differently from the one that was measured."""
    return _layout_box(pdf, text, rect, size, font_path, family, rotate, bold, italic,
                       kern, features, alt_index, spans, writing_mode)


def block_height(lay: _BoxLayout) -> float:
    """The vertical extent the block occupies, first baseline to last.

    Per-span lines carry their OWN leadings; the whole-box path keeps the
    uniform product. This is `measure_text_box`'s `text_height`."""
    if lay.line_leadings is not None:
        return round(sum(lay.line_leadings), 4)
    return round(len(lay.lines) * lay.leading, 4)


def emit_text_box(
    pdf,
    page,
    lay: _BoxLayout,
    color: list | None = None,
    align: str = "left",
    y_top: float | None = None,
) -> dict:
    """Draw a prepared layout onto `page` (a pikepdf.Page) of `pdf`.

    `y_top` is the FIRST BASELINE in the layout's local space. Passing it
    suppresses the shift-up-to-visible rule: a caller that placed the block
    itself has geometry drawn around it, and a rule that moved the text would
    leave that geometry pointing at nothing."""
    rgb = _rgb(color)
    res = page.obj.get("/Resources")
    if res is None:
        res = Dictionary()
        page.obj["/Resources"] = res
    fonts = res.get("/Font")
    if fonts is None:
        fonts = Dictionary()
        res["/Font"] = fonts
    if lay.styled_lines is not None:
        return _emit_spans_box(pdf, page, lay, rgb, align, fonts, y_top)
    return _emit_box(pdf, page, lay, rgb, align, fonts, y_top)


def _rgb(color: list | None) -> tuple[float, float, float]:
    if color is None:
        return (0.0, 0.0, 0.0)
    try:
        rgb = tuple(max(0.0, min(1.0, float(c))) for c in color)[:3]
    except (TypeError, ValueError):
        return (0.0, 0.0, 0.0)
    return rgb if len(rgb) == 3 else (0.0, 0.0, 0.0)


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
    features: list | None = None,
    alt_index: int = 0,
    spans: list | None = None,
    writing_mode: str = HORIZONTAL,
) -> dict:
    """Author a new text box on `page`.

    `rect` is [x0, y0, x1, y1] in USER-space PDF points (bottom-left
    origin). `text` is placed from the top of the box, wrapping at its
    width; explicit newlines are honoured as hard breaks. `size` (points,
    clamped), `color` an [r,g,b] 0-1 (default black), `font_path` the
    bundled fonts dir (or a face), `family` serif/sans/mono (default sans),
    `bold`/`italic` pick the styled face from the same bundle.
    `rotate` (0/90/180/270, CCW) turns the WHOLE block within the box —
    at 90/270 it lays out along the box's HEIGHT (reading bottom-to-top /
    top-to-bottom), at 180 upside-down. Text that would overflow the page
    BOTTOM is shifted up to stay visible (never a success that renders off
    the sheet). The authored run is a normal Type0+ToUnicode object —
    editable and searchable afterward (rotated: on the run surface, the
    standing rotated-text boundary).

    `writing_mode` is `horizontal` (default), `vertical`, `vertical-rl` or
    `vertical-lr`. A vertical box reads DOWN the drawn box's height and its
    columns stack across its width; the direction comes from the text
    (`vertical`) and an explicit spelling is honoured only where the text
    agrees with it. A vertical box cannot also be rotated."""
    input_path = Path(file)
    output_path = Path(output)
    pdf = pikepdf.open(file)
    try:
        # Input-shape validation (text/rect/rotate/style) runs FIRST, before
        # the page-range check — the pre-refactor precedence (a doubly-invalid
        # call surfaces the input error, not the page error).
        lay = _layout_box(pdf, text, rect, size, font_path, family, rotate, bold, italic, kern,
                          features, alt_index, spans, writing_mode)
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        info = emit_text_box(pdf, p, lay, color, align)
        _save(pdf, input_path, output_path)
        out = {"output": str(output_path), "page": int(page)}
        out.update(info)
        del out["text_height"]
        return out
    finally:
        try:
            pdf.close()
        except Exception:
            pass


def _emit_box(pdf, p, lay, rgb, align, fonts, y_top=None) -> dict:
    """The whole-box emitter — one face, one size, uniform leading.

    An explicit `y_top` is the FIRST BASELINE in local space and suppresses
    the shift-up rule: the caller has already decided where the block sits
    and a rule that moves it would break the geometry drawn around it."""
    placed = y_top is not None
    body, lines, leading, sz = lay.body, lay.lines, lay.leading, lay.sz
    l_left, l_right, l_top, l_w = lay.l_left, lay.l_right, lay.l_top, lay.l_w
    frame = lay.frame
    font_dict, encode, width_1000 = lay.font_dict, lay.encode, lay.width_1000

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
    if not placed:
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
    # Vertical: the same rule one axis over — the band comes from the
    # writing frame, so a column that would run off the sheet moves back
    # along the axis its columns stack in.
    try:
        vbox = [float(v) for v in p.cropbox]
    except Exception:
        try:
            vbox = [float(v) for v in p.mediabox]
        except Exception:
            vbox = None
    page_lly, page_ury = _page_band(lay, vbox, sz)
    last_baseline = y_top - (len(lines) - 1) * leading
    if not placed and last_baseline < page_lly:
        y_top = min(page_ury - sz, y_top + (page_lly - last_baseline))
    g_a, g_b, g_c, g_d = lay.glyph_lin
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
        # BOUNDARY 2 — the anchor leaves the writing frame here, and
        # nothing else does. The linear part is the glyphs' own (identity
        # for horizontal text and for an upright column; a quarter turn
        # for horizontal glyphs laid down a column), so for a horizontal
        # box these operands are the shipped ones.
        tx, ty = _t_inv(lay.wframe, lx, ly)
        instrs.append(csi([g_a, g_b, g_c, g_d, round(tx, 4), round(ty, 4)], "Tm"))
        if lay.bidi is not None:
            # The line permutes into visual order HERE, after the
            # wrap — line breaks are a logical-order decision, and rule
            # L1's line-end handling is meaningless before the lines
            # exist. Same two boundaries as the paragraph reflow.
            instrs.extend(
                _bidi_show(lay.bidi.pieces(line), encode, lay.bidi, sz, csi, pikepdf.Array)
            )
            continue
        # A TJ array carrying the face's pair kerning; falls back to
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
    return {
        "lines": len(lines),
        "chars": len(body),
        "text_height": round(len(lines) * leading, 4),
    }


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
    features: list | None = None,
    alt_index: int = 0,
    spans: list | None = None,
    writing_mode: str = HORIZONTAL,
) -> dict:
    """Report how `text` would lay out in the box WITHOUT
    writing — the card's live fit indicator. Runs the exact `_layout_box`
    pass `add_text_box` runs (same wrap width, size clamp, family/style/
    rotate transposition, writing mode, and kerning), so `fits` can never
    disagree with the commit.

    `text_height` = one leading per wrapped line (the block's extent down
    from the box top); `box_height` = the box dimension ACROSS the reading
    direction (l_h — the drawn height at 0/180, the drawn width at 90/270,
    and the drawn WIDTH for a column, whose lines are columns). `fits` is
    text_height <= box_height. Overflow is NOT an error — the box is a
    guide, not a clip; the card warns, the commit still proceeds."""
    pdf = pikepdf.open(file)
    try:
        # Same precedence as add_text_box: input-shape checks (inside
        # _layout_box) before the page range.
        lay = _layout_box(pdf, text, rect, size, font_path, family, rotate, bold, italic, kern,
                          features, alt_index, spans, writing_mode)
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        # Round BEFORE comparing so the verdict matches the reported numbers
        # and float noise can't flip an exact boundary (14*1.2 and a box's
        # subtracted height land on different last-bit values otherwise).
        text_height = block_height(lay)
        box_height = round(lay.l_h, 4)
        return {
            "lines": len(lay.lines),
            "text_height": text_height,
            "box_height": box_height,
            "fits": text_height <= box_height,
            # The RESOLVED writing mode. A bare `vertical` request derives
            # its column direction from the text, and the card has no way to
            # know which way that went without asking the code that decided
            # — asking here is what keeps one implementation of the evidence
            # instead of a renderer copy that can disagree with the commit.
            "writing_mode": (
                HORIZONTAL if not lay.vertical
                else (VERTICAL_LR if lay.columns == COLUMNS_LTR else VERTICAL_RL)
            ),
        }
    finally:
        try:
            pdf.close()
        except Exception:
            pass
