"""Bookmarks derived from a document's own structure tree.

`autotag` CREATES a structure tree and `set_outline` WRITES a bookmark tree;
this module is the join between them. A tagged document's headings ARE its
outline — the title is the heading's own text and the destination is where the
heading sits — so typing them by hand is transcription, not authoring.

Three rules earned here:

1. **Level comes from the tag, except for the generic `H`, whose level comes
   from NESTING.** The spec gives `H` no level of its own: a heading inside two
   enclosing grouping elements is a level-3 heading. Every other heading tag
   (`H1`…`H6`) names its level, and `/RoleMap` indirection is resolved first so
   a document that spells its headings with private tag names still works.

2. **The title is resolved through a stated ladder, and a heading that
   defeats all of it is REPORTED rather than written as "Untitled".**
   `/ActualText`, then `/Alt`, then the text of the marked content the element
   references, then `/T`. A bookmark whose title is a placeholder is worse than
   a stated shortfall: the user cannot tell it apart from a real one.

3. **The destination carries the heading's POSITION, not just its page.** The
   runs carrying the heading's MCID give a rect, and the bookmark lands as
   `/XYZ left top` at its top-left corner. Jumping to "the page the heading is
   on" puts a mid-page heading off-screen, which is the thing a derived
   outline exists to avoid.

MCID → text is the machinery none of this had. It rides `text_runs._walk_runs`,
which now reports each run's innermost marked-content id from the SAME walk
that produced the run — parallel walks disagreeing about content is the class
`search_regions` documents at length. MCIDs are scoped to a content stream, so
a run inside a form XObject is not in the page's numbering and is not offered
as a source; such a heading falls through the ladder instead.
"""

from __future__ import annotations

from pathlib import Path

import pikepdf

from engine.autotag import autotag
from engine.inplace import is_same_file, staged_write
from engine.outline import _count, get_outline, set_outline
from engine.redact import IDENTITY, _resolve_resources
from engine.struct_tree import _is_elem, _kids, _page_map, _page_no
from engine.text_metrics import _FontCache
from engine.text_runs import _walk_runs

MAX_LEVEL = 6

# Depth cap for the structure walk. `struct_tree._MAX_DEPTH`'s value and its
# reason: deep enough for any real document, and it bounds a malformed
# self-referential tree together with the visited set.
_MAX_DEPTH = 64

# The tags that OPEN a level for a generic `H`. Table 333's grouping elements
# that a document actually nests headings inside; `Document` is excluded
# deliberately — every element is inside it, so counting it would make the
# first heading of every tagged file a level-2.
_GROUPING = frozenset({"Sect", "Part", "Art", "Div", "BlockQuote", "TOC", "TOCI"})

_NUMBERED = {f"H{n}": n for n in range(1, MAX_LEVEL + 1)}


def _role_map(root) -> dict:
    out: dict = {}
    table = root.get("/RoleMap")
    if table is None or not isinstance(table, pikepdf.Dictionary):
        return out
    for key, value in table.items():
        try:
            out[str(key).lstrip("/")] = str(value).lstrip("/")
        except Exception:
            continue
    return out


def _resolve_role(tag: str, role_map: dict) -> str:
    """A tag through /RoleMap, following at most a few hops. A cyclic map is a
    malformed document, not a reason to hang."""
    seen: set[str] = set()
    current = tag
    for _ in range(8):
        if current in _NUMBERED or current == "H" or current in _GROUPING:
            return current
        if current in seen:
            break
        seen.add(current)
        nxt = role_map.get(current)
        if nxt is None or nxt == current:
            break
        current = nxt
    return current


def _elem_tag(elem) -> str:
    value = elem.get("/S")
    if value is None:
        return ""
    try:
        return str(value).lstrip("/")
    except Exception:
        return ""


def _text_prop(elem, key: str) -> str:
    value = elem.get(key)
    if value is None:
        return ""
    try:
        return str(value).strip()
    except Exception:
        return ""


def _content_mcids(elem, pages_by_og, inherited_page) -> tuple[int | None, list[int]]:
    """(1-based page, MCIDs) of the element's DIRECT content, page-scoped only.

    A `/MCR` carrying `/Stm` names content inside a form XObject, whose MCID
    numbering is that stream's and not the page's — those are skipped rather
    than resolved against the wrong numbering.
    """
    own_page = _page_no(pages_by_og, elem.get("/Pg"), inherited_page)
    mcids: list[int] = []
    page = own_page
    for kid in _kids(elem):
        if isinstance(kid, int):
            if own_page is not None:
                mcids.append(int(kid))
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
        if page is None:
            page = kid_page
        if kid_page == page:
            mcids.append(int(kid.get("/MCID")))
    return page, mcids


