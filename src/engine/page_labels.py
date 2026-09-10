"""Page number labels — the /PageLabels number tree.

PDF page labels number pages independently of their physical order — front
matter as "i, ii, iii", the body as "1, 2, 3", an appendix as "A-1,
A-2". That mapping lives in the catalog's /PageLabels number tree (ISO 32000
§12.4.2): a /Nums array pairing a 0-based START page index with a label style
dict ({/S style, /P prefix, /St first-number}). This module reads and writes it
and computes the visible label for a page — an EDITOR, exactly like the AcroJS
name-tree editor, not a renderer change.

Styles: D decimal, r/R roman lower/upper, a/A alphabetic lower/upper, or none
(prefix only). Empty ranges REMOVE the tree.
"""

from pathlib import Path

import pikepdf
from pikepdf import Array, Dictionary, Name, String
from engine.inplace import is_same_file, staged_write
from engine.pdf_save import save_pdf

_STYLES = {"D", "r", "R", "a", "A"}


class _UnreadableLabels(Exception):
    """Internal read failure: never publish a partial editable replacement."""


def _label_budget(style: str, number: int) -> None:
    # Roman/alphabetic labels grow with the number, not its digit count.
    # Bound expansion before allocating it (also used by the writer).
    length = number // 1000 + 32 if style in ("r", "R") else number // 26 + 1 if style in ("a", "A") else 32
    if length > 10000 or number > 9007199254740991:
        raise _UnreadableLabels


def _to_roman(n: int) -> str:
    if n <= 0:
        return ""
    vals = [(1000, "m"), (900, "cm"), (500, "d"), (400, "cd"), (100, "c"),
            (90, "xc"), (50, "l"), (40, "xl"), (10, "x"), (9, "ix"),
            (5, "v"), (4, "iv"), (1, "i")]
    out = []
    for v, sym in vals:
        while n >= v:
            out.append(sym)
            n -= v
    return "".join(out)


def _to_alpha(n: int) -> str:
    """1→a, 26→z, 27→aa, 28→bb … (the PDF spec's repeat-letter scheme)."""
    if n <= 0:
        return ""
    letter = chr(ord("a") + (n - 1) % 26)
    count = (n - 1) // 26 + 1
    return letter * count


def _format(style: str, number: int) -> str:
    if style == "D":
        return str(number)
    if style == "r":
        return _to_roman(number)
    if style == "R":
        return _to_roman(number).upper()
    if style == "a":
        return _to_alpha(number)
    if style == "A":
        return _to_alpha(number).upper()
    return ""  # none — prefix only


def label_for(ranges: list[dict], page_index: int) -> str:
    """The visible label for a 0-based page index given normalized ranges
    (each {start, style, prefix, start_at}). A page before the first range (or
    with no ranges) falls back to its 1-based physical number."""
    covering = None
    for rng in sorted(ranges, key=lambda r: int(r["start"])):
        if int(rng["start"]) <= page_index:
            covering = rng
        else:
            break
    if covering is None:
        return str(page_index + 1)
    start_at = int(covering.get("start_at", 1))
    number = start_at + (page_index - int(covering["start"]))
    prefix = str(covering.get("prefix", "") or "")
    style = str(covering.get("style", "D"))
    return prefix + _format(style, number)


def _normalize(ranges: list[dict], total: int) -> list[dict]:
    out = []
    seen = set()
    if not isinstance(ranges, list):
        raise ValueError("Invalid page label ranges")
    for rng in ranges:
        if (not isinstance(rng, dict) or type(rng.get("start")) is not int
                or type(rng.get("start_at", 1)) is not int
                or rng.get("start_at", 1) < 1
                or not isinstance(rng.get("prefix", ""), str)):
            raise ValueError("Invalid page label ranges")
        start = rng["start"]
        if start < 0 or start >= total:
            raise ValueError(f"range start {start} is out of range (0-{total - 1})")
        if start in seen:
            raise ValueError(f"duplicate range start {start}")
        seen.add(start)
        style = str(rng.get("style", "D"))
        if style not in _STYLES and style != "none":
            raise ValueError(f"style must be one of {sorted(_STYLES)} or 'none', got {style!r}")
        out.append({
            "start": start,
            "style": style,
            "prefix": str(rng.get("prefix", "") or ""),
            "start_at": int(rng.get("start_at", 1)),
        })
    out.sort(key=lambda r: r["start"])
    if out and out[0]["start"] != 0:
        out.insert(0, {"start": 0, "style": "D", "prefix": "", "start_at": 1})
    try:
        _render_labels(out, total)
    except _UnreadableLabels:
        raise ValueError("Invalid page label ranges") from None
    return out


