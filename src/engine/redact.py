"""True content redaction: strip text and images under a region from the
actual content stream, then paint a black box over it — not just an overlay.

Approach (per page, per requested region):
  1. Walk the page's content stream, tracking the graphics state (CTM via
     q/Q/cm) and text state (Tm/Td/TD/T*/TL/Tf via BT..ET) closely enough to
     compute an approximate axis-aligned bounding box for every text-showing
     operator (Tj/TJ/'/") and every directly-placed raster image (Do).
     Text width is estimated the same way the frontend's own annotation
     appearance-stream writer does (~0.5em average advance) — pikepdf has no
     font-metrics API, and exact glyph widths aren't needed for redaction:
     over-including a sliver of intersecting text and dropping the whole
     instruction is the SAFE direction here (a false negative — text that
     should have been redacted but wasn't — is the dangerous failure mode
     for a redaction tool; a false positive just removes slightly more than
     asked).
  2. Any instruction whose bbox intersects ANY requested region on that page
     is dropped entirely from the rebuilt stream (not blanked, not made
     invisible — removed from the instruction list that gets re-serialized).
  3. Form XObjects (`Do` on a /Subtype /Form) whose PLACED /BBox intersects a
     region are descended into recursively: a redacted COPY of the form is
     built (intersecting text/images removed, orphaned image resources pruned
     from the copy so their bytes are genuinely gone), registered under a
     fresh name, and this page's `Do` is rewritten to the copy. The ORIGINAL
     form is left intact so other pages/placements that reference it are
     unaffected; it drops out of the saved file if nothing else references it.
  4. A black-filled rectangle is painted over each region on top of the
     rebuilt content, so the redaction is visually obvious even where no
     text/image actually needed stripping.
  5. Annotations whose /Rect intersects a region are removed from /Annots (a
     FreeText/stamp/etc. whose visible box overlaps the mark would otherwise
     survive — content-stream stripping never touches annotation appearances).
  6. `page.remove_unreferenced_resources()` drops the now-orphaned page-level
     image XObjects (and the original forms we replaced) so their bytes aren't
     just invisible but genuinely absent from the saved file.

Remaining limitations (documented; over-redaction, never under-redaction):
  - Word/char spacing (Tw/Tc) and exact glyph widths are not modeled in the
    width estimate — they only ever make real advances SMALLER than the ~0.5em
    heuristic, so omitting them errs wide (the safe direction). Horizontal
    scaling (Tz), which can make text WIDER, IS folded into the bbox.
  - Form-XObject recursion is depth-capped (MAX_FORM_DEPTH). Beyond the cap an
    intersecting `Do` is DROPPED WHOLE (over-redaction, safe) rather than left
    intact. Only reachable on pathological/cyclic nesting; real documents do
    not nest anywhere near that deep.
"""

import shutil
import tempfile
from pathlib import Path
from typing import NamedTuple, Optional

import pikepdf
from pikepdf import Name

from engine.pdf_tree import walk_inheritable

Matrix = tuple[float, float, float, float, float, float]
Rect = tuple[float, float, float, float]  # x0, y0, x1, y1, x0<x1, y0<y1

IDENTITY: Matrix = (1, 0, 0, 1, 0, 0)

# Rough Helvetica-ish average glyph advance, matching the heuristic already
# used for wrapping freetext/stamp appearance text in the frontend builder.
AVG_CHAR_ADVANCE_EM = 0.5

# Depth cap for Form-XObject recursion — only there to terminate on malformed
# cyclic forms; real documents never approach it.
MAX_FORM_DEPTH = 16


def _mat_mult(m1: Matrix, m2: Matrix) -> Matrix:
    """Compose two matrices for the convention p' = p * M: applying m1 then
    m2 to a point is equivalent to applying `_mat_mult(m1, m2)` once."""
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    return (
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    )


def _transform_point(m: Matrix, x: float, y: float) -> tuple[float, float]:
    a, b, c, d, e, f = m
    return (a * x + c * y + e, b * x + d * y + f)


def _bbox_of_rect_under_matrix(m: Matrix, w: float, h: float) -> Rect:
    corners = [_transform_point(m, x, y) for x, y in ((0, 0), (w, 0), (w, h), (0, h))]
    xs = [c[0] for c in corners]
    ys = [c[1] for c in corners]
    return (min(xs), min(ys), max(xs), max(ys))


