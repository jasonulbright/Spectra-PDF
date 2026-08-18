"""ICC-managed colour conversion for prepress.

Converts a document's color to DeviceCMYK for print. Ghostscript drives the
conversion through its
built-in ICC engine (LittleCMS + its compiled-in default CMYK profile), so the
transform is colour-managed even though no external profile is bundled: an RGB
red (`1 0 0 rg`) comes out as CMYK (`0 0.996 1 0 k`), not a naive component
copy.

``convert_cmyk`` takes a destination ICC profile, either a user's .icc file or
a bare name resolved against
gs's ROM-filesystem profiles like ``default_cmyk.icc`` — probe-verified), and
``convert_pdfx`` produces a PDF/X master with a real /OutputIntents entry
(GTS_PDFX, registered characterization by identifier, optionally embedding
the user's destination profile as /DestOutputProfile) via a customized
PDFX_def.ps against the bundled template's contract. Soft-proofing remains a
distinct capability.
"""

import shutil
import subprocess
import tempfile
from pathlib import Path

import pikepdf
from pikepdf import Dictionary, Name

from . import budget, standards_report
from .acroform import reattach_forms_file
from .trapping import DEFAULT_TRAPPED, TRAPPED_VALUES
from .validate import validate_pdf
from .widget_faces import (IDENTITY, box_of, compose, face_box,
                           harvest_appearances, matrix_of, stage_appearances)

# The resource walk, the colorant-space predicates and the colorant naming are
# `ink_manager`'s: one walk addresses paints, shadings and patterns per
# colorant for the whole engine, and a second one would drift from it in
# exactly the places a spot colour hides. Imported ON USE — `separations`
# reaches back here for the soft-proof staging, so a module-level import
# closes a cycle.

# Ghostscript render intent for the colour transform. Relative colorimetric
# (1) is the prepress default — it maps in-gamut colours exactly and clips the
# rest, which is what a print house expects; perceptual (0) would shift every
# colour to compress the gamut. 0=perceptual 1=relative 2=saturation 3=absolute.
# NB: with the BUILT-IN default CMYK profile "saturation" renders IDENTICALLY to
# perceptual — that profile has no Saturation (AToB2) table, so LittleCMS falls
# back to perceptual per the ICC spec. It stays a valid value (a bundled
# destination profile that defines it would make it distinct), but the UI does
# not offer it while it would be a no-op.
_RENDER_INTENTS = {"perceptual": 0, "relative": 1, "saturation": 2, "absolute": 3}


def _dest_profile_flag(dest_profile: str) -> list[str]:
    """-sOutputICCProfile for a user profile. A PATH must exist (typo caught
    early, not as an opaque gs error); a bare name passes through to gs's
    ROM-filesystem profile set (default_cmyk.icc and friends)."""
    p = str(dest_profile).strip()
    if not p:
        return []
    if ("/" in p or "\\" in p) and not Path(p).is_file():
        raise ValueError(f"Destination ICC profile not found: {p}")
    return [f"-sOutputICCProfile={p}"]


def _permit_profile_read(dest_profile: str) -> list[str]:
    """--permit-file-read for a destination profile that is a real file."""
    p = str(dest_profile).strip()
    if not p or not Path(p).is_file():
        return []
    return [f"--permit-file-read={p}"]


# ── the destination profile's own class ────────────────────────────────────

#: ICC.1 clause 7.2 fixed header offsets: the profile/device class at 12, the
#: data colour space at 16, the 'acsp' file signature at 36. Four-byte
#: signatures at fixed positions, so reading them costs no dependency.
_ICC_CLASS = slice(12, 16)
_ICC_SPACE = slice(16, 20)
_ICC_SIGNATURE = slice(36, 40)
_ICC_HEADER_BYTES = 128

#: Profile classes that can describe an OUTPUT condition. A device link
#: ('link') carries a baked-in input space, an abstract profile ('abst')
#: transforms within one space and a named-colour profile ('nmcl') holds a
#: swatch list — none of the three names a destination a conversion can
#: target, whatever their data colour space says.
_OUTPUT_CLASSES = frozenset({"prtr", "mntr", "scnr", "spac"})


def _icc_header(data: bytes) -> tuple[str, str] | None:
    """(profile class, data colour space) or None when this is not a profile."""
    if len(data) < _ICC_HEADER_BYTES or data[_ICC_SIGNATURE] != b"acsp":
        return None
    return (
        data[_ICC_CLASS].decode("latin-1", "replace").strip(),
        data[_ICC_SPACE].decode("latin-1", "replace").strip(),
    )


def _require_cmyk_profile(label: str, data: bytes) -> None:
    """Refuse a destination profile that cannot be this op's output space.

    Ghostscript accepts whatever `-sOutputICCProfile` names and converts to
    THAT space, so a one-channel profile turns "Convert to CMYK" into a
    greyscale conversion and says nothing (measured). The op's name is a
    promise about the output space, so the profile is checked against it.
    """
    header = _icc_header(data)
    if header is None:
        raise ValueError(f'"{label}" is not an ICC profile.')
    profile_class, space = header
    if profile_class not in _OUTPUT_CLASSES:
        raise ValueError(
            f'The destination profile "{label}" is a "{profile_class}" profile, '
            "which does not describe an output condition."
        )
    if space != "CMYK":
        raise ValueError(
            f'The destination profile "{label}" describes "{space}" colour, '
            "not CMYK."
        )


