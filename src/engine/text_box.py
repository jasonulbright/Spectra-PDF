"""The text of an annotation appearance, laid out and drawn in bundled faces.

`text_box_appearance` takes text blocks and answers, per block, its lines and
the text object that draws them, with the subset fonts in one small PDF. It
opens no document: its cost grows with the text it is given.

Faces come from `font_fallback.resolve_fallback_font`, the rule edited page
text uses. One face draws the whole block when one holds it. Otherwise each
word takes the face the rule gives for the word, and a word no single face
holds is cut where the face changes.

A line is wrapped in logical order and permuted into visual order after the
wrap (`bidi.reorder_to_visual`). A word the shaper changes is one unit of the
reorder, drawn by glyph through `build_shaped_font`; every other character is
its own unit.

A soft hyphen (U+00AD) is a break opportunity inside a word. It draws nothing
and takes no advance, except at the end of a line whose break it is: there
it draws a hyphen-minus in the word's face. The lines answered keep it.
"""

import base64
import io
import math
import os
from pathlib import Path

import pikepdf
from pikepdf import ContentStreamInstruction as _CSI
from pikepdf import Dictionary, Name, Operator, String

from engine import bidi, shaping
from engine.font_fallback import (
    _FACE_FILES,
    build_fallback_font,
    build_shaped_font,
    face_advances,
    face_covers,
    face_glyph_names,
    face_outlines,
    present_faces,
    resolve_fallback_font,
    style_key,
    synthetic_family_font,
)
from engine.pdf_save import save_pdf
from engine.text_authoring import _span_show
from engine.text_paragraphs import breaks_between

_LEADING_EM = 1.2
_MAX_BLOCKS = 4096
_MAX_CHARS = 1_000_000

# Characters that order or join text and draw nothing: soft hyphen, zero
# width space, joiners, the directional marks, embeddings and isolates, word
# joiner, Arabic letter mark, byte order mark.
_UNDRAWN = frozenset(
    [0x00AD, 0x061C, 0xFEFF]
    + list(range(0x200B, 0x2010))
    + list(range(0x202A, 0x202F))
    + list(range(0x2060, 0x206A))
)


def _undrawn(ch: str) -> bool:
    return ord(ch) in _UNDRAWN


def _drawn(text: str) -> str:
    return "".join(ch for ch in text if not _undrawn(ch) and ch not in "\n\r")


_SOFT = "\u00ad"


def _inked(text: str) -> str:
    """The characters of `text` that draw inside a line."""
    return _drawn(text).replace(_SOFT, "")


def _face_holds(face: str, text: str) -> bool:
    drawn = _drawn(text)
    # Only the space is drawn from every face: each other white space
    # character is a glyph the face must hold.
    if not drawn.replace(" ", ""):
        return True
    if not face_covers(face, drawn):
        return False
    return not shaping.requires_shaping(drawn) or shaping.face_can_shape(face, drawn)


def face_draws(face: str, text: str) -> bool:
    """Whether `face` alone draws `text`: its cmap maps every character, and
    it shapes the characters of a joining script."""
    return _face_holds(face, text)


