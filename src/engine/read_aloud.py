"""A page's text as a READER hears it: ordered blocks, with the geometry to
highlight any character range of one.

Two questions, answered per page and both reported:

*Which order?* The structure tree's, when the page's whole non-artifact
content is in it — the order the document's own producer declared. Otherwise
the extraction's own order, and the caller is told which ran. Half a page in
one order and half in the other would be an order that is neither, with
nothing to tell a listener which sentences moved, so the choice is
all-or-nothing per page.

*Where is character n?* Blocks are the SHIPPED paragraph lister's paragraphs,
so their text is already in logical order for a right-to-left paragraph (which
is what a synthesizer must be handed) and their `spans` are already a
character-range→run map. This module refines a span to per-CHARACTER
rectangles by walking the run's own drawn codes, and says per span whether it
managed to: a span whose characters were proved to sit one-to-one on the codes
that drew them carries `chars`, and one where the proof failed carries the
whole run's rectangle and `exact: false`. Nothing here guesses, and a caller
never has to wonder how precise a rectangle is.

Rectangles are one per RUN, never a box bounded across runs —
`search_text_regions`' rule 3, for the same reason: a phrase that wraps
belongs in two rectangles, not in one that swallows the margin.

Marked-content sections tagged `/Artifact` are excluded from both orders. The
tag is the producer stating the content is a running header, a folio or a
rule; speaking page furniture between every page is the defect it exists to
prevent.
"""

from __future__ import annotations

import pikepdf

from engine.content_walk import GraphicsTextState
from engine.redact import IDENTITY, _resolve_resources, _span_bbox
from engine.struct_tree import _is_elem, _kids, _page_map, _page_no
from engine.text_metrics import _FontCache, measurable, show_items_from_segments
from engine.text_paragraphs import _group
from engine.text_runs import _walk_runs
from engine.validate import validate_pdf

# Depth cap for the structure walk — `struct_tree._MAX_DEPTH`'s value and its
# reason: deep enough for any real document, and together with the visited set
# it bounds a malformed self-referential tree.
_MAX_DEPTH = 64


def _content_stream_mcids(elem, pages_by_og, inherited_page) -> tuple:
    """(1-based page, MCIDs) of the element's DIRECT content, page-scoped.

    An `/MCR` carrying `/Stm` names content inside a form XObject, whose MCID
    numbering is that stream's and not the page's — skipped rather than
    resolved against the wrong numbering. `derived_nav._content_mcids`' rule,
    spelled here because that module's copy also carries heading concerns.
    """
    own_page = _page_no(pages_by_og, elem.get("/Pg"), inherited_page)
    mcids: list = []
    page = own_page
    for kid in _kids(elem):
        if isinstance(kid, int):
            if own_page is not None:
                mcids.append((own_page, int(kid)))
            continue
        if not isinstance(kid, pikepdf.Dictionary):
            continue
        if _is_elem(kid):
            continue
        try:
            kind = str(kid.get("/Type")) if kid.get("/Type") is not None else ""
        except Exception:
            continue
        if kind != "/MCR" or kid.get("/MCID") is None:
            continue
        if kid.get("/Stm") is not None:
            continue
        kid_page = _page_no(pages_by_og, kid.get("/Pg"), own_page)
        if kid_page is None:
            continue
        mcids.append((kid_page, int(kid.get("/MCID"))))
    return page, mcids


def _struct_order(pdf, page_number: int) -> tuple:
    """(MCID → position, role by MCID) for one page, in depth-first tree order.

    Position is the ordinal of the id's first appearance in the walk, which IS
    the declared reading order. A tag is reported alongside so a caller can
    tell a heading from a paragraph without walking the tree itself.
    """
    try:
        root = pdf.Root.get("/StructTreeRoot")
    except Exception:
        root = None
    if root is None or not isinstance(root, pikepdf.Dictionary):
        return None, {}
    pages_by_og = _page_map(pdf)
    position: dict = {}
    role: dict = {}
    counter = [0]
    visited: set = set()

    def walk(elem, inherited_page, tag, depth) -> None:
        if depth > _MAX_DEPTH:
            return
        try:
            key = elem.objgen
        except Exception:
            key = None
        if key is not None:
            if key in visited:
                return
            visited.add(key)
        own_tag = tag
        value = elem.get("/S")
        if value is not None:
            try:
                own_tag = str(value).lstrip("/")
            except Exception:
                own_tag = tag
        own_page, mcids = _content_stream_mcids(elem, pages_by_og, inherited_page)
        for mcid_page, mcid in mcids:
            if mcid_page != page_number or mcid in position:
                continue
            position[mcid] = counter[0]
            role[mcid] = own_tag
            counter[0] += 1
        for kid in _kids(elem):
            if _is_elem(kid):
                walk(kid, own_page, own_tag, depth + 1)

    for kid in _kids(root):
        if _is_elem(kid):
            walk(kid, None, "", 0)
    return position, role