def _bbox_of_corners_under_matrix(m: Matrix, x0: float, y0: float, x1: float, y1: float) -> Rect:
    """Device bbox of an arbitrary rect (origin not assumed at 0) under m —
    needed for a Form /BBox whose corners are not [0 0 w h]."""
    corners = [_transform_point(m, x, y) for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))]
    xs = [c[0] for c in corners]
    ys = [c[1] for c in corners]
    return (min(xs), min(ys), max(xs), max(ys))


def _normalize_rect(rect: list[float]) -> Rect:
    x0, y0, x1, y1 = rect
    return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


def _intersects(a: Rect, b: Rect) -> bool:
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def _intersects_any(bbox: Rect, regions: list[Rect]) -> bool:
    return any(_intersects(bbox, r) for r in regions)


def _as_matrix(arr) -> Optional[Matrix]:
    if arr is None:
        return None
    try:
        vals = [float(v) for v in arr]
    except (TypeError, ValueError):
        return None
    return tuple(vals) if len(vals) == 6 else None  # type: ignore[return-value]


def _text_show_strings(operator: str, operands: list) -> list[str]:
    """Extract the literal string operands of a text-showing operator, for a
    rough width estimate. TJ's array mixes strings and numeric kerning."""
    if operator in ("Tj", "'", '"'):
        return [str(operands[-1])] if operands else []
    if operator == "TJ":
        arr = operands[0] if operands else []
        try:
            return [str(el) for el in arr if not isinstance(el, (int, float))]
        except TypeError:
            # Malformed TJ (operand not an array) — treat as zero-width.
            return []
    return []


def _lookup_xobject(name, resources, fallback_resources):
    """Resolve a /Do XObject name against this stream's resources, then the
    invoker's resources as a lenient per-name fallback (a form whose own
    /Resources omits a single name). Returns the XObject or None."""
    if not name:
        return None
    for res in (resources, fallback_resources):
        if res is None:
            continue
        xod = res.get("/XObject")
        if xod is not None:
            obj = xod.get(Name(name))
            if obj is not None:
                return obj
    return None


def _resolve_resources(page: "pikepdf.Page"):
    """Resources are inheritable via the page tree — a page dict lacking its
    own /Resources takes it from the nearest ancestor /Pages node that has
    one (common output from generators that put a single shared /Resources
    on the /Pages node rather than duplicating it per page). `page.get` only
    ever sees the page's OWN dict, so relying on it alone silently treats
    such a page as having no XObjects at all — a false negative (an image
    that should have been redacted, wasn't), the one failure direction this
    module can't tolerate. The walk itself is shared with watermark.py via
    pdf_tree.walk_inheritable."""
    resources = walk_inheritable(page, "/Resources")
    return resources if resources is not None else {}


class WalkResult(NamedTuple):
    kept: list
    text_runs_removed: int
    images_removed: int
    dropped_image_names: set
    surviving_image_names: set
    new_forms: dict  # name(str) -> redacted form Stream to register in this scope
    replaced_form_names: set  # original form names whose Do was rewritten/dropped
    forms_dropped_at_cap: int  # intersecting form Dos dropped whole at the depth cap


def _do_instruction(name: str):
    return pikepdf.ContentStreamInstruction([Name(name)], pikepdf.Operator("Do"))


def _existing_xobject_names(resources) -> set:
    xo = resources.get("/XObject") if resources is not None else None
    return {str(k) for k in xo.keys()} if xo is not None else set()


def _new_form_name(name_counter: list, taken: set) -> str:
    while True:
        name = f"/RdxFm{name_counter[0]}"
        name_counter[0] += 1
        if name not in taken:
            taken.add(name)
            return name