class _Faces:
    """The face of each piece of one block's text, by the page-text rule."""

    def __init__(self, font_path: str, family: str, style: str):
        self.font_path = str(font_path)
        # A folder with no face of the family's ladder draws nothing: it is
        # not searched for another font.
        ladder = (_FACE_FILES[family][style], _FACE_FILES[family]["regular"], _FACE_FILES["sans"]["regular"])
        self.empty = os.path.isdir(self.font_path) and not any(
            os.path.isfile(os.path.join(self.font_path, name)) for name in ladder
        )
        self.original = synthetic_family_font(family)
        self.style = style
        self._by_text: dict[str, str | None] = {}
        # The one face of the whole block, when the rule finds one.
        self.whole: str | None = None

    def face_for(self, text: str) -> str | None:
        """The face the rule gives for `text`, or None when that face does
        not hold it."""
        if text not in self._by_text:
            face = None if self.empty else resolve_fallback_font(
                self.font_path, self.original, style=self.style, text=_drawn(text), rtl_ok=True
            )
            self._by_text[text] = face if face is not None and _face_holds(face, text) else None
        return self._by_text[text]

    def missing_of(self, body: str) -> set:
        """The characters of `body` the rule gives no face for. The answer
        for a character does not depend on its neighbours, so a caller that
        holds the face tables can tell it before it asks."""
        return {ch for ch in set(_drawn(body)) if self.face_for(ch) is None}

    def runs_of(self, word: str) -> list[tuple[str, str]]:
        """`word` as (text, face) runs. Every character has a face
        (`missing_of` is empty)."""
        if self.whole is not None:
            return [(word, self.whole)]
        face = self.face_for(word)
        if face is not None:
            return [(word, face)]
        runs: list[tuple[str, str]] = []
        for ch in word:
            if _undrawn(ch):
                if runs:
                    runs[-1] = (runs[-1][0] + ch, runs[-1][1])
                continue
            if runs and _face_holds(runs[-1][1], runs[-1][0] + ch):
                runs[-1] = (runs[-1][0] + ch, runs[-1][1])
                continue
            runs.append((ch, self.face_for(ch)))
        return runs


class _Atom:
    """A stretch of one line that is never cut: a shaped word, or the text
    between two break opportunities."""

    __slots__ = ("text", "face", "space", "breaks", "width", "shaped", "leads", "soft", "soft_points")

    def __init__(self, text, face, space, breaks):
        self.text = text
        self.face = face
        # Spaces between this atom and the one before it on a line, or before
        # the first atom of a hard line.
        self.space = space
        # A line may end before this atom.
        self.breaks = breaks
        self.width = 0.0
        self.shaped = None
        # The first atom of a hard line: its spaces are drawn.
        self.leads = False
        # Ends at a soft hyphen: a line that ends here inside the word draws
        # the hyphen.
        self.soft = False
        # Internal soft-hyphen boundaries for a joining run. The run remains
        # one shaped atom unless wrapping actually takes one of these points.
        self.soft_points: tuple[int, ...] = ()


def _atoms_of(segment: str, faces: _Faces) -> list[_Atom]:
    """One hard line as atoms, in logical order."""
    atoms: list[_Atom] = []
    spaces = 0
    for index, word in enumerate(segment.split(" ")):
        if index:
            spaces += 1
        if not word:
            continue
        first = True
        after_soft = False
        for text, face in faces.runs_of(word):
            joined = shaping.requires_shaping(text)
            cuts = [0]
            if not joined:
                cuts.extend(
                    i for i in range(1, len(text))
                    if text[i - 1] == _SOFT or breaks_between(text[i - 1], text[i])
                )
            cuts.append(len(text))
            for at in range(len(cuts) - 1):
                atom = _Atom(text[cuts[at]:cuts[at + 1]], face, spaces if first else 0, first or at > 0 or after_soft)
                atom.soft = after_soft = not joined and atom.text.endswith(_SOFT)
                if joined:
                    atom.soft_points = tuple(
                        i + 1 for i, ch in enumerate(atom.text)
                        if ch == _SOFT and i > 0 and i + 1 < len(atom.text)
                    )
                atoms.append(atom)
                first, spaces = False, 0
    if atoms:
        atoms[0].leads = True
    return atoms


def _retag(font_dict, face: str, signature: str) -> None:
    """Gives a subset its own tag (ISO 32000-2 9.9.2): six capital letters
    from the face and what the subset holds."""
    value = 2166136261
    for unit in f"{face}\n{signature}".encode("utf-8"):
        value = ((value ^ unit) * 16777619) & 0xFFFFFFFF
    tag = ""
    for i in range(6):
        tag += chr(65 + value % 26)
        value = value // 26 + (i + 1) * 7919
    name = str(font_dict["/BaseFont"]).lstrip("/")
    tagged = Name("/" + tag + name[name.index("+"):])
    font_dict["/BaseFont"] = tagged
    for descendant in font_dict["/DescendantFonts"]:
        descendant["/BaseFont"] = tagged
        descendant["/FontDescriptor"]["/FontName"] = tagged