def _char_rects(run_detail: dict, fonts: _FontCache) -> tuple:
    """(drawn text, one rectangle per character of it) for one run, or (None,
    None) when the run's codes cannot be measured.

    A code that decodes to several characters (a ligature spelling `fi`)
    divides its own advance evenly across them: the alternative is handing the
    whole ligature's box to each letter, which would draw a highlight wider
    than the letters it names.
    """
    cap = run_detail["cap"]
    style = run_detail["style"]
    segments = run_detail["segments"]
    data = b"".join(s for s in segments if isinstance(s, bytes))
    if cap is None or not measurable(cap, data):
        return None, None
    state = GraphicsTextState(
        IDENTITY,
        font_size=style["size"],
        h_scale=style["h_scale"],
        font_name=style["font_name"],
    )
    state.char_spacing = style["char_spacing"]
    state.word_spacing = style["word_spacing"]
    state.rise = style["rise"]
    items = show_items_from_segments(segments, cap, state)
    vertical = bool(cap.writes_vertical)
    ink = fonts.ink_extent(run_detail["resources"], run_detail["fallback"], style["font_name"])
    combined = run_detail["combined"]
    text_parts: list = []
    rects: list = []
    for item in items:
        if item.kern:
            continue
        text = cap.decode(item.data)
        if not text:
            continue
        step = item.advance / len(text)
        for i, ch in enumerate(text):
            x0 = item.x + step * i
            rects.append(
                [
                    round(float(v), 3)
                    for v in _span_bbox(combined, x0, x0 + step, vertical, state, ink)
                ]
            )
            text_parts.append(ch)
    if not rects:
        return None, None
    return "".join(text_parts), rects


def _align(span_text: str, drawn: str, cursor: int) -> tuple:
    """Walk `span_text` against `drawn` from `cursor`, returning the index into
    `drawn` of each of the span's characters, and the cursor to resume from —
    or (None, cursor) when the two do not line up.

    A character the span has and the run did not draw is legitimate in exactly
    one case: the paragraph lister emits a space where two lines join, and that
    space rides the previous span. Such a space takes the position of the
    character before it (a space has no ink, so its rectangle only ever needs
    to be somewhere sensible), and the run cursor does not advance. Anything
    else that fails to match is a real divergence — a normalization, a
    reordering the emission did at unit level — and the caller falls back to
    the whole run.
    """
    out: list = []
    at = cursor
    for ch in span_text:
        if at < len(drawn) and drawn[at] == ch:
            out.append(at)
            at += 1
            continue
        if ch.isspace():
            out.append(out[-1] if out else min(at, len(drawn) - 1))
            continue
        return None, cursor
    return out, at


def _union(rects: list) -> list:
    x0 = min(r[0] for r in rects)
    y0 = min(r[1] for r in rects)
    x1 = max(r[2] for r in rects)
    y1 = max(r[3] for r in rects)
    return [x0, y0, x1, y1]


def _block_spans(paragraph, detail: list, fonts: _FontCache, run_rect) -> list:
    """The paragraph's own character-range→run spans, each carrying geometry."""
    per_run_cursor: dict = {}
    per_run_chars: dict = {}
    out: list = []
    for span in paragraph.spans:
        index = int(span["run"])
        if index not in per_run_chars:
            per_run_chars[index] = _char_rects(detail[index], fonts)
            per_run_cursor[index] = 0
        drawn, rects = per_run_chars[index]
        text = paragraph.text[int(span["start"]) : int(span["end"])]
        entry = {"s": int(span["start"]), "e": int(span["end"]), "run": index}
        mapped = None
        if drawn is not None:
            mapped, cursor = _align(text, drawn, per_run_cursor[index])
            if mapped is not None:
                per_run_cursor[index] = cursor
        if mapped is None:
            entry["exact"] = False
            entry["rect"] = run_rect(index)
        else:
            entry["exact"] = True
            entry["chars"] = [rects[i] for i in mapped]
            entry["rect"] = _union(entry["chars"]) if entry["chars"] else run_rect(index)
        out.append(entry)
    return out


