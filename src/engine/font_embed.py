"""Embed a font the document names but does not carry.

Nineteen of the twenty preflight fixups are an existing op called with the
parameters a profile carries. This is the twentieth, and it is built rather
than routed because nothing in this engine writes a font program into a font
the DOCUMENT already declares — the emitters all author their own.

Four rules govern it, and each one is a defect if it is missed.

**An exact face, or a refusal — never a substitute.** ``font_fallback`` is
what this app uses to DRAW a font it does not have, and drawing is reversible.
Writing a substitute's program into the file under the original's name is not:
every reader downstream then believes the document carries the face it names.
With ``allow_substitute`` explicitly on, a substitute is written AND the
report names it, per font.

**The document's ``/Widths`` win.** A resolved face whose advances disagree
with the widths the document already declares would reflow every line it sets,
so the disagreement refuses BY NAME rather than being embedded and discovered
on press. The comparison runs at every code the document declares an advance
for, which is a superset of the codes it draws — strictness here can only
refuse an embed, never permit a silent metric change.

**A restricted face refuses with the foundry's own reason**, read off the
``fsType`` ``system_fonts`` already resolves, never skipped silently.

**Refusal is per font, not per document.** Four missing fonts of which three
are installed embeds three and names the fourth. A run in which nothing
embedded and something refused raises, so a caller asking for one fixup gets
that fixup's own refusal rather than an empty success — the
``accessibility_fixes`` rule.
"""

from __future__ import annotations

import io
import os
import re
from pathlib import Path

import pikepdf
from pikepdf import Array, Dictionary, Name

from engine.font_embedding import font_embedded
from engine.font_inventory import _descendants, walk_document_fonts
from engine.inplace import is_same_file, staged_write
from engine.pdf_fonts import (
    _declared_simple_widths,
    _simple_encoding_map,
    _simple_widths,
    _strip_subset_prefix,
)
from engine.pdf_save import save_pdf
from engine.system_fonts import _scan, read_face

#: PDF simple-font advances are expressed in thousandths of the text space
#: unit, so one unit at that scale is the tolerance the rule names.
WIDTH_TOLERANCE = 1.0

#: Where a face may come from. `system` is the machine's installed set;
#: `bundled` is the vendored fallback directory this app ships.
SOURCES = ("system", "bundled")

#: Name fragments that describe a WEIGHT or a SLANT rather than a family.
#: Deliberately NOT `roman` or `book`: both are part of real family names
#: (Times New Roman), and stripping them would make two different families
#: compare equal — which is worse than failing to strip a weight, because the
#: weight is read separately off the descriptor.
_STYLE_TOKENS = frozenset(
    {
        "regular", "normal", "italic", "oblique", "bold", "bolditalic",
        "boldoblique", "italicbold", "light", "medium", "semibold",
        "demibold", "extrabold", "ultrabold", "black", "heavy", "thin",
        "condensed", "extended", "narrow",
    }
)

#: The styles a face may carry and still answer for a plain weight/slant
#: request. `Arial Black` reports the family `Arial` and neither the bold nor
#: the italic bit, so without this guard it would answer for `Arial` — a
#: different typeface embedded under the name of the one the document asked
#: for, which is exactly what rule 1 forbids.
_PLAIN_STYLES = frozenset(
    {"regular", "normal", "roman", "book", "italic", "oblique", "bold",
     "bolditalic", "boldoblique", "italicbold"}
)

#: Suffixes that name a foundry's production of a face rather than the face:
#: `ArialMT`, `TimesNewRomanPSMT`. Longest first — `psmt` must win over `mt`.
_PRODUCER_SUFFIXES = ("psmt", "std", "pro", "ps", "mt")


def _name_key(text: str) -> str:
    return "".join(ch for ch in str(text).lower() if ch.isalnum())


def _strip_producer(token: str) -> str:
    for suffix in _PRODUCER_SUFFIXES:
        if token.endswith(suffix) and len(token) > len(suffix):
            return token[: -len(suffix)]
    return token