# What a builder answered for a subset no bound decides: (face, file stamp,
# characters, shaped words) to whether it built.
_TRIED: dict = {}
_TRIED_LIMIT = 64


class _Group:
    """The blocks that share subset fonts: one font per face. The builders
    give every (glyph, spelling) pair its own code, so one font of a face
    carries every character and every shaped run of the group.

    A face whose subset a builder refuses is in `failed`, with the
    characters the refusal names. `check` finds the faces `build` finds,
    and embeds no font where a bound decides."""

    def __init__(self):
        self.chars: dict[str, set] = {}
        self.runs: dict[str, dict] = {}
        self.shapes: dict[str, dict] = {}
        self.styles: dict[str, dict] = {}
        self.failed: dict[str, set] = {}

    def prime(self, atom: _Atom) -> None:
        """Give `atom` its shaped run for measurement without requesting it
        in the eventual font subset. A soft-hyphen split that is not taken
        must not add the alternate forms to the subset."""
        shown = atom.text.replace(_SOFT, "")
        cache = self.shapes.setdefault(atom.face, {})
        if shown not in cache:
            cache[shown] = shaping.shape_if_it_changes(atom.face, shown)
        atom.shaped = cache[shown]

    def need(self, atom: _Atom, draw_hyphen: bool = False) -> None:
        needed = _drawn(atom.text)
        if draw_hyphen:
            needed += "-"
        self.chars.setdefault(atom.face, {" "}).update(needed)
        runs = self.runs.setdefault(atom.face, {})
        shown = atom.text.replace(_SOFT, "")
        self.prime(atom)
        if shown not in runs:
            runs[shown] = atom.shaped

    def _request(self, face: str) -> tuple:
        chars = "".join(sorted(self.chars[face]))
        return chars, [run for _text, run in sorted(self.runs[face].items()) if run is not None]

    def _spellings(self, face: str) -> dict:
        """Glyph name to the texts the subset makes it spell."""
        names = face_glyph_names(face)
        chars, runs = self._request(face)
        spelled: dict[str, set] = {}
        for ch in chars:
            spelled.setdefault(names.get(ord(ch), ""), set()).add(ch)
        for run in runs:
            for name, spells in run.clusters:
                spelled.setdefault(name, set()).add(spells)
        return spelled

    def _fits(self, face: str) -> bool:
        """Whether the builder takes the subset by the bounds it states: a
        code holds two bytes, a program holds at most 65535 glyphs, and a
        second spelling of a glyph is one more code (TrueType outlines) or
        one more glyph (CFF outlines). A CFF2 program takes no glyph: without
        a shaped word a second spelling draws from the first one's code.
        False where only a build decides."""
        spelled = self._spellings(face)
        if "" in spelled:
            return False
        pairs = sum(len(texts) for texts in spelled.values())
        second = pairs - len(spelled)
        if not second:
            return True
        kind, count = face_outlines(face)
        shaped = bool(self._request(face)[1])
        if kind == "cff2":
            return not shaped
        if shaped:
            return pairs < 0xFFFF if kind == "glyf" else len(spelled) + second < 0xFFFF
        return count + second <= (0x10000 if kind == "glyf" else 0xFFFF)

    def _blame(self, face: str) -> set:
        """The characters a refusal of the face's subset names: those of
        the glyphs with two spellings, or every character of the subset."""
        shared = {ch for texts in self._spellings(face).values() if len(texts) > 1 for text in texts for ch in text}
        return shared or set(self.chars[face])

    def _make(self, pdf, face: str):
        chars, runs = self._request(face)
        if runs:
            font, encode, width_1000, glyph_encode, glyph_width = build_shaped_font(pdf, face, chars, runs)
        else:
            font, encode, width_1000 = build_fallback_font(pdf, face, chars)
            glyph_encode = glyph_width = None
        # The pairs in the order the builder takes them: the order gives
        # the codes, so two subsets with one tag hold the same bytes.
        pairs = list(dict.fromkeys(pair for run in runs for pair in run.clusters))
        spelled = "\n".join(f"{name}\t{spells}" for name, spells in pairs)
        _retag(font, face, chars + "\n" + spelled)
        return font, {
            "encode": encode, "width_1000": width_1000,
            "glyph_encode": glyph_encode, "glyph_width": glyph_width, "kern_pairs": {},
        }

    def check(self) -> None:
        for face in sorted(self.chars):
            if self._fits(face):
                continue
            stat = os.stat(face)
            chars, runs = self._request(face)
            key = (face, stat.st_mtime_ns, stat.st_size, chars, tuple(run.text for run in runs))
            if key not in _TRIED:
                scratch = pikepdf.new()
                try:
                    self._make(scratch, face)
                    built = True
                except Exception:
                    built = False
                finally:
                    scratch.close()
                if len(_TRIED) >= _TRIED_LIMIT:
                    del _TRIED[next(iter(_TRIED))]
                _TRIED[key] = built
            if not _TRIED[key]:
                self.failed[face] = self._blame(face)

    def build(self, pdf, names) -> None:
        for face in sorted(self.chars):
            try:
                font, style = self._make(pdf, face)
            except Exception:
                # A refusal of the builder is the answer for the blocks that
                # draw from the face, never an error of the call.
                self.failed[face] = self._blame(face)
                continue
            self.styles[face] = {"name": names(font, face), **style}

    def refusal_of(self, segments) -> str | None:
        """The characters refused for a block of these atoms, or None."""
        faces = {atom.face for atoms in segments for atom in atoms if atom.face in self.failed}
        if not faces:
            return None
        drawn = {ch for atoms in segments for atom in atoms if atom.face in faces for ch in _drawn(atom.text)}
        named = {ch for face in faces for ch in self.failed[face]} & drawn
        return "".join(sorted(named or drawn or {" "}))


