"""Link-region management (Links).

Links are navigation regions (a /Link annotation with a URI action or an
internal destination), NOT comments — so they get their own manager rather than
riding the annotation/comment model: list every link with its target, retarget
a link to a URL, or delete it. Links are addressed by (1-based page, index among
that page's links).

An internal (GoTo) destination is resolved to its target page where the /Dest is
an explicit array `[pageRef …]`; named/other destinations report 'internal'
without a page (resolving the whole name tree is out of scope for the manager).
"""

import shutil
import tempfile
from pathlib import Path

import pikepdf
from pikepdf import Dictionary, Name, String


def _page_index_of(pdf, ref) -> int | None:
    try:
        og = ref.objgen
    except Exception:
        return None
    for i, page in enumerate(pdf.pages):
        try:
            if page.obj.objgen == og:
                return i
        except Exception:
            continue
    return None


def _rect(annot):
    try:
        r = [float(v) for v in annot.get("/Rect")]
        if len(r) == 4:
            return [min(r[0], r[2]), min(r[1], r[3]), max(r[0], r[2]), max(r[1], r[3])]
    except (TypeError, ValueError):
        pass
    return None


def _target(pdf, annot) -> tuple[str, str]:
    """(kind, target-description) for a link. kind ∈ uri|internal|other."""
    a = annot.get("/A")
    if a is not None:
        try:
            s = str(a.get("/S"))
        except Exception:
            s = ""
        if s == "/URI":
            uri = a.get("/URI")
            return ("uri", str(uri) if uri is not None else "")
        if s == "/GoTo":
            d = a.get("/D")
            page = _dest_page(pdf, d)
            return ("internal", f"Page {page + 1}" if page is not None else "internal link")
        return ("other", s.lstrip("/") or "action")
    dest = annot.get("/Dest")
    if dest is not None:
        page = _dest_page(pdf, dest)
        return ("internal", f"Page {page + 1}" if page is not None else "internal link")
    return ("other", "none")


def _dest_page(pdf, dest) -> int | None:
    if isinstance(dest, pikepdf.Array) and len(dest) > 0:
        return _page_index_of(pdf, dest[0])
    return None


def _links_on(page) -> list:
    annots = page.obj.get("/Annots")
    if annots is None:
        return []
    out = []
    for a in annots:
        try:
            if str(a.get("/Subtype")) == "/Link":
                out.append(a)
        except Exception:
            continue
    return out


def list_links(file: str) -> dict:
    with pikepdf.open(file) as pdf:
        links = []
        for pi, page in enumerate(pdf.pages):
            for li, annot in enumerate(_links_on(page)):
                kind, target = _target(pdf, annot)
                links.append({"page": pi + 1, "index": li, "kind": kind, "target": target, "rect": _rect(annot)})
        return {"links": links, "count": len(links)}


def _nth_link(pdf, page_no: int, index: int):
    if not (1 <= int(page_no) <= len(pdf.pages)):
        raise ValueError(f"page {page_no} is out of range (1-{len(pdf.pages)})")
    links = _links_on(pdf.pages[int(page_no) - 1])
    if not (0 <= int(index) < len(links)):
        raise ValueError(f"link index {index} is out of range (page has {len(links)})")
    return links[int(index)]


def set_link_url(file: str, output: str, page: int, index: int, url: str) -> dict:
    """Retarget a link to a URL (replaces any existing action/destination)."""
    if not str(url).strip():
        raise ValueError("url must not be empty")
    input_path, output_path = Path(file), Path(output)
    same_file = input_path.resolve() == output_path.resolve()
    with pikepdf.open(file) as pdf:
        annot = _nth_link(pdf, page, index)
        annot["/A"] = Dictionary(Type=Name.Action, S=Name.URI, URI=String(str(url)))
        if "/Dest" in annot:
            del annot["/Dest"]
        preserved = _save(pdf, input_path, output_path, same_file)
    out = {"output": str(output_path), "page": int(page), "index": int(index), "url": str(url)}
    if preserved:
        out["signatures_preserved"] = True
    return out


