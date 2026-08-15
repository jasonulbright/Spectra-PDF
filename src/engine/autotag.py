"""Autotag — build a structure tree for an UNTAGGED PDF heuristically.

The Tags panel deliberately refuses to conjure a tree from nothing (an empty
manual tree helps no one); this op is the content-analysis half that makes a
first tree, which the panel and the Reading Order panel can then refine.

The heuristic works at the CONTENT-STREAM level, page by page:
  - every top-level BT..ET text block becomes one structure element, its
    role decided by the block's largest font size against the document's
    body size (>= 1.6x -> H1, >= 1.25x -> H2, else P);
  - a block SMALLER than the body size sitting wholly inside the page's top
    or bottom margin is a running head or a folio, and becomes an Artifact —
    a positive statement that the content is decoration, which is what keeps
    it out of a read-aloud. Both conditions are required: a title sits in the
    top margin too, and it is bigger than the body, not smaller;
  - every image XObject `Do` becomes a Figure;
  - the operators are wrapped in `/Role <</MCID n>> BDC ... EMC` marked
    content, elements reference the MCIDs, the page gets /StructParents and
    the root a matching /ParentTree — the full tagged-PDF wiring, so the
    result survives commits (struct-carry) and reads back through pdf.js.

Reading order is STREAM order by design: it is what an untagged file
actually has, and the Reading Order panel exists to fix it afterwards.

The body size is the size the document sets most of its TEXT in, weighted by
how many characters each block shows rather than by how many blocks there are.
A block count makes every block equal, so a page of one long paragraph, one
heading and one folio has a three-way tie — and a tie broken toward the
smallest size elects the folio as the body, which turns the actual body copy
into a heading. Characters are what "most of the document" means.

Honest limits (documented, not silent): font size is the raw `Tf` operand and
block position is the raw text-matrix translation (neither composes the CTM),
Form-XObject interiors are not descended into, and an ALREADY-TAGGED file is
refused — retagging is the Tags panel's judgment call, not a batch
heuristic's. Autotag names no figure: `/Alt` cannot be invented, and a figure
with placeholder alternate text is worse than one the checker reports.
"""

from pathlib import Path

import pikepdf

from engine.inplace import finish_staged, is_same_file, staging_target
from engine.pdf_save import save_pdf

_H1_RATIO = 1.6
_H2_RATIO = 1.25

# The band at each end of the page a running head or a folio sits in, as a
# fraction of page height.
_MARGIN_BAND = 0.06

_IMAGE_SUBTYPE = pikepdf.Name("/Image")

_SHOW_OPS = frozenset({"Tj", "TJ", "'", '"'})


def _is_tagged(pdf: pikepdf.Pdf) -> bool:
    return pikepdf.Name.StructTreeRoot in pdf.Root


def _image_xobject_names(page: pikepdf.Object) -> set[str]:
    """The /XObject resource names on this page that are raster images."""
    names: set[str] = set()
    resources = page.get(pikepdf.Name.Resources)
    if resources is None:
        return names
    xobjects = resources.get(pikepdf.Name.XObject)
    if xobjects is None:
        return names
    for name, xobj in xobjects.items():
        try:
            if xobj.get(pikepdf.Name.Subtype) == _IMAGE_SUBTYPE:
                names.add(str(name))
        except (AttributeError, TypeError):
            continue
    return names


class _Segment:
    """One taggable run of operators.

    `kind` is 'text' (one BT..ET block), 'figure' (one image Do) or 'other'
    (untouched glue). `chars` is how many characters the block shows — the
    weight its size carries in the body-size vote — and `top`/`bottom` are the
    text-matrix translation extremes, which is where the margin test reads.
    """

    __slots__ = ("kind", "ops", "size", "chars", "top", "bottom")

    def __init__(self, kind, ops, size=0.0, chars=0, top=None, bottom=None):
        self.kind = kind
        self.ops = ops
        self.size = size
        self.chars = chars
        self.top = top
        self.bottom = bottom


def _shown_chars(operands) -> int:
    """Characters a show operator paints, summed over its string operands."""
    total = 0
    for operand in operands:
        if isinstance(operand, pikepdf.String):
            try:
                total += len(bytes(operand))
            except Exception:
                continue
        elif isinstance(operand, pikepdf.Array):
            total += _shown_chars(list(operand))
    return total


