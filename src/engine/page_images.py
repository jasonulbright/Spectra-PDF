"""Page-image editing (Phase 7.1 — the first Edit slice).

Lists, deletes, replaces, and extracts IMAGE XObject placements on a page.
A "placement" is one `Do` draw of an image — the unit the user clicks. Ids
are the depth-first visit order of image draws (page stream first, forms
recursed at their `Do` position), so the lister and the rewriter agree by
construction: both walk in encounter order.

Edit semantics are strictly PER-PLACEMENT:
  - delete removes that one `Do`; a shared image XObject drawn elsewhere is
    untouched. Reachability cleanup is `_finalize_page_rewrite` (the
    redact.py recipe): qpdf's `remove_unreferenced_resources` GC plus an
    explicit drop of superseded original FORMS (which the GC leaves) — so
    deleted/replaced image bytes are genuinely absent from the output, not
    merely undrawn.
  - replace registers the new image under a NEW name and renames only that
    `Do` — other placements of the original keep the original. The
    placement CTM is preserved exactly: the new image draws into the old
    box (a different aspect ratio stretches; that is the documented v1
    behavior, matching the phase doc's "reuse the original placement CTM").
  - a placement INSIDE a Form XObject is edited on a COPY of that form
    (registered under a fresh name, only that draw's `Do` rewritten) — the
    `_redact_form` copy-on-edit pattern — so a form stamped on ten pages
    changes only where the user edited it.

Replacement sources (no new engine deps — the WEBVIEW is the decoder, this
module only embeds):
  - ``{"jpeg_path": ...}``: byte passthrough as /DCTDecode (zero quality
    loss). Grayscale and RGB JPEGs only; anything else (CMYK/progressive
    oddities the SOF scan can't bless) raises a specific error the renderer
    answers by re-sending decoded raw pixels.
  - ``{"raw_path": ..., "width": w, "height": h, "channels": 3|4}``: packed
    8-bit pixels from the renderer's canvas decode. channels=4 splits the
    alpha plane into an /SMask.

Inline images (BI/ID/EI) are NOT listed and never touched — they pass
through rewrites verbatim. Rare in modern PDFs; recorded as a v1 non-goal
in the phase doc.

Text-run editing (7.2) will consolidate this walker and redact.py's into
one shared interpreter; for this slice the graphics-state tracking is
deliberately duplicated (~40 lines, helpers imported) rather than churning
the security-critical redactor in a release-bound slice — see
docs/architecture/21-phase7-content-editing.md.
"""

import os
import shutil
import stat
import struct
import tempfile
import zlib
from pathlib import Path

import pikepdf
from pikepdf import Dictionary, Name

from engine.content_walk import GraphicsTextState
from engine.redact import (
    IDENTITY,
    MAX_FORM_DEPTH,
    _as_matrix,
    _bbox_of_rect_under_matrix,
    _copy_resources_for_write,
    _drop_replaced_forms,
    _lookup_xobject,
    _mat_mult,
    _resolve_resources,
)

# ── listing ───────────────────────────────────────────────────────────────


