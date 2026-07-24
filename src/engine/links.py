"""Link-region management (§ I.2 N1 — Links).

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
        _save(pdf, input_path, output_path, same_file)
    return {"output": str(output_path), "page": int(page), "index": int(index), "url": str(url)}


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
        _save(pdf, input_path, output_path, same_file)
    return {"output": str(output_path), "added": added}


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
        _save(pdf, input_path, output_path, same_file)
    return {"output": str(output_path), "page": int(page), "index": int(index)}


def _save(pdf, input_path: Path, output_path: Path, same_file: bool) -> None:
    if same_file:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False, dir=str(input_path.parent)) as tmp:
            tmp_path = tmp.name
        pdf.save(tmp_path)
        shutil.move(tmp_path, str(output_path))
    else:
        pdf.save(output_path)