def _validate_dest_profile(dest_profile: str, gs_path: str) -> None:
    """Read the destination profile's header before anything converts.

    A bare name is one of Ghostscript's own ROM-filesystem profiles and is
    read the only way it can be — extracted and inspected — because that set
    holds greyscale and RGB profiles too.
    """
    p = str(dest_profile).strip()
    if not p:
        return
    path = Path(p)
    if path.is_file():
        _require_cmyk_profile(path.name, path.read_bytes()[:_ICC_HEADER_BYTES])
        return
    if "/" in p or "\\" in p:
        raise ValueError(f"Destination ICC profile not found: {p}")
    scratch = Path(tempfile.mkdtemp(prefix="spectra-icc-"))
    try:
        extracted = _extract_rom_profile(gs_path, p, scratch)
        _require_cmyk_profile(p, extracted.read_bytes()[:_ICC_HEADER_BYTES])
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


# ── the colorant-shading carve-out ─────────────────────────────────────────
#
# Ghostscript will not carry a shading it must colour-convert: a `/Separation`
# or `/DeviceN` `sh`, and a shading pattern in one, come back as a DeviceCMYK
# image and the plate is gone — while a DeviceCMYK shading in the same pass
# survives AS a shading (measured). A colorant whose ALTERNATE is already
# DeviceCMYK needs no transform at all, so its shading is staged as its own
# DeviceCMYK equivalent — the alternate space, with the tint transform composed
# onto the shading's function — and the colorant space is put back on the
# object afterwards. Geometry, clip, z-order and coordinate space stay the
# producer's own work, which is why nothing here reconstructs them.
#
# The paints are bracketed in marked content so the staged objects can be found
# again: a bracket survives the rewrite (measured), a resource NAME does not.
# A colorant whose alternate is anything else genuinely needs the transform,
# goes through the producer, and is REPORTED — as is one whose bracket did not
# survive, which costs the plate and never the colour, because the staged
# shading paints exactly what the transform would have painted.
#
# The walk reaches page content, the Form XObjects and tiling patterns under
# it, and annotation APPEARANCE streams: the producer colour-converts an `/AP`
# exactly as it converts page content, so a colorant gradient in one is
# rasterized in the same way (measured). Every appearance is claimed and no
# annotation is exempt, because the producer exempts none:
#   - the FLAGS decide nothing. ISO 32000-2 12.5.3 makes bit 2 (Hidden)
#     suppress both display and print and bit 3 (Print) govern the rest, but
#     the producer converts every appearance whatever they say (measured), so
#     a flag-aware carve-out would leave it free to destroy the plates it
#     skipped. A document's ink inventory is not a rendering question.
#   - every FACE is rewritten — `/N`, `/R`, `/D` and the appearance states.
#   - an annotation the producer DROPS is flattened into the page content it
#     came from (measured), so its bracket travels there and its plate is
#     recovered at the page tier; a subtype the walk skipped would lose that
#     copy to a process raster instead.

_MARK_TAG = Name("/SpectraShading")
_MARK_ID = "/SpectraId"

_PATH_PAINTING = frozenset({"S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"})
_TEXT_SHOWING = frozenset({"Tj", "TJ", "'", '"'})
_CONSUMING = _PATH_PAINTING | _TEXT_SHOWING | {"Do", "sh", "EI", "INLINE IMAGE"}


class _Carved:
    """One shading the carve-out claims, and its way back."""

    __slots__ = ("ident", "colorants", "shading", "colorspace", "function",
                 "staged_function")

    def __init__(self, ident, colorants, shading, colorspace, function):
        self.ident = ident
        self.colorants = colorants
        self.shading = shading
        self.colorspace = colorspace
        self.function = function
        # The composed function the staging installed. A shading worn by a
        # pattern can be a DIRECT dictionary and so has no object number of
        # its own; the function this pass creates always has one, so it is
        # what names the shading while the staged file is being written.
        self.staged_function = None


def _colorant_alternate(cs):
    """(colorant names, alternate space) for a colorant space, else None."""
    from .ink_manager import _colorant_names, _is_devicen, _is_separation

    if not (_is_separation(cs) or _is_devicen(cs)):
        return None
    return _colorant_names(cs), (cs[2] if len(cs) >= 3 else None)


def _needs_no_transform(alt) -> bool:
    """DeviceCMYK already describes the tint in the destination's own space,
    so the composed shading IS what the conversion would have produced."""
    return isinstance(alt, pikepdf.Name) and str(alt) == "/DeviceCMYK"