def _walk_placements(pdf, instructions, resources, base_ctm, depth, fallback_resources, out, nested):
    """Append one dict per image `Do` to `out`, in encounter order. State
    tracking is the shared GraphicsTextState (7.2 consolidation) — the same
    machine the rewriter's DFS order agreement is proven against."""
    state = GraphicsTextState(base_ctm)
    for instruction in instructions:
        operator = str(instruction.operator)
        operands = list(instruction.operands)
        if state.feed(operator, operands):
            continue
        if operator == "Do":
            name = str(operands[0]) if operands else None
            xobj = _lookup_xobject(name, resources, fallback_resources)
            subtype = str(xobj.get("/Subtype", "")) if xobj is not None else ""
            if xobj is not None and subtype == "/Image":
                x0, y0, x1, y1 = _bbox_of_rect_under_matrix(state.ctm, 1.0, 1.0)
                out.append(
                    {
                        "index": len(out),
                        "rect": [x0, y0, x1, y1],
                        # The FULL device CTM at this Do (the unit square [0,1]²
                        # maps to the page through it). C1's transform op needs
                        # it to build the delta cm; `rect` is just its bbox.
                        "matrix": list(state.ctm),
                        "name": name,
                        "nested": nested,
                        "native_width": int(xobj.get("/Width", 0)),
                        "native_height": int(xobj.get("/Height", 0)),
                    }
                )
            elif xobj is not None and subtype == "/Form" and depth < MAX_FORM_DEPTH:
                form_matrix = _as_matrix(xobj.get("/Matrix")) or IDENTITY
                form_res = xobj.get("/Resources")
                _walk_placements(
                    pdf,
                    pikepdf.parse_content_stream(xobj),
                    form_res if form_res is not None else resources,
                    _mat_mult(form_matrix, state.ctm),
                    depth + 1,
                    resources,
                    out,
                    True,
                )
    return out


def list_page_images(file: str, page: int) -> dict:
    """Image placements on 1-based `page`, in the id order every mutator
    below targets."""
    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        resources = _resolve_resources(p)
        placements: list[dict] = []
        _walk_placements(
            pdf, pikepdf.parse_content_stream(p), resources, IDENTITY, 0, None, placements, False
        )
        return {"page": int(page), "images": placements}


# ── targeted rewriting (delete / replace) ─────────────────────────────────


def _do_instruction(name: str):
    return pikepdf.ContentStreamInstruction([Name(name)], pikepdf.Operator("Do"))


def _op(operands, name: str):
    return pikepdf.ContentStreamInstruction(operands, pikepdf.Operator(name))


def _invert_matrix(m):
    """Inverse of a PDF affine matrix (a,b,c,d,e,f). Raises on a degenerate
    (det≈0) matrix — a placement collapsed to a line/point can't be inverted
    (and can't have been a real image draw)."""
    a, b, c, d, e, f = (float(v) for v in m)
    det = a * d - b * c
    if abs(det) < 1e-9:
        raise ValueError("image placement matrix is degenerate (not invertible)")
    return (
        d / det,
        -b / det,
        -c / det,
        a / det,
        (c * f - d * e) / det,
        (b * e - a * f) / det,
    )


class _EditState:
    """Mutable cursor shared across the recursive rewrite: counts image
    draws in the SAME order as the lister; applies the action at `target`."""

    def __init__(
        self, target: int, action: str, replacement_name: str | None, pending_image=None, delta=None
    ):
        self.target = target
        self.action = action  # 'delete' | 'replace' | 'transform'
        self.replacement_name = replacement_name
        self.pending_image = pending_image
        # 'transform' only: the delta matrix D injected as `q D cm Do Q` at the
        # target draw so the placement's effective CTM becomes the caller's M'.
        self.delta = delta
        self.seen = 0
        self.done = False
        self.deleted_name: str | None = None
        # Original form names whose Do was rewritten to a copy — their
        # entries must be DROPPED when nothing still draws them (qpdf's GC
        # removes orphaned images/fonts but LEAVES forms; without the drop
        # the superseded form keeps the "deleted" image bytes reachable —
        # review-caught, and redact.py's exact precedent).
        self.superseded_forms: set = set()


