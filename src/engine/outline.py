"""PDF outline (bookmarks) read/write using pikepdf."""

import shutil
import tempfile
from pathlib import Path

import pikepdf
from pikepdf import OutlineItem

MAX_DEPTH = 32
MAX_NODES = 10_000


def _resolve_dest_page(pdf: pikepdf.Pdf, item) -> int | None:
    """Best-effort 0-based page index for an outline item's target."""
    dest = None
    try:
        if item.destination is not None:
            dest = item.destination
        elif item.action is not None and item.action.get("/S") == pikepdf.Name.GoTo:
            dest = item.action.get("/D")
    except Exception:
        return None
    if dest is None:
        return None

    # Named destination — resolve through the document's name tree.
    if isinstance(dest, (pikepdf.Name, pikepdf.String, str, bytes)):
        try:
            names = pikepdf.NameTree(pdf.Root.Names.Dests)
            key = str(dest)
            resolved = names.get(key.lstrip("/")) or names.get(key)
            if resolved is None:
                return None
            dest = resolved
            if isinstance(dest, pikepdf.Dictionary):
                dest = dest.get("/D")
        except Exception:
            return None
    if dest is None or not isinstance(dest, pikepdf.Array) or len(dest) == 0:
        return None
    try:
        return pikepdf.Page(dest[0]).index
    except Exception:
        return None


def _read_items(pdf: pikepdf.Pdf, items, depth: int, budget: list[int]) -> list[dict]:
    result = []
    if depth > MAX_DEPTH:
        return result
    for item in items:
        if budget[0] <= 0:
            break
        budget[0] -= 1
        page = _resolve_dest_page(pdf, item)
        result.append(
            {
                "title": str(item.title) if item.title is not None else "",
                # 1-based for symmetry with every other page-facing op
                "page": page + 1 if page is not None else None,
                "children": _read_items(pdf, item.children, depth + 1, budget),
            }
        )
    return result


def get_outline(file: str) -> dict:
    """Read the bookmark tree. Items whose destination can't be resolved to a
    page keep their place in the tree with page=None."""
    with pikepdf.open(file) as pdf:
        with pdf.open_outline() as outline:
            budget = [MAX_NODES]
            items = _read_items(pdf, outline.root, 0, budget)
    return {"outline": items, "count": _count(items), "truncated": budget[0] <= 0}


def _count(items: list[dict]) -> int:
    return sum(1 + _count(i.get("children", [])) for i in items)


def _build_items(entries: list[dict], page_count: int, depth: int) -> list[OutlineItem]:
    if depth > MAX_DEPTH:
        raise ValueError(f"outline deeper than {MAX_DEPTH} levels")
    built = []
    for entry in entries:
        title = str(entry.get("title", "")).strip() or "Untitled"
        page = entry.get("page")
        if page is not None:
            page = int(page)
            if not (1 <= page <= page_count):
                raise ValueError(f"bookmark '{title}' targets page {page} of {page_count}")
            item = OutlineItem(title, page - 1)
        else:
            item = OutlineItem(title)
        item.children.extend(
            _build_items(entry.get("children", []), page_count, depth + 1)
        )
        built.append(item)
    return built


def set_outline(file: str, outline: list[dict], output: str) -> dict:
    """Replace the bookmark tree from a JSON tree of {title, page, children}."""
    input_path = Path(file)
    output_path = Path(output)
    same_file = input_path.resolve() == output_path.resolve()

    with pikepdf.open(file) as pdf:
        items = _build_items(outline or [], len(pdf.pages), 0)
        with pdf.open_outline() as ol:
            ol.root.clear()
            ol.root.extend(items)

        if same_file:
            with tempfile.NamedTemporaryFile(
                suffix=".pdf", delete=False, dir=str(input_path.parent)
            ) as tmp:
                tmp_path = tmp.name
            pdf.save(tmp_path)
        else:
            pdf.save(output_path)

    if same_file:
        shutil.move(tmp_path, str(output_path))

    return {"output": str(output_path), "count": _count(outline or [])}