def add_links(file: str, output: str, links: list) -> dict:
    """Create /Link annotations with URI actions.

    `links` is a list of {page (1-based), rect [x0,y0,x1,y1] in PDF user space,
    url}. Authored from a text selection in the reading view: one link per line
    box of the selection, so a wrapped phrase links every line it covers rather
    than a single box swallowing the space between them.

    /Border [0 0 0] — an invisible border, the convention every mainstream
    authoring tool uses; a visible ring around linked text is not what the
    gesture asked for.
    """
    if not links:
        raise ValueError("no links to add")
    input_path, output_path = Path(file), Path(output)
    same_file = input_path.resolve() == output_path.resolve()
    with pikepdf.open(file) as pdf:
        added = 0
        for spec in links:
            page_no = int(spec["page"])
            if not (1 <= page_no <= len(pdf.pages)):
                raise ValueError(f"page {page_no} is out of range (1-{len(pdf.pages)})")
            url = str(spec.get("url", "")).strip()
            if not url:
                raise ValueError("url must not be empty")
            raw = [float(v) for v in spec["rect"]]
            if len(raw) != 4:
                raise ValueError("rect must be [x0, y0, x1, y1]")
            x0, y0, x1, y1 = min(raw[0], raw[2]), min(raw[1], raw[3]), max(raw[0], raw[2]), max(raw[1], raw[3])
            if x1 - x0 <= 0 or y1 - y0 <= 0:
                raise ValueError("rect must have a positive width and height")
            pg = pdf.pages[page_no - 1]
            annot = pdf.make_indirect(
                Dictionary(
                    Type=Name.Annot,
                    Subtype=Name.Link,
                    Rect=pikepdf.Array([x0, y0, x1, y1]),
                    Border=pikepdf.Array([0, 0, 0]),
                    A=Dictionary(Type=Name.Action, S=Name.URI, URI=String(url)),
                )
            )
            existing = pg.obj.get("/Annots")
            pg.obj["/Annots"] = pikepdf.Array([*existing, annot]) if existing is not None else pikepdf.Array([annot])
            added += 1
        preserved = _save(pdf, input_path, output_path, same_file)
    out = {"output": str(output_path), "added": added}
    if preserved:
        out["signatures_preserved"] = True
    return out


def delete_link(file: str, output: str, page: int, index: int) -> dict:
    """Remove one link annotation from a page."""
    input_path, output_path = Path(file), Path(output)
    same_file = input_path.resolve() == output_path.resolve()
    with pikepdf.open(file) as pdf:
        target = _nth_link(pdf, page, index)
        pg = pdf.pages[int(page) - 1]
        annots = pg.obj.get("/Annots")
        kept = [a for a in annots if a.objgen != target.objgen]
        if kept:
            pg.obj["/Annots"] = pikepdf.Array(kept)
        elif "/Annots" in pg.obj:
            del pg.obj["/Annots"]
        preserved = _save(pdf, input_path, output_path, same_file)
    out = {"output": str(output_path), "page": int(page), "index": int(index)}
    if preserved:
        out["signatures_preserved"] = True
    return out


# ── links derived from the text ───────────────────────────────────────────

# How much of a candidate an existing /Link must cover for the candidate to
# count as already linked. Half, not containment: a hand-drawn link box rarely
# matches a glyph slice exactly, and "the user already linked this" is the
# question being asked.
_ALREADY_LINKED_FRACTION = 0.5


def _bbox(rects: list[dict]) -> list[float]:
    xs0 = [r["rect"][0] for r in rects]
    ys0 = [r["rect"][1] for r in rects]
    xs1 = [r["rect"][2] for r in rects]
    ys1 = [r["rect"][3] for r in rects]
    return [min(xs0), min(ys0), max(xs1), max(ys1)]


def _overlap_area(a: list[float], b: list[float]) -> float:
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    return w * h if (w > 0 and h > 0) else 0.0


def _contains(outer: list[float], inner: list[float]) -> bool:
    return (
        outer[0] <= inner[0] + 0.01
        and outer[1] <= inner[1] + 0.01
        and outer[2] >= inner[2] - 0.01
        and outer[3] >= inner[3] - 0.01
    )


def _existing_link_rects(file: str) -> dict[int, list[list[float]]]:
    by_page: dict[int, list[list[float]]] = {}
    with pikepdf.open(file) as pdf:
        for pi, page in enumerate(pdf.pages):
            rects = [r for r in (_rect(a) for a in _links_on(page)) if r is not None]
            if rects:
                by_page[pi + 1] = rects
    return by_page