def _tokens(text: str) -> list[str]:
    """One typeface name, as comparable pieces.

    The same tokenizer reads both sides, which is the whole point: a document
    writes `TimesNewRomanPS-BoldMT` and the installed face calls itself
    `Times New Roman Bold`, and those are the same four words.
    """
    name = _strip_subset_prefix(str(text).lstrip("/"))
    out: list[str] = []
    for part in re.split(r"[^A-Za-z0-9]+", name):
        token = _strip_producer(_name_key(part))
        if token:
            out.append(token)
    return out


def _full_key(text: str) -> str:
    return "".join(_tokens(text))


def _family_key(text: str) -> str:
    """The family a name states, with its weight and slant words removed.

    `Arial-BoldMT`, `ArialMT`, `Arial,Bold` and `Arial` all reduce to `arial`.
    The weight is read separately (`classify_font_style`), so dropping it here
    cannot lose it — the family alone is what this key answers.
    """
    return "".join(t for t in _tokens(text) if t not in _STYLE_TOKENS)


def _bundled_faces(font_dir: str) -> list[dict]:
    if not font_dir or not os.path.isdir(font_dir):
        return []
    faces: list[dict] = []
    for entry in sorted(os.listdir(font_dir)):
        if not entry.lower().endswith((".ttf", ".otf", ".ttc", ".otc")):
            continue
        face = read_face(os.path.join(font_dir, entry))
        if face is not None:
            faces.append(face)
    return faces


def _available_faces(sources, font_dir: str) -> tuple[list[dict], list[dict]]:
    """(embeddable faces, faces the foundry's own `fsType` excluded).

    The excluded ones are carried rather than dropped: a font that IS
    installed and may not be embedded gets the foundry's reason instead of
    "no matching face is installed", which is a different and misleading
    sentence.
    """
    wanted = [str(s) for s in (sources or ("system",))]
    unknown = [s for s in wanted if s not in SOURCES]
    if unknown:
        raise ValueError(
            f"embed_missing_fonts: unknown font source(s) {', '.join(sorted(unknown))} "
            f"(it reads: {', '.join(SOURCES)})."
        )
    usable: list[dict] = []
    restricted: list[dict] = []
    if "system" in wanted:
        # `read_face` has already resolved every foundry refusal, so the
        # restricted set is read off the same scan rather than re-derived.
        for face in _scan():
            (restricted if face["refusal"] else usable).append(face)
    if "bundled" in wanted:
        for face in _bundled_faces(font_dir):
            (restricted if face["refusal"] else usable).append(face)
    return usable, restricted


def _match(faces: list[dict], raw_name: str, bold: bool, italic: bool) -> dict | None:
    """The face this document's font names, or None.

    Two ways in, in order: the full face name spelled the same way, then the
    family plus the weight and slant. Nothing else — a family that merely
    starts with the same letters is a different typeface, and a face carrying
    a weight of its own (`Arial Black`) never answers for a plain one.
    """
    wanted_full = _full_key(raw_name)
    if wanted_full:
        for face in faces:
            if _full_key(face["name"]) == wanted_full:
                return face
            if _full_key(f"{face['family']} {face['style']}") == wanted_full:
                return face
    family = _family_key(raw_name)
    if not family:
        return None
    for face in faces:
        if (
            _family_key(face["family"]) == family
            and _name_key(face["style"]) in _PLAIN_STYLES
            and bool(face["bold"]) == bool(bold)
            and bool(face["italic"]) == bool(italic)
        ):
            return face
    return None


def _load_face(face: dict):
    from fontTools.ttLib import TTFont

    return TTFont(face["path"], fontNumber=int(face.get("index", 0)), lazy=False)


def _scale_of(tt) -> float:
    upem = int(tt["head"].unitsPerEm) or 1000
    return 1000.0 / upem


def _advance(tt, glyph: str, scale: float) -> float:
    return float(tt["hmtx"][glyph][0]) * scale