def _rewrite(pdf, instructions, resources, depth, fallback_resources, state, name_counter, reserved):
    """Return (kept_instructions, changed, new_forms). Recurses into forms;
    when the target draw lies inside one, the form is COPIED (fresh name,
    rewritten stream) and only this draw's Do is renamed to the copy.

    `new_forms` ({name: stream}) are copies created AT THIS LEVEL, for the
    CALLER to register into its own fresh resources — the redact.py
    new_forms pattern. Registering into the passed-in `resources` directly
    mutated the ENCLOSING form's ORIGINAL, shared resources for 2-level
    nesting (review-caught by object-identity trace: a letterhead form
    reused across pages gained stray edit-copy references)."""
    kept = []
    changed = False
    new_forms: dict = {}
    for instruction in instructions:
        operator = str(instruction.operator)
        operands = list(instruction.operands)
        if operator != "Do" or state.done:
            kept.append(instruction)
            continue
        name = str(operands[0]) if operands else None
        xobj = _lookup_xobject(name, resources, fallback_resources)
        subtype = str(xobj.get("/Subtype", "")) if xobj is not None else ""
        if xobj is not None and subtype == "/Image":
            if state.seen == state.target:
                state.done = True
                changed = True
                if state.action == "delete":
                    state.deleted_name = name
                    # drop the instruction
                elif state.action == "transform":
                    # Wrap the ORIGINAL draw in q/Q with the delta cm. The
                    # accumulated CTM at this point is exactly M_cur, so the
                    # pre-concatenated D makes the effective transform D·M_cur =
                    # M' at any nesting depth; the q/Q keeps the cm from leaking
                    # to later draws.
                    kept.append(_op([], "q"))
                    kept.append(_op([round(float(v), 6) for v in state.delta], "cm"))
                    kept.append(instruction)
                    kept.append(_op([], "Q"))
                else:
                    kept.append(_do_instruction(state.replacement_name))
            else:
                kept.append(instruction)
            state.seen += 1
        elif xobj is not None and subtype == "/Form" and depth < MAX_FORM_DEPTH:
            form_res = xobj.get("/Resources")
            read_res = form_res if form_res is not None else resources
            inner_kept, inner_changed, inner_new_forms = _rewrite(
                pdf,
                pikepdf.parse_content_stream(xobj),
                read_res,
                depth + 1,
                resources,
                state,
                name_counter,
                reserved,
            )
            if inner_changed:
                changed = True
                copy = pdf.make_stream(pikepdf.unparse_content_stream(inner_kept))
                # Rebuilt content is UNCOMPRESSED — never inherit /Filter or
                # /DecodeParms (the redact.py lesson); /Length is recomputed.
                for key in xobj.keys():
                    if key in ("/Length", "/Filter", "/DecodeParms", "/Resources"):
                        continue
                    copy[key] = xobj[key]
                copy_res = _copy_resources_for_write(pdf, read_res)
                # Deeper-level copies register into THIS copy's resources —
                # never into the original's (the staging rule above).
                for nm, st in inner_new_forms.items():
                    copy_res["/XObject"][Name(nm)] = pdf.make_indirect(st)
                if state.action == "replace" and state.replacement_name:
                    # The renamed Do resolves against the COPY's resources.
                    copy_res["/XObject"][Name(state.replacement_name)] = pdf.make_indirect(
                        state.pending_image
                    )
                copy["/Resources"] = copy_res
                new_name = _fresh_name(resources, name_counter, reserved)
                new_forms[new_name] = copy
                kept.append(_do_instruction(new_name))
                if name:
                    state.superseded_forms.add(name)
            else:
                kept.append(instruction)
        else:
            kept.append(instruction)
    return kept, changed, new_forms


def _fresh_name(resources, name_counter, reserved: set) -> str:
    """A name unused by `resources` AND by every allocation this op already
    made (`reserved`) — one op allocates from one counter+set, so the
    replacement-image name and any form-copy names can never collide even
    though registration happens later."""
    taken = set(reserved)
    xo = resources.get("/XObject") if resources is not None else None
    if xo is not None:
        taken |= {str(k) for k in xo.keys()}
    while True:
        name = f"/EditIm{name_counter[0]}"
        name_counter[0] += 1
        if name not in taken:
            reserved.add(name)
            return name


def _register_xobject(pdf, resources, name: str, obj) -> None:
    xo = resources.get("/XObject")
    if xo is None:
        xo = Dictionary()
        resources["/XObject"] = xo
    xo[Name(name)] = pdf.make_indirect(obj)


