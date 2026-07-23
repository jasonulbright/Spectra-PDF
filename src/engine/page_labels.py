"""Page number labels — the /PageLabels number tree (§ I.5 P5).

The king lets a document number its pages independently of their physical order
— front matter as "i, ii, iii", the body as "1, 2, 3", an appendix as "A-1,
A-2". That mapping lives in the catalog's /PageLabels number tree (ISO 32000
§12.4.2): a /Nums array pairing a 0-based START page index with a label style
dict ({/S style, /P prefix, /St first-number}). This module reads and writes it
and computes the visible label for a page — an EDITOR, exactly like the AcroJS
name-tree editor, not a renderer change.

Styles: D decimal, r/R roman lower/upper, a/A alphabetic lower/upper, or none
(prefix only). Empty ranges REMOVE the tree.
"""

import shutil
import tempfile
from pathlib import Path

import pikepdf
from pikepdf import Array, Dictionary, Name, String

_STYLES = {"D", "r", "R", "a", "A"}


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
    for rng in ranges or []:
        start = int(rng["start"])
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
    return out


def get_page_labels(file: str) -> dict:
    """Read the /PageLabels ranges. `labels` is the visible label per page."""
    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        ranges: list[dict] = []
        pl = pdf.Root.get("/PageLabels")
        nums = pl.get("/Nums") if pl is not None else None
        if nums is not None:
            i = 0
            while i + 1 < len(nums):
                try:
                    start = int(nums[i])
                    d = nums[i + 1]
                    style_obj = d.get("/S")
                    style = str(style_obj).lstrip("/") if style_obj is not None else "none"
                    prefix = str(d.get("/P")) if d.get("/P") is not None else ""
                    start_at = int(d.get("/St")) if d.get("/St") is not None else 1
                    ranges.append({"start": start, "style": style, "prefix": prefix, "start_at": start_at})
                except (TypeError, ValueError, AttributeError):
                    pass
                i += 2
        ranges.sort(key=lambda r: r["start"])
        labels = [label_for(ranges, p) for p in range(total)]
        return {"ranges": ranges, "labels": labels, "count": len(ranges)}


def set_page_labels(file: str, output: str, ranges: list[dict]) -> dict:
    """Write the /PageLabels number tree. An empty `ranges` removes it."""
    input_path = Path(file)
    output_path = Path(output)
    same_file = input_path.resolve() == output_path.resolve()

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
            with tempfile.NamedTemporaryFile(
                suffix=".pdf", delete=False, dir=str(input_path.parent)
            ) as tmp:
                tmp_path = tmp.name
            pdf.save(tmp_path)
        else:
            pdf.save(output_path)

    if same_file:
        shutil.move(tmp_path, str(output_path))

    return {"output": str(output_path), "ranges": len(ranges or [])}