def _carve_targets(pdf, annotations: bool):
    """(the shadings the carve-out claims, the colorants it cannot).

    The order is the resource walk's, and it is what names them: the same
    document walked again yields the same identifiers, which is how the
    restore pass finds the objects the staging pass rewrote. The walk's reach
    is therefore part of that identity — staging and restore ask for the same
    `annotations`.
    """
    from .ink_manager import _shading_dicts, shading_skip_reason

    targets: list = []
    rasterized: set = set()
    for shading in _shading_dicts(pdf, annotations):
        try:
            colorspace = shading.get("/ColorSpace")
            entry = _colorant_alternate(colorspace)
        except Exception:  # noqa: BLE001 — an unreadable shading is not one
            continue
        if entry is None:
            continue
        colorants, alt = entry
        function = shading.get("/Function")
        if (not _needs_no_transform(alt) or function is None
                or len(colorspace) < 4
                or shading_skip_reason(shading) is not None):
            rasterized.update(colorants)
            continue
        targets.append(_Carved(
            len(targets) + 1, colorants, shading,
            pdf.make_indirect(colorspace), pdf.make_indirect(function)))
    return targets, rasterized


def _apply_staging(pdf, targets) -> set:
    """Rewrite each target into the destination space; the idents that took."""
    from .color_spaces import build_function
    from .ink_manager import _compose_shading_function

    done: set = set()
    for item in targets:
        tint = build_function(item.colorspace[3])
        replacement = (_compose_shading_function(pdf, item.shading, tint, 4)
                       if tint is not None else None)
        if replacement is None:
            continue
        staged = pdf.make_indirect(replacement)
        item.shading["/ColorSpace"] = item.colorspace[2]
        item.shading["/Function"] = staged
        item.staged_function = staged.objgen
        done.add(item.ident)
    return done


def _shading_of(entry, group: str):
    """The shading a `/Shading` or `/Pattern` resource entry paints."""
    try:
        return entry if group == "/Shading" else entry.get("/Shading")
    except Exception:  # noqa: BLE001
        return None


def _selected_shading(resources, operator: str, operands):
    """The shading a selecting operator names, or None."""
    if operator == "sh" and operands:
        group, key = "/Shading", operands[0]
    elif operator in ("scn", "SCN", "sc", "SC") and operands and isinstance(
            operands[-1], pikepdf.Name):
        group, key = "/Pattern", operands[-1]
    else:
        return None
    table = resources.get(group) if resources is not None else None
    if not isinstance(table, pikepdf.Dictionary):
        return None
    try:
        entry = table[key]
    except Exception:  # noqa: BLE001
        return None
    return _shading_of(entry, group)


def _staged_key(shading):
    """The staged shading's identity: its composed function's object number."""
    if shading is None:
        return None
    try:
        function = shading.get("/Function")
    except Exception:  # noqa: BLE001
        return None
    return function.objgen if getattr(function, "is_indirect", False) else None


def _bracket_owner(pdf, owner, ids) -> None:
    """Bracket every paint of a staged shading in this stream.

    The bracket runs from the operator that SELECTS the shading to the one
    that consumes it: the producer rewrites that pair together, and a bracket
    around the selector alone can be hoisted out from under the paint.
    """
    resources = owner.get("/Resources")
    if resources is None:
        return
    try:
        instructions = list(pikepdf.parse_content_stream(owner))
    except Exception:  # noqa: BLE001 — an unparseable stream brackets nothing
        return
    opens: dict = {}
    closes: dict = {}
    pending = None

    def close_at(index: int) -> None:
        closes[index] = closes.get(index, 0) + 1

    for index, instruction in enumerate(instructions):
        operator = str(instruction.operator)
        shading = _selected_shading(resources, operator, list(instruction.operands))
        ident = ids.get(_staged_key(shading))
        if ident is not None:
            if pending is not None:
                close_at(pending)
                pending = None
            opens[index] = ident
            if operator == "sh":
                close_at(index)
            else:
                pending = index
            continue
        if pending is not None and operator in _CONSUMING:
            close_at(index)
            pending = None
    if pending is not None:
        close_at(pending)
    if not opens:
        return
    out = []
    for index, instruction in enumerate(instructions):
        if index in opens:
            out.append(pikepdf.ContentStreamInstruction(
                [_MARK_TAG, Dictionary({_MARK_ID: opens[index]})],
                pikepdf.Operator("BDC")))
        out.append(instruction)
        for _ in range(closes.get(index, 0)):
            out.append(pikepdf.ContentStreamInstruction([], pikepdf.Operator("EMC")))
    data = pikepdf.unparse_content_stream(out)
    if isinstance(owner, pikepdf.Stream):
        owner.write(data)
    else:
        owner["/Contents"] = pdf.make_stream(data)


def _stage_carve_out(source: Path, scratch: Path, annotations: bool,
                     forms: bool = False):
    """(the staged input or None, {ident: colorants}, the rasterized colorants,
    the appearance boxes staged as pages).

    None means nothing was staged and the conversion runs on the original.

    The colorant staging is decided from the walk BEFORE any form staging runs,
    so the ident order the restore pass re-derives from the original is the one
    this pass used. The staged appearance pages then carry their faces as page
    content, which is where the bracket pass reaches them.
    """
    from .ink_manager import _content_owners

    with pikepdf.open(str(source)) as pdf:
        targets, rasterized = _carve_targets(pdf, annotations)
        staged = _apply_staging(pdf, targets)
        rasterized.update(name for item in targets if item.ident not in staged
                          for name in item.colorants)
        boxes = stage_appearances(pdf) if forms else []
        if not staged and not boxes:
            return None, {}, sorted(rasterized), []
        if staged:
            ids = {item.staged_function: item.ident for item in targets
                   if item.ident in staged}
            for owner in _content_owners(pdf, annotations):
                _bracket_owner(pdf, owner, ids)
        path = scratch / "staged.pdf"
        pdf.save(str(path))
        claimed = {item.ident: item.colorants for item in targets
                   if item.ident in staged}
    return path, claimed, sorted(rasterized), boxes