def _walk(
    pdf: "pikepdf.Pdf",
    instructions,
    resources,
    regions: list[Rect],
    base_ctm: Matrix,
    depth: int,
    name_counter: list,
    base_font_size: float = 12.0,
    base_leading: float = 0.0,
    base_h_scale: float = 1.0,
    fallback_resources=None,
) -> WalkResult:
    """Redact one content-stream instruction list, recursing into Form
    XObjects. `base_ctm` is the device CTM in effect at the start of this
    stream (IDENTITY for a page; form-matrix∘Do-CTM for a form), so every
    computed bbox is in page/device space where `regions` live.
    `base_font_size`/`base_leading`/`base_h_scale` are the text-state values in
    effect at the invoking `Do` (text state is part of the graphics state a
    form inherits). `fallback_resources` are the invoker's resources, consulted
    for an XObject name a form's own /Resources omits (a lenient per-name
    fallback)."""
    ctm: Matrix = base_ctm
    # The graphics-state stack (q/Q) saves/restores the CTM AND text-state
    # parameters (font size, leading, horizontal scaling) — all elements of the
    # graphics state per the PDF spec. Restoring only the CTM would leave a
    # stale font size after a `q .. Tf .. Q`, under-sizing a later bbox → an
    # under-redaction leak.
    gstate_stack: list = []
    tm: Matrix = IDENTITY
    tlm: Matrix = IDENTITY
    font_size = base_font_size
    leading = base_leading
    h_scale = base_h_scale  # Th = Tz/100; horizontal text scaling

    kept: list = []
    text_runs_removed = 0
    images_removed = 0
    dropped_image_names: set = set()
    surviving_image_names: set = set()
    new_forms: dict = {}
    replaced_form_names: set = set()
    forms_dropped_at_cap = 0
    taken_names = _existing_xobject_names(resources)

    def next_line():
        nonlocal tm, tlm
        tlm = _mat_mult((1, 0, 0, 1, 0, -leading), tlm)
        tm = tlm

    for instruction in instructions:
        operator = str(instruction.operator)
        operands = list(instruction.operands)

        if operator == "q":
            gstate_stack.append((ctm, font_size, leading, h_scale))
            kept.append(instruction)
        elif operator == "Q":
            if gstate_stack:
                ctm, font_size, leading, h_scale = gstate_stack.pop()
            kept.append(instruction)
        elif operator == "cm":
            m = _as_matrix(operands)
            if m is not None:
                ctm = _mat_mult(m, ctm)
            kept.append(instruction)
        elif operator == "Tf":
            try:
                font_size = float(operands[-1])
            except (TypeError, ValueError, IndexError):
                pass
            kept.append(instruction)
        elif operator == "TL":
            try:
                leading = float(operands[0])
            except (TypeError, ValueError, IndexError):
                pass
            kept.append(instruction)
        elif operator == "Tz":
            try:
                h_scale = float(operands[0]) / 100.0
            except (TypeError, ValueError, IndexError):
                pass
            kept.append(instruction)
        elif operator == "BT":
            tm = IDENTITY
            tlm = IDENTITY
            kept.append(instruction)
        elif operator in ("Td", "TD"):
            try:
                tx, ty = float(operands[0]), float(operands[1])
            except (TypeError, ValueError, IndexError):
                kept.append(instruction)
            else:
                if operator == "TD":
                    leading = -ty
                tlm = _mat_mult((1, 0, 0, 1, tx, ty), tlm)
                tm = tlm
                kept.append(instruction)
        elif operator == "Tm":
            m = _as_matrix(operands)
            if m is not None:
                tm = m
                tlm = m
            kept.append(instruction)
        elif operator == "T*":
            next_line()
            kept.append(instruction)
        elif operator in ("Tj", "'", '"', "TJ"):
            # ' and " implicitly advance to the next line BEFORE showing.
            if operator in ("'", '"'):
                next_line()
            strings = _text_show_strings(operator, operands)
            raw_width = sum(len(s) for s in strings) * font_size * AVG_CHAR_ADVANCE_EM
            # Tz>100 (expanded text) makes the real rendered width WIDER than the
            # flat 0.5em estimate — fold it into the bbox so we still err wide
            # (Tz<100 only shrinks real glyphs, which the estimate already
            # over-covers, so never scale the bbox DOWN). The tm advance uses
            # the actual scale so subsequent runs stay positioned correctly.
            bbox_width = raw_width * max(h_scale, 1.0)
            combined = _mat_mult(tm, ctm)
            bbox = _bbox_of_rect_under_matrix(combined, max(bbox_width, 0.01), max(font_size, 0.01))
            if _intersects_any(bbox, regions):
                text_runs_removed += 1
            else:
                kept.append(instruction)
            # Advance the text matrix so subsequent same-line Tj/TJ calls
            # (common when a generator emits one call per word/run) don't
            # all collapse onto the same origin point.
            tm = _mat_mult((1, 0, 0, 1, raw_width * h_scale, 0), tm)
        elif operator == "Do":
            name = str(operands[0]) if operands else None
            xobj = _lookup_xobject(name, resources, fallback_resources)
            subtype = str(xobj.get("/Subtype", "")) if xobj is not None else ""

            if xobj is not None and subtype == "/Image":
                bbox = _bbox_of_rect_under_matrix(ctm, 1.0, 1.0)
                if _intersects_any(bbox, regions):
                    images_removed += 1
                    if name:
                        dropped_image_names.add(name)
                else:
                    if name:
                        surviving_image_names.add(name)
                    kept.append(instruction)
            elif xobj is not None and subtype == "/Form":
                form_matrix = _as_matrix(xobj.get("/Matrix")) or IDENTITY
                form_ctm = _mat_mult(form_matrix, ctm)
                bbox_arr = xobj.get("/BBox")
                placed = None
                if bbox_arr is not None:
                    try:
                        bx0, by0, bx1, by1 = (float(v) for v in bbox_arr)
                        placed = _bbox_of_corners_under_matrix(form_ctm, bx0, by0, bx1, by1)
                    except (TypeError, ValueError):
                        placed = None
                intersects = placed is None or _intersects_any(placed, regions)
                if not intersects:
                    kept.append(instruction)
                elif depth >= MAX_FORM_DEPTH:
                    # Past the recursion cap we cannot safely inspect the form,
                    # and it DOES overlap a region — drop the whole form draw
                    # (over-redaction, the secrecy-safe direction) rather than
                    # leak whatever it contains. Only reachable on pathological
                    # (e.g. cyclic) nesting; real documents never get here.
                    # Record it (counter + name to prune) so this counts as a
                    # real change: otherwise an all-zero WalkResult makes an
                    # enclosing _redact_form bottom-out and keep the pristine
                    # original, reverting redaction all the way up the branch.
                    forms_dropped_at_cap += 1
                    if name:
                        replaced_form_names.add(name)
                else:
                    copy, sub = _redact_form(
                        pdf, xobj, resources, regions, form_ctm, depth + 1, name_counter, font_size, leading, h_scale
                    )
                    if copy is not None:
                        new_name = _new_form_name(name_counter, taken_names)
                        new_forms[new_name] = copy
                        if name:
                            replaced_form_names.add(name)
                        kept.append(_do_instruction(new_name))
                        text_runs_removed += sub[0]
                        images_removed += sub[1]
                    else:
                        kept.append(instruction)
            else:
                # Non-image/non-form — pass through.
                kept.append(instruction)
        else:
            kept.append(instruction)

    return WalkResult(
        kept,
        text_runs_removed,
        images_removed,
        dropped_image_names,
        surviving_image_names,
        new_forms,
        replaced_form_names,
        forms_dropped_at_cap,
    )


