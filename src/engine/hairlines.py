"""Hairlines — the stroke widths that survive proofing and vanish on press.

**The measurement is the EFFECTIVE device width, `line_width × sqrt(|det CTM|)`,
never the raw `w` operand.** A `1 w` under a `0.1 0 0 0.1 0 0 cm` draws a
0.1 pt line; reading the operand alone would miss it, and writing the
replacement into the operand alone would over-correct it by ten. The fix
therefore writes `replacement / scale`, so the DEVICE width lands on the
replacement whatever the transform above it.

**`0 w` is a hairline unconditionally.** PDF defines it as the thinnest line
the device can draw — about 0.03 pt on an imagesetter — and a Ghostscript
round trip passes it through untouched while rewriting every other width, so
nothing downstream will ever fix it.

**An annotation border inverts the zero rule.** There a width of `0` means NO
border, not the thinnest one, so a zero is left exactly alone. What carries is
`/BS /W`, `/Border[2]`, and the strokes inside the appearance stream that is
what actually prints — which is where a widget's own border is drawn.

The rewrite wraps each hairline's operator run in `q … Q` with the corrected
`w` inside, so the correction reaches that object and nothing after it. A run
with graphics-state operators interleaved into it takes the setter at paint
time (where it beats an interleaved `w`) and replays the interleaved ops after
the closing `Q`, which is the same shape the vector restyle uses and the same
reason.
"""

from __future__ import annotations

from pathlib import Path

import pikepdf
from pikepdf import Array, Dictionary

from engine.content_walk import mat_mult
from engine.page_images import (
    _do_instruction,
    _drop_replaced_forms,
    _names_drawn,
    _op,
    _register_xobject,
    _save,
)
from engine.page_vectors import _interleaved_indices, _walk_vectors
from engine.redact import (
    IDENTITY,
    _as_matrix,
    _copy_resources_for_write,
    _lookup_xobject,
    _resolve_resources,
)
from engine.validate import validate_pdf

DEFAULT_THRESHOLD_PT = 0.25
DEFAULT_REPLACEMENT_PT = 0.25

# A stroke whose transform collapses to zero area paints nothing, so its
# "width" is not a width and correcting it would be inventing one.
_MIN_SCALE = 1e-9

# Painting operators that stroke. A fill has a `line_width` in the listing but
# no stroke to thin.
_STROKING = ("stroke", "fillstroke")


def is_hairline(raw_width: float, effective_pt: float, threshold_pt: float) -> bool:
    """`0 w` is a hairline whatever the threshold: the device draws it as thin
    as it can, which is thinner than any threshold a user can name. Every
    other stroke is judged on its EFFECTIVE width, not its operand."""
    if raw_width == 0:
        return True
    return effective_pt < threshold_pt


def validated_bounds(threshold_pt, replacement_pt) -> tuple[float, float]:
    """The two widths, or the refusal that says why they cannot both hold.

    A replacement below the threshold would leave behind exactly the hairline
    the run was asked to remove.
    """
    threshold = float(threshold_pt)
    replacement = float(replacement_pt)
    if threshold <= 0:
        raise ValueError("The hairline threshold must be greater than zero.")
    if replacement < threshold:
        raise ValueError(
            "The replacement width must be at least the hairline threshold, "
            "or the corrected strokes are still hairlines."
        )
    return threshold, replacement


# ── finding ────────────────────────────────────────────────────────────────


def _page_numbers(pdf, pages) -> list[int]:
    total = len(pdf.pages)
    if pages is None:
        return list(range(1, total + 1))
    wanted: list[int] = []
    for value in pages:
        number = int(value)
        if 1 <= number <= total and number not in wanted:
            wanted.append(number)
    return wanted


def _stroke_targets(pdf, page, threshold: float) -> tuple[list, list]:
    """(every painted stroke on the page, the hairlines among them)."""
    instructions = list(pikepdf.parse_content_stream(page))
    vectors = _walk_vectors(instructions, pdf=pdf, resources=_resolve_resources(page))
    hairlines = [
        v for v in vectors
        if v["kind"] in _STROKING
        and v.get("_scale", 0.0) > _MIN_SCALE
        and is_hairline(v["line_width"], v["effective_line_width"], threshold)
    ]
    return instructions, hairlines


