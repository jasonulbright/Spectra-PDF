"""Printer marks — crop marks, registration targets, colour bars, page info.

Marks are drawn OUTSIDE the trim, so the page has to GROW: a PDF page carries
no room outside its trim box by construction (`page_boxes.set_page_boxes`
clamps INSIDE the media box and cannot grow it), and every ordinary document
has a media box equal to its trim. `/MediaBox` therefore grows by
`offset + length` on every edge and `/CropBox` grows with it — a viewer clips
to the crop box and would hide the marks that were just drawn. `/TrimBox`,
`/BleedBox` and `/ArtBox` are never touched: they still describe the same
paper, which is the whole point of growing the other two.

The original boxes, `/Contents` and `/Resources` are recorded on the page
under one private key, so `remove_printer_marks` restores exactly what was
there — values and object identity, not a reconstruction. The boxes always
come from that record; the contents and resources do only while they are
still the objects the add wrote, because a wholesale restore over an edit
made since would silently revert it. Anything else takes the surgical path
and strips the mark draw out of what the page carries now. A second `add`
removes first, so two runs leave one mark set and one growth.

Crop marks, registration targets and page information paint in
`/Separation /All`, never in `0 0 0 1 k`. The separation device gives `/All`
no plate of its own and paints it onto every plate, so a mark drawn this way
reaches all four; a black one would reach the black plate alone and tell a
press operator nothing about registration. Colour bars are the deliberate
exception — a patch exists to show ONE ink, so a process patch paints in
DeviceCMYK and a spot patch in that spot's own `/Separation` space. A bar
whose spot set could not be established refuses: this writes a document, and
a printed sheet has no room to carry a caveat.

`/AcroForm` is not at risk here: this appends content to existing pages and
copies no page, so no widget's field registration moves.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import pikepdf
from pikepdf import Array, Dictionary, Name

from engine.inplace import is_same_file, staged_write
from engine.pdf_save import save_pdf
from engine.pdf_tree import walk_inheritable
from engine.preflight import COLORSPACE, walk_page_resources
from engine.separations import ink_kind, refuse_unknown_colorants
from engine.validate import validate_pdf

MARK_KINDS = ("crop", "registration", "colorbars", "pageinfo")
STYLES = ("western", "japanese")
# Stroke weights a press expects, in points.
WEIGHTS = (0.125, 0.25, 0.5)
# PDF's own page-extent implementation limit. A growth past it is refused
# rather than written, because a viewer's behaviour past it is undefined.
MAX_PAGE_EXTENT = 14400.0

# One private key holds everything a removal has to put back.
RECORD_KEY = "/SpectraPrinterMarks"
MARK_XOBJECT = "/SpectraPrinterMarks"

# The bleed a Japanese double crop mark indicates when the page declares no
# bleed box: 3 mm, the printing trade's own default.
_DEFAULT_BLEED_PT = 8.5

# Bézier circle constant — four arcs approximate a circle to ~0.02 %.
_KAPPA = 0.5522847498


def _n(value: float) -> str:
    text = f"{float(value):.4f}".rstrip("0").rstrip(".")
    return text if text else "0"


def _box(page, key: str):
    value = walk_inheritable(page, key)
    if value is None:
        return None
    try:
        x0, y0, x1, y1 = (float(value[i]) for i in range(4))
    except (TypeError, ValueError, IndexError):
        return None
    return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


def _own_array(page, key: str):
    """A COPY of the page's OWN box array, preserving each element's numeric
    type, or None when the page inherits the box instead of carrying it."""
    value = page.obj.get(key)
    if value is None:
        return None
    try:
        return Array([value[i] for i in range(4)])
    except (TypeError, ValueError, IndexError):
        return None


def resolve_trim(page) -> tuple[tuple[float, float, float, float], str]:
    """The trim to mark, and WHICH box it came from.

    Explicit `/TrimBox`, else `/CropBox`, else `/MediaBox`. The source is
    reported because a document with no trim box is being guessed at, and a
    panel that does not say so is letting the user believe a guess.
    """
    for key, label in (("/TrimBox", "trim"), ("/CropBox", "crop"), ("/MediaBox", "media")):
        box = _box(page, key)
        if box is not None:
            return box, label
    return (0.0, 0.0, 612.0, 792.0), "default"


# ── mark geometry (pure) ───────────────────────────────────────────────────


def crop_mark_segments(trim, offset: float, length: float, style: str,
                       bleed: float = 0.0) -> list[tuple[float, float, float, float]]:
    """The crop-mark line segments for one page, in page user space.

    Western style is one L-pair per corner: each arm starts `offset` outside
    the trim and runs `length` further out, so no arm ever crosses the trim
    and none is drawn on the artwork. Japanese style adds a second, parallel
    pair at the bleed distance (the "double" crop mark, whose gap between the
    two lines IS the bleed indicator) plus a centre mark on each edge.
    """
    x0, y0, x1, y1 = trim
    inner = offset
    outer = offset + length
    segments: list[tuple[float, float, float, float]] = []

    def corner(cx: float, cy: float, sx: int, sy: int, shift: float) -> None:
        # Horizontal arm: runs outward along x, sitting on the trim edge line
        # (shifted outward by `shift` for a double mark's second line).
        hy = cy + sy * shift
        segments.append((cx - sx * outer, hy, cx - sx * inner, hy))
        vx = cx + sx * shift
        segments.append((vx, cy - sy * outer, vx, cy - sy * inner))

    shifts = [0.0] if style != "japanese" else [0.0, bleed]
    for shift in shifts:
        corner(x0, y0, 1, 1, shift)
        corner(x1, y0, -1, 1, shift)
        corner(x0, y1, 1, -1, shift)
        corner(x1, y1, -1, -1, shift)

    if style == "japanese":
        # Centre marks: a short pair straddling the middle of each edge, which
        # is what a Japanese sheet is folded and registered against.
        mx, my = (x0 + x1) / 2.0, (y0 + y1) / 2.0
        half = length / 2.0
        for edge_y, sy in ((y0, 1), (y1, -1)):
            for dx in (-half, half):
                segments.append((mx + dx, edge_y - sy * outer, mx + dx, edge_y - sy * inner))
        for edge_x, sx in ((x0, 1), (x1, -1)):
            for dy in (-half, half):
                segments.append((edge_x - sx * outer, my + dy, edge_x - sx * inner, my + dy))
    return segments


def registration_centres(trim, offset: float, length: float) -> list[tuple[float, float, float]]:
    """(x, y, radius) for the four edge-midpoint registration targets."""
    x0, y0, x1, y1 = trim
    mx, my = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    radius = max(1.0, length * 0.35)
    out = offset + length / 2.0
    return [
        (mx, y1 + out, radius),
        (mx, y0 - out, radius),
        (x0 - out, my, radius),
        (x1 + out, my, radius),
    ]


def bar_runs(trim, offset: float, length: float) -> list[tuple[float, float]]:
    """The x-ranges the colour bar may occupy along the top band.

    The top registration target sits at the edge midpoint, so the bar is two
    runs with a gap around it rather than one run drawn through it.
    """
    x0, _y0, x1, y1 = trim
    mx = (x0 + x1) / 2.0
    radius = max(1.0, length * 0.35)
    gap = radius * 1.6
    left = (x0, mx - gap)
    right = (mx + gap, x1)
    return [run for run in (left, right) if run[1] - run[0] > 1.0]


def _circle_ops(cx: float, cy: float, r: float) -> bytes:
    k = _KAPPA * r
    return (
        f"{_n(cx + r)} {_n(cy)} m "
        f"{_n(cx + r)} {_n(cy + k)} {_n(cx + k)} {_n(cy + r)} {_n(cx)} {_n(cy + r)} c "
        f"{_n(cx - k)} {_n(cy + r)} {_n(cx - r)} {_n(cy + k)} {_n(cx - r)} {_n(cy)} c "
        f"{_n(cx - r)} {_n(cy - k)} {_n(cx - k)} {_n(cy - r)} {_n(cx)} {_n(cy - r)} c "
        f"{_n(cx + k)} {_n(cy - r)} {_n(cx + r)} {_n(cy - k)} {_n(cx + r)} {_n(cy)} c h"
    ).encode("ascii")


# ── colour-space and resource plumbing ─────────────────────────────────────


def _is_all_space(obj) -> bool:
    try:
        return (isinstance(obj, pikepdf.Array) and len(obj) >= 4
                and str(obj[0]) == "/Separation" and str(obj[1]) == "/All")
    except Exception:
        return False


def _find_all_space(pages):
    """An existing `/Separation /All` space in the document, or None.

    A document that already declares one keeps a single `/All` space instead
    of gaining a second that means exactly the same thing.

    A branch this walk cannot read is not a refusal here, and this is the one
    colorant walk in the module that does not refuse: missing an existing
    `/All` space costs a second object meaning the same thing, and `/All` has
    no plate of its own to be absent from. Nothing printed differs.
    """
    found = [None]

    def on_colorspace(cs, _category):
        if found[0] is None and _is_all_space(cs):
            found[0] = cs

    for page in pages:
        walk_page_resources(page, on_colorspace=on_colorspace)
        if found[0] is not None:
            return found[0]
    return None


def _make_all_space(pdf):
    """`[/Separation /All /DeviceCMYK tint]` — tint 1 is all four at full."""
    fn = pdf.make_indirect(Dictionary(
        FunctionType=2, Domain=Array([0, 1]), N=1,
        C0=Array([0, 0, 0, 0]), C1=Array([1, 1, 1, 1]),
        Range=Array([0, 1, 0, 1, 0, 1, 0, 1]),
    ))
    return pdf.make_indirect(Array([Name.Separation, Name.All, Name.DeviceCMYK, fn]))


def _name_text(obj) -> str:
    text = str(obj)
    return text[1:] if text.startswith("/") else text


def _spot_spaces(targets) -> dict:
    """{spot name: a colour space that paints THAT ink alone}, over (number, page).

    A `/Separation` array paints its one colorant directly. A `/DeviceN`
    component does not — its components go through one shared transform — so
    it contributes a patch only when the document supplies the component's own
    `/Attributes /Colorants` entry. A spot with no such entry gets no patch
    rather than a patch painted in the wrong space.

    A resource branch the walk cannot read may hold a spot, and this is a
    WRITE: the bar would be printed one patch short with nothing on the sheet
    to say so, and a press operator reads ink density off exactly those
    patches. So an unreadable branch refuses by name rather than producing a
    bar whose completeness nobody established.
    """
    spaces: dict[str, object] = {}
    skipped: list[str] = []

    def on_unreadable(facts, reason: str) -> None:
        # Recorded, not raised here. The walk catches whatever its callbacks
        # throw, so a refusal raised inside this one is swallowed and the bar
        # prints anyway; the raise belongs after the walk returns.
        if COLORSPACE in facts:
            skipped.append(reason)

    def on_colorspace(cs, _category):
        if not isinstance(cs, pikepdf.Array) or len(cs) < 4:
            return
        family = _name_text(cs[0])
        if family == "Separation":
            name = _name_text(cs[1])
            if ink_kind(name) == "spot":
                spaces.setdefault(name, cs)
        elif family == "DeviceN" and len(cs) >= 5:
            try:
                colorants = cs[4].get("/Colorants")
                names = [_name_text(v) for v in cs[1]]
            except Exception:
                return
            if colorants is None:
                return
            for name in names:
                if ink_kind(name) != "spot":
                    continue
                try:
                    own = colorants.get(Name("/" + name))
                except Exception:
                    own = None
                if own is not None:
                    spaces.setdefault(name, own)

    for number, page in targets:
        del skipped[:]
        walk_page_resources(page, on_colorspace=on_colorspace,
                            on_unreadable=on_unreadable)
        if skipped:
            refuse_unknown_colorants(number, skipped[0])
    return spaces


def _embed_text_font(pdf, font_dir: str, text: str):
    """(font object, em-width function, show-bytes function) for `text`.

    The face is the bundled OFL one, embedded and subsetted: PDF/X forbids an
    unembedded font, and a printer mark whose label a RIP substitutes is a
    printer mark that lies.
    """
    from engine.font_fallback import build_fallback_font, resolve_fallback_font

    if not font_dir or not Path(font_dir).is_dir():
        raise ValueError(
            "Page information needs an embedded font and no font directory is available."
        )
    face = resolve_fallback_font(font_dir, text=text or None)
    from engine import rtl_text

    built = rtl_text.build(pdf, face, text)
    if built is not None:
        return (built.font_obj,
                lambda s: built.width_em(s),
                lambda s, size: built.show(s, size))
    font_obj, encode, width_1000 = build_fallback_font(pdf, face, text)
    return (font_obj,
            lambda s: width_1000(s) / 1000.0,
            lambda s, _size: b"<" + encode(s).hex().encode("ascii") + b"> Tj")


# ── the mark form ──────────────────────────────────────────────────────────


def _process_patches() -> list[tuple[str, tuple[float, float, float, float]]]:
    """The process solids and their 75/50/25 % tints, in plate order."""
    base = {"Cyan": (1, 0, 0, 0), "Magenta": (0, 1, 0, 0),
            "Yellow": (0, 0, 1, 0), "Black": (0, 0, 0, 1)}
    out = []
    for name, components in base.items():
        for tint in (1.0, 0.75, 0.5, 0.25):
            out.append((name, tuple(c * tint for c in components)))
    return out


def _build_mark_form(pdf, page, trim, media, offset, length, weight, style,
                     marks, spot_spaces, all_space, page_number, total,
                     filename, timestamp, font_dir):
    """One Form XObject drawing every requested mark, in page user space."""
    content: list[bytes] = []
    resources = Dictionary()
    colorspaces = Dictionary()
    colorspaces[Name("/All0")] = all_space
    bleed_box = _box(page, "/BleedBox")
    bleed = _DEFAULT_BLEED_PT
    if bleed_box is not None:
        declared = min(trim[0] - bleed_box[0], trim[1] - bleed_box[1],
                       bleed_box[2] - trim[2], bleed_box[3] - trim[3])
        if declared > 0:
            bleed = declared

    content.append(f"q /All0 CS 1 SCN /All0 cs 1 scn {_n(weight)} w 0 J 0 j".encode("ascii"))

    if "crop" in marks:
        for x0, y0, x1, y1 in crop_mark_segments(trim, offset, length, style, bleed):
            content.append(f"{_n(x0)} {_n(y0)} m {_n(x1)} {_n(y1)} l S".encode("ascii"))

    if "registration" in marks:
        for cx, cy, r in registration_centres(trim, offset, length):
            content.append(_circle_ops(cx, cy, r) + b" S")
            content.append(_circle_ops(cx, cy, r * 0.45) + b" f")
            content.append(
                f"{_n(cx - r * 1.4)} {_n(cy)} m {_n(cx + r * 1.4)} {_n(cy)} l S "
                f"{_n(cx)} {_n(cy - r * 1.4)} m {_n(cx)} {_n(cy + r * 1.4)} l S".encode("ascii")
            )

    bar_names: list[str] = []
    if "colorbars" in marks:
        runs = bar_runs(trim, offset, length)
        patches: list[tuple[str, object]] = [(name, comps) for name, comps in _process_patches()]
        for index, (name, space) in enumerate(sorted(spot_spaces.items())):
            key = f"/Spot{index}"
            colorspaces[Name(key)] = space
            patches.append((key, None))
            bar_names.append(name)
        # Two overprint control patches: the second lays magenta over cyan
        # with overprint ON, so a plate that shows only magenta there proves
        # the overprint was honoured and one that shows both proves it was
        # knocked out.
        patches.append(("__overprint__", None))
        total_width = sum(hi - lo for lo, hi in runs)
        count = max(1, len(patches))
        patch_w = min(length * 0.9, total_width / count)
        bar_h = max(1.0, length * 0.5)
        bar_y = trim[3] + offset
        if patch_w >= 0.5:
            resources[Name("/ExtGState")] = Dictionary(
                OPon=pdf.make_indirect(Dictionary(Type=Name.ExtGState, OP=True, op=True, OPM=1)),
            )
            slot = 0
            for run_lo, run_hi in runs:
                x = run_lo
                while slot < len(patches) and x + patch_w <= run_hi + 1e-6:
                    key, comps = patches[slot]
                    rect = f"{_n(x)} {_n(bar_y)} {_n(patch_w)} {_n(bar_h)} re"
                    if key == "__overprint__":
                        content.append(f"q 1 0 0 0 k {rect} f".encode("ascii"))
                        content.append(
                            f"/OPon gs 0 1 0 0 k {_n(x + patch_w * 0.35)} {_n(bar_y)} "
                            f"{_n(patch_w * 0.65)} {_n(bar_h)} re f Q".encode("ascii")
                        )
                    elif comps is None:
                        content.append(f"q {key} cs 1 scn {rect} f Q".encode("ascii"))
                    else:
                        c, m, y, k = comps
                        content.append(
                            f"q {_n(c)} {_n(m)} {_n(y)} {_n(k)} k {rect} f Q".encode("ascii")
                        )
                    x += patch_w
                    slot += 1

    if "pageinfo" in marks:
        label = _page_info_text(filename, page_number, total, timestamp, bar_names)
        font_obj, width_em, show = _embed_text_font(pdf, font_dir, label)
        resources[Name("/Font")] = Dictionary(F0=font_obj)
        # The line stops short of the bottom edge's registration target.
        runs = bar_runs(trim, offset, length)
        available = max(1.0, (runs[0][1] - trim[0]) if runs else (trim[2] - trim[0]))
        size = min(length * 0.4, 7.0)
        width = width_em(label) * size
        if width > available and width > 0:
            size = max(2.0, size * available / width)
        baseline = trim[1] - offset - size
        content.append(
            f"q BT /F0 {_n(size)} Tf 1 0 0 1 {_n(trim[0])} {_n(baseline)} Tm ".encode("ascii")
            + show(label, size) + b" ET Q"
        )

    content.append(b"Q")
    resources[Name("/ColorSpace")] = colorspaces
    form = pdf.make_stream(b"\n".join(content))
    form.Type = Name.XObject
    form.Subtype = Name.Form
    form.FormType = 1
    form.BBox = Array([media[0], media[1], media[2], media[3]])
    form.Resources = resources
    return pdf.make_indirect(form)


def _page_info_text(filename: str, page_number: int, total: int,
                    timestamp: str, inks) -> str:
    """The page-information line, in the DOCUMENT's conventions.

    ISO 8601 timestamp, filename verbatim, Western digits — this string is
    written into the file and read off paper by a press operator, so it does
    not follow the reader's UI locale.
    """
    parts = [filename, f"{page_number}/{total}", timestamp]
    if inks:
        parts.append(", ".join(inks))
    return "  ·  ".join(p for p in parts if p)


# ── record / restore ───────────────────────────────────────────────────────


def _record(page):
    value = page.obj.get(RECORD_KEY)
    return value if isinstance(value, pikepdf.Dictionary) else None


def _same_object(a, b) -> bool:
    """Both indirect and the same object. Two direct objects are never the
    same one for this purpose — the question is whether something replaced
    what the add wrote, and only an indirect reference can answer it."""
    try:
        if not (a.is_indirect and b.is_indirect):
            return False
        return a.objgen == b.objgen
    except AttributeError:
        return False


def _untouched_since_add(page, record) -> bool:
    """Are the page's contents and resources still exactly what the add
    wrote? Anything that rewrote the page between the add and the remove —
    another content edit, a resource registration — makes a wholesale restore
    a silent revert of that work, so the removal takes the surgical path
    instead."""
    wrote = record.get("/Wrote")
    if wrote is None or len(wrote) < 3:
        return False
    contents = page.obj.get("/Contents")
    if not isinstance(contents, pikepdf.Array) or len(contents) < 2:
        return False
    return (
        _same_object(contents[0], wrote[0])
        and _same_object(contents[len(contents) - 1], wrote[1])
        and _same_object(page.obj.get("/Resources"), wrote[2])
    )


def _strip_marks(pdf, page) -> None:
    """Remove the mark draw and its XObject from whatever the page carries
    now, leaving every other edit in place.

    A page that inherited its `/Resources` keeps the own copy the add gave it,
    minus the mark entry — the alternative is deleting a dictionary another
    edit may since have added to.
    """
    kept: list = []
    instructions = list(pikepdf.parse_content_stream(page))
    drop: set = set()
    for index, instruction in enumerate(instructions):
        if str(instruction.operator) != "Do" or not instruction.operands:
            continue
        if str(instruction.operands[0]) != MARK_XOBJECT:
            continue
        drop.add(index)
        # The add draws the marks inside their own `q … Q`; dropping the frame
        # with the draw keeps the stream balanced.
        if index > 0 and str(instructions[index - 1].operator) == "q":
            drop.add(index - 1)
        if index + 1 < len(instructions) and str(instructions[index + 1].operator) == "Q":
            drop.add(index + 1)
    for index, instruction in enumerate(instructions):
        if index not in drop:
            kept.append(instruction)
    page.obj[Name("/Contents")] = pdf.make_stream(pikepdf.unparse_content_stream(kept))

    resources = page.obj.get("/Resources")
    if resources is None:
        return
    fresh = Dictionary()
    for key in resources.keys():
        fresh[key] = resources[key]
    xobjects = fresh.get("/XObject")
    if xobjects is not None:
        pruned = Dictionary()
        for key in xobjects.keys():
            if str(key) != MARK_XOBJECT:
                pruned[key] = xobjects[key]
        fresh[Name("/XObject")] = pruned
    page.obj[Name("/Resources")] = pdf.make_indirect(fresh)


def _restore(pdf, page) -> bool:
    """Put the page back. False when nothing is recorded — a page with no
    marks is not an error.

    The BOXES always come from the record, values and numeric types intact:
    the growth is what the add did to them and the recorded originals are the
    only exact answer. Contents and resources are restored wholesale only
    while they are still the objects the add wrote; otherwise the marks are
    stripped out of what is there now, so an edit made between the add and
    the remove survives.
    """
    record = _record(page)
    if record is None:
        return False
    exact = _untouched_since_add(page, record)
    for key in ("/MediaBox", "/CropBox"):
        if record.get(key) is not None:
            page.obj[key] = record[key]
        else:
            try:
                del page.obj[key]
            except (KeyError, AttributeError):
                pass
    if exact:
        for key in ("/Contents", "/Resources"):
            if record.get(key) is not None:
                page.obj[key] = record[key]
            else:
                try:
                    del page.obj[key]
                except (KeyError, AttributeError):
                    pass
    else:
        _strip_marks(pdf, page)
    del page.obj[RECORD_KEY]
    return True


def _grow(box, margin: float):
    return (box[0] - margin, box[1] - margin, box[2] + margin, box[3] + margin)


def _content_streams(page) -> list:
    contents = page.obj.get("/Contents")
    if contents is None:
        return []
    if isinstance(contents, pikepdf.Array):
        return list(contents)
    return [contents]


def _validated(marks, style: str, weight: float, offset: float, length: float):
    kinds = tuple(MARK_KINDS) if marks is None else tuple(str(m) for m in marks)
    for kind in kinds:
        if kind not in MARK_KINDS:
            raise ValueError(f"{kind} is not a printer mark.")
    if style not in STYLES:
        styles = ", ".join(STYLES)
        raise ValueError(f"Mark style must be one of {styles}.")
    if float(weight) not in WEIGHTS:
        weights = ", ".join(f"{w} pt" for w in WEIGHTS)
        raise ValueError(f"Mark weight must be one of {weights}.")
    if float(offset) < 0 or float(length) <= 0:
        raise ValueError("Mark offset must be zero or more and mark length must be positive.")
    return kinds


def add_printer_marks(
    file: str,
    output: str,
    marks: list | None = None,
    style: str = "western",
    weight: float = 0.25,
    offset: float = 9.0,
    length: float = 18.0,
    pages: list | None = None,
    font_dir: str = "",
    timestamp: str = "",
) -> dict:
    """Draw printer marks outside the trim, growing the page to hold them.

    Args:
        marks: any of crop / registration / colorbars / pageinfo. None = all.
        style: `western` (one L-pair per corner) or `japanese` (double crop
            marks whose gap indicates the bleed, plus edge centre marks).
        weight: stroke weight in points — 0.125, 0.25 or 0.5.
        offset: gap between the trim edge and the start of a mark, points.
        length: how far a mark runs outward from `offset`, points. The page
            grows by `offset + length` on every edge.
        pages: 1-based page numbers; None = all, [] = none.
        font_dir: the bundled fallback-fonts directory, for page information.
        timestamp: ISO 8601 stamp to write; empty means now, local offset.

    Marks are idempotent: an add over an existing set removes it and restores
    the recorded boxes first, so two runs leave one mark set and one growth.
    """
    kinds = _validated(marks, style, weight, offset, length)
    validate_pdf(file)
    margin = float(offset) + float(length)
    stamp = timestamp or datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%dT%H:%M:%S%z")
    filename = Path(file).name

    input_path = Path(file)
    output_path = Path(output)
    same_file = is_same_file(str(input_path), str(output_path))
    wanted = None if pages is None else {int(p) for p in pages}

    marked = 0
    skipped: list[dict] = []
    reports: list[dict] = []
    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        targets = [
            (index, page) for index, page in enumerate(pdf.pages, start=1)
            if wanted is None or index in wanted
        ]
        all_space = None
        spot_spaces: dict = {}
        if targets:
            existing = _find_all_space([p for _i, p in targets])
            all_space = existing if existing is not None else _make_all_space(pdf)
            if "colorbars" in kinds:
                spot_spaces = _spot_spaces(targets)

        for index, page in targets:
            _restore(pdf, page)
            media = _box(page, "/MediaBox")
            if media is None:
                skipped.append({"page": index, "reason": "no media box"})
                continue
            new_media = _grow(media, margin)
            if (new_media[2] - new_media[0] > MAX_PAGE_EXTENT
                    or new_media[3] - new_media[1] > MAX_PAGE_EXTENT):
                raise ValueError(
                    f"Adding printer marks would make page {index} larger than "
                    "the 14400-point page limit."
                )
            trim, trim_source = resolve_trim(page)

            record = Dictionary()
            own_media = _own_array(page, "/MediaBox")
            if own_media is not None:
                record[Name("/MediaBox")] = own_media
            own_crop = _own_array(page, "/CropBox")
            if own_crop is not None:
                record[Name("/CropBox")] = own_crop
            contents = page.obj.get("/Contents")
            if contents is not None:
                record[Name("/Contents")] = contents
            own_resources = page.obj.get("/Resources")
            if own_resources is not None:
                record[Name("/Resources")] = own_resources

            form = _build_mark_form(
                pdf, page, trim, new_media, float(offset), float(length),
                float(weight), style, kinds, spot_spaces, all_space,
                index, total, filename, stamp, font_dir,
            )

            resources = Dictionary()
            inherited = walk_inheritable(page, "/Resources")
            if inherited is not None:
                for key in inherited.keys():
                    resources[key] = inherited[key]
            xobjects = Dictionary()
            existing_xo = resources.get("/XObject")
            if existing_xo is not None:
                for key in existing_xo.keys():
                    xobjects[key] = existing_xo[key]
            xobjects[Name(MARK_XOBJECT)] = form
            resources[Name("/XObject")] = xobjects

            streams = _content_streams(page)
            # The original content keeps its own balanced frame: a producer
            # that leaves `q` unmatched would otherwise carry its state into
            # the mark draw.
            pre = pdf.make_stream(b"q\n")
            post = pdf.make_stream(f"\nQ\nq\n{MARK_XOBJECT} Do\nQ\n".encode("ascii"))
            written_resources = pdf.make_indirect(resources)
            page.obj[Name("/Contents")] = Array([pre] + streams + [post])
            page.obj[Name("/Resources")] = written_resources
            # What the add wrote, so the removal can tell an untouched page
            # from one something else has edited since.
            record[Name("/Wrote")] = Array([pre, post, written_resources])
            page.obj[Name("/MediaBox")] = Array(list(new_media))
            crop = _box(page, "/CropBox")
            if crop is not None:
                page.obj[Name("/CropBox")] = Array(list(_grow(crop, margin)))
            page.obj[Name(RECORD_KEY)] = record

            marked += 1
            reports.append({
                "page": index,
                "trim_source": trim_source,
                "media_before": list(media),
                "media_after": list(new_media),
            })

        if same_file:
            with staged_write(output_path) as staged:
                save_pdf(pdf, str(staged))
                pdf.close()
        else:
            save_pdf(pdf, output_path)

    return {
        "output": str(output_path),
        "marked": marked,
        "growth": margin,
        "marks": list(kinds),
        "style": style,
        "spot_patches": sorted(spot_spaces),
        "pages": reports,
        "skipped": skipped,
    }


def remove_printer_marks(file: str, output: str, pages: list | None = None) -> dict:
    """Remove printer marks and restore the boxes the add recorded.

    A page carrying no recorded marks is REPORTED, not refused: removing
    nothing from a page that has nothing is the requested end state.
    """
    validate_pdf(file)
    input_path = Path(file)
    output_path = Path(output)
    same_file = is_same_file(str(input_path), str(output_path))
    wanted = None if pages is None else {int(p) for p in pages}

    removed = 0
    unmarked: list[int] = []
    with pikepdf.open(file) as pdf:
        for index, page in enumerate(pdf.pages, start=1):
            if wanted is not None and index not in wanted:
                continue
            if _restore(pdf, page):
                removed += 1
            else:
                unmarked.append(index)

        if same_file:
            with staged_write(output_path) as staged:
                save_pdf(pdf, str(staged))
                pdf.close()
        else:
            save_pdf(pdf, output_path)

    return {"output": str(output_path), "removed": removed, "unmarked": unmarked}


def list_printer_marks(file: str, pages: list | None = None) -> dict:
    """Per page: which box the trim would come from, whether marks are
    already present, and the page's four boxes."""
    validate_pdf(file)
    wanted = None if pages is None else {int(p) for p in pages}
    rows: list[dict] = []
    with pikepdf.open(file) as pdf:
        for index, page in enumerate(pdf.pages, start=1):
            if wanted is not None and index not in wanted:
                continue
            trim, source = resolve_trim(page)
            rows.append({
                "page": index,
                "marked": _record(page) is not None,
                "trim_source": source,
                "trim": list(trim),
                "media": list(_box(page, "/MediaBox") or ()),
                "crop": list(_box(page, "/CropBox") or ()),
                "bleed": list(_box(page, "/BleedBox") or ()),
                "art": list(_box(page, "/ArtBox") or ()),
            })
    return {
        "pages": rows,
        "marked": sum(1 for r in rows if r["marked"]),
        "without_trim_box": sum(1 for r in rows if r["trim_source"] != "trim"),
    }