def _advance(face: str, text: str) -> float:
    """The advance of unshaped `text` per 1000 units of the em."""
    advances = face_advances(face)
    return sum(advances.get(ord(ch), 0.0) for ch in text)


def _gap_after(before, atom: _Atom, size: float) -> float:
    """The advance of the spaces drawn before `atom`, which follows `before`
    on its line or starts the line."""
    if not atom.space or (before is None and not atom.leads):
        return 0.0
    face = before.face if before is not None else atom.face
    return atom.space * _advance(face, " ") / 1000.0 * size


def _gap(line: list, index: int, size: float) -> float:
    """The advance of the spaces drawn before the atom at `index`."""
    return _gap_after(line[index - 1] if index else None, line[index], size)


def _measure(atom: _Atom, size: float) -> float:
    if atom.shaped is not None:
        return atom.shaped.advance_1000 / 1000.0 * size
    return _advance(atom.face, _inked(atom.text)) / 1000.0 * size


def _hyphen(atom: _Atom, size: float) -> float:
    """The advance of the hyphen-minus a line draws at `atom`'s soft break."""
    return _advance(atom.face, "-") / 1000.0 * size


def _split_wide(atom: _Atom, size: float, width: float) -> list[_Atom]:
    """An unshaped atom wider than the line, cut by character."""
    if atom.shaped is not None or atom.width <= width or len(atom.text) < 2:
        return [atom]
    out: list[_Atom] = []
    rest = atom.text
    space = atom.space
    while rest:
        count = len(rest)
        while count > 1 and _advance(atom.face, _inked(rest[:count])) / 1000.0 * size > width:
            count -= 1
        piece = _Atom(rest[:count], atom.face, space, True)
        piece.width = _measure(piece, size)
        out.append(piece)
        rest, space = rest[count:], 0
    out[-1].soft = atom.soft
    return out