def _subset(face: dict, glyphs, retain_gids: bool) -> tuple[bytes, object]:
    """The face, cut down to the glyphs this document addresses.

    `retain_gids` is the composite case: an Identity CIDToGIDMap addresses a
    glyph by its id, so a renumbered subset would draw the wrong glyph. The
    simple case addresses by name and by cmap, which the subsetter rebuilds.
    """
    from fontTools import subset as ft_subset
    from fontTools.ttLib import TTFont

    options = ft_subset.Options()
    options.retain_gids = bool(retain_gids)
    options.notdef_outline = True
    # A simple font with a `/Differences` encoding is read glyph-name-first by
    # every viewer, so the `post` names have to survive the cut.
    options.glyph_names = True
    options.name_IDs = [1, 2]
    subsetter = ft_subset.Subsetter(options=options)
    subsetter.populate(glyphs=sorted(set(glyphs) | {".notdef"}))
    # `recalcTimestamp` off: it defaults ON and compiles the current clock into
    # `head.modified`, which would make the embedded bytes a function of the
    # second the save ran rather than of the face and the glyph set.
    font = TTFont(
        face["path"], fontNumber=int(face.get("index", 0)), recalcTimestamp=False
    )
    subsetter.subset(font)
    buf = io.BytesIO()
    font.save(buf)
    data = buf.getvalue()
    return data, TTFont(io.BytesIO(data))


def _metrics(tt) -> dict:
    head = tt["head"]
    hhea = tt["hhea"]
    scale = _scale_of(tt)

    def s(value) -> float:
        return round(float(value) * scale, 2)

    try:
        cap_height = tt["OS/2"].sCapHeight
    except (KeyError, AttributeError):
        cap_height = hhea.ascent
    try:
        italic_angle = round(float(tt["post"].italicAngle), 2)
    except (KeyError, AttributeError, TypeError, ValueError):
        italic_angle = 0.0
    return {
        "bbox": [s(head.xMin), s(head.yMin), s(head.xMax), s(head.yMax)],
        "ascent": s(hhea.ascent),
        "descent": s(hhea.descent),
        "cap_height": s(cap_height),
        "italic_angle": italic_angle,
    }


def _program_stream(pdf, data: bytes, subset_font) -> tuple[str, object]:
    """(descriptor key, the font-program stream).

    A CFF-flavoured face embeds whole, as `/FontFile3 /OpenType`; a
    glyf-flavoured one keeps the ordinary `/FontFile2`. The document's own
    version is raised where the OpenType form needs it.
    """
    stream = pdf.make_stream(data)
    if getattr(subset_font, "sfntVersion", "") == "OTTO":
        stream["/Subtype"] = Name("/OpenType")
        return "/FontFile3", stream
    stream["/Length1"] = len(data)
    return "/FontFile2", stream


def _write_descriptor(pdf, holder, program_key, program, base_name,
                      metrics) -> None:
    """Attach the program, creating a descriptor where the document has none.

    A base-14 font carries no `/FontDescriptor` at all, so writing one is the
    whole of what makes it embeddable. An EXISTING descriptor keeps every
    entry it has: its `/Flags` is the document's own statement about how a
    reader reads the font's encoding, and replacing it would change the text.
    """
    descriptor = holder.get("/FontDescriptor")
    if not isinstance(descriptor, pikepdf.Dictionary):
        descriptor = pdf.make_indirect(
            Dictionary(
                Type=Name("/FontDescriptor"),
                FontName=Name("/" + base_name),
                Flags=32,
                FontBBox=Array(metrics["bbox"]),
                ItalicAngle=metrics["italic_angle"],
                Ascent=metrics["ascent"],
                Descent=metrics["descent"],
                CapHeight=metrics["cap_height"],
                StemV=80,
            )
        )
        holder["/FontDescriptor"] = descriptor
    for stale in ("/FontFile", "/FontFile2", "/FontFile3"):
        if stale in descriptor:
            del descriptor[stale]
    descriptor[program_key] = program