def _descendant_mcids(elem, pages_by_og, inherited_page, depth=0) -> tuple[int | None, list[int]]:
    """The element's own content, or — for a heading whose text sits in a
    child `Span`/`Link` — its descendants'. Only the FIRST page reached is
    used: a heading that wraps across a page break is still one bookmark, and
    the destination is where it starts."""
    page, mcids = _content_mcids(elem, pages_by_og, inherited_page)
    if depth >= _MAX_DEPTH:
        return page, mcids
    for kid in _kids(elem):
        if not _is_elem(kid):
            continue
        kid_page, kid_mcids = _descendant_mcids(kid, pages_by_og, page, depth + 1)
        if not kid_mcids:
            continue
        if page is None:
            page = kid_page
        if kid_page == page:
            mcids.extend(kid_mcids)
    return page, mcids


class _PageText:
    """Per-page MCID → (text, rect), read once per page and cached.

    The rect is the union of the runs carrying that id, in page space — the
    lister's own EM box, which is where a caret belongs and therefore where a
    view should be positioned.
    """

    def __init__(self, pdf):
        self._pdf = pdf
        self._cache: dict[int, dict[int, tuple[str, list[float]]]] = {}

    def get(self, page_no: int) -> dict[int, tuple[str, list[float]]]:
        if page_no in self._cache:
            return self._cache[page_no]
        table: dict[int, tuple[str, list[float]]] = {}
        try:
            page = self._pdf.pages[page_no - 1]
            runs: list[dict] = []
            _walk_runs(
                self._pdf,
                pikepdf.parse_content_stream(page),
                _resolve_resources(page),
                IDENTITY,
                0,
                None,
                runs,
                False,
                _FontCache(),
            )
        except Exception:
            self._cache[page_no] = table
            return table
        for run in runs:
            mcid = run.get("mcid")
            # `nested` runs live in a form XObject's own MCID numbering.
            if mcid is None or run.get("nested"):
                continue
            text = str(run.get("text") or "")
            rect = [float(v) for v in run.get("rect") or [0.0, 0.0, 0.0, 0.0]]
            previous = table.get(mcid)
            if previous is None:
                table[mcid] = (text, rect)
                continue
            joined = previous[0]
            if joined and text and not joined.endswith(" ") and not text.startswith(" "):
                joined += " "
            joined += text
            box = previous[1]
            table[mcid] = (
                joined,
                [
                    min(box[0], rect[0]),
                    min(box[1], rect[1]),
                    max(box[2], rect[2]),
                    max(box[3], rect[3]),
                ],
            )
        self._cache[page_no] = table
        return table


def _heading_text_and_box(elem, pages_by_og, inherited_page, page_text: _PageText):
    """(title, source, page, rect) for one heading; rect may be None."""
    actual = _text_prop(elem, "/ActualText")
    alt = _text_prop(elem, "/Alt")
    page, mcids = _descendant_mcids(elem, pages_by_og, inherited_page)
    content = ""
    box: list[float] | None = None
    if page is not None and mcids:
        table = page_text.get(page)
        parts: list[str] = []
        for mcid in mcids:
            found = table.get(mcid)
            if found is None:
                continue
            if found[0].strip():
                parts.append(found[0].strip())
            rect = found[1]
            box = (
                list(rect)
                if box is None
                else [
                    min(box[0], rect[0]),
                    min(box[1], rect[1]),
                    max(box[2], rect[2]),
                    max(box[3], rect[3]),
                ]
            )
        content = " ".join(parts).strip()
    if actual:
        return actual, "actual_text", page, box
    if alt:
        return alt, "alt", page, box
    if content:
        return content, "content", page, box
    title = _text_prop(elem, "/T")
    if title:
        return title, "title", page, box
    return "", "", page, box


def _collect_headings(pdf, max_level: int) -> tuple[list[dict], list[dict]]:
    """(headings in tree order, skipped) for a tagged document."""
    root = pdf.Root.get("/StructTreeRoot")
    if root is None:
        raise ValueError(
            "This document is not tagged, so it has no headings to build "
            "bookmarks from. Tag it first — automatically, or in the Tags panel."
        )
    role_map = _role_map(root)
    pages_by_og = _page_map(pdf)
    page_text = _PageText(pdf)
    headings: list[dict] = []
    skipped: list[dict] = []
    visited: set = set()

    def walk(elem, inherited_page, group_depth, depth):
        if depth > _MAX_DEPTH:
            return
        try:
            og = elem.objgen
            if og != (0, 0):
                if og in visited:
                    return
                visited.add(og)
        except Exception:
            pass
        role = _resolve_role(_elem_tag(elem), role_map)
        own_page = _page_no(pages_by_og, elem.get("/Pg"), inherited_page)
        level = None
        if role in _NUMBERED:
            level = _NUMBERED[role]
        elif role == "H":
            # The generic heading takes its level from how deeply it is nested
            # in grouping elements — the spec's own rule, and the only one
            # available: the tag itself says nothing.
            level = min(max(group_depth, 1), MAX_LEVEL)
        if level is not None:
            title, source, page, box = _heading_text_and_box(
                elem, pages_by_og, own_page, page_text
            )
            if title and level <= max_level:
                headings.append(
                    {
                        "level": level,
                        "title": " ".join(title.split()),
                        "tag": role,
                        "page": page,
                        "rect": box,
                        "source": source,
                    }
                )
            elif not title:
                skipped.append({"tag": role, "page": page, "reason": "no_text"})
            # A heading below the requested depth is a scope choice, not a
            # shortfall, so it is not reported as skipped.
        next_group = group_depth + 1 if role in _GROUPING else group_depth
        for kid in _kids(elem):
            if _is_elem(kid):
                walk(kid, own_page, next_group, depth + 1)

    for kid in _kids(root):
        if _is_elem(kid):
            walk(kid, None, 0, 1)
    return headings, skipped


