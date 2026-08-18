"""One right-to-left line, as content-stream BYTES.

Two engine surfaces build appearance streams by hand rather than through
pikepdf instructions: the watermark stamp and the form-field appearance.
Both need exactly the same three things for right-to-left text — shape the
joining words, permute the line into visual order, measure what will be
drawn — so they get one implementation rather than two copies that drift.

(The authoring emitters do the same work over pikepdf instructions instead;
`text_authoring._bidi_show` / `_span_show` are that side. Two shapes, not
four, and the difference between them is the output format, nothing about
the algorithm.)

The contract a caller must honour, because it is what makes any of this
correct: the FACE must be one that can express the text — resolve it with
`resolve_fallback_font(..., rtl_ok=True)` — and lines must be wrapped
BEFORE they get here, in logical order. Reordering is per line and after
the wrap; doing it earlier reorders across a break that has not happened
yet.
"""

from engine import bidi


def _n(v: float) -> str:
    """Compact stable numeric formatting for content-stream operands."""
    return f"{v:.4f}".rstrip("0").rstrip(".") or "0"


class RtlText:
    """A shaped, reorderable body of right-to-left text over ONE face.

    Build it once for the whole value (so a single subset carries every
    glyph any line will draw), then ask it for each line's width and show
    bytes. `advance_1000` from the shaper is the drawn advance by
    construction: the emitted glyph widths plus the TJ corrections below sum
    to exactly it, which is what keeps a wrap that measured here agreeing
    with what lands on the page.

    Base direction is a PARAGRAPH property (rules P2/P3), so the lines of one
    wrapped value share the one resolved over the whole text. `per_line_base`
    is for a body whose lines are independent paragraphs — a list of option
    labels — where one shared base would lay a right-to-left label out in its
    neighbour's direction. Embedding groups and paragraphs are different
    groupings and only the first decides the subset."""

    __slots__ = (
        "font_obj", "_encode", "_width", "_gencode", "_gwidth", "_runs",
        "_base", "_per_line_base",
    )

    def __init__(
        self,
        pdf,
        face: str,
        text: str,
        runs: "dict | None" = None,
        per_line_base: bool = False,
    ):
        from engine.font_fallback import build_fallback_font, build_shaped_font

        # `runs` is resolved by `build`, BEFORE anything is embedded — whether
        # this class is used at all depends on whether there are any, and
        # constructing it to find out would leave an orphaned font object in
        # the PDF every time the answer is no.
        runs = shaped_runs(face, text) if runs is None else runs
        unique = "".join(sorted(set(text) - {"\n", "\r", "\t"}))
        if runs:
            (
                self.font_obj, self._encode, self._width,
                self._gencode, self._gwidth,
            ) = build_shaped_font(pdf, face, unique, list(runs.values()))
        else:
            self.font_obj, self._encode, self._width = build_fallback_font(
                pdf, face, unique
            )
            self._gencode = self._gwidth = None
        self._runs = runs
        self._per_line_base = per_line_base
        self._base = bidi.paragraph_level(text)

    # -- units ------------------------------------------------------------
    def _units(self, line: str) -> list:
        out: list = []
        for i, token in enumerate(line.split(" ")):
            if i:
                out.append(("text", " "))
            if token and token in self._runs:
                out.append(("glyphs", token))
            else:
                out.extend(("text", ch) for ch in token)
        return out

    def _visual(self, line: str) -> list:
        units = self._units(line)
        base = bidi.paragraph_level(line) if self._per_line_base else self._base
        ordered = bidi.reorder_to_visual(
            units, base, key=lambda u: (u[1][:1] or " ")
        )
        if len(ordered) != len(units):
            raise ValueError(
                "text contains directional formatting characters that cannot "
                "be laid out"
            )
        return ordered

    # -- measure ----------------------------------------------------------
    def width_1000(self, line: str) -> float:
        total = 0.0
        for kind, payload in self._units(line):
            if kind == "glyphs":
                total += self._runs[payload].advance_1000
            else:
                total += self._width(payload)
        return total

    def width_em(self, line: str) -> float:
        return self.width_1000(line) / 1000.0

    # -- emit -------------------------------------------------------------
    def show(self, line: str, size: float = 1.0) -> bytes:
        """The line's show operators, visual-ordered.

        A vertical mark offset becomes text rise, which a TJ array
        structurally cannot carry — dropping it would leave a vowel mark on
        the baseline instead of under its letter — so the show splits around
        a `Ts` and returns to 0 before it ends. `size` scales the rise into
        the caller's text space; the watermark's form draws at 1 em and
        passes 1.0, the field appearance passes its font size."""
        parts: list[bytes] = []
        rise = 0.0
        open_tj = False

        def close() -> None:
            nonlocal open_tj
            if open_tj:
                parts.append(b"] TJ")
                open_tj = False

        def open_() -> None:
            nonlocal open_tj
            if not open_tj:
                parts.append(b"[")
                open_tj = True

        def set_rise(v: float) -> None:
            nonlocal rise
            if abs(v - rise) <= 1e-9:
                return
            close()
            parts.append(_n(v).encode("ascii") + b" Ts")
            rise = v

        for kind, payload in self._visual(line):
            if kind == "text":
                set_rise(0.0)
                open_()
                parts.append(b"<" + self._encode(payload).hex().encode("ascii") + b">")
                continue
            run = self._runs[payload]
            for (name, advance, x_off, y_off), (_n2, spells) in zip(
                run.glyphs, run.clusters
            ):
                set_rise(y_off / 1000.0 * size)
                open_()
                width = self._gwidth(name, spells)
                if x_off:
                    # A NEGATIVE TJ number moves the pen right — the same
                    # sign discipline the authoring emitters state.
                    parts.append(_n(-x_off).encode("ascii"))
                parts.append(
                    b"<" + self._gencode(name, spells).hex().encode("ascii") + b">"
                )
                trailing = x_off + width - advance
                if abs(trailing) > 1e-9:
                    parts.append(_n(trailing).encode("ascii"))
        set_rise(0.0)
        close()
        return b" ".join(parts)


def shaped_runs(face: str, text: str) -> dict:
    """{word: ShapedRun} for every word of `text` that shaping CHANGES.

    `shaping.shape_if_it_changes` is the one gate: a joining word always
    shapes (there is no correct per-character rendering of one), and anything
    else only when the shaper produced something the character path cannot —
    a composed accent, a ligature. A word the face cannot express is absent,
    and the character path then refuses it BY NAME rather than drawing a
    `.notdef`."""
    from engine import shaping

    runs: dict = {}
    for token in text.split():
        if token and token not in runs:
            run = shaping.shape_if_it_changes(face, token)
            if run is not None:
                runs[token] = run
    return runs


def build(
    pdf, face: str, text: str, per_line_base: bool = False
) -> "RtlText | None":
    """An `RtlText` when this text needs one, else None — the gate every
    caller uses, so output that needs neither reordering nor shaping keeps
    its shipped emission byte for byte.

    It needs one when the text is right-to-left (the reorder) OR when
    any word shaped into something the character path cannot draw. The second
    half is why an accent typed into a watermark or a form field now composes
    instead of standing beside its letter; ordinary Latin still returns None
    for every word, so this stays None and nothing changes."""
    runs = shaped_runs(face, text)
    if not runs and not bidi.has_strong_rtl(text):
        return None
    return RtlText(pdf, face, text, runs=runs, per_line_base=per_line_base)