def _marker_ident(operand, properties):
    entry = operand
    if isinstance(operand, pikepdf.Name):
        if properties is None:
            return None
        try:
            entry = properties[operand]
        except Exception:  # noqa: BLE001
            return None
    if not isinstance(entry, pikepdf.Dictionary):
        return None
    try:
        return int(entry.get(_MARK_ID))
    except (TypeError, ValueError):
        return None


def _swap_owner(pdf, owner, by_ident, swapped) -> None:
    """Put the colorant space back on every shading a bracket names.

    Marked content nests, so a paint belongs to the innermost open bracket.
    The producer moves `Q` around freely and that changes nothing here: the
    bracket carries the identity, not the graphics state.
    """
    resources = owner.get("/Resources")
    try:
        instructions = list(pikepdf.parse_content_stream(owner))
    except Exception:  # noqa: BLE001
        return
    properties = resources.get("/Properties") if resources is not None else None
    stack: list = []
    ours = 0
    keep: list = []
    for instruction in instructions:
        operator = str(instruction.operator)
        operands = list(instruction.operands)
        if operator in ("BDC", "BMC"):
            ident = (_marker_ident(operands[1] if len(operands) > 1 else None,
                                   properties)
                     if operands and operands[0] == _MARK_TAG else None)
            stack.append(ident)
            if ident is not None:
                ours += 1
                continue
        elif operator == "EMC":
            ident = stack.pop() if stack else None
            if ident is not None:
                continue
        else:
            open_ident = next((i for i in reversed(stack) if i is not None), None)
            item = by_ident.get(open_ident) if open_ident is not None else None
            if item is not None:
                shading = _selected_shading(resources, operator, operands)
                # Only a shading still in the destination space is put back:
                # two staged shadings the producer merged into one object
                # cannot both be, and the second would relabel the first's
                # plate rather than recover its own.
                if shading is not None and _needs_no_transform(
                        shading.get("/ColorSpace")):
                    shading["/ColorSpace"] = item.colorspace
                    shading["/Function"] = item.function
                    swapped.add(item.ident)
        keep.append(instruction)
    if not ours or stack:
        # An unbalanced bracket set is left in place: the swap has already
        # happened and an inert mark costs nothing, where a mis-cut content
        # stream costs the page.
        return
    data = pikepdf.unparse_content_stream(keep)
    if isinstance(owner, pikepdf.Stream):
        owner.write(data)
    else:
        owner["/Contents"] = pdf.make_stream(data)
    if isinstance(properties, pikepdf.Dictionary):
        for key in list(properties.keys()):
            entry = properties[key]
            if isinstance(entry, pikepdf.Dictionary) and _MARK_ID in entry:
                del properties[key]


def _restore_carve_out(output: Path, source: Path, idents: set,
                       annotations: bool) -> set:
    """Put every staged shading's colorant space back on the converted file.

    Returns the idents that were found. One that was not costs its plate and
    never its colour — the staged shading paints what the transform would have
    painted — so the caller reports it instead of converting a second time.
    """
    from .ink_manager import _content_owners

    swapped: set = set()
    if not idents:
        return swapped
    with pikepdf.open(str(source)) as src:
        targets, _rasterized = _carve_targets(src, annotations)
        by_ident = {item.ident: item for item in targets if item.ident in idents}
        if set(by_ident) != set(idents):
            return swapped
        with pikepdf.open(str(output), allow_overwriting_input=True) as converted:
            for item in by_ident.values():
                item.colorspace = converted.copy_foreign(item.colorspace)
                item.function = converted.copy_foreign(item.function)
            for owner in _content_owners(converted, annotations):
                _swap_owner(converted, owner, by_ident, swapped)
            if swapped:
                converted.save(str(output))
    return swapped


def _after_restore(output: Path, source: Path, claimed: dict, rasterized: list,
                   annotations: bool) -> list:
    """Restore the claimed shadings, and name whatever the restore could not."""
    if not claimed:
        return rasterized
    missing = set(claimed) - _restore_carve_out(output, source, set(claimed),
                                                annotations)
    if not missing:
        return rasterized
    return sorted(set(rasterized) | {name for ident in missing
                                     for name in claimed[ident]})