def _referenced_xobject_names(instructions) -> set:
    return {
        str(ins.operands[0])
        for ins in instructions
        if str(ins.operator) == "Do" and ins.operands
    }


def _drop_replaced_forms(xobjects, referenced: set, replaced: set) -> None:
    """Delete the original form entries we rewrote to redacted copies, but only
    where no surviving Do still references them. Removing the last reference
    makes the original (secret-bearing) form unreachable, so it — and any image
    it alone held — is dropped on save. Erring toward removal is the
    secrecy-safe direction this module already commits to."""
    if xobjects is None:
        return
    for nm in replaced:
        if nm not in referenced and Name(nm) in xobjects:
            del xobjects[Name(nm)]


def _copy_resources_for_write(pdf: "pikepdf.Pdf", resources):
    """A fresh /Resources dict for a redacted form copy: /XObject is a NEW
    subdict (so pruning orphaned images / registering nested copies never
    touches the original form's resources); other entries (fonts, etc.) are
    shared by reference since we only read them."""
    new = pikepdf.Dictionary()
    if resources is not None:
        for key in resources.keys():
            new[key] = resources[key]
    src_xo = resources.get("/XObject") if resources is not None else None
    new_xo = pikepdf.Dictionary()
    if src_xo is not None:
        for key in src_xo.keys():
            new_xo[key] = src_xo[key]
    new["/XObject"] = new_xo
    return new