def _segment_page(instructions, image_names):
    """Split a page's operators into taggable segments."""
    segments: list = []
    current_ops: list = []
    in_text = False
    text_ops: list = []
    max_size = 0.0
    chars = 0
    ty = 0.0
    leading = 0.0
    y_min = None
    y_max = None

    def note_y():
        nonlocal y_min, y_max
        y_min = ty if y_min is None else min(y_min, ty)
        y_max = ty if y_max is None else max(y_max, ty)

    def flush_other():
        nonlocal current_ops
        if current_ops:
            segments.append(_Segment("other", current_ops))
            current_ops = []

    def number(value) -> float:
        try:
            return float(value)
        except (TypeError, ValueError):
            return 0.0

    for operands, operator in instructions:
        op = str(operator)
        if op == "BT":
            flush_other()
            in_text = True
            text_ops = [(operands, operator)]
            max_size = 0.0
            chars = 0
            ty = 0.0
            leading = 0.0
            y_min = y_max = None
            continue
        if in_text:
            text_ops.append((operands, operator))
            if op == "Tf" and len(operands) >= 2:
                max_size = max(max_size, number(operands[1]))
            elif op == "Tm" and len(operands) >= 6:
                ty = number(operands[5])
            elif op in ("Td", "TD") and len(operands) >= 2:
                ty += number(operands[1])
                if op == "TD":
                    leading = -number(operands[1])
            elif op == "TL" and operands:
                leading = number(operands[0])
            elif op in ("T*", "'", '"'):
                # The two show-and-advance operators move to the next line
                # before they paint, exactly as T* does.
                ty -= leading
            if op in _SHOW_OPS:
                chars += _shown_chars(operands)
                note_y()
            if op == "ET":
                in_text = False
                segments.append(_Segment("text", text_ops, max_size, chars, y_max, y_min))
                text_ops = []
            continue
        if op == "Do" and operands and str(operands[0]) in image_names:
            flush_other()
            segments.append(_Segment("figure", [(operands, operator)]))
            continue
        current_ops.append((operands, operator))
    if in_text and text_ops:
        # Unbalanced BT with no ET — leave the fragment untouched.
        segments.append(_Segment("other", text_ops))
    flush_other()
    return segments


def _page_span(page) -> tuple:
    """(bottom, top) of the page box in user space. A box whose origin is not
    zero is why this returns COORDINATES and not a height — a margin test
    against a size would misplace every band on such a page."""
    for key in (pikepdf.Name.CropBox, pikepdf.Name.MediaBox):
        box = page.get(key)
        if box is None:
            continue
        try:
            values = [float(v) for v in box]
            return min(values[1], values[3]), max(values[1], values[3])
        except (TypeError, ValueError, IndexError):
            continue
    return 0.0, 792.0


def _in_margin(segment, span: tuple) -> bool:
    """Does this block sit wholly inside the top or the bottom margin band?"""
    bottom, top = span
    height = top - bottom
    if height <= 0 or segment.top is None or segment.bottom is None:
        return False
    band = height * _MARGIN_BAND
    if segment.bottom >= top - band:
        return True
    return segment.top <= bottom + band


def _role_for(segment, body_size: float, span: tuple) -> str:
    size = segment.size
    if body_size > 0 and size >= body_size * _H1_RATIO:
        return "H1"
    if body_size > 0 and size >= body_size * _H2_RATIO:
        return "H2"
    if body_size > 0 and 0 < size < body_size and _in_margin(segment, span):
        return "Artifact"
    return "P"


