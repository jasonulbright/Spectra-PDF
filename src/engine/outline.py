"""PDF outline (bookmarks) read/write using pikepdf."""

import base64
import shutil
import tempfile
from pathlib import Path

import pikepdf
from pikepdf import OutlineItem

MAX_DEPTH = 32
MAX_NODES = 10_000

# Depth cap for action serialization — real action payloads (URI, JavaScript,
# Named, GoToR) are shallow name/string/number structures; anything deeper is
# pathological and degrades to the lossy path rather than recursing forever.
MAX_ACTION_DEPTH = 16


class _Unserializable(Exception):
    pass


def _serialize_obj(obj, depth: int = 0):
    """pikepdf object → JSON-safe typed structure ({'n': name}, {'s': text},
    {'b64': bytes}, {'a': [...]}, {'d': {...}}, or a plain number/bool).
    Raises _Unserializable for streams/cycles/over-deep payloads — the caller
    flags the item lossy instead of silently dropping it."""
    if depth > MAX_ACTION_DEPTH:
        raise _Unserializable("action nested too deeply")
    if isinstance(obj, pikepdf.Name):
        return {"n": str(obj)}
    if isinstance(obj, pikepdf.String):
        raw = bytes(obj)
        try:
            return {"s": raw.decode("utf-8")}
        except UnicodeDecodeError:
            return {"b64": base64.b64encode(raw).decode("ascii")}
    if isinstance(obj, bool):
        return obj
    if isinstance(obj, int):
        return obj
    if isinstance(obj, (float, pikepdf.Object)) and not isinstance(
        obj, (pikepdf.Array, pikepdf.Dictionary, pikepdf.Stream)
    ):
        # Numeric pikepdf objects (Integer/Real) coerce cleanly; anything else
        # falls through to the structured branches below or fails loudly.
        try:
            f = float(obj)
        except (TypeError, ValueError):
            raise _Unserializable(f"unsupported object: {type(obj).__name__}") from None
        return int(f) if f.is_integer() else f
    if isinstance(obj, pikepdf.Stream):
        raise _Unserializable("stream in action payload")
    if isinstance(obj, pikepdf.Array):
        return {"a": [_serialize_obj(v, depth + 1) for v in obj]}
    if isinstance(obj, pikepdf.Dictionary):
        out = {}
        for key, value in obj.items():
            out[str(key)] = _serialize_obj(value, depth + 1)
        return {"d": out}
    if isinstance(obj, float):
        return obj
    raise _Unserializable(f"unsupported object: {type(obj).__name__}")


def _deserialize_obj(data, depth: int = 0):
    """Inverse of _serialize_obj → a direct pikepdf object. Depth-capped like
    the serialize side (a hand-built over-deep payload gets a clean
    ValueError, not a RecursionError)."""
    if depth > MAX_ACTION_DEPTH:
        raise ValueError("outline action payload nested too deeply")
    if isinstance(data, bool) or isinstance(data, int) or isinstance(data, float):
        return data
    if isinstance(data, dict):
        if "n" in data:
            return pikepdf.Name(data["n"])
        if "s" in data:
            return pikepdf.String(data["s"])
        if "b64" in data:
            return pikepdf.String(base64.b64decode(data["b64"]))
        if "a" in data:
            return pikepdf.Array([_deserialize_obj(v, depth + 1) for v in data["a"]])
        if "d" in data:
            d = pikepdf.Dictionary()
            for key, value in data["d"].items():
                d[key] = _deserialize_obj(value, depth + 1)
            return d
    raise ValueError("malformed outline action payload")


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
        entry = {
            "title": str(item.title) if item.title is not None else "",
            # 1-based for symmetry with every other page-facing op
            "page": page + 1 if page is not None else None,
            "children": _read_items(pdf, item.children, depth + 1, budget),
        }
        if page is None:
            # Preserve the raw action (URI, JavaScript, Named, GoToR, or a
            # named destination that didn't resolve) so a get→edit→set round
            # trip doesn't drop it — the tracked 2b gap. Non-serializable
            # exotica degrade to the old title-only behavior, but VISIBLY.
            try:
                action = item.action
                dest = item.destination
                if action is not None:
                    entry["action"] = _serialize_obj(action)
                elif dest is not None:
                    entry["dest"] = _serialize_obj(dest)
            except _Unserializable:
                entry["action_lossy"] = True
            except Exception:
                entry["action_lossy"] = True
        result.append(entry)
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
        elif entry.get("action") is not None:
            # Round-trip a preserved raw action (see _read_items).
            action = _deserialize_obj(entry["action"])
            if not isinstance(action, pikepdf.Dictionary):
                raise ValueError(f"bookmark '{title}': action payload must be a dictionary")
            item = OutlineItem(title, action=action)
        elif entry.get("dest") is not None:
            dest = _deserialize_obj(entry["dest"])
            if not isinstance(dest, (pikepdf.Name, pikepdf.String)):
                raise ValueError(f"bookmark '{title}': dest payload must be a name or string")
            item = OutlineItem(title, destination=dest)
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