def read_aloud_page(file: str, page: int) -> dict:
    """One page's reading blocks.

    Returns ``{page, order, reason, artifacts, blocks}`` where a block is
    ``{index, role, text, box, spans}`` and a span is
    ``{s, e, run, rect, exact, chars?}`` — `s`/`e` index the BLOCK's text and
    `chars` (present only when `exact`) holds one page-space rectangle per
    character of that range.
    """
    validate_pdf(file)
    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        if not (1 <= int(page) <= total):
            raise ValueError(f"page {page} is out of range (1-{total})")
        p = pdf.pages[int(page) - 1]
        resources = _resolve_resources(p)
        runs: list = []
        detail: list = []
        fonts = _FontCache()
        _walk_runs(
            pdf,
            pikepdf.parse_content_stream(p),
            resources,
            IDENTITY,
            0,
            None,
            runs,
            False,
            fonts,
            detail=detail,
        )
        artifacts = sum(1 for row in runs if row.get("artifact"))
        # An artifact never reaches the grouper: a running header clustered
        # into the first body paragraph would be spoken inside it, and there
        # would be no span to exclude afterwards.
        kept = [
            index
            for index, row in enumerate(runs)
            if not row.get("artifact") and not row.get("clipped")
        ]
        if not kept:
            return {
                "page": int(page),
                "order": "layout",
                "reason": "no readable text",
                "artifacts": artifacts,
                "blocks": [],
            }
        # `_group` indexes runs positionally, so it is fed a DENSE list and the
        # result's run indexes are translated back to the page's own numbering.
        local = [runs[i] for i in kept]
        local_detail = [detail[i] for i in kept]
        for position, row in enumerate(local):
            row = dict(row)
            row["index"] = position
            local[position] = row
        paragraphs = _group(local, local_detail)

        def run_rect(local_index: int) -> list:
            rect = detail[kept[local_index]]["rect"]
            return [round(float(v), 3) for v in rect]

        position_by_mcid, role_by_mcid = _struct_order(pdf, int(page))
        order = "layout"
        reason = None
        if position_by_mcid is None:
            reason = "not tagged"
        else:
            untagged = [
                i
                for i, index in enumerate(kept)
                if runs[index].get("nested")
                or runs[index].get("mcid") is None
                or int(runs[index]["mcid"]) not in position_by_mcid
            ]
            if untagged:
                reason = "page content outside the structure tree"
            elif not position_by_mcid:
                reason = "nothing on this page is in the structure tree"
            else:
                order = "structure"

        entries = []
        for paragraph in paragraphs:
            text = paragraph.text
            if not text.strip():
                continue
            spans = _block_spans(paragraph, local_detail, fonts, run_rect)
            first = paragraph.run_indexes[0] if paragraph.run_indexes else 0
            mcid = runs[kept[first]].get("mcid") if first < len(kept) else None
            entries.append(
                {
                    "sort": (
                        min(
                            (
                                position_by_mcid.get(int(runs[kept[i]]["mcid"]), 1 << 30)
                                for i in paragraph.run_indexes
                                if runs[kept[i]].get("mcid") is not None
                            ),
                            default=1 << 30,
                        )
                        if order == "structure"
                        else len(entries)
                    ),
                    "block": {
                        "role": role_by_mcid.get(int(mcid)) if mcid is not None else None,
                        "text": text,
                        "box": [round(float(v), 3) for v in paragraph.box],
                        "spans": spans,
                    },
                }
            )
        entries.sort(key=lambda e: e["sort"])
        blocks = []
        for index, entry in enumerate(entries):
            block = dict(entry["block"])
            block["index"] = index
            blocks.append(block)
        return {
            "page": int(page),
            "order": order,
            "reason": reason,
            "artifacts": artifacts,
            "blocks": blocks,
        }