def _simple_plan(font_obj, face: dict, tt, raw_name: str) -> tuple[set, str]:
    """The glyphs a simple font needs, or a refusal naming why it cannot.

    Returns (glyph names, the refusal message) — exactly one is meaningful.
    """
    code2uni = _simple_encoding_map(font_obj)
    if code2uni is None:
        return set(), (
            f"{raw_name}: the font's encoding cannot be read, so the installed "
            "face cannot be proven to set the same text"
        )
    widths = _declared_simple_widths(font_obj) or _simple_widths(font_obj, code2uni)[0]
    if not widths:
        return set(), (
            f"{raw_name}: the document declares no advances for it, so an "
            "embedded face cannot be proven to keep its lines the same length"
        )
    cmap = tt.getBestCmap() or {}
    scale = _scale_of(tt)
    glyphs: set = set()
    for code in sorted(widths):
        declared = float(widths[code])
        text = code2uni.get(code)
        if not text or declared <= 0:
            continue
        glyph = cmap.get(ord(text[0]))
        if glyph is None:
            return set(), (
                f"{raw_name}: {face['name']} has no glyph for "
                f"U+{ord(text[0]):04X}, which the document sets at code {code}"
            )
        actual = _advance(tt, glyph, scale)
        if abs(actual - declared) > WIDTH_TOLERANCE:
            return set(), (
                f"{raw_name}: {face['name']} sets code {code} at "
                f"{actual:.0f}/1000 where the document declares "
                f"{declared:.0f}/1000 — embedding it would reflow every line "
                "it sets"
            )
        glyphs.add(glyph)
    if not glyphs:
        return set(), (
            f"{raw_name}: nothing the document sets with it could be matched "
            f"to a glyph in {face['name']}"
        )
    return glyphs, ""


def _cid_widths(descendant) -> dict[int, float]:
    """cid → advance from a CIDFont's `/W`, in both of the array's forms."""
    raw = descendant.get("/W")
    if raw is None:
        return {}
    out: dict[int, float] = {}
    try:
        items = list(raw)
    except (TypeError, ValueError, AttributeError):
        return {}
    index = 0
    while index < len(items):
        try:
            first = int(items[index])
        except (TypeError, ValueError):
            return out
        if index + 1 >= len(items):
            return out
        follower = items[index + 1]
        if isinstance(follower, pikepdf.Array):
            for offset, value in enumerate(follower):
                try:
                    out[first + offset] = float(value)
                except (TypeError, ValueError):
                    continue
            index += 2
            continue
        if index + 2 >= len(items):
            return out
        try:
            last = int(follower)
            width = float(items[index + 2])
        except (TypeError, ValueError):
            return out
        if last - first > 65535:
            return out
        for cid in range(first, last + 1):
            out[cid] = width
        index += 3
    return out


def _composite_plan(font_obj, descendant, face: dict, tt, raw_name: str) -> tuple[set, str]:
    """The glyphs a Type0 font needs, or a refusal naming why it cannot.

    Only the Identity case is embeddable here: a document that addresses
    glyphs by id is the one whose `/W` proves the installed face is the same
    face. A predefined CMap addresses through a registry ordering this engine
    would have to re-derive, and a face that merely shares a name would draw
    different glyphs at the same codes.
    """
    encoding = str(font_obj.get("/Encoding", "")).lstrip("/")
    if encoding not in ("Identity-H", "Identity-V"):
        return set(), (
            f"{raw_name}: its glyphs are addressed through the {encoding or 'built-in'} "
            "character map, which names glyphs the installed face cannot be proven "
            "to number the same way"
        )
    cid_to_gid = descendant.get("/CIDToGIDMap")
    if cid_to_gid is not None and str(cid_to_gid).lstrip("/") != "Identity":
        return set(), (
            f"{raw_name}: it carries its own glyph-id map, which only the font "
            "program it was built against can be read with"
        )
    widths = _cid_widths(descendant)
    if not widths:
        return set(), (
            f"{raw_name}: the document declares no advances for it, so an "
            "embedded face cannot be proven to keep its lines the same length"
        )
    order = tt.getGlyphOrder()
    scale = _scale_of(tt)
    glyphs: set = set()
    for cid in sorted(widths):
        declared = float(widths[cid])
        if declared <= 0:
            continue
        if cid >= len(order):
            return set(), (
                f"{raw_name}: {face['name']} has no glyph {cid}, which the "
                "document sets"
            )
        glyph = order[cid]
        actual = _advance(tt, glyph, scale)
        if abs(actual - declared) > WIDTH_TOLERANCE:
            return set(), (
                f"{raw_name}: {face['name']} sets glyph {cid} at "
                f"{actual:.0f}/1000 where the document declares "
                f"{declared:.0f}/1000 — embedding it would reflow every line "
                "it sets"
            )
        glyphs.add(glyph)
    if not glyphs:
        return set(), (
            f"{raw_name}: nothing the document sets with it could be matched "
            f"to a glyph in {face['name']}"
        )
    return glyphs, ""


