"""Autotag (P20) — build a structure tree for an UNTAGGED PDF heuristically.

The Tags panel deliberately refuses to conjure a tree from nothing (an empty
manual tree helps no one); this op is the content-analysis half that makes a
first tree, which the panel and the Reading Order panel can then refine.

The heuristic works at the CONTENT-STREAM level, page by page:
  - every top-level BT..ET text block becomes one structure element, its
    role decided by the block's largest font size against the document's
    body size (>= 1.6x -> H1, >= 1.25x -> H2, else P);
  - every image XObject `Do` becomes a Figure;
  - the operators are wrapped in `/Role <</MCID n>> BDC ... EMC` marked
    content, elements reference the MCIDs, the page gets /StructParents and
    the root a matching /ParentTree — the full tagged-PDF wiring, so the
    result survives commits (struct-carry) and reads back through pdf.js.

Reading order is STREAM order by design: it is what an untagged file
actually has, and the Reading Order panel exists to fix it afterwards.

Honest limits (documented, not silent): font size is the raw `Tf` operand
(text-matrix scale is not composed), Form-XObject interiors are not
descended into, and an ALREADY-TAGGED file is refused — retagging is the
Tags panel's judgment call, not a batch heuristic's.
"""

from pathlib import Path

import pikepdf

from engine.inplace import finish_staged, is_same_file, staging_target

_H1_RATIO = 1.6
_H2_RATIO = 1.25

_IMAGE_SUBTYPE = pikepdf.Name("/Image")


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


def _segment_page(instructions, image_names):
    """Split a page's operators into taggable segments.

    Returns a list of (kind, ops, max_font_size) where kind is 'text' (one
    BT..ET block), 'figure' (one image Do), or 'other' (untouched glue).
    """
    segments = []
    current_ops = []
    in_text = False
    text_ops = []
    max_size = 0.0
    font_size = 0.0

    def flush_other():
        nonlocal current_ops
        if current_ops:
            segments.append(("other", current_ops, 0.0))
            current_ops = []

    for operands, operator in instructions:
        op = str(operator)
        if op == "BT":
            flush_other()
            in_text = True
            text_ops = [(operands, operator)]
            max_size = 0.0
            continue
        if in_text:
            text_ops.append((operands, operator))
            if op == "Tf" and len(operands) >= 2:
                try:
                    font_size = float(operands[1])
                except (TypeError, ValueError):
                    font_size = 0.0
                max_size = max(max_size, font_size)
            if op == "ET":
                in_text = False
                segments.append(("text", text_ops, max_size))
                text_ops = []
            continue
        if op == "Do" and operands and str(operands[0]) in image_names:
            flush_other()
            segments.append(("figure", [(operands, operator)], 0.0))
            continue
        current_ops.append((operands, operator))
    if in_text and text_ops:
        # Unbalanced BT with no ET — leave the fragment untouched.
        segments.append(("other", text_ops, 0.0))
    flush_other()
    return segments


def _role_for(size: float, body_size: float) -> str:
    if body_size > 0 and size >= body_size * _H1_RATIO:
        return "H1"
    if body_size > 0 and size >= body_size * _H2_RATIO:
        return "H2"
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
            for kind, _ops, size in segments:
                if kind == "text" and size > 0:
                    rounded = round(size, 1)
                    size_votes[rounded] = size_votes.get(rounded, 0) + 1
        body_size = 0.0
        if size_votes:
            body_size = max(size_votes.items(), key=lambda kv: (kv[1], -kv[0]))[0]

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
        tally = {"P": 0, "H1": 0, "H2": 0, "Figure": 0}
        next_key = 0

        for page, segments in zip(pdf.pages, per_page):
            mcid = 0
            new_ops = []
            page_elems = pikepdf.Array()
            for kind, ops, size in segments:
                if kind == "other":
                    new_ops.extend(ops)
                    continue
                role = "Figure" if kind == "figure" else _role_for(size, body_size)
                tally[role] += 1
                new_ops.append(
                    (
                        [pikepdf.Name("/" + role), pikepdf.Dictionary(MCID=mcid)],
                        pikepdf.Operator("BDC"),
                    )
                )
                new_ops.extend(ops)
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
            pdf.save(staged)
        else:
            pdf.save(output_path)

    if same_file:
        finish_staged(staged, output_path)

    return {
        "pages": next_key,
        "tagged": sum(tally.values()),
        "headings": tally["H1"] + tally["H2"],
        "paragraphs": tally["P"],
        "figures": tally["Figure"],
    }