def _public_stroke(entry) -> dict:
    return {
        "line_width": entry["line_width"],
        "effective_pt": entry["effective_line_width"],
        "scale": round(entry.get("_scale", 1.0), 6),
        "kind": entry["kind"],
        "nested": entry["nested"],
        "rect": entry["rect"],
    }


# ── annotation borders ─────────────────────────────────────────────────────


def _border_width(annot) -> tuple[float | None, str]:
    """The annotation's declared border width and which key declared it.

    `/BS /W` supersedes `/Border`; a value of `0` is NOT a hairline — the
    specification defines it as no border at all — and neither is an absent
    one, which means the default of 1 pt.
    """
    try:
        bs = annot.get("/BS")
        if bs is not None and bs.get("/W") is not None:
            return float(bs.get("/W")), "bs"
    except (TypeError, ValueError):
        pass
    try:
        border = annot.get("/Border")
        if border is not None and len(border) >= 3:
            return float(border[2]), "border"
    except (TypeError, ValueError, IndexError):
        pass
    return None, ""


def _set_border_width(annot, source: str, width: float) -> None:
    if source == "bs":
        annot["/BS"]["/W"] = width
        return
    border = annot["/Border"]
    values = [border[i] for i in range(len(border))]
    values[2] = width
    annot["/Border"] = Array(values)


def _appearance_matrix(annot, stream):
    """The form-space → page-space transform of one appearance stream.

    The stream's `/BBox` is mapped through its `/Matrix`, and the result is
    fitted to the annotation's `/Rect`. That composed transform is what scales
    a stroke inside the appearance, so it is what an effective width must be
    measured through.
    """
    matrix = _as_matrix(stream.get("/Matrix")) or IDENTITY
    try:
        bbox = [float(v) for v in stream.get("/BBox")]
        rect = [float(v) for v in annot.get("/Rect")]
    except (TypeError, ValueError):
        return matrix
    corners = [(bbox[0], bbox[1]), (bbox[2], bbox[1]), (bbox[2], bbox[3]), (bbox[0], bbox[3])]
    xs, ys = [], []
    for cx, cy in corners:
        xs.append(matrix[0] * cx + matrix[2] * cy + matrix[4])
        ys.append(matrix[1] * cx + matrix[3] * cy + matrix[5])
    bw, bh = max(xs) - min(xs), max(ys) - min(ys)
    rx0, ry0 = min(rect[0], rect[2]), min(rect[1], rect[3])
    rx1, ry1 = max(rect[0], rect[2]), max(rect[1], rect[3])
    sx = (rx1 - rx0) / bw if bw > _MIN_SCALE else 1.0
    sy = (ry1 - ry0) / bh if bh > _MIN_SCALE else 1.0
    fit = (sx, 0.0, 0.0, sy, rx0 - min(xs) * sx, ry0 - min(ys) * sy)
    return mat_mult(matrix, fit)


def _appearance_streams(annot):
    """Every appearance stream the annotation can present, with the `/AP`
    entry and state key needed to replace it in place."""
    try:
        ap = annot.get("/AP")
    except Exception:
        return []
    if ap is None:
        return []
    out = []
    for ap_key in list(ap.keys()):
        entry = ap[ap_key]
        if isinstance(entry, pikepdf.Stream):
            out.append((ap, ap_key, None, entry))
            continue
        try:
            states = list(entry.keys())
        except Exception:
            continue
        for state in states:
            candidate = entry[state]
            if isinstance(candidate, pikepdf.Stream):
                out.append((ap, ap_key, state, candidate))
    return out


# ── the rewrite ────────────────────────────────────────────────────────────


class _Namer:
    """Fresh XObject names for the copies a fix registers. One counter for the
    whole run, so two copies never collide even across nesting levels."""

    def __init__(self):
        self.next = 0

    def take(self, resources) -> str:
        existing: set = set()
        xo = resources.get("/XObject") if resources is not None else None
        if xo is not None:
            try:
                existing = {str(k) for k in xo.keys()}
            except AttributeError:
                existing = set()
        while f"/FixHair{self.next}" in existing:
            self.next += 1
        name = f"/FixHair{self.next}"
        self.next += 1
        return name


def _by_chain(targets) -> dict:
    """Targets grouped by the form chain they live in, with every ancestor
    chain present so a node can find its children."""
    nodes: dict[tuple, list] = {}
    for entry in targets:
        chain = tuple((str(name), int(idx)) for name, idx in entry["_do_chain"])
        nodes.setdefault(chain, []).append(entry)
    for chain in list(nodes):
        for cut in range(len(chain)):
            nodes.setdefault(chain[:cut], [])
    return nodes