def autotag(file: str, output: str) -> dict:
    """Heuristically tag an untagged PDF. Returns a per-role tally."""
    output_path = Path(output)
    same_file = is_same_file(file, output)

    with pikepdf.open(file) as pdf:
        if _is_tagged(pdf):
            raise ValueError(
                "This document is already tagged. Refine its tags in the Tags "
                "panel instead of re-tagging automatically."
            )

        # Pass 1 — segment every page and find the document's body size (the
        # most common max-size across text blocks).
        per_page = []
        size_votes: dict[float, int] = {}
        for page in pdf.pages:
            image_names = _image_xobject_names(page.obj)
            instructions = pikepdf.parse_content_stream(page)
            segments = _segment_page(instructions, image_names)
            per_page.append(segments)
            for segment in segments:
                if segment.kind == "text" and segment.size > 0 and segment.chars > 0:
                    rounded = round(segment.size, 1)
                    size_votes[rounded] = size_votes.get(rounded, 0) + segment.chars
        body_size = 0.0
        if size_votes:
            # Most characters wins; a genuine tie goes to the LARGER size,
            # because electing the smaller one promotes the body copy to a
            # heading, and a document with no headings at all is the milder
            # wrong answer.
            body_size = max(size_votes.items(), key=lambda kv: (kv[1], kv[0]))[0]

        # Pass 2 — wrap segments in marked content, build elements + the
        # parent tree.
        root = pdf.make_indirect(
            pikepdf.Dictionary(Type=pikepdf.Name.StructTreeRoot)
        )
        doc_elem = pdf.make_indirect(
            pikepdf.Dictionary(
                Type=pikepdf.Name.StructElem,
                S=pikepdf.Name.Document,
                P=root,
            )
        )
        doc_kids = pikepdf.Array()
        parent_tree_nums = pikepdf.Array()
        tally = {"P": 0, "H1": 0, "H2": 0, "Figure": 0, "Artifact": 0}
        next_key = 0

        for page, segments in zip(pdf.pages, per_page):
            mcid = 0
            new_ops = []
            page_elems = pikepdf.Array()
            page_span = _page_span(page.obj)
            wrote_artifact = False
            for segment in segments:
                if segment.kind == "other":
                    new_ops.extend(segment.ops)
                    continue
                role = (
                    "Figure"
                    if segment.kind == "figure"
                    else _role_for(segment, body_size, page_span)
                )
                tally[role] += 1
                if role == "Artifact":
                    # An artifact carries no MCID and no element: it is a
                    # statement that this content is decoration, and the
                    # reverse mapping has nothing to point at.
                    new_ops.append(
                        ([pikepdf.Name("/Artifact")], pikepdf.Operator("BMC"))
                    )
                    new_ops.extend(segment.ops)
                    new_ops.append(([], pikepdf.Operator("EMC")))
                    wrote_artifact = True
                    continue
                new_ops.append(
                    (
                        [pikepdf.Name("/" + role), pikepdf.Dictionary(MCID=mcid)],
                        pikepdf.Operator("BDC"),
                    )
                )
                new_ops.extend(segment.ops)
                new_ops.append(([], pikepdf.Operator("EMC")))
                elem = pdf.make_indirect(
                    pikepdf.Dictionary(
                        Type=pikepdf.Name.StructElem,
                        S=pikepdf.Name("/" + role),
                        P=doc_elem,
                        Pg=page.obj,
                        K=mcid,
                    )
                )
                doc_kids.append(elem)
                page_elems.append(elem)
                mcid += 1
            if len(page_elems) == 0:
                # A page of nothing but running heads still gets its artifact
                # declarations written — that is the whole statement it makes.
                if wrote_artifact:
                    page.obj[pikepdf.Name.Contents] = pdf.make_stream(
                        pikepdf.unparse_content_stream(new_ops)
                    )
                continue
            new_content = pikepdf.unparse_content_stream(new_ops)
            page.obj[pikepdf.Name.Contents] = pdf.make_stream(new_content)
            page.obj[pikepdf.Name.StructParents] = next_key
            parent_tree_nums.append(next_key)
            parent_tree_nums.append(pdf.make_indirect(page_elems))
            next_key += 1

        if next_key == 0:
            raise ValueError(
                "Nothing taggable found — the document has no text blocks or "
                "images to build a structure from."
            )

        doc_elem[pikepdf.Name.K] = doc_kids
        root[pikepdf.Name.K] = doc_elem
        root[pikepdf.Name.ParentTree] = pdf.make_indirect(
            pikepdf.Dictionary(Nums=parent_tree_nums)
        )
        root[pikepdf.Name.ParentTreeNextKey] = next_key
        pdf.Root[pikepdf.Name.StructTreeRoot] = root
        pdf.Root[pikepdf.Name.MarkInfo] = pikepdf.Dictionary(Marked=True)

        if same_file:
            staged = staging_target(output_path)
            save_pdf(pdf, staged)
        else:
            save_pdf(pdf, output_path)

    if same_file:
        finish_staged(staged, output_path)

    return {
        "pages": next_key,
        "tagged": tally["P"] + tally["H1"] + tally["H2"] + tally["Figure"],
        "headings": tally["H1"] + tally["H2"],
        "paragraphs": tally["P"],
        "figures": tally["Figure"],
        "artifacts": tally["Artifact"],
    }