def _names_drawn(instructions) -> set:
    names = set()
    for instruction in instructions:
        if str(instruction.operator) == "Do" and instruction.operands:
            names.add(str(instruction.operands[0]))
    return names


def _finalize_page_rewrite(page, kept, superseded_forms: set) -> None:
    """Post-rewrite reachability cleanup — the redact.py recipe, exactly:
    `page.remove_unreferenced_resources()` (qpdf's real GC) drops orphaned
    image/font entries at every level, but LEAVES unreferenced Form
    XObjects in place, so a form whose Do was superseded by an edit copy is
    dropped explicitly — only when nothing in the rewritten stream still
    draws it, and only from the page's OWN /Resources (an inherited/shared
    dict is left intact: sibling pages may reference the original there).
    Once the form entry is gone its whole subtree — including a "deleted"
    image that lived only in the form's own resources — is unreachable and
    is not written on save."""
    page.remove_unreferenced_resources()
    if superseded_forms:
        own_res = page.obj.get("/Resources")
        if own_res is not None:
            _drop_replaced_forms(own_res.get("/XObject"), _names_drawn(kept), superseded_forms)


def _save(pdf, input_path: Path, output_path: Path) -> None:
    """Same save semantics as ocr_layer: identity-aware same-file takes
    temp+rename; a distinct read-only output is made writable first."""
    same_file = input_path.resolve() == output_path.resolve() or (
        output_path.exists() and os.path.samefile(input_path, output_path)
    )
    if same_file:
        with tempfile.NamedTemporaryFile(
            suffix=".pdf", delete=False, dir=str(input_path.parent)
        ) as tmp:
            tmp_path = tmp.name
        pdf.save(tmp_path)
        pdf.close()
        shutil.move(tmp_path, str(output_path))
    else:
        if output_path.exists() and not os.access(output_path, os.W_OK):
            os.chmod(output_path, stat.S_IWRITE)
        pdf.save(output_path)


def delete_page_image(file: str, output: str, page: int, index: int) -> dict:
    """Remove one image placement (per-placement — see module docstring)."""
    input_path = Path(file)
    output_path = Path(output)
    pdf = pikepdf.open(file)
    try:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        resources = _resolve_resources(p)
        count = len(
            _walk_placements(
                pdf, pikepdf.parse_content_stream(p), resources, IDENTITY, 0, None, [], False
            )
        )
        if not (0 <= int(index) < count):
            raise ValueError(f"image index {index} is out of range (page has {count})")

        state = _EditState(int(index), "delete", None)
        kept, changed, new_forms = _rewrite(
            pdf, pikepdf.parse_content_stream(p), resources, 0, None, state, [1], set()
        )
        if not changed:
            raise ValueError("edit did not apply (placement not found)")
        for nm, st in new_forms.items():
            _register_xobject(pdf, resources, nm, st)
        p.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
        _finalize_page_rewrite(p, kept, state.superseded_forms)
        _save(pdf, input_path, output_path)
        return {"output": str(output_path), "page": int(page), "index": int(index)}
    finally:
        try:
            pdf.close()
        except Exception:
            pass