def _wrap(atoms: list[_Atom], size: float, width: float | None, group) -> tuple[list[list[_Atom]], list[bool]]:
    """Greedy lines and, for each, whether it ends with a drawn hyphen. A
    line ends only before an atom that allows it.

    A line that ends inside a word after a soft hyphen draws the hyphen, so
    it ends there only when the hyphen fits; otherwise it ends at the last
    earlier break that fits. With no such break the hyphen is drawn past
    the width."""
    if not atoms:
        return [[]], [False]
    if width is not None:
        cut: list[_Atom] = []
        for atom in atoms:
            cut.extend(_split_wide(atom, size, width))
        atoms = cut

    def hyphenated(line: list, count: int, following: _Atom) -> bool:
        return count > 0 and line[count - 1].soft and following.space == 0

    lines: list[list[_Atom]] = [[]]
    hyphens: list[bool] = []
    used = 0.0
    pending = atoms[::-1]
    while pending:
        atom = pending.pop()
        line = lines[-1]
        gap = _gap_after(line[-1] if line else None, atom, size)
        if width is not None and atom.soft_points and used + gap + atom.width > width:
            # A joining word stays shaped as a whole unless its internal soft
            # hyphen is the break. Only then shape the two sides separately,
            # so contextual forms continue across an unbroken soft hyphen.
            chosen = None
            for point in reversed(atom.soft_points):
                before = _Atom(atom.text[:point], atom.face, atom.space, atom.breaks)
                before.leads = atom.leads
                before.soft = True
                after = _Atom(atom.text[point:], atom.face, 0, True)
                after.soft_points = tuple(next_point - point for next_point in atom.soft_points if next_point > point)
                group.prime(before)
                group.prime(after)
                before.width, after.width = _measure(before, size), _measure(after, size)
                if used + gap + before.width + _hyphen(before, size) <= width:
                    chosen = (before, after)
                    break
            if chosen is None and (not line or not atom.breaks):
                # With no earlier legal break, keep the last soft-hyphen
                # opportunity even when its hyphen makes the line overflow.
                point = atom.soft_points[-1]
                before = _Atom(atom.text[:point], atom.face, atom.space, atom.breaks)
                before.leads = atom.leads
                before.soft = True
                after = _Atom(atom.text[point:], atom.face, 0, True)
                after.soft_points = tuple(next_point - point for next_point in atom.soft_points if next_point > point)
                group.prime(before)
                group.prime(after)
                before.width, after.width = _measure(before, size), _measure(after, size)
                chosen = (before, after)
            if chosen is not None:
                before, after = chosen
                line.append(before)
                used += gap + before.width
                hyphens.append(True)
                pending.append(after)
                lines.append([])
                used = 0.0
                continue
        if width is None or not line or not atom.breaks or used + gap + atom.width <= width:
            line.append(atom)
            used += gap + atom.width
            continue
        keep = len(line)
        while hyphenated(line, keep, line[keep] if keep < len(line) else atom) and (
            _line_width(line[:keep], size) + _hyphen(line[keep - 1], size) > width
        ):
            keep = next((at for at in range(keep - 1, 0, -1) if line[at].breaks), 0)
        if keep == 0:
            keep = len(line)
        hyphens.append(hyphenated(line, keep, line[keep] if keep < len(line) else atom))
        pending.append(atom)
        pending.extend(reversed(line[keep:]))
        del line[keep:]
        lines.append([])
        used = 0.0
    hyphens.append(False)
    return lines, hyphens


def _order_key(text: str) -> str:
    """The character that orders a drawn unit. The reorder drops a unit
    whose key rule X9 removes (class BN, the embedding codes): a drawn unit
    is ordered by its first character the rule keeps, or as a neutral."""
    for ch in text:
        if bidi.bidi_class(ch) not in bidi._REMOVED_BY_X9:
            return ch
    return "\u2010"