def _restricted_refusal(restricted: list[dict], raw_name: str, bold: bool,
                        italic: bool) -> str:
    face = _match(restricted, raw_name, bold, italic)
    if face is None:
        return ""
    return f"{raw_name}: {face['refusal']}"


def embed_missing_fonts(file: str, output: str, sources=("system",),
                        allow_substitute: bool = False,
                        font_dir: str = "") -> dict:
    """Write a font program for every font the document names and lacks.

    Args:
        file: Input PDF path.
        output: Output PDF path (may equal `file`).
        sources: Where a face may come from — `system`, `bundled`, or both.
        allow_substitute: Write a face that is NOT the one the document names
            when no exact match is installed. Off by default, and every
            substitution it permits is named in the result.
        font_dir: The vendored fallback-fonts directory, for the `bundled`
            source and for the substitute resolver.

    Returns ``{output, embedded, refused, substituted}``. `embedded` names each
    font and the face its program came from; `refused` names each font and why.
    """
    usable, restricted = _available_faces(sources, font_dir)
    output_path = Path(output)
    same_file = is_same_file(file, output)

    embedded: list[dict] = []
    refused: list[dict] = []
    substituted: list[dict] = []
    seen: set = set()

    with pikepdf.open(file) as pdf:
        targets: list = []

        def collect(font_obj, _page, _name) -> None:
            try:
                marker = font_obj.objgen
            except AttributeError:
                marker = None
            key = marker if marker not in (None, (0, 0)) else id(font_obj)
            if key in seen:
                return
            seen.add(key)
            state = font_embedded(font_obj)
            if state is True:
                return
            # Only a font PROVEN to carry no program is rewritten: an unknown
            # state is not a missing program, and embedding over it would
            # replace a font whose own program may be intact. A Type 3 is the
            # exception because no program can ever be written for it, so it
            # is named whatever its glyph procedures read as.
            if state is None and str(font_obj.get("/Subtype", "")).lstrip("/") != "Type3":
                return
            targets.append(font_obj)

        walk_document_fonts(pdf, collect)

        raised: dict = {}
        for font_obj in targets:
            raw_name = str(font_obj.get("/BaseFont", "")).lstrip("/")
            display = _strip_subset_prefix(raw_name) or raw_name or "(unnamed font)"
            try:
                outcome = _embed_one(pdf, font_obj, usable, restricted, display,
                                     allow_substitute, font_dir)
            except ValueError as exc:
                refused.append({"font": display, "reason": str(exc)})
                continue
            if outcome.get("substituted"):
                substituted.append({"font": display, "face": outcome["face"]})
            embedded.append({"font": display, "face": outcome["face"]})
            if outcome.get("min_version"):
                raised[outcome["min_version"]] = True

        if not embedded and refused:
            # The `accessibility_fixes` rule: a caller that asked for this
            # fixup and got nothing is told the reason the first font gave,
            # rather than handed an empty success.
            raise ValueError(refused[0]["reason"])

        if embedded:
            save_kwargs: dict = {}
            if raised:
                save_kwargs["min_version"] = max(raised)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            # The Pdf is closed inside the block: the destination cannot be
            # replaced while it is held open.
            if same_file:
                with staged_write(output_path) as staged:
                    save_pdf(pdf, staged, **save_kwargs)
                    pdf.close()
            else:
                save_pdf(pdf, output_path, **save_kwargs)
    if not embedded and not same_file:
        # Every font already carried its program, and the caller asked for a
        # copy: an output that does not exist would report a success that
        # wrote no file.
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_bytes(Path(file).read_bytes())
    return {
        "output": str(output_path),
        "embedded": embedded,
        "refused": refused,
        "substituted": substituted,
    }