# ── the appearance's pattern space ─────────────────────────────────────────
#
# A pattern matrix maps pattern space to the DEFAULT user space of the content
# stream the pattern is a resource of (ISO 32000-2 8.7.2) — for an annotation
# appearance, that stream's own space, never the page's. The producer writes an
# appearance's CONTENT in a scaled space but its pattern matrices in the page's,
# so a gradient inside an appearance collapses to a flat band and a tiling
# pattern lands at the wrong step (both measured, and neither is about colour: a
# DeviceCMYK gradient with nothing to convert breaks the same way).
#
# The two are reconciled by making the appearance's default space BE the page's:
# 12.5.5's appearance-to-Rect map is baked into the content as a leading `cm`,
# the `/BBox` becomes the `/Rect` and the `/Matrix` the identity. Every paint
# lands exactly where it did, and the pattern matrices then mean what the
# producer wrote them to mean. Only an appearance that actually paints through
# a pattern is touched — nothing else reads a stream's default space.

def _appearance_matrix(stream, rect):
    """12.5.5's appearance-to-Rect matrix, or None when it does not exist.

    The transformed appearance box is mapped onto the annotation rectangle, and
    that fit composes with the form matrix.
    """
    box = face_box(stream)
    matrix = matrix_of(stream, "/Matrix")
    if box is None or matrix is None or rect is None:
        return None
    if rect[2] - rect[0] <= 0 or rect[3] - rect[1] <= 0:
        return None
    sx = (rect[2] - rect[0]) / (box[2] - box[0])
    sy = (rect[3] - rect[1]) / (box[3] - box[1])
    fit = (sx, 0.0, 0.0, sy, rect[0] - box[0] * sx, rect[1] - box[1] * sy)
    return compose(matrix, fit)


def _real(value: float) -> str:
    text = f"{value:.10f}".rstrip("0").rstrip(".")
    return "0" if text in ("", "-", "-0") else text


def _paints_through_pattern(stream, depth: int = 0) -> bool:
    """Whether this appearance reaches a `/Pattern` resource at any depth."""
    if depth > 8:
        return False
    try:
        resources = stream.get("/Resources")
        if resources is None:
            return False
        patterns = resources.get("/Pattern")
        if isinstance(patterns, pikepdf.Dictionary) and len(patterns) > 0:
            return True
        xobjects = resources.get("/XObject")
        if not isinstance(xobjects, pikepdf.Dictionary):
            return False
        for key in list(xobjects.keys()):
            entry = xobjects[key]
            if (isinstance(entry, pikepdf.Stream)
                    and str(entry.get("/Subtype")) == "/Form"
                    and _paints_through_pattern(entry, depth + 1)):
                return True
    except Exception:  # noqa: BLE001 — an unreadable appearance is left alone
        return False
    return False


def _appearance_streams(pdf) -> list:
    """[(appearance stream, its annotation rectangle)], the unambiguous ones.

    One stream worn by two annotations has two rectangles and so no single
    default space to be rebased into; it keeps the one the producer gave it.
    """
    rects: dict = {}
    streams: dict = {}
    for page in pdf.pages:
        for annot in list(page.obj.get("/Annots") or []):
            try:
                rect = box_of(annot, "/Rect")
                appearance = annot.get("/AP")
            except Exception:  # noqa: BLE001
                continue
            if rect is None or appearance is None:
                continue
            faces: list = []
            for key in list(appearance.keys()):
                entry = appearance[key]
                if isinstance(entry, pikepdf.Stream):
                    faces.append(entry)
                elif isinstance(entry, pikepdf.Dictionary):
                    faces.extend(entry[state] for state in list(entry.keys()))
            for face in faces:
                if not isinstance(face, pikepdf.Stream):
                    continue
                ident = face.objgen if face.is_indirect else id(face)
                streams.setdefault(ident, face)
                rects.setdefault(ident, set()).add(rect)
    return [(streams[ident], next(iter(seen)))
            for ident, seen in rects.items() if len(seen) == 1]


def _rebase_appearances(output: Path) -> None:
    """Re-express every pattern-painting appearance in the page's own space."""
    with pikepdf.open(str(output), allow_overwriting_input=True) as pdf:
        rebased = False
        for stream, rect in _appearance_streams(pdf):
            if not _paints_through_pattern(stream):
                continue
            matrix = _appearance_matrix(stream, rect)
            if matrix is None:
                continue
            prefix = ("q " + " ".join(_real(v) for v in matrix) + " cm\n").encode("ascii")
            stream.write(prefix + bytes(stream.read_bytes()) + b"\nQ")
            stream["/BBox"] = pikepdf.Array(list(rect))
            stream["/Matrix"] = pikepdf.Array(list(IDENTITY))
            rebased = True
        if rebased:
            pdf.save(str(output))


def _ink_names(path: Path) -> list:
    from .separations import list_inks

    return [entry["name"] for entry in list_inks(str(path))["inks"]]


def _colour_report(source_inks, output_path: Path, rasterized, *streams) -> dict:
    """What the conversion cost the document's colorants, plus the producer's
    own diagnostics — the two halves `standards_report` builds a PDF/X report
    from, over the one fact a colour conversion can destroy."""
    rows = [
        row for row in (
            standards_report.colorant_shadings_lost(rasterized),
            standards_report.colorants_lost(source_inks, _ink_names(output_path)),
        ) if row is not None
    ]
    named, unmatched = standards_report.classify(standards_report.notices(*streams))
    report = {"altered": rows + named,
              "producer_notices": unmatched[:standards_report.NOTICE_CAP]}
    if len(unmatched) > standards_report.NOTICE_CAP:
        report["notices_truncated"] = True
    return report