def _read_ranges(pdf) -> list[dict]:
    """Read the entire number tree, or refuse it (ISO 32000-2 7.9.7, 12.4.2).

    A malformed child, duplicate key or exhausted budget is not an absent
    range. Limits are checked against the actual descendants, never trusted
    as permission to skip them. Unknown range data cannot be round-tripped
    by this editor and likewise cannot authorize a replacement.
    """
    if "/PageLabels" not in pdf.Root:
        return []
    ranges, seen = [], set()
    count = 0

    def walk(node, depth=0):
        nonlocal count
        count += 1
        if count > 10000 or depth > 64 or not isinstance(node, Dictionary):
            raise _UnreadableLabels
        if node.objgen != (0, 0):
            if node.objgen in seen:
                raise _UnreadableLabels
            seen.add(node.objgen)
        nums, kids = node.get("/Nums"), node.get("/Kids")
        first = len(ranges)
        if (nums is None) == (kids is None):
            raise _UnreadableLabels
        if nums is not None:
            if not isinstance(nums, Array) or len(nums) % 2:
                raise _UnreadableLabels
            for i in range(0, len(nums), 2):
                start, d = nums[i], nums[i + 1]
                if (type(start) is not int or not 0 <= start < len(pdf.pages)
                        or ranges and start <= ranges[-1]["start"]
                        or not isinstance(d, Dictionary) or set(d.keys()) - {"/Type", "/S", "/P", "/St"}
                        or d.get("/Type", Name.PageLabel) != Name.PageLabel):
                    raise _UnreadableLabels
                style, prefix, value = d.get("/S"), d.get("/P"), d.get("/St", 1)
                if (style is not None and (not isinstance(style, Name) or str(style)[1:] not in _STYLES)
                        or prefix is not None and not isinstance(prefix, String)
                        or type(value) is not int or value < 1):
                    raise _UnreadableLabels
                ranges.append({"start": start, "style": str(style)[1:] if style is not None else "none",
                               "prefix": str(prefix) if prefix is not None else "", "start_at": value})
        else:
            if not isinstance(kids, Array) or not kids:
                raise _UnreadableLabels
            for kid in kids:
                if not isinstance(kid, Dictionary) or kid.objgen == (0, 0):
                    raise _UnreadableLabels
                walk(kid, depth + 1)
        limits = node.get("/Limits")
        if depth > 0 and limits is None or depth == 0 and limits is not None:
            raise _UnreadableLabels
        if limits is not None:
            if (not isinstance(limits, Array) or len(limits) != 2 or not all(type(n) is int for n in limits)
                    or first == len(ranges) or list(limits) != [ranges[first]["start"], ranges[-1]["start"]]):
                raise _UnreadableLabels
    walk(pdf.Root.get("/PageLabels"))
    if not ranges or ranges[0]["start"] != 0:
        raise _UnreadableLabels
    return ranges


def _render_labels(ranges: list[dict], total: int) -> list[str]:
    """Read and write share one expansion budget, so writes stay readable."""
    labels, size, index = [], 0, -1
    for page in range(total):
        while index + 1 < len(ranges) and ranges[index + 1]["start"] <= page:
            index += 1
        active = ranges[index] if index >= 0 else None
        if active:
            value = active["start_at"] + page - active["start"]
            _label_budget(active["style"], value)
            if len(active["prefix"]) > 10000:
                raise _UnreadableLabels
            label = active["prefix"] + _format(active["style"], value)
        else:
            label = str(page + 1)
        size += len(label)
        if size > 1000000:
            raise _UnreadableLabels
        labels.append(label)
    return labels


def get_page_labels(file: str) -> dict:
    """Only complete reads may seed the editor; `labels` is for navigation."""
    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        try:
            ranges = _read_ranges(pdf)
            labels = _render_labels(ranges, total)
            return {"ranges": ranges, "labels": labels, "count": len(ranges), "complete": True}
        except (pikepdf.PdfError, TypeError, ValueError, AttributeError, _UnreadableLabels):
            return {"ranges": [], "labels": [], "count": 0, "complete": False}


def set_page_labels(file: str, output: str, ranges: list[dict]) -> dict:
    """Write the /PageLabels number tree. An empty `ranges` removes it."""
    input_path = Path(file)
    output_path = Path(output)
    same_file = is_same_file(str(input_path), str(output_path))

    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        norm = _normalize(ranges, total)
        if not norm:
            if "/PageLabels" in pdf.Root:
                del pdf.Root["/PageLabels"]
        else:
            nums = []
            for rng in norm:
                d = Dictionary()
                if rng["style"] != "none":
                    d[Name.S] = Name("/" + rng["style"])
                if rng["prefix"]:
                    d[Name.P] = String(rng["prefix"])
                if rng["start_at"] != 1:
                    d[Name.St] = rng["start_at"]
                nums.append(rng["start"])
                nums.append(d)
            pdf.Root[Name.PageLabels] = Dictionary(Nums=Array(nums))

        if same_file:
            with staged_write(output_path) as staged:
                save_pdf(pdf, str(staged))
                pdf.close()
        else:
            save_pdf(pdf, output_path)

    return {"output": str(output_path), "ranges": len(ranges or [])}