def _child_chains(nodes, chain) -> list:
    depth = len(chain)
    return sorted(c for c in nodes if len(c) == depth + 1 and c[:depth] == chain)


def _width_op(entry, replacement: float):
    """The `w` this object needs so its DEVICE width is the replacement."""
    scale = float(entry.get("_scale", 1.0)) or 1.0
    return _op([round(replacement / scale, 6)], "w")


def _rewrite_level(pdf, nodes, chain, instrs, scope, replacement, namer, applied):
    """(new instruction list, COW'd resources or None) for one stream.

    Children are rewritten first, on copies registered under fresh names, so a
    form stamped somewhere else keeps drawing what it always drew.
    """
    resources = None
    replace_at: dict[int, object] = {}
    superseded: set = set()
    for child in _child_chains(nodes, chain):
        name, do_idx = child[-1]
        form = _lookup_xobject(name, scope, scope)
        if form is None or str(form.get("/Subtype", "")) != "/Form":
            raise ValueError("The form a hairline is drawn in could not be found.")
        copy = _rewrite_form(pdf, nodes, child, form, scope, replacement, namer, applied)
        if resources is None:
            resources = _copy_resources_for_write(pdf, scope)
        fresh = namer.take(resources)
        _register_xobject(pdf, resources, fresh, copy)
        replace_at[do_idx] = _do_instruction(fresh)
        superseded.add(name)

    heads: dict[int, list] = {}
    tails: dict[int, tuple] = {}
    for entry in nodes.get(chain, []):
        drop = entry["drop_idxs"]
        first, last = drop[0], drop[-1]
        contiguous = drop == list(range(first, last + 1))
        interleaved = _interleaved_indices(instrs, drop)
        width = _width_op(entry, replacement)
        heads.setdefault(first, []).append(width if contiguous else None)
        tails[last] = (interleaved, None if contiguous else width)

    kept: list = []
    for index, instruction in enumerate(instrs):
        head = heads.get(index)
        if head is not None:
            kept.append(_op([], "q"))
            for setter in head:
                if setter is not None:
                    kept.append(setter)
        tail = tails.get(index)
        if tail is not None and tail[1] is not None:
            # An interleaved run takes its setter at PAINT time, where it beats
            # a `w` the producer set inside the run; a setter at the wrap head
            # would silently lose to it.
            kept.append(tail[1])
        kept.append(replace_at.get(index, instruction))
        if tail is not None:
            kept.append(_op([], "Q"))
            for j in tail[0]:
                kept.append(instrs[j])
    applied[0] += len(nodes.get(chain, []))
    if resources is not None and superseded:
        _drop_replaced_forms(resources.get("/XObject"), _names_drawn(kept), superseded)
    return kept, resources


def _rewrite_form(pdf, nodes, chain, form, scope, replacement, namer, applied):
    """A COPY of `form` with its own hairlines fixed and its children rebound."""
    own = form.get("/Resources")
    inner_scope = own if own is not None else scope
    instrs = list(pikepdf.parse_content_stream(form))
    kept, resources = _rewrite_level(
        pdf, nodes, chain, instrs, inner_scope, replacement, namer, applied
    )
    stream = pdf.make_stream(pikepdf.unparse_content_stream(kept))
    for key in form.keys():
        # A BLOCKLIST, not an allowlist: an allowlist silently drops keys the
        # copy needs, such as `/OC` layer membership.
        if str(key) in ("/Length", "/Filter", "/DecodeParms"):
            continue
        stream[key] = form[key]
    if resources is not None:
        stream["/Resources"] = resources
    return pdf.make_indirect(stream)


def _fix_page(pdf, page, instructions, targets, replacement, namer) -> int:
    applied = [0]
    nodes = _by_chain(targets)
    scope = _resolve_resources(page)
    kept, resources = _rewrite_level(
        pdf, nodes, (), instructions, scope, replacement, namer, applied
    )
    page.Contents = pdf.make_stream(pikepdf.unparse_content_stream(kept))
    if resources is not None:
        page.obj["/Resources"] = resources
    return applied[0]