def convert_cmyk(
    file: str,
    output: str,
    render_intent: str = "relative",
    dest_profile: str = "",
    gs_path: str = "gs",
) -> dict:
    """Convert a PDF's colour to DeviceCMYK using Ghostscript's ICC engine.

    Args:
        file: Input PDF path.
        output: Output PDF path.
        render_intent: perceptual | relative | saturation | absolute (the ICC
            rendering intent; default relative colorimetric — the prepress norm).
        dest_profile: Optional destination ICC profile — a .icc file path, or a
            bare gs ROM-filesystem profile name. Empty = gs's compiled default.
        gs_path: Path to the Ghostscript executable.
    """
    info = validate_pdf(file)
    intent = _RENDER_INTENTS.get(str(render_intent).strip().lower())
    if intent is None:
        raise ValueError(
            "render_intent must be perceptual, relative, saturation, or absolute."
        )

    input_path = Path(file)
    output_path = Path(output)
    _validate_dest_profile(dest_profile, gs_path)

    def command(source: Path) -> list:
        return [
            gs_path,
            "-sDEVICE=pdfwrite",
            "-dCompatibilityLevel=1.5",
            "-sColorConversionStrategy=CMYK",
            "-dProcessColorModel=/DeviceCMYK",
            # Both DEFAULT to true and both are load-bearing: setting either
            # false flattens every /Separation and /DeviceN paint on the page
            # to process in the same pass (measured control). An undeclared
            # default that the whole spot-colour path rests on is pinned here.
            "-dPreserveSeparation=true",
            "-dPreserveDeviceN=true",
            # Honour the chosen rendering intent for the ICC transform. NB: we do
            # NOT pass -dOverrideICC — that would REPLACE a source object's own
            # embedded ICC profile with gs's default, discarding the accurate source
            # colour description; honouring embedded profiles is the point of a
            # colour-managed conversion.
            f"-dRenderIntent={intent}",
            *_dest_profile_flag(dest_profile),
            # -dSAFER blocks the profile READ, so a destination profile given as a
            # path fails without an explicit permit — every path a file picker can
            # produce. A bare ROM-filesystem name is not a file and needs none.
            *_permit_profile_read(dest_profile),
            "-dNOPAUSE",
            "-dQUIET",
            "-dBATCH",
            "-dSAFER",
            # % is a gs filename template char (distill review).
            f"-sOutputFile={str(output_path).replace('%', '%%')}",
            str(source),
        ]

    def run(source: Path):
        # Derived budget (budget.run keeps the stdin isolation — gs must
        # never inherit the RPC pipe, the distill review's finding).
        outcome = budget.gs(command(source), what="Ghostscript (CMYK conversion)",
                            path=input_path, pages=info["pages"])
        if outcome.returncode != 0:
            raise RuntimeError(f"Ghostscript CMYK conversion failed: {outcome.stderr}")
        return outcome

    source_inks = _ink_names(input_path)
    scratch = Path(tempfile.mkdtemp(prefix="spectra-prepress-"))
    try:
        staged, claimed, rasterized, boxes = _stage_carve_out(
            input_path, scratch, annotations=True, forms=True)
        result = run(staged if staged is not None else input_path)
        rasterized = _after_restore(output_path, input_path, claimed, rasterized,
                                    annotations=True)
        forms_source = harvest_appearances(output_path, input_path,
                                           scratch, boxes, info["pages"])
        _rebase_appearances(output_path)
        # gs pdfwrite drops /AcroForm and every widget annotation — converting a
        # filled form would silently destroy it. Transplant the fields back onto
        # the regenerated pages (no-op for non-form files) — the same reattach
        # grayscale/compress do, from the file carrying the appearances the
        # producer just converted.
        reattach_forms_file(forms_source if forms_source is not None
                            else input_path, output_path)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    return {
        "output": str(output_path),
        "render_intent": str(render_intent).strip().lower(),
        "original_size": input_path.stat().st_size,
        "output_size": output_path.stat().st_size,
        **_colour_report(source_inks, output_path, rasterized,
                         result.stdout, result.stderr),
    }


# PDF/X targets: gs -dPDFX level → (GTS version we expect back, PDF level).
# X-3 is colour-managed (our conversion IS ICC-managed) and the default;
# X-1a is the CMYK-only legacy exchange target; X-4 allows transparency.
_PDFX_VERSIONS = {1: "1.3", 3: "1.3", 4: "1.6"}