def _units_of(line: list[_Atom], hyphen: bool = False) -> list[tuple]:
    """A line's units in logical order: (kind, payload, face, key). A soft
    hyphen is a unit only as the hyphen that ends the line, ordered with
    the character before it."""
    units: list[tuple] = []
    for index, atom in enumerate(line):
        if index or atom.leads:
            face = line[index - 1].face if index else atom.face
            units.extend(("text", " ", face, " ") for _ in range(atom.space))
        if atom.shaped is not None:
            units.append(("glyphs", atom.shaped, atom.face, _order_key(atom.text)))
        else:
            units.extend(
                ("text", ch, atom.face, ch if _undrawn(ch) else _order_key(ch)) for ch in atom.text if ch != _SOFT
            )
    if hyphen and line:
        key = next((unit[3] for unit in reversed(units) if not _undrawn(unit[3])), "\u2010")
        units.append(("text", "-", line[-1].face, key))
    return units


def _line_text(line: list[_Atom]) -> str:
    return "".join((" " * atom.space if index or atom.leads else "") + atom.text for index, atom in enumerate(line))


def _line_width(line: list[_Atom], size: float, hyphen: bool = False) -> float:
    width = sum(_gap(line, index, size) + atom.width for index, atom in enumerate(line))
    return width + (_hyphen(line[-1], size) if hyphen and line else 0.0)


def _number(value: float) -> str:
    text = f"{round(float(value), 4):.4f}".rstrip("0").rstrip(".")
    return "0" if text in ("", "-0") else text


def _operand(value) -> str:
    if isinstance(value, (pikepdf.Array, list)):
        return "[" + " ".join(_operand(item) for item in value) + "]"
    if isinstance(value, String):
        return "<" + bytes(value).hex() + ">"
    if isinstance(value, bytes):
        return "<" + value.hex() + ">"
    return _number(value)


def _show(units: list[tuple], styles: dict, size: float) -> str:
    """The operators that show visual-order units, the font selected at each
    change of face."""
    def csi(operands, op):
        return _CSI(operands, Operator(op))

    pieces: list[tuple] = []
    for kind, payload, font, _key in units:
        if kind == "text" and _undrawn(payload):
            continue
        if kind == "text" and pieces and pieces[-1][0] == "text" and pieces[-1][2] == font:
            pieces[-1] = ("text", pieces[-1][1] + payload, font)
        else:
            pieces.append((kind, payload, font))
    out: list[str] = []
    current = None
    for piece in pieces:
        style = styles[piece[2]]
        if piece[2] != current:
            out.append(f"/{style['name']} {_number(size)} Tf")
            current = piece[2]
        for instruction in _span_show(piece, {**style, "size": size}, csi, pikepdf.Array):
            operands = " ".join(_operand(operand) for operand in instruction.operands)
            out.append(f"{operands} {instruction.operator}")
    return " ".join(out)


def _block_request(raw) -> dict:
    # The caller builds the request; no user input reaches these checks.
    if not isinstance(raw, dict):
        raise ValueError("a text block request is malformed")
    text = raw.get("text", "")
    if not isinstance(text, str):
        raise ValueError("a text block request is malformed")
    size = raw.get("size", 12.0)
    if isinstance(size, bool) or not isinstance(size, (int, float)) or not math.isfinite(size) or float(size) <= 0:
        raise ValueError("a text block request is malformed")
    width = raw.get("width")
    if width is not None and (
        isinstance(width, bool) or not isinstance(width, (int, float)) or not math.isfinite(width) or float(width) <= 0
    ):
        raise ValueError("a text block request is malformed")
    leading = raw.get("leading")
    if leading is not None and (
        isinstance(leading, bool) or not isinstance(leading, (int, float)) or not math.isfinite(leading) or float(leading) <= 0
    ):
        raise ValueError("a text block request is malformed")
    align = raw.get("align")
    if align not in (None, "left", "center", "right"):
        raise ValueError("a text block request is malformed")
    family = raw.get("family") or "sans"
    if family not in ("sans", "serif", "mono"):
        raise ValueError("a text block request is malformed")
    bold, italic = raw.get("bold", False), raw.get("italic", False)
    if not isinstance(bold, bool) or not isinstance(italic, bool):
        raise ValueError("a text block request is malformed")
    group = raw.get("group")
    if group is not None and (isinstance(group, bool) or not isinstance(group, (int, str))):
        raise ValueError("a text block request is malformed")
    return {
        "text": text.replace("\r\n", "\n").replace("\r", "\n").replace("\t", " "),
        "size": float(size),
        "width": None if width is None else float(width),
        "leading": float(leading) if leading is not None else float(size) * _LEADING_EM,
        "align": align, "family": family, "style": style_key(bold, italic), "group": group,
    }