def _fix_appearance(pdf, annot, holder, ap_key, state, stream, threshold, replacement, namer):
    """Fix the hairline strokes inside one appearance stream, on a COPY.

    The copy matters: an appearance stream can be shared between annotations
    whose `/Rect` differ, and the same operand under two different fits is two
    different device widths.
    """
    ctm = _appearance_matrix(annot, stream)
    own = stream.get("/Resources")
    instrs = list(pikepdf.parse_content_stream(stream))
    vectors = _walk_vectors(instrs, pdf=pdf, resources=own, base_ctm=ctm)
    targets = [
        v for v in vectors
        if v["kind"] in _STROKING
        and v.get("_scale", 0.0) > _MIN_SCALE
        and is_hairline(v["line_width"], v["effective_line_width"], threshold)
    ]
    if not targets:
        return 0, []
    applied = [0]
    nodes = _by_chain(targets)
    kept, resources = _rewrite_level(
        pdf, nodes, (), instrs, own, replacement, namer, applied
    )
    copy = pdf.make_stream(pikepdf.unparse_content_stream(kept))
    for key in stream.keys():
        if str(key) in ("/Length", "/Filter", "/DecodeParms"):
            continue
        copy[key] = stream[key]
    if resources is not None:
        copy["/Resources"] = resources
    indirect = pdf.make_indirect(copy)
    if state is None:
        holder[ap_key] = indirect
        return applied[0], [_public_stroke(v) for v in targets]
    # The state sub-dictionary can be shared too, so it is copied for the same
    # reason the stream is: rebinding one annotation's `/Off` must not rebind
    # another annotation's.
    fresh = Dictionary()
    for key in holder[ap_key].keys():
        fresh[key] = holder[ap_key][key]
    fresh[state] = indirect
    holder[ap_key] = fresh
    return applied[0], [_public_stroke(v) for v in targets]


# ── the two operations ─────────────────────────────────────────────────────


def list_hairlines(
    file: str,
    threshold_pt: float = DEFAULT_THRESHOLD_PT,
    pages: list | None = None,
    include_annotations: bool = True,
) -> dict:
    """Report every stroke thinner than `threshold_pt` on the device.

    Args:
        file: Input PDF path.
        threshold_pt: The width at or above which a stroke is safe, in points.
        pages: 1-based page numbers; None = every page.
        include_annotations: Also report annotation border widths and the
            strokes inside annotation appearance streams.

    The count and the width histogram are what the panel shows BEFORE the fix
    runs, so "how many strokes, at what widths" is answered by measurement
    rather than by running the change and seeing what happened.
    """
    threshold = float(threshold_pt)
    if threshold <= 0:
        raise ValueError("The hairline threshold must be greater than zero.")
    validate_pdf(file)

    rows: list[dict] = []
    histogram: dict[float, int] = {}
    strokes = 0
    borders = 0
    with pikepdf.open(file) as pdf:
        for number in _page_numbers(pdf, pages):
            page = pdf.pages[number - 1]
            row: dict = {"page": number, "strokes": [], "annotations": [], "error": None}
            try:
                _instructions, targets = _stroke_targets(pdf, page, threshold)
            except Exception as exc:
                # A page whose content stream cannot be parsed is reported and
                # the run continues: one broken page never sinks a document
                # report.
                row["error"] = str(exc)
                rows.append(row)
                continue
            for entry in targets:
                row["strokes"].append(_public_stroke(entry))
                key = round(entry["effective_line_width"], 3)
                histogram[key] = histogram.get(key, 0) + 1
            strokes += len(targets)

            if include_annotations:
                annots = page.obj.get("/Annots")
                for index, annot in enumerate(list(annots) if annots is not None else []):
                    try:
                        width, source = _border_width(annot)
                    except Exception:
                        continue
                    subtype = str(annot.get("/Subtype", ""))
                    if width is not None and width != 0 and width < threshold:
                        row["annotations"].append({
                            "index": index, "subtype": subtype,
                            "source": source, "width_pt": width,
                        })
                        borders += 1
                        histogram[round(width, 3)] = histogram.get(round(width, 3), 0) + 1
                    for _holder, _ap_key, _state, stream in _appearance_streams(annot):
                        try:
                            ctm = _appearance_matrix(annot, stream)
                            vectors = _walk_vectors(
                                list(pikepdf.parse_content_stream(stream)),
                                pdf=pdf, resources=stream.get("/Resources"), base_ctm=ctm,
                            )
                        except Exception:
                            continue
                        for entry in vectors:
                            if entry["kind"] not in _STROKING:
                                continue
                            if entry.get("_scale", 0.0) <= _MIN_SCALE:
                                continue
                            if not is_hairline(entry["line_width"],
                                               entry["effective_line_width"], threshold):
                                continue
                            row["annotations"].append({
                                "index": index, "subtype": subtype,
                                "source": "appearance",
                                "width_pt": entry["effective_line_width"],
                            })
                            borders += 1
                            key = round(entry["effective_line_width"], 3)
                            histogram[key] = histogram.get(key, 0) + 1
            rows.append(row)

    return {
        "threshold_pt": threshold,
        "count": strokes + borders,
        "stroke_count": strokes,
        "annotation_count": borders,
        "widths": [{"effective_pt": w, "count": n} for w, n in sorted(histogram.items())],
        "pages": rows,
    }