def _ps_escape(s: str) -> str:
    return s.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def _extract_rom_profile(gs_path: str, name: str, dest_dir: Path) -> Path:
    """Copy a gs ROM-filesystem ICC profile (default_cmyk.icc and friends —
    compiled into the gs DLL) out to a real file, so it can be EMBEDDED as a
    PDF/X /DestOutputProfile. Probe-verified: a PostScript read/write loop
    under --permit-file-write; the result carries the 'acsp' ICC magic."""
    dest = dest_dir / name
    dest_ps = str(dest).replace("\\", "/")
    ps = (
        f"(%rom%iccprofiles/{name}) (r) file /in exch def "
        f"({_ps_escape(dest_ps)}) (w) file /out exch def "
        "{ in read { out exch write } { exit } ifelse } loop out closefile"
    )
    result = subprocess.run(
        [
            gs_path,
            "-dNODISPLAY",
            "-dBATCH",
            "-dNOPAUSE",
            "-q",
            f"--permit-file-write={dest_ps}",
            "-c",
            ps,
        ],
        capture_output=True,
        text=True,
        timeout=60,
        stdin=subprocess.DEVNULL,
    )
    if result.returncode != 0 or not dest.is_file():
        raise RuntimeError(
            f"Could not extract the bundled profile {name}: {result.stderr}"
        )
    return dest


def _pdfx_def_ps(
    version: int,
    condition: str,
    identifier: str,
    info: str,
    icc_path: str,
    trapped: str = DEFAULT_TRAPPED,
) -> str:
    """A customized PDFX_def.ps (the bundled template's contract, trimmed to
    our fixed choices): DOCINFO GTS_PDFXVersion per level, an OutputIntent
    with the given condition/identifier, and — when a profile file is given —
    the embedded /DestOutputProfile stream with /N 4 declared directly (our
    ColorConversionStrategy is ALWAYS CMYK, so the template's fragile
    N-detection block is unnecessary, exactly as its own comments advise).

    `/Trapped` is a CLAIM about the document, and the converter is entitled to
    make it only when the caller asserts it: converting colour neither adds a
    trap network nor proves the absence of one, so the default is `/Unknown`.
    """
    gts = {1: "PDF/X-1a:2001", 3: "PDF/X-3:2002", 4: "PDF/X-4"}[version]
    claim = str(trapped).strip().lstrip("/").capitalize()
    if claim not in TRAPPED_VALUES:
        allowed = ", ".join(TRAPPED_VALUES)
        raise ValueError(f"Trapped must be one of {allowed}.")
    lines = [
        "%!",
        f"[ /GTS_PDFXVersion ({gts}) /Trapped /{claim} /DOCINFO pdfmark",
    ]
    if icc_path:
        ps_path = _ps_escape(str(Path(icc_path)).replace("\\", "/"))
        lines += [
            "[/_objdef {icc_PDFX} /type /stream /OBJ pdfmark",
            "[{icc_PDFX} << /N 4 >> /PUT pdfmark",
            f"[{{icc_PDFX}} ({ps_path}) (r) file /PUT pdfmark",
        ]
    lines += [
        "[/_objdef {OutputIntent_PDFX} /type /dict /OBJ pdfmark",
        "[{OutputIntent_PDFX} <<",
        "  /Type /OutputIntent",
        "  /S /GTS_PDFX",
        f"  /OutputCondition ({_ps_escape(condition)})",
        f"  /Info ({_ps_escape(info) if info else 'none'})",
        f"  /OutputConditionIdentifier ({_ps_escape(identifier)})",
        "  /RegistryName (http://www.color.org)",
        *(["  /DestOutputProfile {icc_PDFX}"] if icc_path else []),
        ">> /PUT pdfmark",
        "[{Catalog} <</OutputIntents [ {OutputIntent_PDFX} ]>> /PUT pdfmark",
    ]
    return "\n".join(lines) + "\n"