def text_box_appearance(blocks: list, font_path: str = "", draw: bool = True, faces: bool = False) -> dict:
    """Lays out `blocks` and, with `draw`, draws them.

    A block: `text`; `size` in points; `width` in points to wrap at, or none
    for hard line ends only; `leading`; `align` (left, center, right; none
    gives left, or right for a text whose base direction is right to left);
    `family` (sans, serif, mono), `bold`, `italic`; `group`, shared by the
    blocks that share their fonts.

    Answers `blocks`, one entry per block in order: `lines` (logical order),
    `widths` (points), `rtl`, `align`, `hyphens` (the indexes of the lines
    that end with a drawn soft hyphen, when there is one), and with `draw`
    the `content` (a text object whose origin is the top left corner of the
    text and whose first baseline is one `size` below it) and `fonts` (the
    resource names it selects, the first the face of the block's first
    character). A block with a character no bundled face holds, or whose
    face cannot carry the subset its group needs, answers `refused`, those
    characters, and nothing else. `pdf` is a one-page file, base64, whose
    page resources hold every font under its name; it is absent when nothing
    is drawn. The file is new: it holds no part of any document.

    Without `draw` the lines and widths come from the advances of the faces
    and are the ones a drawing call answers, refusals included. No font is
    subset, except for a subset whose size alone decides whether its face
    carries it (`_Group._fits`).

    With `faces` the answer also holds `faces`, the names of the face files
    in the fonts folder."""
    if not isinstance(blocks, list) or len(blocks) > _MAX_BLOCKS:
        raise ValueError("a text block request is malformed")
    requests = [_block_request(raw) for raw in blocks]
    if sum(len(request["text"]) for request in requests) > _MAX_CHARS:
        raise ValueError("a text block request is malformed")

    groups: dict = {}
    laid: list = []
    for index, request in enumerate(requests):
        chosen = _Faces(font_path, request["family"], request["style"])
        body = request["text"]
        missing = chosen.missing_of(body)
        if missing:
            laid.append({"refused": "".join(sorted(missing))})
            continue
        chosen.whole = chosen.face_for(body)
        segments = [_atoms_of(segment, chosen) for segment in body.split("\n")]
        key = request["group"] if request["group"] is not None else ("block", index)
        group = groups.setdefault(key, _Group())
        for atoms in segments:
            for atom in atoms:
                group.prime(atom)
        laid.append({"request": request, "segments": segments, "group": group})

    answer: dict = {"blocks": []}
    if faces:
        answer["faces"] = present_faces(font_path)
    pdf = pikepdf.new() if draw and groups else None
    try:
        fonts = Dictionary()

        def names(font, face: str) -> str:
            # The face by name, so a /DA that names the font reads as one.
            stem = Path(face).stem
            if stem.endswith("-Regular"):
                stem = stem[: -len("-Regular")]
            stem = "".join(ch for ch in stem if ch.isascii() and (ch.isalnum() or ch == "-")) or "Face"
            name, n = stem, 1
            while Name("/" + name) in fonts:
                name, n = f"{stem}_{n}", n + 1
            fonts[Name("/" + name)] = font
            return name

        # Lay out first so only the shaped runs actually drawn enter a
        # group's subset. Candidate forms for a soft-hyphen break are measured
        # on demand, but stay out of the file unless the line takes that break.
        for entry in laid:
            if "refused" in entry:
                continue
            request = entry["request"]
            size, width = request["size"], request["width"]
            body = request["text"]
            rtl = bidi.has_strong_rtl(body)
            base_level = bidi.paragraph_level(body) if rtl else 0
            lines: list[list[_Atom]] = []
            hyphens: list[bool] = []
            for atoms in entry["segments"]:
                for atom in atoms:
                    atom.width = _measure(atom, size)
                wrapped, ends = _wrap(atoms, size, width, entry["group"])
                lines.extend(wrapped)
                hyphens.extend(ends)
            entry["lines"], entry["hyphens"], entry["mixed"], entry["base_level"] = lines, hyphens, rtl, base_level
            result = {
                "lines": [_line_text(line) for line in lines],
                "widths": [round(_line_width(line, size, hyphen), 4) for line, hyphen in zip(lines, hyphens)],
                "rtl": bool(base_level % 2),
                "align": request["align"] or ("right" if base_level % 2 else "left"),
            }
            if any(hyphens):
                result["hyphens"] = [row for row, hyphen in enumerate(hyphens) if hyphen]
            entry["result"] = result
            for line, hyphen in zip(lines, hyphens):
                for index, atom in enumerate(line):
                    entry["group"].need(atom, draw_hyphen=hyphen and index == len(line) - 1)

        for group in groups.values():
            if pdf is not None:
                group.build(pdf, names)
            else:
                group.check()

        out: list = answer["blocks"]
        for entry in laid:
            if "refused" not in entry:
                refused = entry["group"].refusal_of(entry["segments"])
                if refused is not None:
                    entry["refused"] = refused
            if "refused" in entry:
                out.append({"refused": entry["refused"]})
                continue
            out.append(entry["result"])

        if pdf is None:
            return answer

        for index, entry in enumerate(laid):
            if "refused" in entry:
                continue
            result = out[index]
            request, styles = entry["request"], entry["group"].styles
            size, width, leading = request["size"], request["width"], request["leading"]
            lines, widths, align = entry["lines"], result["widths"], result["align"]
            used: list[str] = []
            parts = ["BT"]
            extent = width if width is not None else max(widths, default=0.0)
            try:
                for row, line in enumerate(lines):
                    if not line:
                        continue
                    units = _units_of(line, entry["hyphens"][row])
                    if entry["mixed"]:
                        units = bidi.reorder_to_visual(units, entry["base_level"], key=lambda unit: unit[3] or " ")
                    shown = _show(units, styles, size)
                    if not shown:
                        continue
                    for unit in units:
                        name = styles[unit[2]]["name"]
                        if name not in used and not (unit[0] == "text" and _undrawn(unit[1])):
                            used.append(name)
                    slack = max(0.0, extent - widths[row])
                    x = slack / 2 if align == "center" else slack if align == "right" else 0.0
                    parts.append(f"1 0 0 1 {_number(x)} {_number(-size - row * leading)} Tm")
                    parts.append(shown)
            except ValueError:
                # A code the subset font does not give: the block is refused.
                out[index] = {"refused": "".join(sorted(set(_drawn(request["text"])) or {" "}))}
                continue
            parts.append("ET")
            first = next((atom for line in lines for atom in line if _inked(atom.text)), None)
            if first is not None and used:
                lead = styles[first.face]["name"]
                used = [lead] + [name for name in used if name != lead]
            result["content"] = " ".join(parts) if used else ""
            result["fonts"] = used

        if len(fonts) > 0:
            pdf.add_blank_page(page_size=(10, 10))
            pdf.pages[0].obj["/Resources"] = Dictionary(Font=fonts)
            buffer = io.BytesIO()
            # The seam every engine write takes. The document is new: it has
            # no protection to carry and no path to leave.
            save_pdf(pdf, buffer)
            answer["pdf"] = base64.b64encode(buffer.getvalue()).decode("ascii")
        return answer
    finally:
        if pdf is not None:
            pdf.close()