def fix_hairlines(
    file: str,
    output: str,
    threshold_pt: float = DEFAULT_THRESHOLD_PT,
    replacement_pt: float = DEFAULT_REPLACEMENT_PT,
    pages: list | None = None,
    include_annotations: bool = True,
) -> dict:
    """Raise every hairline to `replacement_pt` of DEVICE width.

    Args:
        file: Input PDF path.
        output: Output PDF path (may equal the input).
        threshold_pt: The width below which a stroke counts as a hairline.
        replacement_pt: The device width a corrected stroke lands on. It may
            not be below the threshold, or the correction leaves a hairline.
        pages: 1-based page numbers; None = every page.
        include_annotations: Also raise annotation border widths and the
            strokes inside annotation appearance streams.

    The written operand is `replacement / sqrt(|det CTM|)`, not the
    replacement itself: what a press sees is the device width, and a stroke
    under a scaled transform would otherwise land somewhere else entirely.
    """
    threshold, replacement = validated_bounds(threshold_pt, replacement_pt)
    validate_pdf(file)

    input_path = Path(file)
    output_path = Path(output)
    namer = _Namer()
    fixed_strokes = 0
    fixed_borders = 0
    rows: list[dict] = []

    pdf = pikepdf.open(file)
    try:
        for number in _page_numbers(pdf, pages):
            page = pdf.pages[number - 1]
            row: dict = {"page": number, "strokes": 0, "annotations": 0, "error": None}
            try:
                instructions, targets = _stroke_targets(pdf, page, threshold)
                if targets:
                    row["strokes"] = _fix_page(
                        pdf, page, instructions, targets, replacement, namer
                    )
            except Exception as exc:
                row["error"] = str(exc)
                rows.append(row)
                continue
            fixed_strokes += row["strokes"]

            if include_annotations:
                annots = page.obj.get("/Annots")
                for annot in list(annots) if annots is not None else []:
                    try:
                        width, source = _border_width(annot)
                        if width is not None and width != 0 and width < threshold:
                            _set_border_width(annot, source, replacement)
                            row["annotations"] += 1
                        for holder, ap_key, state, stream in _appearance_streams(annot):
                            count, _found = _fix_appearance(
                                pdf, annot, holder, ap_key, state, stream,
                                threshold, replacement, namer,
                            )
                            row["annotations"] += count
                    except Exception as exc:
                        row["error"] = str(exc)
                fixed_borders += row["annotations"]
            rows.append(row)

        _save(pdf, input_path, output_path)
    finally:
        try:
            pdf.close()
        except Exception:
            pass

    return {
        "output": str(output_path),
        "threshold_pt": threshold,
        "replacement_pt": replacement,
        "fixed": fixed_strokes + fixed_borders,
        "fixed_strokes": fixed_strokes,
        "fixed_annotations": fixed_borders,
        "pages": rows,
    }


def hairline_check(file: str, threshold_pt: float = DEFAULT_THRESHOLD_PT) -> dict:
    """The preflight row: how many hairlines, and the thinnest one found.

    Preflight is the reporter of print-readiness, and a hairline is a
    print-readiness failure that no proof shows.
    """
    try:
        report = list_hairlines(file, threshold_pt=threshold_pt)
    except Exception:
        return {"count": 0, "thinnest_pt": None, "threshold_pt": float(threshold_pt)}
    widths = [row["effective_pt"] for row in report["widths"]]
    return {
        "count": report["count"],
        "thinnest_pt": min(widths) if widths else None,
        "threshold_pt": report["threshold_pt"],
    }