def convert_pdfx(
    file: str,
    output: str,
    version: int = 3,
    dest_profile: str = "",
    condition: str = "Commercial and specialty printing",
    identifier: str = "CGATS TR001",
    info: str = "",
    gs_path: str = "gs",
    trapped: str = DEFAULT_TRAPPED,
) -> dict:
    """Produce a PDF/X print master with a real output intent (tail).

    The conversion runs CMYK (colour-managed, like convert_cmyk) and the
    output carries /GTS_PDFXVersion + a /GTS_PDFX /OutputIntents entry. With
    ``dest_profile`` (a .icc FILE) the profile is EMBEDDED as the intent's
    /DestOutputProfile and also drives the conversion itself
    (-sOutputICCProfile), so the pixels and the declared condition agree;
    without it, the intent names a registered characterization by
    ``identifier`` alone (PDF/X permits that for registry conditions).

    Deliberate non-carrier: like PDF/A, the output does NOT get the original's
    interactive form fields transplanted back — a PDF/X master is a print
    exchange file, and conformance limits interactive content (the same
    rationale recorded on the PDF/A converter).

    **The /GTS_PDFXVersion key is written by the preamble above, not earned by
    the conversion, so its presence proves nothing on its own.** Ghostscript
    retreats to ordinary PDF output when it meets content it cannot make
    conformant, and that retreat neither removes the key nor changes the exit
    status — it is stated once, on stderr. So the run is pinned to the policy
    that removes the offending content instead of abandoning the standard, a
    retreat announced anyway is a refusal, and ``altered`` reports what
    reaching conformance cost (see engine/standards_report.py).
    """
    validate_pdf(file)
    version = int(version)
    if version not in _PDFX_VERSIONS:
        raise ValueError("version must be 1 (X-1a), 3 (X-3), or 4 (X-4).")
    profile = str(dest_profile).strip()

    input_path = Path(file)
    output_path = Path(output)
    _validate_dest_profile(profile, gs_path)

    # Every scratch file this conversion writes lives here, and the user's
    # output directory is never written to except by Ghostscript's own
    # -sOutputFile. Extraction used to land the profile beside the output and
    # unlink it afterwards, which deleted a user's own default_cmyk.icc.
    scratch = Path(tempfile.mkdtemp(prefix="spectra-pdfx-"))
    try:
        if profile and not Path(profile).is_file():
            if "/" in profile or "\\" in profile:
                raise ValueError(f"Destination ICC profile not found: {profile}")
            # A bare gs ROM-filesystem name (default_cmyk.icc …): the EMBED
            # needs a real file, so copy it out of the DLL first.
            profile = str(_extract_rom_profile(gs_path, profile, scratch))

        source_facts = standards_report.census(input_path)
        source_inks = _ink_names(input_path)

        def_path = str(scratch / "pdfx-def.ps")
        with open(def_path, "w", encoding="ascii") as f:
            f.write(_pdfx_def_ps(version, condition, identifier, info, profile, trapped))

        def command(source: Path) -> list:
            return [
                gs_path,
                "-sDEVICE=pdfwrite",
                f"-dPDFX={version}" if version != 3 else "-dPDFX",
                f"-dCompatibilityLevel={_PDFX_VERSIONS[version]}",
                "-sColorConversionStrategy=CMYK",
                "-dProcessColorModel=/DeviceCMYK",
                # The same measured control convert_cmyk pins. It does not
                # decide the X-level's own constraints: X-4 keeps a /DeviceN
                # either way, X-1a and X-3 flatten one either way, and that
                # forced loss is reported by name rather than hidden.
                "-dPreserveSeparation=true",
                "-dPreserveDeviceN=true",
                *(_dest_profile_flag(profile)),
                # The def file READS the profile to embed it — -dSAFER blocks
                # that without an explicit permit (live test catch).
                *([f"--permit-file-read={profile}"] if profile else []),
                "-dNOPAUSE",
                "-dBATCH",
                "-dSAFER",
                # Without this the default policy keeps the offending content and
                # drops the standard, leaving the preamble's version key as the
                # only surviving claim.
                "-dPDFACompatibilityPolicy=1",
                f"-sOutputFile={str(output_path).replace('%', '%%')}",
                def_path,
                str(source),
            ]

        def run(source: Path):
            # Derived budget; the floor stays at this call's own 600 s.
            outcome = budget.gs(command(source), what="Ghostscript (PDF/X conversion)",
                                path=input_path, base=600.0)
            if outcome.returncode != 0:
                raise RuntimeError(f"Ghostscript PDF/X conversion failed: {outcome.stderr}")
            return outcome

        # No appearance is staged here: the conformance policy removes every
        # annotation on the page — every subtype, at every level (measured) —
        # so a staged appearance is staged into an object the producer then
        # deletes, and the restore would report a rasterization that did not
        # happen on top of the annotation loss the report already names. The
        # form staging is off for the same reason plus one more: this output is
        # a deliberate non-carrier of the original's fields (docstring), so
        # there is no reattach for a converted appearance to travel on.
        staged, claimed, rasterized, _boxes = _stage_carve_out(
            input_path, scratch, annotations=False)
        result = run(staged if staged is not None else input_path)
        rasterized = _after_restore(output_path, input_path, claimed, rasterized,
                                    annotations=False)
        _rebase_appearances(output_path)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    report = standards_report.build(
        source_facts, output_path, result.stdout, result.stderr
    )
    if standards_report.abandoned(report):
        said = "; ".join(
            entry["message"]
            for row in report["altered"]
            if row["kind"] == "conformance_abandoned"
            for entry in row["detail"]
        )
        output_path.unlink(missing_ok=True)
        raise RuntimeError(f"PDF/X conversion abandoned the standard: {said}")

    # A colorant loss is invisible to the structural census — the marks stay,
    # they simply print on the wrong plates — so the two ink lists are the
    # only evidence, and they lead the report.
    report["altered"] = [
        row for row in (
            standards_report.colorant_shadings_lost(rasterized),
            standards_report.colorants_lost(source_inks, _ink_names(output_path)),
        ) if row is not None
    ] + report["altered"]

    # The claim is checkable — check it (never ship a silent non-conformance).
    with pikepdf.open(output_path) as pdf:
        intents = pdf.Root.get("/OutputIntents")
        if intents is None or len(intents) == 0:
            raise RuntimeError("PDF/X output carries no /OutputIntents — conversion failed.")
        gts = str(pdf.docinfo.get("/GTS_PDFXVersion", ""))
        claimed = str(pdf.docinfo.get("/Trapped", "")).lstrip("/")

    return {
        "output": str(output_path),
        "pdfx_version": gts,
        "trapped": claimed,
        "embedded_profile": bool(profile),
        "original_size": input_path.stat().st_size,
        "output_size": output_path.stat().st_size,
        **report,
    }