def _candidates(file: str, pages, emails: bool) -> tuple[list[dict], list[int]]:
    """Every web (and, when asked, email) address in the text, with the
    glyph-accurate rects `search_text_regions` computed for it.

    The geometry is that module's verbatim — it is the rect authority and its
    docstring says why nothing else may be. One rect PER RUN, so an address
    that wraps a line links both lines rather than the margin between them.
    """
    from engine.search_regions import search_text_regions
    from engine.text_match import email_target, url_target

    wanted = ["url", "email"] if emails else ["url"]
    found = search_text_regions(file, pages=pages, patterns=wanted)
    raw: list[dict] = []
    for hit in found["hits"]:
        rects = hit.get("rects") or []
        if not rects:
            continue
        text = str(hit.get("text") or "").strip()
        if not text:
            continue
        source = hit.get("source")
        url = url_target(text) if source == "url" else email_target(text)
        raw.append(
            {
                "page": int(hit["page"]),
                "text": text,
                "url": url,
                "kind": "url" if source == "url" else "email",
                "rects": [list(r["rect"]) for r in rects],
                "box": _bbox(rects),
            }
        )
    # A `mailto:` address matches both patterns, and a path containing an @
    # matches the email one inside the URL. One address is one link, so a
    # candidate whose box sits inside another's is the same address seen
    # twice — the WIDER match is the address.
    keep: list[dict] = []
    for i, candidate in enumerate(raw):
        swallowed = False
        for j, other in enumerate(raw):
            if i == j or other["page"] != candidate["page"]:
                continue
            if _contains(other["box"], candidate["box"]) and not _contains(
                candidate["box"], other["box"]
            ):
                swallowed = True
                break
        if not swallowed:
            keep.append(candidate)
    return keep, list(found.get("pages_without_text") or [])


def _mark_already_linked(candidates: list[dict], existing: dict[int, list[list[float]]]) -> None:
    for candidate in candidates:
        boxes = existing.get(candidate["page"], [])
        linked = False
        for rect in candidate["rects"]:
            area = max((rect[2] - rect[0]) * (rect[3] - rect[1]), 1e-9)
            for box in boxes:
                if _overlap_area(box, rect) / area >= _ALREADY_LINKED_FRACTION:
                    linked = True
                    break
            if linked:
                break
        candidate["existing"] = linked


def find_url_links(file: str, pages="all", emails: bool = True) -> dict:
    """Every address the text carries, and whether each one is already linked.

    Reads only. The panel states this count before the apply — the hairlines
    contract — and the apply calls the SAME collector, so a preview and a run
    cannot disagree about what the document contains.
    """
    candidates, without_text = _candidates(file, pages, bool(emails))
    _mark_already_linked(candidates, _existing_link_rects(file))
    return {
        "candidates": candidates,
        "count": len(candidates),
        "already_linked": sum(1 for c in candidates if c["existing"]),
        "pages_without_text": without_text,
    }


def create_links_from_urls(
    file: str,
    output: str,
    pages="all",
    emails: bool = True,
    skip_existing: bool = True,
) -> dict:
    """Author a /Link with a URI action over every address found in the text.

    Built through `add_links`, so the invisible border and the signed-document
    incremental append come free rather than being re-implemented here.
    """
    candidates, _without_text = _candidates(file, pages, bool(emails))
    if not candidates:
        raise ValueError("No web addresses or email addresses were found in the text.")
    _mark_already_linked(candidates, _existing_link_rects(file))
    skipped = 0
    specs: list[dict] = []
    for candidate in candidates:
        if skip_existing and candidate["existing"]:
            skipped += 1
            continue
        for rect in candidate["rects"]:
            specs.append({"page": candidate["page"], "rect": rect, "url": candidate["url"]})
    if not specs:
        # Everything found is already linked. That is a RESULT, not a failure:
        # the document is in the state the user asked for.
        if str(Path(file).resolve()) != str(Path(output).resolve()):
            shutil.copyfile(file, output)
        return {
            "output": str(Path(output)),
            "added": 0,
            "annotations": 0,
            "skipped_existing": skipped,
            "candidates": len(candidates),
        }
    result = add_links(file, output, specs)
    added = len(candidates) - skipped
    return {
        "output": result["output"],
        "added": added,
        "annotations": result["added"],
        "skipped_existing": skipped,
        "candidates": len(candidates),
        **({"signatures_preserved": True} if result.get("signatures_preserved") else {}),
    }


def _save(pdf, input_path: Path, output_path: Path, same_file: bool) -> bool:
    """Land the rewrite; on a SIGNED input the landed bytes become an
    incremental append instead, so link edits never break the
    signature they ride beside. Returns whether that preservation ran."""
    from engine.incremental import finalize_preserving_signatures

    if same_file:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False, dir=str(input_path.parent)) as tmp:
            tmp_path = tmp.name
        pdf.save(tmp_path)
        preserved = finalize_preserving_signatures(str(input_path), tmp_path)
        shutil.move(tmp_path, str(output_path))
    else:
        pdf.save(output_path)
        preserved = finalize_preserving_signatures(str(input_path), str(output_path))
    return bool(preserved.get("preserved"))
