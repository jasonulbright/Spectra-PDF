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

_LEADING_EM = 1.2
_MAX_SIZE = 1638.0

# 9.K2: the OpenType features we can honestly apply (small caps + stylistic
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
    """9.T6 — an ABSOLUTE PATH family selector resolves to that installed
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


class _Bidi:
    """T25 — the right-to-left half of authoring, in one object.

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
    """T25a — one line's `(text, style)` segments as UNITS in logical order:
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
    # 9.T27: shaping is no longer an RTL-only question. A left-to-right box
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
    # T15 per-span styling. None = the whole-box path (byte-identical to the
    # shipped output). Otherwise: `styled_lines` is a list of lines, each a
    # list of (text, style_index) segments; `styles` is one resolved entry
    # per distinct style combo: {size, rgb, font_dict, encode, width_1000,
    # kern_pairs}; `line_leadings` carries each line's own leading (1.2 ×
    # the largest size ON that line — the paragraph engine's rule).
    styled_lines: list | None = None
    styles: list | None = None
    line_leadings: list | None = None
    # T25: the right-to-left half. None for every left-to-right box, which is
    # what keeps the shipped emission byte-identical.
    bidi: object | None = None
    # T19: a FREE rotation angle in degrees (None on the shipped step path).
    # The frame already encodes it; `angle` exists so the shift-up band can
    # compute the page box's preimage under the free rotation.
    angle: float | None = None


def _layout_box_spans(
    pdf, body, spans, sz, font_path, family, bold, italic, kern, features,
    alt_index, rot, l_left, l_right, l_top, l_w, l_h, frame,
    left, right, top, bottom, angle=None,
) -> "_BoxLayout":
    """T15: the per-span layout — one resolved style per distinct combo,
    per-char widths, greedy wrap over mixed-width words, per-line leading
    from the largest size on the line (the paragraph engine's rule), and
    lines as (text, style_index) segments for the emitter."""
    # Per-character style index. Style 0 is the box's own arguments; each
    # distinct (size, bold, italic, color) combo used by a span gets one
    # resolved entry, so N spans sharing a look share fonts and subsets.
    char_style = [0] * len(body)
    combo_index: dict = {(round(sz, 3), bool(bold), bool(italic), None): 0}
    combos: list[tuple] = [(round(sz, 3), bool(bold), bool(italic), None)]
    for span in spans:
        s_size = round(float(span.get("size", sz)), 3)
        s_bold = bool(span.get("bold", bold))
        s_italic = bool(span.get("italic", italic))
        s_color = tuple(span["color"]) if span.get("color") is not None else None
        key = (s_size, s_bold, s_italic, s_color)
        idx = combo_index.get(key)
        if idx is None:
            idx = len(combos)
            combo_index[key] = idx
            combos.append(key)
        for pos in range(span["start"], span["end"]):
            char_style[pos] = idx

    feats = _normalize_features(features)
    # T25a: right-to-left per-span styling. A style boundary INSIDE a
    # cursively joining word is refused rather than drawn: the two halves
    # would embed in two different subsets and each would take its own
    # initial/final joining forms, so the word would visibly break at the
    # seam. Styling whole words — what the card's selection actually
    # produces — works. (The T15 cross-style KERN gap is a hairline; this
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

    def resolve_face(b: bool, i: bool):
        skey = style_key(b, i)
        explicit = _explicit_face(family, skey)
        if explicit is not None:
            return explicit
        if feats:
            from engine.font_fallback import resolve_feature_font

            return resolve_feature_font(str(font_path), style=skey)
        if family in ("serif", "mono", "sans"):
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
    for idx, (s_size, s_bold, s_italic, s_color) in enumerate(combos):
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
                           "runs": {}, "glyph_encode": None, "glyph_width": None})
            continue
        face = resolve_face(s_bold, s_italic)
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
        # T25a: the joining words drawn WHOLLY in this style (guaranteed
        # whole by the boundary refusal above), shaped against THIS style's
        # face so its glyphs land in THIS style's subset.
        runs: dict = {}
        glyph_encode = glyph_width = None
        # 9.T27: left-to-right words shape here too, on the same selective
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
                       "glyph_width": glyph_width})

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

        T25a: a SHAPED word measures by the shaper's positioned advance,
        which is exactly what the emitted glyph widths plus their TJ
        corrections sum to — the wrap and the drawing stay one number."""
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
        words = [(m.start() + start, m.end() + start) for m in _re.finditer(r"\S+", hard)]
        offset = (start if hard else offset) + len(hard) + 1
        if not words:
            styled_lines.append([])
            line_leadings.append(sz * _LEADING_EM)
            plain_lines.append("")
            continue
        cur: list[tuple[int, int]] = []
        cur_w = 0.0
        space_w = lambda st: (styles[st]["width_1000"](" ") / 1000.0 * styles[st]["size"]  # noqa: E731
                              if styles[st]["width_1000"] is not None else 0.0)

        def flush():
            if not cur:
                return
            a, b = cur[0][0], cur[-1][1]
            segs: list[tuple[str, int]] = []
            for wi, (wa, wb) in enumerate(cur):
                if wi > 0:
                    # The joining space takes the PRECEDING word's last style
                    # (the paragraph engine's trailing-space rule).
                    segs.append((" ", char_style[cur[wi - 1][1] - 1]))
                segs.extend(seg_split(wa, wb))
            # Merge adjacent same-style segments for compact emission.
            merged: list[tuple[str, int]] = []
            for text, st in segs:
                if merged and merged[-1][1] == st:
                    merged[-1] = (merged[-1][0] + text, st)
                else:
                    merged.append((text, st))
            styled_lines.append(merged)
            line_leadings.append(
                _LEADING_EM * max(styles[st]["size"] for _t, st in merged)
            )
            plain_lines.append("".join(t for t, _s in merged))

        for wa, wb in words:
            w_width = range_width(wa, wb)
            join_w = space_w(char_style[cur[-1][1] - 1]) if cur else 0.0
            if cur and cur_w + join_w + w_width > l_w:
                flush()
                cur = [(wa, wb)]
                cur_w = w_width
            else:
                cur_w += join_w + w_width
                cur.append((wa, wb))
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
        # T27: the reorder is the identity for a left-to-right box, but the
        # SHAPED emission lives on the same branch — so a box that shaped
        # anything takes it too, at base level 0.
        bidi=(
            bidi.paragraph_level(body)
            if (rtl or any(st.get("runs") for st in styles))
            else None
        ),
    )