def transform_page_image(file: str, output: str, page: int, index: int, matrix: list) -> dict:
    """Move/resize/rotate ONE image placement by rewriting the CTM at its Do
    (Phase 9.C1) — the image bytes are never touched.

    `matrix` is the DESIRED absolute placement matrix M' [a,b,c,d,e,f] in page
    user space — what `list_page_images` reports as `matrix` for this
    placement, after the canvas gesture. The op finds the placement's CURRENT
    device CTM M_cur (the same DFS walk the lister uses), computes the delta
    D = M'·M_cur⁻¹, and wraps the draw as `q D cm Do Q`, so the effective
    transform D·M_cur becomes M'. Per-placement like delete/replace: a shared
    XObject drawn elsewhere is untouched; a placement inside a form is
    transformed on a COPY of that form."""
    m_target = _as_matrix(matrix)
    if m_target is None:
        raise ValueError("matrix must be [a, b, c, d, e, f]")
    input_path = Path(file)
    output_path = Path(output)
    pdf = pikepdf.open(file)
    try:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        resources = _resolve_resources(p)
        placements = _walk_placements(
            pdf, pikepdf.parse_content_stream(p), resources, IDENTITY, 0, None, [], False
        )
        if not (0 <= int(index) < len(placements)):
            raise ValueError(
                f"image index {index} is out of range (page has {len(placements)})"
            )
        m_cur = tuple(placements[int(index)]["matrix"])
        delta = _mat_mult(m_target, _invert_matrix(m_cur))

        state = _EditState(int(index), "transform", None, delta=delta)
        kept, changed, new_forms = _rewrite(
            pdf, pikepdf.parse_content_stream(p), resources, 0, None, state, [1], set()
        )
        if not changed:
            raise ValueError("edit did not apply (placement not found)")
        for nm, st in new_forms.items():
            _register_xobject(pdf, resources, nm, st)
        p.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
        _finalize_page_rewrite(p, kept, state.superseded_forms)
        _save(pdf, input_path, output_path)
        return {"output": str(output_path), "page": int(page), "index": int(index)}
    finally:
        try:
            pdf.close()
        except Exception:
            pass


# ── replacement image construction ────────────────────────────────────────


def _jpeg_info(data: bytes) -> tuple[int, int, int]:
    """(width, height, components) from the SOF marker. Raises ValueError on
    anything that isn't a baseline/progressive JFIF this embedder blesses."""
    if len(data) < 4 or data[0:2] != b"\xff\xd8":
        raise ValueError("not a JPEG file")
    i = 2
    while i + 4 <= len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        # Collapse 0xFF fill runs — spec-legal padding before any marker
        # (T.81 B.1.1.2); reading a fill byte as the marker code misparsed
        # the following payload bytes as a segment length (review-caught).
        while i + 1 < len(data) and data[i + 1] == 0xFF:
            i += 1
        if i + 4 > len(data):
            break
        marker = data[i + 1]
        if marker in (0xC0, 0xC1, 0xC2):  # SOF0/1/2
            if i + 10 > len(data):
                raise ValueError("truncated JPEG (SOF cut short)")
            height, width = struct.unpack(">HH", data[i + 5 : i + 9])
            components = data[i + 9]
            return width, height, components
        if marker == 0xD8 or 0xD0 <= marker <= 0xD7:
            i += 2
            continue
        (seglen,) = struct.unpack(">H", data[i + 2 : i + 4])
        i += 2 + seglen
    raise ValueError("no SOF marker found (unsupported JPEG)")