def _embed_one(pdf, font_obj, usable: list[dict], restricted: list[dict],
               display: str, allow_substitute: bool, font_dir: str) -> dict:
    """One font's program, or a `ValueError` naming why it has none."""
    from engine.font_fallback import classify_font_style

    subtype = str(font_obj.get("/Subtype", "")).lstrip("/")
    if subtype == "Type3":
        # A Type3 font IS its glyph procedures; there is no program to write.
        raise ValueError(
            f"{display}: a Type 3 font carries its glyphs as drawings and has no "
            "program to embed"
        )
    raw_name = str(font_obj.get("/BaseFont", "")).lstrip("/")
    bold, italic = classify_font_style(font_obj)
    face = _match(usable, raw_name, bold, italic)
    substitute = False
    if face is None:
        blocked = _restricted_refusal(restricted, raw_name, bold, italic)
        if blocked:
            raise ValueError(blocked)
        if not allow_substitute:
            raise ValueError(
                f"{display}: no installed face matches it, and this fixup embeds "
                "the face a document names or nothing at all"
            )
        face = _substitute_face(font_obj, font_dir, display)
        substitute = True

    tt = _load_face(face)
    try:
        if subtype == "Type0":
            descendants = _descendants(font_obj)
            if not descendants:
                raise ValueError(f"{display}: its descendant font is missing")
            descendant = descendants[0]
            child = str(descendant.get("/Subtype", "")).lstrip("/")
            if child != "CIDFontType2":
                raise ValueError(
                    f"{display}: this engine embeds a glyph-indexed CID font, and "
                    f"the document declares a {child or 'CID'} font"
                )
            glyphs, refusal = _composite_plan(font_obj, descendant, face, tt, display)
            holder = descendant
        else:
            glyphs, refusal = _simple_plan(font_obj, face, tt, display)
            holder = font_obj
        if refusal:
            raise ValueError(refusal)
        data, subset_font = _subset(face, glyphs, retain_gids=(subtype == "Type0"))
        metrics = _metrics(subset_font)
        program_key, program = _program_stream(pdf, data, subset_font)
        base_name = _strip_subset_prefix(raw_name) or face["name"]
        _write_descriptor(pdf, holder, program_key, program, base_name, metrics)
        if subtype in ("Type1", "MMType1") and program_key == "/FontFile2":
            # A TrueType program is only readable through a TrueType font
            # dictionary. The two simple-font dictionaries carry the same
            # entries, so the declaration moves and nothing else does.
            font_obj["/Subtype"] = Name("/TrueType")
        return {
            "face": face["name"],
            "substituted": substitute,
            # `/FontFile3 /OpenType` is a PDF 1.6 construct.
            "min_version": "1.6" if program_key == "/FontFile3" else "",
        }
    finally:
        try:
            tt.close()
        except Exception:  # noqa: BLE001 — a closed face is not a report row
            pass


def _substitute_face(font_obj, font_dir: str, display: str) -> dict:
    """The face `allow_substitute` permits, as a face descriptor.

    Resolved through the same ladder that DRAWS a missing font, so a document
    whose substitute is written reads as the app already renders it.
    """
    from engine.font_fallback import classify_font_style, resolve_fallback_font, style_key

    if not font_dir:
        raise ValueError(
            f"{display}: no installed face matches it and no fallback fonts "
            "directory was given to substitute from"
        )
    bold, italic = classify_font_style(font_obj)
    try:
        resolved = resolve_fallback_font(font_dir, font_obj, style=style_key(bold, italic))
    except (ValueError, OSError) as exc:
        raise ValueError(f"{display}: {exc}") from exc
    face = read_face(resolved)
    if face is None:
        raise ValueError(f"{display}: the substitute face could not be read")
    if face["refusal"]:
        raise ValueError(f"{display}: {face['refusal']}")
    return face