def _redact_form(pdf, form, parent_resources, regions, form_ctm, depth, name_counter, font_size=12.0, leading=0.0, h_scale=1.0):
    """Build a redacted COPY of a Form XObject, or return (None, None) if
    nothing inside it intersects a region (caller then keeps the original Do).
    `font_size`/`leading`/`h_scale` are the text state active at the invoking
    Do (forms inherit it). Returns (copy_stream, (text_removed, images_removed))."""
    form_res = form.get("/Resources")
    read_res = form_res if form_res is not None else parent_resources
    result = _walk(
        pdf,
        pikepdf.parse_content_stream(form),
        read_res,
        regions,
        form_ctm,
        depth,
        name_counter,
        base_font_size=font_size,
        base_leading=leading,
        base_h_scale=h_scale,
        fallback_resources=parent_resources,
    )
    if (
        result.text_runs_removed == 0
        and result.images_removed == 0
        and not result.new_forms
        and result.forms_dropped_at_cap == 0
    ):
        return None, None

    copy = pdf.make_stream(pikepdf.unparse_content_stream(result.kept))
    # make_stream stores the rebuilt content UNCOMPRESSED with no filter, so we
    # must NOT copy the original's /Filter or /DecodeParms — inheriting a
    # /FlateDecode over raw bytes yields a stream no reader can inflate,
    # corrupting the copy (and any legitimate content it was meant to keep).
    # /Length is likewise recomputed by pikepdf on write. /Resources is set
    # below from a pruned copy.
    for key in form.keys():
        if key in ("/Length", "/Filter", "/DecodeParms", "/Resources"):
            continue
        copy[key] = form[key]

    copy_res = _copy_resources_for_write(pdf, read_res)
    xo = copy_res["/XObject"]
    # Prune image XObjects whose only draws were removed — otherwise their
    # bytes stay reachable (a leak: "redacted" image still embedded).
    for orphan in result.dropped_image_names - result.surviving_image_names:
        if Name(orphan) in xo:
            del xo[Name(orphan)]
    # Drop original nested forms we replaced with redacted copies.
    _drop_replaced_forms(xo, _referenced_xobject_names(result.kept), result.replaced_form_names)
    # Register nested redacted-form copies produced one level down.
    for nm, st in result.new_forms.items():
        xo[Name(nm)] = st
    copy["/Resources"] = copy_res

    return copy, (result.text_runs_removed, result.images_removed)


def _annot_key(obj):
    """Identity key for an annotation object, so /Popup /Parent /IRT references
    can be matched against /Annots entries. Indirect objects key on objgen;
    the rare inline annotation falls back to Python identity."""
    try:
        if obj.is_indirect:
            num, gen = obj.objgen
            return ("i", num, gen)
    except Exception:
        pass
    return ("d", id(obj))


# Keys whose values can carry an annotation's visible/textual content.
_ANNOT_CONTENT_KEYS = ("/Contents", "/RC", "/DS", "/AP", "/T", "/Subj", "/CA", "/RT")


def _scrub_annotation(annot) -> None:
    """Strip content-bearing keys from a removed annotation object, so that any
    OTHER surviving reference to it (a structure-tree entry, an AcroForm field,
    a reference we didn't model) cannot expose what it held."""
    for key in _ANNOT_CONTENT_KEYS:
        try:
            if key in annot:
                del annot[key]
        except Exception:
            pass


def _annot_overlaps(annot, regions: list[Rect]) -> bool:
    try:
        rect = annot.get("/Rect")
    except Exception:
        return False
    if rect is None:
        return False
    try:
        r = _normalize_rect([float(v) for v in rect])
    except (TypeError, ValueError):
        return False
    return _intersects_any(r, regions)


def _strip_annotations(page: "pikepdf.Page", regions: list[Rect]) -> int:
    """Remove annotations whose /Rect intersects a region — and cascade to
    their companions (a /Popup, or an /IRT reply) which commonly sit at a
    non-overlapping /Rect but reference the removed annotation via /Parent or
    /IRT, keeping its (secret-bearing) object reachable if left behind.
    Removed objects are also content-scrubbed as a belt-and-suspenders against
    any reference we don't model. /Rect is in page user space, like `regions`."""
    annots = page.obj.get("/Annots")
    if annots is None:
        return 0
    entries = list(annots)
    present = {_annot_key(a) for a in entries}

    remove = {_annot_key(a) for a in entries if _annot_overlaps(a, regions)}
    if not remove:
        return 0

    # Cascade: pull in each removed annot's /Popup, and any entry whose /Parent
    # or /IRT resolves to something already slated for removal. Iterate to a
    # fixed point so reply-chains are fully collected.
    changed = True
    while changed:
        changed = False
        for a in entries:
            key = _annot_key(a)
            if key in remove:
                for companion_key in ("/Popup",):
                    try:
                        companion = a.get(companion_key)
                    except Exception:
                        companion = None
                    if companion is not None:
                        ck = _annot_key(companion)
                        if ck in present and ck not in remove:
                            remove.add(ck)
                            changed = True
                continue
            for ref_key in ("/Parent", "/IRT"):
                try:
                    ref = a.get(ref_key)
                except Exception:
                    ref = None
                if ref is not None and _annot_key(ref) in remove:
                    remove.add(key)
                    changed = True
                    break

    kept = []
    removed = 0
    for a in entries:
        if _annot_key(a) in remove:
            removed += 1
            _scrub_annotation(a)
        else:
            kept.append(a)
    if kept:
        page.obj["/Annots"] = pikepdf.Array(kept)
    else:
        del page.obj["/Annots"]
    return removed