def _image_from_source(pdf, source: dict):
    """Build the replacement image XObject (a pikepdf Stream) from either a
    passthrough JPEG or renderer-decoded raw pixels."""
    if "jpeg_path" in source:
        data = Path(source["jpeg_path"]).read_bytes()
        width, height, components = _jpeg_info(data)
        if components == 3:
            colorspace = Name("/DeviceRGB")
        elif components == 1:
            colorspace = Name("/DeviceGray")
        else:
            # The renderer answers this error by decoding to raw itself.
            raise ValueError(f"unsupported JPEG ({components} components); send raw pixels")
        stream = pdf.make_stream(data)
        stream["/Type"] = Name("/XObject")
        stream["/Subtype"] = Name("/Image")
        stream["/Width"] = width
        stream["/Height"] = height
        stream["/ColorSpace"] = colorspace
        stream["/BitsPerComponent"] = 8
        stream["/Filter"] = Name("/DCTDecode")
        return stream

    raw_path = source.get("raw_path")
    width = int(source.get("width", 0))
    height = int(source.get("height", 0))
    channels = int(source.get("channels", 0))
    if not raw_path or width <= 0 or height <= 0 or channels not in (3, 4):
        raise ValueError("raw source needs raw_path, width, height, channels in (3, 4)")
    data = Path(raw_path).read_bytes()
    expected = width * height * channels
    if len(data) != expected:
        raise ValueError(f"raw pixel data is {len(data)} bytes; expected {expected}")

    if channels == 4:
        # Strided slice assignment runs at C speed — a per-pixel Python loop
        # over a camera-sized image costs seconds.
        rgb = bytearray(width * height * 3)
        rgb[0::3] = data[0::4]
        rgb[1::3] = data[1::4]
        rgb[2::3] = data[2::4]
        pixel_bytes, alpha_bytes = bytes(rgb), bytes(data[3::4])
    else:
        pixel_bytes, alpha_bytes = data, None

    stream = pdf.make_stream(zlib.compress(pixel_bytes, 6))
    stream["/Type"] = Name("/XObject")
    stream["/Subtype"] = Name("/Image")
    stream["/Width"] = width
    stream["/Height"] = height
    stream["/ColorSpace"] = Name("/DeviceRGB")
    stream["/BitsPerComponent"] = 8
    stream["/Filter"] = Name("/FlateDecode")
    if alpha_bytes is not None:
        smask = pdf.make_stream(zlib.compress(alpha_bytes, 6))
        smask["/Type"] = Name("/XObject")
        smask["/Subtype"] = Name("/Image")
        smask["/Width"] = width
        smask["/Height"] = height
        smask["/ColorSpace"] = Name("/DeviceGray")
        smask["/BitsPerComponent"] = 8
        smask["/Filter"] = Name("/FlateDecode")
        stream["/SMask"] = pdf.make_indirect(smask)
    return stream


def replace_page_image(file: str, output: str, page: int, index: int, source: dict) -> dict:
    """Swap one placement's image for a new one (per-placement; CTM kept)."""
    input_path = Path(file)
    output_path = Path(output)
    pdf = pikepdf.open(file)
    try:
        image_obj = _image_from_source(pdf, source)
    except Exception:
        pdf.close()
        raise
    try:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        resources = _resolve_resources(p)
        count = len(
            _walk_placements(
                pdf, pikepdf.parse_content_stream(p), resources, IDENTITY, 0, None, [], False
            )
        )
        if not (0 <= int(index) < count):
            raise ValueError(f"image index {index} is out of range (page has {count})")
        name_counter = [0]
        reserved: set = set()
        state = _EditState(
            int(index), "replace", _fresh_name(resources, name_counter, reserved), image_obj
        )
        kept, changed, new_forms = _rewrite(
            pdf, pikepdf.parse_content_stream(p), resources, 0, None, state, name_counter, reserved
        )
        if not changed:
            raise ValueError("edit did not apply (placement not found)")
        for nm, st in new_forms.items():
            _register_xobject(pdf, resources, nm, st)
        p.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
        if state.replacement_name in _names_drawn(kept):
            _register_xobject(pdf, resources, state.replacement_name, image_obj)
        # The superseded ORIGINAL (image or form) must not stay embedded —
        # replace previously never pruned at all (review-caught): a replaced
        # image's full bytes rode along in every output forever.
        _finalize_page_rewrite(p, kept, state.superseded_forms)
        _save(pdf, input_path, output_path)
        return {"output": str(output_path), "page": int(page), "index": int(index)}
    finally:
        try:
            pdf.close()
        except Exception:
            pass