def _validated_spans(spans, body_len: int) -> list[dict]:
    """T15: normalize the caller's span list. Each span is
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
        for key in ("bold", "italic"):
            if raw.get(key) is not None:
                if not isinstance(raw[key], bool):
                    raise ValueError(f"span {key} must be true or false")
                span[key] = raw[key]
        out.append(span)
    return out


def _layout_box(pdf, text, rect, size, font_path, family, rotate, bold, italic, kern=True,
                features=None, alt_index=0, spans=None) -> _BoxLayout:
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
    # Strict on purpose (size/rect coerce; this refuses "90"/True): rotate
    # is the one parameter where a silently-coerced wrong value flips the
    # whole geometry. T19 widened the DOMAIN (any finite degree value), not
    # the strictness: booleans and strings still refuse. The four step
    # angles keep the A2-tail contract byte-for-byte; anything else takes
    # the free-rotation frame below.
    if (
        isinstance(rotate, bool)
        or not isinstance(rotate, (int, float))
        or not math.isfinite(float(rotate))
    ):
        raise ValueError(f"rotate must be a number of degrees (got {rotate!r})")
    # Strict booleans (A2-tail-2): checked as bool, NOT truthiness — bool is
    # an int subclass, so a real True/False passes while bold=1 / italic="y"
    # refuse (a coerced style would silently pick the wrong face).
    if not isinstance(bold, bool):
        raise ValueError(f"bold must be true or false (got {bold!r})")
    if not isinstance(italic, bool):
        raise ValueError(f"italic must be true or false (got {italic!r})")
    # 9.K1 (round-41 LOW): validated HERE with its siblings, not later beside
    # the face work — input-shape checks run FIRST, so a bad `kern` reports
    # itself rather than surfacing whatever the font machinery hits on the way.
    if not isinstance(kern, bool):
        raise ValueError(f"kern must be true or false (got {kern!r})")
    _ang = float(rotate) % 360.0
    if _ang in (0.0, 90.0, 180.0, 270.0):
        rot, angle = int(_ang), None  # the shipped step path, byte-identical
    else:
        rot, angle = None, _ang
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
    elif rot is not None:
        l_left, l_right, l_top = 0.0, l_w, l_h
        frame = {
            90: [0, 1, -1, 0, round(right, 4), round(bottom, 4)],
            180: [-1, 0, 0, -1, round(right, 4), round(top, 4)],
            270: [0, -1, 1, 0, round(left, 4), round(top, 4)],
        }[rot]
    else:
        # T19 free rotation: the layout fills the DRAWN box's own
        # dimensions and the frame turns that box about its own CENTER —
        # the king's text-box rotation semantic. Layout, wrap, and measure
        # stay local and angle-blind; only this frame differs.
        l_left, l_right, l_top = 0.0, l_w, l_h
        theta = math.radians(angle)
        cos_t, sin_t = math.cos(theta), math.sin(theta)
        cx, cy = (left + right) / 2.0, (bottom + top) / 2.0
        frame = [
            round(cos_t, 6),
            round(sin_t, 6),
            round(-sin_t, 6),
            round(cos_t, 6),
            round(cx - (l_w / 2.0 * cos_t - l_h / 2.0 * sin_t), 4),
            round(cy - (l_w / 2.0 * sin_t + l_h / 2.0 * cos_t), 4),
        ]

    sz = max(1.0, min(_MAX_SIZE, float(size) if size else 12.0))
    leading = sz * _LEADING_EM

    if spans:
        # T15: the per-span path builds its own styles/segments; the
        # whole-box path below stays byte-identical when spans is absent.
        return _layout_box_spans(
            pdf, body, _validated_spans(spans, len(body)), sz, font_path, family,
            bold, italic, kern, features, alt_index,
            rot, l_left, l_right, l_top, l_w, l_h, frame,
            left, right, top, bottom, angle,
        )

    # A2-tail-2: compose the A3b style into the SAME resolve ladder (both
    # face seats). style_key(False, False) == "regular" == the shipped
    # default, so the no-style path stays byte-identical.
    sk = style_key(bold, italic)
    # 9.K2: an OpenType feature request (small caps / alternates) forces the
    # bundled feature-bearing face — Libertinus Serif — because Liberation
    # carries none of these features. This is the owner's "explicit switch to
    # Libertinus Serif" for authoring: the author asked for small caps, and
    # this is the only bundled face that can do it. No feature => the shipped
    # Liberation path, byte-identical.
    feats = _normalize_features(features)
    explicit = _explicit_face(family, sk)
    if explicit is not None:
        face = explicit
    elif feats:
        from engine.font_fallback import resolve_feature_font

        face = resolve_feature_font(str(font_path), style=sk)
    elif family in ("serif", "mono", "sans"):
        face = resolve_fallback_font(
            str(font_path), synthetic_family_font(family), style=sk, text=body, rtl_ok=True
        )
    else:
        face = resolve_fallback_font(str(font_path), None, style=sk, text=body, rtl_ok=True)

    # Chars actually DRAWN — control whitespace is structural (the line
    # breaks handled just below), never a glyph, so it stays out of the
    # embedded subset.
    unique = "".join(sorted(set(body) - {"\n", "\r", "\t"}))
    # 9.K2: resolve each char to its FEATURE-substituted glyph so the small
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
    bd, font_dict, encode, width_1000 = _prepare_bidi(face, body, pdf, unique, glyph_for)
    if bd is not None:
        # T25: measure through the SAME units the emission draws — shaped
        # words by the shaper's positioned advance, everything else by the
        # subset's widths. Pair kerning is off in this direction: a shaped
        # run carries its own GPOS, and a pair straddling a shaped word and a
        # plain one is not a pair either side has an opinion about.
        width_1000 = bd.line_width_1000
        kern = False

    # 9.K1: pair kerning from the resolved face. Wrapping, centring and
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
        lines=lines, body=body, leading=leading, sz=sz, rot=rot, angle=angle,
        l_left=l_left, l_right=l_right, l_top=l_top, l_w=l_w, l_h=l_h,
        frame=frame, left=left, right=right, top=top, bottom=bottom,
        font_dict=font_dict, encode=encode, width_1000=width_1000,
        kern_pairs=pairs, bidi=bd,
    )


def _emit_spans_box(pdf, p, lay, rgb, align, fonts, input_path, output_path, page) -> dict:
    """T15 emitter: per-style fonts registered once, per-line baselines from
    each line's OWN leading, per-segment Tf/rg (only on change), the same
    shift-up-to-visible rule, the same q/Q + rotation-frame envelope."""
    styles, styled_lines, leadings = lay.styles, lay.styled_lines, lay.line_leadings
    rot, frame = lay.rot, lay.frame
    l_left, l_right, l_top, l_w = lay.l_left, lay.l_right, lay.l_top, lay.l_w
    left, right, top = lay.left, lay.right, lay.top

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
    y = l_top - first_size
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
    if vbox is None:
        page_lly = 0.0
        page_ury = l_top + first_size
    elif rot == 90:
        page_lly, page_ury = right - vbox[2], right - vbox[0]
    elif rot == 180:
        page_lly, page_ury = top - vbox[3], top - vbox[1]
    elif rot == 270:
        page_lly, page_ury = vbox[0] - left, vbox[2] - left
    elif rot is None:
        # T19 free rotation: the band is the page box's PREIMAGE under the
        # frame — invert the (pure rotation + translate) affine, map the
        # four device corners, take the local y-extent.
        a_f, b_f, c_f, d_f, e_f, f_f = (float(v) for v in frame)
        det = a_f * d_f - b_f * c_f
        inv_b, inv_d = -b_f / det, a_f / det
        inv_f = (b_f * e_f - a_f * f_f) / det
        ys = [
            x_ * inv_b + y_ * inv_d + inv_f
            for x_, y_ in (
                (vbox[0], vbox[1]), (vbox[2], vbox[1]),
                (vbox[0], vbox[3]), (vbox[2], vbox[3]),
            )
        ]
        page_lly, page_ury = min(ys), max(ys)
    else:
        page_lly, page_ury = vbox[1], vbox[3]
    if baselines and baselines[-1] < page_lly:
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
        # T25a: the line permutes into visual order HERE, after the wrap —
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
        instrs.append(csi([1, 0, 0, 1, round(lx, 4), round(baselines[i], 4)], "Tm"))
        emit = pieces if pieces is not None else [("text", t, st) for t, st in segments]
        for piece in emit:
            st = piece[2]
            s = styles[st]
            if st not in names:
                continue  # whitespace-only style with no drawn chars
            want_font = (names[st], s["size"])
            if want_font != cur_font:
                instrs.append(csi([Name(names[st]), s["size"]], "Tf"))
                cur_font = want_font
            want_rgb = tuple(s["color"]) if s["color"] is not None else tuple(rgb)
            if want_rgb != cur_rgb:
                instrs.append(csi(list(want_rgb), "rg"))
                cur_rgb = want_rgb
            instrs.extend(_span_show(piece, s, csi, pikepdf.Array))
    instrs.append(csi([], "ET"))
    instrs.append(csi([], "Q"))
    if frame is not None:
        instrs = [csi([], "q"), csi(frame, "cm")] + instrs + [csi([], "Q")]

    content = pikepdf.unparse_content_stream(instrs)
    p.contents_add(b"q\n", prepend=True)
    p.contents_add(b"\nQ\n" + content, prepend=False)
    _save(pdf, input_path, output_path)
    return {
        "output": str(output_path),
        "page": int(page),
        "lines": len(lay.lines),
        "chars": len(lay.body),
        "styles": len([s for s in styles if s["font_dict"] is not None]),
    }


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
        lay = _layout_box(pdf, text, rect, size, font_path, family, rotate, bold, italic, kern,
                          features, alt_index, spans)
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
        if lay.styled_lines is not None:
            return _emit_spans_box(
                pdf, p, lay, rgb, align, fonts, input_path, output_path, page
            )
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
        elif rot is None:
            # T19 free rotation: the band is the page box's PREIMAGE under the
            # frame — invert the (pure rotation + translate) affine, map the
            # four device corners, take the local y-extent.
            a_f, b_f, c_f, d_f, e_f, f_f = (float(v) for v in frame)
            det = a_f * d_f - b_f * c_f
            inv_b, inv_d = -b_f / det, a_f / det
            inv_f = (b_f * e_f - a_f * f_f) / det
            ys = [
                x_ * inv_b + y_ * inv_d + inv_f
                for x_, y_ in (
                    (vbox[0], vbox[1]), (vbox[2], vbox[1]),
                    (vbox[0], vbox[3]), (vbox[2], vbox[3]),
                )
            ]
            page_lly, page_ury = min(ys), max(ys)
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
            if lay.bidi is not None:
                # T25: the line permutes into visual order HERE, after the
                # wrap — line breaks are a logical-order decision, and rule
                # L1's line-end handling is meaningless before the lines
                # exist. Same two boundaries as the paragraph reflow.
                instrs.extend(
                    _bidi_show(lay.bidi.pieces(line), encode, lay.bidi, sz, csi, pikepdf.Array)
                )
                continue
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
    features: list | None = None,
    alt_index: int = 0,
    spans: list | None = None,
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
        lay = _layout_box(pdf, text, rect, size, font_path, family, rotate, bold, italic, kern,
                          features, alt_index, spans)
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        # Round BEFORE comparing so the verdict matches the reported numbers
        # and float noise can't flip an exact boundary (14*1.2 and a box's
        # subtracted height land on different last-bit values otherwise).
        # T15: per-span lines carry their OWN leadings; the whole-box
        # path keeps the shipped uniform product.
        if lay.line_leadings is not None:
            text_height = round(sum(lay.line_leadings), 4)
        else:
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