def _nest(headings: list[dict]) -> list[dict]:
    """Headings in tree order → a bookmark tree.

    A level-n heading becomes a child of the nearest preceding heading of a
    LOWER level. Levels nest relative to what came before, so a document whose
    first heading is an H3 does not grow two empty ancestors.
    """
    roots: list[dict] = []
    stack: list[tuple[int, dict]] = []
    for heading in headings:
        node = {"title": heading["title"], "page": heading["page"], "children": []}
        rect = heading.get("rect")
        if heading["page"] is not None and rect is not None:
            # Top-left of the heading's own box: the view lands ON the heading.
            node["left"] = round(float(rect[0]), 2)
            node["top"] = round(float(rect[3]), 2)
            node["zoom"] = None
        while stack and stack[-1][0] >= heading["level"]:
            stack.pop()
        if stack:
            stack[-1][1]["children"].append(node)
        else:
            roots.append(node)
        stack.append((heading["level"], node))
    return roots


def preview_structure_outline(file: str, max_level: int = MAX_LEVEL) -> dict:
    """What `outline_from_structure` would write, without writing it.

    The panel states this before the apply — the hairlines contract — and the
    two share `_collect_headings`, so the preview and the run cannot disagree
    about what the document contains.
    """
    level_cap = _clamp_level(max_level)
    with pikepdf.open(file) as pdf:
        tagged = pdf.Root.get("/StructTreeRoot") is not None
        if not tagged:
            existing = _count(_existing_outline(pdf))
            return {
                "tagged": False,
                "headings": 0,
                "outline": [],
                "existing": existing,
                "skipped": [],
            }
        headings, skipped = _collect_headings(pdf, level_cap)
        tree = _nest(headings)
        return {
            "tagged": True,
            "headings": len(headings),
            "outline": tree,
            "existing": _count(_existing_outline(pdf)),
            "skipped": skipped,
        }


def _existing_outline(pdf) -> list[dict]:
    """The document's current bookmarks as titles-and-children only — enough to
    COUNT and to append after, without paying for the full destination
    resolution `get_outline` does."""
    with pdf.open_outline() as outline:
        def read(items, depth):
            out = []
            if depth > 32:
                return out
            for item in items:
                out.append(
                    {
                        "title": str(item.title) if item.title is not None else "",
                        "children": read(item.children, depth + 1),
                    }
                )
            return out

        return read(outline.root, 0)


def _clamp_level(max_level) -> int:
    try:
        value = int(max_level)
    except (TypeError, ValueError):
        raise ValueError(f"heading depth must be a number from 1 to {MAX_LEVEL}") from None
    if not (1 <= value <= MAX_LEVEL):
        raise ValueError(f"heading depth must be a number from 1 to {MAX_LEVEL}")
    return value


def outline_from_structure(
    file: str,
    output: str,
    mode: str = "replace",
    max_level: int = MAX_LEVEL,
    tag_if_untagged: bool = False,
) -> dict:
    """Write the document's headings as its bookmark tree.

    `mode` is "replace" (the derived tree becomes the outline) or "append" (it
    follows the existing top-level items). There is no silent third behaviour:
    a document with bookmarks either keeps them or does not, and the caller
    says which.

    `tag_if_untagged` runs `autotag` first so a headless run can perform the
    same chain the panel offers. It is OFF by default — nothing tags a
    document behind the user's back — and the result names which path ran.
    """
    if mode not in ("replace", "append"):
        raise ValueError('mode must be "replace" or "append"')
    level_cap = _clamp_level(max_level)
    output_path = Path(output)
    same_file = is_same_file(file, output)
    source = "structure"
    working = file

    with pikepdf.open(file) as pdf:
        tagged = pdf.Root.get("/StructTreeRoot") is not None
    if not tagged and tag_if_untagged:
        # Tag INTO the output and carry on from there, so the tags the
        # headings were read from are the tags the saved file carries.
        if same_file:
            with staged_write(output_path) as staged:
                autotag(file, str(staged))
        else:
            autotag(file, str(output_path))
        working = str(output_path)
        source = "autotag"

    with pikepdf.open(working) as pdf:
        headings, skipped = _collect_headings(pdf, level_cap)
        if not headings:
            raise ValueError(
                "No headings found in the structure tree — nothing to build "
                "bookmarks from."
            )
        derived = _nest(headings)

    existing = get_outline(working)["outline"] if mode == "append" else []
    tree = [*existing, *derived]
    set_outline(working, tree, str(output_path))
    return {
        "output": str(output_path),
        "added": _count(derived),
        "total": _count(tree),
        "mode": mode,
        "source": source,
        "skipped": skipped,
    }