def add_page_image(file: str, output: str, page: int, rect: list, source: dict) -> dict:
    """Embed a NEW image at `rect` (Phase 9.C2) — pure authoring, no rewrite of
    existing content.

    `rect` is [x0, y0, x1, y1] in USER-space points (the drawn box). `source`
    is the SAME shape 7.1 replace takes ({jpeg_path} passthrough |
    {raw_path,width,height,channels} decoded), embedded by the SAME
    `_image_from_source`. The image is appended as `q <cm> /Name Do Q` with
    `cm` mapping the unit image square onto the box (stretch-to-box, replace's
    v1 rule), so the added image is an ORDINARY placement afterward —
    list/delete/replace/transform (C1) all see it with no special case."""
    try:
        x0, y0, x1, y1 = (float(v) for v in rect)
    except (TypeError, ValueError):
        raise ValueError("rect must be [x0, y0, x1, y1]") from None
    left, right = min(x0, x1), max(x0, x1)
    bottom, top = min(y0, y1), max(y0, y1)
    w, h = right - left, top - bottom
    if w < 1e-3 or h < 1e-3:
        raise ValueError("image box is too small")

    input_path = Path(file)
    output_path = Path(output)
    pdf = pikepdf.open(file)
    try:
        image_obj = _image_from_source(pdf, source)
    except Exception:
        pdf.close()
        raise
    try:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]

        # Register the XObject on a page-LOCAL /Resources so the draw lands on
        # THIS page only. QPDF flattens inherited /Resources onto every page's
        # OWN dict BY REFERENCE, so a page's "own" /Resources + /XObject is
        # frequently the SAME object shared with siblings (the shared-/Pages-
        # /Resources shape this targets, and review-confirmed even for pages
        # that already have an own dict). Registering directly would leak the
        # entry into every sibling — so copy-on-write a fresh /Resources with a
        # NEW /XObject (redact.py's `_copy_resources_for_write`, the module's
        # established guard); existing content still resolves against the
        # copied (shared-by-ref) entries, and `_fresh_name` avoids them all.
        res = _copy_resources_for_write(pdf, _resolve_resources(p))
        p.obj["/Resources"] = res
        name = _fresh_name(res, [0], set())
        _register_xobject(pdf, res, name, image_obj)

        cm = [round(w, 4), 0, 0, round(h, 4), round(left, 4), round(bottom, 4)]
        content = pikepdf.unparse_content_stream(
            [_op([], "q"), _op(cm, "cm"), _do_instruction(name), _op([], "Q")]
        )
        # Shield the EXISTING content in its own q/Q (the A2 lesson): a dangling
        # `cm` in prior content must not transform our appended draw.
        p.contents_add(b"q\n", prepend=True)
        p.contents_add(b"\nQ\n" + content, prepend=False)

        _save(pdf, input_path, output_path)
        return {"output": str(output_path), "page": int(page)}
    finally:
        try:
            pdf.close()
        except Exception:
            pass


def extract_page_image(file: str, page: int, index: int, output_prefix: str) -> dict:
    """Save one placement's image bytes out (placement-independent — the
    XObject's own encoded data; pikepdf picks the natural format)."""
    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        resources = _resolve_resources(p)
        placements: list[dict] = []
        _walk_placements(
            pdf, pikepdf.parse_content_stream(p), resources, IDENTITY, 0, None, placements, False
        )
        if not (0 <= int(index) < len(placements)):
            raise ValueError(f"image index {index} is out of range (page has {len(placements)})")
        target = placements[int(index)]

        # Re-walk to the owning xobject: the lister records the NAME and
        # nesting; resolve the actual object by replaying the same order.
        holder: list = []

        def _collect(instructions, res, depth, fallback):
            for instruction in instructions:
                if str(instruction.operator) != "Do" or not instruction.operands:
                    continue
                nm = str(instruction.operands[0])
                xobj = _lookup_xobject(nm, res, fallback)
                st = str(xobj.get("/Subtype", "")) if xobj is not None else ""
                if xobj is not None and st == "/Image":
                    holder.append(xobj)
                elif xobj is not None and st == "/Form" and depth < MAX_FORM_DEPTH:
                    fres = xobj.get("/Resources")
                    _collect(
                        pikepdf.parse_content_stream(xobj),
                        fres if fres is not None else res,
                        depth + 1,
                        res,
                    )

        _collect(pikepdf.parse_content_stream(p), resources, 0, None)
        xobj = holder[int(index)]
        image = pikepdf.PdfImage(xobj)
        out_path = image.extract_to(fileprefix=output_prefix)
        return {
            "output": out_path,
            "name": target["name"],
            "width": target["native_width"],
            "height": target["native_height"],
        }