def _redact_page(pdf: "pikepdf.Pdf", page: "pikepdf.Page", regions: list[Rect]) -> dict:
    resources = _resolve_resources(page)
    name_counter = [0]
    result = _walk(pdf, pikepdf.parse_content_stream(page), resources, regions, IDENTITY, 0, name_counter)

    new_bytes = pikepdf.unparse_content_stream(result.kept)
    overlay = b"".join(
        f"q 0 0 0 rg {r[0]} {r[1]} {r[2] - r[0]} {r[3] - r[1]} re f Q\n".encode("ascii")
        for r in regions
    )
    page.Contents = pdf.make_stream(new_bytes + b"\n" + overlay)

    # Register redacted form copies on this page's effective /Resources.
    if result.new_forms:
        xo = resources.get("/XObject")
        if xo is None:
            xo = pikepdf.Dictionary()
            resources["/XObject"] = xo
        for nm, st in result.new_forms.items():
            xo[Name(nm)] = st

    # remove_unreferenced_resources drops orphaned images/fonts but leaves
    # unreferenced FORM XObjects in place; explicitly drop the originals we
    # replaced so their (secret-bearing) bytes go unreachable. Only touch the
    # page's OWN /Resources — an inherited/shared dict is left intact because
    # sibling pages still legitimately reference the original there.
    if (result.dropped_image_names - result.surviving_image_names) or result.new_forms:
        page.remove_unreferenced_resources()
    own_res = page.obj.get("/Resources")
    if own_res is not None and result.replaced_form_names:
        _drop_replaced_forms(
            own_res.get("/XObject"),
            _referenced_xobject_names(result.kept),
            result.replaced_form_names,
        )

    annotations_removed = _strip_annotations(page, regions)

    return {
        "text_runs_removed": result.text_runs_removed,
        "images_removed": result.images_removed,
        "annotations_removed": annotations_removed,
    }


def redact(file: str, output: str, regions: list[dict]) -> dict:
    """Strip content under one or more rectangular regions and black them out.

    Args:
        file: Input PDF path.
        output: Output PDF path.
        regions: List of `{"page": <1-based int>, "rect": [x0, y0, x1, y1]}`,
            rect in the page's own /MediaBox point space (i.e. the same
            coordinate system the page's content stream already uses —
            callers are responsible for accounting for /Rotate themselves).
    """
    input_path = Path(file)
    output_path = Path(output)
    same_file = input_path.resolve() == output_path.resolve()

    by_page: dict[int, list[Rect]] = {}
    for region in regions:
        page_num = int(region["page"])
        by_page.setdefault(page_num, []).append(_normalize_rect(region["rect"]))

    stats = {"text_runs_removed": 0, "images_removed": 0, "annotations_removed": 0}
    pages_redacted = 0
    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        for page_num, rects in by_page.items():
            if not (1 <= page_num <= total):
                continue
            page_stats = _redact_page(pdf, pdf.pages[page_num - 1], rects)
            for key in stats:
                stats[key] += page_stats[key]
            pages_redacted += 1

        if same_file:
            with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False, dir=str(input_path.parent)) as tmp:
                tmp_path = tmp.name
            pdf.save(tmp_path)
        else:
            pdf.save(output_path)

    if same_file:
        shutil.move(tmp_path, str(output_path))

    return {
        "output": str(output_path),
        "pages_redacted": pages_redacted,
        "regions_applied": len(regions),
        **stats,
    }
